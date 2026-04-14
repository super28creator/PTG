/**
 * Proxy JSON-RPC → Base (serwer → mainnet.base.org), żeby przeglądarka nie uderzała
 * w publiczne RPC z CORS. Dozwolone tylko metody odczytu używane przy mincie.
 */

const TARGET = process.env.BASE_RPC_URL || "https://mainnet.base.org";

const ALLOWED = new Set([
  "eth_call",
  "eth_estimateGas",
  "eth_getBlockByNumber",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_getStorageAt",
  "eth_maxPriorityFeePerGas",
  "eth_chainId",
  "eth_blockNumber",
]);

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

    if (!body || typeof body !== "object" || typeof body.method !== "string") {
      return res.status(400).json({ error: "bad_request" });
    }
    if (!ALLOWED.has(body.method)) {
      return res.status(403).json({ error: "rpc_method_not_allowed" });
    }

    const upstream = await fetch(TARGET, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.send(text);
  } catch (err) {
    console.error("base-jsonrpc", err);
    setCors(req, res);
    return res.status(500).json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: String(err && err.message ? err.message : err) },
    });
  }
};
