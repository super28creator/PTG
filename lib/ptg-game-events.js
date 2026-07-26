/**
 * Time-boxed game events: custom Win/Mint point rewards + visual style.
 * Stored at ptg_game_events_v1 (Admin SDK writes; active is public-readable).
 */

const EVENTS_ROOT = "ptg_game_events_v1";
const ACTIVE_PATH = `${EVENTS_ROOT}/active`;
const HISTORY_PATH = `${EVENTS_ROOT}/history`;

const DEFAULT_WIN = 1;
const DEFAULT_MINT = 2;
const MAX_POINTS = 1000;
const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MIN_DURATION_MS = 60 * 1000; // 1 minute

const STYLE_PRESETS = {
  gold: {
    preset: "gold",
    bg: "rgba(28, 22, 10, 0.92)",
    border: "rgba(251, 191, 36, 0.35)",
    winColor: "#fbbf24",
    mintColor: "#fde68a",
    accent: "#f59e0b",
    labelColor: "#f5e6c8",
    timerColor: "#fca5a5",
  },
  neon: {
    preset: "neon",
    bg: "rgba(10, 18, 32, 0.92)",
    border: "rgba(34, 211, 238, 0.4)",
    winColor: "#34d399",
    mintColor: "#22d3ee",
    accent: "#a78bfa",
    labelColor: "#c7d2fe",
    timerColor: "#f472b6",
  },
  fire: {
    preset: "fire",
    bg: "rgba(30, 12, 10, 0.94)",
    border: "rgba(248, 113, 113, 0.4)",
    winColor: "#fb923c",
    mintColor: "#f87171",
    accent: "#ef4444",
    labelColor: "#fecaca",
    timerColor: "#fdba74",
  },
  ice: {
    preset: "ice",
    bg: "rgba(8, 20, 32, 0.94)",
    border: "rgba(125, 211, 252, 0.4)",
    winColor: "#67e8f9",
    mintColor: "#93c5fd",
    accent: "#38bdf8",
    labelColor: "#e0f2fe",
    timerColor: "#a5b4fc",
  },
  classic: {
    preset: "classic",
    bg: "rgba(15, 18, 28, 0.85)",
    border: "rgba(255, 255, 255, 0.1)",
    winColor: "#22c55e",
    mintColor: "#38bdf8",
    accent: "#94a3b8",
    labelColor: "#cbd5e1",
    timerColor: "#f87171",
  },
};

function clampInt(n, min, max, fallback) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function isHexColor(s) {
  return typeof s === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s.trim());
}

function isCssColor(s) {
  if (typeof s !== "string") return false;
  const t = s.trim();
  if (!t || t.length > 64) return false;
  if (isHexColor(t)) return true;
  if (/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i.test(t)) return true;
  return false;
}

function normalizeStyle(input) {
  const raw = input && typeof input === "object" ? input : {};
  const presetName = typeof raw.preset === "string" ? raw.preset.trim().toLowerCase() : "classic";
  const base = STYLE_PRESETS[presetName] || STYLE_PRESETS.classic;
  const out = { ...base, preset: base.preset };
  const keys = ["bg", "border", "winColor", "mintColor", "accent", "labelColor", "timerColor"];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (isCssColor(raw[k])) out[k] = String(raw[k]).trim();
  }
  if (presetName === "custom" || raw.preset === "custom") out.preset = "custom";
  return out;
}

function publicEventView(ev) {
  if (!ev || typeof ev !== "object") return null;
  const endsAt = Number(ev.endsAt || 0);
  const startsAt = Number(ev.startsAt || 0);
  const now = Date.now();
  if (!Number.isFinite(endsAt) || endsAt <= now) return null;
  if (Number.isFinite(startsAt) && startsAt > now + 5000) {
    // Not started yet — still show so UI can countdown to start if needed
  }
  return {
    id: String(ev.id || ""),
    name: String(ev.name || "Event").slice(0, 48),
    winPoints: clampInt(ev.winPoints, 1, MAX_POINTS, DEFAULT_WIN),
    mintPoints: clampInt(ev.mintPoints, 1, MAX_POINTS, DEFAULT_MINT),
    startsAt: Number.isFinite(startsAt) ? startsAt : now,
    endsAt,
    style: normalizeStyle(ev.style),
    serverNow: now,
  };
}

