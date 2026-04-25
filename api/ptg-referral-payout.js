/**
 * Wypłata nagród referralowych w USDC na Base — przez EIP-3009
 * `transferWithAuthorization`. Serwer (treasury) podpisuje off-chain
 * autoryzację, a wallet usera sam wysyła transakcję on-chain — dzięki
 * czemu w portfelu widać REAL TX z efektem `+X USDC` na zielono.
 *
 * Endpoint obsługuje DWIE operacje po typie body:
 *
 *  A) QUOTE (body.claimAmountCents + body.signature)
 *     POST: { userId, claimAmountCents, signature }
 *     200 : { ok, amountCents, auth: { contract, from, to, value, validAfter,
 *            validBefore, nonce, v, r, s, chainId }, note? }
 *
 *  B) SETTLE (body.txHash + body.nonce)
 *     POST: { userId, txHash, nonce }
 *     200 : { ok, txHash, amountCents, explorer }
 *
 *  C) RESTORE (body.op === "restore")
 *     POST: { userId, op: "restore" }
 *     200 : { ok, restored, claimed, pendingReward, outstanding? }
 *     Idempotentny self-heal: jeżeli user ma zombie `claim_outstanding`
 *     (pendingReward wyzerowany, autoryzacja nigdy nie trafiła on-chain i już
 *     wygasła), odtwarza `summary.pendingReward` i usuwa rekord. Jeżeli auth
 *     został faktycznie wykorzystany on-chain (a klient nie zdążył dobić
 *     SETTLE), domyka historię claimu.
 *
 * (Scalone w jeden endpoint z powodu limitu 12 funkcji na planie Hobby Vercela.)
 *
 * Env: FIREBASE_SERVICE_ACCOUNT_JSON,
 *      PTG_PAYOUT_PRIVATE_KEY (treasury z USDC + gazu nie potrzebuje;
 *        akceptowane też jako REFERRAL_PAYOUT_PRIVATE_KEY dla kompat.),
 *      BASE_RPC_URL (opcjonalnie),
 *      PTG_REFERRAL_SEASON, PTG_REFERRAL_DATA_VERSION.
 */

const {
  Wallet,
  JsonRpcProvider,
  verifyMessage,
  Interface,
  Signature,
  getAddress,
  hashMessage,
  AbiCoder,
  keccak256,
  toUtf8Bytes,
} = require("ethers");
const { randomBytes } = require("crypto");
const { getAdminDb, hasServiceAccount } = require("../lib/fc-notif-store.js");

const CHAIN_ID = 8453;
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/* USDC (FiatTokenV2.2) na Base. EIP-712 domain — jak u Circle. */
const USDC_EIP712_DOMAIN = {
  name: "USD Coin",
  version: "2",
  chainId: CHAIN_ID,
  verifyingContract: USDC_BASE,
};

const USDC_IFACE = new Interface([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
]);

/* EIP-1271: smart-contract wallet pokazuje ważność podpisu przez
 * `isValidSignature(bytes32 hash, bytes signature)` zwracające magic
 * `0x1626ba7e`. Używane przez Coinbase Smart Wallet (Base App), Safe,
 * Argent itd. Dla smart walletów `ecrecover`/`verifyMessage` NIE działa. */
const EIP1271_IFACE = new Interface([
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
]);
const EIP1271_MAGIC = "0x1626ba7e";

/* EIP-6492: wrapper na podpis dla niezdeployowanego jeszcze smart walleta
 * (counterfactual). Podpis kończy się tym 32-bajtowym suffixem. */
const ERC6492_MAGIC_SUFFIX =
  "6492649264926492649264926492649264926492649264926492649264926492";

function hasErc6492Suffix(sig) {
  if (typeof sig !== "string") return false;
  const body = sig.toLowerCase().startsWith("0x") ? sig.slice(2) : sig;
  return body.toLowerCase().endsWith(ERC6492_MAGIC_SUFFIX);
}

