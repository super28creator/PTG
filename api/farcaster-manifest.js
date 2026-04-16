/**
 * Serves /.well-known/farcaster.json with optional Base Builder association.
 * Framedl and other Base-listed apps use top-level `baseBuilder.allowedAddresses`;
 * set BASE_BUILDER_ALLOWED_ADDRESSES on Vercel (comma-separated 0x addresses).
 */
const fs = require("fs");
const path = require("path");

function loadBaseManifest() {
  const p = path.join(process.cwd(), "farcaster-manifest.json");
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw);
}

function parseAllowedAddresses() {
  const raw = process.env.BASE_BUILDER_ALLOWED_ADDRESSES || "";
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[a-f0-9]{40}$/.test(s));
}

module.exports = (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD, OPTIONS");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  try {
    const manifest = loadBaseManifest();
    const addrs = parseAllowedAddresses();
    if (addrs.length > 0) {
      manifest.baseBuilder = { allowedAddresses: addrs };
    }
    const body = JSON.stringify(manifest);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=120, s-maxage=300");
    if (req.method === "HEAD") return res.status(200).end();
    return res.status(200).send(body);
  } catch (e) {
    console.error("farcaster-manifest", e);
    return res.status(500).json({ ok: false, error: "manifest_load_failed" });
  }
};
