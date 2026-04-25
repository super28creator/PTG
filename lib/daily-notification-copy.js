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

/**
 * Base Dashboard deduplikuje identyczne (title, message, target_path) w oknie 24h
 * i zwraca 200 bez pusha. Cron ma stałą kopię — bez zmiennego `target_path` kolejne
 * dni mogłyby nie wysyłać nic w Base App, gdy Farcaster (inne API) działa normalnie.
 * @param {Date} [utcDate] — domyślnie „teraz” (UTC dla toISOString)
 */
function dailyTargetPathForCron(utcDate = new Date()) {
  const day = utcDate.toISOString().slice(0, 10);
  return `${DAILY_TARGET_PATH}&day=${day}`;
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

function dailyTitleBase() {
  return clip(DAILY_NOTIF_TITLE, 30);
}

function dailyMessageBase() {
  return clip(DAILY_NOTIF_BODY, 200);
}

module.exports = {
  DAILY_NOTIF_TITLE,
  DAILY_NOTIF_BODY,
  DAILY_SOURCE_QUERY,
  DAILY_TARGET_PATH,
  dailyTargetPathForCron,
  dailyTitleFarcaster,
  dailyBodyFarcaster,
  dailyTitleBase,
  dailyMessageBase,
};
