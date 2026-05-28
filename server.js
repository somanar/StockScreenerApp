import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const dataDir = join(root, "data");

loadEnvFile(join(root, ".env"));

const PORT = Number(process.env.PORT || 3000);
const SCAN_LIMIT = Number(process.env.SCAN_LIMIT || 250);
const DEFAULT_PAGE_SIZE = Number(process.env.PAGE_SIZE || 100);
const MAX_PAGE_SIZE = Number(process.env.MAX_PAGE_SIZE || 250);
const QUOTE_BATCH_SIZE = Number(process.env.QUOTE_BATCH_SIZE || 80);
const QUOTE_DELAY_MS = Number(process.env.QUOTE_DELAY_MS || 350);
const YAHOO_CHART_CONCURRENCY = Number(process.env.YAHOO_CHART_CONCURRENCY || 24);
const SUPABASE_TABLE = process.env.SUPABASE_SIGNALS_TABLE || "stock_signals";
const TOP_LIST_SIZE = Number(process.env.TOP_LIST_SIZE || 200);
const TOP_CACHE_MS = Number(process.env.TOP_CACHE_MS || 30_000);
const TOP_STALE_MS = Number(process.env.TOP_STALE_MS || 300_000);
const DATA_REFRESH_MS = Number(process.env.DATA_REFRESH_MS || 30_000);
const BACKGROUND_MARKET_PAGES = Number(process.env.BACKGROUND_MARKET_PAGES || 3);
const backgroundRefreshState = {
  running: false,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastError: null
};
const topMarketCache = new Map();

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const marketConfig = {
  us: {
    title: "US Exchanges",
    universeFile: "us-symbols.json",
    source: "Yahoo Finance",
    quoteProvider: fetchYahooQuotes
  },
  india: {
    title: "Indian Exchanges",
    universeFile: "india-symbols.json",
    source: "Yahoo Finance / Kite",
    quoteProvider: fetchIndiaQuotes
  },
  crypto: {
    title: "Crypto Exchanges",
    universeFile: "crypto-symbols.json",
    source: "Hyperliquid",
    quoteProvider: fetchHyperliquidCrypto
  }
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (url.pathname === "/api/scan") {
      await handleScan(url, res);
      return;
    }

    if (url.pathname === "/api/my-stocks") {
      await handleTopMarket("top-us", "", "changePercent", "asc", res);
      return;
    }

    if (url.pathname === "/api/top-market") {
      await handleTopMarket(
        url.searchParams.get("market") || "top-us",
        url.searchParams.get("sector") || "",
        url.searchParams.get("sortBy") || "changePercent",
        url.searchParams.get("direction") || "asc",
        res
      );
      return;
    }

    if (url.pathname === "/api/chart") {
      await handleChart(url, res);
      return;
    }

    if (url.pathname === "/api/health") {
      sendJson(res, {
        ok: true,
        supabaseConfigured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
        backgroundRefresh: backgroundRefreshState
      });
      return;
    }

    await serveStatic(url.pathname, res);
  } catch (error) {
    console.error(error);
    sendJson(res, { error: error.message || "Unexpected server error" }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`Stock screener running at http://localhost:${PORT}`);
  startBackgroundRefresh();
});

async function handleScan(url, res) {
  const market = (url.searchParams.get("market") || "us").toLowerCase();
  const config = marketConfig[market];

  if (!config) {
    sendJson(res, { error: "Unknown market. Use us, india, or crypto." }, 400);
    return;
  }

  const page = clamp(Number(url.searchParams.get("page") || 1), 1, 1_000_000);
  const perPage = clamp(Number(url.searchParams.get("perPage") || url.searchParams.get("limit") || DEFAULT_PAGE_SIZE), 1, MAX_PAGE_SIZE);
  const query = (url.searchParams.get("query") || "").trim();
  const sortBy = url.searchParams.get("sortBy") || "changePercent";
  const sortDirection = url.searchParams.get("direction") || "asc";
  const startedAt = new Date();

  const stored = await readStoredSignals({
    market,
    page,
    perPage,
    query,
    sortBy,
    sortDirection
  }).catch((error) => {
    console.warn(`Supabase read failed for ${market}: ${error.message}`);
    return null;
  });

  if (stored?.rows?.length) {
    sendJson(res, {
      market,
      title: config.title,
      source: stored.rows[0]?.source || config.source,
      scannedAt: stored.scannedAt || startedAt.toISOString(),
      count: stored.rows.length,
      total: stored.total,
      page,
      perPage,
      totalPages: Math.max(1, Math.ceil(stored.total / perPage)),
      universeTotal: stored.total,
      storage: { enabled: true, source: "Supabase snapshot", refreshedAt: stored.scannedAt },
      rows: stored.rows
    });
    return;
  }

  const scan = await scanMarket(market, config, { page, perPage, query, sortBy, sortDirection });
  const rows = scan.rows;
  const storage = await storeSignals(rows);

  sendJson(res, {
    market,
    title: config.title,
    source: rows[0]?.source || config.source,
    scannedAt: startedAt.toISOString(),
    count: rows.length,
    total: scan.total,
    page: scan.page,
    perPage: scan.perPage,
    totalPages: scan.totalPages,
    universeTotal: scan.universeTotal,
    storage,
    rows
  });
}

async function handleTopMarket(topMarket, sector, sortBy, sortDirection, res) {
  const cacheKey = normalizeTopMarket(topMarket);
  const stored = await readStoredTopMarket(cacheKey, { sector, sortBy, sortDirection }).catch((error) => {
    console.warn(`Supabase top market read failed for ${cacheKey}: ${error.message}`);
    return null;
  });

  if (stored?.rows?.length || stored?.total === 0) {
    sendJson(res, {
      market: cacheKey,
      title: topMarketTitle(cacheKey),
      source: stored.rows[0]?.source || topMarketSource(cacheKey),
      scannedAt: stored.scannedAt || new Date().toISOString(),
      count: stored.rows.length,
      total: stored.total,
      page: 1,
      perPage: TOP_LIST_SIZE,
      totalPages: 1,
      universeTotal: stored.total,
      sectors: stored.sectors,
      sector: normalizeSector(sector),
      activeMetric: normalizeTopSortBy(sortBy),
      activeMetricLabel: topMetricLabel(normalizeTopSortBy(sortBy)),
      marketPhase: "Supabase snapshot",
      storage: { enabled: true, source: "Supabase snapshot", refreshedAt: stored.scannedAt },
      rows: stored.rows,
      cache: { hit: true, stale: false, ageMs: stored.ageMs || 0 }
    });
    return;
  }

  const cached = topMarketCache.get(cacheKey);
  const cacheAge = cached ? Date.now() - cached.cachedAt : Infinity;

  if (cached && cacheAge < TOP_CACHE_MS) {
    sendJson(res, { ...filterTopMarketPayload(cached.payload, { sector, sortBy, sortDirection }), cache: { hit: true, stale: false, ageMs: cacheAge } });
    return;
  }

  if (cached && cacheAge < TOP_STALE_MS) {
    refreshTopMarketCache(cacheKey);
    sendJson(res, { ...filterTopMarketPayload(cached.payload, { sector, sortBy, sortDirection }), cache: { hit: true, stale: true, ageMs: cacheAge } });
    return;
  }

  const payload = await buildTopMarketPayload(cacheKey);
  sendJson(res, { ...filterTopMarketPayload(payload, { sector, sortBy, sortDirection }), cache: { hit: false, stale: false, ageMs: 0 } });
}

