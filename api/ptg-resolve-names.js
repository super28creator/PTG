/**
 * Batch resolve wallet → display name (Base Basenames / ENS, Ethereum ENS, optional Farcaster via Neynar).
 * POST JSON: { "addresses": ["0x...", ...] } — max 80.
 * Response: { "names": { "0x...lowercase": "name or empty" } }
 */

const { ethers } = require("ethers");
const { namehash, solidityPacked } = require("ethers/hash");

const BASE_RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const ETH_RPC = process.env.ETH_MAINNET_RPC_URL || "https://cloudflare-eth.com";

const BASE_REVERSE_REGISTRAR = "0x79ea96012eea67a83431f1701b3dff7e37f9e282";
const BASENAME_L2_RESOLVER_PROXY = "0x426fA03fB86E510d0Dd9F70335Cf102a98b10875";
const BASENAME_L2_RESOLVER_LEGACY = "0xC6d566A56A1aFf6508b41f6c90ff131615583BCD";
const BASE_NUMERIC_CHAIN_ID = 8453;

const ABI_NAME = ["function name(bytes32 node) view returns (string)"];
const ABI_NODE = ["function node(address addr) view returns (bytes32)"];

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

function sha3HexAddressLabel(address) {
  const hexOnly = ethers.getAddress(address).toLowerCase().slice(2);
  return ethers.keccak256(ethers.toUtf8Bytes(hexOnly));
}

function computeBasenameReverseNodeLocal(address) {
  const labelHash = sha3HexAddressLabel(address);
  const coinHex = ((0x80000000 | BASE_NUMERIC_CHAIN_ID) >>> 0).toString(16).toUpperCase();
  const reverseRoot = namehash(`${coinHex}.reverse`);
  return ethers.keccak256(solidityPacked(["bytes32", "bytes32"], [reverseRoot, labelHash]));
}

let baseProvider;
let ethProvider;

function getBaseProvider() {
  if (!baseProvider) baseProvider = new ethers.JsonRpcProvider(BASE_RPC);
  return baseProvider;
}

function getEthProvider() {
  if (!ethProvider) ethProvider = new ethers.JsonRpcProvider(ETH_RPC);
  return ethProvider;
}

async function basenameFromContracts(address) {
  const provider = getBaseProvider();
  let nodeBytes;
  try {
    const rr = new ethers.Contract(BASE_REVERSE_REGISTRAR, ABI_NODE, provider);
    nodeBytes = await rr.node(address);
  } catch (_) {
    nodeBytes = computeBasenameReverseNodeLocal(address);
  }
  for (const resolverAddr of [BASENAME_L2_RESOLVER_PROXY, BASENAME_L2_RESOLVER_LEGACY]) {
    try {
      const res = new ethers.Contract(resolverAddr, ABI_NAME, provider);
      const n = await res.name(nodeBytes);
      if (n && typeof n === "string") {
        const t = n.trim();
        if (t.length > 0) return t;
      }
    } catch (_) {}
  }
  return null;
}

/** Base reverse + Basenames + Ethereum ENS (bez Neynar). */
async function resolveOnchainNames(addr) {
  const chk = ethers.getAddress(addr);

  try {
    const n = await getBaseProvider().lookupAddress(chk);
    if (n && typeof n === "string" && n.trim().length > 0) return n.trim();
  } catch (_) {}

  const bn = await basenameFromContracts(chk);
  if (bn) return bn;

  try {
    const n = await getEthProvider().lookupAddress(chk);
    if (n && typeof n === "string" && n.trim().length > 0) return n.trim();
  } catch (_) {}

  return "";
}

/** Jedno żądanie Neynar dla wielu adresów → { names, pfps } (oba lowercase keys). */
async function fetchNeynarForAddresses(list) {
  const nk = process.env.NEYNAR_API_KEY;
  const names = {};
  const pfps = {};
  if (!nk || typeof nk !== "string" || nk.length < 5 || !list.length) return { names, pfps };
  try {
    const qs = list.map((a) => `addresses=${encodeURIComponent(a)}`).join("&");
    const url = `https://api.neynar.com/v2/farcaster/user/bulk-by-address?${qs}`;
    const r = await fetch(url, {
      headers: {
        accept: "application/json",
        "x-api-key": nk,
      },
    });
    if (!r.ok) return { names, pfps };
    const j = await r.json();
    const users = j.users || (j.result && j.result.users) || [];
    if (!Array.isArray(users)) return { names, pfps };
    const want = new Set(list.map((x) => String(x).toLowerCase()));
    for (const u of users) {
      let label = "";
      if (u.username && String(u.username).trim()) {
        label = "@" + String(u.username).trim().replace(/^@/, "");
      } else if (u.display_name && String(u.display_name).trim()) {
        label = String(u.display_name).trim();
      }
      let pfp = "";
      if (typeof u.pfp_url === "string" && /^https?:\/\//i.test(u.pfp_url)) pfp = u.pfp_url.trim();
      else if (u.pfp && typeof u.pfp.url === "string" && /^https?:\/\//i.test(u.pfp.url)) pfp = u.pfp.url.trim();

      const ethList = [];
      if (typeof u.custody_address === "string") ethList.push(u.custody_address);
      if (Array.isArray(u.verifications)) ethList.push(...u.verifications);
      const va = u.verified_addresses;
      if (va && Array.isArray(va.eth_addresses)) ethList.push(...va.eth_addresses);
      if (va && typeof va.eth_address === "string") ethList.push(va.eth_address);
      for (const raw of ethList) {
        try {
          const a = ethers.getAddress(String(raw)).toLowerCase();
          if (!want.has(a)) continue;
          if (label && !names[a]) names[a] = label;
          if (pfp && !pfps[a]) pfps[a] = pfp;
        } catch (_) {}
      }
    }
  } catch (e) {
    console.warn("neynar batch", e && e.message);
  }
  return { names, pfps };
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
    const raw = body && Array.isArray(body.addresses) ? body.addresses : [];
    const names = {};
    const list = [];
    for (let i = 0; i < raw.length && list.length < 80; i++) {
      const s = typeof raw[i] === "string" ? raw[i].trim() : "";
      if (!/^0x[a-fA-F0-9]{40}$/.test(s)) continue;
      let chk;
      try {
        chk = ethers.getAddress(s);
      } catch {
        continue;
      }
      const k = chk.toLowerCase();
      if (list.indexOf(k) === -1) list.push(k);
    }

    const { names: neynarNames, pfps } = await fetchNeynarForAddresses(list);
    for (const k of list) {
      try {
        let n = await resolveOnchainNames(k);
        if (!n && neynarNames[k]) n = neynarNames[k];
        names[k] = n || "";
      } catch (e) {
        console.warn("ptg-resolve-names", k, e && e.message);
        names[k] = neynarNames[k] || "";
      }
    }

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=120, s-maxage=120");
    return res.status(200).json({ names, pfps });
  } catch (err) {
    console.error("ptg-resolve-names", err);
    setCors(req, res);
    return res.status(500).json({ error: "server_error" });
  }
};
