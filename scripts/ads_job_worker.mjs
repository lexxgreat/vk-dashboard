// Обработчик заданий на создание объявлений (запускается в GitHub Actions,
// workflow create-ads.yml, при появлении файлов в ads-jobs/pending/).
// Задание (JSON): { id, type: "create"|"status", cabinet:<extId>, group,
//   iconId, urlId, texts:{title,body,cta,about} — общий вариант по умолчанию,
//   items:[{name, slot, photo:<base64 jpeg>, texts?:{title,body} — свой текст,
//          перекрывает общий (A/B-тесты заголовков/текстов)}] }.
// Токены VK — из секрета VK_ADS_DIRECT_TOKENS (в браузер не попадают).
// Результат пишется в ads-jobs/done/<id>.json, задание удаляется,
// база дедупликации ads/creatives.json коммитится в репозиторий.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const BASE = "https://ads.vk.com/api/v2";
const PENDING_DIR = "ads-jobs/pending";
const DONE_DIR = "ads-jobs/done";
const CREATIVES = "ads/creatives.json";
const SLOTS = new Set(["image_600x600", "image_1080x607", "image_4_5", "image_607x1080"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tokens = JSON.parse(process.env.VK_ADS_DIRECT_TOKENS || "{}");

async function vk(token, method, apiPath, body, isForm) {
  const res = await fetch(`${BASE}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined && !isForm ? { "Content-Type": "application/json" } : {}),
    },
    body,
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

function loadCreatives() {
  try {
    const db = JSON.parse(fs.readFileSync(CREATIVES, "utf8"));
    if (db && db._schema === 2 && db.cabinets) return db;
  } catch {}
  return { _schema: 2, _updated: new Date().toISOString(), cabinets: {}, meta: {}, banners: [] };
}
function saveCreatives(db) {
  db._updated = new Date().toISOString();
  fs.mkdirSync(path.dirname(CREATIVES), { recursive: true });
  fs.writeFileSync(CREATIVES, JSON.stringify(db, null, 1));
}

/** Загрузка фото в медиатеку кабинета (с sha256-дедупликацией и ретраями). */
async function uploadPhoto(token, extId, buf, name) {
  const hash = crypto.createHash("sha256").update(buf).digest("hex");
  const cdb = loadCreatives();
  const slotKey = slotKeyOf(name);
  const prev = cdb.cabinets[extId]?.[hash]?.[slotKey];
  if (typeof prev === "number") return { contentId: prev, reused: true };

  let contentId = null, lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(buf)], { type: "image/jpeg" }), name);
    const r = await vk(token, "POST", "/content/static.json", fd, true);
    if (r.status === 200 && r.json?.id) { contentId = Number(r.json.id); break; }
    lastErr = `HTTP ${r.status} ${String(r.json?.error?.message ?? r.text).slice(0, 160)}`;
    const code = Number(r.json?.error?.code ?? 0);
    if (r.status < 500 && code < 10 && r.status !== 429) break;
    await sleep(1500 * attempt);
  }
  if (contentId == null) throw new Error(`загрузка фото не удалась: ${lastErr}`);

  cdb.cabinets[extId] = cdb.cabinets[extId] ?? {};
  cdb.cabinets[extId][hash] = { ...(cdb.cabinets[extId][hash] ?? {}), [slotKey]: contentId };
  saveCreatives(cdb);
  return { contentId, reused: false };
}

function slotKeyOf(fileName) {
  // имена генерирует сайт: <имя>-600x600.jpg / -1080x607.jpg / -1080x1350.jpg / -607x1080.jpg
  const m = fileName.match(/-(\d+x\d+)\.jpg$/);
  if (!m) return "image_600x600";
  const map = {
    "600x600": "image_600x600",
    "1080x607": "image_1080x607",
    "1080x1350": "image_4_5",
    "607x1080": "image_607x1080",
  };
  return map[m[1]] ?? "image_600x600";
}

async function handleCreate(job) {
  const token = tokens[String(job.cabinet)];
  if (!token) throw new Error(`нет прямого токена для кабинета ${job.cabinet}`);
  const base = job.texts ?? {};
  const results = [];
  const cdb = loadCreatives();

  for (const item of job.items ?? []) {
    if (!item.name || !SLOTS.has(item.slot) || !item.photo) {
      results.push({ name: item.name ?? "?", ok: false, bannerId: null, moderationStatus: null, error: "невалидный элемент задания" });
      continue;
    }
    // тексты элемента перекрывают общие (варианты для A/B-тестов)
    const t = { ...base, ...(item.texts ?? {}) };
    try {
      const buf = Buffer.from(item.photo, "base64");
      if (buf.length > 5 * 1024 * 1024) throw new Error(`фото больше 5 МБ (${(buf.length / 1048576).toFixed(1)})`);
      const fileName = `${String(item.name).replace(/[^\wа-яёА-ЯЁ-]+/gi, "").slice(0, 60) || "ad"}-${dimsOf(item.slot)}.jpg`;
      const up = await uploadPhoto(token, String(job.cabinet), buf, fileName);
      await sleep(600);

      const body = {
        name: String(item.name).slice(0, 100),
        content: {
          icon_256x256: { id: Number(job.iconId) },
          [item.slot]: { id: up.contentId },
        },
        textblocks: {
          title_40_vkads: { text: String(t.title ?? ""), title: "" },
          text_2000: { text: String(t.body ?? ""), title: "" },
          cta_community_vk: { text: String(t.cta ?? ""), title: "" },
          about_company_115: { text: String(t.about ?? ""), title: "" },
        },
        urls: { primary: { id: Number(job.urlId) } },
      };
      const r = await vk(token, "POST", `/ad_groups/${job.group}/banners.json`, JSON.stringify(body));
      if ((r.status === 200 || r.status === 204) && r.json?.id != null) {
        const bannerId = Number(r.json.id);
        results.push({ name: item.name, ok: true, bannerId, moderationStatus: "pending", reusedPhoto: up.reused });
        cdb.banners.push({
          banner_id: bannerId, name: item.name, ad_group_id: Number(job.group),
          icon_id: Number(job.iconId), format: item.slot, [item.slot]: up.contentId,
          texts: t, status: "active", moderation_status: "pending",
          created_at: new Date().toISOString(), cabinet: Number(job.cabinet),
        });
      } else if (r.status === 204) {
        results.push({ name: item.name, ok: true, bannerId: null, moderationStatus: "pending", reusedPhoto: up.reused });
      } else {
        const err = r.json?.error ?? r.text?.slice(0, 300);
        results.push({
          name: item.name, ok: false, bannerId: null, moderationStatus: null,
          error: typeof err === "string" ? err : JSON.stringify(err).slice(0, 300),
        });
      }
    } catch (e) {
      results.push({ name: item.name, ok: false, bannerId: null, moderationStatus: null, error: String(e.message).slice(0, 300) });
    }
    await sleep(800);
  }
  saveCreatives(cdb);
  return { results };
}

function dimsOf(slot) {
  return { image_600x600: "600x600", image_1080x607: "1080x607", image_4_5: "1080x1350", image_607x1080: "607x1080" }[slot] ?? "600x600";
}

async function handleStatus(job) {
  const token = tokens[String(job.cabinet)];
  if (!token) throw new Error(`нет прямого токена для кабинета ${job.cabinet}`);
  const rows = [];
  for (let page = 0; page < 5; page++) {
    const r = await vk(token, "GET", `/banners.json?limit=250&offset=${page * 250}&fields=id,name,campaign_id,status,moderation_status,moderation_reasons`);
    if (r.status !== 200) break;
    const items = Array.isArray(r.json) ? r.json : (r.json?.items ?? []);
    rows.push(...items);
    if (items.length < 250) break;
    await sleep(300);
  }
  // только группа из задания и только живые баннеры (как в панели)
  return {
    rows: rows
      .filter((b) => Number(b.campaign_id) === Number(job.group) && b.status !== "deleted")
      .map((b) => ({
        id: Number(b.id), name: String(b.name ?? `#${b.id}`), status: String(b.status ?? "unknown"),
        moderationStatus: String(b.moderation_status ?? "unknown"),
        reasons: Array.isArray(b.moderation_reasons) ? b.moderation_reasons.map((x) => String(x)).slice(0, 5) : [],
      }))
      .sort((a, b) => b.id - a.id),
  };
}