async function handleChart(url, res) {
  const symbol = (url.searchParams.get("symbol") || "").trim();
  const range = url.searchParams.get("range") || "6mo";
  const interval = url.searchParams.get("interval") || "1d";

  if (!symbol) {
    sendJson(res, { error: "Missing symbol." }, 400);
    return;
  }

  const payload = await fetchYahooHistoricalChart(symbol, { range, interval });
  sendJson(res, payload);
}

async function buildTopMarketPayload(topMarket) {
  const startedAt = new Date();
  const result = await scanTopMarket(topMarket);
  const storage = await storeSignals(result.rows);

  const payload = {
    market: result.market,
    title: result.title,
    source: result.source,
    scannedAt: startedAt.toISOString(),
    count: result.rows.length,
    total: result.rows.length,
    page: 1,
    perPage: TOP_LIST_SIZE,
    totalPages: 1,
    universeTotal: result.candidateCount,
    sectors: sectorList(result.rows),
    activeMetric: result.activeMetric,
    activeMetricLabel: result.activeMetricLabel,
    marketPhase: result.marketPhase,
    storage,
    rows: result.rows
  };

  topMarketCache.set(result.market, {
    cachedAt: Date.now(),
    payload,
    refreshing: null
  });

  return payload;
}

function filterTopMarketPayload(payload, options = {}) {
  const sector = normalizeSector(options.sector);
  const sortBy = normalizeTopSortBy(options.sortBy);
  const sortDirection = options.sortDirection === "desc" ? "desc" : "asc";
  const metricLabel = topMetricLabel(sortBy);
  const activeMetric = percentMetricFor(sortBy);
  const filteredRows = sector
    ? payload.rows.filter((row) => normalizeSector(row.sector) === sector)
    : payload.rows;
  const sortedRows = filteredRows
    .filter((row) => hasSortableValue(row[sortBy]))
    .sort((a, b) => compareQuoteValues(a, b, sortBy, sortDirection));
  const rows = sortedRows
    .slice(0, TOP_LIST_SIZE)
    .map((row, index) => ({
      ...row,
      activeChangePercent: activeMetric ? nullableRound(row[activeMetric], 4) : row.activeChangePercent,
      activeMetric: sortBy,
      activeMetricLabel: metricLabel,
      signalRank: index + 1,
      raw: {
        ...row.raw,
        activeMetric: sortBy
      }
    }));

  return {
    ...payload,
    sector,
    activeMetric: sortBy,
    activeMetricLabel: metricLabel,
    marketPhase: "Selected filter",
    rows,
    count: rows.length,
    total: sortedRows.length
  };
}

function refreshTopMarketCache(topMarket) {
  const cached = topMarketCache.get(topMarket);
  if (cached?.refreshing) return cached.refreshing;

  const refreshing = buildTopMarketPayload(topMarket)
    .catch((error) => {
      console.warn(`Top market cache refresh failed for ${topMarket}: ${error.message}`);
    })
    .finally(() => {
      const latest = topMarketCache.get(topMarket);
      if (latest) latest.refreshing = null;
    });

  if (cached) cached.refreshing = refreshing;
  return refreshing;
}

function startBackgroundRefresh() {
  if (!isSupabaseConfigured()) {
    console.warn("Background price refresh disabled; Supabase env vars are not configured.");
    return;
  }

  setTimeout(refreshAllSignalSnapshots, 2_000);
  setInterval(refreshAllSignalSnapshots, DATA_REFRESH_MS);
}

async function refreshAllSignalSnapshots() {
  if (backgroundRefreshState.running) return;

  backgroundRefreshState.running = true;
  backgroundRefreshState.lastStartedAt = new Date().toISOString();
  backgroundRefreshState.lastError = null;
  const errors = [];

  const topMarketsToRefresh = ["top-us", "top-india", "top-crypto"];
  for (const market of topMarketsToRefresh) {
    try {
      const result = await scanTopMarket(market);
      await storeSignalsOrThrow(result.rows);
      topMarketCache.delete(market);
    } catch (error) {
      errors.push(`${market}: ${error.message}`);
    }
  }

  for (const [market, config] of Object.entries(marketConfig)) {
    for (let page = 1; page <= BACKGROUND_MARKET_PAGES; page += 1) {
      try {
        const scan = await scanMarket(market, config, {
          page,
          perPage: DEFAULT_PAGE_SIZE,
          query: "",
          sortBy: "changePercent",
          sortDirection: "desc"
        });
        await storeSignalsOrThrow(scan.rows);
        if (scan.totalPages <= page) break;
      } catch (error) {
        errors.push(`${market} page ${page}: ${error.message}`);
        break;
      }
    }
  }

  backgroundRefreshState.lastFinishedAt = new Date().toISOString();
  backgroundRefreshState.lastError = errors.length ? errors.join("; ") : null;
  if (backgroundRefreshState.lastError) {
    console.warn(`Background price refresh completed with errors: ${backgroundRefreshState.lastError}`);
  }
  backgroundRefreshState.running = false;
}

async function storeSignalsOrThrow(rows) {
  const result = await storeSignals(rows);
  if (result?.error) {
    throw new Error(`${result.error}${result.details ? `: ${result.details}` : ""}`);
  }
  return result;
}

async function scanTopMarket(topMarket) {
  if (topMarket === "top-india") return scanTopYahooUniverse({
    market: "top-india",
    title: "My Top Indian Stocks",
    universeFile: "india-symbols.json",
    exchangeFallback: "NSE"
  });

  if (topMarket === "top-crypto") return scanTopCrypto();

  return scanTopUsStocks();
}

function normalizeTopMarket(topMarket) {
  if (topMarket === "top-india" || topMarket === "top-crypto" || topMarket === "top-us") {
    return topMarket;
  }

  return "top-us";
}

function topMarketTitle(topMarket) {
  return {
    "top-us": "My Top US Stocks",
    "top-india": "My Top Indian Stocks",
    "top-crypto": "My Top Crypto"
  }[topMarket] || "My Top US Stocks";
}

