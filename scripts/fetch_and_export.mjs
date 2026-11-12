#!/usr/bin/env node
// Сбор данных VK Рекламы → data.json для статического сайта на GitHub Pages.
// Автономный скрипт (только Node 20+, без зависимостей). Запускается:
//  - локально:   node scripts/fetch_and_export.mjs --tokens-file ../db/tokens_backup.json
//  - в GitHub Actions: VK_TOKENS = {"16019221":"<токен>", ...} (repository secret)
//
// Логика — точная копия дашборда: баланс по transaction_groups (депозиты − списания,
// разделение живые/бонус по событиям), статистика по /statistics/ad_plans/day.json,
// даты в МСК (UTC+3).
//
// СООБЩЕНИЯ: считаются из сообществ клиентов (groups-stats.json — уникальные
// пользователи, писавшие в диалоги группы, по дням; файл обновляет панель при
// синхронизации групп). Кабинеты без привязанной группы сообщений не имеют
// (null → на сайте «—»). Конверсии-цели рекламы больше не используются.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://ads.vk.com/api/v2";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_FILE = path.join(ROOT, "data.json");
const CAB_FILE = path.join(ROOT, "cabinets.json");
// Статистика сообщений сообществ (уникальные писавшие по дням) — из репозитория
const GROUPS_FILE = path.join(ROOT, "groups-stats.json");
// Глубина подневной статистики в data.json (полгода) — для выбора периода
// 7 / 30 / свой период в карточке клиента на сайте. API отдаёт и более
// длинные диапазоны одним вызовом, поэтому расширение окна не добавляет запросов.
const STATS_DAYS = 183;

// ---------- транспорт: прямой VK API или прокси TargetHunter ----------
// Токены с префиксом "THPROXY:" идут через прокси TargetHunter
// (агентские кабинеты ТН: rk.targethunter.ru), остальные — напрямую с Bearer.
const TH_PROXY_PREFIX = "THPROXY:";
const TH_PROXY_URL = "https://rk.targethunter.ru/vkr.request";

const TH_PROXY_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
  "Accept": "application/json, text/plain, */*",
  "Origin": "https://rk.targethunter.ru",
  "Referer": "https://rk.targethunter.ru/",
};

