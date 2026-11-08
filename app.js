// VK Дашборд — статический сайт для GitHub Pages.
// Читает data.json (обновляется GitHub Actions по расписанию) и рисует
// ту же широкую таблицу, что и рабочая панель: строка = кабинет, 8 столбцов.

"use strict";

var LOW_REAL_THRESHOLD = 300;
var DATA = null;
// карточка клиента: чей период открыт и где рисуется динамика
var CUR_CAB = null;
var DYN_EL = null;
// выбранный период динамики: "7" | "30" | "custom" (from/to в ISO)
var PERIOD = { mode: "7", from: null, to: null };

// ---------- форматирование (как в панели) ----------

function fmtMoney(v) {
  if (v == null || Number.isNaN(v)) return "—";
  return Math.round(v).toLocaleString("ru-RU") + " ₽";
}
function fmtMoneyPrecise(v) {
  if (v == null || Number.isNaN(v)) return "—";
  return v.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " ₽";
}
function fmtCpc(v) {
  if (v == null || Number.isNaN(v) || !Number.isFinite(v)) return "—";
  return v.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " ₽";
}
var MONTHS_RU = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
function fmtDateLong(iso) {
  var p = iso.split("-");
  return parseInt(p[2], 10) + " " + MONTHS_RU[parseInt(p[1], 10) - 1];
}
function fmtDateShort(iso) {
  var p = iso.split("-");
  return p[2] + "." + p[1];
}
function isoShift(iso, days) {
  var d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function fmtDateTimeMsk(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    timeZone: "Europe/Moscow",
  }).replace(", ", " ");
}

// ---------- вспомогательные ----------

function el(html) {
  var t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function isLow(cab) {
  return cab.balanceReal != null && cab.balanceReal < LOW_REAL_THRESHOLD;
}

// клики кабинета за конкретный день (из 7-дневной таблицы; дня нет = показов не было)
function clicksOn(cab, iso) {
  if (!cab.clicks7 || !iso) return 0;
  for (var i = 0; i < cab.clicks7.length; i++) {
    if (cab.clicks7[i].date === iso) return cab.clicks7[i].clicks || 0;
  }
  return 0;
}

// средняя цена клика за последние 2 полных дня (вчера + позавчера):
// (расход вчера + расход позавчера) ÷ клики за те же дни
function cpc2days(cab, data) {
  if (cab.spendYesterday == null || cab.spendDayBefore == null) return null;
  var clicks = clicksOn(cab, data.yesterday) + clicksOn(cab, data.dayBefore);
  if (clicks <= 0) return null;
  return (cab.spendYesterday + cab.spendDayBefore) / clicks;
}

// ---------- график сообщений группы: писавшие по дням (столбики) ----------

function buildMsgChartSvg(days) {
  var W = 520, H = 190;
  var mL = 34, mR = 12, mT = 14, mB = 24;
  var iw = W - mL - mR, ih = H - mT - mB;
  var n = days.length;
  if (!n) return "";
  var labelStep = n > 12 ? Math.ceil(n / 10) : 1;
  var showBarNums = n <= 16;
  var maxW = niceCeilInt(Math.max.apply(null, days.map(function (d) { return d.writers || 0; })));
  var yW = function (v) { return mT + ih - (ih * v) / maxW; };
  var band = iw / n;
  var xC = function (i) { return mL + band * (i + 0.5); };

  var p = [];
  for (var g = 0; g <= 3; g++) {
    var frac = g / 3;
    var y = (mT + ih - ih * frac).toFixed(1);
    p.push('<line x1="' + mL + '" y1="' + y + '" x2="' + (W - mR) + '" y2="' + y + '" stroke="#e5e7eb" stroke-width="1"/>');
    p.push('<text x="' + (mL - 6) + '" y="' + (+y + 3.5).toFixed(1) + '" text-anchor="end" font-size="10" fill="#6b7280">' + Math.round(maxW * frac) + "</text>");
  }
  days.forEach(function (d, i) {
    var writers = d.writers || 0;
    var x = xC(i);
    var bw = Math.min(band * 0.52, 40);
    var yTop = yW(writers);
    var h = writers > 0 ? Math.max(2, mT + ih - yTop) : 0;
    var todayFill = d.isToday ? ' opacity="0.55"' : "";
    var todayStroke = d.isToday ? ' stroke="#16a34a" stroke-dasharray="3 2" stroke-width="1"' : "";
    p.push(
      '<g><title>' + esc(fmtDateShort(d.date)) + (d.isToday ? " (сегодня, ещё идёт)" : "") + ": писавших " + writers + "</title>" +
      '<rect x="' + (x - bw / 2).toFixed(1) + '" y="' + yTop.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="3" fill="#16a34a"' + todayFill + todayStroke + "/>" +
      (writers > 0 && showBarNums ? '<text x="' + x.toFixed(1) + '" y="' + (yTop - 5).toFixed(1) + '" text-anchor="middle" font-size="10" font-weight="600" fill="#0f172a">' + writers + "</text>" : "") +
      "</g>"
    );
    if (i % labelStep === 0 || (i === n - 1 && (n - 1) % labelStep > 1)) {
      p.push(
        '<text x="' + x.toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="10"' +
        (d.isToday ? ' font-weight="600" fill="#16a34a"' : ' fill="#6b7280"') + ">" + esc(fmtDateShort(d.date)) + "</text>"
      );
    }
  });
  return '<svg class="chart-svg" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="График: писавшие в группу за ' + n + ' дней">' + p.join("") + "</svg>";
}

// ---------- график в карточке клиента: клики (столбики) + цена клика (линия) ----------
// Чистый SVG без библиотек — строится из clicks7, уже лежащего в data.json.

function niceCeilInt(v) {
  var steps = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100, 150, 200, 300, 500, 1000];
  for (var i = 0; i < steps.length; i++) if (steps[i] >= v) return steps[i];
  return Math.ceil(v / 500) * 500;
}