function topMarketSource(topMarket) {
  return {
    "top-us": "Yahoo Finance",
    "top-india": "Yahoo Finance",
    "top-crypto": "Hyperliquid"
  }[topMarket] || "Yahoo Finance";
}

async function scanMarket(market, config, options) {
  const universe = config.universeFile ? await loadUniverse(config.universeFile) : [];
  const universeTotal = universe.length;
  const filteredUniverse = universe.length ? filterUniverse(universe, options.query) : [];
  let quoteUniverse = filteredUniverse;
  let quotes;
  let total;

  if (universe.length) {
    total = filteredUniverse.length;
    quoteUniverse = paginate(filteredUniverse, options.page, options.perPage);
    quotes = await config.quoteProvider(quoteUniverse);
    if (market === "india") {
      quotes = await enrichIndianPreOpen(quotes);
    }
  } else {
    const allQuotes = await config.quoteProvider(universe);
    const filteredQuotes = filterQuotes(allQuotes, options.query);
    total = filteredQuotes.length;
    quotes = paginate(filteredQuotes, options.page, options.perPage);
  }

  const now = new Date().toISOString();
  const startRank = (options.page - 1) * options.perPage;
  const totalPages = Math.max(1, Math.ceil(total / options.perPage));

  const rows = quotes
    .filter((quote) => Number.isFinite(quote.price) && Number.isFinite(quote.changePercent))
    .sort((a, b) => compareQuoteValues(a, b, options.sortBy, options.sortDirection))
    .map((quote, index) => ({
      market,
      symbol: quote.symbol,
      name: quote.name || quote.symbol,
      exchange: quote.exchange || market.toUpperCase(),
      sector: quote.sector || findUniverseValue(quoteUniverse, quote.symbol, "sector") || null,
      type: quote.type || findUniverseValue(quoteUniverse, quote.symbol, "type") || null,
      detailUrl: quote.detailUrl || detailUrlForQuote(market, quote),
      price: round(quote.price, 6),
      preMarketPrice: nullableRound(quote.preMarketPrice, 6),
      postMarketPrice: nullableRound(quote.postMarketPrice, 6),
      changeAmount: round(quote.changeAmount || 0, 6),
      changePercent: round(quote.changePercent, 4),
      preMarketChangePercent: nullableRound(quote.preMarketChangePercent, 4),
      postMarketChangePercent: nullableRound(quote.postMarketChangePercent, 4),
      activeChangePercent: null,
      volume: quote.volume || 0,
      signalRank: startRank + index + 1,
      source: quote.source || config.source,
      scannedAt: now,
      raw: quote.raw || null
    }));

  return {
    rows,
    page: options.page,
    perPage: options.perPage,
    total,
    totalPages,
    universeTotal
  };
}

async function scanTopUsStocks() {
  const session = currentChangeSession();
  const universe = await loadUniverse("us-symbols.json").catch(() => []);
  const candidates = await fetchYahooScreenerCandidates(["day_gainers", "most_actives"], 250);
  const stockCandidates = candidates
    .filter((quote) => quote.symbol && quote.quoteType !== "ETF" && quote.type !== "ETF")
    .slice(0, 260)
    .map((quote) => ({
      symbol: quote.symbol,
      name: quote.name || quote.symbol,
      exchange: quote.exchange || "US",
      sector: quote.sector || findUniverseValue(universe, quote.symbol, "sector") || null,
      type: "Stock"
    }));

  const quotes = await fetchYahooChartQuotes(stockCandidates);
  const now = new Date().toISOString();

  const rows = quotes
    .filter((quote) => Number.isFinite(Number(quote.changePercent)))
    .map((quote, index) => topYahooRow({
      quote,
      index,
      market: "top-us",
      exchangeFallback: "US",
      fallbackSector: "Other US Stocks",
      session,
      now
    }));

  return {
    rows,
    candidateCount: candidates.length,
    market: "top-us",
    title: "My Top US Stocks",
    source: "Yahoo Finance",
    activeMetric: "changePercent",
    activeMetricLabel: session.metricLabel,
    marketPhase: session.phase
  };
}

async function scanTopYahooUniverse({ market, title, universeFile, session, exchangeFallback }) {
  session ||= currentChangeSession();
  const universe = (await loadUniverse(universeFile)).filter((item) => item.type !== "ETF");
  let quotes = await fetchYahooQuotes(universe);
  if (market === "top-india") {
    quotes = await enrichIndianPreOpen(quotes);
  }
  const now = new Date().toISOString();
  const rows = quotes
    .filter((quote) => Number.isFinite(Number(quote.changePercent)))
    .map((quote, index) => topYahooRow({
      quote,
      index,
      market,
      exchangeFallback,
      fallbackSector: market === "top-india" ? "Other Indian Stocks" : "Other Stocks",
      session,
      now
    }));

  return {
    rows,
    candidateCount: universe.length,
    market,
    title,
    source: "Yahoo Finance",
    activeMetric: "changePercent",
    activeMetricLabel: session.metricLabel,
    marketPhase: session.phase
  };
}

async function scanTopIndiaStocks() {
  const gainers = await fetchNseTopGainers();
  const now = new Date().toISOString();
  const rows = gainers
    .slice(0, TOP_LIST_SIZE)
    .map((quote, index) => ({
      market: "top-india",
      symbol: quote.symbol,
      name: quote.name || quote.symbol,
      exchange: "NSE",
      sector: quote.sector || null,
      type: "Stock",
      detailUrl: yahooDetailUrl(`${quote.symbol}.NS`),
      price: round(quote.price, 6),
      preMarketPrice: null,
      postMarketPrice: null,
      changeAmount: round(quote.changeAmount || 0, 6),
      changePercent: round(quote.changePercent, 4),
      preMarketChangePercent: null,
      postMarketChangePercent: null,
      activeChangePercent: round(quote.changePercent, 4),
      activeMetric: "changePercent",
      activeMetricLabel: "Current change %",
      volume: quote.volume || 0,
      signalRank: index + 1,
      source: "NSE",
      scannedAt: now,
      raw: {
        timestamp: quote.timestamp,
        activeMetric: "changePercent"
      }
    }));

  return {
    rows,
    candidateCount: gainers.length,
    market: "top-india",
    title: "My Top Indian Stocks",
    source: "NSE",
    activeMetric: "changePercent",
    activeMetricLabel: "Current change %",
    marketPhase: gainers[0]?.timestamp || "NSE"
  };
}

