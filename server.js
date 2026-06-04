import http from "node:http";
import https from "node:https";
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
const YAHOO_QUOTE_CONCURRENCY = Number(process.env.YAHOO_QUOTE_CONCURRENCY || 8);
const YAHOO_CHART_CONCURRENCY = Number(process.env.YAHOO_CHART_CONCURRENCY || 24);
const YAHOO_CHART_DELAY_MS = Number(process.env.YAHOO_CHART_DELAY_MS || 0);
const YAHOO_OVERNIGHT_CONCURRENCY = Number(process.env.YAHOO_OVERNIGHT_CONCURRENCY || 32);
const YAHOO_FETCH_TIMEOUT_MS = Number(process.env.YAHOO_FETCH_TIMEOUT_MS || 8_000);
const SUPABASE_TABLE = process.env.SUPABASE_SIGNALS_TABLE || "stock_signals";
const TOP_LIST_SIZE = Number(process.env.TOP_LIST_SIZE || 250);
const SCAN_CACHE_MS = Number(process.env.SCAN_CACHE_MS || 60_000);
const ACTIVE_PAGE_REFRESH_MS = Number(process.env.ACTIVE_PAGE_REFRESH_MS || 30_000);
const TOP_CACHE_MS = Number(process.env.TOP_CACHE_MS || 300_000);
const TOP_STALE_MS = Number(process.env.TOP_STALE_MS || 1_800_000);
const DATA_REFRESH_MS = Number(process.env.DATA_REFRESH_MS || 0);
const BACKGROUND_MARKET_PAGES = Number(process.env.BACKGROUND_MARKET_PAGES || 0);
const US_SESSION_FILTER_CACHE_MS = Number(process.env.US_SESSION_FILTER_CACHE_MS || 120_000);
const EARNINGS_CACHE_MS = Number(process.env.EARNINGS_CACHE_MS || 3_600_000);
const EARNINGS_FETCH_CONCURRENCY = Number(process.env.EARNINGS_FETCH_CONCURRENCY || 2);
const MARKET_WATCH_CACHE_MS = Number(process.env.MARKET_WATCH_CACHE_MS || 60_000);
const backgroundRefreshState = {
  running: false,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastError: null
};
const topMarketCache = new Map();
const scanCache = new Map();
const activePageRefreshes = new Map();
const usSessionFilterCache = new Map();
const earningsCache = new Map();
let marketWatchCache = null;
const marketWatchHistory = new Map();

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const marketConfig = {
  us: {
    title: "All US Stocks/ETFs",
    universeFile: "us-symbols.json",
    source: "Yahoo Finance",
    quoteProvider: fetchYahooQuotes
  },
  india: {
    title: "All Indian Stocks",
    universeFile: "india-symbols.json",
    source: "Yahoo Finance / Kite",
    quoteProvider: fetchIndiaQuotes
  },
  crypto: {
    title: "All Crypto",
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
      await handleTopMarket("top-us", "", "", "changePercent", "desc", res);
      return;
    }

    if (url.pathname === "/api/top-market") {
      await handleTopMarket(
        url.searchParams.get("market") || "top-us",
        url.searchParams.get("sector") || "",
        url.searchParams.get("query") || "",
        url.searchParams.get("sortBy") || "changePercent",
        url.searchParams.get("direction") || "desc",
        res
      );
      return;
    }

    if (url.pathname === "/api/earnings") {
      await handleEarningsCalendar(url, res);
      return;
    }

    if (url.pathname === "/api/market-watch") {
      await handleMarketWatch(url, res);
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
  const sector = normalizeSector(url.searchParams.get("sector") || "");
  const sortBy = normalizeTopSortBy(url.searchParams.get("sortBy") || "changePercent");
  const sortDirection = url.searchParams.get("direction") || "asc";
  const startedAt = new Date();
  const universe = config.universeFile ? await loadUniverse(config.universeFile).catch(() => []) : [];
  const sectorOptions = market === "us" || market === "india" ? sectorList(universe) : [];
  const cacheKey = scanCacheKey({ market, page, perPage, query, sector, sortBy, sortDirection });
  const cached = scanCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < SCAN_CACHE_MS) {
    scheduleActiveScanRefresh(cached.payload, { market, page, perPage, query, sector, sortBy, sortDirection, universe });
    sendJson(res, {
      ...cached.payload,
      cache: { hit: true, ageMs: Date.now() - cached.cachedAt }
    });
    return;
  }

  const stored = shouldUseStoredScanRows({ market, query })
    ? await readStoredSignals({
      market,
      page,
      perPage,
      query,
      sector,
      sortBy,
      sortDirection
    }).catch((error) => {
      console.warn(`Supabase read failed for ${market}: ${error.message}`);
      return null;
    })
    : null;

  if (stored?.rows?.length) {
    const payload = {
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
      sectors: sectorOptions,
      sector,
      activeMetric: stored.activeMetric,
      activeMetricLabel: stored.activeMetricLabel,
      storage: { enabled: true, source: "Supabase snapshot", refreshedAt: stored.scannedAt },
      rows: stored.rows
    };
    cacheScanPayload(cacheKey, payload);
    scheduleActiveScanRefresh(payload, { market, page, perPage, query, sector, sortBy, sortDirection, universe });
    sendJson(res, payload);
    return;
  }

  const scan = await scanMarket(market, config, { page, perPage, query, sector, sortBy, sortDirection, universe });
  const rows = scan.rows;
  if (market === "us" && usesSparseUsSessionFilter(sortBy) && !query && !rows.length) {
    const fallback = await readStoredSignals({ market, page, perPage, query, sector, sortBy, sortDirection }).catch(() => null);
    if (fallback?.rows?.length) {
      const payload = {
        market,
        title: config.title,
        source: fallback.rows[0]?.source || config.source,
        scannedAt: fallback.scannedAt || startedAt.toISOString(),
        count: fallback.rows.length,
        total: fallback.total,
        page,
        perPage,
        totalPages: Math.max(1, Math.ceil(fallback.total / perPage)),
        universeTotal: scan.universeTotal,
        sectors: sectorOptions,
        sector,
        activeMetric: fallback.activeMetric,
        activeMetricLabel: fallback.activeMetricLabel,
        storage: { enabled: true, source: "Supabase snapshot fallback", refreshedAt: fallback.scannedAt },
        rows: fallback.rows
      };
      cacheScanPayload(cacheKey, payload);
      scheduleActiveScanRefresh(payload, { market, page, perPage, query, sector, sortBy, sortDirection, universe });
      sendJson(res, payload);
      return;
    }
  }
  const storage = await storeSignals(rows);

  const payload = {
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
    sectors: sectorOptions,
    sector,
    activeMetric: market === "us" ? normalizeTopSortBy(sortBy) : null,
    activeMetricLabel: market === "us" ? topMetricLabel(normalizeTopSortBy(sortBy)) : null,
    storage,
    rows
  };
  cacheScanPayload(cacheKey, payload);
  sendJson(res, payload);
}

async function handleTopMarket(topMarket, sector, query, sortBy, sortDirection, res) {
  const cacheKey = normalizeTopMarket(topMarket);
  const normalizedSortBy = normalizeTopSortBy(sortBy);
  const normalizedDirection = sortDirection === "desc" ? "desc" : "asc";
  const runtimeCacheKey = topMarketRuntimeCacheKey(cacheKey, normalizedSortBy, normalizedDirection);
  const stored = await readStoredTopMarket(cacheKey, { sector, query, sortBy, sortDirection }).catch((error) => {
      console.warn(`Supabase top market read failed for ${cacheKey}: ${error.message}`);
      return null;
    });

  if (stored?.rows?.length || stored?.total === 0) {
    const storedAge = stored.ageMs || 0;
    const shouldRefreshStoredTopUs = cacheKey === "top-us" && storedAge > TOP_CACHE_MS;
    if (shouldRefreshStoredTopUs) refreshTopMarketCache(cacheKey);
    const payload = {
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
      query: String(query || "").trim(),
      activeMetric: normalizeTopSortBy(sortBy),
      activeMetricLabel: cacheKey === "top-crypto" && normalizeTopSortBy(sortBy) === "changePercent"
        ? "24h change %"
        : topMetricLabel(normalizeTopSortBy(sortBy)),
      marketPhase: "Supabase snapshot",
      storage: { enabled: true, source: "Supabase snapshot", refreshedAt: stored.scannedAt },
      rows: stored.rows,
      cache: { hit: true, stale: shouldRefreshStoredTopUs, ageMs: storedAge }
    };
    scheduleActiveTopRefresh(payload, { market: cacheKey, sector, query, sortBy, sortDirection });
    sendJson(res, payload);
    return;
  }

  const cached = topMarketCache.get(runtimeCacheKey);
  const cacheAge = cached ? Date.now() - cached.cachedAt : Infinity;

  if (cached?.payload && cacheAge < TOP_CACHE_MS) {
    sendJson(res, { ...filterTopMarketPayload(cached.payload, { sector, query, sortBy, sortDirection }), cache: { hit: true, stale: false, ageMs: cacheAge } });
    return;
  }

  if (cached?.payload && cacheAge < TOP_STALE_MS) {
    refreshTopMarketCache(cacheKey, { sortBy: normalizedSortBy, cacheKey: runtimeCacheKey });
    sendJson(res, { ...filterTopMarketPayload(cached.payload, { sector, query, sortBy, sortDirection }), cache: { hit: true, stale: true, ageMs: cacheAge } });
    return;
  }

  if (cacheKey === "top-us") {
    const payload = await buildTopMarketPayload(cacheKey, { sortBy: normalizedSortBy, sortDirection: normalizedDirection, cacheKey: runtimeCacheKey });
    sendJson(res, { ...filterTopMarketPayload(payload, { sector, query, sortBy: normalizedSortBy, sortDirection: normalizedDirection }), cache: { hit: false, stale: false, ageMs: 0 } });
    return;
  }

  const payload = await buildTopMarketPayload(cacheKey, { cacheKey: runtimeCacheKey, sortDirection: normalizedDirection });
  sendJson(res, { ...filterTopMarketPayload(payload, { sector, query, sortBy, sortDirection }), cache: { hit: false, stale: false, ageMs: 0 } });
}

function topMarketRuntimeCacheKey(market, sortBy, sortDirection) {
  return market === "top-us" ? `${market}:${normalizeTopSortBy(sortBy)}:${sortDirection === "asc" ? "asc" : "desc"}` : market;
}

function shouldUseStoredScanRows({ market, query }) {
  if (market === "crypto") return false;
  if (market === "us" || market === "india") return true;
  return true;
}

function scanCacheKey({ market, page, perPage, query, sector, sortBy, sortDirection }) {
  return [
    market,
    page,
    perPage,
    query || "",
    normalizeSector(sector),
    normalizeTopSortBy(sortBy),
    sortDirection === "desc" ? "desc" : "asc"
  ].join("|");
}

function cacheScanPayload(cacheKey, payload) {
  scanCache.set(cacheKey, {
    cachedAt: Date.now(),
    payload
  });

  if (scanCache.size > 80) {
    const oldestKey = scanCache.keys().next().value;
    scanCache.delete(oldestKey);
  }
}

function scheduleActiveScanRefresh(payload, options) {
  if (!isSupabaseConfigured() || !payload?.rows?.length) return;
  if (!["us", "india"].includes(options.market)) return;
  const symbols = payload.rows.map((row) => row.symbol).filter(Boolean);
  if (!symbols.length) return;
  const key = `scan:${options.market}:${symbols.join(",")}:${normalizeTopSortBy(options.sortBy)}:${options.sortDirection}`;
  scheduleActiveRefresh(key, () => refreshActiveScanRows(payload.rows, options));
}