function niceCeil(v) {
  if (!(v > 0)) return 1;
  var exp = Math.pow(10, Math.floor(Math.log10(v)));
  var f = v / exp;
  var steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  for (var j = 0; j < steps.length; j++) if (steps[j] >= f) return steps[j] * exp;
  return 10 * exp;
}

function fmtAxisCpc(v) {
  if (v === 0) return "0";
  if (v >= 10) return String(Math.round(v));
  return v.toFixed(1).replace(".", ",");
}

function buildChartSvg(days) {
  var W = 520, H = 224;
  var mL = 34, mR = 58, mT = 14, mB = 24;
  var iw = W - mL - mR, ih = H - mT - mB;
  var n = days.length;
  if (!n) return "";
  // длинные периоды (30+ дней, свой): даты реже, цифры над столбиками не ставим
  var labelStep = n > 12 ? Math.ceil(n / 10) : 1;
  var showBarNums = n <= 16;

  var maxClicks = niceCeilInt(Math.max.apply(null, days.map(function (d) { return d.clicks || 0; })));
  var cpcVals = days
    .map(function (d) { return d.cpc != null && isFinite(d.cpc) ? d.cpc : null; })
    .filter(function (v) { return v != null; });
  var hasCpc = cpcVals.length > 0;
  var maxCpc = niceCeil(hasCpc ? Math.max.apply(null, cpcVals) : 0);

  var yC = function (v) { return mT + ih - (ih * v) / maxClicks; };
  var yP = function (v) { return mT + ih - (ih * v) / maxCpc; };
  var band = iw / n;
  var xC = function (i) { return mL + band * (i + 0.5); };

  var p = [];

  // сетка + оси: клики слева, цена клика справа
  for (var g = 0; g <= 3; g++) {
    var frac = g / 3;
    var y = (mT + ih - ih * frac).toFixed(1);
    p.push('<line x1="' + mL + '" y1="' + y + '" x2="' + (W - mR) + '" y2="' + y + '" stroke="#e5e7eb" stroke-width="1"/>');
    p.push('<text x="' + (mL - 6) + '" y="' + (+y + 3.5).toFixed(1) + '" text-anchor="end" font-size="10" fill="#6b7280">' + Math.round(maxClicks * frac) + "</text>");
    if (hasCpc) {
      p.push('<text x="' + (W - mR + 6) + '" y="' + (+y + 3.5).toFixed(1) + '" text-anchor="start" font-size="10" fill="#6b7280">' + fmtAxisCpc(maxCpc * frac) + "</text>");
    }
  }

  // столбики кликов (сегодня — полупрозрачный с пунктиром) + подпись значения
  days.forEach(function (d, i) {
    var clicks = d.clicks || 0;
    var x = xC(i);
    var bw = Math.min(band * 0.52, 40);
    var yTop = yC(clicks);
    var h = clicks > 0 ? Math.max(2, mT + ih - yTop) : 0;
    var todayFill = d.isToday ? ' opacity="0.55"' : "";
    var todayStroke = d.isToday ? ' stroke="#3f8ae0" stroke-dasharray="3 2" stroke-width="1"' : "";
    p.push(
      '<g><title>' + esc(fmtDateShort(d.date)) + (d.isToday ? " (сегодня, ещё идёт)" : "") +
      ": клики " + clicks + ", расход " + fmtMoneyPrecise(d.spend) + ", цена клика " + fmtCpc(d.cpc) + "</title>" +
      '<rect x="' + (x - bw / 2).toFixed(1) + '" y="' + yTop.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="3" fill="#3f8ae0"' + todayFill + todayStroke + "/>" +
      (clicks > 0 && showBarNums ? '<text x="' + x.toFixed(1) + '" y="' + (yTop - 5).toFixed(1) + '" text-anchor="middle" font-size="10" font-weight="600" fill="#0f172a">' + clicks + "</text>" : "") +
      "</g>"
    );
    if (i % labelStep === 0 || (i === n - 1 && (n - 1) % labelStep > 1)) {
      p.push(
        '<text x="' + x.toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="10"' +
        (d.isToday ? ' font-weight="600" fill="#3f8ae0"' : ' fill="#6b7280"') + ">" + esc(fmtDateShort(d.date)) + "</text>"
      );
    }
  });

  // линия цены клика — только там, где она известна (клики в этот день были)
  var pts = [];
  days.forEach(function (d, i) {
    if (d.cpc != null && isFinite(d.cpc)) pts.push({ x: xC(i), y: yP(d.cpc), d: d });
  });
  if (pts.length >= 2) {
    p.push(
      '<polyline points="' +
      pts.map(function (pt) { return pt.x.toFixed(1) + "," + pt.y.toFixed(1); }).join(" ") +
      '" fill="none" stroke="#d97706" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>'
    );
  }
  pts.forEach(function (pt) {
    p.push(
      '<circle cx="' + pt.x.toFixed(1) + '" cy="' + pt.y.toFixed(1) + '" r="3.5" fill="#d97706" stroke="#fff" stroke-width="1.5">' +
      '<title>' + esc(fmtDateShort(pt.d.date)) + ": цена клика " + fmtCpc(pt.d.cpc) + "</title></circle>"
    );
  });

  return '<svg class="chart-svg" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="График: клики и цена клика за ' + n + ' дней">' + p.join("") + "</svg>";
}

