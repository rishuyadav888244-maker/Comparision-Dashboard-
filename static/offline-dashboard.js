"use strict";

const OFFLINE_FIELDS = {
  dataset: 0,
  doa: 1,
  dod: 2,
  type: 3,
  month: 4,
  department: 5,
  doctor: 6,
  panel: 7,
  serviceType: 8,
  service: 9,
  amount: 10,
  cash: 11,
  credit: 12,
  bedDays: 13,
  serviceAmount: 14,
};
const OFFLINE_PERIODS = ["1-10 Days", "11-20 Days", "21-31 Days"];
const OFFLINE_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const offlineReady = (async () => {
  const binary = Uint8Array.from(atob(window.__OFFLINE_BUNDLE__), (char) => char.charCodeAt(0));
  const stream = new Blob([binary]).stream().pipeThrough(new DecompressionStream("deflate"));
  const bundle = JSON.parse(await new Response(stream).text());
  window.__OFFLINE_DATA__ = bundle;
  document.documentElement.classList.add("offline-report");
  const footer = document.querySelector(".page-footer span:last-child");
  if (footer) footer.textContent = "Self-contained interactive report";
  const style = document.createElement("style");
  style.textContent = [
    ".offline-report #download-interactive, .offline-report #refresh-data,",
    ".offline-report .button-upload, .offline-report #upload-file,",
    ".offline-report #delete-dataset { display: none !important; }",
  ].join(" ");
  document.head.append(style);
})();
window.__OFFLINE_READY__ = offlineReady;
window.__OFFLINE_REPORT__ = true;

function offlineField(row, name) {
  return row[OFFLINE_FIELDS[name]];
}

function offlineEventDate(row) {
  const type = offlineField(row, "type");
  if (type === "Discharge") return offlineField(row, "dod");
  if (type === "Admission" || type === "OPD") return offlineField(row, "doa");
  return null;
}

function offlinePeriod(date) {
  if (!date) return null;
  const day = Number(date.slice(8, 10));
  return day <= 10 ? OFFLINE_PERIODS[0] : day <= 20 ? OFFLINE_PERIODS[1] : OFFLINE_PERIODS[2];
}

function offlineDatasetRows(datasetId) {
  const index = window.__OFFLINE_DATA__.datasets.findIndex((item) => item.dataset_id === datasetId);
  return window.__OFFLINE_DATA__.rows.filter((row) => row[0] === index);
}

function offlineMonths(rows) {
  const months = new Set();
  rows.forEach((row) => {
    const date = offlineEventDate(row);
    if (date) months.add(Number(date.slice(5, 7)));
  });
  return OFFLINE_MONTHS.filter((_, index) => months.has(index + 1));
}

function offlineRange(rows) {
  const dates = rows.map((row) => {
    const type = offlineField(row, "type");
    return type === "Discharge" ? offlineField(row, "dod")
      : ["Admission", "OPD"].includes(type) ? offlineField(row, "doa") : null;
  }).filter(Boolean).sort();
  return dates.length ? [dates[0], dates[dates.length - 1]] : [null, null];
}

function offlineFilter(rows, months = [], periods = []) {
  const monthSet = new Set(months.map((name) => OFFLINE_MONTHS.indexOf(name) + 1));
  const periodSet = new Set(periods);
  return rows.filter((row) => {
    const date = offlineEventDate(row);
    const type = offlineField(row, "type");
    if (monthSet.size) {
      const monthMatches = ["Admission", "OPD", "Discharge"].includes(type)
        ? date && monthSet.has(Number(date.slice(5, 7)))
        : monthSet.has(OFFLINE_MONTHS.indexOf(offlineField(row, "month")) + 1);
      if (!monthMatches) return false;
    }
    const periodEligible = ["Admission", "OPD", "Discharge"].includes(type);
    return !periodSet.size || (periodEligible && periodSet.has(offlinePeriod(date)));
  });
}

function offlineSum(rows, predicate, field) {
  return rows.reduce((total, row) => total + (predicate(row) ? Number(offlineField(row, field) || 0) : 0), 0);
}

function offlineGroup(rows, predicate, dimension, value = null) {
  const result = new Map();
  rows.forEach((row) => {
    if (!predicate(row)) return;
    const name = String(offlineField(row, dimension) || "").trim() || "Unknown";
    result.set(name, (result.get(name) || 0) + (value ? Number(offlineField(row, value) || 0) : 1));
  });
  return result;
}

function offlineRanked(map, limit = 10) {
  return [...map.entries()].sort((left, right) => right[1] - left[1])
    .slice(0, limit).map(([label, value]) => ({ label, value }));
}

function offlineMonthlyTarget(hospital) {
  if (hospital === "NIMMS Hospital") return 25500000;
  if (hospital === "All Hospitals") return 75500000;
  return 50000000;
}

function offlineTargetForRanges(monthlyTarget, ranges) {
  let target = 0;
  ranges.forEach(([start, end]) => {
    if (!start || !end || end < start) return;
    let cursor = new Date(`${start}T00:00:00`);
    const final = new Date(`${end}T00:00:00`);
    cursor.setDate(1);
    while (cursor <= final) {
      const year = cursor.getFullYear();
      const month = cursor.getMonth();
      const monthDays = new Date(year, month + 1, 0).getDate();
      const monthStart = new Date(year, month, 1);
      const monthEnd = new Date(year, month, monthDays);
      const rangeStart = new Date(`${start}T00:00:00`);
      const rangeEnd = new Date(`${end}T00:00:00`);
      const overlapStart = rangeStart > monthStart ? rangeStart : monthStart;
      const overlapEnd = rangeEnd < monthEnd ? rangeEnd : monthEnd;
      if (overlapEnd >= overlapStart) {
        target += monthlyTarget * (Math.floor((overlapEnd - overlapStart) / 86400000) + 1) / monthDays;
      }
      cursor = new Date(year, month + 1, 1);
    }
  });
  return target;
}

