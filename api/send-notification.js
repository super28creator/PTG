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
const { hasServiceAccount } = require("../lib/fc-notif-store.js");

function makeUuid() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch (_) {}
  const rnd = `${Date.now()}-${Math.random()}`.replace(/[^0-9]/g, "").slice(0, 12);
  return `00000000-0000-4000-8000-${rnd.padEnd(12, "0")}`;
}

function clip(s, max) {
  const t = String(s || "");
  return t.length <= max ? t : t.slice(0, max);
}

function defaultDailyFarcaster() {
  return {
    title: "Phrase To Guess",
    body: "Daily reminder: play today's game and keep your streak.",
    target_url: "https://phrasetoguess.xyz/?source=notif-daily",
    uuid: makeUuid(),
  };
}

function defaultDailyBase() {
  return {
    title: clip("Phrase To Guess", 30),
    message: clip("Daily reminder: play today's game and keep your streak.", 200),
    target_path: "/?source=notif-daily",
  };
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET" || req.method === "HEAD") {
    return res.status(200).json({
      ok: true,
      service: "ptg-send-notification",
      channels: ["farcaster", "base", "both"],
      docs: {
        farcaster: "Neynar + NEYNAR_API_KEY; test: target_fids or env FC_TEST_FID",
        base: "BASE_DASHBOARD_API_KEY + BASE_APP_URL; test: wallet_addresses or notification.wallet_addresses or env BASE_TEST_WALLET",
        farcaster_tokens: "FIREBASE_SERVICE_ACCOUNT_JSON + webhook — stores Warpcast tokens per FID; sends via api.farcaster.xyz before Neynar",
        body: "Optional nested object notification: { title, body, message, target_path, target_fids, wallet_addresses }",
      },
    });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, HEAD, POST, OPTIONS");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const mode = String(body.mode || "daily").toLowerCase();
    const channel = String(body.channel || "both").toLowerCase();
    const n = body.notification && typeof body.notification === "object" ? body.notification : {};

    const out = { ok: true, mode, channel, farcaster: null, base: null };

    /* --- Farcaster: direct API (stored tokens) then Neynar fallback --- */
    if (channel === "farcaster" || channel === "both") {
      const apiKey = process.env.NEYNAR_API_KEY;

      const notification =
        mode === "test"
          ? {
              title: clip(n.title || "Phrase To Guess", 32),
              body: clip(n.body || "Test notification from Phrase To Guess.", 128),
              target_url: String(n.target_url || "https://phrasetoguess.xyz/?source=notif-test"),
              uuid: String(n.uuid || makeUuid()),
            }
          : {
              ...defaultDailyFarcaster(),
              ...(n.title ? { title: clip(n.title, 32) } : {}),
              ...(n.body ? { body: clip(n.body, 128) } : {}),
              ...(n.target_url ? { target_url: String(n.target_url) } : {}),
              ...(n.uuid ? { uuid: String(n.uuid) } : {}),
            };

      let target_fids = Array.isArray(body.target_fids)
        ? body.target_fids
            .map((x) => Number(x))
            .filter((x) => Number.isInteger(x) && x > 0)
            .slice(0, 100)
        : [];
      if (mode === "test" && target_fids.length === 0 && process.env.FC_TEST_FID) {
        const fid = Number(String(process.env.FC_TEST_FID).trim());
        if (Number.isInteger(fid) && fid > 0) target_fids = [fid];
      }
      if (mode === "test" && target_fids.length === 0 && process.env.FC_TEST_FIDS) {
        const extra = String(process.env.FC_TEST_FIDS)
          .split(/[\s,]+/)
          .map((s) => Number(s.trim()))
          .filter((x) => Number.isInteger(x) && x > 0)
          .slice(0, 100);
        if (extra.length) target_fids = extra;
      }
      if (target_fids.length === 0 && Array.isArray(n.target_fids)) {
        target_fids = n.target_fids
          .map((x) => Number(x))
          .filter((x) => Number.isInteger(x) && x > 0)
          .slice(0, 100);
      }

      let directMeta = null;
      let neynarTargetFids = target_fids;
      if (hasServiceAccount() && target_fids.length > 0) {
        const { sendDirectToFids } = require("../lib/fc-send-direct.js");
        const { results, okFids } = await sendDirectToFids(target_fids, notification);
        directMeta = { results, okFids };
        neynarTargetFids = target_fids.filter((fid) => !okFids.includes(fid));
      }

      const needNeynarBroadcast = target_fids.length === 0;
      const needNeynarSubset = neynarTargetFids.length > 0;
      const needNeynar = needNeynarBroadcast || needNeynarSubset;

      if (!needNeynar && target_fids.length > 0) {
        out.farcaster = {
          ok: true,
          via: "farcaster_direct_api",
          direct: directMeta,
          notification,
        };
      } else if (needNeynar && !apiKey) {
        out.farcaster = {
          ok: false,
          error: "missing_neynar_api_key",
          hint: "Broadcast (empty target_fids) still needs Neynar; or complete direct sends for all FIDs",
          direct: directMeta,
        };
        if (channel === "farcaster") {
          return res.status(500).json({ ok: false, error: "missing_neynar_api_key" });
        }
      } else if (needNeynar && apiKey) {
        const neynarRes = await fetch("https://api.neynar.com/v2/farcaster/frame/notifications/", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
          },
          body: JSON.stringify({
            target_fids: neynarTargetFids,
            notification,
          }),
        });
        const text = await neynarRes.text();
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch (_) {}
        if (!neynarRes.ok) {
          out.farcaster = {
            ok: false,
            status: neynarRes.status,
            body: json || text,
            direct: directMeta,
            neynar_target_fids: neynarTargetFids,
          };
          if (channel === "farcaster") {
            return res.status(neynarRes.status).json({
              ok: false,
              error: "neynar_send_failed",
              neynar_status: neynarRes.status,
              neynar_body: json || text || null,
              direct: directMeta,
            });
          }
        } else {
          out.farcaster = {
            ok: true,
            sent_to: neynarTargetFids.length > 0 ? "target_fids" : "all_opted_in",
            notification,
            neynar: json,
            direct: directMeta,
          };
        }
      }
    }

    /* --- Base App (Dashboard REST API) --- */
    if (channel === "base" || channel === "both") {
      const baseKey = process.env.BASE_DASHBOARD_API_KEY;
      const appUrl = defaultAppUrl();
      if (!baseKey) {
        if (channel === "base") {
          return res.status(500).json({
            ok: false,
            error: "missing_base_dashboard_api_key",
            hint: "Create an API key in Base Dashboard (dashboard.base.org) → Settings → API Key",
          });
        }
        out.base = { skipped: true, reason: "missing_base_dashboard_api_key" };
      } else {
        const title =
          mode === "test"
            ? clip(n.title || "Phrase To Guess", 30)
            : clip(n.title || defaultDailyBase().title, 30);
        const message =
          mode === "test"
            ? clip(n.message || n.body || "Test notification from Phrase To Guess.", 200)
            : clip(n.message || n.body || defaultDailyBase().message, 200);
        const target_path =
          n.target_path != null && n.target_path !== ""
            ? String(n.target_path)
            : mode === "test"
              ? "/?source=notif-test"
              : "/?source=notif-daily";

        let wallet_addresses = Array.isArray(body.wallet_addresses)
          ? body.wallet_addresses.map((a) => String(a).toLowerCase()).filter((a) => /^0x[a-f0-9]{40}$/.test(a))
          : [];
        if (wallet_addresses.length === 0 && Array.isArray(n.wallet_addresses)) {
          wallet_addresses = n.wallet_addresses
            .map((a) => String(a).toLowerCase())
            .filter((a) => /^0x[a-f0-9]{40}$/.test(a));
        }
        if (mode === "test" && wallet_addresses.length === 0 && process.env.BASE_TEST_WALLET) {
          wallet_addresses = String(process.env.BASE_TEST_WALLET)
            .split(/[\s,]+/)
            .map((a) => a.trim().toLowerCase())
            .filter((a) => /^0x[a-f0-9]{40}$/.test(a));
        }

        if (mode === "test" && wallet_addresses.length === 0) {
          out.base = {
            ok: false,
            error: "wallet_addresses_required",
            hint: "For Base test, set wallet_addresses, body.wallet_addresses, or env BASE_TEST_WALLET",
          };
          if (channel === "base") {
            return res.status(400).json(out.base);
          }
        } else {
          let fetchErr = null;
          if (mode === "daily" && wallet_addresses.length === 0) {
            try {
              wallet_addresses = await fetchOptInWalletAddresses(baseKey, appUrl);
            } catch (e) {
              fetchErr = e;
            }
          }

          if (fetchErr) {
            out.base = { ok: false, error: "fetch_users_failed", detail: fetchErr.body || fetchErr.message };
            if (channel === "base") {
              return res.status(fetchErr.status || 500).json({
                ok: false,
                error: "base_users_failed",
                detail: fetchErr.body,
              });
            }
          } else if (wallet_addresses.length === 0) {
            out.base = {
              ok: false,
              error: "no_wallet_addresses",
              hint: "No opted-in users, or BASE_APP_URL must match Base Dashboard app URL",
            };
            if (channel === "base") {
              return res.status(422).json(out.base);
            }
          } else {
            try {
              const sendResults = await sendToWallets(baseKey, appUrl, wallet_addresses, {
                title,
                message,
                target_path,
              });
              out.base = {
                ok: true,
                app_url: appUrl,
                recipient_count: wallet_addresses.length,
                title,
                message,
                target_path,
                sendResults,
              };
            } catch (e) {
              out.base = { ok: false, status: e.status, body: e.body };
              if (channel === "base") {
                return res.status(e.status || 500).json({
                  ok: false,
                  error: "base_send_failed",
                  detail: e.body,
                });
              }
            }
          }
        }
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
