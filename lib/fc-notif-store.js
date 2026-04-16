/**
 * Persists Farcaster Mini App notification tokens (per FID) in Firebase RTDB.
 * Admin SDK bypasses security rules — keep FIREBASE_SERVICE_ACCOUNT_JSON only on the server.
 */
const admin = require("firebase-admin");

const DATABASE_URL = "https://phrase-to-guess-default-rtdb.europe-west1.firebasedatabase.app";
const REF = "fc_notif_tokens";

/** Parsed service account; avoids re-parsing and surfaces one clear error for bad env. */
let cachedServiceAccount = null;

function parseServiceAccountFromEnv() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw == null || String(raw).trim() === "") {
    throw new Error("missing_firebase_service_account");
  }
  const trimmed = String(raw).trim();
  if (!trimmed.startsWith("{")) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_JSON must be the raw JSON from Firebase (Project settings → Service accounts → Generate new private key). Do not paste JavaScript sample code (e.g. var admin = require...)."
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON. Open the downloaded .json key file and paste its full contents into Vercel."
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON: expected a JSON object.");
  }
  if (!parsed.private_key || !parsed.client_email) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_JSON must be a Firebase service account key (needs private_key and client_email)."
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

module.exports = {
  saveToken,
  deleteToken,
  getToken,
  hasServiceAccount,
};
