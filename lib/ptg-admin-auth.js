/**
 * Shared admin key check for bug reports + game events panels.
 * Accepts PTG_ADMIN_KEY or legacy PTG_BUG_ADMIN_KEY.
 */

function getConfiguredAdminKey() {
  const primary = String(process.env.PTG_ADMIN_KEY || "").trim();
  if (primary) return primary;
  return String(process.env.PTG_BUG_ADMIN_KEY || "").trim();
}

function isAdminConfigured() {
  return Boolean(getConfiguredAdminKey());
}

function isAdminRequest(req) {
  const key = getConfiguredAdminKey();
  if (!key) return false;
  const fromHeader = String((req && req.headers && req.headers["x-admin-key"]) || "").trim();
  return fromHeader.length > 0 && fromHeader === key;
}

/** @returns {{ ok: true } | { ok: false, status: number, error: string }} */
function requireAdmin(req) {
  if (!isAdminConfigured()) {
    return { ok: false, status: 503, error: "admin_key_not_configured" };
  }
  if (!isAdminRequest(req)) {
    return { ok: false, status: 401, error: "unauthorized_admin" };
  }
  return { ok: true };
}

module.exports = {
  getConfiguredAdminKey,
  isAdminConfigured,
  isAdminRequest,
  requireAdmin,
};