async function vkGet(token, pathWithQuery) {
  if (token.startsWith(TH_PROXY_PREFIX)) {
    const res = await fetch(TH_PROXY_URL, {
      method: "POST",
      headers: TH_PROXY_HEADERS,
      body: new URLSearchParams({
        method: `/api/v2${pathWithQuery}`,
        params: "",
        access_token: token.slice(TH_PROXY_PREFIX.length),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      throw new Error(`TH proxy non-JSON: ${text.slice(0, 120)}`);
    }
    if (j && typeof j === "object" && "status" in j && "response" in j) {
      if (j.status !== true) throw new Error(`токен прокси ТН недействителен: ${j.msg || "запрос отклонён"}`);
      return typeof j.response === "string" ? JSON.parse(j.response) : j.response;
    }
    return j;
  }
  const res = await fetch(`${BASE}${pathWithQuery}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401) throw new Error("токен недействителен (401)");
  return res.json();
}

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
    const r = await vkGet(token, `/billing/transaction_groups.json?limit=200&offset=${off}`);
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
  // Общий баланс VK: все деньги кабинета (живые + бонусные) = Σдепозитов − Σсписаний.
  const gross = sum(deposits) - sum(charges);
  const total = Math.max(r2(gross), 0);

  // Механика VK Рекламы (та же, что в панели src/lib/funds.ts, подтверждена транзакциями):
  //   • депозит без слова «бонус» — живые деньги; с «бонус» — бонусные.
  //   • «Сжигание бонусов» списывает только бонусный счёт (срез по остатку).
  //   • списания за показы тратят живые и бонусные 50/50: бонус компенсирует
  //     не более половины расхода, пока не кончится.
  const kindOf = (t) => {
    const d = t.description || "";
    const bonusWord = /онус|жиган/.test(d); // «Бонус…» / «Сжигание бонусов»
    if (t.type === "deposit") return bonusWord ? "bonus_dep" : "real_dep";
    if (t.type === "charge") return bonusWord ? "bonus_burn" : "spend";
    return "other";
  };
  const tsOf = (t) => Date.parse(String(t.first_at || t.last_at || "").replace(" ", "T") + "Z") || 0;
  const sorted = [...groups].sort((a, b) => tsOf(a) - tsOf(b));

  let bonus = 0;
  for (const t of sorted) {
    const amt = parseFloat(t.amount || "0");
    switch (kindOf(t)) {
      case "bonus_dep":
        bonus += amt;
        break;
      case "bonus_burn":
        bonus = Math.max(0, bonus - amt); // срез по остатку: лишнего не теряем
        break;
      case "spend": {
        const bonusPart = Math.min(Math.max(bonus, 0), amt / 2); // 50/50
        bonus -= bonusPart;
        break;
      }
      default:
        break;
    }
  }

  // Нормализация: реальные деньги = общий баланс − бонусы (никогда не включают бонусы,
  // и real + bonus всегда равны общему балансу VK до копейки).
  const bonusFinal = Math.max(0, Math.min(r2(bonus), total));
  const realFinal = r2(total - bonusFinal);
  return { total: r2(total), real: realFinal, bonus: bonusFinal };
}

// ---------- статистика: ad_plans/day (как в дашборде) ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastStatsCall = 0; // троттлинг: не чаще одного запроса статистики в 3 секунды

async function fetchDailyStats(token, dateFrom, dateTo) {
  const url = `/statistics/ad_plans/day.json?date_from=${dateFrom}&date_to=${dateTo}`;

  let lastErr = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = 3000 - (Date.now() - lastStatsCall);
    if (wait > 0) await sleep(wait);
    lastStatsCall = Date.now();
    const r = await vkGet(token, url);
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
    const r = await vkGet(token, "/campaigns.json?limit=1");
    return typeof r.count === "number" ? r.count : null;
  } catch {
    return null;
  }
}

// ---------- сообщения сообществ: groups-stats.json ----------

function loadGroupStats() {
  try {
    const j = JSON.parse(fs.readFileSync(GROUPS_FILE, "utf8"));
    if (j && j.groups) {
      const byCabinet = {};
      for (const [gid, g] of Object.entries(j.groups)) {
        if (g && g.cabinetExtId != null) byCabinet[String(g.cabinetExtId)] = { ...g, id: gid };
      }
      return { byCabinet, updatedAt: j.updatedAt ?? null };
    }
  } catch {}
  return { byCabinet: {}, updatedAt: null };
}

// { yesterday, month, daily: {iso: count}, from } | null (группы нет — сообщений нет)
function groupMessages(gs, today) {
  if (!gs || !gs.daily) return null;
  const day = (iso) => (gs.daily[iso] ? gs.daily[iso].length : 0);
  const yesterday = isoAddDays(today, -1);
  let month = 0;
  for (let i = 1; i <= 30; i++) month += day(isoAddDays(today, -i));
  const daily = {};
  for (const [iso, uids] of Object.entries(gs.daily)) daily[iso] = Array.isArray(uids) ? uids.length : 0;
  const dates = Object.keys(daily).sort();
  return {
    yesterday: day(yesterday),
    month,
    daily,
    from: dates.length ? dates[0] : null,
    members: gs.members ?? null,
    groupName: gs.name ?? null,
  };
}

// ---------- главный цикл ----------

const r2 = (v) => Math.round(v * 100) / 100;

async function main() {
  const tokens = loadTokens();
  const cabinets = JSON.parse(fs.readFileSync(CAB_FILE, "utf8"));
  const { byCabinet: groupsByCab, updatedAt: groupsUpdatedAt } = loadGroupStats();
  if (Object.keys(groupsByCab).length) {
    console.log(`статистика сообществ: ${Object.keys(groupsByCab).length} групп (обновлена ${groupsUpdatedAt ?? "?"})`);
  }
  const today = mskTodayIso();
  const yesterday = isoAddDays(today, -1);
  const dayBefore = isoAddDays(today, -2);
  const from = isoAddDays(today, -STATS_DAYS);

  console.log(`сбор данных: ${cabinets.length} кабинетов, сегодня (МСК) ${today}`);

  const rows = [];
  for (const cab of cabinets) {
    const extId = cab.extId;
    const token = extId != null ? tokens[String(extId)] : null;
    if (!token) {
      console.log(`${cab.name}: нет токена → статус ${cab.noTokenStatus}`);
      // сообщения сообщества доступны и без токена кабинета (Шарок, Воздух Пермь)
      const msgs = groupMessages(groupsByCab[String(extId)], today);
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
        messagesYesterday: msgs ? msgs.yesterday : null,
        messagesMonth: msgs ? msgs.month : null,
        messagesSource: msgs ? "group" : null,
        msgDaily: msgs ? msgs.daily : null,
        msgDailyFrom: msgs ? msgs.from : null,
        groupName: msgs ? msgs.groupName : null,
        groupMembers: msgs ? msgs.members : null,
        campaignsCount: null,
        clicks7: [],
        clicks7Total: { clicks: 0, spend: 0, cpc: null },
      });
      if (msgs) console.log(`  ${cab.name}: писали в группу ${msgs.yesterday} (за 30 дн. ${msgs.month})`);
      continue;
    }

    try {
      console.log(`${cab.name}: запрашиваю баланс…`);
      const bal = computeBalance(await fetchAllTxGroups(token));

      console.log(`${cab.name}: запрашиваю статистику за ${STATS_DAYS + 1} дней…`);
      const byDate = await fetchDailyStats(token, from, today);
      const stat = (iso) => byDate[iso] || null;

      let spendMonth = 0;
      for (let i = 1; i <= 30; i++) {
        spendMonth += stat(isoAddDays(today, -i))?.spend || 0;
      }
      // сообщения — только из сообщества клиента (уникальные писавшие)
      const msgs = groupMessages(groupsByCab[String(extId)], today);

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

      // Подневная статистика за всё окно (полгода) — для выбора периода
      // 7 / 30 / свой период в карточке клиента на сайте. Дни без активности
      // (везде нули) не пишем: пустые даты сайт добирает нулями сам.
      const daily = {};
      for (let i = STATS_DAYS; i >= 0; i--) {
        const iso = isoAddDays(today, -i);
        const s = stat(iso);
        if (!s) continue;
        if (s.clicks || s.spend || s.shows || s.goals) {
          daily[iso] = { clicks: s.clicks, spend: r2(s.spend), shows: s.shows, goals: s.goals };
        }
      }

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
        messagesYesterday: msgs ? msgs.yesterday : null,
        messagesMonth: msgs ? msgs.month : null,
        messagesSource: msgs ? "group" : null,
        msgDaily: msgs ? msgs.daily : null,
        msgDailyFrom: msgs ? msgs.from : null,
        groupName: msgs ? msgs.groupName : null,
        groupMembers: msgs ? msgs.members : null,
        campaignsCount,
        clicks7,
        clicks7Total: { clicks: c7clicks, spend: r2(c7spend), cpc: c7clicks > 0 ? c7spend / c7clicks : null },
        dailyFrom: from,
        daily,
      });
      console.log(
        `  ${cab.name}: баланс ${bal.total.toFixed(2)} ₽ (живые ${bal.real.toFixed(2)}), вчера ${(stat(yesterday)?.spend || 0).toFixed(2)} ₽` +
          (msgs ? `, писали в группу ${msgs.yesterday} (за 30 дн. ${msgs.month})` : "")
      );
    } catch (e) {
      const msg = String(e.message || e).slice(0, 300);
      console.warn(`  ${cab.name}: ошибка — ${msg}`);
      // даже при сбое токена сообщения сообщества остаются доступными
      const msgs = groupMessages(groupsByCab[String(extId)], today);
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
        messagesYesterday: msgs ? msgs.yesterday : null,
        messagesMonth: msgs ? msgs.month : null,
        messagesSource: msgs ? "group" : null,
        msgDaily: msgs ? msgs.daily : null,
        msgDailyFrom: msgs ? msgs.from : null,
        groupName: msgs ? msgs.groupName : null,
        groupMembers: msgs ? msgs.members : null,
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
