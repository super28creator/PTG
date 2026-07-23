/**
 * Sponsored trophy mint for Farcaster — used by api/ptg-broadcast-mint.js
 * (Hobby plan: no extra serverless function).
 *
 * Flow: personal_sign → treasury publicMint → transferFrom to user.
 */

const {
  Wallet,
  JsonRpcProvider,
  Contract,
  verifyMessage,
  Interface,
  getAddress,
  hashMessage,
  AbiCoder,
  keccak256,
  toUtf8Bytes,
} = require("ethers");

const CHAIN_ID = 8453;
const RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const DEFAULT_NFT =
  process.env.PTG_NFT_ADDRESS ||
  process.env.PTG_CIRCLE_NFT_ADDRESS ||
  "0x9f9343A6833190EE0c816f71D72CE450b1ee8530";
const DEFAULT_URI = "https://phrasetoguess.xyz/nft.json";
const MAX_MSG_AGE_MS = 12 * 60 * 1000;

const NFT_ABI = [
  "function priceWei() view returns (uint256)",
  "function publicMint(string tokenURI_) payable returns (uint256)",
  "function transferFrom(address from, address to, uint256 tokenId)",
  "function nextTokenId() view returns (uint256)",
  "event Minted(address indexed to, uint256 tokenId, string tokenURI)",
];

const EIP1271_IFACE = new Interface([
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
]);
const EIP1271_MAGIC = "0x1626ba7e";
const ERC6492_MAGIC_SUFFIX =
  "6492649264926492649264926492649264926492649264926492649264926492";

function payoutPrivateKey() {
  const pk =
    process.env.PTG_TROPHY_MINT_PRIVATE_KEY ||
    process.env.PTG_PAYOUT_PRIVATE_KEY ||
    process.env.REFERRAL_PAYOUT_PRIVATE_KEY;
  if (!pk || String(pk).length < 20) return null;
  return pk.startsWith("0x") ? pk : `0x${pk}`;
}

function buildMintMessage(minter, metadataUri, issuedAt) {
  /* Krótka, czytelna treść w UI portfela — bez „Chain / URI / Wallet”. */
  return (
    "Phrase To Guess\n" +
    "Claim your victory trophy\n" +
    String(minter).toLowerCase() +
    "\n" +
    String(issuedAt)
  );
}

function hasErc6492Suffix(sig) {
  if (typeof sig !== "string") return false;
  const body = sig.toLowerCase().startsWith("0x") ? sig.slice(2) : sig;
  return body.toLowerCase().endsWith(ERC6492_MAGIC_SUFFIX);
}

function unwrapErc6492Signature(sig) {
  if (!hasErc6492Suffix(sig)) return { inner: sig, wrapped: false };
  try {
    const body = sig.toLowerCase().startsWith("0x") ? sig : "0x" + sig;
    const payload = "0x" + body.slice(2, body.length - ERC6492_MAGIC_SUFFIX.length);
    const coder = AbiCoder.defaultAbiCoder();
    const [, , innerSig] = coder.decode(["address", "bytes", "bytes"], payload);
    return { inner: innerSig, wrapped: true };
  } catch {
    return { inner: sig, wrapped: true };
  }
}

