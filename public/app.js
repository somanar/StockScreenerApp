const state = {
  market: new URLSearchParams(location.search).get("market") || "us",
  rows: [],
  search: "",
  page: 1,
  perPage: 100,
  total: 0,
  totalPages: 1,
  universeTotal: 0,
  sector: "",
  sectors: [],
  sortBy: "changePercent",
  sortDirection: "asc",
  selectedSymbol: null,
  autoRefresh: true,
  isLoading: false,
  nextRefreshAt: null
};

const REFRESH_MS = 30_000;
const topMarkets = new Set(["top-us", "top-india", "top-crypto", "mystocks"]);
let refreshTimer = null;
let countdownTimer = null;
let searchTimer = null;
let chartAbort = null;
let chartState = {
  candles: [],
  row: null,
  hoverIndex: null,
  geometry: null
};

const elements = {
  rows: document.querySelector("#rows"),
  status: document.querySelector("#status"),
  watchlistCount: document.querySelector("#watchlistCount"),
  tabs: document.querySelectorAll(".tab"),
  marketTitle: document.querySelector("#marketTitle"),
  sourceTitle: document.querySelector("#sourceTitle"),
  scanTime: document.querySelector("#scanTime"),
  storageStatus: document.querySelector("#storageStatus"),
  refreshButton: document.querySelector("#refreshButton"),
  searchInput: document.querySelector("#searchInput"),
  limitSelect: document.querySelector("#limitSelect"),
  sectorFilterLabel: document.querySelector("#sectorFilterLabel"),
  sectorSelect: document.querySelector("#sectorSelect"),
  sortFilterLabel: document.querySelector("#sortFilterLabel"),
  sortSelect: document.querySelector("#sortSelect"),
  orderFilterLabel: document.querySelector("#orderFilterLabel"),
  directionSelect: document.querySelector("#directionSelect"),
  autoRefreshInput: document.querySelector("#autoRefreshInput"),
  realtimeStatus: document.querySelector("#realtimeStatus"),
  prevPageButton: document.querySelector("#prevPageButton"),
  nextPageButton: document.querySelector("#nextPageButton"),
  pageInfo: document.querySelector("#pageInfo"),
  selectedSymbol: document.querySelector("#selectedSymbol"),
  selectedPrice: document.querySelector("#selectedPrice"),
  selectedChange: document.querySelector("#selectedChange"),
  detailsLink: document.querySelector("#detailsLink"),
  chartMeta: document.querySelector("#chartMeta"),
  priceChart: document.querySelector("#priceChart")
};

elements.limitSelect.value = String(state.perPage);

elements.tabs.forEach((tab) => {
  tab.classList.toggle("active", tab.dataset.market === state.market);
  tab.addEventListener("click", (event) => {
    event.preventDefault();
    state.market = tab.dataset.market;
    state.page = 1;
    state.sector = "";
    state.selectedSymbol = null;
    history.pushState({}, "", `/?market=${state.market}`);
    elements.tabs.forEach((item) => item.classList.toggle("active", item.dataset.market === state.market));
    updateToolbarMode();
    loadMarket();
  });
});

elements.refreshButton?.addEventListener("click", loadMarket);
elements.searchInput.addEventListener("input", (event) => {
  state.search = event.target.value.trim().toLowerCase();
  state.page = 1;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadMarket, 350);
});
elements.limitSelect.addEventListener("change", (event) => {
  state.perPage = Number(event.target.value);
  state.page = 1;
  loadMarket();
});
elements.sectorSelect.addEventListener("change", (event) => {
  state.sector = event.target.value;
  state.page = 1;
  loadMarket();
});
elements.sortSelect.addEventListener("change", (event) => {
  state.sortBy = event.target.value;
  loadMarket();
});
elements.directionSelect.addEventListener("change", (event) => {
  state.sortDirection = event.target.value;
  loadMarket();
});
elements.autoRefreshInput.addEventListener("change", (event) => {
  state.autoRefresh = event.target.checked;
  scheduleRefresh();
});
elements.prevPageButton.addEventListener("click", () => {
  if (state.page <= 1) return;
  state.page -= 1;
  loadMarket();
});
elements.nextPageButton.addEventListener("click", () => {
  if (state.page >= state.totalPages) return;
  state.page += 1;
  loadMarket();
});

window.addEventListener("popstate", () => {
  state.market = new URLSearchParams(location.search).get("market") || "us";
  state.page = 1;
  state.sector = "";
  state.selectedSymbol = null;
  elements.tabs.forEach((item) => item.classList.toggle("active", item.dataset.market === state.market));
  updateToolbarMode();
  loadMarket();
});