var STATUS = {
  nokey: { label: "нет ключа API", cls: "b-nokey" },
  token_limit: { label: "лимит токенов", cls: "b-limit" },
  error: { label: "ошибка", cls: "b-error" },
  pending: { label: "ждёт синхронизации", cls: "b-nokey" },
  empty: { label: "нет данных", cls: "b-nokey" },
};
function statusBadge(status, note) {
  if (status === "ok") return "";
  var s = STATUS[status] || STATUS.empty;
  return '<span class="badge ' + s.cls + '" title="' + esc(note || s.label) + '">' + s.label + "</span>";
}
function sum(vals) {
  var defined = vals.filter(function (v) { return v != null; });
  return defined.length ? defined.reduce(function (s, v) { return s + v; }, 0) : null;
}

// ---------- шапка и сводка ----------

function renderHeader(data) {
  var last = data.rows
    .map(function (c) { return c.lastSyncAt; })
    .filter(Boolean)
    .sort()
    .pop();
  var upd = last || data.generatedAt;
  document.getElementById("subtitle").textContent =
    "Сегодня " + fmtDateLong(data.today) + " (МСК)" + (upd ? " · обновлено " + fmtDateTimeMsk(upd) : "");
}

function renderTotals(data) {
  var rows = data.rows;
  var t = {
    balanceTotal: sum(rows.map(function (c) { return c.balanceTotal; })),
    balanceReal: sum(rows.map(function (c) { return c.balanceReal; })),
    balanceBonus: sum(rows.map(function (c) { return c.balanceBonus; })),
    spendYesterday: sum(rows.map(function (c) { return c.spendYesterday; })),
    spendDayBefore: sum(rows.map(function (c) { return c.spendDayBefore; })),
    spendMonth: sum(rows.map(function (c) { return c.spendMonth; })),
    messagesYesterday: sum(rows.map(function (c) { return c.messagesYesterday; })),
    messagesMonth: sum(rows.map(function (c) { return c.messagesMonth; })),
  };
  var spend2 = 0;
  var clicks2 = 0;
  var hasSpend2 = false;
  rows.forEach(function (c) {
    if (c.spendYesterday == null || c.spendDayBefore == null) return;
    hasSpend2 = true;
    spend2 += c.spendYesterday + c.spendDayBefore;
    clicks2 += clicksOn(c, data.yesterday) + clicksOn(c, data.dayBefore);
  });
  var cpc2 = hasSpend2 && clicks2 > 0 ? spend2 / clicks2 : null;

  var items = [
    { label: "Общий остаток", value: fmtMoneyPrecise(t.balanceTotal), muted: false },
    { label: "Реальные деньги", value: fmtMoneyPrecise(t.balanceReal), muted: false },
    { label: "Бонусы", value: fmtMoneyPrecise(t.balanceBonus), muted: true },
    { label: "Расход за " + fmtDateLong(data.yesterday), value: fmtMoneyPrecise(t.spendYesterday), muted: false },
    { label: "Расход за " + fmtDateLong(data.dayBefore), value: fmtMoneyPrecise(t.spendDayBefore), muted: false },
    { label: "Ср. цена клика (2 дня)", value: fmtCpc(cpc2), muted: false },
    { label: "Расход за 30 дней", value: fmtMoney(t.spendMonth), muted: true },
    { label: "Сообщений в группе (вчера)", value: t.messagesYesterday != null ? String(t.messagesYesterday) : "—", muted: false },
    { label: "Сообщений в группе (30 дн.)", value: t.messagesMonth != null ? String(t.messagesMonth) : "—", muted: false },
  ];
  var tiles = document.getElementById("totals-tiles");
  tiles.innerHTML = "";
  items.forEach(function (it) {
    tiles.appendChild(el(
      '<div class="tile' + (it.muted ? " muted" : "") + '">' +
      '<div class="label">' + esc(it.label) + '</div>' +
      '<div class="value">' + esc(it.value) + "</div></div>"
    ));
  });
}

