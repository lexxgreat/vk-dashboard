#!/usr/bin/env node
// Скан сообщений групп для GitHub Actions (облако, без БД панели).
// Состояние хранится в самом groups-stats.json (по дням, уникальные uid).
// Инкремент: скан с последнего известного дня группы минус 1 (запас на границу суток).
// Секрет VK_GROUP_TOKENS = JSON {"<groupId>": "<ключ сообщества>", ...}.
// Массовые рассылки не ломают счётчики: учитываются только сообщения от пользователей
// (from_id > 0); тронутые рассылкой диалоги проверяются по истории (1 запрос на диалог).
import fs from "node:fs";

const GROUPS_FILE = "groups-stats.json";
const BASE = "https://api.vk.com/method";
const V = "5.199";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// маппинг groupId → кабинет (из db/group-cabinet-map.json панели)
const CABINET_MAP = {
  "187162481": 17323149,
  "105562394": 16019221,
  "51481443": 15957290,
  "30981705": 23685298,
  "106327089": 15545622,
  "89489886": 15155276,
  "199593708": 28571374,
  "129230098": 26047668,
  "112533993": 15635657,
  "212594218": 24158606,
};

async function vk(token, method, params = {}) {
  const body = new URLSearchParams({ access_token: token, v: V });
  for (const [k, v] of Object.entries(params)) body.set(k, String(v));
  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = await fetch(`${BASE}/${method}`, { method: "POST", headers: { "Content-type": "application/x-www-form-urlencoded" }, body });
    const data = await res.json();
    if (data.error) {
      const code = data.error.error_code;
      if ((code === 6 || code === 9) && attempt < 6) { await sleep(attempt * 1500); continue; }
      throw new Error(`${method}: ${data.error.error_msg} (код ${code})`);
    }
    return data.response;
  }
  throw new Error(`${method}: не удалось после ретраев`);
}

const mskToday = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
const mskDayKey = (unixTs) => new Date(unixTs * 1000 + 3 * 3600 * 1000).toISOString().slice(0, 10);
const mskDayStartUnix = (iso) => Math.floor(Date.parse(iso + "T00:00:00Z") / 1000) - 3 * 3600;
const addDaysMsk = (iso, n) => {
  const d = new Date(Date.parse(iso + "T00:00:00Z") + n * 86400 * 1000);
  return new Date(d.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);
};

async function scanGroup(gid, token, prevGroup) {
  const today = mskToday();
  const prevDaily = prevGroup?.daily ?? {};
  const days = Object.keys(prevDaily).sort();
  // последний известный день; при пустом/устаревшем (>40 дней) — полное окно 35 дней
  let scanFrom = addDaysMsk(today, -34);
  if (days.length) {
    const last = days[days.length - 1];
    const withMargin = addDaysMsk(last, -1);
    if (withMargin > scanFrom) scanFrom = withMargin;
  }
  const fromTs = mskDayStartUnix(scanFrom);
  console.log(`[${gid}] «${prevGroup?.name ?? "?"}»: скан с ${scanFrom}`);

  // 1) кандидаты: диалоги с активностью >= scanFrom
  const candidates = [];
  for (let offset = 0; offset < 20000; offset += 200) {
    const res = await vk(token, "messages.getConversations", { group_id: Number(gid), offset, count: 200 });
    await sleep(350);
    const items = res.items ?? [];
    let oldest = 0;
    for (const item of items) {
      const peer = (item.conversation ?? {}).peer ?? {};
      const lmDate = item.last_message?.date ?? 0;
      if (peer.type === "user" && lmDate >= fromTs) candidates.push(peer.id);
      if (lmDate && (!oldest || lmDate < oldest)) oldest = lmDate;
    }
    if (!items.length || offset + 200 >= (res.count ?? 0) || (oldest && oldest < fromTs)) break;
  }
  console.log(`[${gid}] кандидатов: ${candidates.length}`);

  // 2) история каждого кандидата (воркеры)
  const perDay = new Map();
  let done = 0;
  let qi = 0;
  const worker = async () => {
    while (true) {
      const i = qi++;
      if (i >= candidates.length) return;
      const peerId = candidates[i];
      try {
        const res = await vk(token, "messages.getHistory", { peer_id: peerId, group_id: Number(gid), offset: 0, count: 200 });
        for (const m of res.items ?? []) {
          const date = m.date ?? 0;
          if (date >= fromTs && (m.from_id ?? 0) > 0) {
            const key = mskDayKey(date);
            if (!perDay.has(key)) perDay.set(key, new Set());
            perDay.get(key).add(m.from_id);
          }
        }
      } catch (e) {
        console.log(`[${gid}] диалог ${peerId}: ${e.message} — пропуск`);
      }
      done++;
      if (done % 500 === 0) console.log(`[${gid}] …${done}/${candidates.length}`);
      await sleep(280);
    }
  };
  await Promise.all([worker(), worker(), worker()]);

  // 3) мерж (union uid), окно 45 дней
  const daily = {};
  for (const [day, uids] of Object.entries(prevDaily)) daily[day] = Array.isArray(uids) ? [...new Set(uids)] : [];
  for (const [day, set] of perDay) {
    const merged = new Set(daily[day] || []);
    for (const uid of set) merged.add(uid);
    daily[day] = [...merged];
  }
  const keepFrom = addDaysMsk(today, -45);
  for (const day of Object.keys(daily)) if (day < keepFrom) delete daily[day];

  // 4) участники
  let members = prevGroup?.members ?? null;
  try {
    const info = await vk(token, "groups.getById", { group_id: Number(gid), fields: "members_count" });
    const g = info?.groups?.[0] ?? info?.[0];
    if (g?.members_count) members = g.members_count;
  } catch {}

  const fresh = [...perDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  console.log(`[${gid}] ГОТОВО: свежие дни [${fresh.map(([d, s]) => `${d}:${s.size}`).join(", ") || "—"}]`);
  return {
    name: prevGroup?.name ?? `Группа ${gid}`,
    screenName: prevGroup?.screenName ?? null,
    clientName: prevGroup?.clientName ?? null,
    cabinetExtId: CABINET_MAP[gid] ?? prevGroup?.cabinetExtId ?? null,
    members,
    daily,
  };
}

async function main() {
  const tokens = JSON.parse(process.env.VK_GROUP_TOKENS || "{}");
  const gids = Object.keys(tokens);
  if (!gids.length) { console.log("VK_GROUP_TOKENS пуст — скан групп пропущен"); return; }

  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(GROUPS_FILE, "utf8")).groups || {}; } catch {}

  console.log(`скан ${gids.length} групп: ${gids.join(", ")}`);
  const groups = {};
  for (const gid of gids) {
    try {
      groups[gid] = await scanGroup(gid, tokens[gid], prev[gid]);
    } catch (e) {
      console.log(`[${gid}] ОШИБКА: ${e.message} — данные группы не меняются`);
      if (prev[gid]) groups[gid] = prev[gid];
    }
  }

  const out = {
    _schema: 1,
    _note: "Статистика сообщений сообществ: уникальные пользователи, писавшие в диалоги группы, по дням (МСК). Обновляется панелью и облачным сканом (GitHub Actions).",
    updatedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    groups,
  };
  fs.writeFileSync(GROUPS_FILE, JSON.stringify(out));
}

main().catch((e) => { console.error("СБОЙ:", e.message); process.exit(1); });