updateToolbarMode();
loadMarket();
countdownTimer = setInterval(updateRealtimeStatus, 1000);
window.addEventListener("resize", () => {
  const row = state.rows.find((item) => item.symbol === state.selectedSymbol);
  if (row) loadChart(row);
});
elements.priceChart.addEventListener("mousemove", handleChartHover);
elements.priceChart.addEventListener("mouseleave", () => {
  chartState.hoverIndex = null;
  if (chartState.row) {
    elements.chartMeta.textContent = chartMetaText(chartState.row, { candles: chartState.candles });
    drawChart(chartState.candles, chartState.row);
  }
});

async function loadMarket() {
  if (state.isLoading) return;
  state.isLoading = true;
  elements.status.textContent = "Refreshing live prices...";
  if (!state.rows.length) {
    elements.rows.innerHTML = "";
  }
  if (elements.refreshButton) elements.refreshButton.disabled = true;
  updatePagination();
  clearTimeout(refreshTimer);

  try {
    const response = await fetch(apiUrl());
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Scan failed");
    }

    state.rows = payload.rows || [];
    if (!state.rows.some((row) => row.symbol === state.selectedSymbol)) {
      state.selectedSymbol = state.rows[0]?.symbol || null;
    }
    state.page = payload.page || state.page;
    state.perPage = payload.perPage || state.perPage;
    state.total = payload.total || state.rows.length;
    state.totalPages = payload.totalPages || 1;
    state.universeTotal = payload.universeTotal || state.total;
    state.sectors = payload.sectors || [];
    renderSectorOptions();
    elements.marketTitle.textContent = payload.title || state.market.toUpperCase();
    elements.sourceTitle.textContent = payload.source || "--";
    elements.scanTime.textContent = formatDate(payload.scannedAt);
    elements.storageStatus.textContent = describeStorage(payload.storage);
    if (topMarkets.has(state.market) && payload.activeMetricLabel) {
      elements.sourceTitle.textContent = `${payload.source || "--"} | ${payload.activeMetricLabel}`;
    }
    elements.status.textContent = state.rows.length
      ? statusText(payload)
      : "No rows returned for this market.";
    renderRows();
    updateSelectedPanel();
  } catch (error) {
    state.rows = [];
    elements.status.textContent = error.message;
    elements.storageStatus.textContent = "Not stored";
    renderRows();
    updateSelectedPanel();
  } finally {
    state.isLoading = false;
    if (elements.refreshButton) elements.refreshButton.disabled = false;
    updatePagination();
    scheduleRefresh();
  }
}

function apiUrl() {
  if (topMarkets.has(state.market)) {
    const market = state.market === "mystocks" ? "top-us" : state.market;
    const params = new URLSearchParams({
      market,
      sector: state.sector,
      sortBy: state.sortBy,
      direction: state.sortDirection
    });
    return `/api/top-market?${params.toString()}`;
  }

  const params = new URLSearchParams({
    market: state.market,
    page: String(state.page),
    perPage: String(state.perPage),
    query: state.search,
    sortBy: state.sortBy,
    direction: state.sortDirection
  });

  return `/api/scan?${params.toString()}`;
}

function statusText(payload) {
  if (topMarkets.has(state.market)) {
    const cacheNote = payload.cache?.hit ? " Cached while refreshing." : "";
    const sectorNote = payload.sector ? ` in ${payload.sector}` : "";
    return `Top ${state.rows.length}${sectorNote} by ${payload.activeMetricLabel || "selected metric"}.${cacheNote}`;
  }

  return `${state.rows.length} live rows from ${formatCompact(state.total)} matches / ${formatCompact(state.universeTotal)} symbols.`;
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);

  if (!state.autoRefresh) {
    state.nextRefreshAt = null;
    updateRealtimeStatus();
    return;
  }

  state.nextRefreshAt = Date.now() + REFRESH_MS;
  updateRealtimeStatus();
  refreshTimer = setTimeout(loadMarket, REFRESH_MS);
}