// ---------- таблица ----------

function moneyCell(v) {
  if (v == null) return '<span class="na">—</span>';
  return '<span class="money">' + esc(fmtMoneyPrecise(v)) + "</span>";
}
function intCell(v) {
  if (v == null) return '<span class="na">—</span>';
  return "<span>" + esc(String(v)) + "</span>";
}

function cpcCellHtml(cab, data) {
  var v = cpc2days(cab, data);
  if (v == null) {
    var why = cab.status !== "ok" ? "" : "кликов за последние 2 дня не было";
    return '<span class="na" title="' + esc(why) + '">—</span>';
  }
  return '<span class="money">' + esc(fmtCpc(v)) + "</span>";
}

function renderTable(data) {
  var tbody = document.getElementById("table-body");
  tbody.innerHTML = "";

  if (!data.rows.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="loading">Нет данных</td></tr>';
    return;
  }

  data.rows.forEach(function (cab) {
    var low = isLow(cab);
    var tr = document.createElement("tr");
    if (low) tr.className = "low-row";
    tr.setAttribute("tabindex", "0");
    tr.setAttribute("role", "button");
    tr.setAttribute("aria-label", "Детали: " + cab.clientName);
    tr.addEventListener("click", function () { openModal(cab); });
    tr.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openModal(cab); }
    });

    // Кабинет
    var clientLine = cab.name !== cab.clientName
      ? '<span class="cab-client">' + esc(cab.clientName) + "</span>"
      : "";
    var cabCell =
      '<button type="button" class="cab-btn">' +
      '<span class="cab-name">' + esc(cab.name) +
      '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>' +
      "</span>" + clientLine + "</button>";

    // Общий остаток
    var totalCell;
    if (cab.balanceTotal == null) {
      totalCell = statusBadge(cab.status, cab.statusNote);
    } else if (low) {
      totalCell =
        '<span class="low" title="Живых денег меньше ' + LOW_REAL_THRESHOLD + ' ₽ — пора пополнять">' +
        esc(fmtMoneyPrecise(cab.balanceTotal)) + "</span>";
    } else {
      totalCell = '<span class="money-strong">' + esc(fmtMoneyPrecise(cab.balanceTotal)) + "</span>";
    }

    // Реальные деньги
    var realCell;
    if (cab.balanceReal == null) realCell = '<span class="na">—</span>';
    else if (low) realCell = '<span class="low">' + esc(fmtMoneyPrecise(cab.balanceReal)) + "</span>";
    else realCell = "<span>" + esc(fmtMoneyPrecise(cab.balanceReal)) + "</span>";

    // Сообщений в группе: показываем только у клиентов с подключённой группой;
    // при проблемах с токеном кабинета сообщения всё равно доступны
    var msgYestCell = cab.messagesSource === "group"
      ? intCell(cab.messagesYesterday)
      : cab.status !== "ok"
        ? statusBadge(cab.status, cab.statusNote)
        : intCell(null);

    tr.innerHTML =
      "<td>" + cabCell + "</td>" +
      "<td>" + totalCell + "</td>" +
      "<td>" + realCell + "</td>" +
      "<td>" + moneyCell(cab.spendYesterday) + "</td>" +
      "<td>" + moneyCell(cab.spendDayBefore) + "</td>" +
      "<td>" + cpcCellHtml(cab, data) + "</td>" +
      "<td>" + moneyCell(cab.spendMonth) + "</td>" +
      '<td class="cell-int">' + msgYestCell + "</td>" +
      '<td class="cell-int">' + intCell(cab.messagesSource === "group" ? cab.messagesMonth : null) + "</td>";
    tbody.appendChild(tr);
  });
}

