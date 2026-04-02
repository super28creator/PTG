/**
 * DEPRECATED: Mint jest tylko `mint()` na kontrakcie (bez EIP-712 / bez tego API).
 * Endpoint zostaje pod tym URL, żeby stare klienty dostały jasny komunikat zamiast 404.
 */

function setCors(req, res) {
  const o = req.headers.origin;
  if (o && o !== "null") {
    res.setHeader("Access-Control-Allow-Origin", o);
    res.setHeader("Access-Control-Allow-Credentials", "false");
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "method_not_allowed" });
  }
  return res.status(410).json({
    error: "mint_voucher_deprecated",
    hint:
      "Mint is now on-chain mint() only (no server signature). Deploy Kontrakt-nft.sol from the repo, set PTG_NFT_ADDRESS in the site and Vercel env.",
  });
};
