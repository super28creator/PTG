/**
 * Persists Farcaster Mini App notification tokens (per FID) in Firebase RTDB.
 * Admin SDK bypasses security rules — keep FIREBASE_SERVICE_ACCOUNT_JSON only on the server.
 */
const admin = require("firebase-admin");

const DATABASE_URL = "https://phrase-to-guess-default-rtdb.europe-west1.firebasedatabase.app";
const REF = "fc_notif_tokens";

/** Parsed service account; avoids re-parsing and surfaces one clear error for bad env. */
let cachedServiceAccount = null;

/** Strip BOM; extract `{...}` if extra text was pasted; handle double-stringified JSON from Vercel. */
function normalizeFirebaseServiceAccountString(raw) {
  let s = String(raw).trim().replace(/^\uFEFF/, "");
  if (!s) return "";
  if (!s.startsWith("{")) {
    const i = s.indexOf("{");
    const j = s.lastIndexOf("}");
    if (i >= 0 && j > i) s = s.slice(i, j + 1);
  }
  let parsed;
  try {
    parsed = JSON.parse(s);
  } catch {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON. Paste the downloaded .json file only (no code samples)."
    );
  }
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON: double-encoded JSON parse failed.");
    }
  }
  return parsed;
}

function parseServiceAccountFromEnv() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw == null || String(raw).trim() === "") {
    throw new Error("missing_firebase_service_account");
  }
  const parsed = normalizeFirebaseServiceAccountString(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON: expected a JSON object.");
  }
  if (!parsed.private_key || !parsed.client_email) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_JSON must be a Firebase service account key (needs private_key and client_email). Do not paste the Node.js sample with var admin / require()."
    );
  }
  return parsed;
}

function getServiceAccount() {
  if (!cachedServiceAccount) {
    cachedServiceAccount = parseServiceAccountFromEnv();
  }
  return cachedServiceAccount;
}

function hasServiceAccount() {
  try {
    getServiceAccount();
    return true;
  } catch {
    return false;
  }
}

function initAdmin() {
  if (admin.apps.length) return;
  admin.initializeApp({
    credential: admin.credential.cert(getServiceAccount()),
    databaseURL: DATABASE_URL,
  });
}

async function saveToken(fid, notificationDetails) {
  if (!notificationDetails || !notificationDetails.url || !notificationDetails.token) return false;
  initAdmin();
  const id = String(Number(fid));
  await admin.database().ref(`${REF}/${id}`).set({
    url: String(notificationDetails.url),
    token: String(notificationDetails.token),
    updatedAt: Date.now(),
  });
  return true;
}

async function deleteToken(fid) {
  initAdmin();
  const id = String(Number(fid));
  await admin.database().ref(`${REF}/${id}`).remove();
}

async function getToken(fid) {
  if (!hasServiceAccount()) return null;
  try {
    initAdmin();
  } catch {
    return null;
  }
  const id = String(Number(fid));
  const snap = await admin.database().ref(`${REF}/${id}`).once("value");
  return snap.val() || null;
}

/** All FIDs that have a stored Warpcast notification token (for cron batch send). */
async function listAllTokenFids() {
  initAdmin();
  const snap = await admin.database().ref(REF).once("value");
  const v = snap.val();
  if (!v || typeof v !== "object") return [];
  return Object.keys(v)
    .map((k) => Number(k))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** Admin RTDB (tylko serwer — np. wypłaty referrali po tx USDC). */
function getAdminDb() {
  if (!hasServiceAccount()) {
    throw new Error("missing_firebase_service_account");
  }
  initAdmin();
  return admin.database();
}

module.exports = {
  saveToken,
  deleteToken,
  getToken,
  hasServiceAccount,
  listAllTokenFids,
  getAdminDb,
};