async function scanTopCrypto() {
  const universe = await loadUniverse("crypto-symbols.json");
  const quoteUniverse = universe.slice(0, 250);
  const quotes = await fetchHyperliquidCrypto(quoteUniverse);
  const now = new Date().toISOString();
  const rows = quotes
    .filter((quote) => Number.isFinite(Number(quote.changePercent)))
    .map((quote, index) => ({
      market: "top-crypto",
      symbol: quote.symbol,
      name: quote.name || quote.symbol,
      exchange: quote.exchange || "Hyperliquid",
      sector: quote.sector || inferCryptoSector(quote),
      type: "Crypto",
      detailUrl: quote.detailUrl || detailUrlForQuote("crypto", quote),
      price: round(quote.price, 6),
      preMarketPrice: null,
      postMarketPrice: null,
      changeAmount: round(quote.changeAmount || 0, 6),
      changePercent: round(quote.changePercent, 4),
      preMarketChangePercent: null,
      postMarketChangePercent: null,
      activeChangePercent: round(quote.changePercent, 4),
      activeMetric: "changePercent",
      activeMetricLabel: "24h/current change %",
      volume: quote.volume || 0,
      signalRank: index + 1,
      source: "Hyperliquid",
      scannedAt: now,
      raw: {
        ...quote.raw,
        activeMetric: "changePercent"
      }
    }));

  return {
    rows,
    candidateCount: universe.length,
    market: "top-crypto",
    title: "My Top Crypto",
    source: "Hyperliquid",
    activeMetric: "changePercent",
    activeMetricLabel: "24h/current change %",
    marketPhase: "24H"
  };
}

function topYahooRow({ quote, index, market, exchangeFallback, fallbackSector, session, now }) {
  const metric = session.metric;
  return {
    market,
    symbol: quote.symbol,
    name: quote.name || quote.symbol,
    exchange: quote.exchange || exchangeFallback,
    sector: quote.sector || fallbackSector || null,
    type: quote.type || "Stock",
    detailUrl: quote.detailUrl || yahooDetailUrl(quote.symbol),
    price: round(quote.price, 6),
    preMarketPrice: nullableRound(quote.preMarketPrice, 6),
    postMarketPrice: nullableRound(quote.postMarketPrice, 6),
    changeAmount: round(quote.changeAmount || 0, 6),
    changePercent: round(quote.changePercent, 4),
    preMarketChangePercent: nullableRound(quote.preMarketChangePercent, 4),
    postMarketChangePercent: nullableRound(quote.postMarketChangePercent, 4),
    activeChangePercent: nullableRound(quote[metric], 4),
    activeMetric: metric,
    activeMetricLabel: session.metricLabel,
    volume: quote.volume || 0,
    signalRank: index + 1,
    source: "Yahoo Finance",
    scannedAt: now,
    raw: {
      ...quote.raw,
      marketPhase: session.phase,
      activeMetric: metric
    }
  };
}

async function loadUniverse(fileName) {
  const file = await readFile(join(dataDir, fileName), "utf8");
  return JSON.parse(file);
}

async function fetchYahooQuotes(universe) {
  const symbols = universe.map((item) => item.symbol);
  const batches = chunk(symbols, QUOTE_BATCH_SIZE);
  const allQuotes = [];

  try {
    for (const batch of batches) {
      const endpoint = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(batch.join(","))}`;
      const response = await fetch(endpoint, {
        headers: yahooHeaders()
      });

      if (!response.ok) {
        throw new Error(`Yahoo Finance quote endpoint returned ${response.status}`);
      }

      const payload = await response.json();
      const results = payload?.quoteResponse?.result || [];
      for (const result of results) {
        const regularPrice = Number(result.regularMarketPrice);
        const previousClose = Number(result.regularMarketPreviousClose);
        const preMarketPrice = distinctSessionPrice(result.preMarketPrice, previousClose);
        const postMarketPrice = distinctSessionPrice(result.postMarketPrice, regularPrice);

        allQuotes.push({
          symbol: result.symbol,
          name: result.shortName || result.longName || findName(universe, result.symbol),
          exchange: result.fullExchangeName || result.exchange,
          sector: result.sector || findUniverseValue(universe, result.symbol, "sector"),
          type: findUniverseValue(universe, result.symbol, "type"),
          detailUrl: yahooDetailUrl(result.symbol),
          price: Number(result.regularMarketPrice),
          preMarketPrice,
          postMarketPrice,
          changeAmount: Number(result.regularMarketChange),
          changePercent: Number(result.regularMarketChangePercent),
          preMarketChangePercent: preMarketPrice === null ? null : numberOrNull(result.preMarketChangePercent),
          postMarketChangePercent: postMarketPrice === null ? null : percentChange(postMarketPrice, regularPrice),
          volume: Number(result.regularMarketVolume || result.averageDailyVolume3Month || 0),
          source: "Yahoo Finance",
          raw: {
            currency: result.currency,
            marketState: result.marketState,
            quoteType: result.quoteType
          }
        });
      }

      if (batches.length > 1) {
        await delay(QUOTE_DELAY_MS);
      }
    }

    return allQuotes;
  } catch (error) {
    console.warn(`${error.message}; falling back to Yahoo chart endpoint.`);
    return fetchYahooChartQuotes(universe);
  }
}

async function fetchIndiaQuotes(universe) {
  const quotes = isKiteConfigured()
    ? await fetchKiteQuotes(universe)
    : await fetchYahooQuotes(universe);

  return enrichIndianPreOpen(quotes);
}

async function fetchKiteQuotes(universe) {
  const instruments = universe.map((item) => `NSE:${item.nativeSymbol || String(item.symbol).replace(/\.NS$/, "")}`);
  const batches = chunk(instruments, 500);
  const quotes = [];

  for (const batch of batches) {
    const params = new URLSearchParams();
    batch.forEach((instrument) => params.append("i", instrument));

    const endpoint = `https://api.kite.trade/quote?${params.toString()}`;
    const response = await fetch(endpoint, {
      headers: {
        "Accept": "application/json",
        "X-Kite-Version": "3",
        "Authorization": `token ${process.env.KITE_API_KEY}:${process.env.KITE_ACCESS_TOKEN}`
      }
    });

    if (!response.ok) {
      throw new Error(`Kite quote returned ${response.status}`);
    }

    const payload = await response.json();
    const data = payload?.data || {};

    for (const [instrument, quote] of Object.entries(data)) {
      const nativeSymbol = instrument.replace(/^NSE:/, "");
      const universeRow = universe.find((item) => (item.nativeSymbol || item.symbol.replace(/\.NS$/, "")) === nativeSymbol);
      const price = Number(quote.last_price);
      const previousClose = Number(quote.ohlc?.close);
      const changeAmount = price - previousClose;
      const changePercent = previousClose ? (changeAmount / previousClose) * 100 : null;

      quotes.push({
        symbol: universeRow?.symbol || `${nativeSymbol}.NS`,
        name: universeRow?.name || nativeSymbol,
        exchange: "NSE",
        sector: universeRow?.sector || null,
        type: universeRow?.type || "Stock",
        detailUrl: yahooDetailUrl(universeRow?.symbol || `${nativeSymbol}.NS`),
        price,
        preMarketPrice: null,
        postMarketPrice: null,
        changeAmount,
        changePercent,
        preMarketChangePercent: null,
        postMarketChangePercent: null,
        volume: Number(quote.volume || 0),
        source: "Zerodha Kite",
        raw: {
          instrument,
          mode: "quote",
          ohlc: quote.ohlc
        }
      });
    }

    if (batches.length > 1) {
      await delay(QUOTE_DELAY_MS);
    }
  }

  return quotes;
}

