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

/** Odczyt z różnych schematów odpowiedzi Warpcast / Farcaster. */
function extractArray(json, key) {
  if (!json) return [];
  if (Array.isArray(json[key])) return json[key];
  if (json.result && Array.isArray(json.result[key])) return json.result[key];
  return [];
}

async function sendDirectToFid(fid, notification) {
  if (!hasServiceAccount()) {
    return { fid, ok: false, reason: "no_firebase" };
  }
  const row = await getToken(fid);
  if (!row || !row.url || !row.token) {
    return { fid, ok: false, reason: "no_stored_token" };
  }
  const { results } = await sendDirectBatch(row.url, [{ fid, token: row.token }], notification);
  return results[0] || { fid, ok: false, reason: "no_result" };
}

/**
 * Wysyła jeden request z maks. 100 tokenami na ten sam URL (limit z docs Farcaster).
 * Zwraca per-fid statusy + zbiorczy response.
 */
async function sendDirectBatch(url, tokenRows, notification) {
  const tokens = tokenRows.map((r) => r.token);
  const notificationId = clip(notification.uuid || "", 128) || `ptg-${Date.now()}`;
  const body = {
    notificationId,
    title: clip(notification.title, 32),
    body: clip(notification.body, 128),
    targetUrl: sameOriginTargetUrl(notification.target_url || "https://phrasetoguess.xyz/"),
    tokens,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {}

  const successful = new Set(extractArray(json, "successfulTokens"));
  const invalid = new Set(extractArray(json, "invalidTokens"));
  const rateLimited = new Set(extractArray(json, "rateLimitedTokens"));

  const results = tokenRows.map(({ fid, token }) => {
    const ok = successful.has(token);
    let reason = null;
    if (!ok) {
      if (invalid.has(token)) reason = "invalid_token";
      else if (rateLimited.has(token)) reason = "rate_limited";
      else reason = res.ok ? "not_in_successful_tokens" : `http_${res.status}`;
    }
    return { fid, ok, status: res.status, reason, body: json || text };
  });
  return { results, status: res.status, body: json || text };
}

async function sendDirectToFids(target_fids, notification) {
  if (!hasServiceAccount()) {
    return {
      results: target_fids.map((fid) => ({ fid, ok: false, reason: "no_firebase" })),
      okFids: [],
    };
  }
  const rows = [];
  for (const fid of target_fids) {
    const row = await getToken(fid);
    if (!row || !row.url || !row.token) {
      rows.push({ fid, row: null });
    } else {
      rows.push({ fid, row });
    }
  }

  const groups = new Map();
  for (const { fid, row } of rows) {
    if (!row) continue;
    const list = groups.get(row.url) || [];
    list.push({ fid, token: row.token });
    groups.set(row.url, list);
  }

  const results = rows
    .filter(({ row }) => !row)
    .map(({ fid }) => ({ fid, ok: false, reason: "no_stored_token" }));
  const okFids = [];

  for (const [url, tokenRows] of groups.entries()) {
    for (let i = 0; i < tokenRows.length; i += 100) {
      const chunk = tokenRows.slice(i, i + 100);
      try {
        const { results: chunkResults } = await sendDirectBatch(url, chunk, notification);
        for (const r of chunkResults) {
          results.push(r);
          if (r.ok) okFids.push(r.fid);
        }
      } catch (e) {
        for (const { fid } of chunk) {
          results.push({ fid, ok: false, reason: "fetch_error", error: String(e && e.message ? e.message : e) });
        }
      }
    }
  }
  return { results, okFids };
}

module.exports = {
  sendDirectToFid,
  sendDirectToFids,
};
