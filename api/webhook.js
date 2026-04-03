/**
 * Farcaster Mini App — webhook dla zdarzeń (miniapp_added, removed, notifications_*).
 * Zwraca 200, żeby walidacja URL w manifeście nie padała; logika powiadomień możesz dodać później.
 */
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

module.exports = (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }
  try {
    if (req.body && typeof req.body === "object" && req.body.event) {
      console.log("farcaster webhook", req.body.event);
    }
  } catch (_) {}
  return res.status(200).json({ ok: true });
};