// ---------- выбор периода в карточке клиента (7 / 30 / свой) ----------

function hasDaily(cab) {
  // подневные данные есть, если есть статистика рекламы (daily) ИЛИ сообщения группы
  return !!(cab && ((cab.daily && cab.dailyFrom) || cab.msgDaily));
}

// подпись выбранного периода: «последние 7 дней» / «период 06.05–05.11»
function periodLabel(kind) {
  if (PERIOD.mode === "custom" && PERIOD.from && PERIOD.to) {
    var s = fmtDateShort(PERIOD.from) + "–" + fmtDateShort(PERIOD.to);
    return kind === "short" ? s : "период " + s;
  }
  return kind === "short" ? PERIOD.mode + " дней" : "последние " + PERIOD.mode + " дней";
}

// серия дней выбранного периода: из daily (полгода) или clicks7 (старый data.json)
function periodSeries(cab) {
  if (!DATA || !DATA.today) return [];
  if (hasDaily(cab)) {
    var from = PERIOD.from || isoShift(DATA.today, -6);
    var to = PERIOD.to || DATA.today;
    var out = [];
    for (var iso = from; iso <= to; iso = isoShift(iso, 1)) {
      var d = cab.daily[iso] || null;
      var clicks = d ? d.clicks || 0 : 0;
      var spend = d ? d.spend || 0 : 0;
      out.push({
        date: iso,
        clicks: clicks,
        spend: spend,
        shows: d ? d.shows || 0 : 0,
        goals: d ? d.goals || 0 : 0,
        cpc: clicks > 0 ? spend / clicks : null,
        isToday: iso === DATA.today,
      });
    }
    return out;
  }
  return (cab.clicks7 || []).slice();
}

function syncPeriodBar(cab) {
  var chips = document.querySelectorAll("#period-chips .period-chip");
  Array.prototype.forEach.call(chips, function (chip) {
    chip.classList.toggle("active", chip.getAttribute("data-period") === PERIOD.mode);
  });
  var dates = document.getElementById("period-dates");
  var from = document.getElementById("period-from");
  var to = document.getElementById("period-to");
  var hint = document.getElementById("period-hint");
  if (!dates || !from || !to) return;
  dates.hidden = PERIOD.mode !== "custom";
  if (PERIOD.mode === "custom") {
    from.value = PERIOD.from || "";
    to.value = PERIOD.to || "";
    if (hasDaily(cab)) {
      from.min = cab.dailyFrom;
      to.min = cab.dailyFrom;
    }
    from.max = DATA.today;
    to.max = DATA.today;
    if (hint && hasDaily(cab)) {
      hint.textContent = "данные с " + fmtDateShort(cab.dailyFrom || cab.msgDailyFrom);
    }
  }
}

function setPeriodMode(mode) {
  var cab = CUR_CAB;
  if (!cab || !DATA || !DATA.today) return;
  PERIOD.mode = mode;
  if (mode === "custom") {
    if (!PERIOD.from || !PERIOD.to) {
      PERIOD.from = isoShift(DATA.today, -6);
      PERIOD.to = DATA.today;
    }
  } else {
    var days = parseInt(mode, 10) || 7;
    PERIOD.from = isoShift(DATA.today, -(days - 1));
    PERIOD.to = DATA.today;
  }
  syncPeriodBar(cab);
  renderDyn();
}

function onPeriodDateChange(which, value) {
  var cab = CUR_CAB;
  if (!cab || !DATA || !value) return;
  var min = hasDaily(cab) ? cab.dailyFrom : null;
  var max = DATA.today;
  var v = value;
  if (min && v < min) v = min;
  if (v > max) v = max;
  PERIOD.mode = "custom";
  if (which === "from") {
    PERIOD.from = v;
    if (!PERIOD.to || PERIOD.to < v) PERIOD.to = v;
  } else {
    PERIOD.to = v;
    if (PERIOD.from && PERIOD.from > v) PERIOD.from = v;
  }
  syncPeriodBar(cab);
  renderDyn();
}