function scheduleActiveTopRefresh(payload, options) {
  if (!isSupabaseConfigured() || !payload?.rows?.length) return;
  if (!["top-us", "top-india", "top-crypto"].includes(options.market)) return;
  if (options.market === "top-us" && payload.rows.some((row) => row.market === "us")) {
    scheduleActiveScanRefresh({ ...payload, market: "us" }, {
      market: "us",
      page: 1,
      perPage: payload.rows.length,
      query: options.query,
      sector: options.sector,
      sortBy: options.sortBy,
      sortDirection: options.sortDirection,
      universe: []
    });
    return;
  }
  const symbols = payload.rows.map((row) => row.symbol).filter(Boolean);
  if (!symbols.length) return;
  const key = `top:${options.market}:${symbols.join(",")}:${normalizeTopSortBy(options.sortBy)}:${options.sortDirection}`;
  scheduleActiveRefresh(key, () => refreshActiveTopRows(payload.rows, options));
}

function scheduleActiveRefresh(key, refreshFn) {
  const existing = activePageRefreshes.get(key);
  if (existing?.running) return;
  if (existing?.lastStartedAt && Date.now() - existing.lastStartedAt < ACTIVE_PAGE_REFRESH_MS) return;

  activePageRefreshes.set(key, {
    running: true,
    lastStartedAt: Date.now()
  });

  setTimeout(async () => {
    try {
      await refreshFn();
    } catch (error) {
      console.warn(`Active page refresh failed: ${error.message}`);
    } finally {
      activePageRefreshes.set(key, {
        running: false,
        lastStartedAt: Date.now()
      });
    }
  }, 0);
}

async function refreshActiveScanRows(rows, options) {
  const config = marketConfig[options.market];
  if (!config?.quoteProvider) return;
  const universeRows = activeUniverseRows(rows, options.universe);
  if (!universeRows.length) return;

  let quotes = await config.quoteProvider(universeRows);
  if (options.market === "us" && isTrueOvernightSort(options.sortBy)) {
    quotes = await enrichUsOvernightRows(quotes);
  }

  const now = new Date().toISOString();
  const startRank = (Number(options.page || 1) - 1) * Number(options.perPage || DEFAULT_PAGE_SIZE);
  const quoteUniverse = universeRows;
  const refreshedRows = quotes
    .filter((quote) => Number.isFinite(quote.price) && Number.isFinite(quote.changePercent))
    .map((quote, index) => scanRowFromQuote({
      market: options.market,
      quote,
      quoteUniverse,
      config,
      now,
      signalRank: startRank + index + 1
    }));

  if (refreshedRows.length) {
    await storeSignalsOrThrow(refreshedRows);
    clearScanCacheForMarket(options.market);
  }
}

async function refreshActiveTopRows(rows, options) {
  const normalizedMarket = normalizeTopMarket(options.market);
  const metric = normalizedMarket === "top-crypto" ? "changePercent" : normalizeTopSortBy(options.sortBy || "changePercent");
  const now = new Date().toISOString();
  let refreshedRows = [];

  if (normalizedMarket === "top-crypto") {
    const universe = await loadUniverse("crypto-symbols.json").catch(() => []);
    const activeUniverse = rows
      .map((row) => findCryptoUniverseRow(universe, row.symbol) || { symbol: row.symbol, name: row.name, sector: row.sector, type: row.type })
      .filter(Boolean);
    const quotes = await fetchHyperliquidCrypto(activeUniverse);
    refreshedRows = quotes.map((quote, index) => topCryptoRowFromQuote(quote, index, now));
  } else {
    const universeFile = normalizedMarket === "top-india" ? "india-symbols.json" : "us-symbols.json";
    const universe = await loadUniverse(universeFile).catch(() => []);
    const activeUniverse = activeUniverseRows(rows, universe);
    if (!activeUniverse.length) return;

    let quotes = normalizedMarket === "top-india"
      ? await fetchIndiaQuotes(activeUniverse)
      : await fetchYahooQuotes(activeUniverse);
    if (normalizedMarket === "top-us" && isTrueOvernightSort(metric)) {
      quotes = await enrichUsOvernightRows(quotes);
    }

    const session = {
      phase: "Active page refresh",
      metric,
      metricLabel: normalizedMarket === "top-india" ? "Current change %" : topMetricLabel(metric)
    };
    refreshedRows = quotes
      .filter((quote) => Number.isFinite(Number(quote.changePercent)))
      .map((quote, index) => topYahooRow({
        quote,
        index,
        market: normalizedMarket,
        exchangeFallback: normalizedMarket === "top-india" ? "NSE" : "US",
        fallbackSector: normalizedMarket === "top-india" ? "Other Indian Stocks" : "Other US Stocks",
        session,
        now
      }));
  }

  if (refreshedRows.length) {
    await storeSignalsOrThrow(refreshedRows);
    topMarketCache.delete(topMarketRuntimeCacheKey(normalizedMarket, metric, options.sortDirection));
  }
}

function activeUniverseRows(rows, universe) {
  const bySymbol = new Map(universe.map((item) => [String(item.symbol || "").toUpperCase(), item]));
  return rows
    .map((row) => {
      const symbol = String(row.symbol || "").toUpperCase();
      return bySymbol.get(symbol) || (symbol ? { symbol: row.symbol, name: row.name, sector: row.sector, type: row.type } : null);
    })
    .filter(Boolean);
}

function scanRowFromQuote({ market, quote, quoteUniverse, config, now, signalRank }) {
  const closePrice = closePriceForQuote(quote);
  return {
    market,
    symbol: quote.symbol,
    name: quote.name || quote.symbol,
    exchange: quote.exchange || market.toUpperCase(),
    sector: quote.sector || findUniverseValue(quoteUniverse, quote.symbol, "sector") || null,
    type: quote.type || findUniverseValue(quoteUniverse, quote.symbol, "type") || null,
    detailUrl: quote.detailUrl || detailUrlForQuote(market, quote),
    price: round(quote.price, 6),
    closePrice: nullableRound(closePrice, 6),
    preMarketPrice: nullableRound(quote.preMarketPrice, 6),
    postMarketPrice: nullableRound(quote.postMarketPrice, 6),
    overnightPrice: nullableRound(quote.overnightPrice, 6),
    changeAmount: round(quote.changeAmount || 0, 6),
    changePercent: round(quote.changePercent, 4),
    closeChangePercent: nullableRound(quote.closeChangePercent ?? quote.changePercent, 4),
    preMarketChangePercent: nullableRound(preMarketPercentForQuote(quote, closePrice), 4),
    postMarketChangePercent: nullableRound(quote.postMarketChangePercent, 4),
    overnightChangeAmount: nullableRound(quote.overnightChangeAmount, 6),
    overnightChangePercent: nullableRound(quote.overnightChangePercent, 4),
    activeChangePercent: null,
    volume: quote.volume || 0,
    signalRank,
    source: quote.source || config.source,
    scannedAt: now,
    raw: {
      ...(quote.raw || {}),
      previousClose: quote.raw?.previousClose ?? closePrice ?? null
    }
  };
}

function clearScanCacheForMarket(market) {
  for (const key of scanCache.keys()) {
    if (String(key).startsWith(`${market}|`)) scanCache.delete(key);
  }
}

async function handleChart(url, res) {
  const symbol = (url.searchParams.get("symbol") || "").trim();
  const market = (url.searchParams.get("market") || "").toLowerCase();
  const range = url.searchParams.get("range") || "1d";
  const interval = url.searchParams.get("interval") || "1m";

  if (!symbol) {
    sendJson(res, { error: "Missing symbol." }, 400);
    return;
  }

  const payload = market === "crypto" || market === "top-crypto"
    ? await fetchHyperliquidHistoricalChart(symbol, { range, interval })
    : await fetchYahooHistoricalChart(symbol, { range, interval });
  sendJson(res, payload);
}

async function handleEarningsCalendar(url, res) {
  const year = clamp(Number(url.searchParams.get("year") || new Date().getFullYear()), 2000, 2100);
  const quarter = normalizeEarningsQuarter(url.searchParams.get("quarter") || "all");
  const page = clamp(Number(url.searchParams.get("page") || 1), 1, 1_000_000);
  const perPage = clamp(Number(url.searchParams.get("perPage") || DEFAULT_PAGE_SIZE), 1, MAX_PAGE_SIZE);
  const query = (url.searchParams.get("query") || "").trim().toLowerCase();
  const reportDate = normalizeDateParam(url.searchParams.get("date") || "");
  const sortBy = normalizeEarningsSortBy(url.searchParams.get("sortBy") || "reportDate");
  const direction = url.searchParams.get("direction") === "desc" ? "desc" : "asc";
  const startedAt = new Date();
  const payload = await buildEarningsCalendarPayload(year, quarter, reportDate);
  const dateFiltered = reportDate
    ? payload.rows.filter((row) => row.reportDate === reportDate)
    : payload.rows;
  const filtered = query
    ? dateFiltered.filter((row) =>
      [row.symbol, row.name, row.fiscalQuarterEnding, row.reportDate, row.callTime].some((value) =>
        String(value || "").toLowerCase().includes(query)
      )
    )
    : dateFiltered;
  const sorted = filtered.sort((a, b) => compareEarningsRows(a, b, sortBy, direction));
  const rows = paginate(sorted, page, perPage).map((row, index) => ({
    ...row,
    signalRank: (page - 1) * perPage + index + 1
  }));

  sendJson(res, {
    market: "earnings",
    title: `Earnings Calendar ${year}`,
    source: payload.source || "Nasdaq",
    scannedAt: startedAt.toISOString(),
    count: rows.length,
    total: filtered.length,
    page,
    perPage,
    totalPages: Math.max(1, Math.ceil(filtered.length / perPage)),
    universeTotal: payload.rows.length,
    sectors: ["Q1", "Q2", "Q3", "Q4"],
    sector: quarter === "all" ? "" : quarter,
    reportDate,
    activeMetric: sortBy,
    activeMetricLabel: earningsMetricLabel(sortBy),
    storage: {
      enabled: false,
      source: payload.cacheHit ? "In-memory cache" : "Live calendar"
    },
    rows
  });
}

async function handleMarketWatch(url, res) {
  const startedAt = new Date();
  const payload = await buildMarketWatchPayload();
  const rows = payload.rows.map((row, index) => ({
    ...row,
    signalRank: index + 1
  }));

  sendJson(res, {
    market: "market-watch",
    title: "Market Watch",
    source: payload.source,
    scannedAt: startedAt.toISOString(),
    count: rows.length,
    total: rows.length,
    page: 1,
    perPage: rows.length,
    totalPages: 1,
    universeTotal: payload.rows.length,
    sectors: [],
    sector: "",
    activeMetric: "publishedAt",
    activeMetricLabel: "Newest headlines",
    storage: {
      enabled: false,
      source: payload.cacheHit ? "Rolling 7-day cache" : "Live RSS"
    },
    rows
  });
}

async function buildTopMarketPayload(topMarket, options = {}) {
  const startedAt = new Date();
  const result = await scanTopMarket(topMarket, options);
  if (result.market === "top-us" && !result.rows.length && result.candidateCount) {
    throw new Error("Top US full-universe scan returned no rows.");
  }
  const storage = await storeSignals(result.storageRows || result.rows);

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

  topMarketCache.set(options.cacheKey || result.market, {
    cachedAt: Date.now(),
    payload,
    refreshing: null
  });

  return payload;
}

function filterTopMarketPayload(payload, options = {}) {
  const sector = normalizeSector(options.sector);
  const query = String(options.query || "").trim();
  const sortBy = payload.market === "top-crypto" ? "changePercent" : normalizeTopSortBy(options.sortBy);
  const sortDirection = payload.market === "top-crypto"
    ? "desc"
    : options.sortDirection === "desc" ? "desc" : "asc";
  const metricLabel = payload.market === "top-crypto" && sortBy === "changePercent"
    ? "24h change %"
    : topMetricLabel(sortBy);
  const activeMetric = percentMetricFor(sortBy);
  const sectorFilteredRows = sector
    ? payload.rows.filter((row) => normalizeSector(row.sector) === sector)
    : payload.rows;
  const filteredRows = filterStoredRows(sectorFilteredRows, query);
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
    query,
    activeMetric: sortBy,
    activeMetricLabel: metricLabel,
    marketPhase: "Selected filter",
    rows,
    count: rows.length,
    total: sortedRows.length
  };
}

