/**
 * Shared admin key check for bug reports + game events panels.
 * Accepts PTG_ADMIN_KEY and/or legacy PTG_BUG_ADMIN_KEY (either may match).
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
  s = s.replace(/[\r\n\t]+/g, "").trim();
  return s;
}

function getConfiguredAdminKeys() {
  const out = [];
  const seen = Object.create(null);
  const candidates = [
    ["PTG_ADMIN_KEY", process.env.PTG_ADMIN_KEY],
    ["PTG_BUG_ADMIN_KEY", process.env.PTG_BUG_ADMIN_KEY],
  ];
  for (let i = 0; i < candidates.length; i++) {
    const name = candidates[i][0];
    const val = sanitizeSecret(candidates[i][1]);
    if (!val) continue;
    if (seen[val]) continue;
    seen[val] = true;
    out.push({ name, value: val });
  }
  return out;
}

function getConfiguredAdminKey() {
  const keys = getConfiguredAdminKeys();
  return keys.length ? keys[0].value : "";
}

function isAdminConfigured() {
  return getConfiguredAdminKeys().length > 0;
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
  const keys = getConfiguredAdminKeys();
  if (!keys.length) return false;
  const provided = readRequestAdminKey(req, body);
  if (!provided) return false;
  for (let i = 0; i < keys.length; i++) {
    if (provided === keys[i].value) return true;
  }
  return false;
}

/** Safe public diagnostics — never returns secret values. */
function adminAuthDiagnostics(req, body) {
  const keys = getConfiguredAdminKeys();
  const provided = readRequestAdminKey(req, body);
  return {
    configured: keys.length > 0,
    envPresent: {
      PTG_ADMIN_KEY: Boolean(sanitizeSecret(process.env.PTG_ADMIN_KEY)),
      PTG_BUG_ADMIN_KEY: Boolean(sanitizeSecret(process.env.PTG_BUG_ADMIN_KEY)),
    },
    configuredCount: keys.length,
    configuredLengths: keys.map((k) => k.value.length),
    providedLength: provided.length,
    matched: Boolean(provided) && keys.some((k) => k.value === provided),
  };
}

/** @returns {{ ok: true } | { ok: false, status: number, error: string, diag?: object }} */
function requireAdmin(req, body) {
  const keys = getConfiguredAdminKeys();
  if (!keys.length) {
    return { ok: false, status: 503, error: "admin_key_not_configured" };
  }
  if (!isAdminRequest(req, body)) {
    const diag = adminAuthDiagnostics(req, body);
    console.warn("ptg_admin_auth_fail", {
      providedLength: diag.providedLength,
      configuredLengths: diag.configuredLengths,
      envPresent: diag.envPresent,
    });
    return { ok: false, status: 401, error: "unauthorized_admin", diag };
  }
  return { ok: true };
}

module.exports = {
  sanitizeSecret,
  getConfiguredAdminKey,
  getConfiguredAdminKeys,
  isAdminConfigured,
  isAdminRequest,
  requireAdmin,
  readRequestAdminKey,
  adminAuthDiagnostics,
};
