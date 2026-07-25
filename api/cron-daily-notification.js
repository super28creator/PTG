/**
 * Codzienne przypomnienie (Base App + Farcaster) — jedna treść: lib/daily-notification-copy.js.
 * Harmonogram: vercel.json → 17:00 UTC (EU wieczór, US południe — dobry kompromis promocyjny).
 *
 * Hobby plan: funkcja ma 60s budżetu (vercel.json: maxDuration). Dlatego:
 *  - Base i Farcaster lecą RÓWNOLEGLE (różne domeny, osobne rate-limity).
 *  - Błąd jednego kanału NIE blokuje drugiego (każdy own try/catch).
 *  - Base: dzienna wariacja title/message/path — Dashboard deduplikuje identyczne payloady 24h.
 */
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

const {
  defaultAppUrl,
  fetchOptInWalletAddresses,
  sendToWallets,
  aggregateSendResults,
} = require("../lib/base-dashboard-notifications.js");
const { hasServiceAccount, listAllTokenFids, getAdminDb } = require("../lib/fc-notif-store.js");
const dailyCopy = require("../lib/daily-notification-copy.js");
const NEYNAR_TIMEOUT_MS = Number(process.env.NEYNAR_TIMEOUT_MS || 10000);
const NEYNAR_RETRY_ATTEMPTS = Number(process.env.NEYNAR_RETRY_ATTEMPTS || 3);

function makeUuid() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch (_) {}
  const seed = `${Date.now()}-${Math.random()}`.replace(/[^0-9]/g, "").slice(0, 12);
  return `00000000-0000-4000-8000-${seed.padEnd(12, "0")}`;
}

function channelOk(result) {
  if (!result) return false;
  /* skipped + ok:false (np. brak opted-in wallets) = kanał niezdrowy */
  if (result.skipped) return result.ok !== false;
  return result.ok === true;
}

async function runBaseChannel(baseKey, appUrl) {
  if (!baseKey) return { skipped: true, reason: "missing_base_dashboard_api_key" };

  const now = new Date();
  const payload = {
    title: dailyCopy.dailyTitleBase(now),
    message: dailyCopy.dailyMessageBase(now),
    target_path: dailyCopy.dailyTargetPathForCron(now),
    day: dailyCopy.utcDayKey(now),
  };

  let wallets = [];
  let fetchMeta = { truncated: false, pages: 0 };
  try {
    const fetched = await fetchOptInWalletAddresses(baseKey, appUrl);
    wallets = fetched.addresses || [];
    fetchMeta = { truncated: !!fetched.truncated, pages: fetched.pages || 0 };
  } catch (e) {
    return { ok: false, error: "fetch_users_failed", detail: e.body || e.message, payload };
  }
  if (wallets.length === 0) {
    return {
      ok: false,
      skipped: true,
      reason: "no_opted_in_wallets",
      hint: "BASE_APP_URL must match Base Dashboard app URL; users need Save + Allow notifications",
      payload,
    };
  }

  try {
    const sendResults = await sendToWallets(baseKey, appUrl, wallets, {
      title: payload.title,
      message: payload.message,
      target_path: payload.target_path,
    });
    const delivery = aggregateSendResults(sendResults);
    /*
     * HTTP 200 przy sentCount=0 = typowy objaw 24h dedupe albo wszyscy bez opt-in.
     * Przy known delivery i zerze — oznaczamy błąd, żeby cron nie wyglądał na „ok”.
     */
    if (delivery.known && delivery.sentCount === 0) {
      return {
        ok: false,
        error: "zero_deliveries",
        hint: "Base accepted the request but delivered 0 pushes (dedupe or users disabled notifications)",
        recipient_count: wallets.length,
        delivery,
        fetchMeta,
        payload,
        sendResults,
      };
    }
    return {
      ok: true,
      recipient_count: wallets.length,
      delivery,
      fetchMeta,
      payload,
      sendResults,
    };
  } catch (e) {
    return { ok: false, status: e.status, body: e.body, payload, fetchMeta };
  }
}

async function runFarcasterDirect(notification) {
  if (!hasServiceAccount()) return { skipped: true, reason: "no_firebase_service_account" };
  try {
    const { sendDirectToFids } = require("../lib/fc-send-direct.js");
    const fids = await listAllTokenFids();
    if (fids.length === 0) {
      return { ok: true, skipped: true, reason: "no_stored_tokens_in_rtdb" };
    }
    const { results, okFids } = await sendDirectToFids(fids, notification);
    return {
      ok: true,
      recipient_fids: fids.length,
      delivered: okFids.length,
      results,
    };
  } catch (e) {
    return { ok: false, error: e && e.message ? String(e.message) : "direct_failed" };
  }
}

