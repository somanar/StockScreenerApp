const state = {
  market: new URLSearchParams(location.search).get("market") || "top-us",
  rows: [],
  search: "",
  reportDate: "",
  page: 1,
  perPage: 100,
  total: 0,
  totalPages: 1,
  universeTotal: 0,
  sector: "",
  sectors: [],
  sortBy: "changePercent",
  sortDirection: "desc",
  selectedSymbol: null,
  detailTab: "chart",
  chartRange: "1d",
  chartInterval: "1m",
  showIndicators: false,
  autoRefresh: true,
  extremeThreshold: Number(localStorage.getItem("stockScreenerThreshold")) || 10,
  muteAlerts: localStorage.getItem("stockScreenerMute") === "true",
  notifiedSymbols: new Set(),
  isLoading: false,
  nextRefreshAt: null
};

document.body.classList.toggle("marketWatchMode", state.market === "market-watch");
document.body.classList.toggle("earningsFullMode", state.market === "earnings");

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
  tableHeaders: document.querySelector("#tableHeaders"),
  status: document.querySelector("#status"),
  watchlistCount: document.querySelector("#watchlistCount"),
  watchlistTitle: document.querySelector(".watchlistHeader strong"),
  toolbar: document.querySelector(".toolbar"),
  workspace: document.querySelector(".workspace"),
  watchlistPanel: document.querySelector(".watchlistPanel"),
  tableWrap: document.querySelector(".tableWrap"),
  topScrollWrap: document.querySelector(".topScrollWrap"),
  topScrollSpacer: document.querySelector(".topScrollSpacer"),
  chartPanel: document.querySelector(".chartPanel"),
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
  dateFilterLabel: document.querySelector("#dateFilterLabel"),
  dateInput: document.querySelector("#dateInput"),
  sortFilterLabel: document.querySelector("#sortFilterLabel"),
  sortSelect: document.querySelector("#sortSelect"),
  orderFilterLabel: document.querySelector("#orderFilterLabel"),
  directionSelect: document.querySelector("#directionSelect"),
  muteAlertsInput: document.querySelector("#muteAlertsInput"),
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
  priceChart: document.querySelector("#priceChart"),
  chartTabs: document.querySelectorAll(".chartTab"),
  rangeButtons: document.querySelectorAll(".rangeButton"),
  indicatorButton: document.querySelector("#indicatorButton"),
  detailsPanel: document.querySelector("#detailsPanel"),
  thresholdInput: document.querySelector("#thresholdInput"),
  chartCanvasWrap: document.querySelector(".chartCanvasWrap")
};

elements.limitSelect.value = String(state.perPage);
if (elements.thresholdInput) elements.thresholdInput.value = String(state.extremeThreshold);
if (elements.muteAlertsInput) elements.muteAlertsInput.checked = state.muteAlerts;
normalizeMarketControls();

elements.tabs.forEach((tab) => {
  tab.classList.toggle("active", tab.dataset.market === state.market);
  tab.addEventListener("click", (event) => {
    event.preventDefault();
    state.market = tab.dataset.market;
    state.page = 1;
    state.sector = "";
    state.reportDate = "";
    state.search = "";
    state.notifiedSymbols.clear();
    state.sortDirection = topMarkets.has(state.market) ? "desc" : state.sortDirection;
    if (isEarningsMarket(state.market)) state.sortDirection = "asc";
    state.selectedSymbol = null;
    normalizeMarketControls();
    history.pushState({}, "", `/?market=${state.market}`);
    elements.tabs.forEach((item) => item.classList.toggle("active", item.dataset.market === state.market));
    updateToolbarMode();
    loadMarket();
  });
});

function activeSortBy() {
  if (isMarketWatchMarket(state.market)) return "publishedAt";
  if (isEarningsMarket(state.market)) return state.sortBy;
  return isBrowseMarket(state.market) ? "changePercent" : state.sortBy;
}

function activeSortDirection() {
  if (isMarketWatchMarket(state.market)) return "desc";
  if (isEarningsMarket(state.market)) return state.sortDirection;
  return isBrowseMarket(state.market) ? "asc" : state.sortDirection;
}

function normalizeMarketControls() {
  if (isBrowseMarket(state.market)) {
    state.sortBy = "changePercent";
    state.sortDirection = "asc";
  }
  if (isEarningsMarket(state.market) && state.sortBy !== "marketCapValue") {
    state.sortDirection = "asc";
  }
  renderSortOptions();
  elements.sortSelect.value = state.sortBy;
  elements.directionSelect.value = state.sortDirection;
}

function isBrowseMarket(market) {
  return market === "us" || market === "india";
}

function sortOptionsForMarket() {
  if (isMarketWatchMarket(state.market)) {
    return [
      ["publishedAt", "Published"],
      ["source", "Source"],
      ["factor", "Macro factor"],
      ["impactScore", "Impact"]
    ];
  }

  if (isEarningsMarket(state.market)) {
    return [
      ["reportDate", "Report date"],
      ["symbol", "Symbol"],
      ["name", "Company"],
      ["quarter", "Quarter"],
      ["marketCapValue", "Market cap"]
    ];
  }

  if (state.market === "top-us") {
    return [
      ["changePercent", "Current change %"],
      ["preMarketChangePercent", "Pre-market change %"],
      ["postMarketChangePercent", "After-hours change %"],
      ["overnightChangePercent", "Overnight change %"],
      ["rsi", "RSI (14)"],
      ["ema20", "EMA (20)"]
    ];
  }

  if (state.market === "top-crypto") {
    return [
      ["changePercent", "24h change %"]
    ];
  }

  if (isCryptoMarket(state.market)) {
    return [
      ["changePercent", "24h change %"],
      ["price", "Current price"]
    ];
  }

  if (state.market === "india" || state.market === "top-india") {
    return [
      ["changePercent", "Current change %"],
      ["price", "Current price"],
      ["closePrice", "Close price"],
      ["closeChangePercent", "Close change %"]
    ];
  }

  return [
    ["changePercent", "Current change %"],
    ["price", "Current price"],
    ["preMarketPrice", "Pre-market price"],
    ["postMarketPrice", "After-hours price"],
    ["overnightPrice", "Overnight price"],
    ["preMarketChangePercent", "Pre-market change %"],
    ["postMarketChangePercent", "After-hours change %"],
    ["overnightChangePercent", "Overnight change %"]
  ];
}