function normalizeEventInput(body) {
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 48) : "Event";
  if (!name) throw new Error("missing_name");

  const winPoints = clampInt(body.winPoints, 1, MAX_POINTS, DEFAULT_WIN);
  const mintPoints = clampInt(body.mintPoints, 1, MAX_POINTS, DEFAULT_MINT);

  let durationMs = Number(body.durationMs);
  if (!Number.isFinite(durationMs) && body.durationMinutes != null) {
    durationMs = Number(body.durationMinutes) * 60 * 1000;
  }
  if (!Number.isFinite(durationMs) && body.endsAt != null) {
    durationMs = Number(body.endsAt) - Date.now();
  }
  durationMs = Math.floor(durationMs);
  if (!Number.isFinite(durationMs) || durationMs < MIN_DURATION_MS) {
    throw new Error("duration_too_short");
  }
  if (durationMs > MAX_DURATION_MS) throw new Error("duration_too_long");

  const now = Date.now();
  const startsAt = now;
  const endsAt = now + durationMs;
  const style = normalizeStyle(body.style);
  const id =
    typeof body.id === "string" && /^[a-zA-Z0-9_-]{4,40}$/.test(body.id)
      ? body.id
      : `ev_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  return {
    id,
    name,
    winPoints,
    mintPoints,
    startsAt,
    endsAt,
    durationMs,
    style,
    createdAt: now,
    updatedAt: now,
  };
}

async function expireActiveIfNeeded(db) {
  const snap = await db.ref(ACTIVE_PATH).once("value");
  if (!snap.exists()) return null;
  const ev = snap.val();
  const endsAt = Number(ev && ev.endsAt);
  if (!Number.isFinite(endsAt) || endsAt > Date.now()) return ev;
  const ended = { ...ev, endedAt: Date.now(), endedReason: "expired" };
  const histRef = db.ref(`${HISTORY_PATH}/${ev.id || ended.endedAt}`);
  await histRef.set(ended);
  await db.ref(ACTIVE_PATH).remove();
  return null;
}

async function getActiveEvent(db) {
  const ev = await expireActiveIfNeeded(db);
  return publicEventView(ev);
}

async function startEvent(db, body) {
  const next = normalizeEventInput(body);
  const prev = await expireActiveIfNeeded(db);
  if (prev && prev.id) {
    await db.ref(`${HISTORY_PATH}/${prev.id}`).set({
      ...prev,
      endedAt: Date.now(),
      endedReason: "replaced",
    });
  }
  await db.ref(ACTIVE_PATH).set(next);
  return publicEventView(next);
}

async function stopActiveEvent(db) {
  const snap = await db.ref(ACTIVE_PATH).once("value");
  if (!snap.exists()) return { stopped: false };
  const ev = snap.val() || {};
  const id = ev.id || String(Date.now());
  await db.ref(`${HISTORY_PATH}/${id}`).set({
    ...ev,
    endedAt: Date.now(),
    endedReason: "stopped",
  });
  await db.ref(ACTIVE_PATH).remove();
  return { stopped: true, id };
}

async function listRecentEvents(db, limit) {
  const lim = clampInt(limit, 1, 50, 20);
  const active = await getActiveEvent(db);
  const histSnap = await db.ref(HISTORY_PATH).limitToLast(lim).once("value");
  const raw = histSnap.val() || {};
  const history = Object.entries(raw)
    .map(([id, v]) => ({ id, ...((v && typeof v === "object") ? v : {}) }))
    .sort((a, b) => Number(b.endedAt || b.createdAt || 0) - Number(a.endedAt || a.createdAt || 0))
    .slice(0, lim)
    .map((row) => ({
      id: String(row.id || ""),
      name: String(row.name || "Event"),
      winPoints: clampInt(row.winPoints, 1, MAX_POINTS, DEFAULT_WIN),
      mintPoints: clampInt(row.mintPoints, 1, MAX_POINTS, DEFAULT_MINT),
      startsAt: Number(row.startsAt || 0),
      endsAt: Number(row.endsAt || 0),
      endedAt: Number(row.endedAt || 0),
      endedReason: String(row.endedReason || ""),
      style: normalizeStyle(row.style),
    }));
  return { active, history, presets: STYLE_PRESETS };
}

module.exports = {
  EVENTS_ROOT,
  ACTIVE_PATH,
  HISTORY_PATH,
  STYLE_PRESETS,
  DEFAULT_WIN,
  DEFAULT_MINT,
  normalizeStyle,
  publicEventView,
  getActiveEvent,
  startEvent,
  stopActiveEvent,
  listRecentEvents,
  expireActiveIfNeeded,
};
