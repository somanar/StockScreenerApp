import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = join(root, "data", "india-symbols.json");
const source = "https://archives.nseindia.com/content/equities/EQUITY_L.csv";

const response = await fetch(source, {
  headers: { "User-Agent": "Mozilla/5.0 StockScreenerApp/1.0" }
});

if (!response.ok) {
  throw new Error(`${source} returned ${response.status}`);
}

const text = await response.text();
const [headerLine, ...lines] = text.trim().split(/\r?\n/);
const headers = parseCsvLine(headerLine).map((header) => header.trim());
const sectorMap = await fetchNifty500SectorMap();

const universe = lines
  .map((line) => objectFromCsv(headers, line))
  .filter((row) => row.SYMBOL && row.SERIES?.trim() === "EQ")
  .map((row) => ({
    symbol: `${row.SYMBOL.trim()}.NS`,
    nativeSymbol: row.SYMBOL.trim(),
    name: row["NAME OF COMPANY"]?.trim() || row.SYMBOL.trim(),
    exchange: "NSE",
    sector: sectorMap.get(row.SYMBOL.trim()) || null,
    type: "Stock",
    isin: row["ISIN NUMBER"]?.trim() || null
  }))
  .sort((a, b) => a.symbol.localeCompare(b.symbol));

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(universe, null, 2)}\n`);

console.log(`Wrote ${universe.length} Indian symbols to ${output}`);

async function fetchNifty500SectorMap() {
  const endpoint = "https://archives.nseindia.com/content/indices/ind_nifty500list.csv";
  const response = await fetch(endpoint, {
    headers: { "User-Agent": "Mozilla/5.0 StockScreenerApp/1.0" }
  });

  if (!response.ok) {
    console.warn(`NIFTY 500 sector enrichment returned ${response.status}; continuing without sectors.`);
    return new Map();
  }

  const text = await response.text();
  const [headerLine, ...lines] = text.trim().split(/\r?\n/);
  const headers = parseCsvLine(headerLine).map((header) => header.trim());

  return new Map(lines
    .map((line) => objectFromCsv(headers, line))
    .filter((row) => row.Symbol && row.Industry)
    .map((row) => [row.Symbol.trim(), row.Industry.trim()]));
}

function objectFromCsv(headers, line) {
  const values = parseCsvLine(line);
  return Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current);
  return values;
}
