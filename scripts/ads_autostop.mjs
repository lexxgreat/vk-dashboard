// Автостоп объявлений по правилам (запускается в GitHub Actions, workflow ads-autostop.yml).
// Правила: ads-rules.json в репозитории (сайт редактирует их через Contents API):
//   { updatedAt, rules: [{ id, cabinet:<extId>, group:<campaign_id>, maxSpend:<₽|null>,
//     maxCpc:<₽|null>, days:<период статистики, по умолчанию 30>, enabled, createdAt, note }] }.
// Механика: по каждому активному баннеру группы читается статистика
//   GET /statistics/banners/day.json?date_from&date_to&id=<bannerId>
//   (параметр id — ровно один баннер за вызов; total.base.spent/clicks).
// Нарушение: расход > maxSpend ИЛИ (клики ≥ 1 и расход/клики > maxCpc).
// Действие: POST /banners/{id}.json {"status":"blocked"} — «Остановлено» в VK Рекламе
//   (статусы баннера: active / blocked / deleted; тексты и креатив не затираются — проверено).
// Журнал: ads-rules-log.json (последние 300 событий + сводка последнего прогона).
//   Пишется ТОЛЬКО когда что-то произошло — тихие прогоны не коммитят пустышку.
// Режимы: node ads_autostop.mjs [--dry-run]  (dry-run — только отчёт, ничего не менять).
// Токены VK — из секрета VK_ADS_DIRECT_TOKENS (в браузер не попадают).

import fs from "node:fs";

const BASE = "https://ads.vk.com/api/v2";
const RULES_FILE = "ads-rules.json";
const LOG_FILE = "ads-rules-log.json";
const DRY = process.argv.includes("--dry-run");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tokens = JSON.parse(process.env.VK_ADS_DIRECT_TOKENS || "{}");

