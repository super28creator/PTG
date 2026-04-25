/**
 * Dwufunkcyjny endpoint — wszystko w jednym, bo plan Vercel Hobby limituje
 * liczbę Serverless Functions do 12.
 *
 * TRYB OBRAZKÓW (domyślny):
 *   /api/nft-image                 → PTG-main.png   (pole `image` w nft.json —
 *                                                     portfele/indeksatory GET/HEAD)
 *   /api/nft-image?c=fc            → farcaster 50%.png  (preview Farcaster)
 *   /api/nft-image?c=base          → base logo 50%.png  (preview Base / web)
 *   /api/nft-image?c=web           → base logo 50%.png
 *
 * TRYB HTML WRAPPER (gdy `html=1` — trafia tu przez rewrite `/api/ptg-invite`
 * skonfigurowany w vercel.json):
 *   /api/ptg-invite?c=<channel>&ref=<code>
 *     → strona z og:image / twitter:image / fc:miniapp wskazującymi na wariant
 *       grafiki (farcaster 50%.png dla fc, base logo 50%.png dla base/web),
 *       z meta-refresh + JS redirect do deep-linka docelowego kanału:
 *         c=fc   → farcaster.xyz/~/mini-apps/launch  (Farcaster / Warpcast)
 *         c=base → go.cb-w.com/dapp                  (Base App / Coinbase Wallet)
 *         c=web  → phrasetoguess.xyz                 (zwykły web)
 *
 *     Dzięki temu klient fetchujący wklejony URL widzi brandowaną kartę PTG,
 *     zamiast generycznej karty „Farcaster: a decentralized social network",
 *     którą serwuje `farcaster.xyz`.
 */
const fs = require("fs");
const path = require("path");

const ORIGIN = "https://phrasetoguess.xyz";
const TITLE = "Phrase To Guess";
const DESC =
  "Daily phrase game on Base. Guess letters, watch the chart, mint a trophy onchain.";

const VARIANTS = {
  fc: "farcaster 50%.png",
  farcaster: "farcaster 50%.png",
  base: "base logo 50%.png",
  web: "base logo 50%.png",
};

function htmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isHtmlMode(q) {
  const v = String((q && q.html) || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function serveImage(req, res, q) {
  const raw = String((q && q.c) || "").toLowerCase();
  const file = VARIANTS[raw] || "PTG-main.png";
  try {
    const p = path.join(process.cwd(), file);
    const buf = fs.readFileSync(p);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=604800, s-maxage=86400");
    if (req.method === "HEAD") return res.status(200).end();
    return res.status(200).send(buf);
  } catch (e) {
    console.error("nft-image img", raw, e);
    return res.status(404).send("Not found");
  }
}

function serveInviteHtml(req, res, q) {
  let c = String(q.c || "web").toLowerCase();
  if (c === "farcaster") c = "fc";
  if (c !== "fc" && c !== "base" && c !== "web") c = "web";

  const refRaw = String(q.ref || "").trim();
  const ref = /^[a-f0-9]{12}$/.test(refRaw) ? refRaw : "";
  const refQs = ref ? "ref=" + encodeURIComponent(ref) + "&" : "";

  const viaTag = c === "fc" ? "farcaster" : c;
  const appUrl = ORIGIN + "/?" + refQs + "via=" + encodeURIComponent(viaTag);

  let target;
  if (c === "fc") {
    target =
      "https://farcaster.xyz/~/mini-apps/launch?domain=phrasetoguess.xyz&url=" +
      encodeURIComponent(appUrl);
  } else if (c === "base") {
    target = "https://go.cb-w.com/dapp?cb_url=" + encodeURIComponent(appUrl);
  } else {
    target = appUrl;
  }

  const imageUrl =
    ORIGIN + "/api/nft-image?c=" + (c === "fc" ? "fc" : "base");
  const selfUrl =
    ORIGIN + "/api/ptg-invite?c=" + c + (ref ? "&ref=" + ref : "");

  const miniapp = {
    version: "1",
    imageUrl: imageUrl,
    button: {
      title: "Play Phrase To Guess",
      action: {
        type: "launch_frame",
        name: TITLE,
        url: appUrl,
        splashImageUrl: ORIGIN + "/api/nft-image",
        splashBackgroundColor: "#0a0b0d",
      },
    },
  };
  const miniappAttr = htmlEscape(JSON.stringify(miniapp));

  const tgtAttr = htmlEscape(target);
  const imgAttr = htmlEscape(imageUrl);
  const selfAttr = htmlEscape(selfUrl);
  const titleAttr = htmlEscape(TITLE);
  const descAttr = htmlEscape(DESC);
  const targetJson = JSON.stringify(target);

  const html =
    '<!doctype html>\n' +
    '<html lang="en">\n' +
    '<head>\n' +
    '<meta charset="utf-8" />\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1" />\n' +
    '<title>' + titleAttr + '</title>\n' +
    '<meta property="og:title" content="' + titleAttr + '" />\n' +
    '<meta property="og:description" content="' + descAttr + '" />\n' +
    '<meta property="og:image" content="' + imgAttr + '" />\n' +
    '<meta property="og:image:alt" content="' + titleAttr + '" />\n' +
    '<meta property="og:image:type" content="image/png" />\n' +
    '<meta property="og:url" content="' + selfAttr + '" />\n' +
    '<meta property="og:type" content="website" />\n' +
    '<meta property="og:site_name" content="' + titleAttr + '" />\n' +
    '<meta property="og:locale" content="en_US" />\n' +
    '<meta name="twitter:card" content="summary_large_image" />\n' +
    '<meta name="twitter:title" content="' + titleAttr + '" />\n' +
    '<meta name="twitter:description" content="' + descAttr + '" />\n' +
    '<meta name="twitter:image" content="' + imgAttr + '" />\n' +
    '<meta name="twitter:image:alt" content="' + titleAttr + '" />\n' +
    '<meta name="twitter:site" content="@Super_Guess_" />\n' +
    '<meta name="fc:miniapp" content=\'' + miniappAttr + '\' />\n' +
    '<meta property="fc:frame" content="vNext" />\n' +
    '<meta property="fc:frame:image" content="' + imgAttr + '" />\n' +
    '<meta property="fc:frame:image:aspect_ratio" content="1.5:1" />\n' +
    '<meta property="fc:frame:post_url" content="' + htmlEscape(ORIGIN) + '" />\n' +
    '<meta property="fc:frame:button:1" content="Play Phrase To Guess" />\n' +
    '<meta property="fc:frame:button:1:action" content="link" />\n' +
    '<meta property="fc:frame:button:1:target" content="' + tgtAttr + '" />\n' +
    '<meta http-equiv="refresh" content="0;url=' + tgtAttr + '" />\n' +
    '<link rel="canonical" href="' + tgtAttr + '" />\n' +
    '<style>html,body{margin:0;padding:0;background:#0a0b0d;color:#fff;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;}' +
    '.wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:24px;text-align:center;gap:12px;}' +
    'a{color:#3c8aff;text-decoration:none;font-weight:600;}' +
    'img{max-width:min(420px,90vw);height:auto;border-radius:12px;}</style>\n' +
    '</head>\n' +
    '<body>\n' +
    '<div class="wrap">\n' +
    '  <img src="' + imgAttr + '" alt="' + titleAttr + '" />\n' +
    '  <h1 style="margin:0;font-size:20px;">Opening Phrase To Guess…</h1>\n' +
    '  <p style="margin:0;opacity:.8;">If nothing happens, <a href="' + tgtAttr + '">tap here</a>.</p>\n' +
    '</div>\n' +
    '<script>(function(){try{window.location.replace(' + targetJson + ');}catch(_){try{window.location.href=' + targetJson + ';}catch(__){}}})();</script>\n' +
    '</body>\n' +
    '</html>\n';

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");
  if (req.method === "HEAD") return res.status(200).end();
  return res.status(200).send(html);
}

module.exports = (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD, OPTIONS");
    return res.status(405).send("Method Not Allowed");
  }
  const q = req.query || {};
  if (isHtmlMode(q)) return serveInviteHtml(req, res, q);
  return serveImage(req, res, q);
};
