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
  var items = [
    { label: "Общий остаток", value: fmtMoneyPrecise(t.balanceTotal), muted: false },
    { label: "Реальные деньги", value: fmtMoneyPrecise(t.balanceReal), muted: false },
    { label: "Бонусы", value: fmtMoneyPrecise(t.balanceBonus), muted: true },
    { label: "Расход за " + fmtDateLong(data.yesterday), value: fmtMoneyPrecise(t.spendYesterday), muted: false },
    { label: "Расход за " + fmtDateLong(data.dayBefore), value: fmtMoneyPrecise(t.spendDayBefore), muted: false },
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

function renderTable(data) {
  var tbody = document.getElementById("table-body");
  tbody.innerHTML = "";

  if (!data.rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="loading">Нет данных</td></tr>';
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
    ? "клики за последние 7 дней"
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