function offlineDashboardTarget(monthlyTarget, start, end, months, periods) {
  if (!start || !end) return monthlyTarget;
  const selectedMonths = new Set(months.map((month) => OFFLINE_MONTHS.indexOf(month) + 1));
  const selectedPeriods = new Set(periods);
  const ranges = [];
  const cursor = new Date(`${start}T00:00:00`);
  const final = new Date(`${end}T00:00:00`);
  cursor.setDate(1);
  while (cursor <= final) {
    const year = cursor.getFullYear();
    const month = cursor.getMonth() + 1;
    const days = new Date(year, month, 0).getDate();
    if ((!selectedMonths.size || selectedMonths.has(month)) && selectedPeriods.size) {
      selectedPeriods.forEach((period) => {
        const first = period === OFFLINE_PERIODS[0] ? 1 : period === OFFLINE_PERIODS[1] ? 11 : 21;
        const last = period === OFFLINE_PERIODS[0] ? 10 : period === OFFLINE_PERIODS[1] ? 20 : days;
        ranges.push([`${year}-${String(month).padStart(2, "0")}-${String(first).padStart(2, "0")}`,
          `${year}-${String(month).padStart(2, "0")}-${String(Math.min(last, days)).padStart(2, "0")}`]);
      });
    } else if (!selectedMonths.size || selectedMonths.has(month)) {
      ranges.push([`${year}-${String(month).padStart(2, "0")}-01`,
        `${year}-${String(month).padStart(2, "0")}-${String(days).padStart(2, "0")}`]);
    }
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return offlineTargetForRanges(monthlyTarget, ranges);
}

function offlineKpis(rows, hospital, target) {
  const discharge = (row) => offlineField(row, "type") === "Discharge";
  const opd = (row) => offlineField(row, "type") === "OPD";
  const admissions = rows.filter((row) => offlineField(row, "type") === "Admission").length;
  const discharges = rows.filter(discharge);
  const bedDays = offlineSum(rows, discharge, "bedDays");
  const doaDays = new Set(rows.map((row) => offlineField(row, "doa")).filter(Boolean)).size;
  const beds = hospital === "NIMMS Hospital" ? 50 : hospital === "All Hospitals" ? 205 : 155;
  const ipdRevenue = offlineSum(rows, discharge, "amount");
  const opdRevenue = offlineSum(rows, opd, "amount");
  return {
    revenue: ipdRevenue + opdRevenue,
    ipd_revenue: ipdRevenue,
    opd_revenue: opdRevenue,
    cash_due: offlineSum(rows, discharge, "cash"),
    credit_due: offlineSum(rows, discharge, "credit"),
    opd_consultation: rows.filter((row) => opd(row)
      && String(offlineField(row, "serviceType") || "").toLowerCase() === "consultation").length,
    admissions,
    discharges: discharges.length,
    bed_days: bedDays,
    alos: discharges.length ? bedDays / discharges.length : 0,
    occupancy: doaDays && beds ? bedDays / (beds * doaDays) * 100 : 0,
    achievement: target ? (ipdRevenue + opdRevenue) / target * 100 : 0,
    target,
  };
}

function offlineInsightMoney(value) {
  const amount = Number(value || 0);
  if (Math.abs(amount) >= 10000000) return `₹${(amount / 10000000).toFixed(2)} Cr`;
  if (Math.abs(amount) >= 100000) return `₹${(amount / 100000).toFixed(2)} L`;
  return `₹${Math.round(amount).toLocaleString("en-IN")}`;
}

function offlineInsights(rows, monthlyTarget) {
  const revenueRows = rows.filter((row) => ["OPD", "Discharge"].includes(offlineField(row, "type")));
  const ipdRows = revenueRows.filter((row) => offlineField(row, "type") === "Discharge");
  const opdRows = revenueRows.filter((row) => offlineField(row, "type") === "OPD");
  const sum = (list, field) => list.reduce(
    (total, row) => total + Number(offlineField(row, field) || 0), 0,
  );
  const ipdRevenue = sum(ipdRows, "amount");
  const opdRevenue = sum(opdRows, "amount");
  const totalRevenue = ipdRevenue + opdRevenue;
  const share = (amount, total) => total > 0 ? amount / total * 100 : 0;
  const leader = (list, dimension) => {
    const groups = offlineGroup(list, () => true, dimension, "amount");
    return [...groups.entries()].sort((left, right) => right[1] - left[1])[0] || ["—", 0];
  };
  const [department, departmentRevenue] = leader(ipdRows, "department");
  const [doctor, doctorRevenue] = leader(ipdRows, "doctor");
  const [panel, panelRevenue] = leader(ipdRows, "panel");
  const dateRevenue = new Map();
  revenueRows.forEach((row) => {
    const type = offlineField(row, "type");
    const date = type === "Discharge" ? offlineField(row, "dod") : offlineField(row, "doa");
    if (date) dateRevenue.set(date, (dateRevenue.get(date) || 0) + Number(offlineField(row, "amount") || 0));
  });
  const bestDay = [...dateRevenue.entries()].sort((left, right) => right[1] - left[1])[0];
  const achievedDays = [...dateRevenue.entries()].filter(([date, amount]) => {
    const parts = date.split("-").map(Number);
    const days = new Date(parts[0], parts[1], 0).getDate();
    return amount >= monthlyTarget / days;
  }).length;
  const grossAvailable = opdRows.some((row) => Number(offlineField(row, "serviceAmount")) > 0);
  const opdGross = grossAvailable ? sum(opdRows, "serviceAmount") : null;
  const discount = opdGross === null ? null : Math.max(0, opdGross - opdRevenue);
  const ipdBilling = ipdRows.some((row) => Number(offlineField(row, "serviceAmount")) > 0)
    ? sum(ipdRows, "serviceAmount") : ipdRevenue;
  const pending = sum(ipdRows, "credit");
  const leaderValue = (name, amount) => name === "—" ? "—"
    : `${name} · ${offlineInsightMoney(amount)} (${share(amount, ipdRevenue).toFixed(0)}% of IPD revenue)`;
  const bestDayLabel = bestDay ? new Date(`${bestDay[0]}T00:00:00`).toLocaleDateString(
    "en-GB", { day: "numeric", month: "short" },
  ) : "—";
  const items = [
    ["🎯", "Days daily target was met", dateRevenue.size ? `${achievedDays} of ${dateRevenue.size} days` : "—"],
    ["🏆", "Best earning day", bestDay ? `${bestDayLabel} · ${offlineInsightMoney(bestDay[1])}` : "—"],
    ["🔀", "Revenue from IPD vs OPD", totalRevenue ? `IPD ${share(ipdRevenue, totalRevenue).toFixed(0)}% · OPD ${share(opdRevenue, totalRevenue).toFixed(0)}%` : "—"],
    ["🏥", "Top earning department", leaderValue(department, departmentRevenue)],
    ["🩺", "Top earning doctor", leaderValue(doctor, doctorRevenue)],
    ["🏷️", "Top paying panel", leaderValue(panel, panelRevenue)],
    ["💳", "Payment still pending", `${offlineInsightMoney(pending)} (${share(pending, ipdBilling).toFixed(0)}% of IPD billing)`],
    ["🧾", "OPD gross amount", opdGross === null ? "—" : offlineInsightMoney(opdGross)],
    ["✅", "OPD final amount (received)", opdGross > 0 ? `${offlineInsightMoney(opdRevenue)} (${share(opdRevenue, opdGross).toFixed(0)}% of gross)` : offlineInsightMoney(opdRevenue)],
    ["🏷️", "OPD discount / concession", discount === null ? "—" : `${offlineInsightMoney(discount)} (${share(discount, opdGross).toFixed(0)}% of gross)`],
  ].map(([icon, label, value]) => ({ icon, label, value }));
  return {
    department, doctor, panel,
    day: bestDay ? bestDay[0] : "—",
    items,
  };
}

function offlineBucket(rows, predicate, dateField, granularity, valueField = null) {
  const grouped = new Map();
  rows.forEach((row) => {
    if (!predicate(row)) return;
    const date = dateField === "event" ? offlineEventDate(row) : offlineField(row, dateField);
    if (!date) return;
    const label = granularity === "monthly" ? `${OFFLINE_MONTHS[Number(date.slice(5, 7)) - 1].slice(0, 3)} ${date.slice(0, 4)}`
      : date.slice(8, 10) + " " + OFFLINE_MONTHS[Number(date.slice(5, 7)) - 1].slice(0, 3);
    grouped.set(label, (grouped.get(label) || 0) + (valueField ? Number(offlineField(row, valueField) || 0) : 1));
  });
  return [...grouped.entries()].map(([label, value]) => ({ label, value }));
}

function offlineServices(rows) {
  const groups = offlineGroup(rows, (row) => offlineField(row, "type") === "OPD"
    && offlineField(row, "service")
    && String(offlineField(row, "service")).toLowerCase() !== "consultation", "service");
  const services = [...groups.entries()].filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }));
  const singletons = [...groups.values()].filter((count) => count === 1).length;
  if (singletons) services.push({ label: "Others", value: singletons });
  return services;
}

