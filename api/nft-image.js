/**
 * Serwuje PTG-main.png z pewnego Content-Type: image/png (obejście problemów ze statycznym PNG na Vercel/CDN).
 * Używane w polu `image` w nft.json — portfele i indeksatory robią GET/HEAD.
 */
const fs = require("fs");
const path = require("path");

module.exports = (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD, OPTIONS");
    return res.status(405).send("Method Not Allowed");
  }
  try {
    const p = path.join(process.cwd(), "PTG-main.png");
    const buf = fs.readFileSync(p);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=604800, s-maxage=86400");
    if (req.method === "HEAD") return res.status(200).end();
    return res.status(200).send(buf);
  } catch (e) {
    console.error("nft-image", e);
    return res.status(404).send("Not found");
  }
};
