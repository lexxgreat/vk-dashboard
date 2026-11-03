// VK Дашборд — статический сайт для GitHub Pages.
// Читает data.json (обновляется GitHub Actions по расписанию) и рисует
// ту же широкую таблицу, что и рабочая панель: строка = кабинет, 8 столбцов.

"use strict";

var LOW_REAL_THRESHOLD = 300;
var DATA = null;

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
      (clicks > 0 ? '<text x="' + x.toFixed(1) + '" y="' + (yTop - 5).toFixed(1) + '" text-anchor="middle" font-size="10" font-weight="600" fill="#0f172a">' + clicks + "</text>" : "") +
      "</g>"
    );
    p.push(
      '<text x="' + x.toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="10"' +
      (d.isToday ? ' font-weight="600" fill="#3f8ae0"' : ' fill="#6b7280"') + ">" + esc(fmtDateShort(d.date)) + "</text>"
    );
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
    { label: "Сообщений вчера", value: t.messagesYesterday != null ? String(t.messagesYesterday) : "—", muted: false },
    { label: "Сообщений за 30 дней", value: t.messagesMonth != null ? String(t.messagesMonth) : "—", muted: false },
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

    // Сообщений вчера: при проблеме показываем бейдж статуса
    var msgYestCell = cab.status !== "ok"
      ? statusBadge(cab.status, cab.statusNote)
      : intCell(cab.messagesYesterday);

    tr.innerHTML =
      "<td>" + cabCell + "</td>" +
      "<td>" + totalCell + "</td>" +
      "<td>" + realCell + "</td>" +
      "<td>" + moneyCell(cab.spendYesterday) + "</td>" +
      "<td>" + moneyCell(cab.spendDayBefore) + "</td>" +
      "<td>" + cpcCellHtml(cab, data) + "</td>" +
      "<td>" + moneyCell(cab.spendMonth) + "</td>" +
      '<td class="cell-int">' + msgYestCell + "</td>" +
      '<td class="cell-int">' + intCell(cab.messagesMonth) + "</td>";
    tbody.appendChild(tr);
  });
}

// ---------- карточка клиента (модалка) ----------

function openModal(cab) {
  document.getElementById("modal-title").textContent = cab.clientName || cab.name;
  var hasData = cab.status === "ok";
  document.getElementById("modal-subtitle").textContent = hasData
    ? "клики и цена клика за последние 7 дней"
    : statusBadge(cab.status, cab.statusNote) ? "нет данных по кабинету" : "";

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
  var grid = el('<div class="cab-stats"></div>');
  stats.forEach(function (s) {
    var cls = "tile" + (s.muted ? " muted" : "");
    var vcls = "value" + (s.low ? " low" : "");
    grid.appendChild(el(
      '<div class="' + cls + '"><div class="label">' + esc(s.label) + '</div><div class="' + vcls + '">' + esc(s.value) + "</div></div>"
    ));
  });
  block.appendChild(grid);

  // график: столбики кликов + линия цены клика за 7 дней
  if (cab.clicks7 && cab.clicks7.length) {
    block.appendChild(el(
      '<div class="chart-wrap">' +
      '<div class="chart-head">' +
      '<span class="chart-title">Динамика за 7 дней</span>' +
      '<span class="chart-legend">' +
      '<span class="leg leg-bar"><i></i>клики, шт</span>' +
      '<span class="leg leg-line"><i></i>цена клика, ₽</span>' +
      "</span></div>" +
      buildChartSvg(cab.clicks7) +
      "</div>"
    ));
  }

  if (isLow(cab)) {
    block.appendChild(el(
      '<p class="low-note">Живых денег осталось меньше ' + LOW_REAL_THRESHOLD + " ₽ — нужно пополнить кабинет</p>"
    ));
  }

  // 7-дневная таблица кликов
  if (cab.clicks7 && cab.clicks7.length) {
    var total = cab.clicks7Total;
    var rowsHtml = cab.clicks7.map(function (d) {
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
    var totalRow =
      '<tr class="total-row">' +
      "<td>Итого за 7 дней</td>" +
      "<td>" + esc(String(total.clicks)) + "</td>" +
      "<td>" + esc(fmtMoneyPrecise(total.spend)) + "</td>" +
      "<td>" + esc(fmtCpc(total.cpc)) + '<span class="cpc-note">средняя цена клика</span></td>' +
      "</tr>";
    block.appendChild(el(
      '<div class="clicks-table-wrap"><table class="clicks-table"><thead><tr>' +
      "<th>Дата</th><th>Клики</th><th>Расход</th><th>Цена клика</th>" +
      "</tr></thead><tbody>" + rowsHtml + totalRow + "</tbody></table></div>"
    ));
  } else if (hasData) {
    block.appendChild(el('<p class="no-data">За последние 7 дней показов и кликов не было.</p>'));
  }

  block.appendChild(el('<p class="footnote">«Сегодня» — данные за неполный день, накопление идёт в течение суток.</p>'));

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
