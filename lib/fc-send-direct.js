/**
 * POST to Warpcast / Farcaster notification URL (per-user token).
 * @see https://miniapps.farcaster.xyz/docs/guides/notifications
 */
const { getToken, hasServiceAccount } = require("./fc-notif-store.js");

function clip(s, max) {
  const t = String(s || "");
  return t.length <= max ? t : t.slice(0, max);
}

const APP_HOST = "phrasetoguess.xyz";

/** Farcaster requires targetUrl on the same domain as the Mini App. */
function sameOriginTargetUrl(url) {
  try {
    const u = new URL(String(url || "").trim() || `https://${APP_HOST}/`);
    if (u.hostname === APP_HOST || u.hostname.endsWith(`.${APP_HOST}`)) {
      return u.toString();
    }
  } catch (_) {}
  return `https://${APP_HOST}/`;
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
    targetUrl: sameOriginTargetUrl(notification.target_url || "https://phrasetoguess.xyz/"),
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
  const successful =
    json &&
    (Array.isArray(json.successfulTokens) && json.successfulTokens.length > 0
      ? json.successfulTokens
      : json.result &&
          Array.isArray(json.result.successfulTokens) &&
          json.result.successfulTokens.length > 0
        ? json.result.successfulTokens
        : null);
  const ok = res.ok && successful && successful.length > 0;
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
