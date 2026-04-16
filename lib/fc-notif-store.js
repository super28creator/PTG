/**
 * Persists Farcaster Mini App notification tokens (per FID) in Firebase RTDB.
 * Admin SDK bypasses security rules — keep FIREBASE_SERVICE_ACCOUNT_JSON only on the server.
 */
const admin = require("firebase-admin");

const DATABASE_URL = "https://phrase-to-guess-default-rtdb.europe-west1.firebasedatabase.app";
const REF = "fc_notif_tokens";

function hasServiceAccount() {
  return Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
}

function initAdmin() {
  if (admin.apps.length) return;
  if (!hasServiceAccount()) {
    throw new Error("missing_firebase_service_account");
  }
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)),
    databaseURL: DATABASE_URL,
  });
}

async function saveToken(fid, notificationDetails) {
  if (!notificationDetails || !notificationDetails.url || !notificationDetails.token) return;
  initAdmin();
  const id = String(Number(fid));
  await admin.database().ref(`${REF}/${id}`).set({
    url: String(notificationDetails.url),
    token: String(notificationDetails.token),
    updatedAt: Date.now(),
  });
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