function unwrapErc6492Signature(sig) {
  if (!hasErc6492Suffix(sig)) return { inner: sig, wrapped: false };
  try {
    const body = sig.toLowerCase().startsWith("0x") ? sig : "0x" + sig;
    const payload = "0x" + body.slice(2, body.length - ERC6492_MAGIC_SUFFIX.length);
    const coder = AbiCoder.defaultAbiCoder();
    const [factory, factoryCalldata, innerSig] = coder.decode(
      ["address", "bytes", "bytes"],
      payload
    );
    return { inner: innerSig, factory, factoryCalldata, wrapped: true };
  } catch (e) {
    return { inner: sig, wrapped: true, decodeError: String(e && e.message) };
  }
}

/**
 * Weryfikuje podpis claimu w sposób wspierający zarówno EOA (MetaMask /
 * Coinbase Wallet extension), jak i smart walletów (Coinbase Smart Wallet
 * w Base App, Safe itd.). Najpierw próbuje `ecrecover` (EOA), potem
 * EIP-1271 przez `eth_call` na kontrakcie walleta (smart wallet zdeployowany),
 * wreszcie rozpakowuje ewentualny wrapper EIP-6492.
 */
async function verifyClaimSignature(userAddr, message, signature, rpcUrl) {
  const expected = String(userAddr).toLowerCase();

  try {
    const recovered = verifyMessage(message, signature);
    if (String(recovered).toLowerCase() === expected) {
      return { ok: true, mode: "eoa" };
    }
  } catch (_) {}

  let hashVariants = [];
  try {
    hashVariants.push({ label: "eip191", value: hashMessage(message) });
  } catch (_) {}
  try {
    hashVariants.push({ label: "raw_keccak", value: keccak256(toUtf8Bytes(String(message || ""))) });
  } catch (_) {}
  const uniq = new Set();
  hashVariants = hashVariants.filter((h) => {
    const v = String(h && h.value || "");
    if (!v || uniq.has(v)) return false;
    uniq.add(v);
    return true;
  });
  if (!hashVariants.length) {
    return { ok: false, mode: "none", reason: "hash_failed" };
  }

  const { inner, wrapped } = unwrapErc6492Signature(signature);

  async function rpcCall(data) {
    const r = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: userAddr, data }, "latest"],
      }),
    });
    if (!r.ok) throw new Error("rpc_" + r.status);
    return r.json();
  }

  function isMagic(result) {
    if (!result || typeof result !== "string") return false;
    return result.toLowerCase().startsWith(EIP1271_MAGIC);
  }

  try {
    for (let i = 0; i < hashVariants.length; i++) {
      const hv = hashVariants[i];
      const callInner = EIP1271_IFACE.encodeFunctionData("isValidSignature", [
        hv.value,
        inner,
      ]);
      const j = await rpcCall(callInner);
      if (j && typeof j.result === "string" && isMagic(j.result)) {
        return {
          ok: true,
          mode: wrapped ? "eip1271_inner_from_6492_" + hv.label : "eip1271_" + hv.label,
        };
      }
      if (wrapped) {
        const callOriginal = EIP1271_IFACE.encodeFunctionData("isValidSignature", [
          hv.value,
          signature,
        ]);
        const j2 = await rpcCall(callOriginal);
        if (j2 && typeof j2.result === "string" && isMagic(j2.result)) {
          return { ok: true, mode: "eip1271_wrapped_" + hv.label };
        }
      }
    }
  } catch (e) {
    console.warn("[claim-sig] eip1271 eth_call failed", String(e && e.message));
    return { ok: false, mode: "none", reason: "eip1271_rpc_failed" };
  }

  return {
    ok: false,
    mode: "none",
    reason: wrapped ? "eip6492_unverified" : "no_match",
  };
}

/* TTL autoryzacji (sekundy). Po tym czasie auth wygasa, kolejne podejście
 * odzyska pendingReward jeśli nie został wykorzystany on-chain. */
const AUTH_VALID_SECONDS = 15 * 60;

