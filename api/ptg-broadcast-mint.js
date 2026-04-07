/**
 * Wysyła podpisany raw tx na Base — mint PhraseToGuessNFT: mint() lub publicMint(string).
 * POST JSON: { "rawTransaction": "0x..." }
 */

const TARGET = process.env.BASE_RPC_URL || "https://mainnet.base.org";

const DEFAULT_PTG_NFT_ADDRESS =
  "0x9f9343A6833190EE0c816f71D72CE450b1ee8530";

/** Trophy + odznaki (publicMint(string) / mint() jak w Kontrakt-nft.sol). */
const DEFAULT_ALLOWED_MINT_TARGETS = [
  DEFAULT_PTG_NFT_ADDRESS,
  "0x901969555E3495D79a04c6F44B97968cd0a4B466",
  "0x6fc798704Ff94F925Cc7b01B45E5333d2629C42D",
  "0xa93EEE6d23dB560c22BDCC63e37EebbC0d60B4b6",
  "0x546b1Fa45dbBBCB646D5e19518Ca6427100e7194",
];

/** Dozwolone wywołania mint na allowlistowanych kontraktach. */
const MINT_METHODS = ["mint()", "publicMint()", "publicMint(string)"];
const MAX_GAS_LIMIT = 900000n;

function buildAllowedMintAddressSet(ethersMod) {
  const raw =
    typeof process.env.PTG_ALLOWED_MINT_CONTRACTS === "string"
      ? process.env.PTG_ALLOWED_MINT_CONTRACTS
      : "";
  const parts = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const list =
    parts.length > 0 ? parts : DEFAULT_ALLOWED_MINT_TARGETS;
  const set = new Set();
  for (const a of list) {
    try {
      set.add(ethersMod.getAddress(String(a).trim()));
    } catch {
      /* skip bad entry */
    }
  }
  const envMain = process.env.PTG_NFT_ADDRESS || process.env.PTG_CIRCLE_NFT_ADDRESS;
  if (envMain) {
    try {
      set.add(ethersMod.getAddress(String(envMain).trim()));
    } catch {
      /* ignore */
    }
  }
  return set;
}

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

module.exports = async (req, res) => {
  setCors(req, res);
  try {
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
    const raw =
      body && typeof body === "object" && typeof body.rawTransaction === "string"
        ? body.rawTransaction.trim()
        : "";
    if (!/^0x[0-9a-fA-F]+$/.test(raw) || raw.length > 200000) {
      return res.status(400).json({ error: "bad_raw_transaction" });
    }

    const { ethers } = await import("ethers");
    const allowedTo = buildAllowedMintAddressSet(ethers);
    if (allowedTo.size === 0) {
      return res.status(500).json({ error: "server_bad_nft_address" });
    }

    const selectors = MINT_METHODS.map((m) => ethers.id(m).slice(0, 10).toLowerCase());

    let tx;
    try {
      tx = ethers.Transaction.from(raw);
    } catch (e) {
      return res.status(400).json({
        error: "invalid_raw_tx",
        detail: String(e && e.message ? e.message : e),
      });
    }

    if (tx.chainId !== 8453n) {
      return res.status(400).json({ error: "wrong_chain", expected: 8453 });
    }
    if (tx.to == null) {
      return res.status(400).json({ error: "missing_to" });
    }
    let toAddr;
    try {
      toAddr = ethers.getAddress(tx.to);
    } catch {
      return res.status(400).json({ error: "invalid_to" });
    }
    if (!allowedTo.has(toAddr)) {
      return res.status(400).json({ error: "wrong_contract" });
    }

    const dataHex = String(tx.data || "0x").toLowerCase();
    const okSel = selectors.some((s) => dataHex.startsWith(s));
    if (!okSel) {
      return res.status(400).json({ error: "not_mint_calldata" });
    }

    const gl = tx.gasLimit;
    if (gl == null || gl > MAX_GAS_LIMIT) {
      return res.status(400).json({ error: "bad_gas_limit" });
    }

    const upstream = await fetch(TARGET, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_sendRawTransaction",
        params: [raw],
      }),
    });
    const text = await upstream.text();
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      return res.status(502).json({ error: "bad_upstream_json" });
    }
    if (j.error) {
      return res.status(400).json({
        error: "rpc_rejected",
        detail: j.error.message || String(j.error),
      });
    }
    if (!j.result || typeof j.result !== "string") {
      return res.status(502).json({ error: "no_tx_hash" });
    }
    return res.status(200).json({ hash: j.result });
  } catch (err) {
    console.error("ptg-broadcast-mint", err);
    setCors(req, res);
    return res.status(500).json({
      error: "internal_error",
      detail: String(err && err.message ? err.message : err),
    });
  }
};