async function runFarcasterNeynar(neynarKey, notification) {
  if (!neynarKey) return { skipped: true, reason: "missing_neynar_api_key" };
  try {
    let neynarRes = null;
    let text = "";
    let json = null;
    for (let attempt = 1; attempt <= NEYNAR_RETRY_ATTEMPTS; attempt++) {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), NEYNAR_TIMEOUT_MS);
      try {
        neynarRes = await fetch("https://api.neynar.com/v2/farcaster/frame/notifications/", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": neynarKey,
          },
          body: JSON.stringify({ target_fids: [], notification }),
          signal: ctrl.signal,
        });
        text = await neynarRes.text();
        try {
          json = text ? JSON.parse(text) : null;
        } catch (_) {}
        const retryable =
          neynarRes.status === 408 ||
          neynarRes.status === 409 ||
          neynarRes.status === 425 ||
          neynarRes.status === 429 ||
          neynarRes.status >= 500;
        if (!neynarRes.ok && retryable && attempt < NEYNAR_RETRY_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, Math.min(1500 * attempt, 4000)));
          continue;
        }
        break;
      } finally {
        clearTimeout(tid);
      }
    }
    if (!neynarRes) {
      return { ok: false, error: "neynar_no_response" };
    }
    if (
      neynarRes.status === 422 &&
      json &&
      (json.code === "NoNotificationTokens" || String(json.message || "").includes("No notification tokens"))
    ) {
      return { ok: true, skipped: true, reason: "no_neynar_tokens" };
    }
    if (!neynarRes.ok) {
      return { ok: false, status: neynarRes.status, body: json || text };
    }
    return { ok: true, neynar: json };
  } catch (e) {
    return { ok: false, error: e && e.message ? String(e.message) : "neynar_failed" };
  }
}

async function storeCronStatus(payload) {
  if (!hasServiceAccount()) return;
  try {
    const db = getAdminDb();
    const dayKey = new Date().toISOString().slice(0, 10);
    await db.ref(`ops/cron_daily_notifications/${dayKey}`).set(payload);
    await db.ref("ops/cron_daily_notifications_last").set(payload);
  } catch (_) {}
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

  const neynarKey = process.env.NEYNAR_API_KEY;
  const baseKey = process.env.BASE_DASHBOARD_API_KEY;
  const appUrl = defaultAppUrl();

  if (!neynarKey && !baseKey && !hasServiceAccount()) {
    return res.status(500).json({
      ok: false,
      error: "no_notification_providers",
      hint: "Set NEYNAR_API_KEY and/or BASE_DASHBOARD_API_KEY and/or FIREBASE_SERVICE_ACCOUNT_JSON",
    });
  }

  const startedAt = Date.now();
  const dailyFcNotification = {
    title: dailyCopy.dailyTitleFarcaster(),
    body: dailyCopy.dailyBodyFarcaster(),
    target_url: `${appUrl}${dailyCopy.DAILY_TARGET_PATH}`,
    uuid: makeUuid(),
  };

  try {
    /* Kanały lecą równolegle — różne domeny/rate-limity, a budżet funkcji = 60s wspólny. */
    const [baseResult, directResult, neynarResult] = await Promise.all([
      runBaseChannel(baseKey, appUrl).catch((e) => ({
        ok: false,
        error: String((e && e.message) || e),
      })),
      runFarcasterDirect(dailyFcNotification).catch((e) => ({
        ok: false,
        error: String((e && e.message) || e),
      })),
      runFarcasterNeynar(neynarKey, dailyFcNotification).catch((e) => ({
        ok: false,
        error: String((e && e.message) || e),
      })),
    ]);

    const baseOk = channelOk(baseResult);
    const fcDirectOk = channelOk(directResult);
    const fcNeynarOk = channelOk(neynarResult);
    const anyFcOk = fcDirectOk || fcNeynarOk;
    const allOk = baseOk && anyFcOk;

    const out = {
      ok: allOk,
      partial: !allOk && (baseOk || anyFcOk),
      app_url: appUrl,
      schedule_utc: "17:00",
      schedule_note: "Vercel cron 0 17 * * *; maxDuration=60s (Hobby max); Base+FC same time",
      elapsed_ms: Date.now() - startedAt,
      channels_ok: { base: baseOk, farcaster_direct: fcDirectOk, farcaster_neynar: fcNeynarOk },
      base: baseResult,
      farcaster_direct: directResult,
      farcaster: neynarResult,
      notification: dailyFcNotification,
    };
    await storeCronStatus({
      ...out,
      completed_at_iso: new Date().toISOString(),
    });

    return res.status(allOk || out.partial ? 200 : 500).json(out);
  } catch (err) {
    const fail = {
      ok: false,
      error: "internal_error",
      elapsed_ms: Date.now() - startedAt,
      message: err && err.message ? String(err.message) : "unknown_error",
      completed_at_iso: new Date().toISOString(),
    };
    await storeCronStatus(fail);
    return res.status(500).json(fail);
  }
};
