import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = join(root, "data", "us-symbols.json");

const sources = [
  {
    url: "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt",
    exchange: "NASDAQ",
    parser: parseNasdaqListed
  },
  {
    url: "https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt",
    exchange: "NYSE/AMEX/ARCA",
    parser: parseOtherListed
  },
  {
    url: "https://www.otcmarkets.com/research/stock-screener/api/downloadCSV?greyAccess=true&expertAccess=true",
    exchange: "OTC",
    parser: parseOtcMarketsCsv
  }
];

const rows = [];

for (const source of sources) {
  const response = await fetch(source.url, {
    headers: {
      "Referer": "https://www.otcmarkets.com/research/stock-screener",
      "User-Agent": "Mozilla/5.0 StockScreenerApp/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`${source.url} returned ${response.status}`);
  }

  const text = await response.text();
  rows.push(...source.parser(text, source.exchange));
}

const seen = new Set();
const sectorMap = await fetchNasdaqSectorMap();
const universe = rows
  .filter((row) => {
    if (!row.symbol || seen.has(row.symbol)) return false;
    seen.add(row.symbol);
    return true;
  })
  .map((row) => ({
    ...row,
    sector: sectorMap.get(row.symbol) || row.sector || sectorForFund(row)
  }))
  .sort((a, b) => a.symbol.localeCompare(b.symbol));

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(universe, null, 2)}\n`);

console.log(`Wrote ${universe.length} US symbols to ${output}`);

function parseNasdaqListed(text, exchange) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines.shift().split("|");

  return lines
    .filter((line) => line && !line.startsWith("File Creation Time"))
    .map((line) => objectFromPipe(headers, line))
    .filter((row) => row["Test Issue"] !== "Y" && row["Financial Status"] !== "D")
    .map((row) => ({
      symbol: yahooSymbol(row.Symbol),
      nativeSymbol: row.Symbol,
      name: row["Security Name"],
      exchange,
      type: row.ETF === "Y" ? "ETF" : "Stock"
    }));
}

function parseOtherListed(text, fallbackExchange) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines.shift().split("|");

  return lines
    .filter((line) => line && !line.startsWith("File Creation Time"))
    .map((line) => objectFromPipe(headers, line))
    .filter((row) => row["Test Issue"] !== "Y")
    .map((row) => ({
      symbol: yahooSymbol(row["ACT Symbol"]),
      nativeSymbol: row["ACT Symbol"],
      name: row["Security Name"],
      exchange: exchangeName(row.Exchange) || fallbackExchange,
      type: row.ETF === "Y" ? "ETF" : "Stock"
    }));
}

function objectFromPipe(headers, line) {
  const values = line.split("|");
  return Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
}

function parseOtcMarketsCsv(text) {
  const rows = parseCsv(text);
  const headers = rows.shift() || [];

  return rows
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ""])))
    .filter((row) => row.Symbol && row["Security Name"])
    .map((row) => ({
      symbol: yahooSymbol(row.Symbol),
      nativeSymbol: row.Symbol,
      name: row["Security Name"],
      exchange: "OTC",
      type: otcSecurityType(row["Sec Type"], row.Tier),
      sector: sectorForOtc(row)
    }));
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(value);
      value = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(value);
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
      value = "";
    } else {
      value += char;
    }
  }

  row.push(value);
  if (row.some((cell) => cell !== "")) rows.push(row);
  return rows;
}

function yahooSymbol(symbol) {
  return String(symbol || "").trim().replace(/\./g, "-");
}

function exchangeName(code) {
  return {
    A: "NYSE American",
    N: "NYSE",
    P: "NYSE Arca",
    Z: "Cboe BZX",
    V: "IEXG"
  }[code];
}

async function fetchNasdaqSectorMap() {
  const endpoint = "https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=25&offset=0&download=true";
  const response = await fetch(endpoint, {
    headers: {
      "Accept": "application/json",
      "Origin": "https://www.nasdaq.com",
      "Referer": "https://www.nasdaq.com/market-activity/stocks/screener",
      "User-Agent": "Mozilla/5.0 StockScreenerApp/1.0"
    }
  });

  if (!response.ok) {
    console.warn(`Nasdaq sector enrichment returned ${response.status}; continuing without stock sectors.`);
    return new Map();
  }

  const payload = await response.json();
  return new Map((payload?.data?.rows || [])
    .filter((row) => row.symbol && row.sector)
    .map((row) => [yahooSymbol(row.symbol), row.sector]));
}

function sectorForFund(row) {
  if (row.type !== "ETF") return null;
  const name = String(row.name || "").toLowerCase();
  if (/bond|treasury|income|fixed|municipal|credit|debt|loan|yield/.test(name)) return "Fixed Income";
  if (/bitcoin|crypto|blockchain|digital asset/.test(name)) return "Crypto / Digital Assets";
  if (/real estate|reit/.test(name)) return "Real Estate";
  if (/energy|oil|gas/.test(name)) return "Energy";
  if (/technology|semiconductor|software|cyber|internet/.test(name)) return "Technology";
  if (/health|biotech|pharma|medical/.test(name)) return "Health Care";
  if (/financial|bank/.test(name)) return "Financials";
  if (/commodity|gold|silver|metal/.test(name)) return "Commodities";
  return "ETF / Fund";
}

function otcSecurityType(securityType, tier) {
  const type = String(securityType || "").trim();
  const marketTier = String(tier || "").trim();
  if (/ETF/i.test(type)) return "ETF";
  if (/Fund/i.test(type)) return "Fund";
  if (/Warrant/i.test(type)) return "Warrant";
  if (/Right/i.test(type)) return "Right";
  if (/Unit/i.test(type)) return "Unit";
  if (/Preferred/i.test(type)) return "Preferred Stock";
  return marketTier ? `${type || "Stock"} - ${marketTier}` : type || "Stock";
}

function sectorForOtc(row) {
  const securityType = String(row["Sec Type"] || "");
  if (/ETF|Fund/i.test(securityType)) return "ETF / Fund";
  return "OTC";
}
