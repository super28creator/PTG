/**
 * Farcaster Mini App — webhook (miniapp_added, removed, notifications_*).
 * GET/HEAD/OPTIONS/POST → 200, żeby walidacja URL przy publikacji manifestu nie padała.
 */
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

module.exports = (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET" || req.method === "HEAD") {
    return res.status(200).json({ ok: true, service: "ptg-farcaster-webhook" });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, HEAD, POST, OPTIONS");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }
  try {
    if (req.body && typeof req.body === "object" && req.body.event) {
      console.log("farcaster webhook", req.body.event);
    }
  } catch (_) {}
  return res.status(200).json({ ok: true });
};