async function enrichIndianPreOpen(quotes) {
  const preOpen = await fetchNsePreOpenMap().catch((error) => {
    console.warn(`NSE pre-open enrichment unavailable: ${error.message}`);
    return new Map();
  });

  if (!preOpen.size) return quotes;

  return quotes.map((quote) => {
    const nativeSymbol = String(quote.symbol || "").replace(/\.NS$/, "");
    const pre = preOpen.get(nativeSymbol);
    if (!pre) return quote;

    return {
      ...quote,
      preMarketPrice: pre.price,
      preMarketChangePercent: pre.changePercent,
      raw: {
        ...quote.raw,
        nsePreOpen: pre
      }
    };
  });
}

async function fetchYahooPredefinedScreener(scrId, count) {
  const endpoint = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=false&scrIds=${encodeURIComponent(scrId)}&count=${count}`;
  const response = await fetch(endpoint, { headers: yahooHeaders() });

  if (!response.ok) {
    throw new Error(`Yahoo screener returned ${response.status}`);
  }

  const payload = await response.json();
  const quotes = payload?.finance?.result?.[0]?.quotes || [];

  return quotes.map((quote) => ({
    symbol: quote.symbol,
    name: quote.shortName || quote.longName || quote.displayName || quote.symbol,
    exchange: quote.fullExchangeName || quote.exchange,
    sector: quote.sector || null,
    type: quote.quoteType === "ETF" ? "ETF" : "Stock",
    quoteType: quote.quoteType,
    price: Number(quote.regularMarketPrice?.raw ?? quote.regularMarketPrice),
    changeAmount: Number(quote.regularMarketChange?.raw ?? quote.regularMarketChange),
    changePercent: Number(quote.regularMarketChangePercent?.raw ?? quote.regularMarketChangePercent),
    volume: Number((quote.regularMarketVolume?.raw ?? quote.regularMarketVolume) || 0),
    source: "Yahoo Finance"
  }));
}

async function fetchNseTopGainers() {
  const endpoint = "https://www.nseindia.com/api/live-analysis-variations?index=gainers";
  const response = await fetch(endpoint, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 StockScreenerApp/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`NSE top gainers returned ${response.status}`);
  }

  const payload = await response.json();
  const timestamp = payload?.allSec?.timestamp || payload?.NIFTY?.timestamp || null;
  const rows = payload?.allSec?.data || [];

  return rows
    .filter((row) => row.symbol && row.series === "EQ")
    .map((row) => ({
      symbol: row.symbol,
      name: row.symbol,
      price: Number(row.ltp),
      changeAmount: Number(row.ltp) - Number(row.prev_price),
      changePercent: Number(row.perChange ?? row.net_price),
      volume: Number(row.trade_quantity || 0),
      timestamp
    }))
    .filter((row) => Number.isFinite(row.price) && Number.isFinite(row.changePercent))
    .sort((a, b) => b.changePercent - a.changePercent);
}

async function fetchNsePreOpenMap() {
  const endpoint = "https://www.nseindia.com/api/market-data-pre-open?key=ALL";
  const response = await fetch(endpoint, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 StockScreenerApp/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`NSE pre-open returned ${response.status}`);
  }

  const payload = await response.json();
  const map = new Map();

  for (const row of payload?.data || []) {
    const metadata = row.metadata || {};
    if (!metadata.symbol || metadata.series !== "EQ") continue;

    const price = Number(metadata.lastPrice);
    const changePercent = Number(metadata.pChange);
    if (!Number.isFinite(price)) continue;

    map.set(metadata.symbol, {
      price,
      changeAmount: numberOrNull(metadata.change),
      changePercent: Number.isFinite(changePercent) ? changePercent : null,
      purpose: metadata.purpose || null
    });
  }

  return map;
}

async function fetchYahooScreenerCandidates(scrIds, count) {
  const all = [];
  const seen = new Set();

  for (const scrId of scrIds) {
    const rows = await fetchYahooPredefinedScreener(scrId, count);
    for (const row of rows) {
      if (!row.symbol || seen.has(row.symbol)) continue;
      seen.add(row.symbol);
      all.push(row);
    }
  }

  return all;
}

async function fetchYahooChartQuotes(universe) {
  const quotes = [];
  const concurrency = YAHOO_CHART_CONCURRENCY;
  let cursor = 0;

  async function worker() {
    while (cursor < universe.length) {
      const item = universe[cursor];
      cursor += 1;

      try {
        const quote = await fetchYahooChartQuote(item);
        if (quote) quotes.push(quote);
      } catch (error) {
        console.warn(`Skipping ${item.symbol}: ${error.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return quotes;
}

async function fetchYahooChartQuote(item) {
  const endpoint = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(item.symbol)}?range=1d&interval=1m&includePrePost=true`;
  const response = await fetch(endpoint, { headers: yahooHeaders() });

  if (!response.ok) {
    throw new Error(`Yahoo chart returned ${response.status}`);
  }

  const payload = await response.json();
  const result = payload?.chart?.result?.[0];
  const meta = result?.meta;
  const periods = meta?.currentTradingPeriod || {};

  if (!meta) {
    return null;
  }

  const price = Number(meta.regularMarketPrice);
  const previousClose = Number(meta.previousClose || meta.chartPreviousClose);
  const changeAmount = price - previousClose;
  const changePercent = previousClose ? (changeAmount / previousClose) * 100 : 0;
  const marketState = normalizeMarketPhase(meta.marketState || inferMarketState(result, periods));
  const preMarketPrice = distinctSessionPrice(meta.preMarketPrice, previousClose);
  const overnightPrice = latestTradingPeriodClose(result, "post");
  const postMarketPrice = distinctSessionPrice(meta.postMarketPrice, price)
    || distinctSessionPrice(overnightPrice, price);

  return {
    symbol: meta.symbol || item.symbol,
    name: meta.shortName || meta.longName || item.name || item.symbol,
    exchange: meta.fullExchangeName || meta.exchangeName,
    sector: item.sector || null,
    type: item.type || null,
    detailUrl: yahooDetailUrl(meta.symbol || item.symbol),
    price,
    preMarketPrice,
    postMarketPrice,
    changeAmount,
    changePercent,
    preMarketChangePercent: percentChange(preMarketPrice, previousClose),
    postMarketChangePercent: percentChange(postMarketPrice, price),
    volume: Number(meta.regularMarketVolume || 0),
    source: "Yahoo Finance",
    raw: {
      currency: meta.currency,
      hasPrePostMarketData: meta.hasPrePostMarketData || false,
      marketState,
      overnightPrice,
      quoteType: meta.instrumentType
    }
  };
}

async function fetchYahooHistoricalChart(symbol, { range, interval }) {
  const safeRange = ["1d", "5d", "1mo", "3mo", "6mo", "1y", "2y"].includes(range) ? range : "1d";
  const safeInterval = ["1m", "5m", "15m", "1d", "1wk", "1mo"].includes(interval) ? interval : "1m";
  const includePrePost = safeInterval.endsWith("m") ? "true" : "false";
  const endpoint = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(safeRange)}&interval=${encodeURIComponent(safeInterval)}&includePrePost=${includePrePost}`;
  const response = await fetch(endpoint, { headers: yahooHeaders() });

  if (!response.ok) {
    throw new Error(`Yahoo chart returned ${response.status}`);
  }

  const payload = await response.json();
  const result = payload?.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0] || {};
  const timestamps = result?.timestamp || [];
  const meta = result?.meta || {};

  const candles = timestamps.map((timestamp, index) => ({
    time: new Date(timestamp * 1000).toISOString(),
    open: numberOrNull(quote.open?.[index]),
    high: numberOrNull(quote.high?.[index]),
    low: numberOrNull(quote.low?.[index]),
    close: numberOrNull(quote.close?.[index]),
    volume: Number(quote.volume?.[index] || 0)
  })).filter((candle) =>
    [candle.open, candle.high, candle.low, candle.close].every((value) => Number.isFinite(Number(value)))
  );

  return {
    symbol: meta.symbol || symbol,
    currency: meta.currency || null,
    exchangeName: meta.exchangeName || null,
    range: safeRange,
    interval: safeInterval,
    regularMarketPrice: numberOrNull(meta.regularMarketPrice),
    lastPrice: candles.at(-1)?.close ?? null,
    candles
  };
}

