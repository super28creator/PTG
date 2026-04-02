/**
 * Generuje losową parę kluczy ECDSA (format Ethereum) — bez MetaMask.
 *
 *   node scripts/generate-mint-signer.mjs
 *
 * authorizedSigner → 7. argument konstruktora w Remix
 * MINT_SIGNER_PRIVATE_KEY → zmienna środowiskowa na Vercel (nigdy w repo / froncie)
 *
 * Uruchom raz w bezpiecznym miejscu; wyjście skasuj po skopiowaniu do Vercel.
 */

import { Wallet } from "ethers";

const w = Wallet.createRandom();

console.log("");
console.log("authorizedSigner (adres do kontraktu / Remix):");
console.log(w.address);
console.log("");
console.log("MINT_SIGNER_PRIVATE_KEY (tylko Vercel env):");
console.log(w.privateKey);
console.log("");