function renderRows() {
  elements.rows.innerHTML = state.rows.map((row) => {
    const display = displayMetric(row);
    const changeClass = valueClass(display.amount);
    const activeClass = valueClass(display.percent);
    const selectedClass = row.symbol === state.selectedSymbol ? " selected" : "";
    return `
      <tr class="watchRow${selectedClass}" data-symbol="${escapeHtml(row.symbol)}">
        <td class="symbolCell" title="${escapeHtml(row.name)}">
          <span class="companyName">${escapeHtml(row.name)}</span>
          <span class="tickerText">${escapeHtml(row.symbol)} <span class="sectorText">${escapeHtml(row.sector || row.exchange || "")}</span></span>
        </td>
        <td>${miniSparkline(row)}</td>
        <td>${formatNumberOrDash(row.price)}</td>
        <td>${formatNumberOrDash(row.preMarketPrice)}</td>
        <td>${formatNumberOrDash(row.postMarketPrice)}</td>
        <td class="${activeClass}">${formatPercentOrDash(display.percent)}</td>
        <td class="${changeClass}">${formatSignedOrDash(display.amount)}</td>
      </tr>
    `;
  }).join("");
  elements.watchlistCount.textContent = `${formatCompact(state.rows.length)} shown`;

  elements.rows.querySelectorAll(".watchRow").forEach((rowElement) => {
    rowElement.addEventListener("click", () => {
      state.selectedSymbol = rowElement.dataset.symbol;
      renderRows();
      updateSelectedPanel();
    });
  });
}

function updateSelectedPanel() {
  const row = state.rows.find((item) => item.symbol === state.selectedSymbol);
  if (!row) {
    elements.selectedSymbol.textContent = "--";
    elements.selectedPrice.textContent = "--";
    elements.selectedChange.textContent = "--";
    elements.detailsLink.href = "#";
    elements.chartMeta.textContent = "Select a symbol to view the chart.";
    drawEmptyChart();
    return;
  }

  elements.selectedSymbol.textContent = row.symbol;
  const display = displayMetric(row);
  elements.selectedPrice.textContent = formatNumberOrDash(display.price);
  elements.selectedPrice.className = `selectedPrice ${valueClass(display.percent)}`;
  elements.selectedChange.textContent = `${formatSignedOrDash(display.amount)} ${formatPercentOrDash(display.percent)}`;
  elements.selectedChange.className = `selectedChange ${valueClass(display.percent)}`;
  elements.detailsLink.href = row.detailUrl || "#";
  loadChart(row);
}

function displayMetric(row) {
  if (state.sortBy === "preMarketPrice" || state.sortBy === "preMarketChangePercent") {
    return {
      price: row.preMarketPrice,
      amount: numberOrNull(row.preMarketPrice) === null || numberOrNull(row.price) === null
        ? null
        : Number(row.preMarketPrice) - Number(row.price),
      percent: row.preMarketChangePercent
    };
  }

  if (state.sortBy === "postMarketPrice" || state.sortBy === "postMarketChangePercent") {
    return {
      price: row.postMarketPrice,
      amount: numberOrNull(row.postMarketPrice) === null || numberOrNull(row.price) === null
        ? null
        : Number(row.postMarketPrice) - Number(row.price),
      percent: row.postMarketChangePercent
    };
  }

  return {
    price: row.price,
    amount: row.changeAmount,
    percent: row.activeChangePercent ?? row.changePercent
  };
}

async function loadChart(row) {
  chartAbort?.abort();
  chartAbort = new AbortController();
  elements.chartMeta.textContent = `Loading ${row.symbol} chart...`;
  drawEmptyChart();

  try {
    const params = new URLSearchParams({
      symbol: row.symbol,
      market: state.market,
      range: "1d",
      interval: "1m"
    });
    const response = await fetch(`/api/chart?${params.toString()}`, { signal: chartAbort.signal });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Chart unavailable");

    elements.chartMeta.textContent = chartMetaText(row, payload);
    drawChart(payload.candles || [], row);
  } catch (error) {
    if (error.name === "AbortError") return;
    elements.chartMeta.textContent = `${row.symbol} chart unavailable. ${error.message}`;
    drawEmptyChart();
  }
}

function updateToolbarMode() {
  const isTopMarket = topMarkets.has(state.market);
  elements.sectorFilterLabel.hidden = !isTopMarket;
  elements.sectorSelect.disabled = !isTopMarket;
  elements.sectorSelect.value = state.sector;
}

function renderSectorOptions() {
  const sectors = state.sectors || [];
  const current = sectors.includes(state.sector) ? state.sector : "";
  if (current !== state.sector) state.sector = current;

  elements.sectorSelect.innerHTML = [
    `<option value="">All sectors</option>`,
    ...sectors.map((sector) => `<option value="${escapeHtml(sector)}">${escapeHtml(sector)}</option>`)
  ].join("");
  elements.sectorSelect.value = state.sector;
}

