/**
 * Skalowane PNG dla manifestu Farcaster (wymiary ze spec Mini Apps).
 * ?type=icon (1024²) | splash (200²) | og (1200×630) | feed (1200×800, 3:2) | shot (1284×2778)
 */
const fs = require("fs");
const path = require("path");

let sharp;
try {
  sharp = require("sharp");
} catch (_) {
  sharp = null;
}

const SIZES = {
  icon: { w: 1024, h: 1024 },
  splash: { w: 200, h: 200 },
  og: { w: 1200, h: 630 },
  feed: { w: 1200, h: 800 },
  shot: { w: 1284, h: 2778 },
};

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET" && req.method !== "HEAD") {
    return res.status(405).send("Method Not Allowed");
  }
  if (!sharp) return res.status(500).send("sharp unavailable");

  const t = (req.query && req.query.type) || "icon";
  const dim = SIZES[t];
  if (!dim) {
    return res.status(400).send("type must be icon|splash|og|feed|shot");
  }

  try {
    const pngPath = path.join(process.cwd(), "PTG-main.png");
    const input = fs.readFileSync(pngPath);
    let img = sharp(input).resize(dim.w, dim.h, { fit: "cover", position: "centre" });
    if (t === "icon") {
      img = img.flatten({ background: { r: 10, g: 11, b: 13 } });
    }
    const out = await img.png().toBuffer();
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=604800, s-maxage=86400");
    if (req.method === "HEAD") return res.status(200).end();
    return res.status(200).send(out);
  } catch (e) {
    console.error("farcaster-asset", t, e);
    return res.status(500).send("error");
  }
};
