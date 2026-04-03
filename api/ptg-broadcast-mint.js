/**
 * Wysyła podpisany raw tx na Base — mint PhraseToGuessNFT: mint() lub publicMint(string).
 * POST JSON: { "rawTransaction": "0x..." }
 */

const TARGET = process.env.BASE_RPC_URL || "https://mainnet.base.org";

const DEFAULT_PTG_NFT_ADDRESS =
  "0x9f9343A6833190EE0c816f71D72CE450b1ee8530";

/** Dozwolone wywołania mint na kontrakcie PTG. */
const MINT_METHODS = ["mint()", "publicMint(string)"];
const MAX_GAS_LIMIT = 900000n;

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

    const rawAddr =
      process.env.PTG_NFT_ADDRESS ||
      process.env.PTG_CIRCLE_NFT_ADDRESS ||
      DEFAULT_PTG_NFT_ADDRESS;

    const { ethers } = await import("ethers");
    let expectedTo;
    try {
      expectedTo = ethers.getAddress(String(rawAddr).trim());
    } catch {
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
    if (toAddr !== expectedTo) {
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
