/**
 * Shared admin key check for bug reports + game events panels.
 * Accepts PTG_ADMIN_KEY or legacy PTG_BUG_ADMIN_KEY.
 */

function sanitizeSecret(raw) {
  let s = String(raw == null ? "" : raw).replace(/^\uFEFF/, "").trim();
  // Common Vercel paste mistakes: wrapping quotes / accidental newlines.
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/[\r\n]+/g, "").trim();
  return s;
}

function getConfiguredAdminKey() {
  const primary = sanitizeSecret(process.env.PTG_ADMIN_KEY);
  if (primary) return primary;
  return sanitizeSecret(process.env.PTG_BUG_ADMIN_KEY);
}

function isAdminConfigured() {
  return Boolean(getConfiguredAdminKey());
}

function readRequestAdminKey(req, body) {
  const headers = (req && req.headers) || {};
  const fromHeader = sanitizeSecret(headers["x-admin-key"] || headers["X-Admin-Key"]);
  if (fromHeader) return fromHeader;

  const auth = sanitizeSecret(headers.authorization || headers.Authorization);
  if (auth.toLowerCase().startsWith("bearer ")) {
    const tok = sanitizeSecret(auth.slice(7));
    if (tok) return tok;
  }

  if (body && typeof body === "object") {
    const fromBody = sanitizeSecret(body.adminKey || body.admin_key || body.key);
    if (fromBody) return fromBody;
  }
  return "";
}

function isAdminRequest(req, body) {
  const key = getConfiguredAdminKey();
  if (!key) return false;
  const provided = readRequestAdminKey(req, body);
  return provided.length > 0 && provided === key;
}

/** @returns {{ ok: true } | { ok: false, status: number, error: string }} */
function requireAdmin(req, body) {
  if (!isAdminConfigured()) {
    return { ok: false, status: 503, error: "admin_key_not_configured" };
  }
  if (!isAdminRequest(req, body)) {
    return { ok: false, status: 401, error: "unauthorized_admin" };
  }
  return { ok: true };
}

module.exports = {
  sanitizeSecret,
  getConfiguredAdminKey,
  isAdminConfigured,
  isAdminRequest,
  requireAdmin,
  readRequestAdminKey,
};
