/**
 * Game events admin + public active-event read.
 *
 * POST JSON:
 *   { op: "event_get_active" }                         // public
 *   { op: "admin_ping" }                               // admin
 *   { op: "event_list" }                               // admin
 *   { op: "event_start", name, winPoints, mintPoints, durationMinutes|durationMs, style }  // admin
 *   { op: "event_stop" }                               // admin
 */

const { getAdminDb, hasServiceAccount } = require("../lib/fc-notif-store.js");
const { requireAdmin } = require("../lib/ptg-admin-auth.js");
const {
  getActiveEvent,
  startEvent,
  stopActiveEvent,
  listRecentEvents,
  STYLE_PRESETS,
} = require("../lib/ptg-game-events.js");

function setCors(req, res) {
  const o = req.headers.origin;
  if (o && o !== "null") {
    res.setHeader("Access-Control-Allow-Origin", o);
    res.setHeader("Access-Control-Allow-Credentials", "false");
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Key");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function noStore(res) {
  res.setHeader("Cache-Control", "private, no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
}

module.exports = async (req, res) => {
  setCors(req, res);
  noStore(res);
  try {
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST, OPTIONS");
      return res.status(405).json({ error: "method_not_allowed" });
    }

    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body || "{}");
      } catch {
        return res.status(400).json({ error: "invalid_json" });
      }
    }
    const op = body && typeof body.op === "string" ? body.op.trim() : "";

    if (op === "event_get_active") {
      if (!hasServiceAccount()) {
        return res.status(200).json({ ok: true, active: null, serverNow: Date.now() });
      }
      try {
        const db = getAdminDb();
        const active = await getActiveEvent(db);
        return res.status(200).json({ ok: true, active, serverNow: Date.now() });
      } catch (e) {
        return res.status(500).json({ error: "db_read_failed", detail: String(e && e.message) });
      }
    }

    if (op === "admin_ping") {
      const gate = requireAdmin(req);
      if (!gate.ok) return res.status(gate.status).json({ error: gate.error });
      if (!hasServiceAccount()) {
        return res.status(503).json({ error: "firebase_admin_missing" });
      }
      return res.status(200).json({ ok: true, role: "admin", serverNow: Date.now() });
    }

    if (op === "event_list") {
      const gate = requireAdmin(req);
      if (!gate.ok) return res.status(gate.status).json({ error: gate.error });
      if (!hasServiceAccount()) {
        return res.status(503).json({ error: "firebase_admin_missing" });
      }
      try {
        const db = getAdminDb();
        const data = await listRecentEvents(db, body && body.limit);
        return res.status(200).json({ ok: true, ...data, serverNow: Date.now() });
      } catch (e) {
        return res.status(500).json({ error: "db_read_failed", detail: String(e && e.message) });
      }
    }

    if (op === "event_start") {
      const gate = requireAdmin(req);
      if (!gate.ok) return res.status(gate.status).json({ error: gate.error });
      if (!hasServiceAccount()) {
        return res.status(503).json({ error: "firebase_admin_missing" });
      }
      try {
        const db = getAdminDb();
        const active = await startEvent(db, body || {});
        return res.status(200).json({ ok: true, active, presets: STYLE_PRESETS, serverNow: Date.now() });
      } catch (e) {
        const msg = String(e && e.message ? e.message : "invalid_event");
        const bad =
          msg === "missing_name" ||
          msg === "duration_too_short" ||
          msg === "duration_too_long";
        return res.status(bad ? 400 : 500).json({ error: msg });
      }
    }

    if (op === "event_stop") {
      const gate = requireAdmin(req);
      if (!gate.ok) return res.status(gate.status).json({ error: gate.error });
      if (!hasServiceAccount()) {
        return res.status(503).json({ error: "firebase_admin_missing" });
      }
      try {
        const db = getAdminDb();
        const result = await stopActiveEvent(db);
        return res.status(200).json({ ok: true, ...result, active: null, serverNow: Date.now() });
      } catch (e) {
        return res.status(500).json({ error: "db_write_failed", detail: String(e && e.message) });
      }
    }

    return res.status(400).json({ error: "unknown_op" });
  } catch (err) {
    console.error("ptg-admin-events", err);
    setCors(req, res);
    noStore(res);
    return res.status(500).json({ error: "server_error" });
  }
};
