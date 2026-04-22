/**
 * Wypłata nagród referralowych w USDC na Base po podpisie portfela.
 * POST JSON: { userId, claimAmountCents, signature }
 * — userId: klucz w RTDB (zwykle 0x…), claimAmount musi = pendingReward,
 * — signature: personal_sign nad ustalonym tekstem (ethers).
 *
 * Env: FIREBASE_SERVICE_ACCOUNT_JSON, REFERRAL_PAYOUT_PRIVATE_KEY (treasury z USDC + ETH na gas),
 *      BASE_RPC_URL (opcjonalnie),
 *      PTG_REFERRAL_SEASON (domyślnie 2 — musi być zgodny z REFERRAL_RTDB_SEASON w index.html),
 *      PTG_REFERRAL_DATA_VERSION (domyślnie 6 — suffix _v{N} jak w `ptgReferralsRtdbRoot()`).
 */

const { Wallet, JsonRpcProvider, Contract, verifyMessage } = require("ethers");
const { getAdminDb, hasServiceAccount } = require("../lib/fc-notif-store.js");

const CHAIN_ID = 8453;
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ERC20_TRANSFER = ["function transfer(address to, uint256 amount) returns (bool)"];

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
 * Kwota claimu jest trzymana w centach (w RTDB `pendingReward`), ale minty są
 * bardzo tanie, więc nagrody realnie potrafią być frakcyjnymi centami
 * (np. 0.5 centa = $0.005). USDC na Base ma 6 miejsc po przecinku — 1 cent =
 * 10 000 jednostek USDC, 1 jednostka = $0.000001. Konwertujemy claim do liczby
 * całkowitej jednostek USDC — to też format, w którym kwota trafia do podpisu
 * (żeby klient i serwer nigdy nie rozjechały się na floacie).
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

