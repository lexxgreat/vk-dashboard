// VK Дашборд — секция «Реклама — создание объявлений» для GitHub Pages.
// Запись в VK Рекламу идёт через панель-бэкенд (Next.js): токены VK остаются
// на сервере и в браузер не попадают. Панель ищется по списку адресов ниже.
"use strict";

(function () {
  // ---------- конфиг: где искать панель ----------
  var ADS_BACKENDS = [
    "http://127.0.0.1:3000", // панель на этом компьютере
    // (публичный адрес панели добавляется при деплое)
  ];
  var LS_BACKEND = "adsBackendUrl";
  var LS_KEY = "adsPanelKey";

  // ---------- состояние ----------
  var backend = null;
  var panelKey = "";
  var cabinets = null; // [{id,name,clientName,balance,canWrite,writeNote}]
  var ctx = null; // AdsContextDto
  var cabinetId = null;
  var planId = null;
  var groupId = null;
  var photos = []; // см. addFiles
  var uploading = false;
  var results = null;
  var statuses = null; // [{id,name,status,moderationStatus,reasons}]
  var creating = false;
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
  function $(id) { return document.getElementById(id); }
  function cleanName(fileName) {
    return fileName.replace(/\.(jpe?g|png)$/i, "").replace(/[-_\s]+/g, "").slice(0, 100);
  }

  // ---------- вызов API панели ----------
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
      signal: opts.signal,
    }).then(function (r) {
      if (r.status === 401) {
        var err = new Error("нужен ключ панели");
        err.needKey = true;
        throw err;
      }
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
        return j;
      });
    });
  }

  // ---------- поиск панели ----------
  function detectBackend() {
    var tryNext = function (list, i) {
      if (i >= list.length) return Promise.reject(new Error("not found"));
      var url = list[i];
      return fetch(url + "/api/ads/cabinets", {
        headers: { "X-Panel-Key": panelKey },
        signal: AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined,
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
      "<div><b>Панель не найдена.</b> Создание объявлений работает через панель (сервер с ключами VK) — " +
      "она должна быть запущена. " + esc(detail || "") + "</div></div>" +
      keyFormHtml()
    );
    bindKeyForm();
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
      '<p class="ads-note">Запись идёт напрямую в VK Рекламу с сервера панели: токены не покидают сервер. ' +
      "Кабинеты «только чтение» (прокси TargetHunter, лимит токенов) в списке отмечены и недоступны.</p>";
    bindForm();
  }

  function bindForm() {
    $("ads-cabinet").addEventListener("change", function () {
      switchCabinet(Number(this.value) || null);
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
          var note = c.canWrite ? "" : " · " + (c.writeNote || "только чтение");
          return (
            '<option value="' + c.id + '"' + (c.canWrite ? "" : " disabled") + ">" +
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
    $("ads-ctx-loading").hidden = false;
    $("ads-ctx-err").hidden = true;
    apiFetch("/api/ads/context?cabinet=" + cabinetId).then(function (c) {
      $("ads-ctx-loading").hidden = true;
      ctx = c;
      fillPlans(); fillGroups(); fillDefaults();
      $("ads-ctx").hidden = false;
      $("ads-photos-step").hidden = false;
      $("ads-texts-step").hidden = false;
      $("ads-create-step").hidden = false;
      var lim = $("ads-limits");
      if (ctx.limits.maxActiveBanners != null) {
        lim.textContent = "активных объявлений: " + (ctx.limits.activeBanners != null ? ctx.limits.activeBanners : "—") +
          " / " + ctx.limits.maxActiveBanners;
        lim.hidden = false;
      }
      var based = "автозаполнено из " + ctx.defaults.basedOnBanners + " существующих объявлений кабинета";
      $("ads-based").textContent = based;
      $("ads-based2").textContent = based;
      updateCounts(); updateSummary();
    }).catch(function (e) {
      $("ads-ctx-loading").hidden = true;
      if (e && e.needKey) { needKeyUi(); return; }
      var box = $("ads-ctx-err");
      box.textContent = e.message || String(e);
      box.hidden = false;
    });
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
    var d = ctx.defaults;
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
      accepted.push({ uid: ++uid, file: f, name: cleanName(f.name), url: URL.createObjectURL(f), w: null, h: null, slot: null, uploading: false, contentId: null, kept: null, reused: false, error: null });
    });
    if (!accepted.length) return;
    photos = photos.concat(accepted);
    renderPhotos(); updateCounter();
    accepted.forEach(function (p) {
      var img = new Image();
      img.onload = function () {
        p.w = img.naturalWidth; p.h = img.naturalHeight;
        p.slot = pickSlot(p.w, p.h);
        updatePhotoCard(p);
        updateCounter();
      };
      img.src = p.url;
    });
    uploadQueue(accepted);
  }

  function uploadQueue(items) {
    uploading = true;
    $("ads-uploading").hidden = false;
    var chain = Promise.resolve();
    items.forEach(function (p) {
      chain = chain.then(function () {
        if (photos.indexOf(p) < 0) return; // удалили пока грузилось
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
    return photos.filter(function (p) { return p.contentId && !p.uploading && !p.error; });
  }

  function photoCard(p) {
    var status;
    if (p.uploading) {
      status = '<span class="ads-ph-st ads-ph-up">загружаем в кабинет…</span>';
    } else if (p.error) {
      status = '<span class="ads-ph-st ads-ph-err" title="' + esc(p.error) + '">✕ ' + esc(String(p.error).slice(0, 60)) + "</span>";
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
    if (ctx && ctx.limits.maxActiveBanners != null && ctx.limits.activeBanners != null && ready > 0) {
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

  function needKeyUi() {
    connState(
      '<div class="ads-conn-key">' +
      "<div><b>Панель требует ключ.</b> Введите ключ доступа — он хранится только в вашем браузере.</div>" +
      keyFormHtml() + "</div>"
    );
    bindKeyForm();
  }

  // ---------- создание ----------
  function doCreate() {
    if (creating) return;
    var ready = readyPhotos();
    var t = textsValid();
    var g = ctx.groups.filter(function (x) { return x.id === groupId; })[0];
    var cab = cabinets.filter(function (c) { return c.id === cabinetId; })[0];
    var label = (cab ? cab.name : "кабинет") + " → " + (g ? g.name : "");
    if (!window.confirm(
      "Создать " + ready.length + " " + pluralAds(ready.length) + " в группе «" + (g ? g.name : "") + "» (" + label + ")?\n" +
      "Все — с одинаковыми текстами. Сразу уйдут на модерацию VK."
    )) return;

    creating = true;
    $("ads-progress").hidden = false;
    $("ads-create-err").hidden = true;
    updateSummary();
    apiFetch("/api/ads/create", {
      method: "POST",
      json: {
        cabinetId: cabinetId,
        groupId: groupId,
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
    }).then(function () {
      creating = false;
      $("ads-progress").hidden = true;
      updateSummary();
    });
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
        var reason = st ? st.reasons : [];
        return (
          "<tr><td>" + esc(r.name) + (r.ok ? "" : ' <span class="ads-err-txt">' + esc(r.error || "") + "</span>") +
          "</td><td class='num'>" + (r.bannerId != null ? r.bannerId : "—") +
          "</td><td>" + (r.ok ? modBadge(mod, reason) : "—") + "</td></tr>"
        );
      }).join("") +
      "</tbody></table></div>";
    $("ads-status-btn").addEventListener("click", refreshStatuses);
  }

  function refreshStatuses() {
    if (!cabinetId || !groupId) return;
    apiFetch("/api/ads/status?cabinet=" + cabinetId + "&group=" + groupId).then(function (j) {
      statuses = j.rows || [];
      renderResults();
    }).catch(function (e) { /* тихо: статусы не критичны */ });
  }

  // ---------- запуск ----------
  var booted = false;
  function boot() {
    try { panelKey = localStorage.getItem(LS_KEY) || ""; } catch (e) { panelKey = ""; }
    connState('<div class="ads-conn-ok">Ищем панель…</div>');
    detectBackend().then(function (j) {
      try {
        cabinets = (j && j.rows) || [];
        connState("");
        if (!booted) {
          renderConstructor();
          booted = true;
        }
        renderCabinets();
        $("ads-cabinet").value = cabinetId ? String(cabinetId) : "";
      } catch (renderErr) {
        console.error("[ads] render:", renderErr);
      }
    }).catch(function (e) {
      if (e && e.needKey) { needKeyUi(); return; }
      offlineNotice("Панель — это Next.js-сервер проекта (bun run dev). Запустите её на компьютере и нажмите «Обновить».");
    });
  }

  function init() {
    var toggle = $("ads-toggle");
    toggle.addEventListener("click", function () {
      var open = $("ads-body").hidden;
      $("ads-body").hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.textContent = open ? "Свернуть" : "Создать объявления";
      if (open && !backend) boot();
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
