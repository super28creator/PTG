/**
 * Z eksportu CSV BaseScan buduje prosty ranking: rank, name, address.
 * name = From_Nametag jeśli jest, inaczej adres.
 *
 *   node scripts/nft-ranking-from-csv.mjs "C:/ścieżka/export.csv"
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "private");

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQ = !inQ;
      continue;
    }
    if (!inQ && c === ",") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

function main() {
  const csvPath = process.argv[2];
  if (!csvPath || !fs.existsSync(csvPath)) {
    console.error(
      'Użycie: node scripts/nft-ranking-from-csv.mjs "C:/.../export.csv"'
    );
    process.exit(1);
  }

  const raw = fs.readFileSync(csvPath, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const header = parseCsvLine(lines[0]);
  const ix = {
    status: header.indexOf("Status"),
    method: header.indexOf("Method"),
    from: header.indexOf("From"),
    fromTag: header.indexOf("From_Nametag"),
  };
  if (ix.from < 0 || ix.method < 0 || ix.status < 0) {
    console.error("Brak kolumn Status, Method lub From.");
    process.exit(1);
  }

  /** @type {Map<string, { score: number, nametag: string, from: string }>} */
  const map = new Map();

  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvLine(lines[i]);
    if (row.length < ix.from + 1) continue;
    if (row[ix.status] !== "Success") continue;
    if (row[ix.method] !== "Public Mint") continue;

    const from = row[ix.from].trim();
    const tag = (row[ix.fromTag] ?? "").trim();
    const key = from.toLowerCase();
    if (!key.startsWith("0x")) continue;

    const prev = map.get(key);
    if (!prev) {
      map.set(key, { score: 1, nametag: tag, from });
    } else {
      prev.score += 1;
      if (!prev.nametag && tag) prev.nametag = tag;
    }
  }

  const sorted = [...map.entries()].sort((a, b) => b[1].score - a[1].score);
  const ranking = sorted.map(([k, v], i) => {
    const address = v.from;
    const name = v.nametag || address;
    return { rank: i + 1, name, address };
  });

  const out = {
    updated_at: new Date().toISOString(),
    ranking,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = path.join(OUT_DIR, "nft-ranking.json");
  fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2), "utf8");

  const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const csvOut = [
    ["rank", "name", "address"].join(","),
    ...ranking.map((r) =>
      [r.rank, esc(r.name), esc(r.address)].join(",")
    ),
  ].join("\n");
  const csvOutPath = path.join(OUT_DIR, "nft-ranking.csv");
  fs.writeFileSync(csvOutPath, csvOut, "utf8");

  console.log("Zapisano:", jsonPath);
  console.log("Zapisano:", csvOutPath);
}

main();