function centsToUsdcUnits(cents) {
  const units = claimUnitsFromCents(cents);
  if (units <= 0) return 0n;
  return BigInt(units);
}

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const pk = process.env.REFERRAL_PAYOUT_PRIVATE_KEY;
  if (!pk || String(pk).length < 20) {
    return res.status(503).json({
      error: "payout_not_configured",
      hint: "Set REFERRAL_PAYOUT_PRIVATE_KEY on Vercel (treasury wallet with USDC on Base).",
    });
  }

  if (!hasServiceAccount()) {
    return res.status(503).json({ error: "firebase_admin_missing" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body || "{}");
    } catch {
      return res.status(400).json({ error: "invalid_json" });
    }
  }

  const userId = body && typeof body.userId === "string" ? body.userId.trim() : "";
  const claimAmountCents = body && body.claimAmountCents != null ? Number(body.claimAmountCents) : NaN;
  const signature = body && typeof body.signature === "string" ? body.signature : "";

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
  let recovered;
  try {
    recovered = verifyMessage(message, signature);
  } catch (e) {
    return res.status(400).json({ error: "bad_signature", detail: String(e && e.message) });
  }

  if (String(recovered).toLowerCase() !== userId.toLowerCase()) {
    return res.status(403).json({ error: "signer_mismatch" });
  }

  const root = referralRoot();
  const summaryPath = `${root}/summary/${userId}`;

  let db;
  try {
    db = getAdminDb();
  } catch (e) {
    return res.status(503).json({ error: "firebase_admin", detail: String(e && e.message) });
  }

  const snap = await db.ref(summaryPath).once("value");
  const data = snap.exists() ? snap.val() : null;
  const pending = data && typeof data.pendingReward === "number" ? data.pendingReward : 0;

  if (pending <= 0) {
    return res.status(400).json({ error: "nothing_to_claim" });
  }
  /* Porównujemy kwotę w całkowitych jednostkach USDC (6 decimals), nie w centach.
   * Dzięki temu frakcyjne centy (np. 0.5¢ = 5000 jednostek) działają poprawnie,
   * a porównanie jest nadal ścisłe i nie podatne na błędy floata. */
  const pendingUnits = claimUnitsFromCents(pending);
  const claimUnits = claimUnitsFromCents(claimAmountCents);
  if (pendingUnits !== claimUnits) {
    return res.status(409).json({
      error: "amount_stale",
      pendingReward: pending,
      hint: "Refresh balance and try again.",
    });
  }

  const amountUnits = BigInt(pendingUnits);
  if (amountUnits <= 0n) {
    return res.status(400).json({ error: "amount_too_small" });
  }

  /** Atomowo zdejmij saldo zanim wyślemy USDC (zapobiega podwójnej wypłacie). */
  let deductCommitted = false;
  try {
    deductCommitted = await new Promise((resolve, reject) => {
      db.ref(summaryPath).transaction(
        (cur) => {
          const o = cur && typeof cur === "object" ? cur : {};
          const pr = typeof o.pendingReward === "number" ? o.pendingReward : 0;
          if (pr !== pending) return undefined;
          return { ...o, pendingReward: 0 };
        },
        (err, committed) => {
          if (err) reject(err);
          else resolve(committed === true);
        },
        false
      );
    });
  } catch (e) {
    return res.status(500).json({ error: "rtdb_transaction", detail: String(e && e.message) });
  }

  if (!deductCommitted) {
    return res.status(409).json({ error: "concurrent_claim", hint: "Try again." });
  }

  const rpc = process.env.BASE_RPC_URL || "https://mainnet.base.org";
  let wallet;
  try {
    wallet = new Wallet(pk.startsWith("0x") ? pk : `0x${pk}`, new JsonRpcProvider(rpc));
  } catch (e) {
    try {
      await db.ref(summaryPath).transaction((cur) => {
        const o = cur && typeof cur === "object" ? cur : {};
        const pr = typeof o.pendingReward === "number" ? o.pendingReward : 0;
        return { ...o, pendingReward: pr + pending };
      });
    } catch (_) {}
    return res.status(500).json({ error: "treasury_wallet_invalid", detail: String(e && e.message) });
  }

  const usdc = new Contract(USDC_BASE, ERC20_TRANSFER, wallet);
  let tx;
  try {
    tx = await usdc.transfer(userId, amountUnits);
  } catch (e) {
    console.error("ptg-referral-payout transfer", e);
    try {
      await db.ref(summaryPath).transaction((cur) => {
        const o = cur && typeof cur === "object" ? cur : {};
        const pr = typeof o.pendingReward === "number" ? o.pendingReward : 0;
        return { ...o, pendingReward: pr + pending };
      });
    } catch (e2) {
      console.error("ptg-referral-payout rollback failed", e2);
    }
    return res.status(502).json({
      error: "transfer_failed",
      detail: String(e && e.message),
    });
  }

  let receipt;
  try {
    receipt = await tx.wait(1);
  } catch (e) {
    console.error("ptg-referral-payout wait", e);
    try {
      await db.ref(summaryPath).transaction((cur) => {
        const o = cur && typeof cur === "object" ? cur : {};
        const pr = typeof o.pendingReward === "number" ? o.pendingReward : 0;
        return { ...o, pendingReward: pr + pending };
      });
    } catch (e2) {
      console.error("ptg-referral-payout rollback after wait failed", e2);
    }
    return res.status(502).json({
      error: "tx_not_confirmed",
      txHash: tx.hash,
      detail: String(e && e.message),
    });
  }

  if (!receipt || receipt.status !== 1) {
    try {
      await db.ref(summaryPath).transaction((cur) => {
        const o = cur && typeof cur === "object" ? cur : {};
        const pr = typeof o.pendingReward === "number" ? o.pendingReward : 0;
        return { ...o, pendingReward: pr + pending };
      });
    } catch (e2) {
      console.error("ptg-referral-payout rollback reverted tx", e2);
    }
    return res.status(502).json({ error: "tx_reverted", txHash: tx.hash });
  }

  try {
    await db.ref(summaryPath).transaction((cur) => {
      const o = cur && typeof cur === "object" ? cur : {};
      return {
        ...o,
        claimedTotal: (typeof o.claimedTotal === "number" ? o.claimedTotal : 0) + pending,
        lastClaimAt: Date.now(),
      };
    });

    await db.ref(`${root}/claim_history/${userId}`).push({
      amount: pending,
      ts: Date.now(),
      txHash: tx.hash,
      chainId: CHAIN_ID,
      token: "USDC",
    });
  } catch (e) {
    console.error("ptg-referral-payout rtdb after tx — MANUAL RECONCILE", tx.hash, e);
    return res.status(500).json({
      error: "db_update_failed_after_transfer",
      txHash: tx.hash,
      warning: "USDC was sent; reconcile claimedTotal / history manually.",
    });
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(200).json({
    ok: true,
    txHash: tx.hash,
    amountCents: pending,
    explorer: `https://basescan.org/tx/${tx.hash}`,
  });
};
