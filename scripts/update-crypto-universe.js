import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = join(root, "data", "crypto-symbols.json");

const [meta, contexts] = await hyperliquidInfo({ type: "spotMetaAndAssetCtxs" });
const tokenByIndex = new Map((meta?.tokens || []).map((token) => [token.index, token]));

const universe = (meta?.universe || [])
  .map((pair) => {
    const context = contexts?.[pair.index];
    const baseToken = tokenByIndex.get(pair.tokens?.[0]);
    const quoteToken = tokenByIndex.get(pair.tokens?.[1]);
    const nativeSymbol = String(baseToken?.name || pair.name || "").toUpperCase();
    const price = Number(context?.midPx || context?.markPx);

    if (!nativeSymbol || quoteToken?.name !== "USDC" || !Number.isFinite(price) || price <= 0) {
      return null;
    }

    return {
      symbol: `${nativeSymbol}-USD`,
      nativeSymbol,
      name: `${nativeSymbol}/USDC`,
      exchange: "Hyperliquid",
      sector: inferCryptoSector({ symbol: nativeSymbol, name: nativeSymbol }),
      type: "Crypto",
      hyperliquidCoin: pair.name,
      pairIndex: pair.index,
      tokenIndex: baseToken?.index ?? null,
      isCanonical: Boolean(pair.isCanonical)
    };
  })
  .filter(Boolean)
  .sort((a, b) => {
    if (a.isCanonical !== b.isCanonical) return a.isCanonical ? -1 : 1;
    return a.symbol.localeCompare(b.symbol);
  });

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(universe, null, 2)}\n`);

console.log(`Wrote ${universe.length} Hyperliquid spot assets to ${output}`);

async function hyperliquidInfo(body) {
  const response = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "User-Agent": "StockScreenerApp/1.0"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Hyperliquid info returned ${response.status}`);
  }

  return response.json();
}

function inferCryptoSector(row) {
  const symbol = String(row.symbol || "").toUpperCase();
  const name = String(row.name || "").toLowerCase();
  const text = `${symbol.toLowerCase()} ${name}`;

  if (/(usd|usdc|usdt|dai|stable|usde|usds|usd1|usdd|pyusd|rlusd)/i.test(text)) return "Stablecoins";
  if (/(bitcoin|btc|litecoin|ltc|bitcoin cash|bch|dogecoin|doge|monero|xmr|zcash|zec)/i.test(text)) return "Payments / Store of Value";
  if (/(ethereum|eth|solana|sol|bnb|cardano|ada|avalanche|avax|sui|near|polkadot|dot|ton|cosmos|atom|algorand|algo|hedera|hbar|hyperliquid|hype)/i.test(text)) return "Layer 1";
  if (/(arbitrum|optimism|polygon|matic|pol|starknet|mantle|zksync)/i.test(text)) return "Layer 2 / Scaling";
  if (/(uniswap|uni|aave|maker|mkr|compound|comp|curve|crv|pancake|cake|lido|ondo|defi|yield|liquidity)/i.test(text)) return "DeFi";
  if (/(binance|okb|leo|kucoin|kcs|cro|bitget|bgb|htx|exchange)/i.test(text)) return "Exchange Tokens";
  if (/(shib|pepe|floki|bonk|meme|trump)/i.test(text)) return "Meme";
  if (/(render|tao|bittensor|fetch|fet|ai|artificial intelligence)/i.test(text)) return "AI / Compute";
  if (/(paxg|xaut|gold|tokenized|treasury)/i.test(text)) return "Tokenized Assets";
  if (/(game|gaming|metaverse|sandbox|mana|gala|ronin|axie)/i.test(text)) return "Gaming / Metaverse";

  return "Other Crypto";
}
