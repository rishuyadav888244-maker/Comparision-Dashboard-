"use strict";

/* Prediction view. Loaded after dashboard.js and reuses its shared helpers. */
(() => {
  const HORIZONS = {
    Year: { unit: "months", values: [3, 6, 12], fallback: 6 },
    Month: { unit: "years", values: [1, 2, 3], fallback: 1 },
    Period: { unit: "months", values: [3, 6, 12], fallback: 3 },
  };
  const ui = { ready: false, data: null, view: "charts", loading: false };

  function el(tag, className = "", text = null) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== null) node.textContent = text;
    return node;
  }

  const fullFormat = (kind) => (kind === "currency" ? money : number);
  const shortFormat = (kind) => (kind === "currency" ? compactMoney : number);

  function changeText(pct) {
    if (pct === null || pct === undefined || !Number.isFinite(pct)) return "—";
    return `${pct > 0 ? "▲ +" : pct < 0 ? "▼ −" : ""}${Math.abs(pct).toFixed(1)}%`;
  }

  function changeTone(pct, goodWhenUp) {
    if (!pct) return "";
    return (pct > 0) === goodWhenUp ? "positive" : "negative";
  }

  /* ---------------------------------------------------------------- view */
  function buildView() {
    const comparison = $("#comparison-content");
    const viewMode = $("#comparison-view-mode");
    if (!comparison || !viewMode) return;
    viewMode.add(new Option("Prediction", "prediction"));

    // Prediction filters live INSIDE the existing comparison panel and replace
    // the comparison filters while "Prediction" is selected.
    const panel = document.querySelector("#comparison-view .comparison-controls");
    if (!panel) return;
    const controls = document.createElement("div");
    controls.id = "comparison-prediction-controls";
    controls.className = "prediction-filter-grid is-hidden";
    controls.innerHTML = `
      <label class="field"><span>Hospital</span><select id="prediction-hospital"></select></label>
      <label class="field prediction-field-wide"><span>Predict using</span>
        <select id="prediction-mode">
          <option value="Year">Year · all months of data</option>
          <option value="Month">Month · same month every year</option>
          <option value="Period">Period · same period every month</option>
        </select>
      </label>
      <div id="prediction-dynamic" class="prediction-dynamic-fields"></div>
      <label class="field"><span>Forecast ahead</span><select id="prediction-horizon"></select></label>
      <div class="comparison-filter-actions">
        <button class="button button-primary comparison-apply" id="apply-prediction" type="button">Predict</button>
        <button class="button button-secondary comparison-reset" id="reset-prediction" type="button">Reset</button>
      </div>
    `;
    panel.append(controls);
    const style = document.createElement("style");
    style.textContent = `
      #comparison-view .prediction-filter-grid { display: flex; flex-wrap: nowrap; align-items: flex-end; gap: 6px; }
      #comparison-view .prediction-filter-grid .field { flex: 1 1 140px; min-width: 0; }
      #comparison-view .prediction-filter-grid .prediction-field-wide { flex: 1.5 1 200px; }
      #comparison-view .prediction-filter-grid .prediction-dynamic-fields { display: contents; }
      #comparison-view .prediction-filter-grid .comparison-filter-actions { flex: 0 0 auto; }
      @media (max-width: 900px) { #comparison-view .prediction-filter-grid { flex-wrap: wrap; } }
      #prediction-kpis { grid-template-columns: repeat(5, minmax(0, 1fr)); }
      @media (max-width: 1000px) { #prediction-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }`;
    document.head.append(style);

    const heading = panel.querySelector(".comparison-controls-heading h2");
    const badge = panel.querySelector(".comparison-header-badge");
    const compareGrid = panel.querySelector(".comparison-filter-grid");
    const original = {
      title: heading ? heading.textContent : "",
      badge: badge ? badge.textContent : "",
    };
    ui.sync = () => {
      const predicting = viewMode.value === "prediction";
      if (compareGrid) compareGrid.classList.toggle("is-hidden", predicting);
      controls.classList.toggle("is-hidden", !predicting);
      if (heading) heading.textContent = predicting ? "Predict hospital performance" : original.title;
      if (badge) badge.textContent = predicting ? "FORECAST" : original.badge;
      if (predicting) refreshHospitals();
    };
    viewMode.addEventListener("change", ui.sync);

    const results = document.createElement("section");
    results.id = "comparison-prediction-view";
    results.className = "comparison-prediction-only";
    results.innerHTML = `
      <div id="prediction-content" data-view="charts">
        <div class="section-heading">
          <div><h2 id="prediction-title">Prediction</h2></div>
          <span class="section-note" id="prediction-confidence"></span>
        </div>
        <div id="prediction-kpis" class="kpi-grid"></div>
        <div class="prediction-charts-only"><div id="prediction-charts" class="chart-grid"></div></div>
        <div id="prediction-entities"></div>
        <div class="prediction-numbers-only"><div id="prediction-tables" class="comparison-trend-tables"></div></div>
        <div id="prediction-services"></div>
        <div id="prediction-summary" class="prediction-summary"></div>
      </div>`;
    comparison.append(results);

    $("#prediction-hospital").addEventListener("change", (event) => {
      const source = $("#comparison-hospital");
      if (source) source.value = event.target.value;
    });
    $("#prediction-mode").addEventListener("change", buildModeFields);
    $("#apply-prediction").addEventListener("click", loadPrediction);
    $("#reset-prediction").addEventListener("click", () => {
      $("#prediction-mode").value = "Year";
      buildModeFields();
      loadPrediction();
    });
    window.addEventListener("resize", drawCharts);
    window.addEventListener("comparison-prediction-selected", showPrediction);
  }

  function refreshHospitals() {
    const source = $("#comparison-hospital");
    const target = $("#prediction-hospital");
    if (!source || !target) return;
    const values = [...source.options].map((option) => option.value);
    addOptions(target, values.length ? values : ["All Hospitals"], {
      selected: source.value || "All Hospitals",
    });
  }

  function showPrediction() {
    if (ui.sync) ui.sync();
    if (!ui.ready) {
      ui.ready = true;
      buildModeFields();
      loadPrediction();
    } else {
      drawCharts();
    }
  }

  function buildModeFields() {
    const mode = $("#prediction-mode").value;
    const holder = $("#prediction-dynamic");
    holder.replaceChildren();
    const addSelect = (label, name, values, selected) => {
      const wrapper = el("label", "field");
      const select = document.createElement("select");
      select.name = name;
      addOptions(select, values, { selected });
      wrapper.append(el("span", "", label), select);
      holder.append(wrapper);
    };
    if (mode === "Month") {
      addSelect("Month", "month", MONTH_NAMES, MONTH_NAMES[new Date().getMonth()]);
    } else if (mode === "Period") {
      addSelect("Period", "period", PERIODS, PERIODS[0]);
    }
    const config = HORIZONS[mode];
    addOptions($("#prediction-horizon"), config.values.map((value) => ({
      value, label: `Next ${value} ${config.unit}`,
    })), { selected: String(config.fallback) });
  }

  function currentFilters() {
    const filters = {
      predictBy: $("#prediction-mode").value,
      horizon: $("#prediction-horizon").value,
    };
    document.querySelectorAll("#prediction-dynamic [name]").forEach((input) => {
      filters[input.name] = input.value;
    });
    return filters;
  }

  async function loadPrediction() {
    if (ui.loading) return;
    ui.loading = true;
    const button = $("#apply-prediction");
    button.disabled = true;
    button.textContent = "Predicting…";
    try {
      const query = new URLSearchParams({
        hospital: $("#prediction-hospital").value || "All Hospitals",
        filters: JSON.stringify(currentFilters()),
      });
      const data = await request(`/api/prediction?${query.toString()}`);
      if (!data.hasData) {
        toast(data.message || "No data available for this prediction.", true);
        return;
      }
      ui.data = data;
      render(data);
    } catch (error) {
      toast(error.message, true);
    } finally {
      ui.loading = false;
      button.disabled = false;
      button.textContent = "Predict";
    }
  }

  /* -------------------------------------------------------------- render */
  function render(data) {
    window.__PREDICTION_REPORT_DATA__ = data;
    $("#prediction-title").textContent = `Next ${data.horizon} ${data.unit} forecast`;
    $("#prediction-confidence").textContent = `Confidence: ${data.confidence}`
      + (data.accuracy !== null && data.accuracy !== undefined
        ? ` · typical error ±${data.accuracy}%`
        : ` (${data.points} data points)`);
    renderSummary(data);
    renderKpis(data);
    renderChartCards(data);
    renderEntities(data);
    renderTables(data);
    renderServices(data);
    applyView();
  }

  function applyView() {
    $("#prediction-content").dataset.view = ui.view;
    window.requestAnimationFrame(drawCharts);
  }

  function renderSummary(data) {
    const holder = $("#prediction-summary");
    holder.replaceChildren();
    const summary = data.summary;
    if (!summary || !(summary.highlights || []).length) return;
    const heading = el("div", "section-heading");
    const titleBox = el("div");
    titleBox.append(el("h2", "", `What is changing in the next ${data.horizon} ${data.unit}`));
    heading.append(titleBox);
    const list = el("ul", "comparison-summary");
    list.setAttribute("aria-live", "polite");
    summary.highlights.forEach((item) => {
      const row = el("li", item.tone === "positive" || item.tone === "negative" ? item.tone : "");
      row.append(el("strong", "", `${item.title}: `), document.createTextNode(item.text));
      list.append(row);
    });
    holder.append(heading, list);
  }

  const KPI_KEYS = ["admissions", "discharges", "opd", "revenue", "credit_due"];
  const plural = (unit, count) => (count === 1 ? unit.replace(/s$/, "") : unit);

  function renderKpis(data) {
    const grid = $("#prediction-kpis");
    grid.replaceChildren();
    const span = `${data.horizon} ${plural(data.unit, data.horizon)}`;
    KPI_KEYS.forEach((key) => {
      const metric = data.metrics.find((item) => item.key === key);
      if (!metric) return;
      const summary = metric.summary;
      const card = el("article", "kpi-card");
      card.append(
        el("span", "kpi-label", metric.label),
        el("div", "kpi-value", fullFormat(metric.kind)(summary.horizonTotal)),
      );
      const sub = el("div", "kpi-sub", `Next ${span} · `);
      // Compare per-period averages so a shorter history is still a fair comparison.
      const recentAverage = summary.recentCount ? summary.recentTotal / summary.recentCount : null;
      const pct = recentAverage ? (summary.horizonTotal / data.horizon - recentAverage) / recentAverage * 100 : null;
      if (pct !== null) {
        sub.append(el("span", changeTone(pct, metric.goodWhenUp),
          `${changeText(pct)} vs previous ${summary.recentCount} ${plural(data.unit, summary.recentCount)}`));
      }
      if (key === "revenue") {
        const targetTotal = metric.rows
          .filter((row) => row.forecast !== null && Number.isFinite(row.target))
          .reduce((sum, row) => sum + row.target, 0);
        if (targetTotal > 0) {
          sub.append(document.createTextNode(` · ${(summary.horizonTotal / targetTotal * 100).toFixed(0)}% of target`));
        }
      }
      card.append(sub);
      grid.append(card);
    });
  }

  function renderChartCards(data) {
    const grid = $("#prediction-charts");
    grid.replaceChildren();
    data.metrics.forEach((metric) => {
      const hasTarget = metric.rows.some((row) => Number.isFinite(row.target));
      const card = el("article", "panel chart-card");
      const heading = el("div", "chart-heading");
      const title = el("div");
      title.append(el("h3", "", metric.label));
      const legend = el("span", "legend");
      legend.innerHTML = '<i class="legend-dot blue"></i>Actual '
        + '<i class="legend-dot orange"></i>Forecast'
        + (hasTarget ? ' <i class="legend-dot prediction-target-dot"></i>Target' : "");
      heading.append(title, legend);
      const wrap = el("div", "chart-wrap");
      const canvas = document.createElement("canvas");
      canvas.setAttribute("aria-label", `${metric.label} forecast chart`);
      canvas.predictionMetric = {
        ...metric,
        rows: visibleRows(metric.rows, data),
        connect: data.connectForecast !== false,
      };
      wrap.append(canvas);
      card.append(heading, wrap);
      const footer = el("div", "chart-total");
      const format = fullFormat(metric.kind);
      renderTotalItems(footer, [
        { label: `Next · ${metric.summary.nextLabel}`, value: metric.summary.next, formatter: format },
        { label: `Total next ${data.horizon} ${data.unit}`, value: metric.summary.horizonTotal, formatter: format },
      ]);
      card.append(footer);
      grid.append(card);
    });
  }

  const ENTITY_METRICS = [
    { key: "ipd_revenue", label: "IPD revenue", kind: "currency" },
    { key: "discharges", label: "IPD discharges", kind: "count" },
    { key: "admissions", label: "IPD admissions", kind: "count" },
    { key: "opd", label: "OPD consultations", kind: "count" },
  ];
  const ENTITY_DIMENSIONS = [
    ["departments", "department"],
    ["doctors", "doctor"],
    ["panels", "panel"],
  ];
  ui.entityMetric = "ipd_revenue";

  function renderEntities(data) {
    const holder = $("#prediction-entities");
    holder.replaceChildren();
    if (!data.breakdown) return;
    const summary = data.metrics[0].summary;
    const lastLabel = `Last (${summary.previousLabel})`;
    const nextLabel = `Forecast (${summary.nextLabel})`;
    const metric = ENTITY_METRICS.find((item) => item.key === ui.entityMetric) || ENTITY_METRICS[0];

    const heading = el("div", "section-heading");
    const titleBox = el("div");
    titleBox.append(el("h2", "", `Department, doctor and panel forecast · ${summary.nextLabel}`));
    heading.append(titleBox);

    const tabs = el("div", "comparison-mover-tabs");
    tabs.setAttribute("role", "tablist");
    ENTITY_METRICS.forEach((item) => {
      const button = el("button", "", item.label);
      button.type = "button";
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(item.key === metric.key));
      button.addEventListener("click", () => {
        ui.entityMetric = item.key;
        renderEntities(data);
      });
      tabs.append(button);
    });

    const legend = el("div", "comparison-chart-legend");
    [["", lastLabel], ["second", nextLabel]].forEach(([extra, text]) => {
      const item = el("span", "comparison-chart-legend-item");
      item.append(el("i", `comparison-chart-legend-dot${extra ? ` ${extra}` : ""}`), el("strong", "", text));
      legend.append(item);
    });

    const grid = el("div", "comparison-chart-grid-2");
    const containers = ENTITY_DIMENSIONS.map(([dimension, label], index) => {
      const card = el("article",
        `panel chart-card comparison-mini-card${index === 2 ? " comparison-mini-card-wide" : ""}`);
      const cardHeading = el("div", "chart-heading");
      cardHeading.append(el("h3", "", `${metric.label} by ${label}`));
      const container = el("div", "comparison-column-chart comparison-compact-chart");
      container.setAttribute("role", "img");
      card.append(cardHeading, container);
      grid.append(card);
      return [dimension, container];
    });
    holder.append(heading, tabs, legend, grid);

    const currency = metric.kind === "currency";
    containers.forEach(([dimension, container]) => {
      const rows = ((data.breakdown[dimension] || {})[metric.key] || []).map((row) => ({
        label: row.name, first: row.previous, second: row.next,
      }));
      renderComparisonColumnChart(
        container, rows,
        [{ key: "first", label: lastLabel }, { key: "second", label: nextLabel }],
        currency ? compactMoney : number, null, null, currency ? "currency" : "count",
      );
    });
  }

  function renderTables(data) {
    const holder = $("#prediction-tables");
    holder.replaceChildren();
    data.metrics.forEach((metric) => {
      const format = fullFormat(metric.kind);
      const hasTarget = metric.rows.some((row) => Number.isFinite(row.target));
      const card = el("article", "panel comparison-trend-table-card");
      card.append(el("h3", "", metric.label));
      const table = el("table", "comparison-trend-table prediction-table");
      const head = el("thead");
      const headRow = el("tr");
      ["Period", "Actual", "Forecast", "Likely range", ...(hasTarget ? ["Target"] : [])]
        .forEach((text) => headRow.append(el("th", "", text)));
      head.append(headRow);
      const body = el("tbody");
      metric.rows.slice(-(12 + data.horizon)).forEach((row) => {
        const tr = el("tr", row.forecast !== null ? "prediction-forecast-row" : "");
        tr.append(el("th", "", row.label + (row.partial ? " (so far)" : "")));
        tr.append(el("td", "", row.actual === null ? "—" : format(row.actual)));
        tr.append(el("td", "prediction-forecast-cell", row.forecast === null ? "—" : format(row.forecast)));
        tr.append(el("td", "", row.forecast === null ? "—" : `${format(row.lower)} – ${format(row.upper)}`));
        if (hasTarget) tr.append(el("td", "", Number.isFinite(row.target) ? format(row.target) : "—"));
        body.append(tr);
      });
      table.append(head, body);
      card.append(table);
      holder.append(card);
    });
  }

  function renderServices(data) {
    const holder = $("#prediction-services");
    holder.replaceChildren();
    const card = el("article", "panel comparison-trend-table-card prediction-services-card");
    card.append(el("h3", "", `Top OPD services — forecast for ${data.metrics[0].summary.nextLabel}`));
    if (!data.services.length) {
      card.append(el("p", "comparison-trend-note", "No OPD service records (other than consultation) in this selection."));
      holder.append(card);
      return;
    }
    const table = el("table", "comparison-trend-table prediction-table");
    const head = el("thead");
    const headRow = el("tr");
    ["Service", "Last period", "Forecast", "Likely range", "Change"]
      .forEach((text) => headRow.append(el("th", "", text)));
    head.append(headRow);
    const body = el("tbody");
    data.services.forEach((row) => {
      const change = row.previous ? (row.next - row.previous) / row.previous * 100 : null;
      const tr = el("tr");
      tr.append(el("th", "", row.name));
      tr.append(el("td", "", number(row.previous)));
      tr.append(el("td", "prediction-forecast-cell", number(row.next)));
      tr.append(el("td", "", `${number(row.lower)} – ${number(row.upper)}`));
      tr.append(el("td", `change ${change > 0 ? "increase" : change < 0 ? "decrease" : "neutral"}`,
        changeText(change)));
      body.append(tr);
    });
    table.append(head, body);
    card.append(table);
    holder.append(card);
  }

  /* --------------------------------------------------------------- chart */
  function drawCharts() {
    const section = $("#comparison-prediction-view");
    if (!section || $("#comparison-content").dataset.view !== "prediction") return;
    document.querySelectorAll("#prediction-charts canvas").forEach((canvas) => {
      if (canvas.predictionMetric) drawForecastChart(canvas, canvas.predictionMetric);
    });
  }

  // The forecast is fitted on ALL history, but only the recent part is drawn
  // so that the forecast gets most of the room.
  function visibleRows(rows, data) {
    if (data.mode === "Month") return rows;   // the server already sends a recent window
    const firstForecast = rows.findIndex((row) => row.forecast !== null);
    if (firstForecast < 0) return rows;
    const keep = Math.min(12, Math.max(6, data.horizon * 2));
    return rows.slice(Math.max(0, firstForecast - keep));
  }

  // Forecast columns are drawn wider than history columns (about 45% of the width).
  const FORECAST_SHARE = 0.45;

  function slotLayout(rows, chartWidth) {
    const flags = rows.map((row) => row.forecast !== null);
    const forecastCount = flags.filter(Boolean).length;
    const historyCount = rows.length - forecastCount;
    let weight = 1;
    if (forecastCount && historyCount) {
      weight = Math.min(3.2, Math.max(1,
        (FORECAST_SHARE / (1 - FORECAST_SHARE)) * historyCount / forecastCount));
    }
    const weights = flags.map((flag) => (flag ? weight : 1));
    const total = weights.reduce((sum, value) => sum + value, 0);
    let cursor = 0;
    const starts = weights.map((value) => { const start = cursor; cursor += value; return start; });
    return {
      start: (index) => starts[index] / total * chartWidth,
      center: (index) => (starts[index] + weights[index] / 2) / total * chartWidth,
    };
  }

  function drawForecastChart(canvas, metric) {
    const { context: ctx, width, height } = setupCanvas(canvas);
    ctx.clearRect(0, 0, width, height);
    const rows = metric.rows || [];
    if (!rows.length || width < 60 || height < 60) {
      drawEmpty(ctx, width, height);
      attachChartTooltip(canvas, []);
      return;
    }
    const axisFormat = shortFormat(metric.kind);
    const tipFormat = fullFormat(metric.kind);
    const connect = metric.connect !== false;
    const margin = { top: 26, right: 14, bottom: 36, left: 52 };
    const chartWidth = width - margin.left - margin.right;
    const chartHeight = height - margin.top - margin.bottom;
    const numbers = rows.flatMap((row) => [row.actual, row.upper, row.forecast, row.target])
      .filter((value) => Number.isFinite(value));
    const max = Math.max(...numbers, 1) * 1.08;
    const layout = slotLayout(rows, chartWidth);
    const xAt = (index) => margin.left + layout.center(index);
    const yAt = (value) => margin.top + chartHeight - chartHeight * value / max;
    const firstForecast = rows.findIndex((row) => row.forecast !== null);

    // forecast zone
    if (firstForecast >= 0) {
      const zoneLeft = margin.left + layout.start(firstForecast);
      ctx.fillStyle = "#f4f8fa";
      ctx.fillRect(zoneLeft, margin.top - 6, margin.left + chartWidth - zoneLeft, chartHeight + 6);
      ctx.fillStyle = COLORS.muted;
      ctx.font = "bold 9.5px Segoe UI, Arial";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText("FORECAST", zoneLeft + 5, margin.top - 3);
    }

    // grid + y axis
    ctx.font = "10px Segoe UI, Arial";
    ctx.textBaseline = "middle";
    for (let tick = 0; tick <= 3; tick += 1) {
      const y = margin.top + chartHeight - chartHeight * tick / 3;
      ctx.strokeStyle = COLORS.grid;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(margin.left, y); ctx.lineTo(width - margin.right, y); ctx.stroke();
      ctx.fillStyle = COLORS.muted;
      ctx.textAlign = "right";
      ctx.fillText(axisFormat(max * tick / 3), margin.left - 6, y);
    }

    // 80% likely range
    const bandRows = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.forecast !== null);
    if (connect && bandRows.length > 1) {
      ctx.fillStyle = "rgba(228, 149, 63, .18)";
      ctx.beginPath();
      bandRows.forEach(({ row, index }, i) => {
        if (i === 0) ctx.moveTo(xAt(index), yAt(row.upper)); else ctx.lineTo(xAt(index), yAt(row.upper));
      });
      [...bandRows].reverse().forEach(({ row, index }) => ctx.lineTo(xAt(index), yAt(row.lower)));
      ctx.closePath();
      ctx.fill();
    } else {
      bandRows.forEach(({ row, index }) => {
        ctx.fillStyle = "rgba(228, 149, 63, .22)";
        ctx.fillRect(xAt(index) - 7, yAt(row.upper), 14, Math.max(2, yAt(row.lower) - yAt(row.upper)));
      });
    }

    // target line
    const targetRows = rows.map((row, index) => ({ row, index })).filter(({ row }) => Number.isFinite(row.target));
    if (targetRows.length) {
      ctx.strokeStyle = "#9fb2bf";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      targetRows.forEach(({ row, index }, i) => {
        if (i === 0) ctx.moveTo(xAt(index), yAt(row.target)); else ctx.lineTo(xAt(index), yAt(row.target));
      });
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // actual line (history is only shown for comparison)
    const actualRows = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.actual !== null);
    const complete = actualRows.filter(({ row }) => !row.partial);
    ctx.strokeStyle = COLORS.blue;
    ctx.lineWidth = 2;
    ctx.beginPath();
    complete.forEach(({ row, index }, i) => {
      if (i === 0) ctx.moveTo(xAt(index), yAt(row.actual)); else ctx.lineTo(xAt(index), yAt(row.actual));
    });
    ctx.stroke();

    // forecast line, anchored on the last complete actual point
    const anchor = [...complete].reverse().find(({ index }) => index < firstForecast || firstForecast < 0);
    if (bandRows.length) {
      ctx.strokeStyle = COLORS.orange;
      ctx.lineWidth = 2.2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      const path = connect ? bandRows : bandRows.slice(0, 1);
      let started = false;
      if (anchor) { ctx.moveTo(xAt(anchor.index), yAt(anchor.row.actual)); started = true; }
      path.forEach(({ row, index }) => {
        if (!started) { ctx.moveTo(xAt(index), yAt(row.forecast)); started = true; }
        else ctx.lineTo(xAt(index), yAt(row.forecast));
      });
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // points, labels, hit boxes
    const hitboxes = [];
    const valueLabels = [];
    const lastCompleteIndexes = new Set(complete.slice(-3).map(({ index }) => index));
    actualRows.forEach(({ row, index }) => {
      const x = xAt(index);
      const y = yAt(row.actual);
      ctx.beginPath();
      ctx.arc(x, y, row.focus ? 5 : 3.2, 0, Math.PI * 2);
      ctx.fillStyle = row.partial ? "#fff" : COLORS.blue;
      ctx.fill();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = COLORS.blue;
      ctx.stroke();
      if (!row.partial && row.forecast === null && (row.focus || lastCompleteIndexes.has(index))) {
        valueLabels.push({ text: axisFormat(row.actual), x, y, color: COLORS.blue, priority: 1 });
      }
      hitboxes.push({
        x: x - 9, y: y - 9, width: 18, height: 18,
        label: `${row.label} · actual${row.partial ? " so far (month incomplete)" : ""}`,
        value: row.actual, formatter: tipFormat,
      });
    });
    bandRows.forEach(({ row, index }) => {
      const x = xAt(index);
      const y = yAt(row.forecast);
      ctx.beginPath();
      ctx.arc(x, y, 4.2, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.orange;
      ctx.fill();
      valueLabels.push({ text: axisFormat(row.forecast), x, y, color: "#a85f12", priority: 0 });
      hitboxes.push({
        x: x - 9, y: y - 9, width: 18, height: 18,
        label: `${row.label} · forecast (likely ${tipFormat(row.lower)} – ${tipFormat(row.upper)})`,
        value: row.forecast, formatter: tipFormat,
      });
    });

    ctx.font = "bold 10px Segoe UI, Arial";
    const placedLabels = [];
    valueLabels.sort((left, right) => left.priority - right.priority || left.x - right.x)
      .forEach((label) => {
        const textWidth = ctx.measureText(label.text).width;
        const halfWidth = textWidth / 2 + 3;
        for (const baseline of [label.y - 7, label.y + 18]) {
          const box = {
            left: label.x - halfWidth,
            right: label.x + halfWidth,
            top: baseline - 12,
            bottom: baseline + 2,
          };
          const insidePlot = box.left >= margin.left - 2
            && box.right <= width - margin.right + 2
            && box.top >= margin.top - 2
            && box.bottom <= height - margin.bottom + 2;
          const overlaps = placedLabels.some((other) =>
            box.left < other.right && box.right > other.left
              && box.top < other.bottom && box.bottom > other.top);
          if (!insidePlot || overlaps) continue;
          placedLabels.push(box);
          drawValueLabel(ctx, label.text, label.x, baseline, label.color);
          break;
        }
      });

    // x axis labels: left to right, keeping a minimum gap
    ctx.fillStyle = COLORS.muted;
    ctx.font = "10px Segoe UI, Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    let lastLabelX = -Infinity;
    rows.forEach((row, index) => {
      const x = xAt(index);
      if (x - lastLabelX < 52) return;
      lastLabelX = x;
      ctx.fillText(row.label, x, height - 15);
    });
    attachChartTooltip(canvas, hitboxes);
  }

  buildView();
})();