function setCors(req, res) {
  const o = req.headers.origin;
  if (o && o !== "null") {
    res.setHeader("Access-Control-Allow-Origin", o);
    res.setHeader("Access-Control-Allow-Credentials", "false");
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function referralRoot() {
  const season = Number(process.env.PTG_REFERRAL_SEASON || "2");
  const ver = Number(process.env.PTG_REFERRAL_DATA_VERSION || "6");
  const suffix = Number.isFinite(ver) && ver > 1 ? `_v${ver}` : "";
  return `referrals_v1/s${season}${suffix}`;
}

/**
 * Kwota claimu w centach. Nagrody mogą być frakcyjnymi centami — USDC na
 * Base ma 6 decimals → 1 cent = 10 000 jednostek.
 */
function claimUnitsFromCents(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(0, Math.round(n * 10000));
}

function buildClaimMessage(userId, claimAmountCents) {
  const units = claimUnitsFromCents(claimAmountCents);
  return (
    `Phrase To Guess — referral payout (Base)\n` +
    `Wallet: ${String(userId).toLowerCase()}\n` +
    `Amount (USDC units): ${units}\n` +
    `Chain: ${CHAIN_ID}`
  );
}

/** Sprawdza, czy nonce EIP-3009 został już wykorzystany on-chain. */
async function isAuthorizationUsed(rpcUrl, authorizer, nonce) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [
        {
          to: USDC_BASE,
          data: USDC_IFACE.encodeFunctionData("authorizationState", [
            authorizer,
            nonce,
          ]),
        },
        "latest",
      ],
    }),
  });
  if (!res.ok) throw new Error(`rpc_${res.status}`);
  const j = await res.json();
  if (!j || typeof j.result !== "string") return false;
  const decoded = USDC_IFACE.decodeFunctionResult(
    "authorizationState",
    j.result
  );
  return !!decoded[0];
}

async function handleSettle(req, res, body) {
  if (!hasServiceAccount()) {
    return res.status(503).json({ error: "firebase_admin_missing" });
  }

  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  const txHash = typeof body.txHash === "string" ? body.txHash.trim() : "";
  const nonce = typeof body.nonce === "string" ? body.nonce.trim() : "";

  if (!userId || !/^0x[a-fA-F0-9]{40}$/.test(userId)) {
    return res.status(400).json({ error: "invalid_user_id" });
  }
  if (!txHash || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return res.status(400).json({ error: "invalid_tx_hash" });
  }
  if (!nonce || !/^0x[a-fA-F0-9]{64}$/.test(nonce)) {
    return res.status(400).json({ error: "invalid_nonce" });
  }

  const root = referralRoot();
  const summaryPath = `${root}/summary/${userId}`;
  const outstandingPath = `${root}/claim_outstanding/${userId}`;

  let db;
  try {
    db = getAdminDb();
  } catch (e) {
    return res.status(503).json({ error: "firebase_admin", detail: String(e && e.message) });
  }

  let outstanding = null;
  try {
    const s = await db.ref(outstandingPath).once("value");
    outstanding = s.exists() ? s.val() : null;
  } catch (_) {}

  const rpcUrl = process.env.BASE_RPC_URL || "https://mainnet.base.org";

  if (!outstanding || outstanding.nonce !== nonce) {
    /* Brak dopasowania — sprawdź tx on-chain; jeśli jest, uznajemy za OK. */
    try {
      const provider = new JsonRpcProvider(rpcUrl);
      const receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt) {
        return res.status(400).json({ error: "tx_not_mined_yet" });
      }
      if (receipt.status !== 1) {
        return res.status(400).json({ error: "tx_reverted" });
      }
      return res.status(200).json({
        ok: true,
        note: "already_settled_or_no_outstanding",
        txHash,
      });
    } catch (e) {
      return res.status(502).json({ error: "rpc_receipt_failed", detail: String(e && e.message) });
    }
  }

  const expectedTreasury = outstanding.treasuryAddr
    ? getAddress(outstanding.treasuryAddr)
    : null;
  const amountCents = Number(outstanding.amountCents) || 0;
  if (amountCents <= 0 || !expectedTreasury) {
    return res.status(400).json({ error: "invalid_outstanding" });
  }

  let provider;
  try {
    provider = new JsonRpcProvider(rpcUrl);
  } catch (e) {
    return res.status(502).json({ error: "rpc_init_failed", detail: String(e && e.message) });
  }

  let receipt;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
  } catch (e) {
    return res.status(502).json({ error: "rpc_receipt_failed", detail: String(e && e.message) });
  }
  if (!receipt) return res.status(400).json({ error: "tx_not_mined_yet" });
  if (receipt.status !== 1) return res.status(400).json({ error: "tx_reverted" });
  const toAddr = receipt.to
    ? getAddress(receipt.to)
    : "0x0000000000000000000000000000000000000000";
  if (toAddr !== getAddress(USDC_BASE)) {
    return res.status(400).json({ error: "tx_wrong_target" });
  }

  let used = false;
  try {
    used = await isAuthorizationUsed(rpcUrl, expectedTreasury, nonce);
  } catch (e) {
    console.warn("authorizationState read failed", e);
  }
  if (!used) {
    return res.status(400).json({ error: "authorization_not_used" });
  }

  try {
    const histKey = `${root}/claim_history/${userId}/${nonce}`;
    const histRef = db.ref(histKey);
    const existing = await histRef.once("value");
    if (!existing.exists()) {
      await histRef.set({
        amount: amountCents,
        ts: Date.now(),
        txHash,
        chainId: CHAIN_ID,
        token: "USDC",
        nonce,
      });
      await db.ref(summaryPath).transaction((cur) => {
        const o = cur && typeof cur === "object" && cur !== null ? cur : {};
        return {
          ...o,
          claimedTotal:
            (typeof o.claimedTotal === "number" ? o.claimedTotal : 0) + amountCents,
          lastClaimAt: Date.now(),
        };
      });
    }
    await db.ref(outstandingPath).remove();
  } catch (e) {
    console.error("settle rtdb write failed", e);
    return res.status(500).json({
      error: "db_update_failed_after_transfer",
      txHash,
      warning: "USDC was transferred; reconcile history manually.",
    });
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(200).json({
    ok: true,
    txHash,
    amountCents,
    explorer: `https://basescan.org/tx/${txHash}`,
  });
}

