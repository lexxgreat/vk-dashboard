#!/usr/bin/env node
// Сбор данных VK Рекламы → data.json для статического сайта на GitHub Pages.
// Автономный скрипт (только Node 20+, без зависимостей). Запускается:
//  - локально:   node scripts/fetch_and_export.mjs --tokens-file ../db/tokens_backup.json
//  - в GitHub Actions: VK_TOKENS = {"16019221":"<токен>", ...} (repository secret)
//
// Логика — точная копия дашборда: баланс по transaction_groups (депозиты − списания,
// разделение живые/бонус по событиям), статистика по /statistics/ad_plans/day.json,
// даты в МСК (UTC+3), сообщения = конверсии (base.vk.goals || base.goals).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://ads.vk.com/api/v2";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_FILE = path.join(ROOT, "data.json");
const CAB_FILE = path.join(ROOT, "cabinets.json");

// ---------- аргументы ----------

const argv = process.argv.slice(2);
const tokensFileIdx = argv.indexOf("--tokens-file");
const tokensFile = tokensFileIdx >= 0 ? argv[tokensFileIdx + 1] : null;

// ---------- даты (МСК = UTC+3) ----------

function mskTodayIso() {
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}
function isoAddDays(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------- токены ----------

function loadTokens() {
  if (process.env.VK_TOKENS) {
    const raw = JSON.parse(process.env.VK_TOKENS);
    // допускаем {"16019221":"токен"} и {"16019221":{"access_token":"токен"}}
    const out = {};
    for (const [k, v] of Object.entries(raw)) out[k] = typeof v === "string" ? v : v.access_token;
    return out;
  }
  if (tokensFile) {
    const raw = JSON.parse(fs.readFileSync(tokensFile, "utf8"));
    const out = {};
    for (const [k, v] of Object.entries(raw)) out[k] = typeof v === "string" ? v : v.access_token;
    return out;
  }
  console.error("Нет токенов: задайте VK_TOKENS или --tokens-file <файл>");
  process.exit(1);
}

// ---------- баланс: transaction_groups (как в дашборде) ----------

async function fetchAllTxGroups(token) {
  const all = [];
  for (let off = 0; off < 5000; off += 200) {
    const res = await fetch(`${BASE}/billing/transaction_groups.json?limit=200&offset=${off}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401) throw new Error("токен недействителен (401)");
    const r = await res.json();
    if (!r.items || r.items.length === 0) break;
    all.push(...r.items);
    if (r.items.length < 200) break;
  }
  return all;
}

function computeBalance(groups) {
  const sum = (arr) => arr.reduce((s, t) => s + parseFloat(t.amount || "0"), 0);
  const deposits = groups.filter((t) => t.type === "deposit");
  const charges = groups.filter((t) => t.type === "charge");
  const total = sum(deposits) - sum(charges);

  const events = [];
  const dayOf = (s) => (s || "").slice(0, 10);
  const hourOf = (s) => parseInt((s || "").slice(11, 13) || "12", 10) || 12;

  for (const t of groups) {
    const amt = parseFloat(t.amount || "0");
    const desc = t.description || "";
    if (t.type === "deposit") {
      events.push({ day: dayOf(t.first_at), hour: hourOf(t.first_at), kind: "dep", amt, isBonus: /бонус/i.test(desc) });
    } else if (t.type === "charge") {
      if (/сжигание бонус/i.test(desc)) {
        events.push({ day: dayOf(t.last_at || t.first_at), hour: hourOf(t.last_at || t.first_at), kind: "burn", amt, isBonus: true });
      } else {
        const d1 = dayOf(t.first_at);
        const d2 = dayOf(t.last_at || t.first_at);
        if (!d1 || d1 === d2 || !d2 || d2 < d1) {
          events.push({ day: d1, hour: hourOf(t.first_at), kind: "charge", amt, isBonus: false });
        } else {
          const days = Math.round((Date.parse(d2) - Date.parse(d1)) / 86_400_000) + 1;
          const per = Math.round((amt / days) * 100) / 100;
          let rest = amt;
          for (let i = 0; i < days; i++) {
            const iso = new Date(Date.parse(d1) + i * 86_400_000).toISOString().slice(0, 10);
            const a = i === days - 1 ? rest : per;
            rest = Math.round((rest - a) * 100) / 100;
            events.push({ day: iso, hour: 12, kind: "charge", amt: a, isBonus: false });
          }
        }
      }
    }
  }
  events.sort((a, b) => a.day.localeCompare(b.day) || a.hour - b.hour);

  let real = 0;
  let bonus = 0;
  for (const e of events) {
    if (e.kind === "dep") {
      if (e.isBonus) bonus += e.amt;
      else real += e.amt;
    } else if (e.kind === "burn") {
      bonus = Math.max(0, bonus - e.amt);
    } else {
      const fromBonus = Math.min(Math.max(bonus, 0), e.amt);
      bonus -= fromBonus;
      real -= e.amt - fromBonus;
    }
  }
  if (real < 0 && bonus > 0) {
    const shift = Math.min(bonus, -real);
    bonus -= shift;
    real += shift;
  }
  return { total, real, bonus };
}

// ---------- статистика: ad_plans/day (как в дашборде) ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastStatsCall = 0; // троттлинг: не чаще одного запроса статистики в 3 секунды

async function fetchDailyStats(token, dateFrom, dateTo) {
  const url = `${BASE}/statistics/ad_plans/day.json?date_from=${dateFrom}&date_to=${dateTo}`;
  const auth = { Authorization: `Bearer ${token}` };

  let lastErr = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = 3000 - (Date.now() - lastStatsCall);
    if (wait > 0) await sleep(wait);
    lastStatsCall = Date.now();
    const res = await fetch(url, { headers: auth, signal: AbortSignal.timeout(30_000) });
    if (res.status === 401) throw new Error("токен недействителен (401)");
    const r = await res.json();
    if (r.items) {
      const byDate = {};
      for (const it of r.items) {
        for (const row of it.rows || []) {
          const d = (byDate[row.date] = byDate[row.date] || { clicks: 0, spend: 0, shows: 0, goals: 0 });
          d.clicks += row.base?.clicks || 0;
          d.spend += parseFloat(row.base?.spent || "0");
          d.shows += row.base?.shows || 0;
          d.goals += row.base?.vk?.goals || row.base?.goals || 0;
        }
      }
      return byDate;
    }
    lastErr = JSON.stringify(r).slice(0, 120);
    console.warn(`  лимит статистики, повтор через ${30 + attempt * 30} с: ${lastErr}`);
    await sleep((30 + attempt * 30) * 1000);
  }
  throw new Error(`превышен лимит запросов статистики: ${lastErr}`);
}

async function fetchCampaignsCount(token) {
  try {
    const res = await fetch(`${BASE}/campaigns.json?limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401) throw new Error("токен недействителен (401)");
    const r = await res.json();
    return typeof r.count === "number" ? r.count : null;
  } catch {
    return null;
  }
}

// ---------- главный цикл ----------

const r2 = (v) => Math.round(v * 100) / 100;

async function main() {
  const tokens = loadTokens();
  const cabinets = JSON.parse(fs.readFileSync(CAB_FILE, "utf8"));
  const today = mskTodayIso();
  const yesterday = isoAddDays(today, -1);
  const dayBefore = isoAddDays(today, -2);
  const from = isoAddDays(today, -30);

  console.log(`сбор данных: ${cabinets.length} кабинетов, сегодня (МСК) ${today}`);

  const rows = [];
  for (const cab of cabinets) {
    const extId = cab.extId;
    const token = extId != null ? tokens[String(extId)] : null;
    if (!token) {
      console.log(`${cab.name}: нет токена → статус ${cab.noTokenStatus}`);
      rows.push({
        extId,
        name: cab.name,
        clientName: cab.clientName,
        status: cab.noTokenStatus || "nokey",
        statusNote: cab.noTokenNote ?? "нет токена в секретах",
        lastSyncAt: null,
        balanceTotal: null,
        balanceReal: null,
        balanceBonus: null,
        spendYesterday: null,
        spendDayBefore: null,
        spendMonth: null,
        messagesYesterday: null,
        messagesMonth: null,
        campaignsCount: null,
        clicks7: [],
        clicks7Total: { clicks: 0, spend: 0, cpc: null },
      });
      continue;
    }

    try {
      console.log(`${cab.name}: запрашиваю баланс…`);
      const bal = computeBalance(await fetchAllTxGroups(token));

      console.log(`${cab.name}: запрашиваю статистику за 31 день…`);
      const byDate = await fetchDailyStats(token, from, today);
      const stat = (iso) => byDate[iso] || null;

      let spendMonth = 0;
      let messagesMonth = 0;
      for (let i = 1; i <= 30; i++) {
        spendMonth += stat(isoAddDays(today, -i))?.spend || 0;
        messagesMonth += stat(isoAddDays(today, -i))?.goals || 0;
      }

      // 7-дневная таблица кликов (карточка клиента)
      const clicks7 = [];
      for (let i = 6; i >= 0; i--) {
        const iso = isoAddDays(today, -i);
        const s = stat(iso);
        if (!s) continue;
        clicks7.push({
          date: iso,
          clicks: s.clicks,
          spend: r2(s.spend),
          cpc: s.clicks > 0 ? s.spend / s.clicks : null,
          isToday: i === 0,
        });
      }
      const c7clicks = clicks7.reduce((s, d) => s + d.clicks, 0);
      const c7spend = clicks7.reduce((s, d) => s + d.spend, 0);

      const campaignsCount = await fetchCampaignsCount(token);
      await sleep(1500); // пауза между кабинетами

      rows.push({
        extId,
        name: cab.name,
        clientName: cab.clientName,
        status: "ok",
        statusNote: null,
        lastSyncAt: new Date().toISOString(),
        balanceTotal: r2(bal.total),
        balanceReal: r2(bal.real),
        balanceBonus: r2(bal.bonus),
        spendYesterday: stat(yesterday) ? r2(stat(yesterday).spend) : 0,
        spendDayBefore: stat(dayBefore) ? r2(stat(dayBefore).spend) : 0,
        spendMonth: r2(spendMonth),
        messagesYesterday: stat(yesterday)?.goals || 0,
        messagesMonth,
        campaignsCount,
        clicks7,
        clicks7Total: { clicks: c7clicks, spend: r2(c7spend), cpc: c7clicks > 0 ? c7spend / c7clicks : null },
      });
      console.log(
        `  ${cab.name}: баланс ${bal.total.toFixed(2)} ₽ (живые ${bal.real.toFixed(2)}), вчера ${(stat(yesterday)?.spend || 0).toFixed(2)} ₽, сообщений ${stat(yesterday)?.goals || 0}`
      );
    } catch (e) {
      const msg = String(e.message || e).slice(0, 300);
      console.warn(`  ${cab.name}: ошибка — ${msg}`);
      rows.push({
        extId,
        name: cab.name,
        clientName: cab.clientName,
        status: "error",
        statusNote: msg,
        lastSyncAt: new Date().toISOString(),
        balanceTotal: null,
        balanceReal: null,
        balanceBonus: null,
        spendYesterday: null,
        spendDayBefore: null,
        spendMonth: null,
        messagesYesterday: null,
        messagesMonth: null,
        campaignsCount: null,
        clicks7: [],
        clicks7Total: { clicks: 0, spend: 0, cpc: null },
      });
    }
  }

  const data = {
    generatedAt: new Date().toISOString(),
    today,
    yesterday,
    dayBefore,
    rows,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(data, null, 2));
  const okCount = rows.filter((r) => r.status === "ok").length;
  console.log(`\ndata.json записан: ${rows.length} кабинетов (${okCount} с данными) → ${OUT_FILE}`);
}

main().catch((e) => {
  console.error("СБОЙ СБОРА ДАННЫХ:", e);
  process.exit(1);
});