async function vk(token, method, apiPath, body) {
  const res = await fetch(`${BASE}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(45000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

function mskToday() {
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}
function isoAddDays(iso, delta) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
const r2 = (v) => Math.round(v * 100) / 100;

/** Все баннеры кабинета (до 5 страниц по 250). */
async function fetchBanners(token) {
  const out = [];
  for (let page = 0; page < 5; page++) {
    const r = await vk(token, "GET", `/banners.json?limit=250&offset=${page * 250}&fields=id,name,campaign_id,status`);
    if (r.status !== 200) break;
    const items = Array.isArray(r.json) ? r.json : (r.json?.items ?? []);
    out.push(...items);
    if (items.length < 250) break;
    await sleep(400);
  }
  return out;
}

/** Статистика одного баннера за период: { spend, clicks } или null. */
async function bannerStats(token, bannerId, dateFrom, dateTo) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await vk(token, "GET", `/statistics/banners/day.json?date_from=${dateFrom}&date_to=${dateTo}&id=${bannerId}`);
    if (r.status === 200) {
      const base = r.json?.items?.[0]?.total?.base;
      if (base) return { spend: parseFloat(base.spent || "0"), clicks: Number(base.clicks || 0) };
      return { spend: 0, clicks: 0 };
    }
    console.warn(`    статистика ${bannerId}: HTTP ${r.status}, попытка ${attempt}/3 — ждём ${attempt * 20} с`);
    await sleep(attempt * 20000);
  }
  return null; // не удалось — баннер пропускаем, не останавливаем вслепую
}

function violation(rule, st) {
  if (st.spend > 0 && rule.maxSpend != null && st.spend > rule.maxSpend) {
    return `расход ${r2(st.spend)} ₽ > ${rule.maxSpend} ₽`;
  }
  if (st.clicks >= 1 && rule.maxCpc != null) {
    const cpc = st.spend / st.clicks;
    if (cpc > rule.maxCpc) return `цена клика ${r2(cpc)} ₽ > ${rule.maxCpc} ₽ (кликов ${st.clicks}, расход ${r2(st.spend)} ₽)`;
  }
  return null;
}

function loadLog() {
  try {
    const j = JSON.parse(fs.readFileSync(LOG_FILE, "utf8"));
    if (j && Array.isArray(j.events)) return j;
  } catch {}
  return { updatedAt: null, events: [], lastReport: null };
}

async function main() {
  let rulesDoc;
  try {
    rulesDoc = JSON.parse(fs.readFileSync(RULES_FILE, "utf8"));
  } catch {
    console.log("ads-rules.json не найден или пуст — правил автостопа нет, нечего делать");
    return;
  }
  const rules = (rulesDoc.rules ?? []).filter((x) => x.enabled !== false);
  if (!rules.length) { console.log("активных правил нет"); return; }
  console.log(`правил: ${rules.length}${DRY ? " · РЕЖИМ DRY-RUN (только отчёт)" : ""}`);

  const log = loadLog();
  const events = [];
  const report = { ranAt: new Date().toISOString(), dryRun: DRY, rules: [], stopped: 0 };
  const today = mskToday();

  for (const rule of rules) {
    const token = tokens[String(rule.cabinet)];
    const rr = { rule: rule.id, cabinet: rule.cabinet, group: rule.group, checked: 0, violations: 0, stopped: 0, errors: [] };
    if (!token) { rr.errors.push("нет токена кабинета"); report.rules.push(rr); continue; }
    const days = Number(rule.days) > 0 ? Number(rule.days) : 30;
    const dateFrom = isoAddDays(today, -(days - 1));

    const banners = (await fetchBanners(token))
      .filter((b) => Number(b.campaign_id) === Number(rule.group) && b.status === "active");
    console.log(`правило ${rule.id}: кабинет ${rule.cabinet}, группа ${rule.group}, активных баннеров ${banners.length}, период ${dateFrom}…${today}`);

    for (const b of banners) {
      const st = await bannerStats(token, b.id, dateFrom, today);
      await sleep(1500); // бережём лимиты статистики VK
      rr.checked++;
      if (!st) { rr.errors.push(`баннер ${b.id}: статистика недоступна`); continue; }
      const why = violation(rule, st);
      if (!why) continue;
      rr.violations++;
      const ev = {
        ts: new Date().toISOString(), ruleId: rule.id, cabinet: Number(rule.cabinet), group: Number(rule.group),
        bannerId: Number(b.id), name: String(b.name ?? `#${b.id}`),
        spend: r2(st.spend), clicks: st.clicks, cpc: st.clicks ? r2(st.spend / st.clicks) : null,
        reason: why,
      };
      if (DRY) {
        console.log(`  ⏸ DRY: ${b.name} (#${b.id}) — ${why} — БЫЛ БЫ ОСТАНОВЛЕН`);
      } else {
        const r = await vk(token, "POST", `/banners/${b.id}.json`, { status: "blocked" });
        if (r.status === 200 || r.status === 204) {
          console.log(`  ⏸ ОСТАНОВЛЕН: ${b.name} (#${b.id}) — ${why}`);
          ev.stopped = true;
          rr.stopped++;
          report.stopped++;
          events.push(ev);
        } else {
          console.warn(`  ✕ не удалось остановить ${b.id}: HTTP ${r.status} ${String(r.text).slice(0, 120)}`);
          rr.errors.push(`баннер ${b.id}: стоп не удался (HTTP ${r.status})`);
        }
        await sleep(800);
      }
    }
    report.rules.push(rr);
  }

  console.log(`\nитог: проверено ${report.rules.reduce((s, r) => s + r.checked, 0)} баннеров, ` +
    `нарушений ${report.rules.reduce((s, r) => s + r.violations, 0)}, остановлено ${report.stopped}${DRY ? " (dry-run: 0)" : ""}`);

  if (DRY) { console.log("dry-run: журнал не пишется"); return; }
  if (events.length === 0 && log.lastReport?.ranAt) {
    // тихий прогон: ничего не произошло — не коммитим пустышку
    console.log("событий нет — ads-rules-log.json не меняется");
    return;
  }
  log.events = [...events, ...log.events].slice(0, 300);
  log.updatedAt = new Date().toISOString();
  log.lastReport = report;
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 1));
  console.log(`ads-rules-log.json: +${events.length} событий (всего ${log.events.length})`);
}

main().catch((e) => { console.error("ОШИБКА:", e.message); process.exit(1); });
