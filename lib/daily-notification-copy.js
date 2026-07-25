/**
 * Jedna treść dla dziennego przypomnienia: Base App (Dashboard) + Farcaster (direct/Neynar).
 * Harmonogram: vercel.json → `"schedule": "0 17 * * *"` → 17:00 UTC codziennie
 * (ok. 18:00 CET — szczyt po pracy w EU; ok. 12:00 ET — lunch w USA; kompromis promocyjny).
 */
const DAILY_SOURCE_QUERY = "notif-daily";

const DAILY_NOTIF_TITLE = "Guess your phrase today?";
const DAILY_NOTIF_BODY =
  "Do you guess your phrase today? Play now & keep your streak on Base. 🎯✨";

/** Path only; pełny URL: defaultAppUrl() + DAILY_TARGET_PATH */
const DAILY_TARGET_PATH = `/?source=${DAILY_SOURCE_QUERY}`;

const MONTHS_UTC = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function utcDayKey(utcDate = new Date()) {
  return utcDate.toISOString().slice(0, 10);
}

/**
 * Base Dashboard deduplikuje identyczne (title, message, target_path) w oknie 24h
 * i zwraca 200 bez pusha. Cron leci co dokładnie 24h ze stałą kopią — bez dziennej
 * zmienności Base App przestaje dostawać push (Farcaster ma osobne UUID/API).
 *
 * Sam `target_path?day=` bywa niewystarczający, jeśli host normalizuje path / query.
 * Dlatego Base zmienia też title + message na dzień UTC.
 */
function dailyTargetPathForCron(utcDate = new Date()) {
  return `${DAILY_TARGET_PATH}&day=${utcDayKey(utcDate)}`;
}

function clip(s, max) {
  const t = String(s || "");
  return t.length <= max ? t : t.slice(0, max);
}

function dailyTitleFarcaster() {
  return clip(DAILY_NOTIF_TITLE, 32);
}

function dailyBodyFarcaster() {
  return clip(DAILY_NOTIF_BODY, 128);
}

/** Base title max 30 — krótka, dzienna wariacja bije 24h dedupe. */
function dailyTitleBase(utcDate = new Date()) {
  const d = utcDate.getUTCDate();
  const m = MONTHS_UTC[utcDate.getUTCMonth()];
  return clip(`Guess phrase · ${d} ${m}`, 30);
}

/** Base message max 200 — dopisek daty UTC, gdy path query zostałby zignorowany. */
function dailyMessageBase(utcDate = new Date()) {
  const day = utcDayKey(utcDate);
  const suffix = ` (${day})`;
  const room = Math.max(0, 200 - suffix.length);
  return clip(clip(DAILY_NOTIF_BODY, room) + suffix, 200);
}

module.exports = {
  DAILY_NOTIF_TITLE,
  DAILY_NOTIF_BODY,
  DAILY_SOURCE_QUERY,
  DAILY_TARGET_PATH,
  utcDayKey,
  dailyTargetPathForCron,
  dailyTitleFarcaster,
  dailyBodyFarcaster,
  dailyTitleBase,
  dailyMessageBase,
};
