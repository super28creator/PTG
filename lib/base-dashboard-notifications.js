/**
 * Base Dashboard REST API — in-app notifications (Base App only).
 * @see https://docs.base.org/apps/technical-guides/base-notifications
 */

const BASE_API = "https://dashboard.base.org/api/v1";

/** Docs: 10 requests/minute per IP across GET users + POST send */
const RATE_GAP_MS = Number(process.env.BASE_DASHBOARD_RATE_GAP_MS || 6500);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function defaultAppUrl() {
  return (process.env.BASE_APP_URL || "https://phrasetoguess.xyz").replace(/\/$/, "");
}

/**
 * Paginated GET /notifications/app/users (max 100 per page per docs).
 */
async function fetchOptInWalletAddresses(apiKey, appUrl) {
  const addresses = [];
  let cursor = undefined;
  let page = 0;
  for (;;) {
    if (page++ > 0) await sleep(RATE_GAP_MS);
    const u = new URL(`${BASE_API}/notifications/app/users`);
    u.searchParams.set("app_url", appUrl);
    u.searchParams.set("notification_enabled", "true");
    u.searchParams.set("limit", "100");
    if (cursor) u.searchParams.set("cursor", cursor);

    const res = await fetch(u.toString(), {
      headers: { "x-api-key": apiKey },
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {}
    if (!res.ok) {
      const err = new Error("base_dashboard_users_failed");
      err.status = res.status;
      err.body = json || text;
      throw err;
    }
    const users = (json && json.users) || [];
    for (const row of users) {
      if (row && row.address) {
        addresses.push(String(row.address).toLowerCase());
      }
    }
    const next =
      json &&
      (json.nextCursor != null
        ? json.nextCursor
        : json.next_cursor != null
          ? json.next_cursor
          : json.cursor);
    if (!next) break;
    cursor = next;
  }

  return [...new Set(addresses)];
}

/**
 * POST /notifications/send — max 1000 addresses per request; 10 req/min per IP total.
 */
async function sendToWallets(apiKey, appUrl, walletAddresses, { title, message, target_path }) {
  const chunks = [];
  for (let i = 0; i < walletAddresses.length; i += 1000) {
    chunks.push(walletAddresses.slice(i, i + 1000));
  }
  const results = [];
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    if (chunk.length === 0) continue;
    if (ci > 0) await sleep(RATE_GAP_MS);
    const res = await fetch(`${BASE_API}/notifications/send`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        app_url: appUrl,
        wallet_addresses: chunk,
        title,
        message,
        ...(target_path != null && target_path !== "" ? { target_path } : {}),
      }),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {}
    results.push({ status: res.status, ok: res.ok, body: json || text });
    if (!res.ok) {
      const err = new Error("base_dashboard_send_failed");
      err.status = res.status;
      err.body = json || text;
      err.results = results;
      throw err;
    }
  }
  return results;
}

module.exports = {
  defaultAppUrl,
  fetchOptInWalletAddresses,
  sendToWallets,
  BASE_API,
  RATE_GAP_MS,
};
