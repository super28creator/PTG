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
  const seed = `${Date.now()}-${Math.random()}-${utcDateStamp()}`.replace(/[^0-9]/g, "").slice(0, 12);
  return `00000000-0000-4000-8000-${seed.padEnd(12, "0")}`;
}

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

  const apiKey = process.env.NEYNAR_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ ok: false, error: "missing_neynar_api_key" });
  }

  const payload = {
    target_fids: [],
    notification: {
      title: "Phrase To Guess",
      body: "Daily reminder: play today's game and keep your streak.",
      target_url: "https://phrasetoguess.xyz/?source=notif-daily",
      uuid: makeUuid(),
    },
  };

  try {
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
    return res.status(200).json({ ok: true, payload, neynar: json });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "internal_error",
      message: err && err.message ? String(err.message) : "unknown_error",
    });
  }
};
