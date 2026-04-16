function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

const {
  defaultAppUrl,
  fetchOptInWalletAddresses,
  sendToWallets,
} = require("../lib/base-dashboard-notifications.js");

function makeUuid() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch (_) {}
  const seed = `${Date.now()}-${Math.random()}`.replace(/[^0-9]/g, "").slice(0, 12);
  return `00000000-0000-4000-8000-${seed.padEnd(12, "0")}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Dashboard + Neynar share tight rate limits; space out calls (~10/min). */
const DASHBOARD_REQUEST_GAP_MS = 6500;

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = String(req.headers.authorization || "");
    if (auth !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
  }

  const neynarKey = process.env.NEYNAR_API_KEY;
  const baseKey = process.env.BASE_DASHBOARD_API_KEY;
  const appUrl = defaultAppUrl();

  if (!neynarKey && !baseKey) {
    return res.status(500).json({
      ok: false,
      error: "no_notification_providers",
      hint: "Set NEYNAR_API_KEY (Farcaster) and/or BASE_DASHBOARD_API_KEY (Base App)",
    });
  }

  const out = { ok: true, app_url: appUrl, farcaster: null, base: null };

  try {
    /* --- Base Dashboard: fetch opted-in wallets, send --- */
    if (baseKey) {
      let wallets = [];
      try {
        wallets = await fetchOptInWalletAddresses(baseKey, appUrl);
      } catch (e) {
        out.base = { ok: false, error: "fetch_users_failed", detail: e.body };
      }
      if (!out.base && wallets.length === 0) {
        out.base = { ok: true, skipped: true, reason: "no_opted_in_wallets" };
      } else if (!out.base) {
        await sleep(DASHBOARD_REQUEST_GAP_MS);
        try {
          const sendResults = await sendToWallets(baseKey, appUrl, wallets, {
            title: "Phrase To Guess",
            message: "Daily reminder: play today's game and keep your streak.",
            target_path: "/?source=notif-daily",
          });
          out.base = {
            ok: true,
            recipient_count: wallets.length,
            sendResults,
          };
        } catch (e) {
          out.base = { ok: false, status: e.status, body: e.body };
        }
      }
    }

    /* --- Neynar: broadcast to all Farcaster mini-app opt-ins --- */
    if (neynarKey) {
      const payload = {
        target_fids: [],
        notification: {
          title: "Phrase To Guess",
          body: "Daily reminder: play today's game and keep your streak.",
          target_url: `${appUrl}/?source=notif-daily`,
          uuid: makeUuid(),
        },
      };
      const neynarRes = await fetch("https://api.neynar.com/v2/farcaster/frame/notifications/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": neynarKey,
        },
        body: JSON.stringify(payload),
      });
      const text = await neynarRes.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch (_) {}
      if (!neynarRes.ok) {
        out.farcaster = { ok: false, status: neynarRes.status, body: json || text };
      } else {
        out.farcaster = { ok: true, neynar: json };
      }
    }

    return res.status(200).json(out);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "internal_error",
      message: err && err.message ? String(err.message) : "unknown_error",
    });
  }
};
