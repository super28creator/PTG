/**
 * Farcaster Mini App — webhook (miniapp_added, removed, notifications_*).
 * Verifies JFS with Neynar, persists notification tokens to Firebase RTDB for direct sends.
 * @see https://miniapps.farcaster.xyz/docs/guides/notifications
 */
const { parseWebhookEvent, verifyAppKeyWithNeynar } = require("@farcaster/miniapp-node");
const { saveToken, deleteToken, hasServiceAccount } = require("../lib/fc-notif-store.js");

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET" || req.method === "HEAD") {
    return res.status(200).json({
      ok: true,
      service: "ptg-farcaster-webhook",
      firebase: hasServiceAccount(),
    });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, HEAD, POST, OPTIONS");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  if (!process.env.NEYNAR_API_KEY) {
    return res.status(503).json({
      ok: false,
      error: "missing_neynar_api_key",
      hint: "NEYNAR_API_KEY required to verify webhook signatures",
    });
  }
  if (!hasServiceAccount()) {
    return res.status(503).json({
      ok: false,
      error: "missing_firebase_service_account",
      hint: "Set FIREBASE_SERVICE_ACCOUNT_JSON (Firebase RTDB) to store notification tokens",
    });
  }

  try {
    const raw = req.body;
    const { fid, event } = await parseWebhookEvent(raw, verifyAppKeyWithNeynar);

    if (event.event === "miniapp_added" && event.notificationDetails) {
      await saveToken(fid, event.notificationDetails);
    } else if (event.event === "notifications_enabled") {
      await saveToken(fid, event.notificationDetails);
    } else if (event.event === "miniapp_removed" || event.event === "notifications_disabled") {
      await deleteToken(fid);
    }

    return res.status(200).json({ ok: true, event: event.event, fid });
  } catch (e) {
    console.error("farcaster webhook", e);
    const msg = e && e.message ? String(e.message) : "webhook_error";
    return res.status(400).json({ ok: false, error: msg });
  }
};