function offlineCharts(rows, kpis, months, monthlyTarget) {
  const discharge = (row) => offlineField(row, "type") === "Discharge";
  const admission = (row) => offlineField(row, "type") === "Admission";
  const opd = (row) => offlineField(row, "type") === "OPD";
  const datedDischarges = rows.filter((row) => discharge(row) && offlineField(row, "dod"));
  const granularity = new Set(datedDischarges.map((row) => offlineField(row, "dod"))).size > 45 ? "monthly" : "daily";
  const patientFlow = new Map();
  rows.forEach((row) => {
    const type = offlineField(row, "type");
    if (!["Admission", "Discharge"].includes(type)) return;
    const date = type === "Discharge" ? offlineField(row, "dod") : offlineField(row, "doa");
    if (!date) return;
    const label = granularity === "monthly" ? `${OFFLINE_MONTHS[Number(date.slice(5, 7)) - 1].slice(0, 3)} ${date.slice(0, 4)}`
      : date.slice(8, 10) + " " + OFFLINE_MONTHS[Number(date.slice(5, 7)) - 1].slice(0, 3);
    if (!patientFlow.has(label)) patientFlow.set(label, { label });
    const rowData = patientFlow.get(label);
    const key = type === "Admission" ? "Admissions" : "Discharges";
    rowData[key] = (rowData[key] || 0) + 1;
  });
  const periodRevenue = new Map(OFFLINE_PERIODS.map((period) => [period, 0]));
  const periodDischarges = new Map(OFFLINE_PERIODS.map((period) => [period, 0]));
  const targetActual = new Map(OFFLINE_PERIODS.map((period) => [period, 0]));
  const monthNumbers = new Set((months || []).map((month) => OFFLINE_MONTHS.indexOf(month) + 1));
  rows.forEach((row) => {
    if (discharge(row)) {
      const date = offlineField(row, "dod");
      const period = offlinePeriod(date);
      if (period) {
        periodDischarges.set(period, periodDischarges.get(period) + 1);
        if (!monthNumbers.size || monthNumbers.has(Number(date.slice(5, 7)))) {
          periodRevenue.set(period, periodRevenue.get(period) + Number(offlineField(row, "amount") || 0));
        }
      }
    }
    if (discharge(row) || opd(row)) {
      const date = offlineEventDate(row);
      const period = offlinePeriod(date);
      if (period) targetActual.set(period, targetActual.get(period) + Number(offlineField(row, "amount") || 0));
    }
  });
  let cumulative = 0;
  let cumulativeTarget = 0;
  const targetProgress = OFFLINE_PERIODS.map((label, index) => {
    cumulative += targetActual.get(label);
    const days = [10, 20, 31][index];
    const monthDays = monthNumbers.size === 1
      ? new Date(2024, [...monthNumbers][0], 0).getDate() : 31;
    cumulativeTarget += monthlyTarget * Math.min(days, monthDays) / monthDays;
    return { label, actual: cumulative, target: cumulativeTarget };
  });
  const sumValues = (values) => [...values].reduce((total, value) => total + Number(value || 0), 0);
  const totalFor = (predicate, dimension, value = null) =>
    sumValues(offlineGroup(rows, predicate, dimension, value).values());
  const trendTotal = (series) => series.reduce((total, row) => total + Number(row.value || 0), 0);
  const revenueTrend = offlineBucket(rows, discharge, "dod", granularity, "amount");
  const patientFlowRows = [...patientFlow.values()];
  const opdTrend = offlineBucket(rows, (row) => opd(row)
    && String(offlineField(row, "serviceType") || "").toLowerCase() === "consultation",
  "doa", granularity);
  const periodRevenueRows = [...periodRevenue.entries()].map(([label, value]) => ({ label, value }));
  const periodDischargeRows = [...periodDischarges.entries()].map(([label, value]) => ({ label, value }));
  const services = offlineServices(rows);
  const panels = [...offlineGroup(rows, discharge, "panel", "amount").entries()]
    .map(([Panel, revenue]) => ({
      Panel, "IPD Revenue": revenue,
      "Credit Due": offlineSum(rows, (row) => discharge(row)
        && (String(offlineField(row, "panel") || "").trim() || "Unknown") === Panel, "credit"),
    })).sort((a, b) => b["IPD Revenue"] - a["IPD Revenue"]);
  return {
    revenueTrend,
    patientFlow: patientFlowRows,
    opdDaily: opdTrend,
    dischargeDepartments: offlineRanked(offlineGroup(rows, discharge, "department")),
    dischargeDoctors: offlineRanked(offlineGroup(rows, discharge, "doctor")),
    admissionDepartments: offlineRanked(offlineGroup(rows, admission, "department")),
    admissionDoctors: offlineRanked(offlineGroup(rows, admission, "doctor")),
    ipdRevenueDepartments: offlineRanked(offlineGroup(rows, discharge, "department", "amount")),
    ipdRevenueDoctors: offlineRanked(offlineGroup(rows, discharge, "doctor", "amount")),
    opdDoctors: offlineRanked(offlineGroup(rows, (row) => opd(row)
      && String(offlineField(row, "serviceType") || "").toLowerCase() === "consultation",
    "doctor")),
    opdServices: services,
    panels,
    periodRevenue: periodRevenueRows,
    periodDischarges: periodDischargeRows,
    targetProgress,
    totals: {
      revenueTrend: { value: trendTotal(revenueTrend) },
      patientFlow: {
        Admissions: patientFlowRows.reduce((total, row) => total + Number(row.Admissions || 0), 0),
        Discharges: patientFlowRows.reduce((total, row) => total + Number(row.Discharges || 0), 0),
      },
      opdDaily: { value: trendTotal(opdTrend) },
      dischargeDepartments: { value: totalFor(discharge, "department") },
      dischargeDoctors: { value: totalFor(discharge, "doctor") },
      admissionDepartments: { value: totalFor(admission, "department") },
      admissionDoctors: { value: totalFor(admission, "doctor") },
      ipdRevenueDepartments: { value: totalFor(discharge, "department", "amount") },
      ipdRevenueDoctors: { value: totalFor(discharge, "doctor", "amount") },
      opdDoctors: { value: totalFor((row) => opd(row)
        && String(offlineField(row, "serviceType") || "").toLowerCase() === "consultation", "doctor") },
      opdServices: { value: trendTotal(services) },
      periodRevenue: { value: trendTotal(periodRevenueRows) },
      periodDischarges: { value: trendTotal(periodDischargeRows) },
      targetProgress: {
        actual: targetProgress.length ? targetProgress[targetProgress.length - 1].actual : 0,
        target: targetProgress.length ? targetProgress[targetProgress.length - 1].target : 0,
      },
    },
    insights: offlineInsights(rows, monthlyTarget),
    granularity,
    dischargeCount: rows.filter(discharge).length,
    admissionCount: rows.filter(admission).length,
  };
}