async function main() {
  if (!fs.existsSync(PENDING_DIR)) {
    fs.mkdirSync(PENDING_DIR, { recursive: true });
    console.log("нет папки заданий — нечего делать");
    return;
  }
  const files = fs.readdirSync(PENDING_DIR).filter((f) => f.endsWith(".json"));
  if (files.length === 0) { console.log("заданий нет"); return; }
  fs.mkdirSync(DONE_DIR, { recursive: true });

  for (const f of files) {
    const jobPath = path.join(PENDING_DIR, f);
    let job;
    try {
      job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
    } catch (e) {
      fs.renameSync(jobPath, path.join(DONE_DIR, f.replace(/\.json$/, ".error.json")));
      continue;
    }
    console.log(`▶ задание ${job.id} (${job.type}, кабинет ${job.cabinet})`);
    const out = { id: job.id, type: job.type, cabinet: job.cabinet, group: job.group, startedAt: new Date().toISOString() };
    try {
      if (job.type === "status") Object.assign(out, await handleStatus(job));
      else Object.assign(out, await handleCreate(job));
      out.finishedAt = new Date().toISOString();
      out.ok = true;
    } catch (e) {
      out.ok = false;
      out.error = String(e.message).slice(0, 400);
      out.finishedAt = new Date().toISOString();
    }
    fs.writeFileSync(path.join(DONE_DIR, f), JSON.stringify(out));
    fs.unlinkSync(jobPath);
    console.log(`✓ ${job.id}: ${out.ok ? "готово" : "ошибка: " + (out.error || "")}`);
  }
}

main().catch((e) => { console.error("ОШИБКА:", e.message); process.exit(1); });