async function buildMarketWatchPayload() {
  if (marketWatchCache && Date.now() - marketWatchCache.cachedAt < MARKET_WATCH_CACHE_MS) {
    return { ...marketWatchCache.payload, cacheHit: true };
  }

  const feedSources = [
    {
      source: "MarketWatch",
      url: "https://feeds.marketwatch.com/marketwatch/topstories/"
    },
    {
      source: "MarketWatch",
      url: "https://feeds.content.dowjones.io/public/rss/mw_marketpulse"
    },
    {
      source: "CNN",
      url: "http://rss.cnn.com/rss/money_markets.rss"
    },
    {
      source: "BBC",
      url: "https://feeds.bbci.co.uk/news/business/rss.xml"
    }
  ];
  const feedResults = await Promise.all(feedSources.map(async (feed) => {
    try {
      const xml = await fetchText(feed.url, {
        "Accept": "application/rss+xml,application/xml,text/xml",
        "User-Agent": "Mozilla/5.0 StockScreenerApp/1.0"
      });
      return parseRssItems(xml, feed.source);
    } catch (error) {
      console.warn(`Market Watch feed failed for ${feed.source}: ${error.message}`);
      return [];
    }
  }));
  const freshRows = dedupeMarketWatchRows(feedResults.flat())
    .map((item) => enrichMarketWatchItem(item))
    .filter((row) => isWithinMarketWatchWindow(row.publishedAt));
  mergeMarketWatchHistory(freshRows);
  const rows = [...marketWatchHistory.values()]
    .sort((a, b) => compareMarketWatchRows(a, b, "publishedAt", "desc"));
  const payload = {
    source: "MarketWatch, CNN, BBC",
    rows
  };
  marketWatchCache = {
    cachedAt: Date.now(),
    payload
  };
  return { ...payload, cacheHit: false };
}

function mergeMarketWatchHistory(rows) {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [key, row] of marketWatchHistory.entries()) {
    const published = Date.parse(row.publishedAt || "");
    if (!Number.isFinite(published) || published < cutoff) {
      marketWatchHistory.delete(key);
    }
  }

  for (const row of rows) {
    const key = `${row.source}:${row.title}`.toLowerCase();
    marketWatchHistory.set(key, row);
  }
}

function isWithinMarketWatchWindow(value) {
  const published = Date.parse(value || "");
  if (!Number.isFinite(published)) return true;
  return published >= Date.now() - 7 * 24 * 60 * 60 * 1000;
}

function parseRssItems(xml, source) {
  const itemMatches = [...String(xml || "").matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
  return itemMatches.map((match) => {
    const itemXml = match[1];
    const title = cleanFeedText(xmlTagValue(itemXml, "title"));
    const description = cleanFeedText(xmlTagValue(itemXml, "description"));
    const link = cleanFeedText(xmlTagValue(itemXml, "link"));
    const publishedAt = normalizeFeedDate(xmlTagValue(itemXml, "pubDate") || xmlTagValue(itemXml, "dc:date"));
    const imageUrl = rssImageUrl(itemXml);
    return {
      market: "market-watch",
      source,
      symbol: source,
      name: title,
      title,
      summary: summarizeHeadline(title, description),
      description,
      link,
      detailUrl: link,
      imageUrl,
      publishedAt
    };
  }).filter((item) => item.title && item.link);
}

function rssImageUrl(itemXml) {
  const content = String(itemXml || "");
  const media = content.match(/<media:content\b[^>]*\burl=["']([^"']+)["']/i)
    || content.match(/<media:thumbnail\b[^>]*\burl=["']([^"']+)["']/i)
    || content.match(/<enclosure\b[^>]*\burl=["']([^"']+)["'][^>]*(?:type=["']image\/[^"']+["'])?/i);
  return media ? cleanFeedText(media[1]) : "";
}

function enrichMarketWatchItem(item) {
  const analysis = macroFactorForText(`${item.title} ${item.description}`);
  const id = `${item.source}-${hashText(item.title)}`;
  return {
    ...item,
    id,
    symbol: id,
    factor: analysis.factor,
    impact: analysis.impact,
    impactScore: analysis.score,
    reason: analysis.reason,
    scannedAt: new Date().toISOString(),
    raw: {
      source: item.source
    }
  };
}

function hashText(value) {
  let hash = 0;
  for (const char of String(value || "")) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function macroFactorForText(text) {
  const normalized = String(text || "").toLowerCase();
  const rules = [
    {
      factor: "Rates & Fed",
      impact: "Policy-sensitive",
      score: 3,
      reason: "Interest-rate and central-bank expectations can move equity valuations, growth stocks, banks, bonds, and the dollar.",
      patterns: ["fed", "federal reserve", "central bank", "rate cut", "rate hike", "interest rate", "treasury yield", "bond yield", "powell"]
    },
    {
      factor: "Inflation",
      impact: "Valuation risk",
      score: 3,
      reason: "Inflation changes discount-rate expectations and can pressure margins, consumers, and rate-sensitive sectors.",
      patterns: ["inflation", "cpi", "ppi", "prices", "price growth", "deflation", "disinflation"]
    },
    {
      factor: "Growth & GDP",
      impact: "Demand signal",
      score: 2,
      reason: "Growth, GDP, jobs, and consumer data shape earnings expectations and cyclical sector performance.",
      patterns: ["gdp", "growth", "recession", "slowdown", "jobs", "payroll", "unemployment", "consumer spending", "retail sales", "manufacturing", "services"]
    },
    {
      factor: "Trade & Geopolitics",
      impact: "Risk-off catalyst",
      score: 3,
      reason: "Trade policy, tariffs, wars, and sanctions can affect supply chains, commodities, currencies, and investor risk appetite.",
      patterns: ["tariff", "trade war", "sanction", "war", "conflict", "geopolitical", "china", "russia", "ukraine", "middle east", "iran"]
    },
    {
      factor: "Energy & Commodities",
      impact: "Input-cost driver",
      score: 2,
      reason: "Oil, gas, metals, and commodity moves can shift inflation, margins, and sector leadership.",
      patterns: ["oil", "crude", "gas", "energy", "opec", "gold", "copper", "commodity", "commodities"]
    },
    {
      factor: "Currency & Dollar",
      impact: "FX translation",
      score: 2,
      reason: "Dollar and currency moves affect multinational revenue, commodities, emerging markets, and risk appetite.",
      patterns: ["dollar", "currency", "forex", "yen", "euro", "pound", "fx"]
    },
    {
      factor: "Credit & Banks",
      impact: "Financial stress",
      score: 3,
      reason: "Banking, credit, and debt stress can tighten financial conditions and weigh on broader equity risk.",
      patterns: ["bank", "credit", "debt", "default", "loan", "mortgage", "commercial real estate", "financial stability"]
    },
    {
      factor: "Earnings & Guidance",
      impact: "Profit expectations",
      score: 2,
      reason: "Earnings and guidance headlines can reset market expectations for margins and sector leadership.",
      patterns: ["earnings", "profit", "guidance", "revenue", "margin", "outlook"]
    }
  ];
  const matched = rules.find((rule) => rule.patterns.some((pattern) => normalized.includes(pattern)));
  return matched || {
    factor: "Market Sentiment",
    impact: "Broad risk tone",
    score: 1,
    reason: "This headline may affect investor sentiment, liquidity, or sector rotation even without a specific macro category."
  };
}

function summarizeHeadline(title, description) {
  const cleanedDescription = cleanFeedText(description);
  if (cleanedDescription) return truncateText(cleanedDescription, 220);
  const cleanedTitle = cleanFeedText(title);
  return truncateText(`Macro relevance: ${cleanedTitle}`, 220);
}

function dedupeMarketWatchRows(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.source}:${row.title}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeMarketWatchSortBy(sortBy) {
  const allowed = new Set(["publishedAt", "source", "factor", "impactScore"]);
  return allowed.has(sortBy) ? sortBy : "publishedAt";
}

function marketWatchMetricLabel(sortBy) {
  return {
    publishedAt: "Published",
    source: "Source",
    factor: "Macro factor",
    impactScore: "Impact"
  }[sortBy] || "Published";
}

function compareMarketWatchRows(a, b, field, direction) {
  const multiplier = direction === "asc" ? 1 : -1;
  if (field === "publishedAt") {
    const aTime = Date.parse(a.publishedAt || "");
    const bTime = Date.parse(b.publishedAt || "");
    const aFinite = Number.isFinite(aTime);
    const bFinite = Number.isFinite(bTime);
    if (!aFinite && !bFinite) return String(a.title).localeCompare(String(b.title));
    if (!aFinite) return 1;
    if (!bFinite) return -1;
    if (aTime !== bTime) return (aTime - bTime) * multiplier;
    return String(a.title).localeCompare(String(b.title));
  }
  if (field === "impactScore") {
    const compared = (Number(a.impactScore || 0) - Number(b.impactScore || 0)) * multiplier;
    return compared || String(a.title).localeCompare(String(b.title));
  }
  const compared = String(a[field] || "").localeCompare(String(b[field] || ""));
  return compared === 0 ? String(a.title).localeCompare(String(b.title)) : compared * multiplier;
}

function xmlTagValue(xml, tagName) {
  const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(xml || "").match(new RegExp(`<${escapedTag}[^>]*>([\\s\\S]*?)<\\/${escapedTag}>`, "i"));
  return match ? stripCdata(match[1]) : "";
}

function stripCdata(value) {
  return String(value || "").replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function cleanFeedText(value) {
  return decodeHtmlEntities(String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim());
}

function normalizeFeedDate(value) {
  const date = new Date(cleanFeedText(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function truncateText(value, maxLength) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}...`;
}

async function fetchText(url, headers = {}) {
  const response = await fetch(url, {
    headers,
    signal: timeoutSignal(YAHOO_FETCH_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`GET ${url} returned ${response.status}`);
  }
  return response.text();
}

async function buildEarningsCalendarPayload(year, quarter, reportDate = "") {
  const cacheKey = `${year}:${quarter}:${reportDate || "all"}`;
  const cached = earningsCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < EARNINGS_CACHE_MS) {
    return { ...cached.payload, cacheHit: true };
  }

  const ranges = reportDate
    ? [{ from: reportDate, to: reportDate }]
    : quarter === "all"
    ? [1, 2, 3, 4].map((item) => quarterDateRange(year, `Q${item}`))
    : [quarterDateRange(year, quarter)];
  const dates = ranges.flatMap(({ from, to }) => datesBetween(from, to));
  let source = "Nasdaq";
  let rows = await fetchNasdaqEarningsDates(dates);
  if (!rows.length) {
    rows = await fetchStockAnalysisEarningsCalendar(year, quarter, reportDate);
    source = "StockAnalysis";
  }
  const uniqueRows = dedupeEarningsRows(rows)
    .sort((a, b) => compareEarningsRows(a, b, "reportDate", "asc"));
  const payload = { rows: uniqueRows, source };
  earningsCache.set(cacheKey, {
    cachedAt: Date.now(),
    payload
  });
  return { ...payload, cacheHit: false };
}

async function fetchNasdaqEarningsDates(dates) {
  const rows = [];
  let cursor = 0;
  let blocked = false;
  const concurrency = Math.min(EARNINGS_FETCH_CONCURRENCY, Math.max(1, dates.length));

  async function worker() {
    while (cursor < dates.length && !blocked) {
      const date = dates[cursor];
      cursor += 1;
      try {
        rows.push(...await fetchNasdaqEarningsDate(date));
      } catch (error) {
        if (String(error.message).includes("403")) {
          blocked = true;
          return;
        }
        console.warn(`Skipping earnings date ${date}: ${error.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return rows;
}

async function fetchNasdaqEarningsDate(date) {
  const endpoint = `https://api.nasdaq.com/api/calendar/earnings?date=${encodeURIComponent(date)}`;
  const response = await fetch(endpoint, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 StockScreenerApp/1.0",
      "Origin": "https://www.nasdaq.com",
      "Referer": "https://www.nasdaq.com/"
    },
    signal: timeoutSignal(YAHOO_FETCH_TIMEOUT_MS)
  });

  if (!response.ok) {
    throw new Error(`Nasdaq earnings returned ${response.status}`);
  }

  const payload = await response.json();
  const rows = payload?.data?.rows || [];
  return rows
    .map((row) => earningsRowFromNasdaq(row, date))
    .filter((row) => row.symbol);
}

async function fetchStockAnalysisEarningsCalendar(year, quarter, reportDate = "") {
  const html = await httpsGetText("https://stockanalysis.com/stocks/earnings-calendar/", {
    "Accept": "text/html,application/xhtml+xml",
    "User-Agent": "Mozilla/5.0 StockScreenerApp/1.0"
  });
  const rows = [];
  const dayPattern = /date:"(\d{4}-\d{2}-\d{2})",day:"([^"]+)",symbols:\[(.*?)\],count:/gs;
  let dayMatch;
  while ((dayMatch = dayPattern.exec(html))) {
    const scheduledDate = dayMatch[1];
    if (reportDate && scheduledDate !== reportDate) continue;
    if (!scheduledDate.startsWith(`${year}-`)) continue;
    const scheduledQuarter = earningsQuarterFromDate(scheduledDate);
    if (quarter !== "all" && scheduledQuarter !== quarter) continue;

    const symbolsBlock = dayMatch[3];
    const symbolPattern = /\{s:"([^"]+)",n:"([^"]+)",t:([^,}]+),e:([^,}]+),eg:([^,}]+),r:([^,}]+),rg:([^,}]+),m:([^}]+)\}/g;
    let symbolMatch;
    while ((symbolMatch = symbolPattern.exec(symbolsBlock))) {
      const symbol = decodeJsString(symbolMatch[1]);
      const name = decodeJsString(symbolMatch[2]);
      const callTime = stockAnalysisCallTime(symbolMatch[3]);
      const epsEstimate = parseJsValue(symbolMatch[4]);
      const revenueEstimate = parseJsValue(symbolMatch[6]);
      const revenueGrowth = parseJsValue(symbolMatch[7]);
      const marketCap = parseJsValue(symbolMatch[8]);
      rows.push({
        market: "earnings",
        symbol,
        name,
        reportDate: scheduledDate,
        quarter: scheduledQuarter,
        fiscalQuarterEnding: "",
        callTime,
        epsForecast: formatNullableNumber(epsEstimate),
        epsActual: "",
        surprisePercent: "",
        marketCap: formatMarketCap(marketCap),
        marketCapValue: numberOrNull(marketCap),
        noOfEsts: "",
        lastYearReportDate: "",
        revenueEstimate: formatMarketCap(revenueEstimate),
        revenueGrowth: formatNullablePercent(revenueGrowth),
        detailUrl: symbol ? yahooDetailUrl(symbol) : null,
        source: "StockAnalysis",
        raw: {
          revenueEstimate,
          revenueGrowth,
          source: "stockanalysis"
        }
      });
    }
  }
  return rows;
}

