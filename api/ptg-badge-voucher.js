/**
 * EIP-712 voucher dla PTGBadgeSigned721.mintWithSig (Base).
 * POST JSON: { "contractAddress": "0x...", "minter": "0x..." }
 * Wymaga PTG_BADGE_SIGNER_PRIVATE_KEY lub MINT_SIGNER_PRIVATE_KEY (ten sam klucz co `signer` na kontrakcie).
 */

const BASE_CHAIN_ID = 8453n;
const RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const VOUCHER_TTL_SEC = 900;

/** Adres → dokładna nazwa EIP712Domain.name z deployu (musi zgadzać się z kontraktem). */
const BADGE_DOMAIN_NAME_BY_ADDRESS = new Map(
  Object.entries({
    "0x901969555E3495D79a04c6F44B97968cd0a4B466": "PTG Badge OG",
    "0x6fc798704Ff94F925Cc7b01B45E5333d2629C42D": "PTG Badge 10 Wins",
    "0xa93EEE6d23dB560c22BDCC63e37EebbC0d60B4b6": "PTG Badge 100 Wins",
    "0x546b1Fa45dbBBCB646D5e19518Ca6427100e7194": "PTG Badge 1000 Wins",
  }).map(([k, v]) => [k.toLowerCase(), v])
);

function setCors(req, res) {
  const o = req.headers.origin;
  if (o && o !== "null") {
    res.setHeader("Access-Control-Allow-Origin", o);
    res.setHeader("Access-Control-Allow-Credentials", "false");
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function pickSignerKey() {
  const k =
    process.env.PTG_BADGE_SIGNER_PRIVATE_KEY ||
    process.env.MINT_SIGNER_PRIVATE_KEY ||
    process.env.PTG_MINT_SIGNER_PRIVATE_KEY ||
    process.env.MINT_PRIVATE_KEY ||
    "";
  return typeof k === "string" ? k.trim() : "";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetries(label, attempts, fn) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      console.error(`ptg-badge-voucher ${label} attempt ${i + 1}/${attempts}`, e);
      if (i < attempts - 1) await sleep(250 * (i + 1));
    }
  }
  throw last;
}

/** Log pełny błąd serwerowo; do klienta nie wysyłamy szczegółów (ethers / RPC). */
function clientJson(req, res, status, body) {
  setCors(req, res);
  return res.status(status).json(body);
}

module.exports = async (req, res) => {
  setCors(req, res);
  try {
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST, OPTIONS");
      return res.status(405).json({ error: "method_not_allowed" });
    }

    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body || "{}");
      } catch {
        return res.status(400).json({ error: "invalid_json" });
      }
    }
    const contractRaw =
      body && typeof body.contractAddress === "string" ? body.contractAddress.trim() : "";
    const minterRaw = body && typeof body.minter === "string" ? body.minter.trim() : "";
    if (!contractRaw || !minterRaw) {
      return res.status(400).json({ error: "missing_contract_or_minter" });
    }

    const { ethers } = await import("ethers");
    let contractAddress;
    let minter;
    try {
      contractAddress = ethers.getAddress(contractRaw);
      minter = ethers.getAddress(minterRaw);
    } catch {
      return res.status(400).json({ error: "invalid_address" });
    }

    const domainName = BADGE_DOMAIN_NAME_BY_ADDRESS.get(contractAddress.toLowerCase());
    if (!domainName) {
      return res.status(400).json({ error: "unknown_badge_contract" });
    }

    const pk = pickSignerKey();
    if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
      return res.status(503).json({ error: "badge_signer_not_configured" });
    }

    const wallet = new ethers.Wallet(pk);
    const provider = new ethers.JsonRpcProvider(RPC);
    const iface = new ethers.Interface([
      "function nonces(address) view returns (uint256)",
      "function signer() view returns (address)",
      "function hasMinted(address) view returns (bool)",
    ]);
    const balIface = new ethers.Interface([
      "function balanceOf(address) view returns (uint256)",
    ]);

    let signerOnChain;
    try {
      [signerOnChain] = await withRetries("signer", 3, async () => {
        const signerData = iface.encodeFunctionData("signer", []);
        const signerRes = await provider.call({ to: contractAddress, data: signerData });
        return iface.decodeFunctionResult("signer", signerRes);
      });
    } catch (e) {
      console.error("ptg-badge-voucher: signer()", e);
      return clientJson(req, res, 503, { error: "badge_rpc_error" });
    }
    if (signerOnChain.toLowerCase() !== wallet.address.toLowerCase()) {
      console.error(
        "ptg-badge-voucher: signer mismatch",
        "wallet",
        wallet.address,
        "chain",
        signerOnChain
      );
      return clientJson(req, res, 500, { error: "signer_key_mismatch" });
    }

    let already = false;
    try {
      [already] = await withRetries("hasMinted", 3, async () => {
        const hmData = iface.encodeFunctionData("hasMinted", [minter]);
        const hmRes = await provider.call({ to: contractAddress, data: hmData });
        return iface.decodeFunctionResult("hasMinted", hmRes);
      });
    } catch (e1) {
      try {
        const [bal] = await withRetries("balanceOf", 3, async () => {
          const bData = balIface.encodeFunctionData("balanceOf", [minter]);
          const bRes = await provider.call({ to: contractAddress, data: bData });
          return balIface.decodeFunctionResult("balanceOf", bRes);
        });
        already = bal > 0n;
      } catch (e2) {
        console.error("ptg-badge-voucher: hasMinted/balanceOf", e1, e2);
        return clientJson(req, res, 503, { error: "badge_rpc_error" });
      }
    }
    if (already) {
      return clientJson(req, res, 400, { error: "already_minted_on_chain" });
    }

    let nonce;
    try {
      [nonce] = await withRetries("nonces", 3, async () => {
        const nonceData = iface.encodeFunctionData("nonces", [minter]);
        const nonceRes = await provider.call({ to: contractAddress, data: nonceData });
        return iface.decodeFunctionResult("nonces", nonceRes);
      });
    } catch (e) {
      console.error("ptg-badge-voucher: nonces", e);
      return clientJson(req, res, 503, { error: "badge_rpc_error" });
    }

    const deadline = BigInt(Math.floor(Date.now() / 1000) + VOUCHER_TTL_SEC);

    const domain = {
      name: domainName,
      version: "1",
      chainId: BASE_CHAIN_ID,
      verifyingContract: contractAddress,
    };
    const types = {
      Mint: [
        { name: "to", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };
    const value = {
      to: minter,
      nonce,
      deadline,
    };

    const sigHex = await wallet.signTypedData(domain, types, value);
    const sig = ethers.Signature.from(sigHex);

    return res.status(200).json({
      contractAddress,
      minter,
      nonce: nonce.toString(),
      deadline: deadline.toString(),
      v: Number(sig.v),
      r: sig.r,
      s: sig.s,
    });
  } catch (err) {
    console.error("ptg-badge-voucher", err);
    return clientJson(req, res, 500, { error: "internal_error" });
  }
};
