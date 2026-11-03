// VK Дашборд — секция «Реклама — создание объявлений» для GitHub Pages.
// ДВА РЕЖИМА (выбирается автоматически):
//  1. ПАНЕЛЬ: если на этом компьютере запущена Next.js-панель — запись идёт
//     напрямую через неё (токены VK на сервере панели, ключ доступа в браузере).
//  2. GITHUB ACTIONS: если панели нет — сайт читает ads-context.json из репозитория
//     (кампании/группы/автозаполнение), а создание объявлений отправляет заданием
//     ads-jobs/pending/*.json через GitHub Contents API. Задание обрабатывает
//     workflow create-ads.yml с секретом VK_ADS_DIRECT_TOKENS — токены VK
//     НИКОГДА не попадают в браузер. Нужен fine-grained PAT (contents:write
//     только на этот репозиторий) — хранится в localStorage браузера.
"use strict";

(function () {
  // ---------- конфиг ----------
  var ADS_BACKENDS = [
    "http://127.0.0.1:3000", // панель на этом компьютере
  ];
  var GH_REPO = "lexxgreat/vk-dashboard";
  var GH_BRANCH = "main";
  var GH_RAW = "https://raw.githubusercontent.com/" + GH_REPO + "/" + GH_BRANCH + "/";
  var GH_API = "https://api.github.com/repos/" + GH_REPO + "/";
  var LS_BACKEND = "adsBackendUrl";
  var LS_KEY = "adsPanelKey";
  var LS_GH_KEY = "adsGhToken";

  // ---------- состояние ----------
  var mode = null; // "panel" | "gh" | null
  var backend = null;
  var panelKey = "";
  var ghToken = "";
  var ghContext = null; // ads-context.json
  var cabinets = null;
  var ctx = null;
  var cabinetId = null; // панель: id из БД; gh: внешний id кабинета
  var planId = null;
  var groupId = null;
  var photos = [];
  var uploading = false;
  var results = null;
  var statuses = null;
  var creating = false;
  var polling = null; // таймер опроса результата gh-задания
  var uid = 0;

  var SLOTS = [
    { slot: "image_600x600", w: 600, h: 600, label: "квадрат 1:1" },
    { slot: "image_1080x607", w: 1080, h: 607, label: "горизонтальный 16:9" },
    { slot: "image_4_5", w: 1080, h: 1350, label: "вертикальный 4:5" },
    { slot: "image_607x1080", w: 607, h: 1080, label: "вертикальный 9:16" },
  ];

  // ---------- утилиты ----------
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function fmtMoney(v) {
    if (v == null || isNaN(v)) return "—";
    return Math.round(v).toLocaleString("ru-RU") + " ₽";
  }
  function pluralAds(n) {
    var a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return "объявлений";
    if (b > 1 && b < 5) return "объявления";
    if (b === 1) return "объявление";
    return "объявлений";
  }
  function pluralPhotos(n) {
    var a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return "фото";
    if (b > 1 && b < 5) return "фотографии";
    if (b === 1) return "фотография";
    return "фото";
  }
  function pickSlot(w, h) {
    var a = w / h, best = null;
    SLOTS.forEach(function (f) {
      var s = f.w / f.h;
      var kept = a > s ? s / a : a / s;
      if (!best || kept > best.kept) best = { slot: f.slot, w: f.w, h: f.h, label: f.label, kept: kept };
    });
    return best;
  }
  function $ (id) { return document.getElementById(id); }
  function cleanName(fileName) {
    return fileName.replace(/\.(jpe?g|png)$/i, "").replace(/[-_\s]+/g, "").slice(0, 100);
  }
  function b64utf8(s) {
    return btoa(unescape(encodeURIComponent(s)));
  }

  // ---------- вызовы API панели ----------
  function apiFetch(path, opts) {
    opts = opts || {};
    var headers = { "X-Panel-Key": panelKey };
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(opts.json);
    }
    return fetch(backend + path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body,
    }).then(function (r) {
      if (r.status === 401) { var e = new Error("нужен ключ панели"); e.needKey = true; throw e; }
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
        return j;
      });
    });
  }

  // ---------- GitHub Contents API ----------
  function ghPut(path, message, contentStr) {
    return fetch(GH_API + "contents/" + encodeURIComponent(path).replace(/%2F/g, "/"), {
      method: "PUT",
      headers: {
        Authorization: "Bearer " + ghToken,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: message, content: b64utf8(contentStr), branch: GH_BRANCH }),
    }).then(function (r) {
      if (r.status === 401 || r.status === 403) {
        throw new Error("GitHub отклонил токен (проверьте fine-grained PAT с правом Contents: write на репозиторий " + GH_REPO + ")");
      }
      if (!r.ok) throw new Error("GitHub HTTP " + r.status);
      return r.json();
    });
  }

  function ghFetchContextJson() {
    return fetch(GH_RAW + "ads-context.json?t=" + Date.now()).then(function (r) {
      if (!r.ok) throw new Error("ads-context.json не найден (HTTP " + r.status + ")");
      return r.json();
    });
  }

  /** Обработка задания через GitHub Actions: отправка + опрос результата. */
  function ghRunJob(job, onResult) {
    var id = job.id;
    var file = "ads-jobs/pending/" + id + ".json";
    return ghPut(file, "задание на объявления " + id, JSON.stringify(job)).then(function () {
      // мягкий дубль-триггер: repository_dispatch (если у токена есть право) —
      // основной триггер всё равно push по пути ads-jobs/pending/**
      fetch(GH_API + "dispatches", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + ghToken,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ event_type: "ads-job", client_payload: { id: id } }),
      }).catch(function () {});
      // опрос результата (воркер пишет ads-jobs/done/<id>.json)
      return new Promise(function (resolve, reject) {
        var tries = 0;
        (function poll() {
          tries++;
          if (tries > 55) { reject(new Error("GitHub Actions не успел за ~5 минут — проверьте вкладку Actions репозитория")); return; }
          fetch(GH_RAW + "ads-jobs/done/" + id + ".json?t=" + Date.now())
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (j) {
              if (j && j.id === id) { resolve(j); return; }
              if (typeof onResult === "function") onResult(tries);
              polling = setTimeout(poll, 6000);
            })
            .catch(function () { polling = setTimeout(poll, 6000); });
        })();
      });
    });
  }

  // ---------- поиск панели / режим ----------
  function detectBackend() {
    var tryNext = function (list, i) {
      if (i >= list.length) return Promise.reject(new Error("not found"));
      var url = list[i];
      return fetch(url + "/api/ads/cabinets", {
        headers: { "X-Panel-Key": panelKey },
        signal: AbortSignal.timeout ? AbortSignal.timeout(3500) : undefined,
      }).then(function (r) {
        if (r.status === 401) { backend = url; var e = new Error("нужен ключ"); e.needKey = true; throw e; }
        if (!r.ok) throw new Error("HTTP " + r.status);
        backend = url;
        try { localStorage.setItem(LS_BACKEND, url); } catch (e2) {}
        return r.json();
      }).catch(function (err) {
        if (err && err.needKey) throw err;
        return tryNext(list, i + 1);
      });
    };
    var list = [];
    try {
      var saved = localStorage.getItem(LS_BACKEND);
      if (saved && list.indexOf(saved) < 0 && ADS_BACKENDS.indexOf(saved) < 0) list.push(saved);
    } catch (e) {}
    ADS_BACKENDS.forEach(function (u) { if (list.indexOf(u) < 0) list.push(u); });
    return tryNext(list, 0);
  }

  // ============ UI ============

  function connState(html) {
    $("ads-conn").innerHTML = html;
    $("ads-conn").hidden = !html;
  }

  function offlineNotice(detail) {
    connState(
      '<div class="ads-conn-off">' +
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>' +
      "<div><b>Панель не найдена.</b> " + esc(detail || "") + "</div></div>" +
      ghTokenForm()
    );
    bindGhTokenForm();
  }

  function ghTokenForm() {
    var help =
      "<b>Зачем нужен этот токен:</b> статистика на сайте работает без него. Но кнопка " +
      "«Создать объявления» записывает файл-задание в репозиторий " + GH_REPO + ", а GitHub " +
      "разрешает запись только по ключу — анонимному посетителю нельзя коммитить в чужой " +
      "репозиторий. Это НЕ токен VK: токены кабинетов лежат в секретах GitHub Actions и " +
      "в браузер не попадают. Этот ключ может только добавлять файлы в этот один " +
      "репозиторий — до секретов и настроек ему нельзя, даже если его кто-то узнает.<br>" +
      "<b>Как создать:</b> github.com → Settings → Developer settings → " +
      "Fine-grained personal access tokens → Generate new token. Repository access: " +
      "<i>Only select repositories</i> → <b>" + GH_REPO + "</b>. Permissions → Repository permissions → " +
      "<b>Contents: Read and write</b>. Остальное не трогайте. Токен сохраняется только в " +
      "этом браузере (localStorage) и в любой момент отзывается на github.com.";
    return (
      '<div class="ads-gh"><p class="ads-gh-help">' + help + "</p>" +
      '<form class="ads-key" id="ads-gh-form">' +
      '<label for="ads-gh-input">Токен GitHub (fine-grained)</label>' +
      '<input type="password" id="ads-gh-input" placeholder="github_pat_…" value="' + esc(ghToken) + '" autocomplete="off">' +
      '<button type="submit" class="btn">Войти</button>' +
      "</form></div>"
    );
  }
  function bindGhTokenForm() {
    var f = $("ads-gh-form");
    if (!f) return;
    f.addEventListener("submit", function (ev) {
      ev.preventDefault();
      ghToken = $("ads-gh-input").value.trim();
      try { localStorage.setItem(LS_GH_KEY, ghToken); } catch (e) {}
      boot();
    });
  }

  function keyFormHtml() {
    return (
      '<form class="ads-key" id="ads-key-form">' +
      '<label for="ads-key-input">Ключ панели</label>' +
      '<input type="password" id="ads-key-input" placeholder="ключ доступа" value="' + esc(panelKey) + '" autocomplete="off">' +
      '<button type="submit" class="btn">Сохранить</button>' +
      "</form>"
    );
  }
  function bindKeyForm() {
    var f = $("ads-key-form");
    if (!f) return;
    f.addEventListener("submit", function (ev) {
      ev.preventDefault();
      panelKey = $("ads-key-input").value.trim();
      try { localStorage.setItem(LS_KEY, panelKey); } catch (e) {}
      boot();
    });
  }

  function needKeyUi() {
    connState(
      '<div class="ads-conn-key">' +
      "<div><b>Панель требует ключ.</b> Введите ключ доступа — он хранится только в вашем браузере.</div>" +
      keyFormHtml() + "</div>"
    );
    bindKeyForm();
  }

  function renderConstructor() {
    $("ads-form").innerHTML =
      '<div class="ads-card">' +
      '<div class="ads-card-head"><span>Конструктор объявлений</span>' +
      '<span class="badge" id="ads-limits" hidden></span></div>' +
      '<div class="ads-card-body">' +

      // Шаг 1 — кабинет
      '<div class="ads-step">' +
      '<label class="ads-label" for="ads-cabinet">Кабинет</label>' +
      '<select class="ads-select" id="ads-cabinet"><option value="">Выберите кабинет…</option></select>' +
      "</div>" +

      // Шаг 2 — кампания и группа
      '<div id="ads-ctx" hidden>' +
      '<div class="ads-step ads-step-2">' +
      "<div><label class='ads-label' for='ads-plan'>Кампания</label>" +
      "<select class='ads-select' id='ads-plan'></select></div>" +
      "<div><label class='ads-label' for='ads-group'>Группа объявлений</label>" +
      "<select class='ads-select' id='ads-group'></select></div>" +
      "</div>" +
      '<p class="ads-hint" id="ads-group-info"></p>' +
      '<p class="ads-hint" id="ads-based"></p>' +
      "</div>" +
      '<div class="ads-loading" id="ads-ctx-loading" hidden>Читаем кампании и настройки кабинета…</div>' +
      '<p class="ads-err" id="ads-ctx-err" hidden></p>' +

      // Шаг 3 — фото
      '<div class="ads-step" id="ads-photos-step" hidden>' +
      '<label class="ads-label">Фото объявлений (JPG/PNG, до 5 МБ) — можно пачкой</label>' +
      '<div class="ads-drop" id="ads-drop" role="button" tabindex="0" aria-label="Добавить фото">' +
      '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.6-3.6a2 2 0 0 0-2.8 0L6 21"/></svg>' +
      '<span class="ads-drop-main">Перетащите фото пачкой или нажмите для выбора</span>' +
      '<span class="ads-drop-sub">Можно выделить сразу несколько файлов — из каждого получится отдельное объявление. Формат подберётся автоматически.</span>' +
      '<input type="file" id="ads-file" multiple accept=".jpg,.jpeg,.png" hidden>' +
      "</div>" +
      '<div class="ads-photos" id="ads-photos"></div>' +
      '<div class="ads-counter" id="ads-counter" hidden></div>' +
      '<div class="ads-uploading" id="ads-uploading" hidden>Загружаем фото в кабинет по одному (пауза — бережём лимиты VK)…</div>' +
      '<p class="ads-warn" id="ads-limit-warn" hidden></p>' +
      "</div>" +

      // Шаг 4 — тексты
      '<div class="ads-step" id="ads-texts-step" hidden>' +
      '<div class="ads-row-head"><label class="ads-label" style="margin:0">Тексты — одинаковые для всех объявлений</label>' +
      '<span class="ads-hint" id="ads-based2"></span></div>' +
      '<div class="ads-grid-2">' +
      "<div><label class='ads-label' for='ads-title'>Заголовок <span id='ads-title-c' class='ads-count'></span></label>" +
      "<input type='text' id='ads-title' maxlength='40'></div>" +
      "<div><label class='ads-label' for='ads-cta'>Кнопка-призыв (CTA)</label>" +
      "<input type='text' id='ads-cta' maxlength='30'><span class='ads-hint'>например: write (написать)</span></div>" +
      "</div>" +
      "<label class='ads-label' for='ads-about'>Реквизиты рекламодателя <span id='ads-about-c' class='ads-count'></span></label>" +
      "<input type='text' id='ads-about' maxlength='115'>" +
      "<label class='ads-label' for='ads-body'>Текст объявления <span id='ads-body-c' class='ads-count'></span></label>" +
      "<textarea id='ads-body' rows='4' maxlength='2000'></textarea>" +
      '<button type="button" class="ads-more" id="ads-more">Показать дополнительно (иконка и ссылка объявления)</button>' +
      '<div class="ads-grid-2" id="ads-adv" hidden>' +
      "<div><label class='ads-label' for='ads-icon'>Иконка (content_id) — как у существующих объявлений</label>" +
      "<input type='text' id='ads-icon' inputmode='numeric' placeholder='например 112275360'></div>" +
      "<div><label class='ads-label' for='ads-url'>Ссылка на сообщество (id)</label>" +
      "<input type='text' id='ads-url' inputmode='numeric'></div>" +
      "</div></div>" +

      // Шаг 5 — итог и создание
      '<div class="ads-step ads-create" id="ads-create-step" hidden>' +
      '<div class="ads-summary" id="ads-summary"></div>' +
      '<div class="ads-btnrow">' +
      '<button type="button" class="btn" id="ads-create">Создать объявления</button>' +
      '<span class="ads-hint" id="ads-create-hint"></span>' +
      "</div>" +
      '<div class="ads-progress" id="ads-progress" hidden>Создаём по одному объявлению (~1 сек на штуку)…</div>' +
      '<p class="ads-err" id="ads-create-err" hidden></p>' +
      '<div class="ads-results" id="ads-results"></div>' +
      "</div>" +

      "</div></div>" +
      '<p class="ads-note">Запись идёт в VK Рекламу через сервер' +
      (mode === "gh"
        ? " GitHub Actions (токены VK — в секретах репозитория, в браузер не попадают)"
        : " панели: токены VK не покидают сервер") +
      ". Кабинеты «только чтение» в списке отмечены и недоступны.</p>";
    bindForm();
  }

  function bindForm() {
    $("ads-cabinet").addEventListener("change", function () {
      switchCabinet(this.value || null);
    });
    $("ads-plan").addEventListener("change", function () {
      planId = Number(this.value) || null;
      groupId = null;
      fillGroups();
      updateSummary();
    });
    $("ads-group").addEventListener("change", function () {
      groupId = Number(this.value) || null;
      updateSummary();
    });

    var drop = $("ads-drop"), file = $("ads-file");
    drop.addEventListener("click", function () { file.click(); });
    drop.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); file.click(); }
    });
    ["dragenter", "dragover"].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add("over"); });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove("over"); });
    });
    drop.addEventListener("drop", function (e) { addFiles(e.dataTransfer.files); });
    file.addEventListener("change", function () {
      if (this.files && this.files.length) addFiles(this.files);
      this.value = "";
    });

    ["title", "cta", "about", "body"].forEach(function (id) {
      $("ads-" + id).addEventListener("input", function () {
        updateCounts();
        updateSummary();
      });
    });
    $("ads-more").addEventListener("click", function () {
      var adv = $("ads-adv"), open = !adv.hidden;
      adv.hidden = open;
      this.textContent = open ? "Показать дополнительно (иконка и ссылка объявления)" : "Скрыть дополнительно";
    });
    $("ads-icon").addEventListener("input", function () { this.value = this.value.replace(/\D/g, ""); updateSummary(); });
    $("ads-url").addEventListener("input", function () { this.value = this.value.replace(/\D/g, ""); updateSummary(); });

    $("ads-create").addEventListener("click", doCreate);
  }

  // ---------- кабинеты ----------
  function renderCabinets() {
    var sel = $("ads-cabinet");
    sel.innerHTML =
      '<option value="">Выберите кабинет…</option>' +
      cabinets
        .map(function (c) {
          var extra = c.clientName && c.clientName !== c.name ? " — " + c.clientName : "";
          var note = c.canWrite === false ? " · " + (c.writeNote || "только чтение") : "";
          return (
            '<option value="' + esc(c.value) + '"' + (c.canWrite === false ? " disabled" : "") + ">" +
            esc(c.name + extra) + " · " + fmtMoney(c.balance) + esc(note) +
            "</option>"
          );
        })
        .join("");
  }

  function switchCabinet(id) {
    cabinetId = id;
    planId = groupId = null;
    ctx = null;
    photos.forEach(function (p) { if (p.url) URL.revokeObjectURL(p.url); });
    photos = [];
    results = null; statuses = null;
    renderPhotos(); updateCounter();
    ["ads-ctx", "ads-photos-step", "ads-texts-step", "ads-create-step"].forEach(function (i) { $(i).hidden = true; });
    $("ads-results").innerHTML = "";
    if (!cabinetId) return;

    if (mode === "gh") {
      // контекст уже в ads-context.json (обновляется каждые 30 минут)
      ctx = ghContext.cabinets[String(cabinetId)] || null;
      if (!ctx) {
        var box = $("ads-ctx-err");
        box.textContent = "Для этого кабинета нет данных в ads-context.json";
        box.hidden = false;
        return;
      }
      ctx.plans = ctx.plans || []; ctx.groups = ctx.groups || [];
      applyContext();
      return;
    }

    $("ads-ctx-loading").hidden = false;
    $("ads-ctx-err").hidden = true;
    apiFetch("/api/ads/context?cabinet=" + encodeURIComponent(cabinetId)).then(function (c) {
      $("ads-ctx-loading").hidden = true;
      ctx = c;
      applyContext();
    }).catch(function (e) {
      $("ads-ctx-loading").hidden = true;
      if (e && e.needKey) { needKeyUi(); return; }
      var box = $("ads-ctx-err");
      box.textContent = e.message || String(e);
      box.hidden = false;
    });
  }

  function applyContext() {
    fillPlans(); fillGroups(); fillDefaults();
    $("ads-ctx").hidden = false;
    $("ads-photos-step").hidden = false;
    $("ads-texts-step").hidden = false;
    $("ads-create-step").hidden = false;
    var lim = $("ads-limits");
    if (ctx.limits && ctx.limits.maxActiveBanners != null) {
      lim.textContent = "активных объявлений: " + (ctx.limits.activeBanners != null ? ctx.limits.activeBanners : "—") +
        " / " + ctx.limits.maxActiveBanners;
      lim.hidden = false;
    } else lim.hidden = true;
    var based = "автозаполнено из " + ((ctx.defaults && ctx.defaults.basedOnBanners) || 0) + " существующих объявлений кабинета";
    $("ads-based").textContent = based;
    $("ads-based2").textContent = based;
    updateCounts(); updateSummary();
  }

  function fillPlans() {
    $("ads-plan").innerHTML =
      '<option value="">Все кампании</option>' +
      ctx.plans.map(function (p) {
        return '<option value="' + p.id + '">' + esc(p.name) + "</option>";
      }).join("");
  }
  function fillGroups() {
    var groups = ctx ? ctx.groups.filter(function (g) { return !planId || g.planId === planId; }) : [];
    $("ads-group").innerHTML =
      '<option value="">Выберите группу…</option>' +
      groups.map(function (g) {
        return '<option value="' + g.id + '">' + esc(g.name) + "</option>";
      }).join("");
    var g = groups.filter(function (x) { return x.id === groupId; })[0];
    if (!g) groupId = null;
    $("ads-group").value = groupId ? String(groupId) : "";
    $("ads-group-info").textContent = g
      ? "id группы " + g.id + (g.packageId ? " · пакет " + g.packageId : "")
      : "";
  }
  function fillDefaults() {
    var d = ctx.defaults || {};
    $("ads-title").value = d.title || "";
    $("ads-cta").value = d.cta || "";
    $("ads-about").value = d.about || "";
    $("ads-body").value = d.text || "";
    $("ads-icon").value = d.iconId != null ? String(d.iconId) : "";
    $("ads-url").value = d.urlId != null ? String(d.urlId) : "";
  }

  // ---------- фото ----------
  function addFiles(files) {
    if (!cabinetId) return;
    var accepted = [];
    Array.prototype.forEach.call(files, function (f) {
      if (!/\.(jpe?g|png)$/i.test(f.name) || f.size > 5 * 1024 * 1024) return;
      accepted.push({ uid: ++uid, file: f, name: cleanName(f.name), url: URL.createObjectURL(f), w: null, h: null, slot: null, kept: null, uploading: false, contentId: null, reused: false, photo: null, error: null });
    });
    if (!accepted.length) return;
    photos = photos.concat(accepted);
    renderPhotos(); updateCounter();
    accepted.forEach(function (p) {
      var img = new Image();
      img.onload = function () {
        p.w = img.naturalWidth; p.h = img.naturalHeight;
        p.slot = pickSlot(p.w, p.h);
        p.kept = p.slot.kept;
        if (mode === "gh") {
          cropToSlot(img, p.slot, function (b64) {
            p.photo = b64;          // jpeg уже в размере слота — грузить будет Actions
            p.uploading = false;
            updatePhotoCard(p); updateCounter();
          });
        }
        updatePhotoCard(p); updateCounter();
      };
      img.onerror = function () { p.error = "не удалось прочитать файл"; updatePhotoCard(p); };
      img.src = p.url;
    });
    if (mode === "panel") uploadQueue(accepted);
  }

  /** Кроп под слот в браузере (canvas, cover, приоритет верхней части) → base64 JPEG. */
  function cropToSlot(img, slot, cb) {
    var w = slot.w, h = slot.h;
    var canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    var c2d = canvas.getContext("2d");
    var sw = img.naturalWidth, sh = img.naturalHeight;
    var scale = Math.max(w / sw, h / sh);
    var dw = sw * scale, dh = sh * scale;
    var dx = (w - dw) / 2;          // по горизонтали — центр
    var dy = dh >= h ? 0 : (h - dh) / 2; // по вертикали — прижим вверх (как sharp position: top)
    c2d.drawImage(img, dx, dy, dw, dh);
    canvas.toBlob(function (blob) {
      if (!blob) return;
      var fr = new FileReader();
      fr.onload = function () { cb(fr.result.split(",")[1]); };
      fr.readAsDataURL(blob);
    }, "image/jpeg", 0.9);
  }

  function uploadQueue(items) {
    uploading = true;
    $("ads-uploading").hidden = false;
    var chain = Promise.resolve();
    items.forEach(function (p) {
      chain = chain.then(function () {
        if (photos.indexOf(p) < 0) return;
        p.uploading = true; updatePhotoCard(p);
        var fd = new FormData();
        fd.append("cabinet", String(cabinetId));
        fd.append("file", p.file, p.file.name);
        return fetch(backend + "/api/ads/upload", {
          method: "POST",
          headers: { "X-Panel-Key": panelKey },
          body: fd,
        }).then(function (r) {
          if (r.status === 401) { var e = new Error("нужен ключ панели"); e.needKey = true; throw e; }
          return r.json();
        }).then(function (j) {
          p.uploading = false;
          if (j.ok) {
            p.contentId = j.contentId;
            p.slot = SLOTS.filter(function (s) { return s.slot === j.slot; })[0] || p.slot;
            p.kept = j.kept;
            p.reused = !!j.reused;
          } else {
            p.error = j.error || "ошибка загрузки";
          }
        }).catch(function (e) {
          p.uploading = false;
          p.error = e && e.message ? e.message : "сеть недоступна";
          if (e && e.needKey) needKeyUi();
        }).then(function () {
          updatePhotoCard(p); updateCounter();
        });
      });
    });
    chain.then(function () {
      uploading = false;
      $("ads-uploading").hidden = true;
      updateCounter();
    });
  }

  function readyPhotos() {
    return photos.filter(function (p) {
      if (p.error || p.uploading) return false;
      return mode === "gh" ? !!p.photo : !!p.contentId;
    });
  }

  function photoCard(p) {
    var status;
    if (p.uploading) {
      status = '<span class="ads-ph-st ads-ph-up">загружаем в кабинет…</span>';
    } else if (p.error) {
      status = '<span class="ads-ph-st ads-ph-err" title="' + esc(p.error) + '">✕ ' + esc(String(p.error).slice(0, 60)) + "</span>";
    } else if (mode === "gh") {
      status =
        '<span class="ads-ph-st"><span class="ads-slot">' + esc((p.slot && p.slot.label) || "…") + "</span>" +
        (p.photo ? "" : " <span class='ads-muted'>готовим…</span>") +
        "</span>";
    } else if (p.contentId) {
      status =
        '<span class="ads-ph-st"><span class="ads-slot">' + esc((p.slot && p.slot.label) || p.slot) + "</span>" +
        (p.kept != null ? " <span class='ads-muted'>сохранится " + Math.round(p.kept * 100) + "%</span>" : "") +
        (p.reused ? " <span class='ads-muted'>(уже была в кабинете)</span>" : "") +
        "</span>";
    } else if (p.slot) {
      status = '<span class="ads-ph-st"><span class="ads-slot">' + esc(p.slot.label) + "</span></span>";
    } else {
      status = "";
    }
    return (
      '<div class="ads-photo" id="ads-ph-' + p.uid + '">' +
      '<div class="ads-photo-img"><img src="' + p.url + '" alt="Фото ' + esc(p.file.name) + '">' +
      '<button type="button" class="ads-ph-del" data-uid="' + p.uid + '" aria-label="Убрать фото">×</button></div>' +
      '<input type="text" class="ads-ph-name" data-uid="' + p.uid + '" value="' + esc(p.name) + '" aria-label="Имя объявления">' +
      '<div class="ads-ph-meta">' + status + "</div>" +
      "</div>"
    );
  }

  function renderPhotos() {
    $("ads-photos").innerHTML = photos.map(photoCard).join("");
    bindPhotoCards();
  }
  function updatePhotoCard(p) {
    var card = $("ads-ph-" + p.uid);
    if (!card) { renderPhotos(); return; }
    card.outerHTML = photoCard(p);
    bindPhotoCards();
  }
  function bindPhotoCards() {
    document.querySelectorAll(".ads-ph-del").forEach(function (b) {
      b.onclick = function () {
        var u = Number(b.dataset.uid);
        photos = photos.filter(function (p) {
          if (p.uid === u && p.url) URL.revokeObjectURL(p.url);
          return p.uid !== u;
        });
        renderPhotos(); updateCounter();
      };
    });
    document.querySelectorAll(".ads-ph-name").forEach(function (inp) {
      inp.oninput = function () {
        var u = Number(inp.dataset.uid);
        photos.forEach(function (p) { if (p.uid === u) p.name = inp.value; });
      };
    });
  }

  function updateCounter() {
    var bar = $("ads-counter");
    if (!bar) return;
    if (!photos.length) { bar.hidden = true; return; }
    var ready = readyPhotos().length;
    bar.hidden = false;
    if (uploading) {
      bar.innerHTML = "Загружаем фото в кабинет… готово " + ready + " из " + photos.length;
      bar.classList.add("muted");
    } else {
      bar.classList.remove("muted");
      bar.innerHTML =
        "Загружено " + photos.length + " " + pluralPhotos(photos.length) + " · <b>будет создано " + ready + " " + pluralAds(ready) + "</b>" +
        (photos.length !== ready
          ? ' <span class="ads-muted">(' + (photos.length - ready) + " не готовы — ошибка или ещё грузятся)</span>"
          : ' <span class="ads-muted">— по одному на каждую фотографию</span>');
    }
    var warn = $("ads-limit-warn");
    if (ctx && ctx.limits && ctx.limits.maxActiveBanners != null && ctx.limits.activeBanners != null && ready > 0) {
      var over = ctx.limits.activeBanners + ready > ctx.limits.maxActiveBanners;
      warn.hidden = !over;
      warn.textContent = "Лимит активных объявлений может быть превышен — VK может отклонить часть созданий.";
    } else if (warn) warn.hidden = true;
    updateSummary();
  }

  // ---------- тексты ----------
  function updateCounts() {
    $("ads-title-c").textContent = ($("ads-title").value.length) + "/40";
    $("ads-about-c").textContent = ($("ads-about").value.length) + "/115";
    $("ads-body-c").textContent = ($("ads-body").value.length) + "/2000";
  }

  function textsValid() {
    return {
      title: $("ads-title").value.trim(),
      cta: $("ads-cta").value.trim(),
      about: $("ads-about").value.trim(),
      body: $("ads-body").value.trim(),
    };
  }

  function updateSummary() {
    var sum = $("ads-summary"), btn = $("ads-create"), hint = $("ads-create-hint");
    if (!sum) return;
    var ready = readyPhotos().length;
    var g = ctx && ctx.groups ? ctx.groups.filter(function (x) { return x.id === groupId; })[0] : null;
    sum.innerHTML =
      "Будет создано: <b>" + ready + " " + pluralAds(ready) + "</b>" +
      (ready === 0
        ? " — загрузите фото выше"
        : " — по одному на каждое фото, с одинаковыми текстами" + (g ? ", в группе «" + esc(g.name) + "»" : ""));
    var t = textsValid();
    var ok = !!groupId && ready > 0 && t.title && t.about && t.body && t.cta &&
      $("ads-icon").value && $("ads-url").value;
    btn.disabled = !ok || creating;
    btn.textContent = creating ? "Создаём…" : "Создать " + ready + " " + pluralAds(ready);
    if (!ok && !creating) {
      hint.textContent = !groupId
        ? "выберите группу объявлений"
        : ready === 0
          ? "загрузите хотя бы одно фото"
          : "проверьте тексты и поля";
    } else {
      hint.textContent = "";
    }
  }

  // ---------- создание ----------
  function doCreate() {
    if (creating) return;
    var ready = readyPhotos();
    var t = textsValid();
    var g = ctx.groups.filter(function (x) { return x.id === groupId; })[0];
    var cab = cabinets.filter(function (c) { return String(c.value) === String(cabinetId); })[0];
    var label = (cab ? cab.name : "кабинет") + " → " + (g ? g.name : "");
    if (!window.confirm(
      "Создать " + ready.length + " " + pluralAds(ready.length) + " в группе «" + (g ? g.name : "") + "» (" + label + ")?\n" +
      "Все — с одинаковыми текстами. Сразу уйдут на модерацию VK." +
      (mode === "gh" ? "\nОбработка через GitHub Actions займёт ~30–90 секунд." : "")
    )) return;

    creating = true;
    $("ads-progress").hidden = false;
    $("ads-progress").textContent = mode === "gh"
      ? "Отправляем задание в GitHub и ждём обработку (обычно 30–90 секунд)…"
      : "Создаём по одному объявлению (~1 сек на штуку)…";
    $("ads-create-err").hidden = true;
    updateSummary();

    var done = function () {
      creating = false;
      $("ads-progress").hidden = true;
      updateSummary();
    };

    if (mode === "gh") {
      var jobId = "job_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      var job = {
        id: jobId,
        type: "create",
        cabinet: Number(cabinetId),
        group: Number(groupId),
        iconId: Number($("ads-icon").value),
        urlId: Number($("ads-url").value),
        texts: t,
        items: ready.map(function (p) {
          return { name: p.name, slot: p.slot.slot, photo: p.photo };
        }),
      };
      ghRunJob(job, function (tries) {
        $("ads-progress").textContent = "Задание в GitHub Actions, ждём результат… (" + (tries * 6) + " сек)";
      }).then(function (out) {
        results = out.results || [];
        if (!out.ok && out.error) {
          var box = $("ads-create-err");
          box.textContent = out.error;
          box.hidden = false;
        }
        statuses = null;
        renderResults();
        ghRefreshStatuses();
        done();
      }).catch(function (e) {
        var box = $("ads-create-err");
        box.textContent = e.message || String(e);
        box.hidden = false;
        done();
      });
      return;
    }

    apiFetch("/api/ads/create", {
      method: "POST",
      json: {
        cabinetId: Number(cabinetId),
        groupId: Number(groupId),
        iconId: Number($("ads-icon").value),
        urlId: Number($("ads-url").value),
        texts: t,
        items: ready.map(function (p) {
          return { name: p.name, slot: p.slot.slot, contentId: p.contentId };
        }),
      },
    }).then(function (j) {
      results = j.results || [];
      renderResults();
      refreshStatuses();
    }).catch(function (e) {
      if (e && e.needKey) { needKeyUi(); return; }
      var box = $("ads-create-err");
      box.textContent = e.message || String(e);
      box.hidden = false;
    }).then(done);
  }

  function modBadge(s, reasons) {
    var map = {
      allowed: ["прошла модерацию", "ok"],
      pending: ["на модерации", "pend"],
      declined: ["отклонена · нужна ручная проверка", "decl"],
    };
    var m = map[s] || [s || "—", "unk"];
    var title = reasons && reasons.length ? ' title="' + esc(reasons.join("; ")) + '"' : "";
    return '<span class="ads-mod ads-mod-' + m[1] + '"' + title + ">" + m[0] + "</span>";
  }

  function renderResults() {
    var box = $("ads-results");
    if (!results) { box.innerHTML = ""; return; }
    box.innerHTML =
      '<div class="ads-res-head"><span>Результат: создано ' +
      results.filter(function (r) { return r.ok; }).length + " из " + results.length + "</span>" +
      '<button type="button" class="btn btn-outline" id="ads-status-btn">Обновить статусы модерации</button></div>' +
      '<div class="table-wrap ads-res-table"><table class="grid-table"><thead><tr>' +
      "<th>Объявление</th><th>ID</th><th>Модерация</th>" +
      "</tr></thead><tbody>" +
      results.map(function (r) {
        var st = statuses ? statuses.filter(function (s) { return s.id === r.bannerId; })[0] : null;
        var mod = st ? st.moderationStatus : r.moderationStatus;
        var reason = st ? st.reasons : null;
        return (
          "<tr><td>" + esc(r.name) + (r.ok ? "" : ' <span class="ads-err-txt">' + esc(r.error || "") + "</span>") +
          "</td><td class='num'>" + (r.bannerId != null ? r.bannerId : "—") +
          "</td><td>" + (r.ok ? modBadge(mod, reason) : "—") + "</td></tr>"
        );
      }).join("") +
      "</tbody></table></div>";
    $("ads-status-btn").addEventListener("click", function () {
      if (mode === "gh") ghRefreshStatuses(); else refreshStatuses();
    });
  }

  function refreshStatuses() {
    if (mode !== "panel" || !cabinetId || !groupId) return;
    apiFetch("/api/ads/status?cabinet=" + encodeURIComponent(cabinetId) + "&group=" + groupId).then(function (j) {
      statuses = j.rows || [];
      renderResults();
    }).catch(function (e) { /* тихо: статусы не критичны */ });
  }

  function ghRefreshStatuses() {
    if (mode !== "gh" || !cabinetId || !groupId || !ghToken) return;
    var jobId = "st_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    var job = { id: jobId, type: "status", cabinet: Number(cabinetId), group: Number(groupId) };
    ghRunJob(job).then(function (out) {
      if (out.ok) {
        statuses = out.rows || [];
        renderResults();
      }
    }).catch(function (e) { /* тихо */ });
  }

  // ---------- запуск ----------
  var booted = false;
  function boot() {
    try { panelKey = localStorage.getItem(LS_KEY) || ""; } catch (e) { panelKey = ""; }
    try { ghToken = localStorage.getItem(LS_GH_KEY) || ""; } catch (e) { ghToken = ""; }
    connState('<div class="ads-conn-ok">Ищем панель…</div>');
    mode = null;

    detectBackend().then(function (j) {
      mode = "panel";
      cabinets = (j && j.rows ? j.rows : []).map(function (c) {
        return { value: String(c.id), name: c.name, clientName: c.clientName, balance: c.balance, canWrite: c.canWrite, writeNote: c.writeNote };
      });
      afterConnect();
    }).catch(function (e) {
      if (e && e.needKey) { mode = "panel"; needKeyUi(); return; }
      // панели нет → режим GitHub Actions
      ghFetchContextJson().then(function (gc) {
        ghContext = gc;
        mode = "gh";
        if (!ghToken) {
          connState(
            '<div class="ads-conn-gh"><div><b>Режим GitHub Actions.</b> Панель на компьютере не запущена — ' +
            "объявления создаст workflow в репозитории. Нужен токен GitHub — узкий ключ " +
            "записи в репозиторий (зачем и как — ниже).</div>" +
            ghTokenForm() + "</div>"
          );
          bindGhTokenForm();
          if (!booted) { renderConstructor(); booted = true; }
          return;
        }
        cabinets = Object.keys(gc.cabinets || {}).map(function (extId) {
          var c = gc.cabinets[extId];
          return { value: extId, name: c.name, clientName: c.clientName, balance: c.balance, canWrite: true };
        });
        connState('<div class="ads-conn-gh"><div><b>Режим GitHub Actions.</b> Задания обрабатывает workflow ' +
          "в репозитории (токены VK — в секретах GitHub). Обработка ~30–90 сек.</div></div>");
        afterConnect();
      }).catch(function () {
        offlineNotice("Создание объявлений работает либо через панель (Next.js, bun run dev — запустите её и нажмите «Обновить»), либо через GitHub Actions.");
      });
    });
  }

  function afterConnect() {
    connState(mode === "gh"
      ? '<div class="ads-conn-gh"><div><b>Режим GitHub Actions.</b> Задания обрабатывает workflow в репозитории ' +
        "(токены VK — в секретах GitHub). Обработка ~30–90 сек.</div></div>"
      : "");
    if (!booted) {
      renderConstructor();
      booted = true;
    }
    renderCabinets();
    $("ads-cabinet").value = cabinetId ? String(cabinetId) : "";
  }

  function init() {
    var toggle = $("ads-toggle");
    toggle.addEventListener("click", function () {
      var open = $("ads-body").hidden;
      $("ads-body").hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.textContent = open ? "Свернуть" : "Создать объявления";
      if (open && !mode) boot();
    });
    $("ads-refresh").addEventListener("click", function () {
      if (!$("ads-body").hidden) boot();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