function offlineDashboard(query) {
  const datasetId = query.searchParams.get("datasetId") || window.__OFFLINE_DATA__.datasets[0]?.dataset_id;
  const dataset = window.__OFFLINE_DATA__.datasets.find((item) => item.dataset_id === datasetId);
  if (!dataset) throw new Error("The selected dataset is not available.");
  const allRows = offlineDatasetRows(datasetId);
  const months = query.searchParams.getAll("month");
  const periods = query.searchParams.getAll("period");
  const rows = offlineFilter(allRows, months, periods);
  const [start, end] = offlineRange(allRows);
  const monthlyTarget = offlineMonthlyTarget(dataset.hospital_name);
  const target = offlineDashboardTarget(monthlyTarget, start, end, months, periods);
  const kpis = offlineKpis(rows, dataset.hospital_name, target);
  return {
    hasData: true,
    dataset,
    dateRange: { start, end },
    recordCount: rows.length,
    filters: { month: months, period: periods },
    options: { months: offlineMonths(allRows), periods: OFFLINE_PERIODS },
    kpis,
    charts: offlineCharts(rows, kpis, months, monthlyTarget),
  };
}

function offlineComparisonOptions() {
  const dates = window.__OFFLINE_DATA__.rows.map(offlineEventDate).filter(Boolean);
  const latestDate = dates.length ? dates.sort().at(-1) : null;
  return {
    years: [...new Set(dates.map((date) => Number(date.slice(0, 4))))].sort((a, b) => a - b),
    months: offlineMonths(window.__OFFLINE_DATA__.rows),
    latestDate,
  };
}

function offlineComparisonRange(filters, side) {
  const monthDays = (year, month) => new Date(year, month, 0).getDate();
  const padded = (number) => String(number).padStart(2, "0");
  const makeDate = (year, month, day) => `${year}-${padded(month)}-${padded(day)}`;
  const mode = filters.compareBy;
  if (mode === "Year") {
    const year = Number(filters[`year${side}`]);
    if (filters.month && filters.month !== "All Months") {
      const month = OFFLINE_MONTHS.indexOf(filters.month) + 1;
      return [makeDate(year, month, 1), makeDate(year, month, monthDays(year, month))];
    }
    return [`${year}-01-01`, `${year}-12-31`];
  }
  if (mode === "Month") {
    const year = Number(filters.year);
    const month = OFFLINE_MONTHS.indexOf(filters[`month${side}`]) + 1;
    return [makeDate(year, month, 1), makeDate(year, month, monthDays(year, month))];
  }
  if (mode === "Last Months") {
    const count = Number(filters.monthsCount);
    const endYear = Number(filters.endYear);
    const endMonth = OFFLINE_MONTHS.indexOf(filters.endMonth) + 1;
    const endMonthIndex = endYear * 12 + endMonth - 1;
    const periodEndMonthIndex = side === "2" ? endMonthIndex : endMonthIndex - count;
    const periodStartMonthIndex = periodEndMonthIndex - count + 1;
    const startYear = Math.floor(periodStartMonthIndex / 12);
    const startMonth = periodStartMonthIndex % 12 + 1;
    const finishYear = Math.floor(periodEndMonthIndex / 12);
    const finishMonth = periodEndMonthIndex % 12 + 1;
    return [makeDate(startYear, startMonth, 1),
      makeDate(finishYear, finishMonth, monthDays(finishYear, finishMonth))];
  }
  if (mode === "Week") {
    const year = Number(filters.year);
    const month = OFFLINE_MONTHS.indexOf(filters.month) + 1;
    const week = Number(filters[`week${side}`]);
    return [makeDate(year, month, (week - 1) * 7 + 1),
      makeDate(year, month, Math.min(week * 7, monthDays(year, month)))];
  }
  if (mode === "Period") {
    const year = Number(filters.year);
    const month = OFFLINE_MONTHS.indexOf(filters.month) + 1;
    const start = filters[`period${side}`] === OFFLINE_PERIODS[0] ? 1
      : filters[`period${side}`] === OFFLINE_PERIODS[1] ? 11 : 21;
    const end = filters[`period${side}`] === OFFLINE_PERIODS[0] ? 10
      : filters[`period${side}`] === OFFLINE_PERIODS[1] ? 20 : monthDays(year, month);
    return [makeDate(year, month, start), makeDate(year, month, end)];
  }
  if (mode === "Date") return [filters[`date${side}`], filters[`date${side}`]];
  return [filters[`start${side}`], filters[`end${side}`]];
}

