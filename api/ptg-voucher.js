/**
 * Vercel Serverless: EIP-712 podpis dla mintWithSignature (PhraseToGuessNFT).
 * Ścieżka /api/ptg-voucher — neutralna nazwa (mniej blokad niż "mint" w URL).
 *
 * Zmienne: MINT_SIGNER_PRIVATE_KEY, PTG_NFT_ADDRESS (lub PTG_CIRCLE_NFT_ADDRESS),
 * opcjonalnie PTG_RTD_BASE_URL, PTG_LEADERBOARD_SEASON, BASE_RPC_URL
 */

const DEFAULT_RTD =
  "https://phrase-to-guess-default-rtdb.europe-west1.firebasedatabase.app";
const DEFAULT_RPC = "https://mainnet.base.org";
const CHAIN_ID = 8453n;

function normUid(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function isAddress(x) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(x || ""));
}

async function fetchPlayerRtd(userId, season) {
  const base = process.env.PTG_RTD_BASE_URL || DEFAULT_RTD;
  const url = `${base}/players_s${season}/${encodeURIComponent(userId)}.json`;
  const r = await fetch(url, { method: "GET" });
  if (!r.ok) return null;
  return r.json();
}

async function verifyFarcasterQuickAuthJwt(token, jose) {
  const JWKS = jose.createRemoteJWKSet(
    new URL("https://auth.farcaster.xyz/.well-known/jwks.json")
  );
  const { payload } = await jose.jwtVerify(token, JWKS, {
    issuer: "https://auth.farcaster.xyz",
  });
  return payload;
}

function fcUsernameMatchesUserId(payload, userId) {
  const raw =
    payload.username ||
    payload.name ||
    payload.preferred_username ||
    "";
  const u = normUid(String(raw).replace(/^@/, ""));
  return u && u === normUid(userId);
}

async function assertEligibleToMint({ minter, userId, fcQuickAuthToken }) {
  const season = Number(process.env.PTG_LEADERBOARD_SEASON || "2") || 2;
  const data = await fetchPlayerRtd(userId, season);
  if (!data || !data.pendingMint) {
    const err = new Error("no_pending_mint");
    err.code = 403;
    throw err;
  }

  const m = minter.toLowerCase();
  const uid = String(userId).toLowerCase();

  if (uid === m) return;

  const bound = data.mintWalletForMint;
  if (bound && String(bound).toLowerCase() === m) return;

  if (fcQuickAuthToken) {
    const jose = await import("jose");
    let payload;
    try {
      payload = await verifyFarcasterQuickAuthJwt(fcQuickAuthToken, jose);
    } catch {
      const err = new Error("invalid_fc_token");
      err.code = 403;
      throw err;
    }
    if (fcUsernameMatchesUserId(payload, userId)) return;
    const err = new Error("fc_token_username_mismatch");
    err.code = 403;
    throw err;
  }

  const err = new Error("wallet_not_linked_to_player");
  err.code = 403;
  throw err;
}

/** Odbicie Origin (WebView / CORS); bez zduplikowania z edge headers. */
function setCors(req, res) {
  const o = req.headers.origin;
  if (o && o !== "null") {
    res.setHeader("Access-Control-Allow-Origin", o);
    res.setHeader("Access-Control-Allow-Credentials", "false");
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

module.exports = async (req, res) => {
  setCors(req, res);
  try {
    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST, OPTIONS");
      return res.status(405).json({ error: "method_not_allowed" });
    }

    const key = process.env.MINT_SIGNER_PRIVATE_KEY;
    const rawAddr = process.env.PTG_NFT_ADDRESS || process.env.PTG_CIRCLE_NFT_ADDRESS;
    if (!key || !rawAddr) {
      return res.status(503).json({ error: "server_mint_not_configured" });
    }

    const { ethers } = await import("ethers");
    let contractAddress;
    try {
      contractAddress = ethers.getAddress(String(rawAddr).trim());
    } catch {
      return res.status(500).json({ error: "bad_contract_address" });
    }

    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body || "{}");
      } catch {
        return res.status(400).json({ error: "invalid_json" });
      }
    }

    const minter = body.minter;
    const userId = body.userId;
    const fcQuickAuthToken = body.fcQuickAuthToken || body.fcToken || null;

    if (!isAddress(minter) || !userId || String(userId).length > 200) {
      return res.status(400).json({ error: "bad_request" });
    }

    try {
      await assertEligibleToMint({ minter, userId, fcQuickAuthToken });
    } catch (e) {
      const code = e.code === 403 ? 403 : 500;
      return res.status(code).json({ error: e.message || "forbidden" });
    }

    const rpc = process.env.BASE_RPC_URL || DEFAULT_RPC;
    const provider = new ethers.JsonRpcProvider(rpc);
    const nft = new ethers.Contract(
      contractAddress,
      ["function nonces(address) view returns (uint256)"],
      provider
    );

    let nonce;
    try {
      nonce = await nft.nonces(minter);
    } catch {
      return res.status(500).json({ error: "nonce_rpc_failed" });
    }

    const deadline = Math.floor(Date.now() / 1000) + 15 * 60;

    const domain = {
      name: "PhraseToGuess",
      version: "1",
      chainId: CHAIN_ID,
      verifyingContract: contractAddress,
    };

    const types = {
      Mint: [
        { name: "minter", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };

    const value = {
      minter,
      nonce,
      deadline: BigInt(deadline),
    };

    let wallet;
    try {
      wallet = new ethers.Wallet(key.startsWith("0x") ? key : `0x${key}`);
    } catch {
      return res.status(500).json({ error: "bad_signer_key" });
    }

    let signature;
    try {
      signature = await wallet.signTypedData(domain, types, value);
    } catch {
      return res.status(500).json({ error: "sign_failed" });
    }

    const sig = ethers.Signature.from(signature);

    return res.status(200).json({
      deadline: String(deadline),
      v: sig.v,
      r: sig.r,
      s: sig.s,
    });
  } catch (err) {
    console.error("ptg-voucher", err);
    setCors(req, res);
    return res.status(500).json({
      error: "internal_error",
      detail: String(err && err.message ? err.message : err),
    });
  }
};