async function verifyMintSignature(userAddr, message, signature, rpcUrl) {
  const expected = String(userAddr).toLowerCase();
  try {
    const recovered = verifyMessage(message, signature);
    if (String(recovered).toLowerCase() === expected) {
      return { ok: true, mode: "eoa" };
    }
  } catch (_) {}

  let hashVariants = [];
  try {
    hashVariants.push(hashMessage(message));
  } catch (_) {}
  try {
    hashVariants.push(keccak256(toUtf8Bytes(String(message || ""))));
  } catch (_) {}
  hashVariants = [...new Set(hashVariants.filter(Boolean))];
  if (!hashVariants.length) return { ok: false, reason: "hash_failed" };

  const { inner, wrapped } = unwrapErc6492Signature(signature);

  async function rpcCall(data) {
    const r = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: userAddr, data }, "latest"],
      }),
    });
    if (!r.ok) throw new Error("rpc_" + r.status);
    return r.json();
  }

  try {
    for (const hv of hashVariants) {
      const callInner = EIP1271_IFACE.encodeFunctionData("isValidSignature", [hv, inner]);
      const j = await rpcCall(callInner);
      if (j && typeof j.result === "string" && j.result.toLowerCase().startsWith(EIP1271_MAGIC)) {
        return { ok: true, mode: wrapped ? "eip1271_6492" : "eip1271" };
      }
      if (wrapped) {
        const callOrig = EIP1271_IFACE.encodeFunctionData("isValidSignature", [hv, signature]);
        const j2 = await rpcCall(callOrig);
        if (
          j2 &&
          typeof j2.result === "string" &&
          j2.result.toLowerCase().startsWith(EIP1271_MAGIC)
        ) {
          return { ok: true, mode: "eip1271_wrapped" };
        }
      }
    }
  } catch (e) {
    return { ok: false, reason: "eip1271_rpc_failed", detail: String(e && e.message) };
  }
  return { ok: false, reason: "no_match" };
}

function parseTokenIdFromReceipt(receipt, treasuryAddr, iface) {
  if (!receipt || !Array.isArray(receipt.logs)) return null;
  const treasuryLc = String(treasuryAddr).toLowerCase();
  for (const log of receipt.logs) {
    if (!log) continue;
    try {
      const parsed = iface.parseLog({
        topics: log.topics,
        data: log.data,
      });
      if (!parsed || parsed.name !== "Minted") continue;
      const to = parsed.args && parsed.args.to != null ? String(parsed.args.to) : "";
      if (to.toLowerCase() !== treasuryLc) continue;
      if (parsed.args && parsed.args.tokenId != null) {
        return BigInt(parsed.args.tokenId);
      }
    } catch (_) {}
  }
  return null;
}

function isSponsoredTrophyBody(body) {
  if (!body || typeof body !== "object") return false;
  if (body.op === "sponsored_trophy") return true;
  return (
    typeof body.signature === "string" &&
    typeof body.minter === "string" &&
    body.issuedAt != null &&
    !body.rawTransaction
  );
}

/**
 * POST body: { op:"sponsored_trophy", minter, signature, metadataUri?, issuedAt }
 */