function offlinePeriodRows(rows, filters, side) {
  const mode = filters.compareBy;
  if (mode === "Year" || mode === "Month" || mode === "Week" || mode === "Period") {
    const year = Number(mode === "Year" ? filters[`year${side}`] : filters.year);
    const month = mode === "Year" ? filters.month : mode === "Month"
      ? filters[`month${side}`] : filters.month;
    const week = mode === "Week" ? Number(filters[`week${side}`]) : null;
    const period = mode === "Period" ? filters[`period${side}`] : null;
    return rows.filter((row) => {
      const date = offlineEventDate(row);
      if (!date || Number(date.slice(0, 4)) !== year) return false;
      const monthNumber = Number(date.slice(5, 7));
      if (month && month !== "All Months" && monthNumber !== OFFLINE_MONTHS.indexOf(month) + 1) return false;
      if (week && Math.floor((Number(date.slice(8, 10)) - 1) / 7) + 1 !== week) return false;
      if (period && offlinePeriod(date) !== period) return false;
      return true;
    });
  }
  const [start, end] = offlineComparisonRange(filters, side);
  return rows.filter((row) => {
    const date = offlineEventDate(row);
    return date && date >= start && date <= end;
  });
}

function offlineChange(current, previous) {
  if (previous === 0) return current === 0 ? 0 : current > 0 ? "New" : null;
  return (current - previous) / previous * 100;
}