async function fetchHyperliquidCrypto(universe = []) {
  const [meta, contexts] = await hyperliquidInfo({ type: "spotMetaAndAssetCtxs" });
  const tokenByIndex = new Map((meta?.tokens || []).map((token) => [token.index, token]));
  const wantedCoins = new Set(universe.map((item) => item.hyperliquidCoin).filter(Boolean));
  const wantedSymbols = new Set(universe.map((item) => item.symbol).filter(Boolean));
  const rows = [];

  for (const pair of meta?.universe || []) {
    const context = contexts?.[pair.index];
    const quoteToken = tokenByIndex.get(pair.tokens?.[1]);
    if (quoteToken?.name && quoteToken.name !== "USDC") continue;

    const baseToken = tokenByIndex.get(pair.tokens?.[0]);
    const symbol = `${String(baseToken?.name || pair.name).toUpperCase()}-USD`;
    if (wantedCoins.size && !wantedCoins.has(pair.name) && !wantedSymbols.has(symbol)) continue;

    const quote = hyperliquidSpotRowToQuote({ pair, context, baseToken });
    if (quote) rows.push(quote);
  }

  return rows;
}

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

function hyperliquidSpotRowToQuote({ pair, context, baseToken }) {
  const price = marketPriceOrNull(context?.midPx) || marketPriceOrNull(context?.markPx);
  const previous = marketPriceOrNull(context?.prevDayPx);
  if (price === null || previous === null) return null;

  const nativeSymbol = String(baseToken?.name || pair.name).toUpperCase();
  const changeAmount = price - previous;
  const changePercent = previous ? (changeAmount / previous) * 100 : 0;

  return {
    symbol: `${nativeSymbol}-USD`,
    name: `${nativeSymbol}/USDC`,
    exchange: "Hyperliquid",
    sector: inferCryptoSector({ symbol: nativeSymbol, name: nativeSymbol }),
    type: "Crypto",
    detailUrl: `https://app.hyperliquid.xyz/trade/${encodeURIComponent(pair.name)}`,
    price,
    preMarketPrice: null,
    postMarketPrice: null,
    changeAmount,
    changePercent,
    preMarketChangePercent: null,
    postMarketChangePercent: null,
    volume: Number(context?.dayNtlVlm || 0),
    source: "Hyperliquid",
    raw: {
      hyperliquidCoin: pair.name,
      pairIndex: pair.index,
      tokenIndex: baseToken?.index,
      midPx: context?.midPx,
      markPx: context?.markPx,
      prevDayPx: context?.prevDayPx,
      dayBaseVlm: context?.dayBaseVlm,
      dayNtlVlm: context?.dayNtlVlm
    }
  };
}

async function storeSignals(rows) {
  if (!isSupabaseConfigured()) {
    return { enabled: false, message: "Supabase env vars are not configured." };
  }

  if (!rows.length) {
    return { enabled: true, inserted: 0 };
  }

  const endpoint = `${supabaseRestBase()}/${SUPABASE_TABLE}?on_conflict=market,ticker`;
  const payload = rows.map((row) => ({
    market: row.market,
    symbol: row.symbol,
    ticker: row.symbol,
    name: row.name,
    exchange: row.exchange,
    sector: row.sector,
    price: row.price,
    pre_market_price: row.preMarketPrice,
    post_market_price: row.postMarketPrice,
    change_amount: row.changeAmount,
    change_percent: row.changePercent,
    pre_market_change_percent: row.preMarketChangePercent,
    post_market_change_percent: row.postMarketChangePercent,
    volume: row.volume,
    signal_rank: row.signalRank,
    source: row.source,
    scanned_at: row.scannedAt,
    raw: row.raw
  }));

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": process.env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Prefer": "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const details = await response.text();
      if (details.toLowerCase().includes("sector")) {
        const fallbackResponse = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "apikey": process.env.SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
            "Prefer": "resolution=merge-duplicates,return=minimal"
          },
          body: JSON.stringify(payload.map(({ sector, ...row }) => row))
        });

        if (fallbackResponse.ok) {
          return {
            enabled: true,
            inserted: rows.length,
            warning: "Stored without sector column; run the Supabase migration to persist sectors."
          };
        }
      }

      return {
        enabled: true,
        inserted: 0,
        error: `Supabase returned ${response.status}`,
        details
      };
    }
  } catch (error) {
    return {
      enabled: true,
      inserted: 0,
      error: "Supabase write failed",
      details: error.message
    };
  }

  return { enabled: true, inserted: rows.length };
}