function earningsRowFromNasdaq(row, reportDate) {
  const fiscalQuarterEnding = cleanCalendarValue(row.fiscalQuarterEnding);
  return {
    market: "earnings",
    symbol: cleanCalendarValue(row.symbol),
    name: cleanCalendarValue(row.name),
    reportDate,
    quarter: earningsQuarterFromDate(reportDate),
    fiscalQuarterEnding,
    callTime: normalizeEarningsTime(row.time),
    epsForecast: cleanCalendarValue(row.epsForecast),
    epsActual: cleanCalendarValue(row.lastYearEPS),
    surprisePercent: cleanCalendarValue(row.epsSurprise || row.epssurprisepct),
    marketCap: cleanCalendarValue(row.marketCap),
    marketCapValue: parseMarketCap(row.marketCap),
    noOfEsts: cleanCalendarValue(row.noOfEsts),
    lastYearReportDate: cleanCalendarValue(row.lastYearRptDt),
    detailUrl: row.symbol ? yahooDetailUrl(row.symbol) : null,
    source: "Nasdaq",
    raw: row
  };
}

function dedupeEarningsRows(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.reportDate}:${row.symbol}:${row.fiscalQuarterEnding}:${row.callTime}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function quarterDateRange(year, quarter) {
  const ranges = {
    Q1: [`${year}-01-01`, `${year}-03-31`],
    Q2: [`${year}-04-01`, `${year}-06-30`],
    Q3: [`${year}-07-01`, `${year}-09-30`],
    Q4: [`${year}-10-01`, `${year}-12-31`]
  };
  const [from, to] = ranges[quarter] || ranges.Q1;
  return { from, to };
}

function datesBetween(from, to) {
  const dates = [];
  const current = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function normalizeEarningsQuarter(value) {
  const normalized = String(value || "").toUpperCase();
  return ["Q1", "Q2", "Q3", "Q4"].includes(normalized) ? normalized : "all";
}

function normalizeDateParam(value) {
  const normalized = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : "";
}

function normalizeEarningsSortBy(sortBy) {
  const allowed = new Set(["reportDate", "symbol", "name", "quarter", "marketCapValue"]);
  return allowed.has(sortBy) ? sortBy : "reportDate";
}

function earningsMetricLabel(sortBy) {
  return {
    reportDate: "Report date",
    symbol: "Symbol",
    name: "Company",
    quarter: "Quarter",
    marketCapValue: "Market cap"
  }[sortBy] || "Report date";
}

function compareEarningsRows(a, b, field, direction) {
  const multiplier = direction === "desc" ? -1 : 1;
  const aValue = field === "marketCapValue" ? numberOrNull(a[field]) : a[field];
  const bValue = field === "marketCapValue" ? numberOrNull(b[field]) : b[field];
  if (field === "marketCapValue") {
    const aFinite = Number.isFinite(Number(aValue));
    const bFinite = Number.isFinite(Number(bValue));
    if (!aFinite && !bFinite) return String(a.symbol).localeCompare(String(b.symbol));
    if (!aFinite) return 1;
    if (!bFinite) return -1;
    if (Number(aValue) !== Number(bValue)) return (Number(aValue) - Number(bValue)) * multiplier;
    return String(a.symbol).localeCompare(String(b.symbol));
  }
  const compared = String(aValue || "").localeCompare(String(bValue || ""));
  return compared === 0 ? String(a.symbol).localeCompare(String(b.symbol)) : compared * multiplier;
}

function earningsQuarterFromDate(date) {
  const month = Number(String(date).slice(5, 7));
  if (month >= 1 && month <= 3) return "Q1";
  if (month >= 4 && month <= 6) return "Q2";
  if (month >= 7 && month <= 9) return "Q3";
  if (month >= 10 && month <= 12) return "Q4";
  return "";
}

function earningsQuarterFromFiscal(value) {
  const match = String(value || "").match(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\/(\d{4})/i);
  if (!match) return "";
  const monthName = String(value).slice(0, 3).toLowerCase();
  const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(monthName) + 1;
  return earningsQuarterFromDate(`${match[1]}-${String(month).padStart(2, "0")}-01`);
}

function normalizeEarningsTime(value) {
  const cleaned = cleanCalendarValue(value);
  return {
    "time-not-supplied": "TAS",
    "before-market": "BMO",
    "after-market": "AMC",
    "during-market": "DMH"
  }[cleaned] || cleaned;
}

function stockAnalysisCallTime(value) {
  const normalized = String(parseJsValue(value) || "").toLowerCase();
  return {
    bmo: "BMO",
    amc: "AMC",
    dmh: "DMH",
    tas: "TAS"
  }[normalized] || (normalized ? normalized.toUpperCase() : "TAS");
}

function parseJsValue(value) {
  const raw = String(value || "").trim();
  if (raw === "null" || raw === "undefined" || raw === "") return null;
  if (raw.startsWith("\"") && raw.endsWith("\"")) return decodeJsString(raw.slice(1, -1));
  const number = Number(raw);
  return Number.isFinite(number) ? number : raw;
}

function decodeJsString(value) {
  return decodeHtmlEntities(String(value || "")
    .replace(/\\"/g, "\"")
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))));
}

function formatNullableNumber(value) {
  const number = numberOrNull(value);
  if (number === null) return "";
  return number < 0 ? `(${serverFormatNumber(Math.abs(number))})` : serverFormatNumber(number);
}

function formatNullablePercent(value) {
  const number = numberOrNull(value);
  return number === null ? "" : `${serverFormatSigned(number)}%`;
}

function formatMarketCap(value) {
  const number = numberOrNull(value);
  if (number === null) return "";
  if (Math.abs(number) >= 1e12) return `${serverFormatNumber(number / 1e12)}T`;
  if (Math.abs(number) >= 1e9) return `${serverFormatNumber(number / 1e9)}B`;
  if (Math.abs(number) >= 1e6) return `${serverFormatNumber(number / 1e6)}M`;
  if (Math.abs(number) >= 1e3) return `${serverFormatNumber(number / 1e3)}K`;
  return serverFormatNumber(number);
}

function serverFormatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: Math.abs(number) < 10 ? 2 : 1
  }).format(number);
}

function serverFormatSigned(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return `${number > 0 ? "+" : ""}${serverFormatNumber(number)}`;
}

function cleanCalendarValue(value) {
  const cleaned = decodeHtmlEntities(String(value ?? "")).replace(/\s+/g, " ").trim();
  return !cleaned || cleaned === "N/A" ? "" : cleaned;
}

function parseMarketCap(value) {
  const cleaned = String(value || "").replace(/[$,\s]/g, "");
  const match = cleaned.match(/^(-?\d+(?:\.\d+)?)([KMBT])?$/i);
  if (!match) return null;
  const number = Number(match[1]);
  const multiplier = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[String(match[2] || "").toUpperCase()] || 1;
  return Number.isFinite(number) ? number * multiplier : null;
}

function refreshTopMarketCache(topMarket, options = {}) {
  const cacheKey = options.cacheKey || topMarketRuntimeCacheKey(topMarket, options.sortBy || "changePercent", options.sortDirection || "asc");
  const cached = topMarketCache.get(cacheKey);
  if (cached?.refreshing) return cached.refreshing;

  const refreshing = buildTopMarketPayload(topMarket, { ...options, cacheKey })
    .catch((error) => {
      console.warn(`Top market cache refresh failed for ${topMarket}: ${error.message}`);
    })
    .finally(() => {
      const latest = topMarketCache.get(cacheKey);
      if (latest) latest.refreshing = null;
    });

  if (cached) {
    cached.refreshing = refreshing;
  } else {
    topMarketCache.set(cacheKey, {
      cachedAt: 0,
      payload: null,
      refreshing
    });
  }
  return refreshing;
}

function startBackgroundRefresh() {
  if (!isSupabaseConfigured()) {
    console.warn("Background price refresh disabled; Supabase env vars are not configured.");
    return;
  }

  if (DATA_REFRESH_MS <= 0) {
    console.warn("Background price refresh disabled; DATA_REFRESH_MS is not positive.");
    return;
  }

  setTimeout(refreshAllSignalSnapshots, 10_000);
  setInterval(refreshAllSignalSnapshots, DATA_REFRESH_MS);
}