function renderSortOptions() {
  const options = sortOptionsForMarket();
  if (!options.some(([value]) => value === state.sortBy)) {
    state.sortBy = options[0]?.[0] || "changePercent";
  }
  elements.sortSelect.innerHTML = options
    .map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`)
    .join("");
}

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
elements.dateInput?.addEventListener("change", (event) => {
  state.reportDate = event.target.value;
  state.page = 1;
  loadMarket();
});
elements.sortSelect.addEventListener("change", (event) => {
  state.sortBy = event.target.value;
  state.page = 1;
  loadMarket();
});
elements.directionSelect.addEventListener("change", (event) => {
  state.sortDirection = event.target.value;
  state.page = 1;
  loadMarket();
});
elements.muteAlertsInput?.addEventListener("change", (event) => {
  state.muteAlerts = event.target.checked;
  localStorage.setItem("stockScreenerMute", String(state.muteAlerts));
});
elements.autoRefreshInput.addEventListener("change", (event) => {
  state.autoRefresh = event.target.checked;
  scheduleRefresh();
});
elements.thresholdInput?.addEventListener("input", (event) => {
  state.extremeThreshold = Number(event.target.value) || 10;
  localStorage.setItem("stockScreenerThreshold", String(state.extremeThreshold));
  state.notifiedSymbols.clear();
  renderRows();
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
  state.reportDate = "";
  state.search = "";
  state.notifiedSymbols.clear();
  state.sortDirection = topMarkets.has(state.market) ? "desc" : state.sortDirection;
  if (isEarningsMarket(state.market)) state.sortDirection = "asc";
  state.selectedSymbol = null;
  elements.tabs.forEach((item) => item.classList.toggle("active", item.dataset.market === state.market));
  updateToolbarMode();
  loadMarket();
});

updateToolbarMode();
setupTopTableScroll();
loadMarket();
countdownTimer = setInterval(updateRealtimeStatus, 1000);
window.addEventListener("resize", () => {
  const row = state.rows.find((item) => item.symbol === state.selectedSymbol);
  if (row) loadChart(row);
  syncTopTableScrollSize();
});
elements.priceChart.addEventListener("mousemove", handleChartHover);
elements.priceChart.addEventListener("mouseleave", () => {
  chartState.hoverIndex = null;
  if (chartState.row) {
    elements.chartMeta.textContent = chartMetaText(chartState.row, { candles: chartState.candles });
    drawChart(chartState.candles, chartState.row);
  }
});
elements.chartTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    state.detailTab = tab.dataset.detailTab || "chart";
    updateDetailTab();
  });
});
elements.rangeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.chartRange = button.dataset.range || "1d";
    state.chartInterval = button.dataset.interval || "1m";
    updateRangeButtons();
    const row = state.rows.find((item) => item.symbol === state.selectedSymbol);
    if (row) loadChart(row);
  });
});
elements.indicatorButton.addEventListener("click", () => {
  state.showIndicators = !state.showIndicators;
  elements.indicatorButton.classList.toggle("active", state.showIndicators);
  if (chartState.row) drawChart(chartState.candles, chartState.row);
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
    if ((topMarkets.has(state.market) || state.market === "us" || isEarningsMarket(state.market) || isMarketWatchMarket(state.market)) && payload.activeMetricLabel) {
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
  if (isMarketWatchMarket(state.market)) {
    return "/api/market-watch";
  }

  if (isEarningsMarket(state.market)) {
    const params = new URLSearchParams({
      year: String(new Date().getFullYear()),
      quarter: state.sector || "all",
      date: state.reportDate,
      page: String(state.page),
      perPage: String(state.perPage),
      query: state.search,
      sortBy: activeSortBy(),
      direction: activeSortDirection()
    });
    return `/api/earnings?${params.toString()}`;
  }

  if (topMarkets.has(state.market)) {
    const market = state.market === "mystocks" ? "top-us" : state.market;
    const params = new URLSearchParams({
      market,
      sector: state.sector,
      query: state.search,
      sortBy: activeSortBy(),
      direction: activeSortDirection()
    });
    return `/api/top-market?${params.toString()}`;
  }

  const params = new URLSearchParams({
    market: state.market,
    page: String(state.page),
    perPage: String(state.perPage),
    query: state.search,
    sector: isSectorBrowseMarket(state.market) ? state.sector : "",
    sortBy: activeSortBy(),
    direction: activeSortDirection()
  });

  return `/api/scan?${params.toString()}`;
}

function statusText(payload) {
  if (isMarketWatchMarket(state.market)) {
    return `${state.rows.length} headlines from the last 7 days. Newest updates stay on top.`;
  }

  if (isEarningsMarket(state.market)) {
    const quarterNote = payload.sector ? ` for ${payload.sector}` : "";
    const dateNote = payload.reportDate ? ` on ${payload.reportDate}` : "";
    return `${state.rows.length} earnings shown${quarterNote}${dateNote} from ${formatCompact(payload.total)} scheduled reports.`;
  }

  if (topMarkets.has(state.market)) {
    const cacheNote = payload.cache?.hit ? " (Real-time data refreshing...)" : "";
    const sectorNote = payload.sector ? ` in ${payload.sector}` : "";
    const limitNote = state.market === "top-us" ? "Top 50" : `Top ${state.rows.length}`;
    return `${limitNote}${sectorNote} by ${payload.activeMetricLabel || "selected metric"}.${cacheNote}`;
  }

  if (state.market === "us" && payload.activeMetricLabel) {
    const sectorNote = payload.sector ? ` in ${payload.sector}` : "";
    return `${state.rows.length} rows${sectorNote} with ${payload.activeMetricLabel} from ${formatCompact(payload.total)} matches / ${formatCompact(payload.universeTotal)} symbols.`;
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

  const interval = refreshIntervalMs();
  state.nextRefreshAt = Date.now() + interval;
  updateRealtimeStatus();
  refreshTimer = setTimeout(loadMarket, interval);
}

function renderRows() {
  renderTableHeaders();
  if (isMarketWatchMarket(state.market)) {
    elements.rows.innerHTML = state.rows.map((row, index) => {
      const selectedClass = row.symbol === state.selectedSymbol ? " selected" : "";
      return `
        <tr class="watchRow newsCard${index === 0 ? " leadNews" : ""}${selectedClass}" data-symbol="${escapeHtml(row.symbol)}">
          <td>
            <article>
              ${row.imageUrl ? `<a href="${escapeHtml(row.detailUrl || "#")}" target="_blank" rel="noopener noreferrer"><img class="newsImage" src="${escapeHtml(row.imageUrl)}" alt=""></a>` : ""}
              <div class="newsMeta">
                <span>${escapeHtml(row.source || "")}</span>
                <span>${escapeHtml(row.factor || "")}</span>
                <span>${formatDate(row.publishedAt)}</span>
              </div>
              <a class="newsHeadline" href="${escapeHtml(row.detailUrl || "#")}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.title || "--")}</a>
              <p class="newsSummary">${escapeHtml(row.summary || "")}</p>
              <a class="newsLink" href="${escapeHtml(row.detailUrl || "#")}" target="_blank" rel="noopener noreferrer">Read details</a>
            </article>
          </td>
        </tr>
      `;
    }).join("");
    elements.watchlistCount.textContent = `${formatCompact(state.rows.length)} shown`;
    syncTopTableScrollSize();
    elements.rows.querySelectorAll(".watchRow").forEach((rowElement) => {
      rowElement.addEventListener("click", () => {
        state.selectedSymbol = rowElement.dataset.symbol;
        renderRows();
        updateSelectedPanel();
      });
    });
    return;
  }

  let alertType = null;

  elements.rows.innerHTML = state.rows.map((row) => {
    const selectedClass = row.symbol === state.selectedSymbol ? " selected" : "";
    const activePercent = Number(row.activeChangePercent ?? row.changePercent);
    let extremeClass = "";
    let extremeIcon = "";
    if (activePercent >= state.extremeThreshold) {
      extremeClass = " extreme-up";
      extremeIcon = ` <span title="Up >${state.extremeThreshold}%">🚀</span>`;
      if (!state.notifiedSymbols.has(row.symbol)) {
        state.notifiedSymbols.add(row.symbol);
        if (alertType !== "both") alertType = alertType === "down" ? "both" : "up";
      }
    } else if (activePercent <= -state.extremeThreshold) {
      extremeClass = " extreme-down";
      extremeIcon = ` <span title="Down >${state.extremeThreshold}%">📉</span>`;
      if (!state.notifiedSymbols.has(row.symbol)) {
        state.notifiedSymbols.add(row.symbol);
        if (alertType !== "both") alertType = alertType === "up" ? "both" : "down";
      }
    } else {
      state.notifiedSymbols.delete(row.symbol);
    }
    const metricCells = rowCellsForMarket(row);
    const tickerMarkup = tickerMarkupForRow(row, extremeIcon);
    return `
      <tr class="watchRow${selectedClass}${extremeClass}" data-symbol="${escapeHtml(row.symbol)}">
        <td class="symbolCell" title="${escapeHtml(row.name)}">
          <span class="companyName">${escapeHtml(row.name)}</span>
          ${tickerMarkup}
        </td>
        <td>${miniSparkline(row)}</td>
        ${metricCells}
      </tr>
    `;
  }).join("");
  elements.watchlistCount.textContent = `${formatCompact(state.rows.length)} shown`;
  syncTopTableScrollSize();

  if (alertType) {
    playAlertSound(alertType);
    triggerVisualAlert(alertType);
  }

  elements.rows.querySelectorAll(".watchRow").forEach((rowElement) => {
    rowElement.addEventListener("click", () => {
      state.selectedSymbol = rowElement.dataset.symbol;
      renderRows();
      updateSelectedPanel();
    });
  });
}

function setupTopTableScroll() {
  if (!elements.tableWrap || !elements.topScrollWrap || !elements.topScrollSpacer) return;
  let syncingFromTop = false;
  let syncingFromTable = false;

  elements.topScrollWrap.addEventListener("scroll", () => {
    if (syncingFromTable) return;
    syncingFromTop = true;
    elements.tableWrap.scrollLeft = elements.topScrollWrap.scrollLeft;
    syncingFromTop = false;
  });

  elements.tableWrap.addEventListener("scroll", () => {
    if (syncingFromTop) return;
    syncingFromTable = true;
    elements.topScrollWrap.scrollLeft = elements.tableWrap.scrollLeft;
    syncingFromTable = false;
  });
}

function syncTopTableScrollSize() {
  if (!elements.tableWrap || !elements.topScrollWrap || !elements.topScrollSpacer) return;
  requestAnimationFrame(() => {
    const scrollWidth = elements.tableWrap.scrollWidth;
    const clientWidth = elements.tableWrap.clientWidth;
    elements.topScrollSpacer.style.width = `${scrollWidth}px`;
    elements.topScrollWrap.classList.toggle("isHidden", scrollWidth <= clientWidth + 1);
    elements.topScrollWrap.scrollLeft = elements.tableWrap.scrollLeft;
  });
}

function tickerMarkupForRow(row, extraMarkup = "") {
  const sectorMarkup = ` <span class="sectorText">${escapeHtml(row.sector || row.exchange || "")}</span>`;
  if (!isIndianMarket(state.market)) {
    return `<span class="tickerText">${escapeHtml(row.symbol)}${extraMarkup}${sectorMarkup}</span>`;
  }

  const href = nseQuoteUrl(row.symbol);
  return `<a class="tickerText tickerLink" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.symbol)}${extraMarkup}${sectorMarkup}</a>`;
}

function nseQuoteUrl(symbol) {
  const nseSymbol = String(symbol || "").replace(/\.NS$/i, "").trim().toUpperCase();
  return `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(nseSymbol)}`;
}

function renderTableHeaders() {
  if (isMarketWatchMarket(state.market)) {
    elements.tableHeaders.innerHTML = "";
    return;
  }

  if (isEarningsMarket(state.market)) {
    elements.tableHeaders.innerHTML = [
      "Symbol",
      "Company",
      "Report Date",
      "Quarter",
      "Call Time",
      "EPS Est",
      "Last Year EPS",
      "Market Cap"
    ].map((label) => `<th>${escapeHtml(label)}</th>`).join("");
    return;
  }

  const metricHeaders = metricHeadersForMarket();
  elements.tableHeaders.innerHTML = [
    "Symbol",
    "Trend",
    ...metricHeaders
  ].map((label) => `<th>${escapeHtml(label)}</th>`).join("");
}

function metricHeadersForMarket() {
  if (isCryptoMarket(state.market)) return ["Current Price", "24h Change", "24h Volume"];
  if (isIndianMarket(state.market)) return ["Current Price", "Current %", "Close Price", "Close %"];
  
  const headers = ["Current Price", "Current %", "Pre Price", "Pre %", "After Hours", "After Hours %"];
  if (state.market === "top-us") {
    headers.push("RSI", "EMA (20)");
  } else {
    headers.push("Overnight", "Overnight %");
  }
  return headers;
}

function rowCellsForMarket(row) {
  if (isMarketWatchMarket(state.market)) {
    return `
      <td>${escapeHtml(row.factor || "--")}</td>
      <td>${escapeHtml(row.impact || "--")}</td>
      <td>${formatDate(row.publishedAt)}</td>
      <td class="summaryCell">${escapeHtml(row.summary || "--")}</td>
    `;
  }

  if (isEarningsMarket(state.market)) {
    return `
      <td>${escapeHtml(row.name || "--")}</td>
      <td>${escapeHtml(row.reportDate || "--")}</td>
      <td>${escapeHtml(row.quarter || "--")}</td>
      <td>${escapeHtml(row.callTime || "--")}</td>
      <td>${escapeHtml(row.epsForecast || "--")}</td>
      <td>${escapeHtml(row.epsActual || "--")}</td>
      <td>${escapeHtml(row.marketCap || "--")}</td>
    `;
  }

  if (isCryptoMarket(state.market)) {
    return `
      <td>${formatNumberOrDash(row.price)}</td>
      <td class="${valueClass(row.changePercent)}">${formatPercentOrDash(row.changePercent)}</td>
      <td>${formatCompact(row.volume)}</td>
    `;
  }

  if (isIndianMarket(state.market)) {
    const closePrice = closePriceForRow(row);
    const closePercent = closeChangePercentForRow(row);
    return `
      <td>${formatPriceOrDash(row.price)}</td>
      <td class="${valueClass(row.changePercent)}">${formatPercentOrDash(row.changePercent)}</td>
      <td>${formatPriceOrDash(closePrice)}</td>
      <td class="${valueClass(closePercent)}">${formatPercentOrDash(closePercent)}</td>
    `;
  }

  if (state.market === "top-us") {
    const rsiClass = row.rsi > 70 ? "negative" : row.rsi < 30 ? "positive" : "";
    return `
      <td>${formatNumberOrDash(row.price)}</td>
      <td class="${valueClass(row.changePercent)}">${formatPercentOrDash(row.changePercent)}</td>
      <td>${formatNumberOrDash(row.preMarketPrice)}</td>
      <td class="${valueClass(row.preMarketChangePercent)}">${formatPercentOrDash(row.preMarketChangePercent)}</td>
      <td>${formatNumberOrDash(row.postMarketPrice)}</td>
      <td class="${valueClass(row.postMarketChangePercent)}">${formatPercentOrDash(row.postMarketChangePercent)}</td>
      <td class="${rsiClass}">${formatNumberOrDash(row.rsi)}</td>
      <td>${formatNumberOrDash(row.ema20)}</td>
    `;
  }

  return `
    <td>${formatNumberOrDash(row.price)}</td>
    <td class="${valueClass(row.changePercent)}">${formatPercentOrDash(row.changePercent)}</td>
    <td>${formatNumberOrDash(row.preMarketPrice)}</td>
    <td class="${valueClass(row.preMarketChangePercent)}">${formatPercentOrDash(row.preMarketChangePercent)}</td>
    <td>${formatNumberOrDash(row.postMarketPrice)}</td>
    <td class="${valueClass(row.postMarketChangePercent)}">${formatPercentOrDash(row.postMarketChangePercent)}</td>
    <td>${formatNumberOrDash(row.overnightPrice)}</td>
    <td class="${valueClass(row.overnightChangePercent)}">${formatPercentOrDash(row.overnightChangePercent)}</td>
  `;
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
  if (isMarketWatchMarket(state.market)) {
    elements.selectedSymbol.textContent = row.source || "--";
    elements.selectedPrice.textContent = row.factor || "--";
    elements.selectedPrice.className = "selectedPrice";
    elements.selectedChange.textContent = row.impact || "--";
    elements.selectedChange.className = "selectedChange";
    elements.detailsLink.href = row.detailUrl || "#";
    state.detailTab = "financials";
    renderDetailsPanel(row);
    updateDetailTab();
    elements.chartMeta.textContent = row.summary || "Select a headline to view details.";
    drawEmptyChart();
    return;
  }

  if (isEarningsMarket(state.market)) {
    elements.selectedPrice.textContent = row.reportDate || "--";
    elements.selectedPrice.className = "selectedPrice";
    elements.selectedChange.textContent = `${row.quarter || "--"} ${row.callTime || ""}`.trim();
    elements.selectedChange.className = "selectedChange";
    elements.detailsLink.href = row.detailUrl || "#";
    state.detailTab = "financials";
    renderDetailsPanel(row);
    updateDetailTab();
    elements.chartMeta.textContent = "Select Chart for a price chart, or use Financials/Profile for earnings details.";
    drawEmptyChart();
    return;
  }

  const display = displayMetric(row);
  elements.selectedPrice.textContent = formatPriceOrDash(display.price);
  elements.selectedPrice.className = `selectedPrice ${valueClass(display.percent)}`;
  elements.selectedChange.textContent = `${formatSignedPriceOrDash(display.amount)} ${formatPercentOrDash(display.percent)}`;
  elements.selectedChange.className = `selectedChange ${valueClass(display.percent)}`;
  elements.detailsLink.href = row.detailUrl || "#";
  renderDetailsPanel(row);
  updateDetailTab();
  loadChart(row);
}

function displayMetric(row) {
  const sortBy = activeSortBy();
  if (sortBy === "preMarketPrice" || sortBy === "preMarketChangePercent") {
    return {
      price: row.preMarketPrice,
      amount: changeAmountFromPercent(row.preMarketPrice, row.preMarketChangePercent),
      percent: row.preMarketChangePercent
    };
  }

  if (sortBy === "postMarketPrice" || sortBy === "postMarketChangePercent") {
    const baseline = numberOrNull(row.raw?.regularMarketPrice) ?? numberOrNull(row.raw?.previousClose) ?? numberOrNull(row.price);
    return {
      price: row.postMarketPrice,
      amount: numberOrNull(row.raw?.postMarketChange) !== null
        ? row.raw.postMarketChange
        : numberOrNull(row.postMarketPrice) === null || baseline === null
        ? null
        : Number(row.postMarketPrice) - baseline,
      percent: row.postMarketChangePercent
    };
  }

  if (sortBy === "overnightPrice" || sortBy === "overnightChangePercent") {
    return {
      price: row.overnightPrice,
      amount: numberOrNull(row.overnightChangeAmount) !== null
        ? row.overnightChangeAmount
        : numberOrNull(row.overnightPrice) === null || numberOrNull(row.price) === null
          ? null
          : Number(row.overnightPrice) - Number(row.price),
      percent: row.overnightChangePercent
    };
  }

  if (sortBy === "closePrice" || sortBy === "closeChangePercent") {
    return {
      price: closePriceForRow(row),
      amount: row.changeAmount,
      percent: closeChangePercentForRow(row)
    };
  }

  return {
    price: row.price,
    amount: row.changeAmount,
    percent: row.activeChangePercent ?? row.changePercent
  };
}

function closePriceForRow(row) {
  const rawClose = numberOrNull(row.raw?.previousClose ?? row.raw?.ohlc?.close);
  if (rawClose !== null) return rawClose;

  const price = numberOrNull(row.price);
  const changeAmount = numberOrNull(row.changeAmount);
  if (price !== null && changeAmount !== null) return price - changeAmount;
  return null;
}

function closeChangePercentForRow(row) {
  return numberOrNull(row.raw?.closeChangePercent) ?? numberOrNull(row.changePercent);
}

function changeAmountFromPercent(price, percent) {
  const numericPrice = numberOrNull(price);
  const numericPercent = numberOrNull(percent);
  if (numericPrice === null || numericPercent === null || numericPercent <= -100) return null;

  const basePrice = numericPrice / (1 + numericPercent / 100);
  return numericPrice - basePrice;
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
      range: state.chartRange,
      interval: state.chartInterval
    });
    const response = await fetch(`/api/chart?${params.toString()}`, { signal: chartAbort.signal });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Chart unavailable");

    chartState = { candles: payload.candles || [], row, hoverIndex: null, geometry: null };
    elements.chartMeta.textContent = chartMetaText(row, payload);
    drawChart(payload.candles || [], row);
  } catch (error) {
    if (error.name === "AbortError") return;
    const fallbackCandles = fallbackCandlesForRow(row);
    chartState = { candles: fallbackCandles, row, hoverIndex: null, geometry: null };
    elements.chartMeta.textContent = `${row.symbol} live chart unavailable. Showing latest price move. ${error.message}`;
    drawChart(fallbackCandles, row);
  }
}

function fallbackCandlesForRow(row) {
  const price = numberOrNull(row.price);
  const changeAmount = numberOrNull(row.changeAmount);
  const close = closePriceForRow(row) ?? (price !== null && changeAmount !== null ? price - changeAmount : null);
  if (price === null || close === null) return [];

  const points = 48;
  const now = Date.now();
  const start = now - 24 * 60 * 60 * 1000;
  const step = (now - start) / (points - 1);
  const range = Math.max(Math.abs(price - close), Math.abs(price) * 0.002, 0.01);
  const candles = [];

  for (let index = 0; index < points; index += 1) {
    const progress = index / (points - 1);
    const base = close + (price - close) * progress;
    const wave = Math.sin(progress * Math.PI * 3) * range * 0.12;
    const candleClose = index === points - 1 ? price : base + wave;
    const candleOpen = index === 0 ? close : candles[index - 1].close;
    candles.push({
      time: new Date(start + step * index).toISOString(),
      open: candleOpen,
      high: Math.max(candleOpen, candleClose) + range * 0.05,
      low: Math.min(candleOpen, candleClose) - range * 0.05,
      close: candleClose,
      volume: Number(row.volume || 0) / points
    });
  }

  return candles;
}

function updateToolbarMode() {
  const isAllCrypto = state.market === "crypto";
  const isEarnings = isEarningsMarket(state.market);
  const isMarketWatch = isMarketWatchMarket(state.market);
  document.body.classList.toggle("marketWatchMode", isMarketWatch);
  document.body.classList.toggle("earningsFullMode", isEarnings);
  if (elements.watchlistTitle) {
    elements.watchlistTitle.textContent = isMarketWatch
      ? "Latest Macro Headlines"
      : isEarnings ? "Earnings Calendar" : "Watchlists";
  }
  if (elements.toolbar) elements.toolbar.hidden = isMarketWatch;
  if (elements.chartPanel) elements.chartPanel.hidden = isMarketWatch || isEarnings;
  const supportsSector = isEarnings || (!isAllCrypto && (topMarkets.has(state.market) || isSectorBrowseMarket(state.market)));
  const supportsSort = isEarnings || (!isAllCrypto && !isBrowseMarket(state.market));
  elements.searchInput.closest("label").hidden = isMarketWatch;
  elements.limitSelect.closest("label").hidden = isMarketWatch;
  elements.searchInput.disabled = isMarketWatch;
  elements.limitSelect.disabled = isMarketWatch;
  if (isMarketWatch) {
    state.search = "";
    state.page = 1;
  }
  elements.sectorFilterLabel.childNodes[0].textContent = isEarnings ? "Quarter " : "Sector ";
  elements.sectorFilterLabel.hidden = !supportsSector;
  elements.sectorSelect.disabled = !supportsSector;
  elements.sectorSelect.value = state.sector;
  if (elements.dateFilterLabel && elements.dateInput) {
    elements.dateFilterLabel.hidden = !isEarnings;
    elements.dateInput.disabled = !isEarnings;
    elements.dateInput.value = state.reportDate;
  }
  elements.sortFilterLabel.hidden = !supportsSort;
  elements.orderFilterLabel.hidden = !supportsSort;
  elements.sortSelect.disabled = !supportsSort;
  elements.directionSelect.disabled = !supportsSort;
  normalizeMarketControls();
}

function isSectorBrowseMarket(market) {
  return market === "us" || market === "india";
}

function isIndianMarket(market) {
  return market === "india" || market === "top-india";
}

function isCryptoMarket(market) {
  return market === "crypto" || market === "top-crypto";
}

function isMarketWatchMarket(market) {
  return market === "market-watch";
}

function isEarningsMarket(market) {
  return market === "earnings";
}

function updateRangeButtons() {
  elements.rangeButtons.forEach((button) => {
    button.classList.toggle(
      "activeRange",
      button.dataset.range === state.chartRange && button.dataset.interval === state.chartInterval
    );
  });
}

function updateDetailTab() {
  elements.chartTabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.detailTab === state.detailTab);
  });

  const isChart = state.detailTab === "chart";
  elements.chartCanvasWrap.hidden = !isChart;
  elements.detailsPanel.hidden = isChart;
  elements.indicatorButton.disabled = !isChart;
  if (!isChart) renderDetailsPanel(state.rows.find((item) => item.symbol === state.selectedSymbol));
}

function renderDetailsPanel(row) {
  if (!row) {
    elements.detailsPanel.innerHTML = `<div class="detailEmpty">Select a symbol.</div>`;
    return;
  }

  if (isMarketWatchMarket(state.market)) {
    const panels = {
      financials: [
        ["Headline", row.title || "--"],
        ["Source", row.source || "--"],
        ["Published", formatDate(row.publishedAt)],
        ["Macro factor", row.factor || "--"],
        ["Impact", row.impact || "--"],
        ["Summary", row.summary || "--"]
      ],
      valuation: [
        ["Why it matters", row.reason || "--"],
        ["Selected metric", topMetricName()],
        ["Signal rank", row.signalRank || "--"],
        ["Source", row.source || "--"]
      ],
      profile: [
        ["Headline", row.title || "--"],
        ["Provider", row.source || "--"],
        ["Details", row.detailUrl ? `<a href="${escapeHtml(row.detailUrl)}" target="_blank" rel="noopener noreferrer">Open article</a>` : "--"]
      ]
    };
    const items = panels[state.detailTab] || panels.financials;
    elements.detailsPanel.innerHTML = detailGridHtml(items);
    return;
  }

  if (isEarningsMarket(state.market)) {
    const panels = {
      financials: [
        ["Report date", row.reportDate || "--"],
        ["Fiscal quarter", row.fiscalQuarterEnding || row.quarter || "--"],
        ["Call time", row.callTime || "--"],
        ["EPS estimate", row.epsForecast || "--"],
        ["Last year EPS", row.epsActual || "--"],
        ["Revenue estimate", row.revenueEstimate || "--"],
        ["Revenue growth", row.revenueGrowth || "--"],
        ["Market cap", row.marketCap || "--"]
      ],
      valuation: [
        ["Selected metric", topMetricName()],
        ["Signal rank", row.signalRank || "--"],
        ["Source", row.source || "--"],
        ["Estimates", row.noOfEsts || "--"],
        ["Last year report", row.lastYearReportDate || "--"]
      ],
      profile: [
        ["Name", row.name || "--"],
        ["Symbol", row.symbol || "--"],
        ["Quarter", row.quarter || "--"],
        ["Details", row.detailUrl ? `<a href="${escapeHtml(row.detailUrl)}" target="_blank" rel="noopener noreferrer">Open details</a>` : "--"]
      ]
    };
    const items = panels[state.detailTab] || panels.financials;
    elements.detailsPanel.innerHTML = detailGridHtml(items);
    return;
  }

  const display = displayMetric(row);
  const raw = row.raw || {};
  const currency = raw.currency || row.currency || (isIndianMarket(state.market) ? "INR" : isCryptoMarket(state.market) ? "USD" : "USD");
  const previousClose = numberOrNull(raw.previousClose ?? raw.prevDayPx);
  const latestChartPrice = numberOrNull(raw.latestChartPrice ?? raw.regularMarketPrice ?? raw.markPx);
  const regularMarketPrice = numberOrNull(raw.regularMarketPrice);
  const marketCap = numberOrNull(raw.marketCap);
  const changeLabel = isCryptoMarket(state.market) ? "24h change" : "Current change";
  const sessionItems = isCryptoMarket(state.market)
    ? [
      ["24h change", `${formatSignedPriceOrDash(row.changeAmount)} ${formatPercentOrDash(row.changePercent)}`],
      ["24h volume", formatCompact(row.volume)],
      ["Previous day", formatPriceOrDash(previousClose)]
    ]
    : isIndianMarket(state.market)
    ? [
      ["Close", `${formatPriceOrDash(closePriceForRow(row))} ${formatPercentOrDash(closeChangePercentForRow(row))}`],
      ["Previous close", formatPriceOrDash(previousClose)],
      ["Market state", raw.marketState || "--"]
    ]
    : [
      ["Pre-market", `${formatNumberOrDash(row.preMarketPrice)} ${formatPercentOrDash(row.preMarketChangePercent)}`],
      ["After hours", `${formatNumberOrDash(row.postMarketPrice)} ${formatPercentOrDash(row.postMarketChangePercent)}`],
      ["Overnight", `${formatNumberOrDash(row.overnightPrice)} ${formatPercentOrDash(row.overnightChangePercent)}`],
      ["Close", `${formatPriceOrDash(closePriceForRow(row))} ${formatPercentOrDash(closeChangePercentForRow(row))}`],
      ["Previous close", formatPriceOrDash(previousClose)],
      ["Market state", raw.marketState || "--"]
    ];
  const panels = {
    financials: [
      ["Current price", formatPriceOrDash(row.price)],
      [changeLabel, `${formatSignedPriceOrDash(row.changeAmount)} ${formatPercentOrDash(row.changePercent)}`],
      ["Volume", formatCompact(row.volume)],
      ...sessionItems,
      ["Currency", currency],
      ["Last scan", formatDate(row.scannedAt)]
    ],
    valuation: [
      ["Selected metric", topMetricName()],
      ["Selected price", formatPriceOrDash(display.price)],
      ["Selected change", `${formatSignedPriceOrDash(display.amount)} ${formatPercentOrDash(display.percent)}`],
      ["Signal rank", row.signalRank || "--"],
      ["Active change", formatPercentOrDash(row.activeChangePercent)],
      ["Regular market", formatPriceOrDash(regularMarketPrice)],
      ["Latest chart price", formatPriceOrDash(latestChartPrice)],
      ["Market cap", marketCap ? formatCompact(marketCap) : "--"],
      ["Volume", formatCompact(row.volume)],
      ["Source", row.source || "--"],
      ["P/E", raw.trailingPE ? formatNumber(raw.trailingPE) : "--"]
    ],
    profile: [
      ["Name", row.name || "--"],
      ["Symbol", row.symbol || "--"],
      ["Exchange", row.exchange || "--"],
      ["Sector", row.sector || "--"],
      ["Type", row.type || raw.quoteType || "--"],
      ["Market", state.market],
      ["Currency", currency],
      ["Quote type", raw.quoteType || "--"],
      ["Data source", row.source || "--"],
      ["Last scan", formatDate(row.scannedAt)],
      ["Details", row.detailUrl ? `<a href="${escapeHtml(row.detailUrl)}" target="_blank" rel="noopener noreferrer">Open details</a>` : "--"]
    ]
  };

  const items = panels[state.detailTab] || panels.financials;
  elements.detailsPanel.innerHTML = detailGridHtml(items);
}

function detailGridHtml(items) {
  return `
    <div class="detailGrid">
      ${items.map(([label, value]) => `
        <div class="detailItem">
          <span>${escapeHtml(label)}</span>
          <strong>${String(value).startsWith("<a ") ? value : escapeHtml(value)}</strong>
        </div>
      `).join("")}
    </div>
  `;
}

function topMetricName() {
  if (isMarketWatchMarket(state.market)) {
    return {
      publishedAt: "Published",
      source: "Source",
      factor: "Macro factor",
      impactScore: "Impact"
    }[activeSortBy()] || "Published";
  }

  if (isEarningsMarket(state.market)) {
    return {
      reportDate: "Report date",
      symbol: "Symbol",
      name: "Company",
      quarter: "Quarter",
      marketCapValue: "Market cap"
    }[activeSortBy()] || "Report date";
  }

  if (isCryptoMarket(state.market)) {
    return {
      changePercent: "24h change %",
      price: "Current price"
    }[activeSortBy()] || "24h change %";
  }

  return {
    changePercent: "Current change %",
    price: "Current price",
    preMarketPrice: "Pre-market price",
    postMarketPrice: "After-hours price",
    overnightPrice: "Overnight price",
    preMarketChangePercent: "Pre-market change %",
    postMarketChangePercent: "After-hours change %",
    overnightChangePercent: "Overnight change %",
    closePrice: "Close price",
    closeChangePercent: "Close change %"
  }[activeSortBy()] || "Current change %";
}

function renderSectorOptions() {
  const sectors = state.sectors || [];
  const current = sectors.includes(state.sector) ? state.sector : "";
  if (current !== state.sector) state.sector = current;

  const allLabel = isMarketWatchMarket(state.market)
    ? "All factors"
    : isEarningsMarket(state.market) ? "All quarters" : "All sectors";
  elements.sectorSelect.innerHTML = [
    `<option value="">${allLabel}</option>`,
    ...sectors.map((sector) => `<option value="${escapeHtml(sector)}">${escapeHtml(sector)}</option>`)
  ].join("");
  elements.sectorSelect.value = state.sector;
}

function chartMetaText(row, payload) {
  const candles = payload.candles || [];
  const last = candles[candles.length - 1] || {};
  const open = formatPriceOrDash(last.open);
  const high = formatPriceOrDash(last.high);
  const low = formatPriceOrDash(last.low);
  const close = formatPriceOrDash(last.close);
  return `O ${open}  H ${high}  L ${low}  C ${close}  Vol ${formatCompact(last.volume)}  ${escapePlain(row.name)}`;
}

function drawEmptyChart() {
  const canvas = elements.priceChart;
  const context = canvas.getContext("2d");
  resizeCanvas(canvas, context);
  const { width, height } = canvas.getBoundingClientRect();
  context.clearRect(0, 0, width, height);
  drawGrid(context, width, height, 46, width - 46);
  chartState = { candles: [], row: null, hoverIndex: null, geometry: null };
}

function drawChart(candles, row) {
  const canvas = elements.priceChart;
  const context = canvas.getContext("2d");
  resizeCanvas(canvas, context);
  const { width, height } = canvas.getBoundingClientRect();
  context.clearRect(0, 0, width, height);

  if (!candles.length) {
    drawGrid(context, width, height, 46, width - 46);
    return;
  }

  const priceTop = 22;
  const priceBottom = Math.floor(height * 0.78);
  const volumeTop = priceBottom + 22;
  const volumeBottom = height - 24;
  const left = 46;
  const right = width - (isIndianMarket(state.market) ? 88 : 46);
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
  chartState = {
    ...chartState,
    candles,
    row,
    geometry: { left, right, priceTop, priceBottom, volumeTop, volumeBottom, low, high, step, visible }
  };

  drawGrid(context, width, height, left, right);

  context.font = "11px Inter, system-ui, sans-serif";
  context.textAlign = "right";
  context.textBaseline = "middle";
  context.fillStyle = "#475467";
  for (let index = 0; index <= 5; index += 1) {
    const value = low + ((high - low) * (5 - index)) / 5;
    const y = priceTop + ((high - value) / (high - low)) * (priceBottom - priceTop);
    context.fillText(formatChartPrice(value), width - 8, y);
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

  if (state.showIndicators) {
    drawMovingAverage(context, visible, { left, step, low, high, priceBottom, priceTop });
  }

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
    const lastPriceLabel = formatChartPrice(lastPrice);
    const labelWidth = Math.max(40, context.measureText(lastPriceLabel).width + 14);
    context.fillStyle = row.changePercent < 0 ? "#ff3f5f" : "#00c477";
    context.fillRect(right + 4, y - 10, labelWidth, 20);
    context.fillStyle = "#ffffff";
    context.textAlign = "center";
    context.fillText(lastPriceLabel, right + 4 + labelWidth / 2, y + 1);
  }

  context.textAlign = "left";
  context.fillStyle = "#667085";
  context.fillText(`Volume ${formatCompact(visible[visible.length - 1]?.volume)}`, left, volumeTop - 9);

  if (Number.isInteger(chartState.hoverIndex)) {
    drawCrosshair(context, chartState.hoverIndex);
  }
}

function handleChartHover(event) {
  if (!chartState.geometry?.visible?.length) return;
  const rect = elements.priceChart.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const { left, right, step, visible } = chartState.geometry;
  if (x < left || x > right) return;
  const index = clamp(Math.round((x - left - step / 2) / step), 0, visible.length - 1);
  chartState.hoverIndex = index;
  const candle = visible[index];
  elements.chartMeta.textContent = candleMetaText(candle);
  drawChart(chartState.candles, chartState.row);
}

function drawCrosshair(context, index) {
  const { left, right, priceTop, volumeBottom, low, high, priceBottom, step, visible } = chartState.geometry;
  const candle = visible[index];
  const x = left + index * step + step / 2;
  const y = scale(candle.close, low, high, priceBottom, priceTop);

  context.save();
  context.strokeStyle = "rgba(71, 84, 103, 0.7)";
  context.lineWidth = 1;
  context.setLineDash([3, 5]);
  context.beginPath();
  context.moveTo(x, priceTop);
  context.lineTo(x, volumeBottom);
  context.moveTo(left, y);
  context.lineTo(right, y);
  context.stroke();
  context.setLineDash([]);

  const closeLabel = formatChartPrice(candle.close);
  const labelWidth = Math.max(46, context.measureText(closeLabel).width + 14);
  context.fillStyle = "#eef4ff";
  context.fillRect(right + 4, y - 10, labelWidth, 20);
  context.fillStyle = "#101828";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(closeLabel, right + 4 + labelWidth / 2, y);
  context.restore();
}

function drawMovingAverage(context, visible, geometry) {
  const period = 20;
  const points = [];
  for (let index = 0; index < visible.length; index += 1) {
    const slice = visible.slice(Math.max(0, index - period + 1), index + 1);
    if (slice.length < Math.min(period, index + 1)) continue;
    const avg = slice.reduce((sum, candle) => sum + Number(candle.close), 0) / slice.length;
    points.push({
      x: geometry.left + index * geometry.step + geometry.step / 2,
      y: scale(avg, geometry.low, geometry.high, geometry.priceBottom, geometry.priceTop)
    });
  }

  if (points.length < 2) return;
  context.save();
  context.strokeStyle = "#f2b94b";
  context.lineWidth = 1.5;
  context.beginPath();
  points.forEach((point, index) => {
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  context.stroke();
  context.restore();
}

function candleMetaText(candle) {
  return `${formatChartTime(candle.time)}  O ${formatPriceOrDash(candle.open)}  H ${formatPriceOrDash(candle.high)}  L ${formatPriceOrDash(candle.low)}  C ${formatPriceOrDash(candle.close)}  Vol ${formatCompact(candle.volume)}`;
}

function drawGrid(context, width, height, left, right) {
  const priceTop = 22;
  const priceBottom = Math.floor(height * 0.78);
  const volumeBottom = height - 24;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "rgba(203, 213, 225, 0.75)";
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
  context.strokeStyle = "rgba(148, 163, 184, 0.75)";
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
  const pagination = elements.pageInfo.closest(".pagination");
  if (pagination) pagination.hidden = isMarketWatchMarket(state.market);
  if (isMarketWatchMarket(state.market)) return;
  elements.pageInfo.textContent = `Page ${state.page} of ${state.totalPages} | ${formatCompact(state.total)} matches`;
  elements.prevPageButton.disabled = state.isLoading || state.page <= 1;
  elements.nextPageButton.disabled = state.isLoading || state.page >= state.totalPages;
}

function describeStorage(storage) {
  if (!storage) return "--";
  if (isMarketWatchMarket(state.market)) return storage.source || "Rolling 7-day cache";
  if (!storage.enabled) return "Env needed";
  if (storage.error) return storage.error;
  if (storage.warning) return storage.warning;
  return `${storage.inserted || 0} rows stored`;
}

function updateRealtimeStatus() {
  const intervalSeconds = Math.round(refreshIntervalMs() / 1000);
  if (!state.autoRefresh) {
    elements.realtimeStatus.textContent = "Paused";
    return;
  }

  if (state.isLoading) {
    elements.realtimeStatus.textContent = "Scanning now";
    return;
  }

  if (!state.nextRefreshAt) {
    elements.realtimeStatus.textContent = `Auto ${intervalSeconds}s`;
    return;
  }

  const seconds = Math.max(0, Math.ceil((state.nextRefreshAt - Date.now()) / 1000));
  elements.realtimeStatus.textContent = `Next ${seconds}s`;
}

function refreshIntervalMs() {
  return isMarketWatchMarket(state.market) ? 15_000 : REFRESH_MS;
}

function formatDate(value) {
  if (!value) return "--";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium"
  }).format(new Date(value));
}

function formatChartTime(value) {
  if (!value) return "--";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric"
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

function formatPrice(value) {
  if (!Number.isFinite(Number(value))) return "--";
  const number = Number(value);
  if (!isIndianMarket(state.market)) return formatNumber(number);
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: number < 1 ? 6 : 2
  }).format(number);
}

function formatPriceOrDash(value) {
  return Number.isFinite(Number(value)) ? formatPrice(Number(value)) : "--";
}

function formatChartPrice(value) {
  if (!Number.isFinite(Number(value))) return "--";
  return isIndianMarket(state.market)
    ? `₹${formatNumber(Number(value))}`
    : formatNumber(Number(value));
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

function formatSignedPriceOrDash(value) {
  if (!Number.isFinite(Number(value))) return "--";
  if (!isIndianMarket(state.market)) return formatSigned(Number(value));
  const number = Number(value);
  const sign = number > 0 ? "+" : number < 0 ? "-" : "";
  return `${sign}${formatPrice(Math.abs(number))}`;
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(Number(value) * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
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

function playAlertSound(type = "up") {
  if (state.muteAlerts) return;

  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();

    const playBeep = (time, freq) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, time); // Custom pitch
      gain.gain.setValueAtTime(0.1, time); // Low volume
      gain.gain.exponentialRampToValueAtTime(0.00001, time + 0.1); // Fade out very quickly
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(time);
      osc.stop(time + 0.1);
    };

    const now = ctx.currentTime;
    if (type === "up" || type === "both") {
      playBeep(now, 880);        // High pitch (A5) for gains
      playBeep(now + 0.15, 880);
    }
    if (type === "down" || type === "both") {
      playBeep(now, 330);        // Lower pitch (E4) for drops
      playBeep(now + 0.15, 330);
    }
  } catch (e) {
    console.warn("Audio alert failed", e);
  }
}

function triggerVisualAlert(type) {
  elements.workspace.classList.remove("flash-up", "flash-down", "flash-both");
  void elements.workspace.offsetWidth; // Trigger reflow to restart animation if already running
  elements.workspace.classList.add(`flash-${type}`);
  setTimeout(() => {
    elements.workspace.classList.remove(`flash-${type}`);
  }, 1500);
}