async function readStoredSignals({ market, page, perPage, query, sortBy, sortDirection }) {
  if (!isSupabaseConfigured()) return null;

  const rows = await fetchStoredRows(market);
  if (!rows.length) return null;

  const filtered = filterStoredRows(rows, query);
  const sorted = filtered.sort((a, b) => compareQuoteValues(a, b, sortBy, sortDirection));
  const pageRows = paginate(sorted, page, perPage).map((row, index) => ({
    ...row,
    signalRank: (page - 1) * perPage + index + 1
  }));

  return {
    rows: pageRows,
    total: filtered.length,
    scannedAt: newestScannedAt(filtered)
  };
}

async function readStoredTopMarket(market, { sector, sortBy, sortDirection }) {
  if (!isSupabaseConfigured()) return null;

  const rows = await fetchStoredRows(market);
  if (!rows.length) return null;

  const requestedSector = normalizeSector(sector);
  const normalizedSortBy = normalizeTopSortBy(sortBy);
  const direction = sortDirection === "desc" ? "desc" : "asc";
  const filtered = requestedSector
    ? rows.filter((row) => normalizeSector(row.sector) === requestedSector)
    : rows;
  const sortableRows = filtered
    .filter((row) => hasSortableValue(row[normalizedSortBy]))
    .sort((a, b) => compareQuoteValues(a, b, normalizedSortBy, direction));
  const activeMetric = percentMetricFor(normalizedSortBy);
  const pageRows = sortableRows.slice(0, TOP_LIST_SIZE).map((row, index) => ({
    ...row,
    activeChangePercent: activeMetric ? nullableRound(row[activeMetric], 4) : row.activeChangePercent,
    activeMetric: normalizedSortBy,
    activeMetricLabel: topMetricLabel(normalizedSortBy),
    signalRank: index + 1
  }));

  return {
    rows: pageRows,
    total: sortableRows.length,
    sectors: sectorList(rows),
    scannedAt: newestScannedAt(rows),
    ageMs: ageMs(newestScannedAt(rows))
  };
}

async function fetchStoredRows(market) {
  const endpoint = new URL(`${supabaseRestBase()}/${SUPABASE_TABLE}`);
  endpoint.searchParams.set("select", "*");
  endpoint.searchParams.set("market", `eq.${market}`);
  endpoint.searchParams.set("limit", "10000");

  const response = await fetch(endpoint, {
    headers: supabaseHeaders()
  });

  if (!response.ok) {
    throw new Error(`Supabase read returned ${response.status}`);
  }

  const rows = await response.json();
  return rows.map(storedSignalToRow);
}

function storedSignalToRow(row) {
  return {
    market: row.market,
    symbol: row.symbol || row.ticker,
    name: row.name || row.symbol || row.ticker,
    exchange: row.exchange || "",
    sector: row.sector || null,
    type: row.raw?.quoteType || null,
    detailUrl: detailUrlForQuote(row.market, { symbol: row.symbol || row.ticker, raw: row.raw }),
    price: numberOrNull(row.price),
    preMarketPrice: numberOrNull(row.pre_market_price),
    postMarketPrice: numberOrNull(row.post_market_price),
    changeAmount: numberOrNull(row.change_amount) || 0,
    changePercent: numberOrNull(row.change_percent),
    preMarketChangePercent: numberOrNull(row.pre_market_change_percent),
    postMarketChangePercent: numberOrNull(row.post_market_change_percent),
    activeChangePercent: null,
    volume: Number(row.volume || 0),
    signalRank: Number(row.signal_rank || 0),
    source: row.source || "Supabase",
    scannedAt: row.scanned_at,
    raw: row.raw || null
  };
}

function filterStoredRows(rows, query) {
  if (!query) return rows;
  const needle = query.toLowerCase();
  return rows.filter((row) =>
    [row.symbol, row.name, row.exchange, row.sector, row.type].some((value) =>
      String(value || "").toLowerCase().includes(needle)
    )
  );
}

function newestScannedAt(rows) {
  return rows
    .map((row) => row.scannedAt)
    .filter(Boolean)
    .sort()
    .at(-1) || null;
}

function ageMs(value) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? Date.now() - timestamp : null;
}

