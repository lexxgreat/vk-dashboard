// Экспорт контекста для конструктора объявлений на статическом сайте.
// Запускается в GitHub Actions (update-stats.yml) с env VK_ADS_DIRECT_TOKENS
// (JSON {"extId": "token"} — только прямые токены кабинетов с правом записи).
// Читает data.json (имена клиентов), пишет ads-context.json:
//   { generatedAt, cabinets: { "<extId>": { name, clientName, balance, plans, groups, defaults, limits } } }
// Сайт на GitHub Pages читает этот файл мгновенно (без ключей), а сами
// создания идут через ads-jobs/*.json → create-ads.yml (токены — в секретах).

import fs from "node:fs";

const BASE = "https://ads.vk.com/api/v2";
const BANNER_FIELDS = "id,name,campaign_id,status,moderation_status,moderation_reasons,content,textblocks,urls";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const itemsOf = (payload) => {
  if (Array.isArray(payload)) return payload;
  const items = payload?.items;
  return Array.isArray(items) ? items : [];
};
const mostFrequent = (counts) => {
  let best = null, n = 0;
  for (const [k, v] of counts) if (v > n) { best = k; n = v; }
  return best;
};

async function vk(token, path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(40000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

async function fetchAllBanners(token) {
  const out = [];
  for (let page = 0; page < 5; page++) {
    const r = await vk(token, `/banners.json?limit=250&offset=${page * 250}&fields=${BANNER_FIELDS}`);
    if (r.status !== 200) break;
    const items = itemsOf(r.json);
    out.push(...items);
    if (items.length < 250) break;
    await sleep(300);
  }
  return out;
}

async function contextOf(extId, token) {
  const u = await vk(token, "/user.json?fields=id,username,permissions,max_active_banners");
  await sleep(300);
  const p = await vk(token, "/ad_plans.json?limit=50&fields=id,name,status");
  await sleep(300);
  const c = await vk(token, "/campaigns.json?limit=250&fields=id,name,status,ad_plan_id,package_id");
  await sleep(300);
  const banners = await fetchAllBanners(token);
  if (p.status !== 200) throw new Error(`ad_plans ${extId}: HTTP ${p.status} ${p.text.slice(0, 120)}`);
  if (c.status !== 200) throw new Error(`campaigns ${extId}: HTTP ${c.status} ${c.text.slice(0, 120)}`);

  const plans = itemsOf(p.json)
    .filter((x) => x.status === "active")
    .map((x) => ({ id: Number(x.id), name: String(x.name ?? `Кампания #${x.id}`), status: "active" }));
  const groups = itemsOf(c.json)
    .filter((x) => x.status === "active")
    .map((x) => ({
      id: Number(x.id),
      name: String(x.name ?? `Группа #${x.id}`),
      status: "active",
      planId: x.ad_plan_id != null ? Number(x.ad_plan_id) : null,
      packageId: x.package_id != null ? Number(x.package_id) : null,
    }));

  const live = banners.filter((x) => x.status !== "deleted");
  const iconCounts = new Map(), urlCounts = new Map(), aboutCounts = new Map(), ctaCounts = new Map();
  const titleAllowed = new Map(), textAllowed = new Map(), titleAny = new Map(), textAny = new Map();
  let activeBanners = 0;
  for (const bn of live) {
    if (bn.status === "active") activeBanners++;
    const iconId = bn.content?.icon_256x256?.id;
    if (iconId != null) iconCounts.set(iconId, (iconCounts.get(iconId) ?? 0) + 1);
    const urlId = bn.urls?.primary?.id;
    if (urlId != null) urlCounts.set(urlId, (urlCounts.get(urlId) ?? 0) + 1);
    const about = bn.textblocks?.about_company_115?.text;
    if (about) aboutCounts.set(about, (aboutCounts.get(about) ?? 0) + 1);
    const cta = bn.textblocks?.cta_community_vk?.text;
    if (cta) ctaCounts.set(cta, (ctaCounts.get(cta) ?? 0) + 1);
    const title = bn.textblocks?.title_40_vkads?.text;
    const text = bn.textblocks?.text_2000?.text;
    const allowed = bn.moderation_status === "allowed";
    if (title) {
      titleAny.set(title, (titleAny.get(title) ?? 0) + 1);
      if (allowed) titleAllowed.set(title, (titleAllowed.get(title) ?? 0) + 1);
    }
    if (text) {
      textAny.set(text, (textAny.get(text) ?? 0) + 1);
      if (allowed) textAllowed.set(text, (textAllowed.get(text) ?? 0) + 1);
    }
  }

  const userInfo = u.json?.user ?? u.json;
  return {
    userName: typeof userInfo?.username === "string" ? userInfo.username : null,
    plans,
    groups,
    defaults: {
      iconId: mostFrequent(iconCounts),
      urlId: mostFrequent(urlCounts),
      about: mostFrequent(aboutCounts) ?? "",
      cta: mostFrequent(ctaCounts) ?? "write",
      title: mostFrequent(titleAllowed) ?? mostFrequent(titleAny) ?? "",
      text: mostFrequent(textAllowed) ?? mostFrequent(textAny) ?? "",
      basedOnBanners: live.length,
    },
    limits: {
      maxActiveBanners: typeof userInfo?.max_active_banners === "number" ? userInfo.max_active_banners : null,
      activeBanners,
    },
  };
}

async function main() {
  const tokens = JSON.parse(process.env.VK_ADS_DIRECT_TOKENS || "{}");
  const data = JSON.parse(fs.readFileSync("data.json", "utf8"));
  const names = new Map(data.rows.map((r) => [String(r.extId), r]));

  const cabinets = {};
  const errors = [];
  for (const [extId, token] of Object.entries(tokens)) {
    try {
      const ctx = await contextOf(extId, token);
      const meta = names.get(extId) ?? {};
      cabinets[extId] = {
        name: meta.name ?? `Кабинет ${extId}`,
        clientName: meta.clientName ?? "",
        balance: meta.balanceTotal ?? null,
        ...ctx,
      };
      console.log(`✓ ${extId} (${meta.name ?? "?"}): планов ${ctx.plans.length}, групп ${ctx.groups.length}, объявлений ${ctx.defaults.basedOnBanners}`);
    } catch (e) {
      errors.push(`${extId}: ${e.message}`);
      console.error(`✗ ${extId}: ${e.message}`);
    }
    await sleep(500);
  }

  fs.writeFileSync(
    "ads-context.json",
    JSON.stringify({ generatedAt: new Date().toISOString(), cabinets, errors }, null, 1)
  );
  console.log(`ads-context.json: ${Object.keys(cabinets).length} кабинетов, ${errors.length} ошибок`);
}

main().catch((e) => { console.error("ОШИБКА:", e.message); process.exit(1); });