async function refreshAllSignalSnapshots() {
  if (backgroundRefreshState.running) return;

  backgroundRefreshState.running = true;
  backgroundRefreshState.lastStartedAt = new Date().toISOString();
  backgroundRefreshState.lastError = null;
  const errors = [];

  const topMarketsToRefresh = ["top-india", "top-crypto"];
  for (const market of topMarketsToRefresh) {
    try {
      await buildTopMarketPayload(market);
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

async function scanTopMarket(topMarket, options = {}) {
  if (topMarket === "top-india") return scanTopYahooUniverse({
    market: "top-india",
    title: "Top Indian Stocks",
    universeFile: "india-symbols.json",
    exchangeFallback: "NSE"
  });

  if (topMarket === "top-crypto") return scanTopCrypto();

  return scanTopUsStocks(options);
}

function normalizeTopMarket(topMarket) {
  if (topMarket === "top-india" || topMarket === "top-crypto" || topMarket === "top-us") {
    return topMarket;
  }

  return "top-us";
}

function topMarketTitle(topMarket) {
  return {
    "top-us": "Top US Stocks",
    "top-india": "Top Indian Stocks",
    "top-crypto": "Top Crypto"
  }[topMarket] || "Top US Stocks";
}

function topMarketSource(topMarket) {
  return {
    "top-us": "Yahoo Finance",
    "top-india": "Yahoo Finance",
    "top-crypto": "Hyperliquid"
  }[topMarket] || "Yahoo Finance";
}

function isTopUsStockUniverseRow(item) {
  const symbol = String(item?.symbol || "");
  const name = String(item?.name || "");
  const sector = String(item?.sector || "");
  const type = String(item?.type || item?.raw?.quoteType || "");
  if (/ETF|Fund/i.test(sector)) return false;
  if (!symbol || /\b(ETF|Fund)\b/i.test(type)) return false;
  if (/\$/.test(symbol)) return false;
  if (/(?:^|[-.])(W|WS|WT|R|RT|U)$/.test(symbol)) return false;
  if (/\b(ETF|fund|warrant|right|unit|preferred|preference|depositary share)\b/i.test(name)) return false;
  return true;
}

async function scanMarket(market, config, options) {
  const universe = options.universe || (config.universeFile ? await loadUniverse(config.universeFile) : []);
  const universeTotal = universe.length;
  const showFullCryptoUniverse = market === "crypto";
  const sectorFilteredUniverse = showFullCryptoUniverse ? universe : filterUniverseBySector(universe, options.sector);
  const filteredUniverse = showFullCryptoUniverse
    ? filterUniverse(sectorFilteredUniverse, options.query)
    : sectorFilteredUniverse.length ? filterUniverse(sectorFilteredUniverse, options.query) : [];
  const page = options.page;
  const perPage = options.perPage;
  let quoteUniverse = filteredUniverse;
  let quotes;
  let total;

  if (market === "us" && universe.length && !options.query && usesSparseUsSessionFilter(options.sortBy)) {
    return scanSparseUsSessionMarket(config, filteredUniverse, universeTotal, options);
  }

  if (universe.length) {
    total = filteredUniverse.length;
    if (showFullCryptoUniverse) {
      quoteUniverse = filteredUniverse;
      quotes = await config.quoteProvider(quoteUniverse);
    } else {
      const targetEnd = page * perPage;
      const validQuotes = [];
      const chunkSize = Math.max(perPage, MAX_PAGE_SIZE);
      let cursor = 0;

      while (validQuotes.length < targetEnd && cursor < filteredUniverse.length) {
        quoteUniverse = filteredUniverse.slice(cursor, cursor + chunkSize);
        cursor += chunkSize;

        let chunkQuotes = await config.quoteProvider(quoteUniverse);
        if (market === "india") {
          chunkQuotes = await enrichIndianPreOpen(chunkQuotes);
        }
        if (market === "us" && isTrueOvernightSort(options.sortBy)) {
          chunkQuotes = await enrichUsOvernightRows(chunkQuotes);
        }

        validQuotes.push(...filterScanMetricRows(
          chunkQuotes.filter((quote) => Number.isFinite(quote.price) && Number.isFinite(quote.changePercent)),
          market,
          options.sortBy
        ));

        if (!chunkQuotes.length && quoteUniverse.length < chunkSize) break;
      }

      quotes = validQuotes;
      quoteUniverse = filteredUniverse;
    }
  } else {
    const allQuotes = await config.quoteProvider(universe);
    const filteredQuotes = filterQuotes(allQuotes, options.query);
    total = filteredQuotes.length;
    quotes = showFullCryptoUniverse ? filteredQuotes : paginate(filteredQuotes, page, perPage);
    if (market === "us" && isTrueOvernightSort(options.sortBy)) {
      quotes = await enrichUsOvernightRows(quotes);
    }
  }

  const now = new Date().toISOString();
  const startRank = (page - 1) * perPage;
  const metricFilteredQuotes = filterScanMetricRows(
    quotes.filter((quote) => Number.isFinite(quote.price) && Number.isFinite(quote.changePercent)),
    market,
    options.sortBy
  );
  const totalRows = showFullCryptoUniverse ? metricFilteredQuotes.length : total;
  const totalPages = Math.max(1, Math.ceil(totalRows / perPage));

  const pageQuotes = metricFilteredQuotes
    .sort((a, b) => compareQuoteValues(a, b, options.sortBy, options.sortDirection));
  const pagedQuotes = showFullCryptoUniverse || (universe.length && market !== "crypto")
    ? paginate(pageQuotes, page, perPage)
    : pageQuotes;
  const rows = pagedQuotes
    .map((quote, index) => {
      const closePrice = closePriceForQuote(quote);
      return {
        market,
        symbol: quote.symbol,
        name: quote.name || quote.symbol,
        exchange: quote.exchange || market.toUpperCase(),
        sector: quote.sector || findUniverseValue(quoteUniverse, quote.symbol, "sector") || null,
        type: quote.type || findUniverseValue(quoteUniverse, quote.symbol, "type") || null,
        detailUrl: quote.detailUrl || detailUrlForQuote(market, quote),
        price: round(quote.price, 6),
        closePrice: nullableRound(closePrice, 6),
        preMarketPrice: nullableRound(quote.preMarketPrice, 6),
        postMarketPrice: nullableRound(quote.postMarketPrice, 6),
        overnightPrice: nullableRound(quote.overnightPrice, 6),
        changeAmount: round(quote.changeAmount || 0, 6),
        changePercent: round(quote.changePercent, 4),
        closeChangePercent: nullableRound(quote.closeChangePercent ?? quote.changePercent, 4),
        preMarketChangePercent: nullableRound(quote.preMarketChangePercent, 4),
        postMarketChangePercent: nullableRound(quote.postMarketChangePercent, 4),
        overnightChangeAmount: nullableRound(quote.overnightChangeAmount, 6),
        overnightChangePercent: nullableRound(quote.overnightChangePercent, 4),
        activeChangePercent: null,
        volume: quote.volume || 0,
        signalRank: startRank + index + 1,
        source: quote.source || config.source,
        scannedAt: now,
        raw: {
          ...(quote.raw || {}),
          previousClose: quote.raw?.previousClose ?? closePrice ?? null
        }
      };
    });

  return {
    rows,
    page,
    perPage,
    total: totalRows,
    totalPages,
    universeTotal,
    universeRows: sectorFilteredUniverse
  };
}

async function scanSparseUsSessionMarket(config, universe, universeTotal, options) {
  const targetStart = (options.page - 1) * options.perPage;
  const targetEnd = targetStart + options.perPage;
  const chunkSize = Math.max(options.perPage, MAX_PAGE_SIZE);
  const cacheKey = usSessionFilterCacheKey(options.sortBy, options.sector);
  const cached = usSessionFilterCache.get(cacheKey);
  const cacheAge = cached ? Date.now() - cached.cachedAt : Infinity;
  const cache = cached && cacheAge < US_SESSION_FILTER_CACHE_MS
    ? cached
    : { matches: [], cursor: 0, scanned: 0, cachedAt: Date.now() };

  while (cache.matches.length < targetEnd && cache.cursor < universe.length) {
    const quoteUniverse = universe.slice(cache.cursor, cache.cursor + chunkSize);
    cache.cursor += chunkSize;
    cache.scanned += quoteUniverse.length;

    let quotes = await config.quoteProvider(quoteUniverse);
    if (!quotes.length) break;
    if (isTrueOvernightSort(options.sortBy)) {
      quotes = await enrichUsOvernightRows(quotes);
    }

    const chunkMatches = filterScanMetricRows(
      quotes.filter((quote) => Number.isFinite(quote.price) && Number.isFinite(quote.changePercent)),
      "us",
      options.sortBy
    );
    cache.matches.push(...chunkMatches);
    cache.cachedAt = Date.now();
    if (cache.matches.length) usSessionFilterCache.set(cacheKey, cache);
  }

  if (!cache.matches.length) usSessionFilterCache.delete(cacheKey);

  const now = new Date().toISOString();
  const pageMatches = cache.matches
    .slice(targetStart, targetEnd)
    .sort((a, b) => compareQuoteValues(a, b, options.sortBy, options.sortDirection));

  const rows = pageMatches.map((quote, index) => ({
    market: "us",
    symbol: quote.symbol,
    name: quote.name || quote.symbol,
    exchange: quote.exchange || "US",
    sector: quote.sector || findUniverseValue(universe, quote.symbol, "sector") || null,
    type: quote.type || findUniverseValue(universe, quote.symbol, "type") || null,
    detailUrl: quote.detailUrl || detailUrlForQuote("us", quote),
    price: round(quote.price, 6),
    preMarketPrice: nullableRound(quote.preMarketPrice, 6),
    postMarketPrice: nullableRound(quote.postMarketPrice, 6),
    overnightPrice: nullableRound(quote.overnightPrice, 6),
    changeAmount: round(quote.changeAmount || 0, 6),
    changePercent: round(quote.changePercent, 4),
    preMarketChangePercent: nullableRound(quote.preMarketChangePercent, 4),
    postMarketChangePercent: nullableRound(quote.postMarketChangePercent, 4),
    overnightChangeAmount: nullableRound(quote.overnightChangeAmount, 6),
    overnightChangePercent: nullableRound(quote.overnightChangePercent, 4),
    activeChangePercent: null,
    volume: quote.volume || 0,
    signalRank: targetStart + index + 1,
    source: quote.source || config.source,
    scannedAt: now,
    raw: {
      ...(quote.raw || {}),
      sparseFilter: options.sortBy,
      sparseCacheAgeMs: cacheAge === Infinity ? 0 : cacheAge,
      sparseCacheHit: Boolean(cached && cacheAge < US_SESSION_FILTER_CACHE_MS),
      sparseScannedSymbols: cache.scanned
    }
  }));

  return {
    rows,
    page: options.page,
    perPage: options.perPage,
    total: universe.length,
    totalPages: Math.max(1, Math.ceil(universe.length / options.perPage)),
    universeTotal
  };
}

function calculateRSI(closes, period = 14) {
  if (closes.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + (avgGain / avgLoss)));
}

function calculateEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = (closes[i] - ema) * k + ema;
  }
  return ema;
}