function chartMetaText(row, payload) {
  const candles = payload.candles || [];
  const last = candles[candles.length - 1] || {};
  const open = formatNumberOrDash(last.open);
  const high = formatNumberOrDash(last.high);
  const low = formatNumberOrDash(last.low);
  const close = formatNumberOrDash(last.close);
  return `O ${open}  H ${high}  L ${low}  C ${close}  Vol ${formatCompact(last.volume)}  ${escapePlain(row.name)}`;
}

function drawEmptyChart() {
  const canvas = elements.priceChart;
  const context = canvas.getContext("2d");
  resizeCanvas(canvas, context);
  const { width, height } = canvas.getBoundingClientRect();
  context.clearRect(0, 0, width, height);
  drawGrid(context, width, height, 46, width - 46);
}

function drawChart(candles, row) {
  const canvas = elements.priceChart;
  const context = canvas.getContext("2d");
  resizeCanvas(canvas, context);
  const { width, height } = canvas.getBoundingClientRect();
  context.clearRect(0, 0, width, height);

  if (!candles.length) {
    drawGrid(context, width, height, 44, 24);
    return;
  }

  const priceTop = 22;
  const priceBottom = Math.floor(height * 0.78);
  const volumeTop = priceBottom + 22;
  const volumeBottom = height - 24;
  const left = 46;
  const right = width - 46;
  const chartWidth = right - left;
  const visible = candles.slice(-130);
  const prices = visible.flatMap((candle) => [candle.high, candle.low]).filter((value) => Number.isFinite(Number(value)));
  const volumes = visible.map((candle) => Number(candle.volume || 0));
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const pricePadding = Math.max((maxPrice - minPrice) * 0.08, Math.abs(maxPrice || 1) * 0.01);
  const low = minPrice - pricePadding;
  const high = maxPrice + pricePadding;
  const maxVolume = Math.max(...volumes, 1);
  const step = chartWidth / Math.max(visible.length, 1);
  const candleWidth = Math.max(3, Math.min(9, step * 0.58));

  drawGrid(context, width, height, left, right);

  context.font = "11px Inter, system-ui, sans-serif";
  context.textAlign = "right";
  context.textBaseline = "middle";
  context.fillStyle = "#9fb0c7";
  for (let index = 0; index <= 5; index += 1) {
    const value = low + ((high - low) * (5 - index)) / 5;
    const y = priceTop + ((high - value) / (high - low)) * (priceBottom - priceTop);
    context.fillText(formatNumber(value), width - 8, y);
  }

  visible.forEach((candle, index) => {
    const x = left + index * step + step / 2;
    const openY = scale(candle.open, low, high, priceBottom, priceTop);
    const closeY = scale(candle.close, low, high, priceBottom, priceTop);
    const highY = scale(candle.high, low, high, priceBottom, priceTop);
    const lowY = scale(candle.low, low, high, priceBottom, priceTop);
    const isUp = Number(candle.close) >= Number(candle.open);
    const color = isUp ? "#00c477" : "#ff3f5f";

    context.strokeStyle = color;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x, highY);
    context.lineTo(x, lowY);
    context.stroke();

    context.fillStyle = color;
    context.fillRect(
      x - candleWidth / 2,
      Math.min(openY, closeY),
      candleWidth,
      Math.max(2, Math.abs(closeY - openY))
    );

    const volumeHeight = (Number(candle.volume || 0) / maxVolume) * (volumeBottom - volumeTop);
    context.globalAlpha = 0.72;
    context.fillRect(x - candleWidth / 2, volumeBottom - volumeHeight, candleWidth, volumeHeight);
    context.globalAlpha = 1;
  });

  const lastPrice = Number(row.price || visible[visible.length - 1]?.close);
  if (Number.isFinite(lastPrice)) {
    const y = scale(lastPrice, low, high, priceBottom, priceTop);
    context.strokeStyle = row.changePercent < 0 ? "rgba(255, 63, 95, 0.65)" : "rgba(0, 196, 119, 0.65)";
    context.setLineDash([2, 6]);
    context.beginPath();
    context.moveTo(left, y);
    context.lineTo(right, y);
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = row.changePercent < 0 ? "#ff3f5f" : "#00c477";
    context.fillRect(right + 4, y - 10, 40, 20);
    context.fillStyle = "#ffffff";
    context.textAlign = "center";
    context.fillText(formatNumber(lastPrice), right + 24, y + 1);
  }

  context.textAlign = "left";
  context.fillStyle = "#cfe0f6";
  context.fillText(`Volume ${formatCompact(visible[visible.length - 1]?.volume)}`, left, volumeTop - 9);
}