function offlineChangeLabel(value) {
  if (value === null || value === undefined) return "N/A";
  if (value === "New") return "New";
  return value === 0 ? "0.0%" : `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function offlineComparisonSummary(metrics, moverData, filters) {
  const metricValues = (label) => {
    const metric = metrics.find((item) => item.label === label);
    return metric ? [metric.first || 0, metric.second || 0] : [0, 0];
  };
  const periodDays = ["1", "2"].map((side) => {
    const [start, end] = offlineComparisonRange(filters, side);
    return Math.floor((new Date(`${end}T00:00:00`) - new Date(`${start}T00:00:00`))
      / 86400000) + 1;
  });
  const ipdRevenue = metricValues("IPD revenue");
  const discharges = metricValues("Discharges");
  const averageIpdRevenuePerDischarge = ipdRevenue.map(
    (value, index) => discharges[index] ? value / discharges[index] : 0,
  );
  const ipdDischargeEffect = discharges[0]
    ? (discharges[1] - discharges[0]) * averageIpdRevenuePerDischarge[0]
    : ipdRevenue[1] - ipdRevenue[0];
  const ipdBillPerDischargeEffect = discharges[0]
    ? discharges[1] * (
      averageIpdRevenuePerDischarge[1] - averageIpdRevenuePerDischarge[0]
    )
    : 0;
  const creditDue = metricValues("Credit due");
  const collected = ipdRevenue.map((revenue, index) =>
    Math.max(0, revenue - creditDue[index]),
  );
  const netIpdChange = ipdRevenue[1] - ipdRevenue[0];
  const biggestIpdRevenueMovers = {};
  ["departments", "doctors", "panels"].forEach((dimension) => {
    const candidates = (moverData.ipdRevenue[dimension] || [])
      .map((row) => ({
        name: row.name,
        change: Number(row.values[1] || 0) - Number(row.values[0] || 0),
      }))
      .filter((row) => row.change)
      .sort((left, right) => Math.abs(right.change) - Math.abs(left.change));
    const mover = candidates[0];
    biggestIpdRevenueMovers[dimension] = mover ? {
      ...mover,
      netChangePercent: netIpdChange ? mover.change / netIpdChange * 100 : null,
    } : null;
  });
  return {
    periodDays,
    totalRevenue: metricValues("Revenue"),
    ipdRevenue,
    opdRevenue: metricValues("OPD revenue"),
    discharges,
    averageIpdRevenuePerDischarge,
    ipdDischargeEffect,
    ipdBillPerDischargeEffect,
    creditDue,
    collected,
    collectionRate: ipdRevenue.map(
      (revenue, index) => revenue ? collected[index] / revenue * 100 : 0,
    ),
    biggestIpdRevenueMovers,
  };
}

function offlineComparison(rows, query) {
  const hospital = query.searchParams.get("hospital") || "All Hospitals";
  const filters = JSON.parse(query.searchParams.get("filters") || "{}");
  const scoped = hospital === "All Hospitals" ? rows
    : rows.filter((row) => window.__OFFLINE_DATA__.datasets[row[0]].hospital_name === hospital);
  const first = offlinePeriodRows(scoped, filters, "1");
  const second = offlinePeriodRows(scoped, filters, "2");
  if (!first.length || !second.length) {
    return { hasData: false, message: `No records found for the ${!first.length ? "first" : "second"} comparison period.` };
  }
  const [range1, range2] = [offlineComparisonRange(filters, "1"), offlineComparisonRange(filters, "2")];
  let labels;
  if (filters.compareBy === "Year") {
    labels = [filters.month && filters.month !== "All Months" ? `${filters.month} ${filters.year1}` : String(filters.year1),
      filters.month && filters.month !== "All Months" ? `${filters.month} ${filters.year2}` : String(filters.year2)];
  } else if (filters.compareBy === "Month") labels = [filters.month1, filters.month2];
  else if (filters.compareBy === "Last Months") {
    labels = [range1, range2].map(([start, end]) => {
      const format = (date) => `${OFFLINE_MONTHS[Number(date.slice(5, 7)) - 1].slice(0, 3)} ${date.slice(0, 4)}`;
      return `${format(start)} – ${format(end)}`;
    });
  } else if (filters.compareBy === "Week") labels = [`Week ${filters.week1}`, `Week ${filters.week2}`];
  else if (filters.compareBy === "Period") labels = [filters.period1, filters.period2];
  else if (filters.compareBy === "Date") labels = [filters.date1, filters.date2];
  else labels = [`${filters.start1} – ${filters.end1}`, `${filters.start2} – ${filters.end2}`];
  if (labels[0] === labels[1]) labels = [`${labels[0]} · Period 1`, `${labels[1]} · Period 2`];
  const monthlyTarget = offlineMonthlyTarget(hospital);
  const targets = [range1, range2].map((range) => offlineTargetForRanges(monthlyTarget, [range]));
  const kpis = [offlineKpis(first, hospital, targets[0]), offlineKpis(second, hospital, targets[1])];
  const metricDefs = [
    ["Revenue", "revenue", "currency"], ["IPD revenue", "ipd_revenue", "currency"],
    ["OPD revenue", "opd_revenue", "currency"], ["Revenue target", "target", "currency"],
    ["Target achievement", "achievement", "percent"], ["Admissions", "admissions", "count"],
    ["Discharges", "discharges", "count"], ["OPD consultations", "opd_consultation", "count"],
    ["Occupancy", "occupancy", "percent"], ["Occupied bed days", "bed_days", "count"],
    ["Average stay", "alos", "days"], ["Cash due", "cash_due", "currency"],
    ["Credit due", "credit_due", "currency"],
  ];
  const metrics = metricDefs.map(([label, key, kind]) => {
    const changeValue = offlineChange(kpis[1][key], kpis[0][key]);
    return { label, first: kpis[0][key], second: kpis[1][key],
      change: offlineChangeLabel(changeValue), changeValue, kind };
  });
  const countBy = (periodRows, predicate, dimension, value = null) =>
    offlineGroup(periodRows, predicate, dimension, value);
  const pairChart = (left, right) => {
    const names = new Set([...left.keys(), ...right.keys()]);
    return [...names].map((label) => ({ label, first: left.get(label) || 0, second: right.get(label) || 0 }))
      .sort((a, b) => Math.max(b.first, b.second) - Math.max(a.first, a.second)).slice(0, 10);
  };
  const pairMoverRows = (left, right) => {
    const names = new Set([...left.keys(), ...right.keys()]);
    return [...names].map((name) => ({
      name,
      values: [left.get(name) || 0, right.get(name) || 0],
    }));
  };
  const pairNamedRows = (left, right, nameKey) => {
    const names = new Set([...left.keys(), ...right.keys()]);
    return [...names].map((name) => ({
      [nameKey]: name,
      [labels[0]]: left.get(name) || 0,
      [labels[1]]: right.get(name) || 0,
    }));
  };
  const consultation = (row) => offlineField(row, "type") === "OPD"
    && String(offlineField(row, "serviceType") || "").toLowerCase() === "consultation";
  const dischargeDepartments = [
    countBy(first, (row) => offlineField(row, "type") === "Discharge", "department"),
    countBy(second, (row) => offlineField(row, "type") === "Discharge", "department"),
  ];
  const dischargeDoctors = [
    countBy(first, (row) => offlineField(row, "type") === "Discharge", "doctor"),
    countBy(second, (row) => offlineField(row, "type") === "Discharge", "doctor"),
  ];
  const admissionDepartments = [
    countBy(first, (row) => offlineField(row, "type") === "Admission", "department"),
    countBy(second, (row) => offlineField(row, "type") === "Admission", "department"),
  ];
  const admissionDoctors = [
    countBy(first, (row) => offlineField(row, "type") === "Admission", "doctor"),
    countBy(second, (row) => offlineField(row, "type") === "Admission", "doctor"),
  ];
  const ipdRevenueDepartments = [
    countBy(first, (row) => offlineField(row, "type") === "Discharge", "department", "amount"),
    countBy(second, (row) => offlineField(row, "type") === "Discharge", "department", "amount"),
  ];
  const ipdRevenueDoctors = [
    countBy(first, (row) => offlineField(row, "type") === "Discharge", "doctor", "amount"),
    countBy(second, (row) => offlineField(row, "type") === "Discharge", "doctor", "amount"),
  ];
  const opdDoctors = [
    countBy(first, consultation, "doctor"),
    countBy(second, consultation, "doctor"),
  ];
  const opdDepartments = [
    countBy(first, consultation, "department"),
    countBy(second, consultation, "department"),
  ];
  const panels = [
    countBy(first, (row) => offlineField(row, "type") === "Discharge", "panel", "amount"),
    countBy(second, (row) => offlineField(row, "type") === "Discharge", "panel", "amount"),
  ];
  const serviceFilter = (row) => offlineField(row, "type") === "OPD"
    && offlineField(row, "service")
    && String(offlineField(row, "service")).toLowerCase() !== "consultation";
  const services = [
    countBy(first, serviceFilter, "service"),
    countBy(second, serviceFilter, "service"),
  ];
  const chartGroups = {
    dischargeDepartments, dischargeDoctors, admissionDepartments, admissionDoctors,
    ipdRevenueDepartments, ipdRevenueDoctors, opdDoctors, opdServices: services, panels,
  };
  const charts = Object.fromEntries(Object.entries(chartGroups).map(([key, [left, right]]) => [
    key === "opdServices" ? "services" : key,
    pairChart(left, right),
  ]));
  const chartTotals = Object.fromEntries(Object.entries(chartGroups).map(([key, [left, right]]) => [
    key,
    [left, right].map((group) => [...group.values()].reduce((total, value) => total + value, 0)),
  ]));
  const comparisonTrends = {
    admissions: offlineComparisonCountTrend(first, second, filters, "Admission", "IPD admission"),
    discharges: offlineComparisonCountTrend(first, second, filters, "Discharge", "IPD discharge"),
    opdConsultations: offlineComparisonCountTrend(first, second, filters, "opd", "OPD consultation"),
    revenue: offlineComparisonCountTrend(first, second, filters, "revenue", "IPD revenue"),
  };
  const moverData = {
    ipdRevenue: {
      departments: pairMoverRows(
        countBy(first, (row) => offlineField(row, "type") === "Discharge", "department", "amount"),
        countBy(second, (row) => offlineField(row, "type") === "Discharge", "department", "amount"),
      ),
      doctors: pairMoverRows(
        countBy(first, (row) => offlineField(row, "type") === "Discharge", "doctor", "amount"),
        countBy(second, (row) => offlineField(row, "type") === "Discharge", "doctor", "amount"),
      ),
      panels: pairMoverRows(
        countBy(first, (row) => offlineField(row, "type") === "Discharge", "panel", "amount"),
        countBy(second, (row) => offlineField(row, "type") === "Discharge", "panel", "amount"),
      ),
    },
    ipdDischarges: {
      departments: pairMoverRows(
        countBy(first, (row) => offlineField(row, "type") === "Discharge", "department"),
        countBy(second, (row) => offlineField(row, "type") === "Discharge", "department"),
      ),
      doctors: pairMoverRows(
        countBy(first, (row) => offlineField(row, "type") === "Discharge", "doctor"),
        countBy(second, (row) => offlineField(row, "type") === "Discharge", "doctor"),
      ),
      panels: pairMoverRows(
        countBy(first, (row) => offlineField(row, "type") === "Discharge", "panel"),
        countBy(second, (row) => offlineField(row, "type") === "Discharge", "panel"),
      ),
    },
    ipdAdmissions: {
      departments: pairMoverRows(
        countBy(first, (row) => offlineField(row, "type") === "Admission", "department"),
        countBy(second, (row) => offlineField(row, "type") === "Admission", "department"),
      ),
      doctors: pairMoverRows(
        countBy(first, (row) => offlineField(row, "type") === "Admission", "doctor"),
        countBy(second, (row) => offlineField(row, "type") === "Admission", "doctor"),
      ),
      panels: pairMoverRows(
        countBy(first, (row) => offlineField(row, "type") === "Admission", "panel"),
        countBy(second, (row) => offlineField(row, "type") === "Admission", "panel"),
      ),
    },
    opdConsultations: {
      departments: pairMoverRows(
        countBy(first, consultation, "department"),
        countBy(second, consultation, "department"),
      ),
      doctors: pairMoverRows(
        countBy(first, consultation, "doctor"),
        countBy(second, consultation, "doctor"),
      ),
      panels: pairMoverRows(
        countBy(first, consultation, "panel"),
        countBy(second, consultation, "panel"),
      ),
    },
  };
  const revenueTrend = offlineComparisonTrend(first, second, filters, labels);
  const insights = [offlineInsights(first), offlineInsights(second)];
  const namedRows = (left, right, nameKey) => pairNamedRows(left, right, nameKey);
  const serviceRows = pairNamedRows(services[0], services[1], "Service");
  return {
    hasData: true, hospital, labels, recordCounts: [first.length, second.length], metrics,
    periodRanges: [range1, range2],
    monthlyTarget,
    trends: comparisonTrends,
    summary: offlineComparisonSummary(metrics, moverData, filters), moverData,
    chartTotals,
    charts,
    departments: namedRows(ipdRevenueDepartments[0], ipdRevenueDepartments[1], "Department"),
    doctors: namedRows(ipdRevenueDoctors[0], ipdRevenueDoctors[1], "Doctor"),
    dischargeDepartments: namedRows(dischargeDepartments[0], dischargeDepartments[1], "Dept. Name"),
    dischargeDoctors: namedRows(dischargeDoctors[0], dischargeDoctors[1], "Doctor Name"),
    admissionDepartments: namedRows(admissionDepartments[0], admissionDepartments[1], "Dept. Name"),
    admissionDoctors: namedRows(admissionDoctors[0], admissionDoctors[1], "Doctor Name"),
    opdDepartments: namedRows(opdDepartments[0], opdDepartments[1], "Dept. Name"),
    opdDoctors: namedRows(opdDoctors[0], opdDoctors[1], "Doctor Name"),
    panels: pairNamedRows(panels[0], panels[1], "Panel"),
    services: serviceRows,
    revenueTrend,
    managementInsights: { [labels[0]]: insights[0], [labels[1]]: insights[1] },
    insights: metrics.slice(0, 4).map((metric) => ({
      label: metric.label,
      message: metric.change !== "0.0%" && metric.change !== "N/A"
        ? `${labels[1]} is ${metric.change} versus ${labels[0]}.`
        : `${metric.label} is broadly unchanged between periods.`,
      positive: typeof metric.changeValue === "number" && metric.changeValue > 0
        && !["Occupancy", "Average stay"].includes(metric.label),
    })),
  };
}

function offlineComparisonCountTrend(first, second, filters, kind, titleName) {
  const mode = filters.compareBy;
  const ranges = [offlineComparisonRange(filters, "1"), offlineComparisonRange(filters, "2")];
  const dateNumber = (value) => {
    const [year, month, day] = value.split("-").map(Number);
    return Date.UTC(year, month - 1, day) / 86400000;
  };
  const monthNumber = (value) => {
    const [year, month] = value.split("-").map(Number);
    return year * 12 + month;
  };
  const rangeDays = ranges.map(([start, end]) => dateNumber(end) - dateNumber(start) + 1);
  const monthly = mode === "Year" && (!filters.month || filters.month === "All Months");
  const longRange = mode === "Last Months" || (mode === "From-To" && Math.max(...rangeDays) > 62);
  const groupedFor = (rows, range) => {
    const grouped = new Map();
    rows.forEach((row) => {
      const type = offlineField(row, "type");
      if (kind === "opd") {
        if (!(
          type === "OPD"
          && String(offlineField(row, "serviceType") || "").toLowerCase() === "consultation"
        )) return;
      } else if (type !== (kind === "revenue" ? "Discharge" : kind)) return;
      const date = offlineEventDate(row);
      if (!date) return;
      let key;
      if (monthly) {
        key = Number(date.slice(5, 7));
      } else if (longRange) {
        key = monthNumber(date) - monthNumber(range[0]) + 1;
      } else {
        key = dateNumber(date) - dateNumber(range[0]) + 1;
      }
      const value = kind === "revenue" ? Number(offlineField(row, "amount") || 0) : 1;
      grouped.set(key, (grouped.get(key) || 0) + value);
    });
    return grouped;
  };
  const groups = [groupedFor(first, ranges[0]), groupedFor(second, ranges[1])];
  const granularity = monthly || longRange ? "month" : "day";
  const length = monthly ? 12 : longRange
    ? Math.max(...ranges.map(([start, end]) => monthNumber(end) - monthNumber(start) + 1))
    : Math.max(...rangeDays);
  const labels = Array.from({ length }, (_, index) => {
    const number = index + 1;
    if (mode === "Last Months") {
      const [year, month] = ranges[1][0].split("-").map(Number);
      const absoluteMonth = year * 12 + month - 1 + index;
      return `${OFFLINE_MONTHS[absoluteMonth % 12].slice(0, 3)} ${Math.floor(absoluteMonth / 12)}`;
    }
    return monthly ? OFFLINE_MONTHS[index].slice(0, 3)
      : longRange ? `Month ${number}` : String(number);
  });
  return {
    title: `${titleName} trend by ${granularity}`,
    granularity,
    rows: labels.map((label, index) => ({
      label,
      first: groups[0].get(index + 1) || 0,
      second: groups[1].get(index + 1) || 0,
    })),
    totals: groups.map((group) => [...group.values()].reduce((total, value) => total + value, 0)),
  };
}

function offlineComparisonTrend(first, second, filters, labels) {
  const mode = filters.compareBy;
  const trendFor = (rows, side) => {
    const eligible = rows.filter((row) => offlineField(row, "type") === "Discharge"
      && offlineField(row, "dod"));
    const grouped = new Map();
    eligible.forEach((row) => {
      const date = offlineField(row, "dod");
      let key;
      if (mode === "Year" || mode === "From-To") {
        key = mode === "Year" ? OFFLINE_MONTHS[Number(date.slice(5, 7)) - 1].slice(0, 3)
          : `${OFFLINE_MONTHS[Number(date.slice(5, 7)) - 1].slice(0, 3)} ${date.slice(0, 4)}`;
      } else if (mode === "Last Months") {
        const range = offlineComparisonRange(filters, side);
        const offset = (Number(date.slice(0, 4)) - Number(range[0].slice(0, 4))) * 12
          + Number(date.slice(5, 7)) - Number(range[0].slice(5, 7));
        const currentRange = offlineComparisonRange(filters, "2");
        const currentYear = Number(currentRange[0].slice(0, 4));
        const currentMonth = Number(currentRange[0].slice(5, 7));
        const absoluteMonth = currentYear * 12 + currentMonth - 1 + offset;
        key = `${OFFLINE_MONTHS[absoluteMonth % 12].slice(0, 3)} ${Math.floor(absoluteMonth / 12)}`;
      } else if (mode === "Month" || mode === "Period") key = offlinePeriod(date);
      else if (mode === "Week") key = `Week ${Math.floor((Number(date.slice(8, 10)) - 1) / 7) + 1}`;
      else key = filters[`date${side}`];
      grouped.set(key, (grouped.get(key) || 0) + Number(offlineField(row, "amount") || 0));
    });
    if (mode === "Year") return new Map(OFFLINE_MONTHS.map((month) => [month.slice(0, 3), grouped.get(month.slice(0, 3)) || 0]));
    if (mode === "Last Months") {
      const currentRange = offlineComparisonRange(filters, "2");
      const [year, month] = currentRange[0].split("-").map(Number);
      const count = Number(filters.monthsCount);
      const labels = Array.from({ length: count }, (_, index) => {
        const absoluteMonth = year * 12 + month - 1 + index;
        return `${OFFLINE_MONTHS[absoluteMonth % 12].slice(0, 3)} ${Math.floor(absoluteMonth / 12)}`;
      });
      return new Map(labels.map((label) => [label, grouped.get(label) || 0]));
    }
    if (mode === "Month" || mode === "Period") return new Map(OFFLINE_PERIODS.map((period) => [period, grouped.get(period) || 0]));
    if (mode === "Week") return new Map([1, 2, 3, 4, 5].map((week) => [`Week ${week}`, grouped.get(`Week ${week}`) || 0]));
    if (mode === "From-To") return new Map([...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0])));
    return grouped;
  };
  const left = trendFor(first, "1");
  const right = trendFor(second, "2");
  const order = mode === "Year" ? OFFLINE_MONTHS.map((month) => month.slice(0, 3))
    : mode === "Last Months" ? [...right.keys()]
    : mode === "Month" || mode === "Period" ? OFFLINE_PERIODS
      : mode === "Week" ? [1, 2, 3, 4, 5].map((week) => `Week ${week}`)
        : [...new Set([...left.keys(), ...right.keys()])];
  const title = {
    Year: "IPD revenue trend by month", Month: "IPD revenue trend by billing period",
    "Last Months": "IPD revenue trend by month",
    Week: "IPD revenue by week", Period: "IPD revenue by billing period",
    Date: "IPD revenue on selected dates", "From-To": "IPD revenue trend by month",
  }[mode] || "IPD revenue trend";
  return {
    title,
    rows: order.map((label) => ({ label, first: left.get(label) || 0, second: right.get(label) || 0 })),
    totals: [first, second].map((rows) => offlineSum(rows,
      (row) => offlineField(row, "type") === "Discharge", "amount")),
  };
}

window.fetch = async (input, options = {}) => {
  await offlineReady;
  const url = new URL(typeof input === "string" ? input : input.url, window.location.href);
  const pathname = url.protocol === "file:"
    ? url.pathname.replace(/^\/[A-Za-z]:/, "")
    : url.pathname;
  if (options.method && options.method !== "GET") {
    return new Response(JSON.stringify({ error: "This action is not available in an offline report." }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }
  try {
    let payload;
    if (pathname === "/api/options") {
      const datasets = window.__OFFLINE_DATA__.datasets;
      const defaultDatasetId = datasets[0]?.dataset_id || null;
      const defaultRows = defaultDatasetId ? offlineDatasetRows(defaultDatasetId) : [];
      const [start, end] = offlineRange(defaultRows);
      payload = {
        datasets, hospitals: [...new Set(datasets.map((item) => item.hospital_name))].sort(),
        periods: OFFLINE_PERIODS, defaultDatasetId,
        months: offlineMonths(defaultRows), dateRange: { start, end },
        comparison: offlineComparisonOptions(),
      };

      function downloadOfflineCsv() {
        const activeView = document.querySelector(".view-tab.is-active")?.dataset.view || "overview";
        let rows;
        if (activeView === "comparison") {
          const result = window.__OFFLINE_COMPARISON_RESULT__;
          if (!result) {
            toast("Compare two periods before exporting.", true);
            return;
          }
          rows = result.metrics.map((metric) => ({
            Section: "Metric", Label: metric.label,
            [result.labels[0]]: metric.first, [result.labels[1]]: metric.second,
            Change: metric.change,
          }));
        } else {
          const filters = selectedFilters();
          const filtered = offlineFilter(
            offlineDatasetRows(filters.datasetId), filters.month, filters.period,
          );
          const headers = ["DOA", "DOD", "Type", "Month", "Dept. Name", "Doctor Name",
            "Panel Name", "Service Type", "Service Name", "Service Final Amount",
            "Cash Due", "Credit Due", "Bed Days"];
          rows = filtered.map((row) => Object.fromEntries(headers.map((header, index) =>
            [header, row[index + 1] ?? ""])));
        }
        const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
        const csv = [headers, ...rows.map((row) => headers.map((header) => row[header] ?? ""))]
          .map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","))
          .join("\r\n");
        const link = document.createElement("a");
        link.href = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }));
        link.download = activeView === "comparison"
          ? "Vedansh_Medicare_Comparison.csv" : "Vedansh_Medicare_Dashboard_Data.csv";
        link.click();
        URL.revokeObjectURL(link.href);
      }

      document.addEventListener("DOMContentLoaded", () => {
        if (!window.__OFFLINE_REPORT__) return;
        document.querySelector("#export-button")?.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopImmediatePropagation();
          downloadOfflineCsv();
        }, true);
      });
    } else if (pathname === "/api/dashboard") {
      payload = offlineDashboard(url);
    } else if (pathname === "/api/comparison/options") {
      payload = offlineComparisonOptions();
    } else if (pathname === "/api/comparison") {
      payload = offlineComparison(window.__OFFLINE_DATA__.rows, url);
      window.__OFFLINE_COMPARISON_RESULT__ = payload;
    } else if (pathname === "/api/prediction") {
      const hospital = url.searchParams.get("hospital") || "All Hospitals";
      const filters = JSON.parse(url.searchParams.get("filters") || "{}");
      const mode = filters.predictBy || "Year";
      const month = mode === "Month" ? filters.month || "" : "";
      const period = mode === "Period" ? filters.period || "" : "";
      const horizon = String(filters.horizon || 6);
      const key = JSON.stringify([hospital, mode, month, period, horizon]);
      payload = window.__OFFLINE_DATA__.predictions?.[key];
      if (!payload) {
        return new Response(JSON.stringify({
          error: "This prediction setting is not included in the offline report.",
        }), {
          status: 400, headers: { "Content-Type": "application/json" },
        });
      }
    } else {
      payload = { error: "This action is not available in an offline report." };
      return new Response(JSON.stringify(payload), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(payload), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }
};