async function handleSponsoredTrophyMint(res, body) {
  try {
    if (!body || typeof body !== "object") {
      return res.status(400).json({ error: "invalid_body" });
    }

    const pk = payoutPrivateKey();
    if (!pk) {
      return res.status(503).json({
        error: "trophy_mint_not_configured",
        hint: "Set PTG_PAYOUT_PRIVATE_KEY (or PTG_TROPHY_MINT_PRIVATE_KEY) on Vercel.",
      });
    }

    let minter;
    try {
      minter = getAddress(String(body.minter || "").trim());
    } catch {
      return res.status(400).json({ error: "invalid_minter" });
    }

    const signature = typeof body.signature === "string" ? body.signature.trim() : "";
    if (!/^0x[0-9a-fA-F]+$/.test(signature) || signature.length < 130) {
      return res.status(400).json({ error: "invalid_signature" });
    }

    const metadataUri =
      typeof body.metadataUri === "string" && body.metadataUri.trim()
        ? body.metadataUri.trim()
        : DEFAULT_URI;
    if (metadataUri !== DEFAULT_URI && !metadataUri.startsWith("https://phrasetoguess.xyz/")) {
      return res.status(400).json({ error: "uri_not_allowed" });
    }

    const issuedAt = Number(body.issuedAt);
    if (!Number.isFinite(issuedAt) || issuedAt <= 0) {
      return res.status(400).json({ error: "invalid_issued_at" });
    }
    const age = Date.now() - issuedAt;
    if (age < -60_000 || age > MAX_MSG_AGE_MS) {
      return res.status(400).json({ error: "signature_expired" });
    }

    const message = buildMintMessage(minter, metadataUri, issuedAt);
    const sigCheck = await verifyMintSignature(minter, message, signature, RPC);
    if (!sigCheck.ok) {
      console.error("ptg-trophy-mint bad_signature", sigCheck);
      return res.status(401).json({ error: "bad_signature", reason: sigCheck.reason || "no_match" });
    }

    let nftAddr;
    try {
      nftAddr = getAddress(DEFAULT_NFT);
    } catch {
      return res.status(500).json({ error: "bad_nft_address" });
    }

    const provider = new JsonRpcProvider(RPC, CHAIN_ID);
    let treasury;
    try {
      treasury = new Wallet(pk, provider);
    } catch (e) {
      return res.status(503).json({ error: "treasury_wallet_invalid", detail: String(e && e.message) });
    }

    const nft = new Contract(nftAddr, NFT_ABI, treasury);
    let price;
    try {
      price = await nft.priceWei();
    } catch (e) {
      console.error("ptg-trophy-mint priceWei", e);
      return res.status(502).json({ error: "price_read_failed" });
    }
    if (price == null || price <= 0n) {
      return res.status(502).json({ error: "invalid_price" });
    }

    const bal = await provider.getBalance(treasury.address);
    const minNeed = price + 100000000000000n; /* 0.0001 ETH headroom */
    if (bal < minNeed) {
      console.error("ptg-trophy-mint treasury_low", {
        treasury: treasury.address,
        bal: bal.toString(),
        price: price.toString(),
      });
      return res.status(503).json({ error: "treasury_low_eth" });
    }

    let mintTx;
    try {
      mintTx = await nft.publicMint(metadataUri, {
        value: price,
        gasLimit: 320000n,
      });
    } catch (e) {
      console.error("ptg-trophy-mint publicMint", e);
      return res.status(502).json({
        error: "mint_failed",
        detail: String((e && e.shortMessage) || (e && e.message) || e).slice(0, 180),
      });
    }

    let mintReceipt;
    try {
      mintReceipt = await mintTx.wait(1);
    } catch (e) {
      console.error("ptg-trophy-mint mint wait", e);
      return res.status(502).json({
        error: "mint_pending",
        mintTxHash: mintTx.hash,
        detail: String(e && e.message).slice(0, 120),
      });
    }

    let tokenId = parseTokenIdFromReceipt(mintReceipt, treasury.address, nft.interface);
    if (tokenId == null) {
      try {
        const next = await nft.nextTokenId();
        if (next > 0n) tokenId = next - 1n;
      } catch (_) {}
    }
    if (tokenId == null) {
      return res.status(502).json({
        error: "token_id_unknown",
        mintTxHash: mintTx.hash,
      });
    }

    let transferTx;
    try {
      transferTx = await nft.transferFrom(treasury.address, minter, tokenId, {
        gasLimit: 120000n,
      });
      /* Nie czekaj na 2. receipt — klient dostaje hash od razu (szybszy UX). */
    } catch (e) {
      console.error("ptg-trophy-mint transferFrom", e);
      return res.status(502).json({
        error: "transfer_failed",
        mintTxHash: mintTx.hash,
        tokenId: tokenId.toString(),
        detail: String((e && e.shortMessage) || (e && e.message) || e).slice(0, 180),
      });
    }

    return res.status(200).json({
      ok: true,
      mode: "sponsored",
      sigMode: sigCheck.mode,
      minter,
      tokenId: tokenId.toString(),
      mintTxHash: mintTx.hash,
      txHash: transferTx.hash,
      explorer: "https://basescan.org/tx/" + transferTx.hash,
    });
  } catch (e) {
    console.error("ptg-trophy-mint fatal", e);
    return res.status(500).json({
      error: "server_error",
      detail: String(e && e.message ? e.message : e).slice(0, 160),
    });
  }
}

module.exports = {
  handleSponsoredTrophyMint,
  buildMintMessage,
  isSponsoredTrophyBody,
};