async function scanTopUsStocks(options = {}) {
  const metric = normalizeTopSortBy(options.sortBy || "changePercent");
  const direction = options.sortDirection === "asc" ? "asc" : "desc";
  const activeSession = currentChangeSession();
  const session = {
    phase: activeSession.phase,
    metric: options.sortBy ? metric : activeSession.metric,
    metricLabel: options.sortBy ? topMetricLabel(metric) : activeSession.metricLabel
  };
  const universe = (await loadUniverse("us-symbols.json").catch(() => []))
    .filter(isTopUsStockUniverseRow);
  let quotes = await fetchYahooQuotes(universe);
  if (isTrueOvernightSort(metric) && !quotes.some((quote) => hasSortableValue(quote.overnightChangePercent))) {
    quotes = await enrichUsOvernightRows(quotes);
  }
  const now = new Date().toISOString();

  const rows = quotes
    .filter((quote) => Number.isFinite(Number(quote.changePercent)))
    .filter((quote) => filterScanMetricRows([quote], "us", metric).length)
    .map((quote, index) => topYahooRow({
      quote,
      index,
      market: "top-us",
      exchangeFallback: "US",
      fallbackSector: "Other US Stocks",
      session,
      now
    }));
  const finalRows = rows
    .filter((row) => hasSortableValue(row[session.metric]))
    .sort((a, b) => compareQuoteValues(a, b, session.metric, direction))
    .slice(0, TOP_LIST_SIZE)
    .map((row, index) => ({ ...row, signalRank: index + 1 }));

  return {
    rows: finalRows,
    storageRows: finalRows,
    candidateCount: universe.length,
    market: "top-us",
    title: "Top US Stocks",
    source: "Yahoo Finance",
    activeMetric: metric,
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
    title: "Top Indian Stocks",
    source: "NSE",
    activeMetric: "changePercent",
    activeMetricLabel: "Current change %",
    marketPhase: gainers[0]?.timestamp || "NSE"
  };
}

async function scanTopCrypto() {
  const universe = await loadUniverse("crypto-symbols.json");
  const quotes = await fetchHyperliquidCrypto(universe);
  const now = new Date().toISOString();
  const rows = quotes
    .filter((quote) => Number.isFinite(Number(quote.changePercent)))
    .sort((a, b) => compareQuoteValues(a, b, "changePercent", "desc"))
    .map((quote, index) => topCryptoRowFromQuote(quote, index, now));

  return {
    rows,
    candidateCount: universe.length,
    market: "top-crypto",
    title: "Top Crypto",
    source: "Hyperliquid",
    activeMetric: "changePercent",
    activeMetricLabel: "24h change %",
    marketPhase: "24H"
  };
}

function topCryptoRowFromQuote(quote, index, now) {
  return {
    market: "top-crypto",
    symbol: quote.symbol,
    name: quote.name || quote.symbol,
    exchange: quote.exchange || "Hyperliquid",
    sector: quote.sector || inferCryptoSector(quote),
    type: "Crypto",
    detailUrl: quote.detailUrl || detailUrlForQuote("crypto", quote),
    price: round(quote.price, 6),
    closePrice: nullableRound(closePriceForQuote(quote), 6),
    preMarketPrice: null,
    postMarketPrice: null,
    changeAmount: round(quote.changeAmount || 0, 6),
    changePercent: round(quote.changePercent, 4),
    preMarketChangePercent: null,
    postMarketChangePercent: null,
    activeChangePercent: round(quote.changePercent, 4),
    activeMetric: "changePercent",
    activeMetricLabel: "24h change %",
    volume: quote.volume || 0,
    signalRank: index + 1,
    source: "Hyperliquid",
    scannedAt: now,
    raw: {
      ...quote.raw,
      activeMetric: "changePercent"
    }
  };
}

function topYahooRow({ quote, index, market, exchangeFallback, fallbackSector, session, now }) {
  const metric = session.metric;
  const closePrice = closePriceForQuote(quote);
  const preMarketChangePercent = preMarketPercentForQuote(quote, closePrice);
  return {
    market,
    symbol: quote.symbol,
    name: quote.name || quote.symbol,
    exchange: quote.exchange || exchangeFallback,
    sector: quote.sector || fallbackSector || null,
    type: quote.type || "Stock",
    detailUrl: quote.detailUrl || yahooDetailUrl(quote.symbol),
    price: round(quote.price, 6),
    closePrice: nullableRound(closePrice, 6),
    preMarketPrice: nullableRound(quote.preMarketPrice, 6),
    postMarketPrice: nullableRound(quote.postMarketPrice, 6),
    overnightPrice: nullableRound(quote.overnightPrice, 6),
    changeAmount: round(quote.changeAmount || 0, 6),
    changePercent: round(quote.changePercent, 4),
    closeChangePercent: nullableRound(quote.closeChangePercent ?? quote.changePercent, 4),
    preMarketChangePercent: nullableRound(preMarketChangePercent, 4),
    postMarketChangePercent: nullableRound(quote.postMarketChangePercent, 4),
    overnightChangeAmount: nullableRound(quote.overnightChangeAmount, 6),
    overnightChangePercent: nullableRound(quote.overnightChangePercent, 4),
    activeChangePercent: nullableRound(metric === "preMarketChangePercent" ? preMarketChangePercent : quote[metric], 4),
    activeMetric: metric,
    activeMetricLabel: session.metricLabel,
    volume: quote.volume || 0,
    signalRank: index + 1,
    source: "Yahoo Finance",
    scannedAt: now,
    raw: {
      ...quote.raw,
      previousClose: quote.raw?.previousClose ?? closePrice ?? null,
      closeChangePercent: quote.raw?.closeChangePercent ?? quote.closeChangePercent ?? quote.changePercent ?? null,
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
  const errors = [];
  if (!batches.length) return allQuotes;

  try {
    const firstBatchQuotes = await fetchYahooQuoteBatch(batches[0], universe);
    allQuotes.push(...firstBatchQuotes);
  } catch (error) {
    if (String(error.message).includes("401")) {
      console.warn("Yahoo quote endpoint is unauthorized; using Yahoo chart endpoint.");
      return fetchYahooChartQuotes(universe);
    }
    errors.push(error.message);
  }

  let cursor = 0;
  const remainingBatches = batches.slice(1);
  const concurrency = Math.min(YAHOO_QUOTE_CONCURRENCY, Math.max(1, remainingBatches.length));

  async function worker() {
    while (cursor < remainingBatches.length) {
      const batch = remainingBatches[cursor];
      cursor += 1;
      try {
        const quotes = await fetchYahooQuoteBatch(batch, universe);
        allQuotes.push(...quotes);
      } catch (error) {
        errors.push(error.message);
      }

      if (QUOTE_DELAY_MS > 0 && cursor < remainingBatches.length) {
        await delay(QUOTE_DELAY_MS);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));

  if (errors.length) {
    console.warn(`Yahoo quote skipped ${errors.length} batch(es): ${errors.slice(0, 3).join("; ")}`);
  }

  if (!allQuotes.length && universe.length) {
    console.warn("Yahoo quote endpoint returned no rows; falling back to Yahoo chart endpoint.");
    return fetchYahooChartQuotes(universe);
  }

  return allQuotes;
}

async function fetchYahooQuoteBatch(batch, universe) {
      const endpoint = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(batch.join(","))}`;
      const response = await fetch(endpoint, {
        headers: yahooHeaders(),
        signal: timeoutSignal(YAHOO_FETCH_TIMEOUT_MS)
      });

      if (!response.ok) {
        throw new Error(`Yahoo Finance quote endpoint returned ${response.status}`);
      }

      const payload = await response.json();
      const results = payload?.quoteResponse?.result || [];
      const quotes = [];
      for (const result of results) {
        const regularPrice = Number(result.regularMarketPrice);
        const previousClose = Number(result.regularMarketPreviousClose);
        const preMarketPrice = distinctSessionPrice(result.preMarketPrice, previousClose);
        const preMarketChangePercent = percentChange(preMarketPrice, previousClose);
        const postMarketPrice = distinctSessionPrice(result.postMarketPrice, regularPrice);
        const overnightPrice = distinctSessionPrice(result.overnightMarketPrice, regularPrice);

        quotes.push({
          symbol: result.symbol,
          name: result.shortName || result.longName || findName(universe, result.symbol),
          exchange: result.fullExchangeName || result.exchange,
          sector: result.sector || findUniverseValue(universe, result.symbol, "sector"),
          type: findUniverseValue(universe, result.symbol, "type"),
          detailUrl: yahooDetailUrl(result.symbol),
          price: Number(result.regularMarketPrice),
          closePrice: Number.isFinite(previousClose) ? previousClose : null,
          preMarketPrice,
          postMarketPrice,
          overnightPrice,
          changeAmount: Number(result.regularMarketChange),
          changePercent: Number(result.regularMarketChangePercent),
          closeChangePercent: Number(result.regularMarketChangePercent),
          preMarketChangePercent,
          postMarketChangePercent: postMarketPrice === null
            ? null
            : numberOrNull(result.postMarketChangePercent) ?? percentChange(postMarketPrice, regularPrice),
          overnightChangeAmount: numberOrNull(result.overnightMarketChange),
          overnightChangePercent: overnightPrice === null ? null : numberOrNull(result.overnightMarketChangePercent),
          volume: Number(result.regularMarketVolume || result.averageDailyVolume3Month || 0),
          source: "Yahoo Finance",
          raw: {
            currency: result.currency,
            marketState: result.marketState,
            previousClose: Number.isFinite(previousClose) ? previousClose : null,
            closeChangePercent: Number(result.regularMarketChangePercent),
            regularMarketPrice: Number.isFinite(regularPrice) ? regularPrice : null,
            postMarketChange: numberOrNull(result.postMarketChange),
            overnightMarketPrice: numberOrNull(result.overnightMarketPrice),
            overnightMarketChange: numberOrNull(result.overnightMarketChange),
            overnightMarketChangePercent: numberOrNull(result.overnightMarketChangePercent),
            quoteType: result.quoteType
          }
        });
      }

      return quotes;
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
        closePrice: Number.isFinite(previousClose) ? previousClose : null,
        preMarketPrice: null,
        postMarketPrice: null,
        changeAmount,
        changePercent,
        closeChangePercent: changePercent,
        preMarketChangePercent: null,
        postMarketChangePercent: null,
        volume: Number(quote.volume || 0),
        source: "Zerodha Kite",
        raw: {
          instrument,
          mode: "quote",
          previousClose: Number.isFinite(previousClose) ? previousClose : null,
          closeChangePercent: changePercent,
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
      } finally {
        if (YAHOO_CHART_DELAY_MS > 0) {
          await delay(YAHOO_CHART_DELAY_MS);
        }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return quotes;
}

async function fetchYahooChartQuote(item) {
  const endpoint = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(item.symbol)}?range=1d&interval=1m&includePrePost=true`;
  const response = await fetch(endpoint, {
    headers: yahooHeaders(),
    signal: timeoutSignal(YAHOO_FETCH_TIMEOUT_MS)
  });

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

  const regularPrice = marketPriceOrNull(meta.regularMarketPrice);
  const latestPrice = latestChartClose(result);
  const price = latestPrice ?? regularPrice;
  const previousClose = Number(meta.previousClose || meta.chartPreviousClose);
  if (price === null || !Number.isFinite(previousClose)) return null;
  const changeAmount = price - previousClose;
  const changePercent = previousClose ? (changeAmount / previousClose) * 100 : 0;
  const marketState = normalizeMarketPhase(meta.marketState || inferMarketState(result, periods));
  const priorPreMarketPrice = latestTradingPeriodClose(result, "pre");
  const preMarketPrice = distinctSessionPrice(meta.preMarketPrice, previousClose)
    || distinctSessionPrice(priorPreMarketPrice, previousClose);
  const afterHoursChartPrice = latestTradingPeriodClose(result, "post");
  const postMarketBaseline = regularPrice ?? previousClose;
  const postMarketPrice = distinctSessionPrice(meta.postMarketPrice, postMarketBaseline)
    || distinctSessionPrice(afterHoursChartPrice, postMarketBaseline);
  const preMarketChangePercent = percentChange(preMarketPrice, previousClose)
    ?? numberOrNull(meta.preMarketChangePercent);
  const postMarketChangePercent = numberOrNull(meta.postMarketChangePercent)
    ?? percentChange(postMarketPrice, postMarketBaseline);

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
    preMarketChangePercent,
    postMarketChangePercent,
    volume: Number(meta.regularMarketVolume || 0),
    source: "Yahoo Finance",
    raw: {
      currency: meta.currency,
      hasPrePostMarketData: meta.hasPrePostMarketData || false,
      marketState,
      regularMarketPrice: regularPrice,
      latestChartPrice: latestPrice,
      postMarketBaseline,
      priorPreMarketPrice,
      afterHoursChartPrice,
      postMarketChange: numberOrNull(meta.postMarketChange),
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

async function fetchHyperliquidHistoricalChart(symbol, { range, interval }) {
  const universe = await loadUniverse("crypto-symbols.json").catch(() => []);
  const universeRow = findCryptoUniverseRow(universe, symbol);
  if (!universeRow?.hyperliquidCoin) {
    throw new Error(`Hyperliquid chart symbol not found for ${symbol}`);
  }

  const safeRange = ["1d", "5d", "1mo", "3mo", "6mo", "1y"].includes(range) ? range : "1d";
  const safeInterval = hyperliquidIntervalFor(interval, safeRange);
  const endTime = Date.now();
  const startTime = endTime - rangeMs(safeRange);
  const rawCandles = await hyperliquidInfo({
    type: "candleSnapshot",
    req: {
      coin: universeRow.hyperliquidCoin,
      interval: safeInterval,
      startTime,
      endTime
    }
  });
  const candleRows = typeof rawCandles === "string" ? JSON.parse(rawCandles) : rawCandles;
  const candles = (Array.isArray(candleRows) ? candleRows : [])
    .map((candle) => ({
      time: new Date(Number(candle.t)).toISOString(),
      open: numberOrNull(candle.o),
      high: numberOrNull(candle.h),
      low: numberOrNull(candle.l),
      close: numberOrNull(candle.c),
      volume: Number(candle.v || 0)
    }))
    .filter((candle) =>
      [candle.open, candle.high, candle.low, candle.close].every((value) => Number.isFinite(Number(value)))
    );

  if (!candles.length) {
    const quotes = await fetchHyperliquidCrypto([universeRow]);
    const quote = quotes[0];
    if (quote) {
      const previous = quote.price - quote.changeAmount;
      candles.push(
        {
          time: new Date(endTime - 24 * 60 * 60 * 1000).toISOString(),
          open: previous,
          high: Math.max(previous, quote.price),
          low: Math.min(previous, quote.price),
          close: previous,
          volume: 0
        },
        {
          time: new Date(endTime).toISOString(),
          open: previous,
          high: Math.max(previous, quote.price),
          low: Math.min(previous, quote.price),
          close: quote.price,
          volume: quote.volume || 0
        }
      );
    }
  }

  return {
    symbol,
    currency: "USD",
    exchangeName: "Hyperliquid",
    range: safeRange,
    interval: safeInterval,
    regularMarketPrice: candles.at(-1)?.close ?? null,
    lastPrice: candles.at(-1)?.close ?? null,
    candles
  };
}

function findCryptoUniverseRow(universe, symbol) {
  const normalized = String(symbol || "").toUpperCase();
  return universe.find((item) => {
    const itemSymbol = String(item.symbol || "").toUpperCase();
    const nativeSymbol = String(item.nativeSymbol || itemSymbol.replace(/-USD$/, "")).toUpperCase();
    const displaySymbol = `${cryptoDisplaySymbol(nativeSymbol)}-USD`;
    return itemSymbol === normalized || displaySymbol === normalized;
  }) || null;
}

function hyperliquidIntervalFor(interval, range) {
  if (range === "1d") return ["1m", "5m", "15m"].includes(interval) ? interval : "1m";
  if (range === "5d") return "1h";
  return "1d";
}

function rangeMs(range) {
  return {
    "1d": 24 * 60 * 60 * 1000,
    "5d": 5 * 24 * 60 * 60 * 1000,
    "1mo": 31 * 24 * 60 * 60 * 1000,
    "3mo": 93 * 24 * 60 * 60 * 1000,
    "6mo": 186 * 24 * 60 * 60 * 1000,
    "1y": 366 * 24 * 60 * 60 * 1000
  }[range] || 24 * 60 * 60 * 1000;
}

async function enrichUsOvernightRows(rows) {
  const enriched = [];
  let cursor = 0;
  const concurrency = Math.min(YAHOO_OVERNIGHT_CONCURRENCY, Math.max(1, rows.length));

  async function worker() {
    while (cursor < rows.length) {
      const index = cursor;
      cursor += 1;
      enriched[index] = await enrichUsOvernightRow(rows[index]);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return enriched;
}

async function enrichUsOvernightRow(row) {
  try {
    const quote = await fetchYahooEmbeddedQuote(row.symbol);
    const overnightPrice = rawYahooNumber(quote?.overnightMarketPrice);
    const overnightChangePercent = rawYahooNumber(quote?.overnightMarketChangePercent);
    const overnightChange = rawYahooNumber(quote?.overnightMarketChange);

    if (!sessionPriceIsDistinct(overnightPrice, row.price) || !hasMeaningfulPercent(overnightChangePercent)) {
      return {
        ...row,
        overnightPrice: null,
        overnightChangeAmount: null,
        overnightChangePercent: null,
        raw: {
          ...(row.raw || {}),
          overnightMarketPrice: overnightPrice,
          overnightMarketChange: overnightChange,
          overnightMarketChangePercent: overnightChangePercent,
          overnightMarketSource: "Yahoo embedded quote",
          overnightMarketUnavailable: true
        }
      };
    }

    return {
      ...row,
      overnightPrice,
      overnightChangeAmount: overnightChange,
      overnightChangePercent,
      raw: {
        ...(row.raw || {}),
        overnightMarketPrice: overnightPrice,
        overnightMarketChange: overnightChange,
        overnightMarketChangePercent: overnightChangePercent,
        overnightMarketTime: rawYahooNumber(quote?.overnightMarketTime),
        overnightMarketSource: "Yahoo embedded quote"
      }
    };
  } catch {
    return row;
  }
}

async function fetchYahooEmbeddedQuote(symbol) {
  const html = await httpsGetText(`https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/`, {
    ...yahooHeaders(),
    "Accept": "text/html,application/xhtml+xml"
  });
  return extractYahooEmbeddedQuote(html, symbol);
}

function extractYahooEmbeddedQuote(html, symbol) {
  const markerIndex = html.indexOf("overnightMarketPrice");
  if (markerIndex < 0) return null;

  const scriptStart = html.lastIndexOf("<script", markerIndex);
  const contentStart = html.indexOf(">", scriptStart);
  const scriptEnd = html.indexOf("</script>", contentStart);
  if (scriptStart < 0 || contentStart < 0 || scriptEnd < 0) return null;

  const scriptBody = decodeHtmlEntities(html.slice(contentStart + 1, scriptEnd));
  const outer = JSON.parse(scriptBody);
  const inner = JSON.parse(outer.body || "{}");
  const quotes = inner?.quoteResponse?.result || [];
  return quotes.find((quote) => quote.symbol === symbol) || quotes[0] || null;
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&quot;/g, "\"")
    .replace(/&#34;/g, "\"")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function rawYahooNumber(value) {
  const raw = value && typeof value === "object" && "raw" in value ? value.raw : value;
  return numberOrNull(raw);
}

function httpsGetText(url, headers, redirects = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers, maxHeaderSize: 128 * 1024 }, (response) => {
      const location = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && location && redirects < 3) {
        response.resume();
        resolve(httpsGetText(new URL(location, url).toString(), headers, redirects + 1));
        return;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`GET ${url} returned ${response.statusCode}`));
        return;
      }

      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolve(body));
    });

    request.setTimeout(YAHOO_FETCH_TIMEOUT_MS, () => {
      request.destroy(new Error(`GET ${url} timed out`));
    });
    request.on("error", reject);
  });
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
  const displaySymbol = cryptoDisplaySymbol(nativeSymbol);
  const changeAmount = price - previous;
  const changePercent = previous ? (changeAmount / previous) * 100 : 0;

  return {
    symbol: `${displaySymbol}-USD`,
    name: `${displaySymbol}/USDC`,
    exchange: "Hyperliquid",
    sector: inferCryptoSector({ symbol: displaySymbol, name: displaySymbol }),
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
      dayNtlVlm: context?.dayNtlVlm,
      nativeSymbol
    }
  };
}