function drawGrid(context, width, height, left, right) {
  const priceTop = 22;
  const priceBottom = Math.floor(height * 0.78);
  const volumeBottom = height - 24;
  context.fillStyle = "#0d1219";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "rgba(52, 69, 91, 0.45)";
  context.lineWidth = 1;

  for (let index = 0; index <= 7; index += 1) {
    const x = left + ((right - left) * index) / 7;
    context.beginPath();
    context.moveTo(x, priceTop);
    context.lineTo(x, volumeBottom);
    context.stroke();
  }

  for (let index = 0; index <= 6; index += 1) {
    const y = priceTop + ((priceBottom - priceTop) * index) / 6;
    context.beginPath();
    context.moveTo(left, y);
    context.lineTo(right, y);
    context.stroke();
  }

  context.beginPath();
  context.moveTo(left, priceBottom);
  context.lineTo(right, priceBottom);
  context.strokeStyle = "rgba(122, 142, 166, 0.55)";
  context.stroke();
}

function miniSparkline(row) {
  const values = sparkValues(row);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = max - min || 1;
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * 66 + 1;
    const y = 28 - ((value - min) / spread) * 24;
    return `${round(x, 2)},${round(y, 2)}`;
  }).join(" ");
  const color = Number(row.changePercent) < 0 ? "#ff3f5f" : "#00c477";
  return `<svg class="miniChart" viewBox="0 0 68 30" aria-hidden="true">
    <polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.4"></polyline>
  </svg>`;
}

function sparkValues(row) {
  let seed = [...String(row.symbol || "")].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const trend = Number(row.changePercent || 0) / 100;
  const values = [];
  let value = 1;
  for (let index = 0; index < 28; index += 1) {
    seed = (seed * 9301 + 49297) % 233280;
    const noise = (seed / 233280 - 0.48) * 0.055;
    value = Math.max(0.2, value + noise + trend / 18);
    values.push(value);
  }
  return values;
}

function resizeCanvas(canvas, context) {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width * ratio));
  const height = Math.max(1, Math.floor(rect.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function scale(value, min, max, outputMin, outputMax) {
  if (max === min) return (outputMin + outputMax) / 2;
  return outputMin + ((Number(value) - min) / (max - min)) * (outputMax - outputMin);
}

function updatePagination() {
  elements.pageInfo.textContent = `Page ${state.page} of ${state.totalPages} | ${formatCompact(state.total)} matches`;
  elements.prevPageButton.disabled = state.isLoading || state.page <= 1;
  elements.nextPageButton.disabled = state.isLoading || state.page >= state.totalPages;
}

function describeStorage(storage) {
  if (!storage) return "--";
  if (!storage.enabled) return "Env needed";
  if (storage.error) return storage.error;
  if (storage.warning) return storage.warning;
  return `${storage.inserted || 0} rows stored`;
}

function updateRealtimeStatus() {
  if (!state.autoRefresh) {
    elements.realtimeStatus.textContent = "Paused";
    return;
  }

  if (state.isLoading) {
    elements.realtimeStatus.textContent = "Scanning now";
    return;
  }

  if (!state.nextRefreshAt) {
    elements.realtimeStatus.textContent = "Auto 30s";
    return;
  }

  const seconds = Math.max(0, Math.ceil((state.nextRefreshAt - Date.now()) / 1000));
  elements.realtimeStatus.textContent = `Next ${seconds}s`;
}

function formatDate(value) {
  if (!value) return "--";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium"
  }).format(new Date(value));
}

function formatNumber(value) {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: value < 1 ? 6 : 2
  }).format(value);
}

function formatNumberOrDash(value) {
  return Number.isFinite(Number(value)) ? formatNumber(Number(value)) : "--";
}

function formatPercentOrDash(value) {
  return Number.isFinite(Number(value)) ? `${formatSigned(Number(value))}%` : "--";
}

function formatCompact(value) {
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1
  }).format(value || 0);
}

function formatSigned(value) {
  const number = Number(value || 0);
  const sign = number > 0 ? "+" : "";
  return `${sign}${formatNumber(number)}`;
}

function formatSignedOrDash(value) {
  return Number.isFinite(Number(value)) ? formatSigned(Number(value)) : "--";
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(Number(value) * factor) / factor;
}

function valueClass(value) {
  if (!Number.isFinite(Number(value))) return "";
  return Number(value) < 0 ? "negative" : "positive";
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function escapePlain(value) {
  return String(value ?? "");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
