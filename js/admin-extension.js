/* ============================================================
   REAL ADMIN EXTENSION — Supabase bilan haqiqiy ishlashi
   ============================================================ */
(function () {

  const EXAM_CARD_CONFIG = [
    { id: 'attanal_full', title: "At-Tanal bo'limi (Imtihon sahifasi)" },
    { id: 'attanal_full_exam', title: "To'liq At-Tanal imtihoni (Simulyatsiya)" },
    { id: 'cefr_mock', title: "CEFR Daraja testi (Mock imtihon)" }
  ];

  const DEFAULT_GRAMMAR_ORDER = ['nahv', 'sarf', 'imlo', 'xatolar'];

  let APP_CONFIG = {
    exam_cards: {},
    grammar_order: []
  };

  let USER_MESSAGES = [];
  let pollTimer = null;

  /* ---------- helpers ---------- */

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function localGet(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function localSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {}
  }

  async function rpc(name, body) {
    const res = await fetch(SUPABASE_URL + '/rest/v1/rpc/' + name, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body || {})
    });

    const text = await res.text();

    if (!res.ok) {
      throw new Error(text || ('HTTP ' + res.status));
    }

    return text ? JSON.parse(text) : null;
  }

  /* ---------- CSS inject ---------- */

  function injectAssets() {
    if (document.getElementById('realAdminExtensionStyle')) return;

    const style = document.createElement('style');
    style.id = 'realAdminExtensionStyle';
    style.textContent = `
      [hidden]{display:none!important;}

      .admin-ext-row{
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:12px;
        padding:12px 0;
        border-bottom:1px solid var(--border);
        flex-wrap:wrap;
      }

      .admin-ext-toggles{
        display:flex;
        gap:14px;
        align-items:center;
        flex-wrap:wrap;
      }

      .admin-ext-toggles label{
        display:flex;
        align-items:center;
        gap:6px;
        font-size:12.5px;
        font-weight:600;
        cursor:pointer;
        color:var(--text-dim);
      }

      .admin-ext-toggles input{
        width:16px;
        height:16px;
        accent-color:var(--indigo-700);
        cursor:pointer;
      }

      .grammar-sortable{
        list-style:none;
        padding:0;
        margin:0;
        display:flex;
        flex-direction:column;
        gap:10px;
      }

      .grammar-sortable li{
        padding:14px 16px;
        border:1px solid var(--border);
        border-radius:14px;
        cursor:grab;
        user-select:none;
        display:flex;
        align-items:center;
        gap:12px;
        font-weight:600;
        font-size:13.5px;
        background:var(--card);
      }

      .grammar-sortable li.dragging{
        opacity:.5;
      }

      .exam-card.is-locked, .card[data-card-id].is-locked, #attanalFullExamCard.is-locked{
        opacity:1;
        pointer-events:none;
        position:relative;
        overflow:hidden;
      }

      /* Frosted blur qatlami — kartaning butun eni/bo'yiga to'liq mos (width/height/border-radius
         .exam-card::after'dan meros bo'lib qolmasligi uchun aniq qayta belgilanadi), overlay ostidagi
         karta rangi/kontenti blur bo'lib ko'rinadi. .exam-card'dagi overflow:hidden burchaklarni kesadi. */
      .exam-card.is-locked::after, .card[data-card-id].is-locked::after, #attanalFullExamCard.is-locked::after{
        content:'';
        position:absolute;
        inset:0;
        width:100%;
        height:100%;
        border-radius:inherit;
        background:rgba(20,20,30,.38);
        backdrop-filter:blur(6px);
        -webkit-backdrop-filter:blur(6px);
        pointer-events:auto;
        cursor:not-allowed;
        z-index:10;
      }

      /* Kattaroq qulf ikonkasi (SVG, emoji emas) — inline SVG data-URI orqali ::before'ga chizilgan */
      .exam-card.is-locked::before, .card[data-card-id].is-locked::before, #attanalFullExamCard.is-locked::before{
        content:'';
        position:absolute;
        inset:0;
        margin:auto;
        width:40px;
        height:40px;
        background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='11' width='18' height='11' rx='2'/%3E%3Cpath d='M7 11V7a5 5 0 0 1 10 0v4'/%3E%3C/svg%3E");
        background-repeat:no-repeat;
        background-position:center;
        background-size:contain;
        filter:drop-shadow(0 2px 6px rgba(0,0,0,.35));
        pointer-events:none;
        z-index:11;
      }

      /* Grammatika kategoriya cardlari uchun ham xuddi shu qulf uslubi (.exam-card.is-locked
         bilan bir xil mantiq) — .grammar-cat-wrap allaqachon border-radius:22px va
         overflow:hidden ega, shuning uchun overlay to'g'ridan-to'g'ri shu elementga tushadi. */
      .grammar-cat-wrap.is-locked{
        opacity:1;
        pointer-events:none;
        position:relative;
      }

      .grammar-cat-wrap.is-locked::after{
        content:'';
        position:absolute;
        inset:0;
        width:100%;
        height:100%;
        border-radius:22px;
        background:rgba(20,20,30,.38);
        backdrop-filter:blur(6px);
        -webkit-backdrop-filter:blur(6px);
        pointer-events:auto;
        cursor:not-allowed;
        z-index:10;
      }

      .grammar-cat-wrap.is-locked::before{
        content:'';
        position:absolute;
        inset:0;
        margin:auto;
        width:40px;
        height:40px;
        background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='11' width='18' height='11' rx='2'/%3E%3Cpath d='M7 11V7a5 5 0 0 1 10 0v4'/%3E%3C/svg%3E");
        background-repeat:no-repeat;
        background-position:center;
        background-size:contain;
        filter:drop-shadow(0 2px 6px rgba(0,0,0,.35));
        pointer-events:none;
        z-index:11;
      }

      /* Pastki menyu (bottom-nav) tugmalari uchun qulf holati — card'lardan farqli
         o'laroq bu kichik tugma, shuning uchun blur overlay o'rniga xiralashtirish +
         burchakda kichik qulf belgisi ishlatiladi. */
      .bn-btn.is-locked{
        opacity:.35;
        pointer-events:none;
        position:relative;
      }

      .bn-btn.is-locked::after{
        content:'🔒';
        position:absolute;
        top:2px;
        right:calc(50% - 26px);
        font-size:10px;
        line-height:1;
        pointer-events:none;
      }

      /* userMsgBell and dashUserMsgBell styles */
      #userMsgBell{
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      #userMsgBell svg{
        width: 20px;
        height: 20px;
      }

      .user-msg-badge,
      #userMsgBadge,
      #dashUserMsgBadge{
        position:absolute;
        top:-4px;
        right:-4px;
        min-width:18px;
        height:18px;
        border-radius:99px;
        background:#EF4444;
        color:#fff;
        font-size:10px;
        font-weight:700;
        display:none;
        align-items:center;
        justify-content:center;
        padding:0 4px;
        border:2px solid var(--card);
        line-height: 1;
        pointer-events: none;
      }

      #userMsgPanel{
        position:fixed;
        top:calc(64px + var(--app-safe-top, 0px));
        right:calc(16px + var(--app-safe-right, 0px));
        width:min(380px, calc(100vw - 32px));
        max-height:min(450px, calc(100vh - 120px - var(--app-safe-top, 0px)));
        overflow-y:auto;
        z-index:9999;
        border-radius:20px;
        border:1px solid var(--border);
        background:var(--card);
        box-shadow:0 20px 50px -12px rgba(0,0,0,.5);
        padding:20px;
      }

      .umsg-item{
        padding:14px;
        border:1px solid var(--border);
        border-radius:14px;
        margin-bottom:10px;
        background:var(--bg);
      }

      .umsg-item.unread{
        border-color:var(--indigo-500);
        background:var(--indigo-100);
      }

      .umsg-title{
        font-weight:600;
        font-size:13.5px;
        margin-bottom:4px;
      }

      .umsg-body{
        font-size:12.5px;
        color:var(--text-dim);
        line-height:1.5;
      }

      .umsg-time{
        font-size:11px;
        color:var(--text-faint);
        font-weight:600;
        margin-top:6px;
      }

      .sent-msg-item{
        padding:12px;
        border-bottom:1px solid var(--border);
      }
    `;

    document.head.appendChild(style);
  }

  /* ---------- HTML inject ---------- */

  function injectAdminExtensionHTML() {
    const tabs = document.getElementById('adminTabs');
    const reportsPane = document.getElementById('adminTab-reports');

    if (tabs && !document.getElementById('adminTab-examcards')) {
      tabs.insertAdjacentHTML('beforeend', `
        <button class="admin-tab" data-atab="examcards" onclick="openAdminPanelModal('examcards')">🎯 Imtihon cardlari</button>
        <button class="admin-tab" data-atab="gramorder" onclick="openAdminPanelModal('gramorder')">📚 Grammatika tartibi</button>
        <button class="admin-tab" data-atab="sendmsg" onclick="openAdminPanelModal('sendmsg')">✉️ Xabar yuborish</button>
      `);
    }

    if (reportsPane && !document.getElementById('adminTab-examcards')) {
      reportsPane.insertAdjacentHTML('afterend', `
        <div class="admin-panel-body" id="adminTab-examcards" style="display:none;">
          <p style="font-size:13px;color:var(--text-dim);font-weight:600;margin-bottom:16px;">
            Cardlarni yashirish/ko‘rsatish yoki qulflash/ochish barcha foydalanuvchilarga ta’sir qiladi.
          </p>
          <div class="card" style="padding:18px 20px;">
            <div id="examCardAdminList"></div>
          </div>
        </div>

        <div class="admin-panel-body" id="adminTab-gramorder" style="display:none;">
          <p style="font-size:13px;color:var(--text-dim);font-weight:600;margin-bottom:16px;">
            Grammatika bo‘limlarini ushlab sudrab tartibini o‘zgartiring. Tartib Supabase’da saqlanadi.
          </p>
          <div class="card" style="padding:18px 20px;">
            <ul id="grammarOrderList" class="grammar-sortable"></ul>
          </div>
        </div>

        <div class="admin-panel-body" id="adminTab-sendmsg" style="display:none;">
          <p style="font-size:13px;color:var(--text-dim);font-weight:600;margin-bottom:16px;">
            Foydalanuvchi Telegram ID yozing yoki <b>all</b> deb yozing — hammasiga yuboriladi.
          </p>

          <div class="card" style="padding:18px 20px;margin-bottom:16px;">
            <form id="adminMsgForm">
              <div class="form-field" style="margin-bottom:12px;">
                <label>Foydalanuvchi ID</label>
                <input type="text" id="msgUserId" placeholder="Masalan: 123456789 yoki all" required>
              </div>

              <div class="form-field" style="margin-bottom:12px;">
                <label>Sarlavha</label>
                <input type="text" id="msgTitle" placeholder="Xabar sarlavhasi" required>
              </div>

              <div class="form-field" style="margin-bottom:12px;">
                <label>Xabar matni</label>
                <textarea id="msgBody" placeholder="Xabar matni..." required></textarea>
              </div>

              <button type="submit" class="btn btn-primary">📨 Yuborish</button>
            </form>
          </div>

          <div class="card" style="padding:18px 20px;">
            <h4 style="font-size:13px;font-weight:600;margin-bottom:10px;">Yuborilgan xabarlar</h4>
            <div id="sentMessagesList"></div>
          </div>
        </div>
      `);
    }

    if (!document.getElementById('userMsgBell')) {
      const topbarRight = document.querySelector('.topbar-right');
      if (topbarRight) {
        topbarRight.insertAdjacentHTML('afterbegin', `
          <button class="theme-toggle" id="userMsgBell" hidden onclick="toggleUserMsgPanel()" title="Xabarlar" style="position:relative;font-size:16px;">
            🔔<span id="userMsgBadge">0</span>
          </button>
        `);
      }
    }
    if (!document.getElementById('userMsgPanel')) {
      document.body.insertAdjacentHTML('beforeend', `
        <div id="userMsgPanel" hidden>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
            <h4 style="font-size:14px;font-weight:600;">📨 Xabarlar</h4>
            <button onclick="toggleUserMsgPanel()" style="background:none;border:none;cursor:pointer;color:var(--text-faint);font-size:16px;">✕</button>
          </div>
          <div id="userMsgList"></div>
        </div>
      `);
    }
  }

  /* ---------- config load ---------- */

  async function loadAppConfig() {
    try {
      const cfg = await rpc('get_app_config');

      if (cfg) {
        APP_CONFIG = {
          exam_cards: cfg.exam_cards || {},
          grammar_order: cfg.grammar_order || [],
          community_cards: cfg.community_cards || [],
          history_purged_at: cfg.history_purged_at || null,
          content_version: cfg.content_version || null
        };

        localSet('arab_app_config_cache', APP_CONFIG);
        if (typeof syncContentVersionCheck === 'function' && cfg.content_version) {
          syncContentVersionCheck(cfg.content_version);
        }
        // Admin "hammasini tozalash"ni bosgan bo'lsa, shu qurilmadagi eski
        // lokal Tarix keshini (agar hali tozalanmagan bo'lsa) shu yerda tozalaymiz.
        try{ purgeLocalHistoryIfStale(); }catch(e){}
      }
    } catch (e) {
      console.warn('App config yuklanmadi, fallback ishlatiladi:', e);

      const cached = localGet('arab_app_config_cache', null);

      if (cached) {
        APP_CONFIG = cached;
        if (!APP_CONFIG.community_cards) APP_CONFIG.community_cards = [];
      } else {
        APP_CONFIG = {
          exam_cards: localGet('arab_ext_exam_cards', {}),
          grammar_order: localGet('arab_ext_grammar_order', DEFAULT_GRAMMAR_ORDER),
          community_cards: []
        };
      }
    }

    applyExamCardState();
    applyGrammarOrder();
    applyGrammarCardLockState();
    applyNavBtnLockState();
    renderCommunityView();
    if(document.getElementById('view-admin')?.classList.contains('active')) renderAdminQuestions();
  }

  function getCardState(cardId) {
    return APP_CONFIG.exam_cards[cardId] || {
      visible: true,
      locked: false
    };
  }

  /* ---------- chiroyli icon-tugmali qator (imtihon/nav/grammatika cardlari uchun) ----------
     Testlarni "Ko'rish / Tahrirlash / O'chirish" qatorlaridagi (.topic-row / .t-actions / .icon-btn)
     uslubiga mos: checkbox o'rniga ko'z (ko'rinish) va qulf (bloklash) ikonka-tugmalari. */
  const EX_ICON_EYE = (typeof IB_ICON_VIEW !== 'undefined') ? IB_ICON_VIEW : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/></svg>`;
  const EX_ICON_EYE_OFF = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>`;
  const EX_ICON_LOCK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
  const EX_ICON_UNLOCK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>`;

  function renderCardToggleRow(title, state, toggleFnName, idArg){
    const visIcon = state.visible ? EX_ICON_EYE : EX_ICON_EYE_OFF;
    const visClass = state.visible ? 'ib-view' : 'ib-menu';
    const visTitle = state.visible ? "Yashirish" : "Ko\u2018rsatish";
    const lockIcon = state.locked ? EX_ICON_LOCK : EX_ICON_UNLOCK;
    const lockClass = state.locked ? 'ib-del' : 'ib-menu';
    const lockTitle = state.locked ? "Qulfni ochish" : "Qulflash";
    return `
      <div class="topic-row exam-card-admin-row">
        <div>
          <div class="t-name">${title}</div>
          <div class="t-meta">${state.visible ? "Ko\u2018rinadi" : "Yashirilgan"} \u00b7 ${state.locked ? "Qulflangan" : "Ochiq"}</div>
        </div>
        <div class="t-actions">
          <button type="button" class="icon-btn ${visClass}" title="${visTitle}" onclick="${toggleFnName}('${idArg}', 'visible', ${!state.visible})">${visIcon}</button>
          <button type="button" class="icon-btn ${lockClass}" title="${lockTitle}" onclick="${toggleFnName}('${idArg}', 'locked', ${!state.locked})">${lockIcon}</button>
        </div>
      </div>
    `;
  }

  function normalizeGrammarOrder(order) {
    let result = Array.isArray(order)
      ? order.filter(id => DEFAULT_GRAMMAR_ORDER.includes(id))
      : [];

    DEFAULT_GRAMMAR_ORDER.forEach(id => {
      if (!result.includes(id)) {
        result.push(id);
      }
    });

    return result;
  }

  /* ---------- exam cards ---------- */

  function ensureExamCardIds() {
    EXAM_CARD_CONFIG.forEach(card => {
      if (document.querySelector('[data-card-id="' + card.id + '"]')) return;

      if (card.id === 'attanal_full_exam') {
        const fullCard = document.getElementById('attanalFullExamCard');
        if (fullCard) fullCard.setAttribute('data-card-id', card.id);
        return;
      }

      const searchText = card.id === 'attanal_full'
        ? 'التنال العربي'
        : 'CEFR';

      const cards = document.querySelectorAll('.exam-card');

      for (const el of cards) {
        if (el.textContent.includes(searchText)) {
          el.setAttribute('data-card-id', card.id);
          break;
        }
      }
    });
  }

  function applyExamCardState() {
    ensureExamCardIds();

    EXAM_CARD_CONFIG.forEach(card => {
      const el = document.querySelector('[data-card-id="' + card.id + '"]');
      if (!el) return;

      const state = getCardState(card.id);

      el.hidden = !state.visible;
      el.style.display = state.visible ? '' : 'none';
      el.classList.toggle('is-locked', state.locked);
    });
  }

  async function saveExamCard(cardId) {
    const state = getCardState(cardId);

    try {
      await rpc('admin_set_exam_card', {
        p_card_id: cardId,
        p_visible: state.visible,
        p_locked: state.locked
      });

      localSet('arab_app_config_cache', APP_CONFIG);
      toast('✅ Saqlandi');
    } catch (e) {
      console.error(e);
      toast('❌ Saqlanmadi: ' + (e.message || 'Admin huquqi yoki Supabase xatosi').slice(0, 180), 5000);
    }
  }

  window.toggleExamCard = async function (cardId, field, value) {
    if (!APP_CONFIG.exam_cards[cardId]) {
      APP_CONFIG.exam_cards[cardId] = {
        visible: true,
        locked: false
      };
    }

    APP_CONFIG.exam_cards[cardId][field] = value;

    renderExamCardAdmin();
    applyExamCardState();

    await saveExamCard(cardId);
  };

  function renderExamCardAdmin() {
    const list = document.getElementById('examCardAdminList');
    if (!list) return;

    list.innerHTML = EXAM_CARD_CONFIG.map(card => {
      const state = getCardState(card.id);
      return renderCardToggleRow(card.title, state, 'toggleExamCard', card.id);
    }).join('');
  }

  // Qulflangan cardga bosishni bloklash (imtihon cardlari + grammatika kategoriya
  // cardlari + pastki menyu tugmalari)
  document.addEventListener('click', function (e) {
    const card = e.target.closest('[data-card-id]');
    const gramWrap = !card ? e.target.closest('.grammar-cat-wrap[data-cat]') : null;
    const navBtn = (!card && !gramWrap) ? e.target.closest('.bn-btn[data-view]') : null;

    if (!card && !gramWrap && !navBtn) return;

    let cardId;
    if (card) cardId = card.dataset.cardId;
    else if (gramWrap) cardId = grammarCardId(gramWrap.dataset.cat);
    else cardId = navBtnCardId(navBtn.dataset.view);

    const state = getCardState(cardId);

    if (state && state.locked) {
      e.preventDefault();
      e.stopImmediatePropagation();
      toast('🔒 Bu bo‘lim hozircha qulflangan');
    } else if (state && state.visible === false) {
      e.preventDefault();
      e.stopImmediatePropagation();
      toast("Bu bo'lim vaqtincha mavjud emas");
    }
  }, true);

  /* ---------- bottom-nav (pastki menyu) tugmalari (lock/hide) ---------- */

  const NAV_BTN_CONFIG = [
    { id: 'dashboard', title: 'Asosiy' },
    { id: 'imtihon', title: 'Imtihon' },
    { id: 'grammar', title: 'Testlar (Grammatika)' },
    { id: 'rank', title: 'Reyting' },
    { id: 'profil', title: 'Profil' }
  ];

  function navBtnCardId(viewId) {
    return 'navbtn_' + viewId;
  }

  function applyNavBtnLockState() {
    NAV_BTN_CONFIG.forEach(btn => {
      const el = document.querySelector('.bn-btn[data-view="' + btn.id + '"]');
      if (!el) return;

      const state = getCardState(navBtnCardId(btn.id));

      el.hidden = !state.visible;
      el.classList.toggle('is-locked', !!state.locked);
    });
  }
  window.applyNavBtnLockState = applyNavBtnLockState;

  window.toggleNavBtnCard = async function (viewId, field, value) {
    const cardId = navBtnCardId(viewId);

    if (!APP_CONFIG.exam_cards[cardId]) {
      APP_CONFIG.exam_cards[cardId] = {
        visible: true,
        locked: false
      };
    }

    APP_CONFIG.exam_cards[cardId][field] = value;

    renderNavBtnAdmin();
    applyNavBtnLockState();

    await saveExamCard(cardId);
  };

  function renderNavBtnAdmin() {
    const list = document.getElementById('navBtnAdminList');
    if (!list) return;

    list.innerHTML = NAV_BTN_CONFIG.map(btn => {
      const state = getCardState(navBtnCardId(btn.id));
      return renderCardToggleRow(btn.title, state, 'toggleNavBtnCard', btn.id);
    }).join('');
  }

  /* ---------- grammar category cards (lock/hide) ---------- */

  function grammarCardId(catId) {
    return 'grammar_' + catId;
  }

  function grammarCardConfigList() {
    const cats = (typeof GRAMMAR_CATEGORIES !== 'undefined') ? GRAMMAR_CATEGORIES : [];
    return cats.map(c => ({ id: grammarCardId(c.id), catId: c.id, title: c.name + ' (' + c.ar + ')' }));
  }

  function applyGrammarCardLockState() {
    const cats = (typeof GRAMMAR_CATEGORIES !== 'undefined') ? GRAMMAR_CATEGORIES : [];

    cats.forEach(cat => {
      const el = document.querySelector('.grammar-cat-wrap[data-cat="' + cat.id + '"]');
      if (!el) return;

      const state = getCardState(grammarCardId(cat.id));

      el.hidden = !state.visible;
      el.classList.toggle('is-locked', !!state.locked);
    });
  }
  window.applyGrammarCardLockState = applyGrammarCardLockState;

  window.toggleGrammarCard = async function (catId, field, value) {
    const cardId = grammarCardId(catId);

    if (!APP_CONFIG.exam_cards[cardId]) {
      APP_CONFIG.exam_cards[cardId] = {
        visible: true,
        locked: false
      };
    }

    APP_CONFIG.exam_cards[cardId][field] = value;

    renderGrammarLockAdmin();
    applyGrammarCardLockState();

    await saveExamCard(cardId);
  };

  function renderGrammarLockAdmin() {
    const list = document.getElementById('grammarLockAdminList');
    if (!list) return;

    const cards = grammarCardConfigList();

    list.innerHTML = cards.map(card => {
      const state = getCardState(card.id);
      return renderCardToggleRow(card.title, state, 'toggleGrammarCard', card.catId);
    }).join('');
  }
  /* ---------- grammar order ---------- */

  function applyGrammarOrder() {
    const container = document.getElementById('grammarCatGrid');
    if (!container) return;

    const order = normalizeGrammarOrder(APP_CONFIG.grammar_order);

    const items = Array.from(container.querySelectorAll('.grammar-cat-wrap[data-cat]'));

    items.sort((a, b) => {
      return order.indexOf(a.dataset.cat) - order.indexOf(b.dataset.cat);
    });

    items.forEach(item => container.appendChild(item));
  }

  function renderGrammarOrderAdmin() {
    const ul = document.getElementById('grammarOrderList');
    if (!ul) return;

    const order = normalizeGrammarOrder(APP_CONFIG.grammar_order);

    ul.innerHTML = order.map(id => {
      const cat = (typeof GRAMMAR_CATEGORIES !== 'undefined')
        ? GRAMMAR_CATEGORIES.find(c => c.id === id)
        : null;

      if (!cat) return '';

      return `
        <li draggable="true" data-cat-id="${cat.id}">
          <span style="color:var(--text-faint);cursor:grab;">⠿</span>
          <span style="flex:1;">${cat.name} <span style="color:var(--text-faint);font-size:11px;">(${cat.ar})</span></span>
        </li>
      `;
    }).join('');

    initGrammarDragDrop(ul);
  }

  function initGrammarDragDrop(ul) {
    let dragEl = null;

    ul.querySelectorAll('li').forEach(li => {
      li.addEventListener('dragstart', function (e) {
        dragEl = this;
        this.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', '');
      });

      li.addEventListener('dragend', function () {
        this.classList.remove('dragging');
        dragEl = null;
        saveGrammarOrderFromDOM(ul);
      });
    });

    ul.addEventListener('dragover', function (e) {
      e.preventDefault();

      if (!dragEl) return;

      const afterElement = getDragAfterElement(ul, e.clientY);

      if (afterElement === null) {
        ul.appendChild(dragEl);
      } else {
        ul.insertBefore(dragEl, afterElement);
      }
    });

    ul.addEventListener('drop', function (e) {
      e.preventDefault();
    });
  }

  function getDragAfterElement(container, y) {
    const items = Array.from(container.querySelectorAll('li:not(.dragging)'));

    return items.reduce((closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;

      if (offset < 0 && offset > closest.offset) {
        return {
          offset: offset,
          element: child
        };
      }

      return closest;
    }, {
      offset: Number.NEGATIVE_INFINITY,
      element: null
    }).element;
  }

  async function saveGrammarOrderFromDOM(ul) {
    const order = Array.from(ul.querySelectorAll('li')).map(li => li.dataset.catId);

    APP_CONFIG.grammar_order = order;

    applyGrammarOrder();
    localSet('arab_app_config_cache', APP_CONFIG);

    try {
      await rpc('admin_set_grammar_order', {
        p_order: order
      });

      toast('✅ Grammatika tartibi saqlandi');
    } catch (e) {
      console.error(e);
      toast('❌ Tartib saqlanmadi: ' + (e.message || 'Admin huquqi yoki Supabase xatosi').slice(0, 180), 5000);
    }
  }

  /* ---------- messages ---------- */

  async function refreshUserMessages() {
    if (!SESSION_TOKEN) {
      USER_MESSAGES = [];
      renderUserMsgBell();
      return;
    }

    try {
      USER_MESSAGES = await rpc('get_my_messages') || [];
    } catch (e) {
      console.warn('Xabarlar yuklanmadi:', e);
      USER_MESSAGES = [];
    }

    renderUserMsgBell();

    const panel = document.getElementById('userMsgPanel');

    if (panel && !panel.hidden) {
      renderUserMsgPanel();
    }
  }

  function renderUserMsgBell() {
    const unread = USER_MESSAGES.filter(m => !m.read).length;

    const badges = [
      document.getElementById('userMsgBadge'),
      document.getElementById('dashUserMsgBadge')
    ].filter(Boolean);

    badges.forEach(b => {
      b.textContent = String(unread);
      b.style.display = unread > 0 ? 'flex' : 'none';
    });

    const bell = document.getElementById('userMsgBell');
    if (bell) {
      bell.hidden = false;
    }
  }

  function renderUserMsgPanel() {
    const list = document.getElementById('userMsgList');
    if (!list) return;

    if (!USER_MESSAGES.length) {
      list.innerHTML = '<p style="text-align:center;color:var(--text-faint);padding:20px;">Xabar yo‘q</p>';
      return;
    }

    list.innerHTML = USER_MESSAGES.map(m => `
      <div class="umsg-item ${m.read ? '' : 'unread'}">
        <div class="umsg-title">${escapeHtml(m.title)}</div>
        <div class="umsg-body">${escapeHtml(m.body)}</div>
        <div class="umsg-time">${new Date(m.created_at).toLocaleString('uz-UZ')}</div>
      </div>
    `).join('');
  }

  window.toggleUserMsgPanel = async function () {
    const panel = document.getElementById('userMsgPanel');
    if (!panel) return;

    const willOpen = panel.hidden;

    panel.hidden = !willOpen;

    if (willOpen) {
      renderUserMsgPanel();

      try {
        await rpc('mark_my_messages_read');
        await refreshUserMessages();
      } catch (e) {
        console.warn('O‘qilgan deb belgilanmadi:', e);
      }
    }
  };

  async function sendAdminMessage(e) {
    e.preventDefault();

    const userId = document.getElementById('msgUserId').value.trim();
    const title = document.getElementById('msgTitle').value.trim();
    const body = document.getElementById('msgBody').value.trim();

    if (!userId || !title || !body) {
      toast('⚠️ Barcha maydonlarni to‘ldiring');
      return false;
    }

    try {
      await rpc('admin_send_message', {
        p_user_id: userId,
        p_title: title,
        p_body: body
      });

      toast('✅ Xabar yuborildi');

      document.getElementById('adminMsgForm').reset();

      renderSentMessages();
      refreshUserMessages();
    } catch (e) {
      console.error(e);
      toast('❌ Xabar yuborilmadi: ' + (e.message || 'Admin huquqi yoki Supabase xatosi').slice(0, 180), 5000);
    }

    return false;
  }

  async function renderSentMessages() {
    const list = document.getElementById('sentMessagesList');
    if (!list) return;

    const isAdminUser =
      window.IS_CURRENT_USER_ADMIN === true ||
      (typeof ADMIN_TELEGRAM_IDS !== 'undefined' &&
      typeof TELEGRAM_PROFILE !== 'undefined' &&
      TELEGRAM_PROFILE &&
      ADMIN_TELEGRAM_IDS.includes(TELEGRAM_PROFILE.rawId));

    if (!isAdminUser) {
      list.innerHTML = '<p style="color:var(--text-faint);font-size:13px;">Faqat admin ko‘ra oladi.</p>';
      return;
    }

    try {
      const res = await fetch(
        SUPABASE_URL + '/rest/v1/admin_messages?select=*&order=created_at.desc&limit=20',
        { headers: authHeaders() }
      );

      const msgs = res.ok ? await res.json() : [];

      if (!msgs.length) {
        list.innerHTML = '<p style="color:var(--text-faint);font-size:13px;">Hali xabar yuborilmagan.</p>';
        return;
      }

      list.innerHTML = msgs.map(m => `
        <div class="sent-msg-item">
          <div style="font-weight:600;font-size:13px;">${escapeHtml(m.title)}</div>
          <div style="font-size:12px;color:var(--text-dim);margin-top:2px;">${escapeHtml(m.body)}</div>
          <div style="font-size:11px;color:var(--text-faint);margin-top:4px;">
            👤 ${escapeHtml(m.user_id)} · ${new Date(m.created_at).toLocaleString('uz-UZ')}
          </div>
        </div>
      `).join('');
    } catch (e) {
      console.error(e);
      list.innerHTML = '<p style="color:var(--text-faint);font-size:13px;">Xabarlar yuklanmadi.</p>';
    }
  }

  /* ---------- adminlar ro'yxati (qo'shish / yoqish-o'chirish / olib tashlash) ---------- */

  let ADMINS_LIST = [];

  async function renderAdminAdminsList() {
    const wrap = document.getElementById('adminAdminsList');
    if (!wrap) return;

    if (!window.IS_SUPER_ADMIN) {
      wrap.innerHTML = '<p style="color:var(--text-faint);font-size:13px;">Bu bo\u2018lim faqat bosh administratorlar uchun.</p>';
      return;
    }

    wrap.innerHTML = '<p style="color:var(--text-faint);font-size:13px;">Yuklanmoqda...</p>';

    try {
      const rows = await rpc('admin_list_admins');
      ADMINS_LIST = Array.isArray(rows) ? rows : [];
    } catch (e) {
      console.error(e);
      wrap.innerHTML = `<p style="color:var(--red);font-size:13px;">Adminlar ro'yxati yuklanmadi: ${escapeHtml((e.message || 'Supabase xatosi').slice(0, 180))}</p>`;
      return;
    }

    if (ADMINS_LIST.length === 0) {
      wrap.innerHTML = '<p style="color:var(--text-faint);font-size:13px;">Hali birorta admin topilmadi.</p>';
      return;
    }

    const myId = String((typeof TELEGRAM_PROFILE !== 'undefined' && TELEGRAM_PROFILE) ? TELEGRAM_PROFILE.rawId : '');

    wrap.innerHTML = ADMINS_LIST.map(a => {
      const isMe = myId && String(a.telegram_id) === myId;
      const isActive = a.is_active !== false;
      return `
      <div class="report-item">
        <div class="report-head">
          <span style="font-weight:600;font-size:13.5px;">${escapeHtml(a.nickname || 'Noma\u2019lum')}${isMe ? ' <span style="color:var(--indigo-500);font-weight:600;">(Siz)</span>' : ''}</span>
          <span class="report-meta">ID: ${escapeHtml(String(a.telegram_id))}</span>
        </div>
        <div class="report-tags">
          <span class="report-tag">@${escapeHtml(a.username || '\u2014')}</span>
          <span class="report-tag" style="${isActive ? '' : 'background:var(--red-bg);color:var(--red);'}">${isActive ? 'Faol' : 'O\u2018chirilgan'}</span>
        </div>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
          <button class="btn btn-outline" style="padding:8px 14px;font-size:12px;" onclick="toggleAdminActive('${escapeHtml(String(a.telegram_id))}', ${isActive})">${isActive ? 'Vaqtincha o\u2018chirish' : 'Qayta yoqish'}</button>
          <button class="btn btn-outline" style="padding:8px 14px;font-size:12px;border-color:var(--red);color:var(--red);" ${isMe ? 'disabled title="O\u2018zingizni olib tashlay olmaysiz"' : ''} onclick="removeAdmin('${escapeHtml(String(a.telegram_id))}')">Adminlikdan olib tashlash</button>
        </div>
      </div>`;
    }).join('');
  }

  window.addNewAdmin = async function () {
    if (!window.IS_SUPER_ADMIN) {
      toast('Ruxsat yo\u2018q: bu amal faqat bosh administratorlar uchun');
      return;
    }
    const input = document.getElementById('newAdminId');
    const raw = (input?.value || '').trim();
    if (!/^\d+$/.test(raw)) {
      toast('Telegram ID faqat raqamlardan iborat bo\u2018lishi kerak');
      return;
    }
    try {
      await rpc('admin_add_admin', { p_telegram_id: Number(raw) });
      if (input) input.value = '';
      toast('\u2705 Yangi admin qo\u2018shildi');
      renderAdminAdminsList();
    } catch (e) {
      console.error(e);
      toast('\u274c Qo\u2018shilmadi: ' + (e.message || 'Supabase xatosi').slice(0, 180), 5000);
    }
  };

  window.toggleAdminActive = async function (telegramId, currentlyActive) {
    if (!window.IS_SUPER_ADMIN) {
      toast('Ruxsat yo\u2018q: bu amal faqat bosh administratorlar uchun');
      return;
    }
    try {
      await rpc('admin_set_admin_active', { p_telegram_id: Number(telegramId), p_active: !currentlyActive });
      toast(currentlyActive ? '\u2705 Admin vaqtincha o\u2018chirildi' : '\u2705 Admin qayta yoqildi');
      renderAdminAdminsList();
    } catch (e) {
      console.error(e);
      toast('\u274c Amalga oshmadi: ' + (e.message || 'Supabase xatosi').slice(0, 180), 5000);
    }
  };

  window.removeAdmin = async function (telegramId) {
    if (!window.IS_SUPER_ADMIN) {
      toast('Ruxsat yo\u2018q: bu amal faqat bosh administratorlar uchun');
      return;
    }
    const myId = String((typeof TELEGRAM_PROFILE !== 'undefined' && TELEGRAM_PROFILE) ? TELEGRAM_PROFILE.rawId : '');
    if (myId && String(telegramId) === myId) {
      toast('O\u2018zingizni adminlikdan olib tashlay olmaysiz');
      return;
    }
    const ok = await showLiquidConfirm({
      title: "Adminni olib tashlash",
      message: "Bu foydalanuvchini adminlikdan butunlay olib tashlaysizmi?",
      subtext: "Bu amalni ortga qaytarib bo'lmaydi.",
      confirmLabel: "Ha, olib tashlansin",
      cancelLabel: "Bekor qilish",
      isDanger: true
    });
    if (!ok) return;
    try {
      await rpc('admin_remove_admin', { p_telegram_id: Number(telegramId) });
      toast('\u2705 Adminlikdan olib tashlandi');
      renderAdminAdminsList();
    } catch (e) {
      console.error(e);
      toast('\u274c Amalga oshmadi: ' + (e.message || 'Supabase xatosi').slice(0, 180), 5000);
    }
  };

  /* ---------- mahoratlar bo'yicha kunlik limit (faqat super admin) ---------- */

  const SKILL_LIMIT_META = [
    { id: 'grammatika', name: 'Grammatika', ar: '\u0627\u0644\u0642\u0648\u0627\u0639\u062f', icon: '\ud83d\udcd7' },
    { id: 'qiroa',      name: 'Qiroa',       ar: '\u0627\u0644\u0642\u0631\u0627\u0621\u0629', icon: '\ud83d\udcd6' },
    { id: 'istima',     name: 'Istima',      ar: '\u0627\u0644\u0627\u0633\u062a\u0645\u0627\u0639', icon: '\ud83c\udfa7' },
    { id: 'muhavara',   name: 'Muhovara',    ar: '\u0627\u0644\u0645\u062d\u0627\u062f\u062b\u0629', icon: '\ud83c\udf99\ufe0f' },
    { id: 'kitaba',     name: 'Kitaba',      ar: '\u0627\u0644\u0643\u062a\u0627\u0628\u0629', icon: '\u270d\ufe0f' }
  ];

  let SKILL_DAILY_LIMITS = {};

  async function loadSkillDailyLimits() {
    try {
      // MUHIM: bu yerda ataylab 'get_skill_daily_limits' (admin bo'lmagan, faqat
      // o'qish uchun ochiq RPC) chaqirilmoqda — 'admin_list_skill_daily_limits'
      // emas. Chunki bu funksiya endi faqat admin panelda emas, HAR BIR oddiy
      // foydalanuvchi uchun ham (limitni real tekshirish uchun) chaqiriladi, va
      // 'admin_' prefiksli RPC'lar odatda faqat super adminlarga ochiq bo'ladi.
      // Supabase'da bu RPC'ni yaratish kerak (faqat skill_id, daily_limit qaytarsin,
      // admin tekshiruvisiz) — quyidagi SQL orqali.
      const rows = await rpc('get_skill_daily_limits');
      const map = {};
      (Array.isArray(rows) ? rows : []).forEach(r => {
        map[r.skill_id] = (r.daily_limit === null || r.daily_limit === undefined) ? 0 : Number(r.daily_limit);
      });
      SKILL_DAILY_LIMITS = map;
      localSet('arab_ext_skill_daily_limits', map);
    } catch (e) {
      console.warn('Kunlik limitlar yuklanmadi, keshdan olinadi:', e);
      SKILL_DAILY_LIMITS = localGet('arab_ext_skill_daily_limits', {});
      throw e;
    } finally {
      // Bu qiymat faqat admin panelda emas, HAR BIR foydalanuvchi uchun kerak —
      // chunki cheklovni haqiqiy tekshirish (checkSkillDailyLimit, asosiy skriptda)
      // shu window.SKILL_DAILY_LIMITS'ni o'qiydi. Shuning uchun bu yerda har doim,
      // xato bo'lsa ham (keshdagi qiymat bilan) window'ga chiqarib qo'yamiz.
      window.SKILL_DAILY_LIMITS = SKILL_DAILY_LIMITS;
    }
  }
  // Ilova ochilgan zahoti (admin panel ochilishini kutmasdan) barcha foydalanuvchilar
  // uchun limitlarni yuklab, window.SKILL_DAILY_LIMITS'ni to'ldirib qo'yish uchun
  // tashqi (global) chaqiriladigan wrapper.
  window.refreshSkillDailyLimitsGlobal = function () {
    return loadSkillDailyLimits().catch(() => {});
  };

  async function renderSkillLimitsAdmin() {
    const wrap = document.getElementById('skillLimitsAdminList');
    if (!wrap) return;

    if (!window.IS_SUPER_ADMIN) {
      wrap.innerHTML = '<p style="color:var(--text-faint);font-size:13px;">Bu bo\u2018lim faqat bosh administratorlar uchun.</p>';
      return;
    }

    wrap.innerHTML = '<p style="color:var(--text-faint);font-size:13px;">Yuklanmoqda...</p>';

    let loadError = null;
    try {
      await loadSkillDailyLimits();
    } catch (e) {
      loadError = e;
    }

    wrap.innerHTML = SKILL_LIMIT_META.map(s => {
      const current = SKILL_DAILY_LIMITS[s.id] ?? 0;
      return `
      <div class="report-item" data-skill-limit-row="${s.id}">
        <div class="report-head">
          <span style="font-weight:600;font-size:13.5px;">${s.icon} ${escapeHtml(s.name)}</span>
          <span class="report-meta" style="font-family:var(--font-ar-bold);">${s.ar}</span>
        </div>
        <div style="display:flex;gap:10px;margin-top:10px;flex-wrap:wrap;align-items:flex-end;">
          <div class="form-field" style="flex:1;min-width:160px;margin:0;">
            <label>Kunlik limit (0 = cheksiz)</label>
            <input type="number" min="0" step="1" inputmode="numeric" id="skillLimitInput_${s.id}" value="${current}" style="width:100%;">
          </div>
          <button class="btn btn-primary" style="height:44px;" onclick="saveSkillDailyLimit('${s.id}')">Saqlash</button>
        </div>
      </div>`;
    }).join('');

    if (loadError) {
      wrap.insertAdjacentHTML('afterbegin', `<p style="color:var(--red);font-size:12.5px;font-weight:600;margin-bottom:4px;">\u26a0\ufe0f Serverdan yangilanmadi, oxirgi saqlangan qiymatlar ko\u2018rsatilmoqda: ${escapeHtml((loadError.message || 'Supabase xatosi').slice(0, 160))}</p>`);
    }
  }

  window.saveSkillDailyLimit = async function (skillId) {
    if (!window.IS_SUPER_ADMIN) {
      toast('Ruxsat yo\u2018q: bu amal faqat bosh administratorlar uchun');
      return;
    }
    const input = document.getElementById('skillLimitInput_' + skillId);
    const raw = (input?.value ?? '').trim();
    if (raw !== '' && (!/^\d+$/.test(raw))) {
      toast('Limit faqat 0 yoki musbat butun son bo\u2018lishi kerak');
      return;
    }
    const value = raw === '' ? 0 : Number(raw);
    try {
      await rpc('admin_set_skill_daily_limit', { p_skill_id: skillId, p_daily_limit: value });
      SKILL_DAILY_LIMITS[skillId] = value;
      localSet('arab_ext_skill_daily_limits', SKILL_DAILY_LIMITS);
      toast('\u2705 Kunlik limit saqlandi');
    } catch (e) {
      console.error(e);
      toast('\u274c Saqlanmadi: ' + (e.message || 'Supabase xatosi').slice(0, 180), 5000);
    }
  };

  /* ---------- admin tab override ---------- */

  function overrideShowAdminTab() {
    const baseShowAdminTab = window.showAdminTab;

    window.showAdminTab = function (tab) {
      if ((tab === 'admins' || tab === 'skilllimits') && !window.IS_SUPER_ADMIN) {
        toast('Bu bo\u2018lim faqat bosh administratorlar uchun');
        tab = 'overview';
      }

      if (typeof baseShowAdminTab === 'function') {
        baseShowAdminTab(tab);
      }

      ['examcards', 'gramorder', 'sendmsg', 'admins', 'community', 'skilllimits', 'speakingduel'].forEach(t => {
        const el = document.getElementById('adminTab-' + t);
        if (el) {
          el.style.display = (t === tab) ? '' : 'none';
        }
      });

      document.querySelectorAll('#adminTabs .admin-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.atab === tab);
      });

      if (tab === 'examcards') { renderExamCardAdmin(); renderGrammarLockAdmin(); renderNavBtnAdmin(); }
      if (tab === 'gramorder') renderGrammarOrderAdmin();
      if (tab === 'sendmsg') renderSentMessages();
      if (tab === 'admins') renderAdminAdminsList();
      if (tab === 'community') renderCommunityAdmin();
      if (tab === 'skilllimits') renderSkillLimitsAdmin();
      if (tab === 'speakingduel') renderSpeakingDuelQuestionsAdmin();
    };
  }

  /* ---------- bind events ---------- */

  function bindStaticEvents() {
    const msgForm = document.getElementById('adminMsgForm');

    if (msgForm) {
      msgForm.addEventListener('submit', sendAdminMessage);
    }

    // DIQQAT: userMsgBell tugmasida HTML ichida onclick="toggleUserMsgPanel()" allaqachon bor.
    // Bu yerda avval yana addEventListener bilan bog'langani uchun bosilganda funksiya
    // 2 marta ishlab, panel ochilib-yopilib (toggle ustiga toggle) hech narsa
    // bo'lmagandek ko'rinar edi. Endi faqat bitta ulanish qoldirildi (HTML'dagi onclick).
  }

  /* ---------- auth wait ---------- */

  async function waitForAuth() {
    const start = Date.now();

    while (
      (typeof APP_READY === 'undefined' || !APP_READY) &&
      Date.now() - start < 10000
    ) {
      await sleep(250);
    }

    await sleep(300);
  }

  /* ---------- init ---------- */

  async function initRealAdminExtension() {
    injectAssets();
    injectAdminExtensionHTML();
    overrideShowAdminTab();
    bindStaticEvents();

    // Tarmoq/auth kutilmasdan, keshdan darhol tiklaymiz — shu bilan qulf/hide
    // holati ilova ochilgan zahoti to'g'ri ko'rinadi (avval bir necha soniya
    // hech narsa qulflanmagandek ko'rinib turardi).
    const cachedCfg = localGet('arab_app_config_cache', null);
    if (cachedCfg) {
      APP_CONFIG = {
        exam_cards: cachedCfg.exam_cards || {},
        grammar_order: cachedCfg.grammar_order || []
      };
      applyExamCardState();
      applyGrammarOrder();
      applyGrammarCardLockState();
      applyNavBtnLockState();
    }

    await waitForAuth();

    await loadAppConfig();

    // MUHIM: kunlik limitlar oldin faqat super adminlar "Kunlik limitlar" panelini
    // ochganda yuklanardi — oddiy foydalanuvchilarda umuman yuklanmasdi, shu sabab
    // limit qo'yilsa ham amalda hech kim uchun ishlamas edi. Endi HAR BIR
    // foydalanuvchi ilovani ochganda darhol yuklanadi (xato bo'lsa ham indamay
    // o'tkazib yuboriladi — .catch orqali).
    await window.refreshSkillDailyLimitsGlobal();

    renderExamCardAdmin();
    renderGrammarOrderAdmin();
    renderGrammarLockAdmin();
    renderNavBtnAdmin();

    await refreshUserMessages();

    if (pollTimer) {
      clearInterval(pollTimer);
    }

    // EGRESS OPTIMIZATSIYASI: Har 5 daqiqada (faqat ekran ochiq/faol bo'lsa) config, xabarlar va kunlik limitlarni
    // tekshirib turadi. Avval 2 daqiqa edi — pg_stat_statements tahlili shu 3 ta chaqiruv umumiy so'rovlarning
    // ~41%ini tashkil qilishini ko'rsatdi, shu sabab interval uzaytirildi (2026-08).
    var POLL_INTERVAL_MS = 300000; // 5 daqiqa. Kerak bo'lsa 600000 (10 daqiqa) ga ham oshirish mumkin.
    // Yuqorida ilova ochilganda loadAppConfig/refreshUserMessages/refreshSkillDailyLimitsGlobal
    // allaqachon bir marta chaqirildi — shuni hisobga olib debounce hisoblagichini shu daqiqadan boshlaymiz.
    var lastPollAt = Date.now();

    function runPollNow() {
      lastPollAt = Date.now();
      loadAppConfig();
      refreshUserMessages();
      window.refreshSkillDailyLimitsGlobal();
    }

    pollTimer = setInterval(function () {
      if (typeof document !== 'undefined' && document.hidden) return;
      runPollNow();
    }, POLL_INTERVAL_MS);

    // Telefonda ilovaga qaytganda yangilab oladi.
    // EGRESS OPTIMIZATSIYASI: agar oxirgi so'rovdan 60 soniyadan kam vaqt o'tgan bo'lsa (foydalanuvchi
    // tez-tez tab almashtirsa), qayta so'rov yubormaymiz — shu 60 soniyalik "debounce" ortiqcha
    // takroriy chaqiruvlarning oldini oladi.
    var VISIBILITY_DEBOUNCE_MS = 60000; // 60 soniya
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        if (Date.now() - lastPollAt < VISIBILITY_DEBOUNCE_MS) return;
        runPollNow();
      }
    });
  }

  /* ================= HAMJAMIYAT ================= */

  const COMMUNITY_FN_URL = `${SUPABASE_URL}/functions/v1/community-card-info`;
  let ADMIN_COMMUNITY_CARDS = [];

  function formatMemberCount(n) {
    if (n === null || n === undefined) return '';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K obunachi';
    return n + ' obunachi';
  }

  function openCommunityLink(link) {
    const tg = window.Telegram?.WebApp;
    if (tg?.openTelegramLink && /t\.me|telegram\.me/i.test(link)) {
      tg.openTelegramLink(link);
    } else if (tg?.openLink) {
      tg.openLink(link);
    } else {
      window.open(link, '_blank');
    }
  }
  window.openCommunityLink = openCommunityLink;

  let communityLoaded = false;
  function renderCommunityView() {
    const box = document.getElementById('communityCardsList');
    if (!box) return;
    if (!communityLoaded && (!APP_CONFIG.community_cards || !APP_CONFIG.community_cards.length)) {
      box.innerHTML = Array.from({length: 3}).map(() => `
        <div class="community-card skel-card">
          <div class="skel skel-avatar" style="width:48px;height:48px;"></div>
          <div class="community-info" style="gap:6px;">
            <div class="skel skel-line" style="width:50%;height:15px;"></div>
            <div class="skel skel-line" style="width:80%;height:12px;"></div>
            <div class="skel skel-line" style="width:30%;height:10px;"></div>
          </div>
          <div class="skel skel-box" style="width:72px;height:32px;border-radius:10px;"></div>
        </div>
      `).join('');
      return;
    }
    const cards = (APP_CONFIG.community_cards || []);
    if (!cards.length) {
      box.innerHTML = `<p class="fade-in-enter" style="font-size:13px;color:var(--text-faint);font-weight:600;">Hozircha hamjamiyat kartalari qo'shilmagan.</p>`;
      return;
    }
    box.innerHTML = cards.map(c => `
      <div class="community-card fade-in-enter">
        ${c.avatar_url
          ? `<img class="community-avatar" src="${c.avatar_url}" alt="">`
          : `<div class="community-avatar">${(c.name || '?').trim().charAt(0).toUpperCase()}</div>`
        }
        <div class="community-info">
          <div class="community-name">${c.name || ''}</div>
          <div class="community-desc">${c.description || ''}</div>
          <div class="community-subs">${formatMemberCount(c.member_count)}</div>
        </div>
        <button class="community-open-btn" onclick="openCommunityLink('${(c.telegram_link || '').replace(/'/g, "\\'")}')">Ochish</button>
      </div>
    `).join('');
  }
  window.renderCommunityView = function() {
    communityLoaded = true;
    renderCommunityView();
  };

  async function renderCommunityAdmin() {
    const box = document.getElementById('communityAdminList');
    if (!box) return;
    box.innerHTML = `<div class="loading-inline"><span class="loading-spinner"></span>Yuklanmoqda…</div>`;
    try {
      const rows = await rpc('admin_list_community_cards', {});
      ADMIN_COMMUNITY_CARDS = Array.isArray(rows) ? rows : [];
    } catch (e) {
      box.innerHTML = `<p style="color:var(--red);font-size:13px;">Yuklab bo'lmadi: ${(e.message || '').slice(0, 150)}</p>`;
      return;
    }
    if (!ADMIN_COMMUNITY_CARDS.length) {
      box.innerHTML = `<p style="font-size:13px;color:var(--text-faint);font-weight:600;">Hali karta qo'shilmagan.</p>`;
      return;
    }
    box.innerHTML = ADMIN_COMMUNITY_CARDS.map((c, i) => `
      <div class="community-admin-row" id="ccRow-${c.id}">
        <div style="display:flex;align-items:center;gap:10px;">
          ${c.avatar_url
            ? `<img class="community-avatar" style="width:40px;height:40px;" src="${c.avatar_url}" alt="">`
            : `<div class="community-avatar" style="width:40px;height:40px;font-size:15px;">${(c.name || '?').trim().charAt(0).toUpperCase()}</div>`
          }
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;font-size:13.5px;">${c.name}${c.visible ? '' : ' <span style="color:var(--red);font-size:11px;">(yashirilgan)</span>'}</div>
            <div style="font-size:11.5px;color:var(--text-faint);font-weight:600;">${c.description || ''}</div>
            <div style="font-size:11px;color:var(--text-faint);font-weight:600;">${formatMemberCount(c.member_count) || 'son aniqlanmagan'} · ${c.telegram_link}</div>
          </div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;">
          <button class="row-btn" onclick="moveCommunityCardAdmin('${c.id}','up')" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="row-btn" onclick="moveCommunityCardAdmin('${c.id}','down')" ${i === ADMIN_COMMUNITY_CARDS.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="row-btn" onclick="refreshCommunityCardAdmin('${c.id}')">🔄 Yangilash</button>
          <button class="row-btn" onclick="toggleCommunityCardVisible('${c.id}', ${!c.visible})">${c.visible ? '🙈 Yashirish' : '👁 Ko\'rsatish'}</button>
          <button class="row-btn" onclick="toggleCommunityEditForm('${c.id}')">✏️ Tahrirlash</button>
          <button class="row-btn danger" onclick="deleteCommunityCardAdmin('${c.id}')">🗑 O'chirish</button>
        </div>
        <div id="ccEdit-${c.id}" style="display:none;margin-top:10px;" class="community-admin-edit-form">
          <input type="text" id="ccEditName-${c.id}" value="${(c.name || '').replace(/"/g, '&quot;')}" placeholder="Nomi">
          <input type="text" id="ccEditDesc-${c.id}" value="${(c.description || '').replace(/"/g, '&quot;')}" placeholder="Izoh">
          <input type="text" id="ccEditLink-${c.id}" value="${(c.telegram_link || '').replace(/"/g, '&quot;')}" placeholder="Telegram link">
          <button class="btn btn-primary" onclick="saveCommunityCardAdmin('${c.id}')">Saqlash</button>
        </div>
      </div>
    `).join('');
  }
  window.renderCommunityAdmin = renderCommunityAdmin;

  window.toggleCommunityEditForm = function (id) {
    const el = document.getElementById('ccEdit-' + id);
    if (el) el.style.display = (el.style.display === 'none') ? '' : 'none';
  };

  window.addCommunityCardAdmin = async function () {
    const name = document.getElementById('ccNewName').value.trim();
    const desc = document.getElementById('ccNewDesc').value.trim();
    const link = document.getElementById('ccNewLink').value.trim();
    if (!name || !link) { toast('Nomi va linkni kiriting'); return; }

    const btn = document.getElementById('ccAddBtn');
    btn.disabled = true; btn.textContent = 'Qo\'shilmoqda…';

    try {
      const newId = await rpc('admin_add_community_card', {
        p_name: name, p_description: desc, p_telegram_link: link
      });

      try {
        const res = await fetch(COMMUNITY_FN_URL, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ card_id: newId, telegram_link: link })
        });
        const data = await res.json();
        if (!res.ok) toast('Karta qo\'shildi, lekin avtomatik aniqlanmadi: ' + (data.error || ''), 4000);
      } catch (e) {
        toast('Karta qo\'shildi, lekin rasm/son aniqlanmadi', 3000);
      }

      document.getElementById('ccNewName').value = '';
      document.getElementById('ccNewDesc').value = '';
      document.getElementById('ccNewLink').value = '';
      toast('✅ Qo\'shildi');
      await renderCommunityAdmin();
      await loadAppConfig();
    } catch (e) {
      toast('❌ Xato: ' + (e.message || '').slice(0, 150), 4000);
    } finally {
      btn.disabled = false; btn.textContent = '+ Qo\'shish va aniqlash';
    }
  };

  window.refreshCommunityCardAdmin = async function (id) {
    const card = ADMIN_COMMUNITY_CARDS.find(c => c.id === id);
    if (!card) return;
    toast('Yangilanmoqda…', 1500);
    try {
      const res = await fetch(COMMUNITY_FN_URL, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ card_id: id, telegram_link: card.telegram_link })
      });
      const data = await res.json();
      if (!res.ok) { toast('❌ ' + (data.error || 'Xato'), 4000); return; }
      toast('✅ Yangilandi');
      await renderCommunityAdmin();
      await loadAppConfig();
    } catch (e) {
      toast('❌ Xato: ' + (e.message || '').slice(0, 150), 4000);
    }
  };

  window.toggleCommunityCardVisible = async function (id, newVisible) {
    const card = ADMIN_COMMUNITY_CARDS.find(c => c.id === id);
    if (!card) return;
    try {
      await rpc('admin_update_community_card', {
        p_id: id, p_name: card.name, p_description: card.description,
        p_telegram_link: card.telegram_link, p_visible: newVisible
      });
      toast('✅ Saqlandi');
      await renderCommunityAdmin();
      await loadAppConfig();
    } catch (e) {
      toast('❌ Xato: ' + (e.message || '').slice(0, 150), 4000);
    }
  };

  window.saveCommunityCardAdmin = async function (id) {
    const name = document.getElementById('ccEditName-' + id).value.trim();
    const desc = document.getElementById('ccEditDesc-' + id).value.trim();
    const link = document.getElementById('ccEditLink-' + id).value.trim();
    const card = ADMIN_COMMUNITY_CARDS.find(c => c.id === id);
    if (!name || !link) { toast('Nomi va linkni kiriting'); return; }
    try {
      await rpc('admin_update_community_card', {
        p_id: id, p_name: name, p_description: desc,
        p_telegram_link: link, p_visible: card ? card.visible : true
      });
      toast('✅ Saqlandi');
      await renderCommunityAdmin();
      await loadAppConfig();
    } catch (e) {
      toast('❌ Xato: ' + (e.message || '').slice(0, 150), 4000);
    }
  };

  window.deleteCommunityCardAdmin = async function (id) {
    const ok = await showLiquidConfirm({
      title: "Kartani o'chirish",
      message: "Ushbu kartani butunlay o'chirmoqchimisiz?",
      subtext: "Bu amalni ortga qaytarib bo'lmaydi.",
      confirmLabel: "Ha, o'chirilsin",
      cancelLabel: "Bekor qilish",
      isDanger: true
    });
    if (!ok) return;
    try {
      await rpc('admin_delete_community_card', { p_id: id });
      toast('✅ O\'chirildi');
      await renderCommunityAdmin();
      await loadAppConfig();
    } catch (e) {
      toast('❌ Xato: ' + (e.message || '').slice(0, 150), 4000);
    }
  };

  window.moveCommunityCardAdmin = async function (id, direction) {
    try {
      await rpc('admin_move_community_card', { p_id: id, p_direction: direction });
      await renderCommunityAdmin();
      await loadAppConfig();
    } catch (e) {
      toast('❌ Xato: ' + (e.message || '').slice(0, 150), 4000);
    }
  };

  let ADMIN_SPEAKING_DUEL_QUESTIONS = [];

  async function renderSpeakingDuelQuestionsAdmin() {
    const box = document.getElementById('speakingDuelQuestionsAdminList');
    if (!box) return;
    box.innerHTML = `<div class="loading-inline"><span class="loading-spinner"></span>Yuklanmoqda…</div>`;
    try {
      const rows = await rpc('admin_list_speaking_duel_questions', {});
      ADMIN_SPEAKING_DUEL_QUESTIONS = Array.isArray(rows) ? rows : [];
    } catch (e) {
      box.innerHTML = `<p style="color:var(--red);font-size:13px;">Yuklab bo'lmadi: ${(e.message || '').slice(0, 150)}</p>`;
      return;
    }
    if (!ADMIN_SPEAKING_DUEL_QUESTIONS.length) {
      box.innerHTML = `<p style="font-size:13px;color:var(--text-faint);font-weight:600;">Hali savol qo'shilmagan. Kamida 3 ta faol savol bo'lmasa, foydalanuvchilar speaking duel boshlay olmaydi.</p>`;
      return;
    }
    box.innerHTML = ADMIN_SPEAKING_DUEL_QUESTIONS.map(q => `
      <div class="community-admin-row" id="sdqRow-${q.id}">
        <div style="flex:1;min-width:0;">
          <div class="ar-text" style="font-size:17px;font-weight:600;line-height:1.7;">${q.prompt_ar}${q.active ? '' : ' <span style="color:var(--red);font-size:11px;font-weight:700;">(nofaol)</span>'}</div>
          ${q.prompt_uz ? `<div style="font-size:12px;color:var(--text-faint);font-weight:600;margin-top:4px;">${q.prompt_uz}</div>` : ''}
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;">
          <button class="row-btn" onclick="toggleSpeakingDuelQuestionAdmin('${q.id}', ${!q.active})">${q.active ? '🙈 Nofaol qilish' : '👁 Faollashtirish'}</button>
          <button class="row-btn" onclick="toggleSpeakingDuelQuestionEditForm('${q.id}')">✏️ Tahrirlash</button>
          <button class="row-btn danger" onclick="deleteSpeakingDuelQuestionAdmin('${q.id}')">🗑 O'chirish</button>
        </div>
        <div id="sdqEdit-${q.id}" style="display:none;margin-top:10px;" class="community-admin-edit-form">
          <textarea id="sdqEditAr-${q.id}" rows="2" style="width:100%;margin-bottom:6px;">${(q.prompt_ar || '')}</textarea>
          <input type="text" id="sdqEditUz-${q.id}" value="${(q.prompt_uz || '').replace(/"/g, '&quot;')}" placeholder="Uzbekcha izoh" style="width:100%;margin-bottom:6px;">
          <button class="btn btn-primary" onclick="saveSpeakingDuelQuestionAdmin('${q.id}')">Saqlash</button>
        </div>
      </div>
    `).join('');
  }
  window.renderSpeakingDuelQuestionsAdmin = renderSpeakingDuelQuestionsAdmin;

  window.toggleSpeakingDuelQuestionEditForm = function (id) {
    const el = document.getElementById('sdqEdit-' + id);
    if (el) el.style.display = (el.style.display === 'none') ? '' : 'none';
  };

  window.addSpeakingDuelQuestionAdmin = async function () {
    const ar = document.getElementById('sdqNewAr').value.trim();
    const uz = document.getElementById('sdqNewUz').value.trim();
    if (!ar) { toast("Arabcha savol matnini kiriting"); return; }

    const btn = document.getElementById('sdqAddBtn');
    btn.disabled = true; btn.textContent = 'Qo\'shilmoqda…';

    try {
      await rpc('admin_add_speaking_duel_question', { p_prompt_ar: ar, p_prompt_uz: uz || null });
      document.getElementById('sdqNewAr').value = '';
      document.getElementById('sdqNewUz').value = '';
      toast('✅ Qo\'shildi');
      await renderSpeakingDuelQuestionsAdmin();
    } catch (e) {
      toast('❌ Xato: ' + (e.message || '').slice(0, 150), 4000);
    } finally {
      btn.disabled = false; btn.textContent = '+ Qo\'shish';
    }
  };

  window.saveSpeakingDuelQuestionAdmin = async function (id) {
    const ar = document.getElementById('sdqEditAr-' + id).value.trim();
    const uz = document.getElementById('sdqEditUz-' + id).value.trim();
    if (!ar) { toast("Arabcha savol matnini kiriting"); return; }
    try {
      await rpc('admin_update_speaking_duel_question', { p_id: id, p_prompt_ar: ar, p_prompt_uz: uz || null });
      toast('✅ Saqlandi');
      await renderSpeakingDuelQuestionsAdmin();
    } catch (e) {
      toast('❌ Xato: ' + (e.message || '').slice(0, 150), 4000);
    }
  };

  window.toggleSpeakingDuelQuestionAdmin = async function (id, newActive) {
    try {
      await rpc('admin_toggle_speaking_duel_question', { p_id: id, p_active: newActive });
      toast('✅ Saqlandi');
      await renderSpeakingDuelQuestionsAdmin();
    } catch (e) {
      toast('❌ Xato: ' + (e.message || '').slice(0, 150), 4000);
    }
  };

  window.deleteSpeakingDuelQuestionAdmin = async function (id) {
    const ok = await showLiquidConfirm({
      title: "Savolni o'chirish",
      message: "Ushbu speaking duel savolini butunlay o'chirmoqchimisiz?",
      subtext: "Bu amalni ortga qaytarib bo'lmaydi.",
      confirmLabel: "Ha, o'chirilsin",
      cancelLabel: "Bekor qilish",
      isDanger: true
    });
    if (!ok) return;
    try {
      await rpc('admin_delete_speaking_duel_question', { p_id: id });
      toast('✅ O\'chirildi');
      await renderSpeakingDuelQuestionsAdmin();
    } catch (e) {
      toast('❌ Xato: ' + (e.message || '').slice(0, 150), 4000);
    }
  };

  initRealAdminExtension();

})();