function buildPeriodBar(cab) {
  var bar = el(
    '<div class="period-bar">' +
    '<div class="period-chips" id="period-chips" role="group" aria-label="Период статистики">' +
    '<button type="button" class="period-chip active" data-period="7">7 дней</button>' +
    '<button type="button" class="period-chip" data-period="30">30 дней</button>' +
    '<button type="button" class="period-chip" data-period="custom">Свой период</button>' +
    "</div>" +
    '<div class="period-dates" id="period-dates" hidden>' +
    '<label>с <input type="date" id="period-from" aria-label="Начало периода"></label>' +
    '<label>по <input type="date" id="period-to" aria-label="Конец периода"></label>' +
    '<span class="period-hint" id="period-hint"></span>' +
    "</div>" +
    "</div>"
  );
  var chips = bar.querySelectorAll(".period-chip");
  Array.prototype.forEach.call(chips, function (chip) {
    var v = chip.getAttribute("data-period");
    if (!hasDaily(cab) && v !== "7") {
      chip.disabled = true;
      chip.title = "Станет доступно после следующего обновления данных";
      return;
    }
    chip.addEventListener("click", function () { setPeriodMode(v); });
  });
  var from = bar.querySelector("#period-from");
  var to = bar.querySelector("#period-to");
  if (from) from.addEventListener("change", function () { onPeriodDateChange("from", this.value); });
  if (to) to.addEventListener("change", function () { onPeriodDateChange("to", this.value); });
  return bar;
}

function pluralWriters(n) {
  var m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "человек";
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return "человека";
  return "человек";
}

// серия дней выбранного периода по сообщениям группы (уникальные писавшие).
// Данные сообщений начинаются с msgDailyFrom (когда группу подключили) —
// дни до него не рисуем, вместо этого подсказка.
function msgSeries(cab) {
  if (!cab.msgDaily || !DATA.today) return [];
  var from = PERIOD.from || isoShift(DATA.today, -6);
  var to = PERIOD.to || DATA.today;
  var min = cab.msgDailyFrom || null;
  if (min && from < min) from = min;
  if (from > to) return [];
  var out = [];
  for (var iso = from; iso <= to; iso = isoShift(iso, 1)) {
    out.push({
      date: iso,
      writers: cab.msgDaily[iso] || 0,
      isToday: iso === DATA.today,
    });
  }
  return out;
}

// перерисовать график + таблицу под выбранный период
function renderDyn() {
  var cab = CUR_CAB;
  var box = DYN_EL;
  if (!cab || !box) return;
  box.innerHTML = "";

  var series = periodSeries(cab);
  var hasActivity = series.some(function (d) { return d.clicks || d.spend || d.shows || d.goals; });

  // подзаголовок карточки — под выбранный период
  if (cab.status === "ok") {
    document.getElementById("modal-subtitle").textContent =
      "клики и цена клика за " + periodLabel();
  } else if (cab.messagesSource === "group") {
    document.getElementById("modal-subtitle").textContent =
      "реклама недоступна — сообщения группы за " + periodLabel();
  }

  if (series.length && hasActivity) {
    var totalClicks = 0;
    var totalSpend = 0;
    series.forEach(function (d) { totalClicks += d.clicks || 0; totalSpend += d.spend || 0; });

    // график: столбики кликов + линия цены клика за выбранный период
    box.appendChild(el(
      '<div class="chart-wrap">' +
      '<div class="chart-head">' +
      '<span class="chart-title">Динамика за ' + esc(periodLabel("short")) + "</span>" +
      '<span class="chart-legend">' +
      '<span class="leg leg-bar"><i></i>клики, шт</span>' +
      '<span class="leg leg-line"><i></i>цена клика, ₽</span>' +
      "</span></div>" +
      buildChartSvg(series) +
      "</div>"
    ));

    // подневная таблица за выбранный период
    var rowsHtml = series.map(function (d) {
      var todayNote = d.isToday ? '<span class="today-note">сегодня, ещё идёт</span>' : "";
      return (
        "<tr>" +
        "<td>" + esc(fmtDateShort(d.date)) + todayNote + "</td>" +
        "<td>" + esc(String(d.clicks)) + "</td>" +
        "<td>" + esc(fmtMoneyPrecise(d.spend)) + "</td>" +
        "<td>" + esc(fmtCpc(d.cpc)) + "</td>" +
        "</tr>"
      );
    }).join("");
    var totalLabel = PERIOD.mode === "custom" ? "Итого за период" : "Итого за " + PERIOD.mode + " дней";
    var totalRow =
      '<tr class="total-row">' +
      "<td>" + esc(totalLabel) + "</td>" +
      "<td>" + esc(String(totalClicks)) + "</td>" +
      "<td>" + esc(fmtMoneyPrecise(totalSpend)) + "</td>" +
      "<td>" + esc(fmtCpc(totalClicks > 0 ? totalSpend / totalClicks : null)) + '<span class="cpc-note">средняя цена клика</span></td>' +
      "</tr>";
    box.appendChild(el(
      '<div class="clicks-table-wrap"><table class="clicks-table"><thead><tr>' +
      "<th>Дата</th><th>Клики</th><th>Расход</th><th>Цена клика</th>" +
      "</tr></thead><tbody>" + rowsHtml + totalRow + "</tbody></table></div>"
    ));
  } else {
    box.appendChild(el('<p class="no-data">За выбранный период показов и кликов не было.</p>'));
  }

  // сообщения группы — тем же периодом (если группа подключена)
  renderMsgDyn(cab, box);
}