async function handleQuote(req, res, body) {
  const pk =
    process.env.PTG_PAYOUT_PRIVATE_KEY || process.env.REFERRAL_PAYOUT_PRIVATE_KEY;
  if (!pk || String(pk).length < 20) {
    return res.status(503).json({
      error: "payout_not_configured",
      hint: "Set PTG_PAYOUT_PRIVATE_KEY on Vercel (treasury wallet with USDC on Base).",
    });
  }

  if (!hasServiceAccount()) {
    return res.status(503).json({ error: "firebase_admin_missing" });
  }

  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  const claimAmountCents =
    body.claimAmountCents != null ? Number(body.claimAmountCents) : NaN;
  const signature = typeof body.signature === "string" ? body.signature : "";

  if (!userId || !/^0x[a-fA-F0-9]{40}$/.test(userId)) {
    return res.status(400).json({
      error: "invalid_user_id",
      hint: "On-chain payout requires Ethereum wallet as userId (0x…). Connect wallet in the app.",
    });
  }
  if (!Number.isFinite(claimAmountCents) || claimAmountCents <= 0) {
    return res.status(400).json({ error: "invalid_amount" });
  }
  if (!signature) {
    return res.status(400).json({ error: "missing_signature" });
  }

  const message = buildClaimMessage(userId, claimAmountCents);
  const rpcUrl = process.env.BASE_RPC_URL || "https://mainnet.base.org";
  const sigCheck = await verifyClaimSignature(userId, message, signature, rpcUrl).catch(
    (e) => ({ ok: false, mode: "none", reason: "verify_threw:" + String(e && e.message) })
  );
  if (!sigCheck || !sigCheck.ok) {
    console.warn("[claim-sig] reject", {
      userId: String(userId || "").toLowerCase(),
      mode: sigCheck && sigCheck.mode,
      reason: sigCheck && sigCheck.reason,
    });
    return res.status(403).json({
      error: "signer_mismatch",
      mode: sigCheck && sigCheck.mode,
      reason: sigCheck && sigCheck.reason,
    });
  }
  let treasury;
  try {
    treasury = new Wallet(
      pk.startsWith("0x") ? pk : `0x${pk}`,
      new JsonRpcProvider(rpcUrl)
    );
  } catch (e) {
    return res.status(500).json({ error: "treasury_wallet_invalid", detail: String(e && e.message) });
  }
  const treasuryAddr = getAddress(await treasury.getAddress());
  const userAddr = getAddress(userId);

  const root = referralRoot();
  const summaryPath = `${root}/summary/${userId}`;
  const outstandingPath = `${root}/claim_outstanding/${userId}`;

  let db;
  try {
    db = getAdminDb();
  } catch (e) {
    return res.status(503).json({ error: "firebase_admin", detail: String(e && e.message) });
  }

  /* 1) Posprzątaj ewentualny poprzedni, niezakończony auth. */
  let outstanding = null;
  try {
    const oSnap = await db.ref(outstandingPath).once("value");
    outstanding = oSnap.exists() ? oSnap.val() : null;
  } catch (_) {
    outstanding = null;
  }
  if (outstanding && outstanding.auth && outstanding.nonce) {
    const now = Math.floor(Date.now() / 1000);
    let used = false;
    try {
      used = await isAuthorizationUsed(rpcUrl, treasuryAddr, outstanding.nonce);
    } catch (e) {
      console.warn("authorizationState read failed", e);
    }
    if (used) {
      try { await db.ref(outstandingPath).remove(); } catch (_) {}
      return res.status(400).json({ error: "already_claimed" });
    }
    if (Number(outstanding.validBefore) > now) {
      /* Aktywny, nadal ważny — zwróć bez powtórnego zdejmowania pendingReward. */
      return res.status(200).json({
        ok: true,
        amountCents: outstanding.amountCents,
        auth: outstanding.auth,
        note: "resuming_existing",
      });
    }
    /* Wygasł bez wykorzystania — przywróć pending, usuń wpis. */
    try {
      const restoreCents = Number(outstanding.amountCents) || 0;
      if (restoreCents > 0) {
        await db.ref(summaryPath).transaction((cur) => {
          const o = cur && typeof cur === "object" && cur !== null ? cur : {};
          const pr = typeof o.pendingReward === "number" ? o.pendingReward : 0;
          return { ...o, pendingReward: pr + restoreCents };
        });
      }
      await db.ref(outstandingPath).remove();
    } catch (e) {
      console.warn("expired outstanding cleanup failed", e);
    }
    outstanding = null;
  }

  /* 2) Pobierz pendingReward, zwaliduj zgodność z podpisaną kwotą (bez dotykania DB). */
  const snap = await db.ref(summaryPath).once("value");
  const data = snap.exists() ? snap.val() : null;
  const pending = data && typeof data.pendingReward === "number" ? data.pendingReward : 0;
  if (pending <= 0) {
    return res.status(400).json({ error: "nothing_to_claim" });
  }
  const pendingUnits = claimUnitsFromCents(pending);
  const claimUnits = claimUnitsFromCents(claimAmountCents);
  if (pendingUnits !== claimUnits) {
    return res.status(409).json({
      error: "amount_stale",
      pendingReward: pending,
      hint: "Refresh balance and try again.",
    });
  }

  /* 3) Podpis EIP-3009 (tylko krypto, jeszcze nic nie dotykamy w DB).
   *    Najpierw chcemy mieć gotowy `outstanding`, dopiero potem zerować
   *    pending — inaczej awaria między „zero pending" a „zapis outstanding"
   *    skutkowała znikaniem kasy, bo outstanding nie powstawał. */
  const amountUnits = BigInt(claimUnitsFromCents(pending));
  const validAfter = 0;
  const validBefore = Math.floor(Date.now() / 1000) + AUTH_VALID_SECONDS;
  const nonce = "0x" + randomBytes(32).toString("hex");

  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  };
  const values = {
    from: treasuryAddr,
    to: userAddr,
    value: amountUnits.toString(),
    validAfter,
    validBefore,
    nonce,
  };

  let sigHex;
  try {
    sigHex = await treasury.signTypedData(USDC_EIP712_DOMAIN, types, values);
  } catch (e) {
    return res.status(500).json({ error: "treasury_sign_failed", detail: String(e && e.message) });
  }
  const sig = Signature.from(sigHex);

  const auth = {
    contract: USDC_BASE,
    from: treasuryAddr,
    to: userAddr,
    value: amountUnits.toString(),
    validAfter,
    validBefore,
    nonce,
    v: sig.v,
    r: sig.r,
    s: sig.s,
    chainId: CHAIN_ID,
  };

  /* 4) OUTSTANDING FIRST. Jeżeli ten zapis padnie, nic nie zostało zepsute. */
  try {
    await db.ref(outstandingPath).set({
      auth,
      nonce,
      amountCents: pending,
      validBefore,
      createdAt: Date.now(),
      treasuryAddr,
    });
  } catch (e) {
    return res.status(500).json({ error: "outstanding_write_failed", detail: String(e && e.message) });
  }

  /* 5) DOPIERO teraz atomowo zdejmij pending. Jeżeli się nie zatwierdzi albo
   *    pending pod ręką jest już inny niż w chwili podpisu, rollback'ujemy
   *    outstanding. Dzięki temu nigdy nie mamy „pending znikło + outstanding
   *    nie powstało". */
  let deductCommitted = false;
  let priorPending = -1;
  try {
    deductCommitted = await new Promise((resolve, reject) => {
      db.ref(summaryPath).transaction(
        (cur) => {
          const o = cur && typeof cur === "object" && cur !== null ? cur : null;
          if (!o) {
            priorPending = 0;
            return { pendingReward: 0 };
          }
          const pr = typeof o.pendingReward === "number" ? o.pendingReward : 0;
          priorPending = pr;
          return { ...o, pendingReward: 0 };
        },
        (err, committed) => {
          if (err) return reject(err);
          resolve(committed === true);
        },
        false
      );
    });
  } catch (e) {
    try { await db.ref(outstandingPath).remove(); } catch (_) {}
    return res.status(500).json({ error: "rtdb_transaction", detail: String(e && e.message) });
  }

  if (!deductCommitted) {
    try { await db.ref(outstandingPath).remove(); } catch (_) {}
    return res.status(409).json({ error: "concurrent_claim", hint: "Try again." });
  }
  if (priorPending <= 0) {
    try { await db.ref(outstandingPath).remove(); } catch (_) {}
    return res.status(400).json({ error: "nothing_to_claim" });
  }
  if (claimUnitsFromCents(priorPending) !== claimUnits) {
    try { await db.ref(outstandingPath).remove(); } catch (_) {}
    try {
      await db.ref(summaryPath).transaction((cur) => {
        const o = cur && typeof cur === "object" && cur !== null ? cur : {};
        const pr = typeof o.pendingReward === "number" ? o.pendingReward : 0;
        return { ...o, pendingReward: pr + priorPending };
      });
    } catch (_) {}
    return res.status(409).json({
      error: "amount_stale",
      pendingReward: priorPending,
      hint: "Refresh balance and try again.",
    });
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(200).json({
    ok: true,
    amountCents: priorPending,
    auth,
  });
}