function cryptoDisplaySymbol(symbol) {
  return {
    UAVAX: "AVAX",
    UBTC: "BTC",
    UETH: "ETH",
    USOL: "SOL"
  }[symbol] || symbol;
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

async function readStoredSignals({ market, page, perPage, query, sector, sortBy, sortDirection }) {
  if (!isSupabaseConfigured()) return null;

  const rows = await fetchStoredRows(market);
  if (!rows.length) return null;

  const normalizedSortBy = normalizeTopSortBy(sortBy);
  const sectorFiltered = filterRowsBySector(rows, sector);
  const filtered = filterStoredRows(sectorFiltered, query);
  if (market === "us" && isTrueOvernightSort(normalizedSortBy) && hasStaleUsOvernightRows(market, filtered)) return null;
  const metricFiltered = filterScanMetricRows(filtered, market, normalizedSortBy);
  if (market === "us" && filtered.length && !metricFiltered.length) return null;
  const sorted = metricFiltered.sort((a, b) => compareQuoteValues(a, b, normalizedSortBy, sortDirection));
  const activeMetric = percentMetricFor(normalizedSortBy);
  let pageRows = paginate(sorted, page, perPage).map((row, index) => ({
    ...row,
    activeChangePercent: activeMetric ? nullableRound(row[activeMetric], 4) : row.activeChangePercent,
    activeMetric: normalizedSortBy,
    activeMetricLabel: topMetricLabel(normalizedSortBy),
    signalRank: (page - 1) * perPage + index + 1
  }));
  if (market === "us" && isTrueOvernightSort(normalizedSortBy)) {
    pageRows = await enrichUsOvernightRows(pageRows);
    pageRows = filterScanMetricRows(pageRows, market, normalizedSortBy)
      .sort((a, b) => compareQuoteValues(a, b, normalizedSortBy, sortDirection))
      .map((row, index) => ({
        ...row,
        activeChangePercent: activeMetric ? nullableRound(row[activeMetric], 4) : row.activeChangePercent,
        signalRank: (page - 1) * perPage + index + 1
      }));
  }

  return {
    rows: pageRows,
    total: metricFiltered.length,
    activeMetric: normalizedSortBy,
    activeMetricLabel: topMetricLabel(normalizedSortBy),
    scannedAt: newestScannedAt(filtered)
  };
}

async function readStoredTopMarket(market, { sector, query, sortBy, sortDirection }) {
  if (!isSupabaseConfigured()) return null;

  let rows = await fetchStoredRows(market);
  if (!rows.length) return null;
  const universe = await topMarketUniverseForStoredRows(market);
  if (universe.length) {
    rows = rows.map((row) => enrichStoredTopRow(row, universe));
  }
  if (market === "top-us") {
    const fallbackRows = await readStoredUsRowsForTopMarket();
    if (hasInvalidTopUsSnapshot(rows)) {
      if (fallbackRows.length) rows = fallbackRows;
      else return null;
    } else if (fallbackRows.length) {
      rows = mergeStoredRowsBySymbol(rows, fallbackRows);
    }
  }

  const requestedSector = normalizeSector(sector);
  const normalizedSortBy = normalizeTopSortBy(sortBy);
  const direction = sortDirection === "desc" ? "desc" : "asc";
  const filtered = requestedSector
    ? rows.filter((row) => normalizeSector(row.sector) === requestedSector)
    : rows;
  const searchedRows = filterStoredRows(filtered, query);
  const sortableRows = searchedRows
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

function mergeStoredRowsBySymbol(primaryRows, secondaryRows) {
  const merged = new Map();
  [...secondaryRows, ...primaryRows].forEach((row) => {
    const symbol = String(row.symbol || "").toUpperCase();
    if (!symbol) return;
    const existing = merged.get(symbol);
    if (!existing || new Date(row.scannedAt || 0) >= new Date(existing.scannedAt || 0)) {
      merged.set(symbol, row);
    }
  });
  return [...merged.values()];
}

async function readStoredUsRowsForTopMarket() {
  const universe = await loadUniverse("us-symbols.json").catch(() => []);
  const rows = await fetchStoredRows("us").catch(() => []);
  if (!rows.length) return [];
  return rows
    .map((row) => enrichStoredTopRow(row, universe))
    .filter(isTopUsStockUniverseRow);
}

function hasInvalidTopUsSnapshot(rows) {
  if (!rows.length) return true;
  const sectors = new Set(rows.map((row) => normalizeSector(row.sector)).filter(Boolean));
  if (!sectors.has("Technology")) return true;
  return rows.some((row) => !isTopUsStockUniverseRow(row));
}

async function topMarketUniverseForStoredRows(market) {
  if (market === "top-us") return loadUniverse("us-symbols.json").catch(() => []);
  if (market === "top-india") return loadUniverse("india-symbols.json").catch(() => []);
  if (market === "top-crypto") return loadUniverse("crypto-symbols.json").catch(() => []);
  return [];
}

function enrichStoredTopRow(row, universe) {
  return {
    ...row,
    sector: row.sector || findUniverseValue(universe, row.symbol, "sector") || null,
    type: row.type || findUniverseValue(universe, row.symbol, "type") || row.raw?.quoteType || null
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
  const price = numberOrNull(row.price);
  const changeAmount = numberOrNull(row.change_amount) || 0;
  const closePrice = numberOrNull(row.raw?.previousClose ?? row.raw?.ohlc?.close)
    ?? (price === null ? null : price - changeAmount);
  const preMarketPrice = numberOrNull(row.pre_market_price);
  const regularMarketPrice = numberOrNull(row.raw?.regularMarketPrice);
  const storedPostMarketPrice = numberOrNull(row.post_market_price);
  const fallbackPostMarketPrice = isPostMarketRow(row.raw) && storedPostMarketPrice === null
    ? distinctSessionPrice(price, regularMarketPrice)
    : null;
  const postMarketPrice = storedPostMarketPrice ?? fallbackPostMarketPrice;
  const postMarketChangePercent = percentChange(postMarketPrice, regularMarketPrice)
    ?? numberOrNull(row.post_market_change_percent);
  return {
    market: row.market,
    symbol: row.symbol || row.ticker,
    name: row.name || row.symbol || row.ticker,
    exchange: row.exchange || "",
    sector: row.sector || null,
    type: row.raw?.quoteType || null,
    detailUrl: detailUrlForQuote(row.market, { symbol: row.symbol || row.ticker, raw: row.raw }),
    price,
    closePrice,
    preMarketPrice,
    postMarketPrice,
    overnightPrice: numberOrNull(row.raw?.overnightMarketPrice),
    changeAmount,
    changePercent: numberOrNull(row.change_percent),
    closeChangePercent: numberOrNull(row.raw?.closeChangePercent) ?? numberOrNull(row.change_percent),
    preMarketChangePercent: preMarketPercent(preMarketPrice, closePrice)
      ?? numberOrNull(row.pre_market_change_percent),
    postMarketChangePercent,
    overnightChangeAmount: numberOrNull(row.raw?.overnightMarketChange),
    overnightChangePercent: numberOrNull(row.raw?.overnightMarketChangePercent),
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

function filterUniverseBySector(universe, sector) {
  const requestedSector = normalizeSector(sector);
  if (!requestedSector) return universe;
  return universe.filter((item) => normalizeSector(item.sector) === requestedSector);
}

function filterRowsBySector(rows, sector) {
  const requestedSector = normalizeSector(sector);
  if (!requestedSector) return rows;
  return rows.filter((row) => normalizeSector(row.sector) === requestedSector);
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
    "closePrice",
    "preMarketPrice",
    "postMarketPrice",
    "overnightPrice",
    "closeChangePercent",
    "preMarketChangePercent",
    "postMarketChangePercent",
    "overnightChangePercent"
  ]);
  return allowed.has(sortBy) ? sortBy : "changePercent";
}

function topMetricLabel(sortBy) {
  if (sortBy === "changePercent") return "Current change %";

  return {
    price: "Current price",
    closePrice: "Close price",
    preMarketPrice: "Pre-market price",
    postMarketPrice: "After-hours price",
    overnightPrice: "Overnight price",
    closeChangePercent: "Close change %",
    preMarketChangePercent: "Pre-market change %",
    postMarketChangePercent: "After-hours change %",
    overnightChangePercent: "Overnight change %"
  }[sortBy] || "Current change %";
}

function percentMetricFor(sortBy) {
  return {
    changePercent: "changePercent",
    closeChangePercent: "closeChangePercent",
    preMarketChangePercent: "preMarketChangePercent",
    postMarketChangePercent: "postMarketChangePercent",
    overnightChangePercent: "overnightChangePercent"
  }[sortBy] || null;
}

function hasSortableValue(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function closePriceForQuote(quote) {
  const directClose = numberOrNull(quote.closePrice ?? quote.raw?.previousClose ?? quote.raw?.ohlc?.close);
  if (directClose !== null) return directClose;

  const price = numberOrNull(quote.price);
  const changeAmount = numberOrNull(quote.changeAmount);
  if (price !== null && changeAmount !== null) return price - changeAmount;
  return null;
}

function preMarketPercentForQuote(quote, fallbackClose = null) {
  const previousClose = numberOrNull(quote.raw?.previousClose ?? quote.closePrice ?? fallbackClose);
  return preMarketPercent(quote.preMarketPrice, previousClose) ?? numberOrNull(quote.preMarketChangePercent);
}

function preMarketPercent(price, previousClose) {
  return percentChange(numberOrNull(price), numberOrNull(previousClose));
}

function isPostMarketRow(raw) {
  const state = String(raw?.marketState || raw?.marketPhase || "").toUpperCase();
  return state === "POST" || state === "POSTPOST" || state === "AFTER_HOURS" || state === "AFTERHOURS";
}

function isOvernightSort(sortBy) {
  const normalizedSortBy = normalizeTopSortBy(sortBy);
  return isTrueOvernightSort(normalizedSortBy);
}

function isTrueOvernightSort(sortBy) {
  const normalizedSortBy = normalizeTopSortBy(sortBy);
  return normalizedSortBy === "overnightPrice" || normalizedSortBy === "overnightChangePercent";
}

function usesSparseUsSessionFilter(sortBy) {
  const normalizedSortBy = normalizeTopSortBy(sortBy);
  return normalizedSortBy === "preMarketPrice"
    || normalizedSortBy === "preMarketChangePercent"
    || normalizedSortBy === "postMarketPrice"
    || normalizedSortBy === "postMarketChangePercent"
    || normalizedSortBy === "overnightPrice"
    || normalizedSortBy === "overnightChangePercent";
}

function usSessionFilterCacheKey(sortBy, sector) {
  return `${normalizeTopSortBy(sortBy)}:${normalizeSector(sector)}`;
}

function filterScanMetricRows(rows, market, sortBy) {
  if (market !== "us") return rows;
  const normalizedSortBy = normalizeTopSortBy(sortBy);
  if (normalizedSortBy === "postMarketPrice" || normalizedSortBy === "postMarketChangePercent") {
    return rows.filter((row) =>
      hasSortableValue(row[normalizedSortBy])
      && sessionPriceIsDistinct(row.postMarketPrice, row.raw?.regularMarketPrice ?? row.raw?.previousClose ?? row.price)
      && hasMeaningfulPercent(row.postMarketChangePercent)
    );
  }

  if (normalizedSortBy === "overnightPrice" || normalizedSortBy === "overnightChangePercent") {
    return rows.filter((row) =>
      hasSortableValue(row[normalizedSortBy])
      && sessionPriceIsDistinct(row.overnightPrice, row.price)
      && hasMeaningfulPercent(row.overnightChangePercent)
    );
  }

  if (normalizedSortBy === "preMarketPrice" || normalizedSortBy === "preMarketChangePercent") {
    return rows.filter((row) =>
      hasSortableValue(row[normalizedSortBy])
      && sessionPriceIsDistinct(row.preMarketPrice, row.raw?.previousClose ?? row.closePrice ?? previousCloseFromPercent(row.preMarketPrice, row.preMarketChangePercent))
      && hasMeaningfulPercent(row.preMarketChangePercent)
    );
  }

  return rows.filter((row) => hasSortableValue(row[normalizedSortBy]));
}

function hasStaleUsOvernightRows(market, rows) {
  return market === "us" && rows.some((row) => {
    const price = numberOrNull(row.price);
    const overnightPrice = numberOrNull(row.postMarketPrice);
    if (price === null || overnightPrice === null) return false;

    const storedOvernightPrice = numberOrNull(row.raw?.overnightPrice);
    const storedOvernightPercent = numberOrNull(row.postMarketChangePercent);
    const matchesClose = Math.abs(price - overnightPrice) < 0.000001;
    const noChartDerivedOvernight = storedOvernightPrice === null || Math.abs(storedOvernightPrice - price) < 0.000001;
    const noOvernightChange = storedOvernightPercent === null || Math.abs(storedOvernightPercent) < 0.000001;

    return matchesClose && noChartDerivedOvernight && noOvernightChange;
  });
}

function sessionPriceIsDistinct(sessionPrice, regularPrice) {
  const session = numberOrNull(sessionPrice);
  const regular = numberOrNull(regularPrice);
  if (session === null || regular === null) return false;
  return Math.abs(session - regular) >= 0.000001;
}

function hasMeaningfulPercent(value) {
  const percent = numberOrNull(value);
  return percent !== null && Math.abs(percent) >= 0.000001;
}

function previousCloseFromPercent(price, percent) {
  const numericPrice = numberOrNull(price);
  const numericPercent = numberOrNull(percent);
  if (numericPrice === null || numericPercent === null || numericPercent <= -100) return null;
  return numericPrice / (1 + numericPercent / 100);
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

  const aRawValue = field === "closePrice" ? closePriceForQuote(a) : a[field];
  const bRawValue = field === "closePrice" ? closePriceForQuote(b) : b[field];
  const aMissing = aRawValue === null || aRawValue === undefined || aRawValue === "";
  const bMissing = bRawValue === null || bRawValue === undefined || bRawValue === "";
  const aValue = Number(aRawValue);
  const bValue = Number(bRawValue);
  const aFinite = !aMissing && Number.isFinite(aValue);
  const bFinite = !bMissing && Number.isFinite(bValue);

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

function currentChangeSession() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    weekday: "short"
  });
  const parts = formatter.formatToParts(now);
  const hour = parseInt(parts.find(p => p.type === "hour").value, 10);
  const minute = parseInt(parts.find(p => p.type === "minute").value, 10);
  const day = parts.find(p => p.type === "weekday").value;
  const isWeekend = day === "Sat" || day === "Sun";
  const timeVal = hour * 100 + minute;

  if (isWeekend) {
    return { phase: "CLOSED", metric: "postMarketChangePercent", metricLabel: "Post-market change %" };
  }
  if (timeVal >= 400 && timeVal < 930) {
    return { phase: "PRE", metric: "preMarketChangePercent", metricLabel: "Pre-market change %" };
  }
  if (timeVal >= 930 && timeVal < 1600) {
    return { phase: "REGULAR", metric: "changePercent", metricLabel: "Current change %" };
  }
  return { phase: "POST", metric: "postMarketChangePercent", metricLabel: "After-hours change %" };
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

function latestChartClose(chartResult) {
  const closes = chartResult?.indicators?.quote?.[0]?.close || [];
  for (let index = closes.length - 1; index >= 0; index -= 1) {
    const close = marketPriceOrNull(closes[index]);
    if (close !== null) return close;
  }
  return null;
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

function timeoutSignal(ms) {
  return AbortSignal.timeout(Math.max(1, Number(ms) || 1));
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
