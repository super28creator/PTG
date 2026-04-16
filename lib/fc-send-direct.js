/**
 * POST to Warpcast / Farcaster notification URL (per-user token).
 * @see https://miniapps.farcaster.xyz/docs/guides/notifications
 */
const { getToken, hasServiceAccount } = require("./fc-notif-store.js");

function clip(s, max) {
  const t = String(s || "");
  return t.length <= max ? t : t.slice(0, max);
}

async function sendDirectToFid(fid, notification) {
  if (!hasServiceAccount()) {
    return { fid, ok: false, reason: "no_firebase" };
  }
  const row = await getToken(fid);
  if (!row || !row.url || !row.token) {
    return { fid, ok: false, reason: "no_stored_token" };
  }
  const notificationId = clip(notification.uuid || "", 128) || `ptg-${Date.now()}`;
  const body = {
    notificationId,
    title: clip(notification.title, 32),
    body: clip(notification.body, 128),
    targetUrl: String(notification.target_url || "https://phrasetoguess.xyz/"),
    tokens: [row.token],
  };
  const res = await fetch(row.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {}
  const ok =
    res.ok &&
    json &&
    Array.isArray(json.successfulTokens) &&
    json.successfulTokens.length > 0;
  return { fid, ok, status: res.status, body: json || text };
}

async function sendDirectToFids(target_fids, notification) {
  const results = [];
  const okFids = [];
  for (const fid of target_fids) {
    const r = await sendDirectToFid(fid, notification);
    results.push(r);
    if (r.ok) okFids.push(fid);
  }
  return { results, okFids };
}

module.exports = {
  sendDirectToFid,
  sendDirectToFids,
};