/**
 * RESTORE — idempotentny self-heal. Klient woła to przy otwieraniu UI
 * referrali i po świeżym loginie, żeby rozpoznać „zombie" outstanding'i
 * (kasa zniknęła z summary, bo user nie zdążył dokończyć claimu / wallet
 * odrzucił popup / fetch padł w połowie). Bez parametrów poza `userId` —
 * nie wymaga żadnego podpisu, bo tylko decyduje na podstawie on-chain
 * `authorizationState` + lokalnego TTL.
 */
async function handleRestore(req, res, body) {
  if (!hasServiceAccount()) {
    return res.status(503).json({ error: "firebase_admin_missing" });
  }
  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  if (!userId || !/^0x[a-fA-F0-9]{40}$/.test(userId)) {
    return res.status(400).json({ error: "invalid_user_id" });
  }

  const root = referralRoot();
  const summaryPath = `${root}/summary/${userId}`;
  const outstandingPath = `${root}/claim_outstanding/${userId}`;

  let db;
  try {
    db = getAdminDb();
  } catch (e) {
    return res.status(503).json({ error: "firebase_admin", detail: String(e && e.message) });
  }

  const rpcUrl = process.env.BASE_RPC_URL || "https://mainnet.base.org";

  const [oSnap, sSnap] = await Promise.all([
    db.ref(outstandingPath).once("value"),
    db.ref(summaryPath).once("value"),
  ]);
  const outstanding = oSnap.exists() ? oSnap.val() : null;
  const summary = sSnap.exists() ? sSnap.val() : null;
  const pendingNow = summary && typeof summary.pendingReward === "number" ? summary.pendingReward : 0;

  if (!outstanding || !outstanding.nonce || !outstanding.treasuryAddr) {
    return res.status(200).json({
      ok: true,
      restored: 0,
      claimed: 0,
      pendingReward: pendingNow,
    });
  }

  let used = false;
  try {
    used = await isAuthorizationUsed(rpcUrl, outstanding.treasuryAddr, outstanding.nonce);
  } catch (e) {
    return res.status(502).json({ error: "rpc_read_failed", detail: String(e && e.message) });
  }

  const amountCents = Number(outstanding.amountCents) || 0;
  const nowSec = Math.floor(Date.now() / 1000);
  const stillValid = Number(outstanding.validBefore || 0) > nowSec;

  if (used) {
    /* Klient nie dobił SETTLE — zamknijmy wpis w historii. */
    let claimed = 0;
    try {
      const nonce = outstanding.nonce;
      const histRef = db.ref(`${root}/claim_history/${userId}/${nonce}`);
      const existing = await histRef.once("value");
      if (!existing.exists()) {
        await histRef.set({
          amount: amountCents,
          ts: Date.now(),
          chainId: CHAIN_ID,
          token: "USDC",
          nonce,
          source: "restore",
        });
        await db.ref(summaryPath).transaction((cur) => {
          const o = cur && typeof cur === "object" && cur !== null ? cur : {};
          return {
            ...o,
            claimedTotal:
              (typeof o.claimedTotal === "number" ? o.claimedTotal : 0) + amountCents,
            lastClaimAt: Date.now(),
          };
        });
        claimed = amountCents;
      }
      await db.ref(outstandingPath).remove();
    } catch (e) {
      return res.status(500).json({ error: "db_update_failed", detail: String(e && e.message) });
    }
    return res.status(200).json({ ok: true, restored: 0, claimed, pendingReward: pendingNow });
  }

  if (stillValid) {
    /* Nie wygasł — user wciąż może go dokończyć. Zwracamy pełen `auth`,
     * żeby klient mógł WZNOWIĆ flow (skip QUOTE + sign, od razu
     * eth_sendTransaction). Dzięki temu „pending zniknęło, outstanding
     * nadal wisi" nie blokuje usera do końca TTL. */
    return res.status(200).json({
      ok: true,
      restored: 0,
      claimed: 0,
      pendingReward: pendingNow,
      outstanding: {
        amountCents,
        validBefore: outstanding.validBefore,
        auth: outstanding.auth || null,
        nonce: outstanding.nonce,
      },
    });
  }

  /* Wygasł bez wykorzystania — odtwórz pendingReward i usuń rekord. */
  let restored = 0;
  try {
    if (amountCents > 0) {
      await db.ref(summaryPath).transaction((cur) => {
        const o = cur && typeof cur === "object" && cur !== null ? cur : {};
        const pr = typeof o.pendingReward === "number" ? o.pendingReward : 0;
        return { ...o, pendingReward: pr + amountCents };
      });
      restored = amountCents;
    }
    await db.ref(outstandingPath).remove();
  } catch (e) {
    return res.status(500).json({ error: "db_restore_failed", detail: String(e && e.message) });
  }

  const newPending = pendingNow + restored;
  return res.status(200).json({
    ok: true,
    restored,
    claimed: 0,
    pendingReward: newPending,
  });
}

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body || "{}");
    } catch {
      return res.status(400).json({ error: "invalid_json" });
    }
  }
  if (!body || typeof body !== "object") {
    return res.status(400).json({ error: "invalid_body" });
  }

  /* Dispatch po obecności pól:
   *  - op === "restore"                      → RESTORE
   *  - txHash + nonce (bez signature)        → SETTLE
   *  - claimAmountCents + signature          → QUOTE
   */
  if (typeof body.op === "string" && body.op.toLowerCase() === "restore") {
    return handleRestore(req, res, body);
  }
  if (typeof body.txHash === "string" && typeof body.nonce === "string" && !body.signature) {
    return handleSettle(req, res, body);
  }
  return handleQuote(req, res, body);
};