// блок сообщений группы в карточке: график + таблица по выбранному периоду
function renderMsgDyn(cab, box) {
  if (!cab.msgDaily) return;
  var mseries = msgSeries(cab);
  var mTotal = 0;
  mseries.forEach(function (d) { mTotal += d.writers || 0; });

  var head =
    '<div class="chart-head msg-head">' +
    '<span class="chart-title">Сообщения в группе' +
    (cab.groupName ? " — " + esc(cab.groupName) : "") + "</span>" +
    '<span class="chart-legend"><span class="leg leg-msg"><i></i>писавшие, чел</span></span>' +
    "</div>";

  var hintFrom = cab.msgDailyFrom && PERIOD.from && cab.msgDailyFrom > PERIOD.from
    ? '<p class="period-hint msg-from-hint">данные сообщений — с ' + esc(fmtDateShort(cab.msgDailyFrom)) + " (тогда подключили группу)</p>"
    : "";

  var chart = mseries.length
    ? '<div class="chart-wrap">' + head + buildMsgChartSvg(mseries) + "</div>"
    : '<div class="chart-wrap">' + head + '<p class="no-data">За выбранный период данных сообщений нет.</p></div>';
  box.appendChild(el(chart + hintFrom));

  if (!mseries.length) return;

  var mRows = mseries.map(function (d) {
    var todayNote = d.isToday ? '<span class="today-note">сегодня, ещё идёт</span>' : "";
    return (
      "<tr>" +
      "<td>" + esc(fmtDateShort(d.date)) + todayNote + "</td>" +
      '<td class="cell-int">' + esc(String(d.writers)) + "</td>" +
      "</tr>"
    );
  }).join("");
  var mTotalLabel = PERIOD.mode === "custom" ? "Итого за период" : "Итого за " + PERIOD.mode + " дней";
  var mTotalRow =
    '<tr class="total-row">' +
    "<td>" + esc(mTotalLabel) + "</td>" +
    '<td class="cell-int">' + esc(String(mTotal)) + ' <span class="cpc-note">' + esc(pluralWriters(mTotal) + " писали") + "</span></td>" +
    "</tr>";
  box.appendChild(el(
    '<div class="clicks-table-wrap"><table class="clicks-table msgs-table"><thead><tr>' +
    "<th>Дата</th><th>Писавших в группу</th>" +
    "</tr></thead><tbody>" + mRows + mTotalRow + "</tbody></table></div>"
  ));
}

// ---------- карточка клиента (модалка) ----------

