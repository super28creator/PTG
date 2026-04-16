function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function utcDateStamp() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function makeUuid() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch (_) {}
  const rnd = `${Date.now()}-${Math.random()}`.replace(/[^0-9]/g, "").slice(0, 12);
  return `00000000-0000-4000-8000-${rnd.padEnd(12, "0")}`;
}

function defaultDailyNotification() {
  return {
    title: "Phrase To Guess",
    body: "Daily reminder: play today's game and keep your streak.",
    target_url: "https://phrasetoguess.xyz/?source=notif-daily",
    uuid: makeUuid(),
  };
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET" || req.method === "HEAD") {
    return res.status(200).json({ ok: true, service: "ptg-send-notification" });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, HEAD, POST, OPTIONS");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  try {
    const apiKey = process.env.NEYNAR_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ ok: false, error: "missing_neynar_api_key" });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const mode = String(body.mode || "daily").toLowerCase();
    const n = body.notification && typeof body.notification === "object" ? body.notification : {};

    const notification =
      mode === "test"
        ? {
            title: String(n.title || "Phrase To Guess"),
            body: String(n.body || "Test notification from Phrase To Guess."),
            target_url: String(n.target_url || "https://phrasetoguess.xyz/?source=notif-test"),
            uuid: String(n.uuid || makeUuid()),
          }
        : {
            ...defaultDailyNotification(),
            ...(n.title ? { title: String(n.title) } : {}),
            ...(n.body ? { body: String(n.body) } : {}),
            ...(n.target_url ? { target_url: String(n.target_url) } : {}),
            ...(n.uuid ? { uuid: String(n.uuid) } : {}),
          };

    const target_fids = Array.isArray(body.target_fids)
      ? body.target_fids
          .map((x) => Number(x))
          .filter((x) => Number.isInteger(x) && x > 0)
          .slice(0, 100)
      : [];

    const payload = {
      target_fids,
      notification,
    };

    const neynarRes = await fetch("https://api.neynar.com/v2/farcaster/frame/notifications/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify(payload),
    });

    const text = await neynarRes.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {}

    if (!neynarRes.ok) {
      return res.status(neynarRes.status).json({
        ok: false,
        error: "neynar_send_failed",
        neynar_status: neynarRes.status,
        neynar_body: json || text || null,
      });
    }

    return res.status(200).json({
      ok: true,
      mode,
      sent_to: target_fids.length > 0 ? "target_fids" : "all_opted_in",
      notification,
      neynar: json,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "internal_error",
      message: err && err.message ? String(err.message) : "unknown_error",
    });
  }
};