async function serveStatic(pathname, res) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const fullPath = join(publicDir, safePath);

  if (!fullPath.startsWith(publicDir)) {
    sendText(res, "Forbidden", 403);
    return;
  }

  try {
    const file = await readFile(fullPath);
    res.writeHead(200, {
      "Content-Type": contentTypes[extname(fullPath)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(file);
  } catch {
    const index = await readFile(join(publicDir, "index.html"));
    res.writeHead(200, { "Content-Type": contentTypes[".html"], "Cache-Control": "no-store" });
    res.end(index);
  }
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

function sendText(res, text, status = 200) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function findName(universe, symbol) {
  return universe.find((item) => item.symbol === symbol)?.name || symbol;
}

function findUniverseValue(universe, symbol, key) {
  return universe.find((item) => item.symbol === symbol)?.[key] || null;
}

function filterUniverse(universe, query) {
  if (!query) return universe;
  const needle = query.toLowerCase();
  return universe.filter((item) =>
    [item.symbol, item.name, item.exchange, item.sector, item.type].some((value) =>
      String(value || "").toLowerCase().includes(needle)
    )
  );
}

function filterQuotes(quotes, query) {
  if (!query) return quotes;
  const needle = query.toLowerCase();
  return quotes.filter((item) =>
    [item.symbol, item.name, item.exchange, item.sector, item.type].some((value) =>
      String(value || "").toLowerCase().includes(needle)
    )
  );
}

function sectorList(rows) {
  return [...new Set(rows.map((row) => normalizeSector(row.sector)).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

function normalizeTopSortBy(sortBy) {
  const allowed = new Set([
    "changePercent",
    "price",
    "preMarketPrice",
    "postMarketPrice",
    "preMarketChangePercent",
    "postMarketChangePercent"
  ]);
  return allowed.has(sortBy) ? sortBy : "changePercent";
}

function topMetricLabel(sortBy) {
  return {
    changePercent: "Current change %",
    price: "Current price",
    preMarketPrice: "Pre-market price",
    postMarketPrice: "Overnight price",
    preMarketChangePercent: "Pre-market change %",
    postMarketChangePercent: "Overnight change %"
  }[sortBy] || "Current change %";
}

function percentMetricFor(sortBy) {
  return {
    changePercent: "changePercent",
    preMarketChangePercent: "preMarketChangePercent",
    postMarketChangePercent: "postMarketChangePercent"
  }[sortBy] || null;
}

function hasSortableValue(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function normalizeSector(value) {
  const sector = String(value || "").trim();
  if (!sector || sector === "--") return "";
  return sector;
}

function inferCryptoSector(row) {
  const symbol = String(row.symbol || "").toUpperCase().replace(/-USD$/, "");
  const name = String(row.name || "").toLowerCase();
  const text = `${symbol.toLowerCase()} ${name}`;

  if (/(usd|tether|usdc|dai|stable|paypal usd|ripple usd|trueusd|frax|usde|usds|usd1|usdd|pyusd|rlusd)/i.test(text)) return "Stablecoins";
  if (/(bitcoin|btc|litecoin|ltc|bitcoin cash|bch|dogecoin|doge|monero|xmr|zcash|zec|proof of work)/i.test(text)) return "Payments / Store of Value";
  if (/(ethereum|eth|solana|sol|bnb|cardano|ada|avalanche|avax|sui|near|polkadot|dot|toncoin|ton|cosmos|atom|algorand|algo|hedera|hbar|internet computer|icp|layer 1)/i.test(text)) return "Layer 1";
  if (/(arbitrum|optimism|polygon|matic|pol|starknet|immutable|mantle|base|zksync|layer 2|scaling)/i.test(text)) return "Layer 2 / Scaling";
  if (/(uniswap|uni|aave|maker|mkr|compound|comp|curve|crv|pancake|cake|lido|ondo|morpho|defi|yield|liquidity)/i.test(text)) return "DeFi";
  if (/(binance|okb|leo|kucoin|kcs|crypto.com|cro|bitget|bgb|htx|exchange)/i.test(text)) return "Exchange Tokens";
  if (/(shib|pepe|floki|bonk|meme)/i.test(text)) return "Meme";
  if (/(render|tao|bittensor|fetch|fet|ai|artificial intelligence|near)/i.test(text)) return "AI / Compute";
  if (/(paxg|xaut|gold|tokenized|treasury|blackrock|buidl|usyc|usd yield)/i.test(text)) return "Tokenized Assets";
  if (/(game|gaming|metaverse|sandbox|mana|gala|ronin|axie)/i.test(text)) return "Gaming / Metaverse";

  return "Other Crypto";
}

function paginate(items, page, perPage) {
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}

function compareQuoteValues(a, b, field, direction) {
  const multiplier = direction === "desc" ? -1 : 1;

  if (["symbol", "name", "exchange", "type"].includes(field)) {
    return String(a[field] || "").localeCompare(String(b[field] || "")) * multiplier;
  }

  const aValue = Number(a[field]);
  const bValue = Number(b[field]);
  const aFinite = Number.isFinite(aValue);
  const bFinite = Number.isFinite(bValue);

  if (!aFinite && !bFinite) return String(a.symbol).localeCompare(String(b.symbol));
  if (!aFinite) return 1;
  if (!bFinite) return -1;
  if (aValue === bValue) return String(a.symbol).localeCompare(String(b.symbol));
  return (aValue - bValue) * multiplier;
}

function detailUrlForQuote(market, quote) {
  if ((market === "crypto" || market === "top-crypto") && quote.raw?.id) {
    return `https://www.coingecko.com/en/coins/${encodeURIComponent(quote.raw.id)}`;
  }

  return yahooDetailUrl(quote.symbol);
}

function yahooDetailUrl(symbol) {
  return `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/chart`;
}

function isKiteConfigured() {
  return Boolean(process.env.KITE_API_KEY && process.env.KITE_ACCESS_TOKEN);
}

function supabaseRestBase() {
  return `${process.env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1`;
}

function supabaseHeaders(extra = {}) {
  return {
    "apikey": process.env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra
  };
}

function isSupabaseConfigured() {
  const url = process.env.SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  return Boolean(
    url &&
    key &&
    !url.includes("your-project") &&
    !key.includes("your-service-role-key")
  );
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return max;
  return Math.min(Math.max(value, min), max);
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(Number(value) * factor) / factor;
}

function nullableRound(value, places) {
  if (value === null || value === undefined || value === "") return null;
  return Number.isFinite(Number(value)) ? round(value, places) : null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function marketPriceOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function distinctSessionPrice(value, regularPrice) {
  const price = marketPriceOrNull(value);
  if (price === null) return null;
  const regular = Number(regularPrice);
  if (Number.isFinite(regular) && Math.abs(price - regular) < 0.000001) return null;
  return price;
}

function percentChange(price, previousClose) {
  if (!Number.isFinite(price) || !Number.isFinite(previousClose) || previousClose === 0) {
    return null;
  }

  return ((price - previousClose) / previousClose) * 100;
}

function normalizeMarketPhase(marketState) {
  const value = String(marketState || "").toUpperCase();

  if (value.includes("PRE")) return "PRE";
  if (value.includes("REGULAR")) return "REGULAR";
  if (value.includes("POST")) return "POST";
  return "CLOSED";
}

function currentChangeSession(phase = "REGULAR") {
  return {
    phase,
    metric: "changePercent",
    metricLabel: "Current change %"
  };
}

function latestSessionClose(chartResult, session) {
  if (!session?.start || !session?.end) return null;

  const timestamps = chartResult?.timestamp || [];
  const closes = chartResult?.indicators?.quote?.[0]?.close || [];
  let latest = null;

  for (let index = 0; index < timestamps.length; index += 1) {
    const timestamp = Number(timestamps[index]);
    const close = marketPriceOrNull(closes[index]);
    if (close !== null && timestamp >= session.start && timestamp <= session.end) {
      latest = close;
    }
  }

  return latest;
}

function latestTradingPeriodClose(chartResult, periodName) {
  const periods = chartResult?.meta?.tradingPeriods?.[periodName] || [];
  let latest = null;

  for (const dayPeriods of periods) {
    for (const period of dayPeriods || []) {
      const close = latestSessionClose(chartResult, period);
      if (close !== null) latest = close;
    }
  }

  return latest;
}

function inferMarketState(chartResult, periods) {
  const timestamps = chartResult?.timestamp || [];
  const latest = Number(timestamps[timestamps.length - 1]);

  if (!Number.isFinite(latest)) return null;
  if (withinSession(latest, periods.pre)) return "PRE";
  if (withinSession(latest, periods.regular)) return "REGULAR";
  if (withinSession(latest, periods.post)) return "POST";
  return "CLOSED";
}

function withinSession(timestamp, session) {
  return Boolean(session?.start && session?.end && timestamp >= session.start && timestamp <= session.end);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function yahooHeaders() {
  return {
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0 StockScreenerApp/1.0"
  };
}

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;

  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