function openModal(cab) {
  CUR_CAB = cab;
  PERIOD = { mode: "7", from: null, to: null };
  DYN_EL = null;
  document.getElementById("modal-title").textContent = cab.clientName || cab.name;
  var hasData = cab.status === "ok";
  var hasGroup = cab.messagesSource === "group";
  document.getElementById("modal-subtitle").textContent = hasData
    ? "клики и цена клика за последние 7 дней"
    : hasGroup
      ? "реклама недоступна — внутри только сообщения группы"
      : "нет данных по кабинету";

  var body = document.getElementById("modal-body");
  body.innerHTML = "";

  var block = el('<div class="cab-block"></div>');

  var meta = cab.extId ? "кабинет " + cab.extId : "кабинет без ID";
  if (cab.campaignsCount != null) meta += " · кампаний: " + cab.campaignsCount;
  block.appendChild(el(
    '<div class="cab-block-head"><h3>' + esc(cab.name) + '</h3><span class="meta">' + esc(meta) + "</span></div>"
  ));

  // плитки со статами
  var stats = [
    { label: "Баланс", value: cab.balanceTotal != null ? fmtMoneyPrecise(cab.balanceTotal) : "—", strong: true },
    { label: "Живые деньги", value: cab.balanceReal != null ? fmtMoneyPrecise(cab.balanceReal) : "—", strong: false, low: isLow(cab) },
    { label: "Бонусы", value: cab.balanceBonus != null ? fmtMoneyPrecise(cab.balanceBonus) : "—", muted: true },
    { label: "Расход вчера", value: cab.spendYesterday != null ? fmtMoneyPrecise(cab.spendYesterday) : "—", strong: true },
    { label: "Расход позавчера", value: cab.spendDayBefore != null ? fmtMoneyPrecise(cab.spendDayBefore) : "—", strong: true },
    { label: "Расход за 30 дней", value: cab.spendMonth != null ? fmtMoney(cab.spendMonth) : "—", muted: true },
  ];
  if (cab.messagesSource === "group") {
    stats.push({ label: "Писали в группу — вчера", value: cab.messagesYesterday != null ? String(cab.messagesYesterday) + " чел." : "—", strong: true });
    stats.push({ label: "Писали в группу — за 30 дней", value: cab.messagesMonth != null ? String(cab.messagesMonth) + " чел." : "—", strong: true });
  }
  var grid = el('<div class="cab-stats"></div>');
  stats.forEach(function (s) {
    var cls = "tile" + (s.muted ? " muted" : "");
    var vcls = "value" + (s.low ? " low" : "");
    grid.appendChild(el(
      '<div class="' + cls + '"><div class="label">' + esc(s.label) + '</div><div class="' + vcls + '">' + esc(s.value) + "</div></div>"
    ));
  });
  block.appendChild(grid);

  // выбор периода (7 / 30 / свой) + динамика под него (клики и/или сообщения группы)
  if (hasData || hasGroup) {
    block.appendChild(buildPeriodBar(cab));
    DYN_EL = el('<div class="dyn-wrap"></div>');
    block.appendChild(DYN_EL);
    renderDyn();
  }

  if (isLow(cab)) {
    block.appendChild(el(
      '<p class="low-note">Живых денег осталось меньше ' + LOW_REAL_THRESHOLD + " ₽ — нужно пополнить кабинет</p>"
    ));
  }

  block.appendChild(el('<p class="footnote">«Сегодня» — данные за неполный день, накопление идёт в течение суток. Период можно сменить над графиком: 7 дней (по умолчанию), 30 дней или свой — он действует и на клики, и на сообщения группы (если группа подключена).</p>'));

  body.appendChild(block);
  document.getElementById("modal").hidden = false;
  document.body.style.overflow = "hidden";
}

function closeModal() {
  document.getElementById("modal").hidden = true;
  document.body.style.overflow = "";
}

// ---------- загрузка данных ----------

function loadData(isManual) {
  var btn = document.getElementById("refresh-btn");
  var icon = document.getElementById("refresh-icon");
  var label = document.getElementById("refresh-label");
  btn.disabled = true;
  icon.classList.add("spin");
  label.textContent = "Обновление…";

  fetch("data.json?ts=" + Date.now(), { cache: "no-store" })
    .then(function (r) { return r.ok ? r.json() : Promise.reject("HTTP " + r.status); })
    .then(function (data) {
      DATA = data;
      renderHeader(data);
      renderTotals(data);
      renderTable(data);
    })
    .catch(function (e) {
      document.getElementById("subtitle").textContent =
        "Не удалось загрузить данные (" + e + ") — обновите страницу чуть позже";
    })
    .finally(function () {
      btn.disabled = false;
      icon.classList.remove("spin");
      label.textContent = "Обновить";
    });
}

document.getElementById("refresh-btn").addEventListener("click", function () { loadData(true); });
document.getElementById("modal-close").addEventListener("click", closeModal);
document.getElementById("modal").addEventListener("click", function (e) {
  if (e.target === document.getElementById("modal")) closeModal();
});
document.addEventListener("keydown", function (e) {
  if (e.key === "Escape") closeModal();
});

// восстановить свёрнутость сводки (как в панели — по умолчанию скрыта)
try {
  if (localStorage.getItem("vk-dash:totals-visible") === "1") {
    document.getElementById("totals-details").open = true;
  }
} catch (e) { /* noop */ }
document.getElementById("totals-details").addEventListener("toggle", function () {
  try {
    localStorage.setItem("vk-dash:totals-visible", this.open ? "1" : "0");
  } catch (e) { /* noop */ }
});

loadData();
setInterval(loadData, 5 * 60 * 1000); // сами подтягиваем свежие данные раз в 5 минут
