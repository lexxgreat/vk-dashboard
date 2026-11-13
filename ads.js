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
  // ссылка с автозаполнением формы токена (имя/описание/срок/право Contents:rw).
  // Параметры по документации GitHub; репозиторий и «Generate» пользователь выбирает сам.
  var GH_NEW_TOKEN_URL =
    "https://github.com/settings/personal-access-tokens/new?name=" +
    encodeURIComponent("vk-dashboard сайт") +
    "&description=" +
    encodeURIComponent("Создание объявлений с сайта vk-dashboard") +
    "&expires_in=90&contents=write";
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
  var titleVariants = []; // списки для A/B-тестов: каждое фото × каждый вариант
  var textVariants = [];
  var rulesData = null; // ads-rules.json (автостоп)
  var rulesLog = null;  // ads-rules-log.json
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
  function ghPut(path, message, contentStr, sha) {
    return fetch(GH_API + "contents/" + encodeURIComponent(path).replace(/%2F/g, "/"), {
      method: "PUT",
      headers: {
        Authorization: "Bearer " + ghToken,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: message, content: b64utf8(contentStr), branch: GH_BRANCH, ...(sha ? { sha: sha } : {}) }),
    }).then(function (r) {
      if (r.status === 401 || r.status === 403) {
        throw new Error("GitHub отклонил токен (проверьте fine-grained PAT с правом Contents: write на репозиторий " + GH_REPO + ")");
      }
      if (!r.ok) throw new Error("GitHub HTTP " + r.status + (r.status === 409 ? " (файл успел измениться — нажмите «Обновить» и повторите)" : ""));
      return r.json();
    });
  }

  function utf8b64(s) {
    return decodeURIComponent(escape(atob(s)));
  }
  /** Текущий файл из репозитория: { sha, text } или null (404).
   *  no-store + свежий параметр _t: браузерный кэш отдавал устаревший sha,
   *  и PUT получал 409 «файл успел измениться» (баг 13.11 — правила не
   *  удалялись/не создавались, хотя сервер иногда принимал первую из гонки). */
  function ghGetFile(path) {
    return fetch(GH_API + "contents/" + encodeURIComponent(path).replace(/%2F/g, "/") + "?ref=" + GH_BRANCH + "&_t=" + Date.now(), {
      headers: { Authorization: "Bearer " + ghToken, Accept: "application/vnd.github+json" },
      cache: "no-store",
    }).then(function (r) {
      if (r.status === 404) return null;
      if (!r.ok) throw new Error("GitHub HTTP " + r.status);
      return r.json();
    }).then(function (meta) {
      return meta ? { sha: meta.sha, text: utf8b64(meta.content) } : null;
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
      "<b>Как создать:</b> нажмите кнопку ниже — имя, описание, срок 90 дней и право " +
      "<b>Contents: Read and write</b> заполнятся сами. На открывшейся странице останется " +
      "два шага: Repository access → <i>Only select repositories</i> → выбрать <b>" + GH_REPO +
      "</b>, затем внизу <b>Generate token</b>. Скопируйте токен (показывается один раз) " +
      "и вставьте в поле здесь. Токен сохраняется только в этом браузере (localStorage) " +
      "и в любой момент отзывается на github.com.";
    return (
      '<div class="ads-gh"><p class="ads-gh-help">' + help + "</p>" +
      '<div style="margin-top:10px"><a class="btn" href="' + GH_NEW_TOKEN_URL +
      '" target="_blank" rel="noopener noreferrer">Создать токен — всё уже заполнено</a></div>' +
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
      '<div class="ads-row-head"><label class="ads-label" style="margin:0" id="ads-texts-head">Тексты — одинаковые для всех объявлений</label>' +
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

      // списки текстов для A/B-тестов
      '<div class="ads-bulk" id="ads-bulk">' +
      '<div class="ads-row-head"><label class="ads-label" style="margin:0">Тексты списком — для A/B-тестов</label>' +
      '<span class="ads-hint">необязательно</span></div>' +
      '<div class="ads-bulk-tools">' +
      '<label class="btn btn-outline ads-bulk-filebtn">Загрузить Excel/CSV<input type="file" id="ads-bulk-file" accept=".xlsx,.xls,.csv,.tsv,.txt" hidden></label>' +
      '<button type="button" class="btn btn-outline" id="ads-bulk-clear">Очистить списки</button>' +
      "</div>" +
      '<div class="ads-bulk-paste">' +
      "<div><label class='ads-label' for='ads-bulk-titles'>Заголовки — по одному в строке</label>" +
      "<textarea id='ads-bulk-titles' rows='3' placeholder='Например:&#10;Шарики с гелием&#10;Шары под потолок'></textarea></div>" +
      "<div><label class='ads-label' for='ads-bulk-texts'>Тексты — по одному в строке</label>" +
      "<textarea id='ads-bulk-texts' rows='3' placeholder='Каждая строка — отдельный вариант текста объявления'></textarea></div>" +
      "</div>" +
      '<div class="ads-btnrow"><button type="button" class="btn" id="ads-bulk-apply">Применить списки</button>' +
      '<span class="ads-hint" id="ads-bulk-msg"></span></div>' +
      '<div class="ads-bulk-lists" id="ads-bulk-lists"></div>' +
      '<p class="ads-hint">Каждое фото × каждый заголовок × каждый текст = отдельное объявление. ' +
      "Excel/CSV: колонки «заголовок» и «текст» (можно одну; без заголовков — первая колонка заголовки, вторая тексты). " +
      "Поля выше — общий вариант: пустая ячейка списка подставит его.</p>" +
      "</div>" +

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

      // Автостоп — правила автоостановки объявлений (только gh-режим: исполняет GitHub)
      (mode === "gh"
        ? '<div class="ads-card" id="ads-rules-card">' +
          '<div class="ads-card-head"><span>Автостоп объявлений</span><span class="badge" id="ads-rules-badge">…</span></div>' +
          '<div class="ads-card-body">' +
          '<p class="ads-hint">Правила проверяет GitHub — даже когда вы ушли с сайта: запланировано 6 раз в час (:07–:57), сразу после изменения правил и по кнопке «Проверить сейчас». GitHub нередко прореживает запуски, поэтому реально проверки проходят примерно раз в 1–2 часа. Статистика VK отстаёт на ~1–2 часа — от превышения порога до остановки обычно проходит 1–3 часа. Остановка = «Остановлено» в VK Рекламе: баннер не крутится, но сохраняется (тексты и креатив на месте, можно запустить снова). Оба порога срабатывают вместе: потратил больше лимита И клик дороже — стоп; дешёвые клики — вариант удачный, крутится дальше.</p>' +
          '<div id="ads-rules-list"></div>' +
          '<form class="ads-rule-form" id="ads-rule-form">' +
          '<div class="ads-rule-row">' +
          '<select class="ads-select" id="ads-rule-cabinet"><option value="">Кабинет…</option></select>' +
          '<select class="ads-select" id="ads-rule-group"><option value="">Группа…</option></select>' +
          "</div>" +
          '<div class="ads-rule-row">' +
          '<label>стоп при расходе &gt; <input type="number" id="ads-rule-spend" min="1" step="1" placeholder="25"> ₽</label>' +
          '<label>и цене клика &gt; <input type="number" id="ads-rule-cpc" min="0.5" step="0.5" placeholder="30"> ₽</label>' +
          '<label>за <input type="number" id="ads-rule-days" min="1" max="90" step="1" value="30"> дн.</label>' +
          "</div>" +
          '<p class="ads-hint">Оба порога работают вместе — стоп, когда потрачено больше И клик дороже; один порог (второй пустой) — срабатывает сам по себе.</p>' +
          '<div class="ads-btnrow"><button type="submit" class="btn" id="ads-rule-add">Добавить правило</button>' +
          '<button type="button" class="btn btn-outline" id="ads-rules-refresh">Обновить</button>' +
          '<button type="button" class="btn btn-outline" id="ads-rule-check">Проверить сейчас</button>' +
          '<span class="ads-hint" id="ads-rule-msg"></span></div>' +
          "</form>" +
          '<p class="ads-err" id="ads-rule-err" hidden></p>' +
          '<div class="ads-rules-log" id="ads-rules-log"></div>' +
          "</div></div>"
        : "") +

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
    bindBulk();
    if (mode === "gh") bindRules();
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
    var cc = comboCounts();
    bar.hidden = false;
    if (uploading) {
      bar.innerHTML = "Готовим фото… готово " + ready + " из " + photos.length;
      bar.classList.add("muted");
    } else if (variantsActive()) {
      bar.classList.remove("muted");
      var parts = ["Загружено " + photos.length + " " + pluralPhotos(photos.length)];
      if (cc.titles) parts.push(cc.titles + " " + pluralField(cc.titles, "заголовок", "заголовка", "заголовков"));
      if (cc.texts) parts.push(cc.texts + " " + pluralField(cc.texts, "текст", "текста", "текстов"));
      bar.innerHTML = parts.join(" · ") + " → <b>будет создано " + cc.total + " " + pluralAds(cc.total) + "</b>" +
        (photos.length !== ready ? ' <span class="ads-muted">(' + (photos.length - ready) + " фото не готовы)</span>" : "");
    } else {
      bar.classList.remove("muted");
      bar.innerHTML =
        "Загружено " + photos.length + " " + pluralPhotos(photos.length) + " · <b>будет создано " + ready + " " + pluralAds(ready) + "</b>" +
        (photos.length !== ready
          ? ' <span class="ads-muted">(' + (photos.length - ready) + " не готовы — ошибка или ещё грузятся)</span>"
          : ' <span class="ads-muted">— по одному на каждую фотографию</span>');
    }
    var warn = $("ads-limit-warn");
    if (ctx && ctx.limits && ctx.limits.maxActiveBanners != null && ctx.limits.activeBanners != null && cc.total > 0) {
      var over = ctx.limits.activeBanners + cc.total > ctx.limits.maxActiveBanners;
      warn.hidden = !over;
      warn.textContent = "Лимит активных объявлений может быть превышен — VK может отклонить часть созданий.";
    } else if (warn) warn.hidden = true;
    updateSummary();
  }

  // ---------- списки текстов (A/B-тесты) ----------
  function pluralField(n, one, few, many) {
    var a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  }
  function variantsActive() { return titleVariants.length > 0 || textVariants.length > 0; }
  function comboCounts() {
    var ready = readyPhotos().length;
    var t = titleVariants.length, x = textVariants.length;
    return { photos: ready, titles: t, texts: x, total: ready * (t || 1) * (x || 1) };
  }

  function loadSheetJS(cb) {
    if (window.XLSX) return cb(true);
    var s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
    s.onload = function () { cb(true); };
    s.onerror = function () { cb(false); };
    document.head.appendChild(s);
  }

  /** строки таблицы → списки заголовков/текстов (заголовочная строка опознаётся по словам) */
  function listsFromRows(rows) {
    rows = (rows || [])
      .map(function (r) { return (r || []).map(function (c) { return String(c == null ? "" : c).trim(); }); })
      .filter(function (r) { return r.join(""); });
    if (!rows.length) return { titles: [], texts: [] };
    var lower = rows[0].map(function (c) { return c.toLowerCase(); });
    var hTitle = lower.findIndex(function (c) { return /заголов|title/.test(c); });
    var hText = lower.findIndex(function (c) { return /текст|text/.test(c); });
    var hasHead = hTitle >= 0 || hText >= 0;
    var data = hasHead ? rows.slice(1) : rows;
    var cols = hasHead ? [hTitle, hText] : (rows[0].length > 1 ? [0, 1] : [-1, 0]);
    var titles = [], texts = [];
    data.forEach(function (r) {
      if (cols[0] >= 0 && r[cols[0]]) titles.push(r[cols[0]].slice(0, 40));
      if (cols[1] >= 0 && r[cols[1]]) texts.push(r[cols[1]].slice(0, 2000));
    });
    return { titles: titles, texts: texts };
  }

  function parseDelimited(text) {
    var lines = String(text || "").split(/\r?\n/).filter(function (l) { return l.trim(); });
    var first = lines[0] || "";
    var delim = first.indexOf("\t") >= 0 ? "\t" : first.indexOf(";") >= 0 ? ";" : first.indexOf(",") >= 0 ? "," : null;
    return listsFromRows(lines.map(function (l) { return delim ? l.split(delim) : [l]; }));
  }

  function applyBulkLists(titles, texts) {
    titleVariants = titles;
    textVariants = texts;
    renderBulkLists();
    updateCounter();
  }

  function bulkMsg(s, isErr) {
    var el = $("ads-bulk-msg");
    if (!el) return;
    el.textContent = s || "";
    el.className = s ? (isErr ? "ads-err-txt" : "ads-hint") : "ads-hint";
  }

  function renderBulkLists() {
    var box = $("ads-bulk-lists");
    if (!box) return;
    var html = "";
    if (titleVariants.length) {
      html += '<span class="ads-chip" title="' + esc(titleVariants.slice(0, 8).join(" · ")) + '">Заголовки: <b>' +
        titleVariants.length + "</b> " + esc(pluralField(titleVariants.length, "вариант", "варианта", "вариантов")) +
        ' <button type="button" class="ads-chip-x" data-clear="title" aria-label="Убрать заголовки">×</button></span>';
    }
    if (textVariants.length) {
      html += '<span class="ads-chip" title="' + esc(textVariants.slice(0, 5).map(function (t) { return t.slice(0, 60); }).join(" · ")) + '">Тексты: <b>' +
        textVariants.length + "</b> " + esc(pluralField(textVariants.length, "вариант", "варианта", "вариантов")) +
        ' <button type="button" class="ads-chip-x" data-clear="text" aria-label="Убрать тексты">×</button></span>';
    }
    if (!html) html = '<span class="ads-muted">списки пусты — все объявления пойдут с одинаковыми текстами</span>';
    box.innerHTML = html;
    box.querySelectorAll(".ads-chip-x").forEach(function (b) {
      b.onclick = function () {
        if (b.dataset.clear === "title") titleVariants = [];
        else textVariants = [];
        renderBulkLists(); updateCounter();
      };
    });
    var head = $("ads-texts-head");
    if (head) {
      head.textContent = variantsActive()
        ? "Тексты — списки вариантов (A/B-тест)"
        : "Тексты — одинаковые для всех объявлений";
    }
  }

  function bindBulk() {
    var file = $("ads-bulk-file");
    if (!file) return;
    file.addEventListener("change", function () {
      var f = this.files && this.files[0];
      this.value = "";
      if (!f) return;
      bulkMsg("Читаем " + f.name + "…");
      if (/\.(xlsx|xls)$/i.test(f.name)) {
        loadSheetJS(function (ok) {
          if (!ok) { bulkMsg("Не удалось загрузить парсер Excel (CDN недоступен?) — вставьте списки текстом или CSV", true); return; }
          var fr = new FileReader();
          fr.onload = function () {
            try {
              var wb = XLSX.read(fr.result, { type: "array" });
              var rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: "" });
              var lists = listsFromRows(rows);
              if (!lists.titles.length && !lists.texts.length) { bulkMsg("В файле не нашлось непустых строк", true); return; }
              applyBulkLists(lists.titles, lists.texts);
              bulkMsg("Из " + f.name + ": заголовков " + lists.titles.length + ", текстов " + lists.texts.length);
            } catch (e) { bulkMsg("Не удалось разобрать файл: " + (e.message || e), true); }
          };
          fr.readAsArrayBuffer(f);
        });
      } else {
        var fr = new FileReader();
        fr.onload = function () {
          try {
            var lists = parseDelimited(fr.result);
            if (!lists.titles.length && !lists.texts.length) { bulkMsg("В файле не нашлось непустых строк", true); return; }
            applyBulkLists(lists.titles, lists.texts);
            bulkMsg("Из " + f.name + ": заголовков " + lists.titles.length + ", текстов " + lists.texts.length);
          } catch (e) { bulkMsg("Не удалось разобрать файл: " + (e.message || e), true); }
        };
        fr.readAsText(f, "utf-8");
      }
    });
    $("ads-bulk-apply").addEventListener("click", function () {
      var titles = $("ads-bulk-titles").value.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
      var texts = $("ads-bulk-texts").value.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (!titles.length && !texts.length) { bulkMsg("Оба поля пусты — вставьте списки или загрузите файл", true); return; }
      applyBulkLists(titles, texts);
      bulkMsg("Применено: заголовков " + titles.length + ", текстов " + texts.length);
    });
    $("ads-bulk-clear").addEventListener("click", function () {
      applyBulkLists([], []);
      $("ads-bulk-titles").value = "";
      $("ads-bulk-texts").value = "";
      bulkMsg("Списки очищены — объявления пойдут с одинаковыми текстами");
    });
    renderBulkLists();
  }

  // ---------- автостоп: правила ----------
  function fmtTs(iso) {
    try {
      var d = new Date(iso);
      return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" }) + " " +
        d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    } catch (e) { return String(iso || ""); }
  }

  function loadRules() {
    if (mode !== "gh") return;
    fetch(GH_RAW + "ads-rules.json?t=" + Date.now()).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { rulesData = j && j.rules ? j : { updatedAt: null, rules: [] }; renderRules(); })
      .catch(function () { rulesData = { updatedAt: null, rules: [] }; renderRules(); });
    fetch(GH_RAW + "ads-rules-log.json?t=" + Date.now()).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { rulesLog = j || null; renderRulesLog(); })
      .catch(function () { rulesLog = null; renderRulesLog(); });
  }

  function ruleCabinetContext(extId) {
    return ghContext && ghContext.cabinets ? ghContext.cabinets[String(extId)] : null;
  }

  function fillRuleCabinets() {
    var sel = $("ads-rule-cabinet");
    if (!sel) return;
    var opts = '<option value="">Кабинет…</option>';
    var list = cabinets || [];
    list.forEach(function (c) {
      opts += '<option value="' + esc(c.value) + '">' + esc(c.name) + "</option>";
    });
    sel.innerHTML = opts;
  }

  function fillRuleGroups(extId) {
    var sel = $("ads-rule-group");
    if (!sel) return;
    var opts = '<option value="">Группа…</option>';
    var c = ruleCabinetContext(extId);
    if (c && c.groups) {
      c.groups.forEach(function (g) {
        opts += '<option value="' + g.id + '">' + esc(g.name) + "</option>";
      });
    }
    sel.innerHTML = opts;
  }

  function renderRules() {
    var badge = $("ads-rules-badge");
    var list = $("ads-rules-list");
    if (!badge || !list) return;
    var rules = (rulesData && rulesData.rules) || [];
    var active = rules.filter(function (r) { return r.enabled !== false; }).length;
    badge.textContent = active ? active + " " + pluralField(active, "правило", "правила", "правил") : "нет правил";
    if (!rules.length) {
      list.innerHTML = '<p class="ads-hint">Правил пока нет — добавьте первое ниже. Например: группа «Архангельск» → стоп при расходе &gt; 25 ₽ и цене клика &gt; 30 ₽.</p>';
      return;
    }
    var names = {};
    (cabinets || []).forEach(function (c) { names[String(c.value)] = c.name; });
    list.innerHTML =
      '<div class="table-wrap ads-res-table"><table class="grid-table"><thead><tr>' +
      "<th>Кабинет · группа</th><th>Пороги</th><th></th></tr></thead><tbody>" +
      rules.map(function (r, i) {
        var g = ruleCabinetContext(r.cabinet);
        var gname = "";
        if (g && g.groups) {
          var f = g.groups.filter(function (x) { return Number(x.id) === Number(r.group); })[0];
          if (f) gname = f.name;
        }
        var conds = [];
        if (r.maxSpend != null) conds.push("расход &gt; " + r.maxSpend + " ₽");
        if (r.maxCpc != null) conds.push("цена клика &gt; " + r.maxCpc + " ₽");
        return (
          "<tr><td>" + esc(names[String(r.cabinet)] || ("кабинет " + r.cabinet)) + " · <b>" + esc(gname || ("группа " + r.group)) + "</b>" +
          (r.enabled === false ? ' <span class="ads-muted">(выключено)</span>' : "") +
          "</td><td class='num'>" + (conds.length ? esc(conds.join(" и ")) : "—") + " · за " + (r.days || 30) + " дн.</td>" +
          '<td class="num"><button type="button" class="ads-chip-x" data-rule-toggle="' + i + '" aria-label="Включить/выключить">' + (r.enabled === false ? "▶" : "⏸") +
          '</button> <button type="button" class="ads-chip-x" data-rule-del="' + i + '" aria-label="Удалить">×</button></td></tr>'
        );
      }).join("") +
      "</tbody></table></div>";
    list.querySelectorAll("[data-rule-del]").forEach(function (b) {
      b.onclick = function () { saveRules(rules.filter(function (_, i2) { return i2 !== Number(b.dataset.ruleDel); }), "автостоп: правило удалено"); };
    });
    list.querySelectorAll("[data-rule-toggle]").forEach(function (b) {
      b.onclick = function () {
        var idx = Number(b.dataset.ruleToggle);
        var next = rules.slice();
        next[idx] = { ...next[idx], enabled: next[idx].enabled === false };
        saveRules(next, "автостоп: правило " + (next[idx].enabled ? "включено" : "выключено"));
      };
    });
  }

  function renderRulesLog() {
    var box = $("ads-rules-log");
    if (!box) return;
    var events = (rulesLog && rulesLog.events) || [];
    if (!events.length) {
      box.innerHTML = '<p class="ads-hint">Журнал пуст — срабатываний пока не было' +
        (rulesLog && rulesLog.lastReport ? " (последняя проверка: " + fmtTs(rulesLog.lastReport.ranAt) + ")" : "") + ".</p>";
      return;
    }
    box.innerHTML =
      '<div class="ads-rules-log-head">Последние остановки:</div><ul class="ads-rules-log-list">' +
      events.slice(0, 8).map(function (e) {
        return "<li><span class='ads-muted'>" + fmtTs(e.ts) + "</span> · <b>" + esc(e.name) + "</b> (#" + e.bannerId + ") — " + esc(e.reason) + "</li>";
      }).join("") +
      "</ul>";
  }

  function ruleMsg(s, isErr) {
    var el = $("ads-rule-msg");
    if (!el) return;
    el.textContent = s || "";
    el.className = s ? (isErr ? "ads-err-txt" : "ads-hint") : "ads-hint";
    var box = $("ads-rule-err");
    if (box) { box.hidden = !isErr; if (isErr) box.textContent = s; }
  }

  /** Сохранить правила в репозиторий (Contents API, с sha) и перечитать.
   *  При 409 (файл изменился между чтением и записью — чужой клик, гонка,
   *  автостоп-коммит) — автоматически до 2 повторов со свежим sha. */
  function saveRules(rules, message) {
    if (!ghToken) { ruleMsg("Нужен токен GitHub — форма выше", true); return; }
    ruleMsg("Сохраняем…");
    var doc = { updatedAt: new Date().toISOString(), rules: rules };
    var content = JSON.stringify(doc);
    var done = function () {
      rulesData = doc;
      renderRules();
      ruleMsg("Сохранено. Проверка запустится автоматически (~1 мин).");
      setTimeout(loadRules, 65000);
    };
    var attempt = function (n) {
      ghGetFile("ads-rules.json").then(function (cur) {
        return ghPut("ads-rules.json", message, content, cur ? cur.sha : null);
      }).then(done).catch(function (e) {
        if (n < 2 && /409/.test(String(e && e.message || e))) {
          ruleMsg("Файл правил изменился — повторяем со свежей версией…");
          setTimeout(function () { attempt(n + 1); }, 1500);
          return;
        }
        ruleMsg(e.message || String(e), true);
      });
    };
    attempt(0);
  }

  function bindRules() {
    var form = $("ads-rule-form");
    if (!form) return;
    fillRuleCabinets();
    $("ads-rule-cabinet").addEventListener("change", function () {
      fillRuleGroups(this.value || null);
    });
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var cab = $("ads-rule-cabinet").value;
      var grp = $("ads-rule-group").value;
      var spend = parseFloat($("ads-rule-spend").value);
      var cpc = parseFloat($("ads-rule-cpc").value);
      var days = parseInt($("ads-rule-days").value, 10) || 30;
      if (!cab || !grp) { ruleMsg("выберите кабинет и группу", true); return; }
      if (!spend && !cpc) { ruleMsg("укажите хотя бы один порог — расход и/или цену клика", true); return; }
      var rules = ((rulesData && rulesData.rules) || []).slice();
      rules.push({
        id: "r_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        cabinet: Number(cab), group: Number(grp),
        maxSpend: spend > 0 ? spend : null,
        maxCpc: cpc > 0 ? cpc : null,
        days: days, enabled: true,
        createdAt: new Date().toISOString(),
      });
      saveRules(rules, "автостоп: + правило (группа " + grp + ")");
    });
    $("ads-rules-refresh").addEventListener("click", loadRules);
    $("ads-rule-check").addEventListener("click", function () {
      if (!ghToken) { ruleMsg("Нужен токен GitHub — форма выше", true); return; }
      ruleMsg("Запускаем проверку на GitHub…");
      fetch(GH_API + "dispatches", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + ghToken,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ event_type: "autostop-check" }),
      }).then(function (r) {
        if (r.status === 204) {
          ruleMsg("Проверка запущена — журнал обновится через ~1–2 мин.");
          setTimeout(loadRules, 90000);
        } else {
          ruleMsg("GitHub HTTP " + r.status + " — не удалось запустить проверку", true);
        }
      }).catch(function (e) { ruleMsg(e.message || String(e), true); });
    });
    loadRules();
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
  function variantsValid() {
    for (var i = 0; i < titleVariants.length; i++) if (!titleVariants[i]) return false;
    for (var j = 0; j < textVariants.length; j++) if (!textVariants[j]) return false;
    return true;
  }

  function updateSummary() {
    var sum = $("ads-summary"), btn = $("ads-create"), hint = $("ads-create-hint");
    if (!sum) return;
    var cc = comboCounts();
    var g = ctx && ctx.groups ? ctx.groups.filter(function (x) { return x.id === groupId; })[0] : null;
    if (variantsActive()) {
      sum.innerHTML =
        "Будет создано: <b>" + cc.total + " " + pluralAds(cc.total) + "</b>" +
        (cc.total === 0
          ? " — загрузите фото выше"
          : " — каждое фото" +
            (cc.titles ? " × каждый заголовок (" + cc.titles + ")" : "") +
            (cc.texts ? " × каждый текст (" + cc.texts + ")" : "") +
            ", в группе «" + esc(g ? g.name : "") + "»");
    } else {
      sum.innerHTML =
        "Будет создано: <b>" + cc.total + " " + pluralAds(cc.total) + "</b>" +
        (cc.total === 0
          ? " — загрузите фото выше"
          : " — по одному на каждое фото, с одинаковыми текстами" + (g ? ", в группе «" + esc(g.name) + "»" : ""));
    }
    var t = textsValid();
    var ok = !!groupId && cc.total > 0 && variantsValid() &&
      (variantsActive() || (t.title && t.body)) &&
      t.cta && t.about &&
      $("ads-icon").value && $("ads-url").value;
    // общие поля (CTA, реквизиты, иконка, ссылка) нужны всегда; заголовок/текст —
    // либо общие, либо списком; в режиме панели списки пока не поддерживаются
    if (ok && mode === "panel" && variantsActive()) ok = false;
    btn.disabled = !ok || creating;
    btn.textContent = creating ? "Создаём…" : "Создать " + cc.total + " " + pluralAds(cc.total);
    if (!ok && !creating) {
      hint.textContent = !groupId
        ? "выберите группу объявлений"
        : cc.total === 0
          ? "загрузите хотя бы одно фото"
          : mode === "panel" && variantsActive()
            ? "списки текстов сейчас работают в режиме GitHub Actions (панель — в планах)"
            : !variantsValid()
              ? "в списках есть пустые строки"
              : !t.cta || !t.about
                ? "заполните CTA и реквизиты"
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
    var cc = comboCounts();
    var titles = titleVariants.length ? titleVariants : [t.title];
    var bodies = textVariants.length ? textVariants : [t.body];
    var g = ctx.groups.filter(function (x) { return x.id === groupId; })[0];
    var cab = cabinets.filter(function (c) { return String(c.value) === String(cabinetId); })[0];
    var label = (cab ? cab.name : "кабинет") + " → " + (g ? g.name : "");
    var comboNote = variantsActive()
      ? "\nКомбинации: " + cc.photos + " фото" +
        (cc.titles ? " × " + cc.titles + " заголовков" : "") +
        (cc.texts ? " × " + cc.texts + " текстов" : "") + " = " + cc.total + " объявлений — каждое со своим текстом."
      : "\nВсе — с одинаковыми текстами.";
    if (!window.confirm(
      "Создать " + cc.total + " " + pluralAds(cc.total) + " в группе «" + (g ? g.name : "") + "» (" + label + ")?" +
      comboNote + " Сразу уйдут на модерацию VK." +
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
      var items = [];
      ready.forEach(function (p) {
        titles.forEach(function (tv, ti) {
          bodies.forEach(function (bv, bi) {
            var multi = titles.length > 1 || bodies.length > 1;
            var suffix = "";
            if (multi) {
              if (titles.length > 1) suffix += " з" + (ti + 1);
              if (bodies.length > 1) suffix += (suffix ? "-" : " ") + "т" + (bi + 1);
            }
            items.push({
              name: (p.name + (suffix ? " ·" + suffix.replace(" ", "") : "")).slice(0, 100),
              slot: p.slot.slot,
              photo: p.photo,
              texts: { title: tv, body: bv },
            });
          });
        });
      });
      var job = {
        id: jobId,
        type: "create",
        cabinet: Number(cabinetId),
        group: Number(groupId),
        iconId: Number($("ads-icon").value),
        urlId: Number($("ads-url").value),
        texts: t, // общий вариант (fallback) + CTA/реквизиты
        items: items,
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
    if (mode === "gh" && booted) { loadRules(); fillRuleCabinets(); }
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
      var open = $("ads-wrap").hidden;
      $("ads-wrap").hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.textContent = open ? "Свернуть" : "Создать объявления";
      if (open && !mode) boot();
    });
    $("ads-refresh").addEventListener("click", function () {
      if (!$("ads-wrap").hidden) boot();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
