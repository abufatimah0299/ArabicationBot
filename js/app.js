/* ============================================================
   ARABICATION — TELEGRAM SDK + SUPABASE INTEGRATSIYASI
   ============================================================ */
const SUPABASE_URL = "https://riqtbtcsllyriyavbamt.supabase.co";       // <-- shu yerga o'z Project URL'ingizni qo'ying
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJpcXRidGNzbGx5cml5YXZiYW10Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY2NDc3NzUsImV4cCI6MjEwMjIyMzc3NX0.GFhKmzx2uq9uZ8fg-cxWtuI39e0wlsIUypwxU_vWCtQ";                      // <-- shu yerga o'z anon key'ingizni qo'ying
const AUTH_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/telegram-auth`;
// Duel havolalari uchun: BotFather'da bergan bot username (@ belgisiz) va shu botga
// bog'langan Web App'ning "short name"i (t.me/<bot>/<short_name>?startapp=... havolasi uchun).
const BOT_USERNAME = 'arabicationbot';         // BotFather'dagi haqiqiy bot username
const WEBAPP_SHORT_NAME = '';                  // Bo'sh qoldiring: bot "Configure Mini App" (menyu tugmasi) orqali ulangan bo'lsa, short_name kerak emas.
                                                // Faqat /newapp orqali BotFather'da alohida nomlangan (va /myapps'da chiqadigan) ilova yaratgan bo'lsangiz, shu yerga o'sha short name'ni yozing.

let SESSION_TOKEN = null;
window.APP_READY = false; // dashboard/skill render funksiyalari shu flag chiqqach chaqiriladi

/* MOSLASHTIRING: bu yerga faqat admin panelni ko'rishi kerak bo'lgan Telegram foydalanuvi ID'larini yozing.
   DIQQAT: bu faqat tugmani yashiradi — haqiqiy himoya emas! Admin ma'lumotlariga backend (Supabase RLS)
   tarafida ham shu ID'lar uchun ruxsat berilishi shart, aks holda boshqa foydalanuvchi ham API orqali
   to'g'ridan-to'g'ri o'sha ma'lumotlarga kirib olishi mumkin. */
const ADMIN_TELEGRAM_IDS = [5400174077];

/* MOSLASHTIRING: qo'llab-quvvatlash uchun o'z Telegram username'ingizni yozing */
const SUPPORT_USERNAME = 'arabication_support';
function contactSupport(){
  const tg = window.Telegram?.WebApp;
  const url = `https://t.me/${SUPPORT_USERNAME}`;
  if(tg?.openTelegramLink){ tg.openTelegramLink(url); }
  else{ window.open(url, '_blank'); }
}

function authHeaders(){
  const token = (typeof SESSION_TOKEN === 'string' && SESSION_TOKEN.trim().split('.').length === 3)
    ? SESSION_TOKEN.trim()
    : SUPABASE_ANON_KEY;
  return {
    "Content-Type": "application/json",
    "apikey": SUPABASE_ANON_KEY,
    "Authorization": `Bearer ${token}`,
  };
}

/* ============================================================
   SMART CACHE (EGRESS VA TRAFIKNI TEJOVCHI VERSIYA TIZIMI)
   questions, writing_topics, qiroa_texts, istima_audio, mocks va
   barcha umumiy sozlamalarni localStorage'ga doimiy saqlaydi.
   Keyingi safar ilovaga kirganda bazaga so'rov yubormasdan
   to'g'ridan-to'g'ri localStorage'dan o'qiydi (0 ms, 0 Egress).
   Faqat admin yangi ma'lumot qo'shganda / tahrirlaganda / o'chirganda
   yoki versiya o'zgargandagina bazadan qayta yuklaydi.
   ============================================================ */
const APP_CONTENT_VERSION_KEY = 'arb_content_ver';
const DEFAULT_CONTENT_VERSION = 1;

const SmartCache = {
  get(key, maxAgeMs = null) {
    try {
      const raw = localStorage.getItem('arb_c_' + key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.data === undefined) return null;
      if (maxAgeMs && parsed.time && (Date.now() - parsed.time > maxAgeMs)) {
        return null;
      }
      return parsed.data;
    } catch (e) { return null; }
  },
  set(key, data) {
    try {
      if (data === null || data === undefined) return;
      localStorage.setItem('arb_c_' + key, JSON.stringify({ time: Date.now(), data }));
    } catch (e) {
      try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const k = localStorage.key(i);
          if (k && k.startsWith('arb_c_') && k !== 'arb_c_' + key) {
            localStorage.removeItem(k);
          }
        }
        localStorage.setItem('arb_c_' + key, JSON.stringify({ time: Date.now(), data }));
      } catch (_) {}
    }
  },
  invalidate(keyPrefix) {
    try {
      const toRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k === 'arb_c_' + keyPrefix || k.startsWith('arb_c_' + keyPrefix))) {
          toRemove.push(k);
        }
      }
      toRemove.forEach(k => localStorage.removeItem(k));
      // Versiyani oshirib qo'yamiz
      const currentVer = parseInt(localStorage.getItem(APP_CONTENT_VERSION_KEY) || '1', 10);
      localStorage.setItem(APP_CONTENT_VERSION_KEY, String(currentVer + 1));
    } catch (_) {}
  },
  clearAllStatic() {
    try {
      const keys = ['questions', 'grammar_topics', 'writing_topics', 'qiroa_texts', 'istima_audio', 'speaking_questions', 'mocks', 'app_config', 'leaderboard'];
      keys.forEach(k => this.invalidate(k));
    } catch (_) {}
  }
};

/* Content versiyasini backend bilan solishtirish. Agar admin backendda yangi ma'lumot
   kiritgan bo'lsa va versiya o'zgargan bo'lsa, lokal keshlar avtomatik tozalanib yangilanadi. */
async function syncContentVersionCheck(remoteVersion) {
  if (!remoteVersion) return;
  const localVer = localStorage.getItem(APP_CONTENT_VERSION_KEY);
  if (!localVer) {
    localStorage.setItem(APP_CONTENT_VERSION_KEY, String(remoteVersion));
    return;
  }
  if (String(localVer) !== String(remoteVersion)) {
    console.log(`[SmartCache] Yangi ma'lumotlar versiyasi topildi: ${localVer} -> ${remoteVersion}. Kesh tozalanmoqda.`);
    SmartCache.clearAllStatic();
    localStorage.setItem(APP_CONTENT_VERSION_KEY, String(remoteVersion));
  }
}

/* Admin huquqini backenddan tekshirish (ADMIN_TELEGRAM_IDS massividan keyin qo'shilgan
   adminlar uchun). admin_list_admins RPC faqat haqiqiy adminlarga ruxsat berilgan deb
   hisoblanadi (Supabase RLS/security definer), shu bois bu chaqiruv muvaffaqiyatli bo'lса
   va javobda o'z ID'imiz faol admin sifatida bo'lsa — foydalanuvchi admin hisoblanadi. */
async function checkBackendAdminAccess(rawId){
  if(!rawId || !SESSION_TOKEN) return false;
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_list_admins`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({})
    });
    if(!res.ok) return false;
    const rows = await res.json();
    if(!Array.isArray(rows)) return false;
    return rows.some(a => String(a.telegram_id) === String(rawId) && a.is_active !== false);
  }catch(e){
    return false;
  }
}

window.IS_CURRENT_USER_ADMIN = false; // boshqa joylarda (masalan yuborilgan xabarlar ro'yxati) ham foydalanish uchun
function showAdminButtons(show){
  window.IS_CURRENT_USER_ADMIN = !!show;
  const adminLink = document.getElementById('adminNavLink');
  if(adminLink) adminLink.style.display = show ? '' : 'none';
  const profileAdminLink = document.getElementById('profileAdminLink');
  if(profileAdminLink) profileAdminLink.style.display = show ? '' : 'none';
  const bnAdminBtn = document.getElementById('bnAdminBtn');
  if(bnAdminBtn) bnAdminBtn.style.display = show ? '' : 'none';
  const bnProfilBtn = document.getElementById('bnProfilBtn');
  if(bnProfilBtn) bnProfilBtn.style.display = ''; // Profil doim ko'rinadi (admin uchun ham Admin tugmasi oldida)
  const sidebarProfilLink = document.getElementById('sidebarProfilLink');
  if(sidebarProfilLink) sidebarProfilLink.style.display = show ? '' : 'none';
}

/* "Bosh admin" (super admin) — faqat ADMIN_TELEGRAM_IDS massividagi ID'lar.
   Faqat ular "👑 Adminlar" bo'limini ko'radi va yangi admin qo'sha/o'chira/olib
   tashlay oladi. Backend orqali (Adminlar bo'limi bilan) qo'shilgan oddiy adminlar
   bu bo'limni ko'rmaydi. DIQQAT: bu ham faqat UI cheklovi — admin_add_admin /
   admin_remove_admin / admin_set_admin_active RPC'lari Supabase tomonida ham
   faqat super adminlarga ruxsat berilishi shart, aks holda oddiy admin buni
   to'g'ridan-to'g'ri API orqali chaqirib yuborishi mumkin.*/
window.IS_SUPER_ADMIN = false;
function setSuperAdminUI(isSuper){
  window.IS_SUPER_ADMIN = !!isSuper;
  const tabBtn = document.querySelector('#adminTabs [data-atab="admins"]');
  if(tabBtn) tabBtn.style.display = isSuper ? '' : 'none';
  const limitsTabBtn = document.querySelector('#adminTabs [data-atab="skilllimits"]');
  if(limitsTabBtn) limitsTabBtn.style.display = isSuper ? '' : 'none';
  // Agar hozir aynan shu tab ochiq bo'lsa-yu, huquq yo'q bo'lib qolsa — umumiy bo'limga qaytaramiz.
  if(!isSuper){
    const pane = document.getElementById('adminTab-admins');
    if(pane && pane.style.display !== 'none'){
      showAdminTab('overview');
    }
    const limitsPane = document.getElementById('adminTab-skilllimits');
    if(limitsPane && limitsPane.style.display !== 'none'){
      showAdminTab('overview');
    }
  }
}

async function tgInitAndAuth(){
  const tg = window.Telegram?.WebApp;
  if(!tg){ showDebug("❌ Telegram.WebApp topilmadi — SDK yuklanmagan yoki brauzerda ochilgan."); return null; }
  tg.ready();
  if (typeof tg.expand === 'function') tg.expand();
  if (tg.isVersionAtLeast && tg.isVersionAtLeast('8.0') && typeof tg.requestFullscreen === 'function') {
    try { tg.requestFullscreen(); } catch(e){}
  }
  if (tg.isVersionAtLeast && tg.isVersionAtLeast('7.7') && typeof tg.disableVerticalSwipes === 'function') {
    try { tg.disableVerticalSwipes(); } catch(e){}
  }
  if(typeof window.applyTelegramSafeAreas === 'function') window.applyTelegramSafeAreas();
  const initData = tg.initData;
  if(!initData){ showDebug("❌ initData BO'SH. Menu Button 'Web App' turida sozlanmagan bo'lishi mumkin. (tg.platform: "+tg.platform+", version: "+tg.version+")"); return null; }
  showDebug("✅ initData bor (uzunligi: "+initData.length+"). Supabase'ga so'rov yuborilmoqda...");
  try{
    const res = await fetch(AUTH_FUNCTION_URL, {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + SUPABASE_ANON_KEY
      },
      body: JSON.stringify({initData})
    });
    if(!res.ok){ const t = await res.text(); showDebug("❌ Auth xato ("+res.status+"): "+t); return null; }
    const {token, user} = await res.json();
    SESSION_TOKEN = token;
    showDebug("✅ Auth muvaffaqiyatli: "+(user?.first_name||'?'));
    return user;
  }catch(e){
    console.warn("Auth so'rovi bajarilmadi:", e && e.message);
    return null;
  }
}

/* Debug panel olib tashlandi — xatoliklar faqat brauzer konsoliga (F12) yoziladi */
function showDebug(msg){
  console.log("[DEBUG]", msg);
}

/* Telegram Mini App ichida DevTools yo'q, shu sabab har qanday kutilmagan JS xatosini
   (oldin faqat konsolga yozilib, ko'rinmay qolardi) endi ekranda toast sifatida
   ko'rsatamiz — shunda foydalanuvchi (yoki admin) xato matnini ko'rib, yuborib bera oladi. */
window.addEventListener('error', function(e){
  try{ toast(`⚠️ Kutilmagan xato: ${e.message}`, 7000); }catch(_){}
  console.error('[window.onerror]', e.error || e.message, e);
});
window.addEventListener('unhandledrejection', function(e){
  const msg = (e.reason && e.reason.message) || e.reason;
  try{ toast(`⚠️ Kutilmagan xato (promise): ${msg}`, 7000); }catch(_){}
  console.error('[unhandledrejection]', e.reason);
});

async function loadDashboardFromBackend(userId){
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_user_dashboard`, {
      method:"POST", headers: authHeaders(), body: JSON.stringify({p_user_id: userId})
    });
    if(!res.ok) return null;
    const rows = await res.json();
    return Array.isArray(rows) ? rows[0] : rows;
  }catch(e){ console.error(e); return null; }
}

async function submitQuizResultToBackend({skillId, topicId, topicName, correct, total, isMock}){
  if(!SESSION_TOKEN) return null;
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/submit_quiz_result`, {
      method:"POST", headers: authHeaders(),
      body: JSON.stringify({
        p_user_id: TELEGRAM_PROFILE.rawId, p_skill_id: skillId, p_topic_id: topicId||null,
        p_topic_name: topicName||null, p_correct: correct, p_total: total,
        p_is_mock: !!isMock
      })
    });
    if(!res.ok){
      const errText = await res.text();
      console.error("Natija yuborilmadi:", errText);
      toast("⚠️ Natija tarixga saqlanmadi: " + errText.slice(0,140), 7000);
      return null;
    }
    const data = await res.json();
    // Natija backendga muvaffaqiyatli yozilgach, Tarix/Xatolarim va mahorat foizlarini
    // (skill hub'dagi halqalar) darhol qayta yuklaymiz — aks holda foydalanuvchi ilovani
    // qayta ochmaguncha eski (bo'sh/eskirgan) ma'lumotni ko'rib turadi.
    refreshHistoryAndScoresFromBackend();
    return data;
  }catch(e){
    console.error(e);
    toast("⚠️ Tarmoq xatosi: natija saqlanmadi", 7000);
    return null;
  }
}

/* Har bir mahorat (grammatika, qiroa, istima, muhavara, kitaba) bo'yicha test/imtihon
   tugab, natija submit_quiz_result orqali backendga yozilgach chaqiriladi: Tarix
   (quiz_attempts), Xatolarim va dashboarddagi mahorat foizlarini qaytadan yuklab,
   ekranni yangi ma'lumot bilan qayta chizadi. */
async function refreshHistoryAndScoresFromBackend(){
  if(!TELEGRAM_PROFILE.rawId) return;
  try{
    const [history, errors, dash] = await Promise.all([
      loadHistoryFromBackend(TELEGRAM_PROFILE.rawId),
      loadErrorsFromBackend(TELEGRAM_PROFILE.rawId),
      loadDashboardFromBackend(TELEGRAM_PROFILE.rawId),
    ]);
    window.HISTORY_DATA_LIVE = history;
    window.USER_ERRORS_LIVE = errors;
    applyLiveHistory();
    applyLiveErrors();
    applyBackendSkillScores(dash);
    applyProfileStats(dash);
    applyProfileHeader(dash);
    // Yangi to'plangan XP reytingda ham darhol ko'rinishi uchun (foydalanuvchi
    // Rank bo'limini qayta ochmasdan turib ham) leaderboard'ni shu yerda ham
    // qayta yuklaymiz.
    refreshRankFromBackend();
  }catch(e){ console.error('[refreshHistoryAndScoresFromBackend]', e); }
}

async function loadHistoryFromBackend(userId){
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/quiz_attempts?user_id=eq.${userId}&order=created_at.desc&limit=50`, {
      headers: authHeaders()
    });
    return res.ok ? await res.json() : [];
  }catch(e){ console.error(e); return []; }
}

async function loadErrorsFromBackend(userId){
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/user_errors?user_id=eq.${userId}&order=created_at.desc&limit=50`, {
      headers: authHeaders()
    });
    return res.ok ? await res.json() : [];
  }catch(e){ console.error(e); return []; }
}

/* 2-BOSQICH: rank bo'limida XP qancha test/urinishdan yig'ilganini ko'rsatish uchun,
   leaderboard_view'ga qo'shimcha ravishda leaderboard_attempt_counts (yoki shunga
   o'xshash) view/jadvaldan har bir foydalanuvchining mahorat bo'yicha test/urinish
   sonini ham olib, asosiy qatorga birlashtiramiz. Bu view hali backendda yo'q bo'lsa,
   fetch shunchaki bo'sh/404 qaytaradi va hisoblagichlar 0 sifatida qoladi — sahifa
   buzilmaydi (pastdagi SQL taklifiga qarang). */
async function loadAttemptCountsFromBackend(){
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/leaderboard_attempt_counts?select=*`, { headers: authHeaders() });
    if(!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  }catch(e){ console.error('[loadAttemptCountsFromBackend]', e); return []; }
}
async function loadLeaderboardFromBackend(forceRefresh = false){
  if(!forceRefresh){
    const cached = SmartCache.get('leaderboard', 3 * 60 * 1000); // 3 daqiqa kesh
    if(cached) return cached;
  }
  try{
    const [res, counts] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/leaderboard_view?select=*`, { headers: authHeaders() }),
      loadAttemptCountsFromBackend()
    ]);
    if(!res.ok){
      console.warn('[loadLeaderboardFromBackend] error:', res.status);
      return [];
    }
    const data = await res.json();
    // Har bir foydalanuvchining test/urinish sonini id bo'yicha asosiy qatorga qo'shamiz.
    if(Array.isArray(data) && counts.length){
      const countsById = new Map(counts.map(c => [String(pick(c, ['user_id','telegram_id','id'], '')), c]));
      for(const row of data){
        const rid = String(pick(row, ['user_id','telegram_id','id'], ''));
        const extra = countsById.get(rid);
        if(extra) Object.assign(row, extra);
      }
    }
    if(Array.isArray(data) && data.length > 0){
      SmartCache.set('leaderboard', data);
    }
    return data;
  }catch(e){ console.error('[loadLeaderboardFromBackend]', e); return []; }
}
/* Reyting ro'yxatini backenddan qayta yuklab, ekranni yangi ma'lumot bilan qayta
   chizadi. applyLiveLeaderboard() ichida view-rank ochiq bo'lsa renderRank() ni
   o'zi chaqiradi — shu sabab bu yerda alohida render() chaqirish shart emas. */
async function refreshRankFromBackend(){
  const lb = await loadLeaderboardFromBackend(true);
  applyLiveLeaderboard(lb);
}

/* Savollar banki — hammasi uchun umumiy (Supabase "questions" jadvali).
   Admin yangi savol qo'shganda backendga yoziladi, boshqa foydalanuvchilar
   ilovani ochganda shu funksiya orqali yuklanadi.
   EGRESS OPTIMIZATSIYASI: 10 daqiqa SmartCache bilan keshlanadi. */
async function loadQuestionsFromBackend(forceRefresh = false){
  if(!forceRefresh){
    const cached = SmartCache.get('questions');
    if(cached) return cached;
  }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/questions?select=id,skill_id,topic_id,category,q,opts,correct_index,exp&order=order_index.asc.nullslast,created_at.asc`, { headers: authHeaders() });
    if(!res.ok) return null;
    const data = await res.json();
    if(Array.isArray(data)){
      SmartCache.set('questions', data);
    }
    return data;
  }catch(e){ console.error(e); return null; }
}
/* Backend xatolarini konsoldan tashqari ilova ichida (toast) ko'rsatish uchun —
   Telegram Mini App'da DevTools ochib bo'lmaydi, shu sabab admin xato matnini
   to'g'ridan-to'g'ri ekranda ko'rishi kerak. */
window.LAST_BACKEND_ERROR = '';
function setLastBackendError(status, text){
  window.LAST_BACKEND_ERROR = `HTTP ${status}: ${(text||'').slice(0,300)}`;
  console.error(window.LAST_BACKEND_ERROR);
}

async function saveQuestionToBackend({skillId, topicId, category, q, opts, a, exp}){
  if(!SESSION_TOKEN){ setLastBackendError('—', 'SESSION_TOKEN yo\'q (Telegram orqali kirilmagan)'); return null; }
  try{
    const bodyWithCat = { p_skill_id: skillId, p_topic_id: topicId||null, p_category: category||null, p_q: q, p_opts: opts, p_correct: a, p_exp: exp||null };
    let res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_add_question`, {
      method:"POST", headers: authHeaders(),
      body: JSON.stringify(bodyWithCat)
    });
    if(!res.ok && res.status >= 400){
      // Agar backend admin_add_question p_category parametrini tanimasa (eski RPC), p_category'siz qayta urinamiz
      const bodyWithoutCat = { p_skill_id: skillId, p_topic_id: topicId||null, p_q: q, p_opts: opts, p_correct: a, p_exp: exp||null };
      res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_add_question`, {
        method:"POST", headers: authHeaders(),
        body: JSON.stringify(bodyWithoutCat)
      });
    }
    if(!res.ok){ setLastBackendError(res.status, await res.text()); return null; }
    SmartCache.invalidate('questions');
    const text = await res.text();
    return text ? JSON.parse(text) : true;
  }catch(e){ setLastBackendError('—', e.message); return null; }
}
/* Bir nechta savolni bittada qo'shish (ommaviy/bulk) — Supabase'da `admin_bulk_add_questions`
   RPC funksiyasi talab qilinadi (p_items — har biri {p_skill_id,p_topic_id,p_q,p_opts,p_correct,p_exp}
   shaklidagi obyektlar massivi). Muvaffaqiyatli bo'lsa backend qo'shilgan qatorlarni qaytaradi. */
async function saveQuestionsBulkToBackend(items){
  if(!SESSION_TOKEN){ setLastBackendError('—', 'SESSION_TOKEN yo\'q (Telegram orqali kirilmagan)'); return null; }
  if(!Array.isArray(items) || !items.length){ setLastBackendError('—', 'Ro\'yxat bo\'sh'); return null; }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_bulk_add_questions`, {
      method:"POST", headers: authHeaders(),
      body: JSON.stringify({ p_items: items.map(it=>({
        p_skill_id: it.skillId, p_topic_id: it.topicId||null, p_q: it.q,
        p_opts: it.opts, p_correct: it.a, p_exp: it.exp||null,
      })) })
    });
    if(!res.ok){ setLastBackendError(res.status, await res.text()); return null; }
    SmartCache.invalidate('questions');
    const text = await res.text();
    return text ? JSON.parse(text) : true;
  }catch(e){ setLastBackendError('—', e.message); return null; }
}
/* Bir nechta savolni bittada, HAR BIRI O'Z MAVZUSI bilan qo'shish (mavzu nomi bo'yicha
   avtomatik topiladi yoki mavjud bo'lmasa avtomatik yaratiladi). Supabase'da
   `admin_bulk_add_questions_with_topics` RPC funksiyasi talab qilinadi. */
async function saveQuestionsBulkWithTopicsToBackend(items){
  if(!SESSION_TOKEN){ setLastBackendError('—', 'SESSION_TOKEN yo\'q (Telegram orqali kirilmagan)'); return null; }
  if(!Array.isArray(items) || !items.length){ setLastBackendError('—', 'Ro\'yxat bo\'sh'); return null; }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_bulk_add_questions_with_topics`, {
      method:"POST", headers: authHeaders(),
      body: JSON.stringify({ p_items: items.map(it=>({
        p_skill_id: it.skillId,
        p_topic_id: it.topicId || null,
        p_topic_name: it.topicName || null,
        p_topic_ar: it.topicAr || null,
        p_category: it.category || null,
        p_q: it.q, p_opts: it.opts, p_correct: it.a, p_exp: it.exp||null,
      })) })
    });
    if(!res.ok){ setLastBackendError(res.status, await res.text()); return null; }
    SmartCache.invalidate('questions');
    SmartCache.invalidate('grammar_topics');
    const text = await res.text();
    return text ? JSON.parse(text) : true;
  }catch(e){ setLastBackendError('—', e.message); return null; }
}
/* Barcha savollarni (hamma bo'lim, hamma mavzu) o'chirish — Supabase'da
   `admin_clear_all_questions` RPC funksiyasi talab qilinadi. Mavzular
   ro'yxati (grammar_topics) tegilmaydi, faqat savollarning o'zi o'chadi. */
async function clearAllQuestionsOnBackend(){
  if(!SESSION_TOKEN){ setLastBackendError('—', 'SESSION_TOKEN yo\'q (Telegram orqali kirilmagan)'); return null; }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_clear_all_questions`, {
      method:"POST", headers: authHeaders(), body: JSON.stringify({})
    });
    if(!res.ok){ setLastBackendError(res.status, await res.text()); return null; }
    SmartCache.invalidate('questions');
    const text = await res.text();
    return text ? JSON.parse(text) : 0;
  }catch(e){ setLastBackendError('—', e.message); return null; }
}
async function clearAllQuestions(){
  const countText = document.getElementById('adminQuestionsCount')?.textContent || '';
  const ok = await showLiquidConfirm({
    title: "Barcha savollarni o'chirish",
    message: `DIQQAT: Bu BARCHA bo'limlardagi BARCHA savollarni butunlay o'chiradi (${countText}).`,
    subtext: "Mavzular ro'yxati saqlanib qoladi, lekin ichidagi barcha savollar yo'qoladi. Bu amalni ORQAGA QAYTARIB BO'LMAYDI!",
    confirmLabel: "Ha, butunlay o'chirilsin",
    cancelLabel: "Bekor qilish",
    isDanger: true
  });
  if(!ok) return;

  const deletedCount = await clearAllQuestionsOnBackend();
  if(deletedCount !== null){
    toast(`🗑 ${deletedCount} ta savol o'chirildi`);
    await refreshQiroaFromBackend();
    renderAdminQuestions();
  } else {
    toast("⚠️ O'chirilmadi: " + window.LAST_BACKEND_ERROR, 6000);
  }
}

/* Faqat joriy tanlangan bo'lim (adminActiveSkill) savollarini VA shu bo'limga tegishli
   mavzular/matnlarni (Grammatika uchun grammar_topics, Qiroa uchun qiroa_texts) tozalaydi.
   Istima/Muhavara/Kitaba'da alohida "mavzu" jadvali yo'q — shu bo'limlar uchun faqat
   savollar o'chadi.
   TEZ YO'L: agar Supabase'da `admin_clear_section_questions(p_skill_id)` RPC funksiyasi
   yaratilgan bo'lsa, bitta so'rov bilan bir zumda o'chiradi (pastdagi SQL qarang).
   ZAXIRA YO'L: agar hali o'sha RPC yaratilmagan bo'lsa (404/"function does not exist"),
   avtomatik ravishda eski — sekinroq, lekin har doim ishlaydigan — usulga o'tadi: avval
   shu bo'limga tegishli savollarni, so'ng (grammatika/qiroa uchun) mavzularni/matnlarni
   birma-bir (mavjud admin_delete_question / admin_delete_grammar_topic /
   admin_delete_qiroa_text RPC'lari orqali) o'chiradi. */
async function clearSectionQuestionsOnBackendFast(skillId){
  if(!SESSION_TOKEN){ setLastBackendError('—', 'SESSION_TOKEN yo\'q (Telegram orqali kirilmagan)'); return null; }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_clear_section_questions`, {
      method:"POST", headers: authHeaders(),
      body: JSON.stringify({ p_skill_id: skillId })
    });
    if(!res.ok){
      const errText = await res.text();
      // RPC hali Supabase'da yaratilmagan — chaqiruvchi funksiya buni ko'rib, eski usulga o'tkazadi.
      if(res.status === 404 || /function .* does not exist|PGRST202/i.test(errText)) return undefined;
      setLastBackendError(res.status, errText);
      return null;
    }
    return await res.json(); // { questions: N, topics: M }
  }catch(e){ setLastBackendError('—', e.message); return null; }
}
async function clearSectionQuestionsOnBackend(skillId){
  const all = await loadQuestionsFromBackend();
  const rows = (all||[]).filter(r => r.skill_id === skillId);
  let deletedQ = 0, failedQ = 0;
  for(const r of rows){
    const ok = await deleteQuestionOnBackend(r.id);
    if(ok) deletedQ++; else failedQ++;
  }

  let deletedT = 0, failedT = 0, totalT = 0;
  if(skillId === 'grammatika'){
    const topics = await loadGrammarTopicsFromBackend();
    totalT = (topics||[]).length;
    for(const t of (topics||[])){
      const ok = await deleteGrammarTopicOnBackend(t.id);
      if(ok) deletedT++; else failedT++;
    }
  } else if(skillId === 'qiroa'){
    const texts = await loadQiroaTextsFromBackend();
    totalT = (texts||[]).length;
    for(const t of (texts||[])){
      const ok = await deleteQiroaTextOnBackend(t.id);
      if(ok !== null) deletedT++; else failedT++;
    }
  }

  return { deletedQ, failedQ, totalQ: rows.length, deletedT, failedT, totalT };
}
function grammarQiroaTopicWord(skillId){
  return skillId==='grammatika' ? "mavzu" : (skillId==='qiroa' ? "matn" : null);
}
async function clearCurrentSectionQuestions(){
  const skillName = SKILL_META[adminActiveSkill]?.name || adminActiveSkill;
  const topicWord = grammarQiroaTopicWord(adminActiveSkill);
  const topicsWarning = topicWord ? ` va barcha ${topicWord}larni (mavzular/matnlar ro'yxatini)` : '';
  const ok = await showLiquidConfirm({
    title: `"${skillName}" bo'limini tozalash`,
    message: `DIQQAT: Bu faqat "${skillName}" bo'limidagi BARCHA savollarni${topicsWarning} butunlay o'chiradi.`,
    subtext: "Boshqa bo'limlarga tegmaydi. Bu amalni ORQAGA QAYTARIB BO'LMAYDI!",
    confirmLabel: "Ha, o'chirilsin",
    cancelLabel: "Bekor qilish",
    isDanger: true
  });
  if(!ok) return;

  toast(`⏳ "${skillName}" bo'limi tozalanmoqda...`);

  const fastResult = await clearSectionQuestionsOnBackendFast(adminActiveSkill);
  if(fastResult !== undefined && fastResult !== null){
    let msg = `🗑 "${skillName}" bo'limidan ${fastResult.questions ?? 0} ta savol`;
    if(topicWord && fastResult.topics) msg += ` va ${fastResult.topics} ta ${topicWord}`;
    msg += " o'chirildi";
    toast(msg);
    const liveTopics = await loadGrammarTopicsFromBackend();
    applyLiveGrammarTopics(liveTopics);
    await refreshQiroaFromBackend();
    renderAdminQuestions();
    return;
  }
  if(fastResult === null){
    toast("⚠️ O'chirilmadi: " + window.LAST_BACKEND_ERROR, 6000);
    return;
  }
  // fastResult === undefined -> RPC hali yaratilmagan, zaxira (sekinroq) usulga o'tamiz
  const result = await clearSectionQuestionsOnBackend(adminActiveSkill);
  if(result.totalQ === 0 && result.totalT === 0){
    toast(`ℹ️ "${skillName}" bo'limida o'chiriladigan narsa topilmadi`);
  } else if(result.failedQ === 0 && result.failedT === 0){
    let msg = `🗑 "${skillName}" bo'limidan ${result.deletedQ} ta savol`;
    if(topicWord && result.totalT) msg += ` va ${result.deletedT} ta ${topicWord}`;
    msg += " o'chirildi";
    toast(msg);
  } else {
    toast(`🗑 "${skillName}": savollar ${result.deletedQ}/${result.totalQ}, ${topicWord||'mavzu'}lar ${result.deletedT}/${result.totalT} o'chirildi (ba'zilari xato berdi: ${window.LAST_BACKEND_ERROR})`, 9000);
  }
  const liveTopics = await loadGrammarTopicsFromBackend();
  applyLiveGrammarTopics(liveTopics);
  await refreshQiroaFromBackend();
  renderAdminQuestions();
}

/* ---------- Savollar/mazmun bazasini backup qilish (yuklab olish) va qayta yuklash (import) ----------
   Har bir bo'lim o'zining backend jadvaliga ega bo'lgani uchun (Grammatika/Qiroa/Istima —
   "questions" jadvali + kerak bo'lsa "qiroa_texts"/"istima_audio"; Muhavara — "speaking_questions";
   Kitaba — "writing_topics"), backup/import shu FARQNI hisobga oladi: adminActiveSkill'ga qarab
   to'g'ri jadval(lar)dan o'qiydi/yozadi. Fayl formatini "format" maydonidan aniqlaydi, shu bois
   eski (faqat "questions" jadvali uchun chiqarilgan) backup fayllari ham hamon ishlayveradi. */
function downloadJSONFile(filename, dataObj){
  const blob = new Blob([JSON.stringify(dataObj, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
function backupStamp(){ return new Date().toISOString().slice(0,19).replace(/[:T]/g,'-'); }

async function exportAllQuestionsData(){
  const targetSkill = adminActiveSkill;
  const skillName = SKILL_META[targetSkill]?.name || targetSkill;
  toast('⏳ Ma\'lumotlar yuklanmoqda...');

  /* ---- Muhavara (so'zlashuv) — "speaking_questions" jadvali ---- */
  if(targetSkill === 'muhavara'){
    const rows = await loadSpeakingQuestionsFromBackend();
    if(!rows.length){
      toast(`⚠️ "${skillName}" bo'limida hali savol yo'q — backup qilinadigan narsa topilmadi`, 6000);
      return;
    }
    const items = rows.map(r => ({ partId: r.part_id, prompt: r.prompt }));
    const payload = {
      exported_at: new Date().toISOString(), app: 'Arabication',
      format: 'speaking_questions_v1', skillId: targetSkill, count: items.length, items,
    };
    downloadJSONFile(`arabication-muhavara-backup-${backupStamp()}.json`, payload);
    toast(`✅ "${skillName}" bo'limidan ${items.length} ta savol backup qilindi (yuklab olindi)`);
    return;
  }

  /* ---- Kitaba (yozish) — "writing_topics" jadvali ---- */
  if(targetSkill === 'kitaba'){
    const rows = await loadWritingTopicsFromBackend();
    if(!rows.length){
      toast(`⚠️ "${skillName}" bo'limida hali mavzu yo'q — backup qilinadigan narsa topilmadi`, 6000);
      return;
    }
    const items = rows.map(r => ({ partId: r.part_id, topicAr: r.topic_ar }));
    const payload = {
      exported_at: new Date().toISOString(), app: 'Arabication',
      format: 'writing_topics_v1', skillId: targetSkill, count: items.length, items,
    };
    downloadJSONFile(`arabication-kitaba-backup-${backupStamp()}.json`, payload);
    toast(`✅ "${skillName}" bo'limidan ${items.length} ta mavzu backup qilindi (yuklab olindi)`);
    return;
  }

  /* ---- Qiroa (o'qish) — "qiroa_texts" (matnlar) + ularga bog'liq savollar ---- */
  if(targetSkill === 'qiroa'){
    const [texts, questions] = await Promise.all([
      loadQiroaTextsFromBackend(),
      loadQuestionsFromBackend(),
    ]);
    if(!texts.length){
      toast(`⚠️ "${skillName}" bo'limida hali matn yo'q — backup qilinadigan narsa topilmadi`, 6000);
      return;
    }
    const items = texts.map(t => ({
      juzId: t.juz_id,
      title: t.title || '',
      passage: t.passage || '',
      questions: (questions||[])
        .filter(q => q.skill_id === 'qiroa' && q.topic_id === t.id)
        .map(q => ({ q: q.q, opts: q.opts, a: q.correct_index, exp: q.exp || '' })),
    }));
    const payload = {
      exported_at: new Date().toISOString(), app: 'Arabication',
      format: 'qiroa_texts_v1', skillId: targetSkill, count: items.length, items,
    };
    downloadJSONFile(`arabication-qiroa-backup-${backupStamp()}.json`, payload);
    const qCount = items.reduce((s,it)=>s+it.questions.length, 0);
    toast(`✅ "${skillName}" bo'limidan ${items.length} ta matn (${qCount} ta savol bilan) backup qilindi`);
    return;
  }

  /* ---- Istima (tinglash) — "istima_audio" (audio testlar) + ularga bog'liq savollar ---- */
  if(targetSkill === 'istima'){
    const [audios, questions] = await Promise.all([
      loadIstimaAudioFromBackend(),
      loadQuestionsFromBackend(),
    ]);
    if(!audios.length){
      toast(`⚠️ "${skillName}" bo'limida hali audio yo'q — backup qilinadigan narsa topilmadi`, 6000);
      return;
    }
    const items = audios.map(a => ({
      juzId: a.juz_id,
      audioUrl: a.audio_url || '',
      questions: (questions||[])
        .filter(q => q.skill_id === 'istima' && q.topic_id === a.id)
        .map(q => ({ q: q.q, opts: q.opts, a: q.correct_index, exp: q.exp || '' })),
    }));
    const payload = {
      exported_at: new Date().toISOString(), app: 'Arabication',
      format: 'istima_audio_v1', skillId: targetSkill, count: items.length, items,
    };
    downloadJSONFile(`arabication-istima-backup-${backupStamp()}.json`, payload);
    const qCount = items.reduce((s,it)=>s+it.questions.length, 0);
    toast(`✅ "${skillName}" bo'limidan ${items.length} ta audio-test (${qCount} ta savol bilan) backup qilindi`);
    return;
  }

  /* ---- Grammatika (va boshqa hamma narsa) — eski usul: "questions" jadvali ---- */
  const [topics, questions] = await Promise.all([
    loadGrammarTopicsFromBackend(),
    loadQuestionsFromBackend(),
  ]);
  const topicsById = {};
  (topics||[]).forEach(t => { topicsById[t.id] = t; });

  const items = (questions||[])
    .filter(q => q.skill_id === targetSkill)
    .map(q => {
      const t = q.topic_id ? topicsById[q.topic_id] : null;
      return {
        skillId: q.skill_id,
        topic: t ? t.name : null,
        topicAr: t ? t.ar : null,
        category: t ? t.category : null,
        q: q.q,
        opts: q.opts,
        a: q.correct_index,
        exp: q.exp || '',
      };
    });

  if(!items.length){
    toast(`⚠️ "${skillName}" bo'limida hali savol yo'q — backup qilinadigan narsa topilmadi`, 6000);
    return;
  }

  const payload = {
    exported_at: new Date().toISOString(),
    app: 'Arabication',
    format: 'bulk_add_with_topics_v1',
    skillId: targetSkill,
    count: items.length,
    questions: items,
  };
  downloadJSONFile(`arabication-${targetSkill}-backup-${backupStamp()}.json`, payload);
  toast(`✅ "${skillName}" bo'limidan ${items.length} ta savol backup qilindi (yuklab olindi)`);
}

async function importQuestionsFromFile(event){
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if(!file) return;

  let parsed;
  try{
    const text = await file.text();
    parsed = JSON.parse(text);
  }catch(err){
    toast('❌ Fayl JSON formatida emas: ' + err.message, 6000);
    return;
  }

  const targetSkill = adminActiveSkill;
  const skillName = SKILL_META[targetSkill]?.name || targetSkill;
  const format = parsed && typeof parsed === 'object' ? (parsed.format || '') : '';

  /* ---- Muhavara import ("speaking_questions_v1") ---- */
  if(format === 'speaking_questions_v1'){
    if(targetSkill !== 'muhavara'){
      toast(`❌ Bu fayl "So'zlashuv" bo'limi uchun — avval admin panelda "So'zlashuv" bo'limini tanlang`, 8000);
      return;
    }
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    if(!items.length){ toast('❌ Faylda savollar topilmadi ("items" massivi kerak)', 6000); return; }
    const ok = await showLiquidConfirm({
      title: "Savollarni import qilish",
      message: `Faylda "${skillName}" bo'limi uchun ${items.length} ta savol topildi.`,
      subtext: "Ularni bazaga qayta yuklaymizmi? (Allaqachon mavjud savollar avtomatik o'tkazib yuboriladi)",
      confirmLabel: "Yuklash",
      cancelLabel: "Bekor qilish",
      isDanger: false,
      icon: "📥"
    });
    if(!ok) return;

    toast(`⏳ ${items.length} ta savol tekshirilmoqda...`);
    const existing = await loadSpeakingQuestionsFromBackend();
    const existingSet = new Set((existing||[]).map(r => `${r.part_id}::${(r.prompt||'').trim()}`));
    const validItems = items.filter(it => it.partId && it.prompt);
    const toAdd = validItems.filter(it => !existingSet.has(`${it.partId}::${String(it.prompt).trim()}`));
    const skipped = validItems.length - toAdd.length;

    let inserted = 0, failed = 0;
    if(toAdd.length){
      toast(`⏳ ${toAdd.length} ta yangi savol yuborilmoqda...`);
      const result = await saveSpeakingQuestionsBulkToBackend(toAdd);
      if(result){
        inserted = result.inserted_count ?? toAdd.length;
      } else {
        failed = toAdd.length;
      }
    }

    await refreshSpeakingFromBackend();
    renderAdminQuestions();
    let msg = `✅ "${skillName}" uchun import tugadi: ${inserted} ta qo'shildi, ${skipped} ta takroriy o'tkazib yuborildi`;
    if(failed > 0) msg += `, ⚠️ ${failed} ta yuborilmadi (xato: ${window.LAST_BACKEND_ERROR})`;
    toast(msg, 9000);
    return;
  }

  /* ---- Kitaba import ("writing_topics_v1") ---- */
  if(format === 'writing_topics_v1'){
    if(targetSkill !== 'kitaba'){
      toast(`❌ Bu fayl "Yozish" bo'limi uchun — avval admin panelda "Yozish" bo'limini tanlang`, 8000);
      return;
    }
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    if(!items.length){ toast('❌ Faylda mavzular topilmadi ("items" massivi kerak)', 6000); return; }
    const ok = await showLiquidConfirm({
      title: "Mavzularni import qilish",
      message: `Faylda "${skillName}" bo'limi uchun ${items.length} ta mavzu topildi.`,
      subtext: "Ularni bazaga qayta yuklaymizmi? (Allaqachon mavjud mavzular avtomatik o'tkazib yuboriladi)",
      confirmLabel: "Yuklash",
      cancelLabel: "Bekor qilish",
      isDanger: false,
      icon: "📥"
    });
    if(!ok) return;

    toast(`⏳ ${items.length} ta mavzu yuborilmoqda...`);
    const existing = await loadWritingTopicsFromBackend();
    const existingSet = new Set((existing||[]).map(r => `${r.part_id}::${(r.topic_ar||'').trim()}`));

    let inserted = 0, skipped = 0, failed = 0;
    for(const it of items){
      if(!it.partId || !it.topicAr){ failed++; continue; }
      const key = `${it.partId}::${String(it.topicAr).trim()}`;
      if(existingSet.has(key)){ skipped++; continue; }
      const saved = await addWritingTopicToBackend(it.partId, it.topicAr);
      if(saved){ inserted++; existingSet.add(key); } else { failed++; }
    }

    await refreshKitabaFromBackend();
    renderAdminQuestions();
    let msg = `✅ "${skillName}" uchun import tugadi: ${inserted} ta qo'shildi, ${skipped} ta takroriy o'tkazib yuborildi`;
    if(failed > 0) msg += `, ⚠️ ${failed} ta yuborilmadi (xato: ${window.LAST_BACKEND_ERROR})`;
    toast(msg, 9000);
    return;
  }

  /* ---- Qiroa import ("qiroa_texts_v1") — har bir matn + unga bog'liq savollar ---- */
  if(format === 'qiroa_texts_v1'){
    if(targetSkill !== 'qiroa'){
      toast(`❌ Bu fayl "O'qish" bo'limi uchun — avval admin panelda "O'qish" bo'limini tanlang`, 8000);
      return;
    }
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    if(!items.length){ toast('❌ Faylda matnlar topilmadi ("items" massivi kerak)', 6000); return; }
    const ok = await showLiquidConfirm({
      title: "Matnlarni import qilish",
      message: `Faylda "${skillName}" bo'limi uchun ${items.length} ta matn topildi.`,
      subtext: "Ularni bazaga qayta yuklaymizmi? (Bir xil juz + bir xil matn allaqachon mavjud bo'lsa, o'tkazib yuboriladi)",
      confirmLabel: "Yuklash",
      cancelLabel: "Bekor qilish",
      isDanger: false,
      icon: "📥"
    });
    if(!ok) return;

    const existingTexts = await loadQiroaTextsFromBackend();
    const existingSet = new Set((existingTexts||[]).map(r => `${r.juz_id}::${(r.passage||'').trim()}`));

    let textsAdded = 0, textsSkipped = 0, textsFailed = 0, qInserted = 0, qFailed = 0;
    toast(`⏳ ${items.length} ta matn yaratilmoqda...`);
    for(const it of items){
      if(!it.juzId || !it.passage){ textsFailed++; continue; }
      const key = `${it.juzId}::${String(it.passage).trim()}`;
      if(existingSet.has(key)){ textsSkipped++; continue; }

      const savedText = await addQiroaTextToBackend(it.juzId, it.passage, it.title || '');
      if(!savedText){ textsFailed++; continue; }
      const testId = Array.isArray(savedText) ? savedText[0]?.id : savedText?.id;
      if(!testId){ textsFailed++; continue; }
      textsAdded++;
      existingSet.add(key);

      const qRows = Array.isArray(it.questions) ? it.questions : [];
      if(qRows.length){
        const qItems = qRows
          .filter(row => row.q && Array.isArray(row.opts))
          .map(row => ({ skillId: 'qiroa', topicId: testId, q: row.q, opts: row.opts, a: (typeof row.a === 'number' ? row.a : row.correct_index), exp: row.exp || '' }));
        if(qItems.length){
          const result = await saveQuestionsBulkWithTopicsToBackend(qItems);
          if(result){ qInserted += result.inserted_count ?? qItems.length; }
          else { qFailed += qItems.length; }
        }
      }
    }

    await refreshQiroaFromBackend();
    renderAdminQuestions();
    let msg = `✅ "${skillName}" uchun import tugadi: ${textsAdded} ta matn qo'shildi (${qInserted} ta savol bilan), ${textsSkipped} ta takroriy matn o'tkazib yuborildi`;
    if(textsFailed > 0 || qFailed > 0) msg += `, ⚠️ ${textsFailed} ta matn / ${qFailed} ta savol yuborilmadi (xato: ${window.LAST_BACKEND_ERROR})`;
    toast(msg, 10000);
    return;
  }

  /* ---- Istima import ("istima_audio_v1") — har bir audio-test + unga bog'liq savollar ---- */
  if(format === 'istima_audio_v1'){
    if(targetSkill !== 'istima'){
      toast(`❌ Bu fayl "Tinglash" bo'limi uchun — avval admin panelda "Tinglash" bo'limini tanlang`, 8000);
      return;
    }
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    if(!items.length){ toast('❌ Faylda audio-testlar topilmadi ("items" massivi kerak)', 6000); return; }
    const ok = await showLiquidConfirm({
      title: "Audio-testlarni import qilish",
      message: `Faylda "${skillName}" bo'limi uchun ${items.length} ta audio-test topildi.`,
      subtext: "Ularni bazaga qayta yuklaymizmi? (Bir xil juz + bir xil audio URL allaqachon mavjud bo'lsa, o'tkazib yuboriladi)",
      confirmLabel: "Yuklash",
      cancelLabel: "Bekor qilish",
      isDanger: false,
      icon: "📥"
    });
    if(!ok) return;

    const existingAudios = await loadIstimaAudioFromBackend();
    const existingSet = new Set((existingAudios||[]).map(r => `${r.juz_id}::${(r.audio_url||'').trim()}`));

    let audiosAdded = 0, audiosSkipped = 0, audiosFailed = 0, qInserted = 0, qFailed = 0;
    toast(`⏳ ${items.length} ta audio-test yaratilmoqda...`);
    for(const it of items){
      if(!it.juzId || !it.audioUrl){ audiosFailed++; continue; }
      const key = `${it.juzId}::${String(it.audioUrl).trim()}`;
      if(existingSet.has(key)){ audiosSkipped++; continue; }

      const savedAudio = await addIstimaAudioToBackend(it.juzId, it.audioUrl);
      if(!savedAudio){ audiosFailed++; continue; }
      const testId = Array.isArray(savedAudio) ? savedAudio[0]?.id : savedAudio?.id;
      if(!testId){ audiosFailed++; continue; }
      audiosAdded++;
      existingSet.add(key);

      const qRows = Array.isArray(it.questions) ? it.questions : [];
      if(qRows.length){
        const qItems = qRows
          .filter(row => row.q && Array.isArray(row.opts))
          .map(row => ({ skillId: 'istima', topicId: testId, q: row.q, opts: row.opts, a: (typeof row.a === 'number' ? row.a : row.correct_index), exp: row.exp || '' }));
        if(qItems.length){
          const result = await saveQuestionsBulkWithTopicsToBackend(qItems);
          if(result){ qInserted += result.inserted_count ?? qItems.length; }
          else { qFailed += qItems.length; }
        }
      }
    }

    await refreshIstimaFromBackend();
    renderAdminQuestions();
    let msg = `✅ "${skillName}" uchun import tugadi: ${audiosAdded} ta audio-test qo'shildi (${qInserted} ta savol bilan), ${audiosSkipped} ta takroriy o'tkazib yuborildi`;
    if(audiosFailed > 0 || qFailed > 0) msg += `, ⚠️ ${audiosFailed} ta audio / ${qFailed} ta savol yuborilmadi (xato: ${window.LAST_BACKEND_ERROR})`;
    toast(msg, 10000);
    return;
  }

  /* ---- Grammatika (va eski formatdagi barcha fayllar) — "questions" jadvali orqali ---- */
  const rows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.questions) ? parsed.questions : null);
  if(!rows || !rows.length){
    toast('❌ Faylda savollar topilmadi ("questions" massivi kerak)', 6000);
    return;
  }

  const matching = rows.filter(row => (row.skillId || row.skill_id) === targetSkill);
  const foreignCount = rows.length - matching.length;

  if(!matching.length){
    toast(`❌ Faylda "${skillName}" bo'limiga tegishli savol topilmadi (fayl boshqa bo'lim uchun bo'lishi mumkin — avval to'g'ri bo'limni tanlang)`, 8000);
    return;
  }

  let confirmSubtext = "(Allaqachon mavjud bo'lgan savollar avtomatik o'tkazib yuboriladi, takrorlanmaydi)";
  if(foreignCount > 0){
    confirmSubtext += `\n\n⚠️ Diqqat: faylda yana ${foreignCount} ta boshqa bo'limlarga tegishli savol bor — joriy bo'lim ("${skillName}") tanlanganligi sababli ular IMPORT QILINMAYDI.`;
  }
  const ok = await showLiquidConfirm({
    title: "Savollarni import qilish",
    message: `Faylda "${skillName}" bo'limiga tegishli ${matching.length} ta savol topildi. Ularni bazaga qayta yuklaymizmi?`,
    subtext: confirmSubtext,
    confirmLabel: "Yuklash",
    cancelLabel: "Bekor qilish",
    isDanger: false,
    icon: "📥"
  });
  if(!ok) return;

  const items = matching.map(row => ({
    skillId: row.skillId || row.skill_id,
    topicId: row.topicId || null,
    topicName: row.topic || row.topicName || null,
    topicAr: row.topicAr || null,
    category: row.category || null,
    q: row.q, opts: row.opts, a: (typeof row.a === 'number' ? row.a : row.correct_index),
    exp: row.exp || '',
  })).filter(it => it.skillId && it.q && Array.isArray(it.opts));

  if(!items.length){
    toast('❌ Faylda yaroqli savollar topilmadi', 6000);
    return;
  }

  toast(`⏳ ${items.length} ta savol yuklanmoqda...`);

  // Katta fayllarda backend timeout bo'lmasligi uchun bo'lib-bo'lib (chunklab) yuboramiz.
  const CHUNK = 150;
  let totalInserted = 0, totalSkipped = 0, failed = 0;
  for(let i=0; i<items.length; i+=CHUNK){
    const chunk = items.slice(i, i+CHUNK);
    const result = await saveQuestionsBulkWithTopicsToBackend(chunk);
    if(result){
      totalInserted += result.inserted_count ?? 0;
      totalSkipped += result.skipped_count ?? 0;
    } else {
      failed += chunk.length;
    }
  }

  let msg = `✅ "${skillName}" uchun import tugadi: ${totalInserted} ta qo'shildi, ${totalSkipped} ta takroriy o'tkazib yuborildi`;
  if(foreignCount > 0) msg += `, ${foreignCount} ta boshqa bo'limga tegishli savol e'tiborga olinmadi`;
  if(failed > 0) msg += `, ⚠️ ${failed} ta yuborilmadi (xato: ${window.LAST_BACKEND_ERROR})`;
  toast(msg, 9000);

  const liveTopics = await loadGrammarTopicsFromBackend();
  applyLiveGrammarTopics(liveTopics);
  await refreshQiroaFromBackend();
  renderAdminQuestions();
}


/* Mavjud savolni tahrirlash — Supabase'da `admin_edit_question` RPC funksiyasi talab qilinadi. */
async function updateQuestionOnBackend({id, q, opts, a, exp}){
  if(!SESSION_TOKEN || !id){ setLastBackendError('—', 'SESSION_TOKEN yoki id yo\'q'); return null; }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_edit_question`, {
      method:"POST", headers: authHeaders(),
      body: JSON.stringify({ p_id: id, p_q: q, p_opts: opts, p_correct: a, p_exp: exp||null })
    });
    if(!res.ok){ setLastBackendError(res.status, await res.text()); return null; }
    SmartCache.invalidate('questions');
    const text = await res.text();
    return text ? JSON.parse(text) : true;
  }catch(e){ setLastBackendError('—', e.message); return null; }
}
/* Savolni o'chirish — Supabase'da `admin_delete_question` RPC funksiyasi talab qilinadi. */
async function deleteQuestionOnBackend(id){
  if(!SESSION_TOKEN || !id){ setLastBackendError('—', 'SESSION_TOKEN yoki id yo\'q'); return false; }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_delete_question`, {
      method:"POST", headers: authHeaders(),
      body: JSON.stringify({ p_id: id })
    });
    if(!res.ok){ setLastBackendError(res.status, await res.text()); return false; }
    SmartCache.invalidate('questions');
    return true;
  }catch(e){ setLastBackendError('—', e.message); return false; }
}
/* Savollar tartibini saqlash — Supabase'da `admin_reorder_questions` RPC funksiyasi
   talab qilinadi (p_ids — tartib bo'yicha id'lar ro'yxati). */
async function reorderQuestionsOnBackend(orderedIds){
  if(!SESSION_TOKEN || !orderedIds?.length){ setLastBackendError('—', 'SESSION_TOKEN yoki id ro\'yxati yo\'q'); return false; }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_reorder_questions`, {
      method:"POST", headers: authHeaders(),
      body: JSON.stringify({ p_ids: orderedIds })
    });
    if(!res.ok){ setLastBackendError(res.status, await res.text()); return false; }
    SmartCache.invalidate('questions');
    return true;
  }catch(e){ setLastBackendError('—', e.message); return false; }
}

/* Grammatika mavzulari — hammasi uchun umumiy (Supabase "grammar_topics" jadvali).
   EGRESS OPTIMIZATSIYASI: 15 daqiqa SmartCache bilan keshlanadi. */
async function loadGrammarTopicsFromBackend(forceRefresh = false){
  if(!forceRefresh){
    const cached = SmartCache.get('grammar_topics');
    if(cached) return cached;
  }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/grammar_topics?select=id,category,name,ar&order=order_index.asc.nullslast,created_at.asc`, { headers: authHeaders() });
    if(!res.ok) return [];
    const data = await res.json();
    if(Array.isArray(data)){
      SmartCache.set('grammar_topics', data);
    }
    return data;
  }catch(e){ console.error(e); return []; }
}
async function saveGrammarTopicToBackend({category, name, ar}){
  if(!SESSION_TOKEN){ setLastBackendError('—', 'SESSION_TOKEN yo\'q'); return null; }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_add_grammar_topic`, {
      method:"POST", headers: authHeaders(),
      body: JSON.stringify({ p_category: category, p_name: name, p_ar: ar })
    });
    if(!res.ok){ setLastBackendError(res.status, await res.text()); return null; }
    SmartCache.invalidate('grammar_topics');
    const text = await res.text();
    return text ? JSON.parse(text) : true;
  }catch(e){ setLastBackendError('—', e.message); return null; }
}
async function updateGrammarTopicOnBackend({id, category, name, ar}){
  if(!SESSION_TOKEN || !id){ setLastBackendError('—', 'SESSION_TOKEN yoki id yo\'q'); return null; }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_edit_grammar_topic`, {
      method:"POST", headers: authHeaders(),
      body: JSON.stringify({ p_id: id, p_category: category, p_name: name, p_ar: ar })
    });
    if(!res.ok){ setLastBackendError(res.status, await res.text()); return null; }
    SmartCache.invalidate('grammar_topics');
    const text = await res.text();
    return text ? JSON.parse(text) : true;
  }catch(e){ setLastBackendError('—', e.message); return null; }
}
async function deleteGrammarTopicOnBackend(id){
  if(!SESSION_TOKEN || !id){ setLastBackendError('—', 'SESSION_TOKEN yoki id yo\'q'); return false; }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_delete_grammar_topic`, {
      method:"POST", headers: authHeaders(),
      body: JSON.stringify({ p_id: id })
    });
    if(!res.ok){ setLastBackendError(res.status, await res.text()); return false; }
    SmartCache.invalidate('grammar_topics');
    return true;
  }catch(e){ setLastBackendError('—', e.message); return false; }
}
async function reorderGrammarTopicsOnBackend(orderedIds){
  if(!SESSION_TOKEN || !orderedIds?.length){ setLastBackendError('—', 'SESSION_TOKEN yoki id ro\'yxati yo\'q'); return false; }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_reorder_grammar_topics`, {
      method:"POST", headers: authHeaders(),
      body: JSON.stringify({ p_ids: orderedIds })
    });
    if(!res.ok){ setLastBackendError(res.status, await res.text()); return false; }
    SmartCache.invalidate('grammar_topics');
    return true;
  }catch(e){ setLastBackendError('—', e.message); return false; }
}
/* Kitaba (Yozma) mavzulari — 3 qism, har biri uchun alohida mavzular banki
   EGRESS OPTIMIZATSIYASI: 15 daqiqa SmartCache bilan keshlanadi. */
async function loadWritingTopicsFromBackend(forceRefresh = false){
  if(!forceRefresh){
    const cached = SmartCache.get('writing_topics');
    if(cached) return cached;
  }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/writing_topics?select=id,part_id,topic_ar&order=part_id.asc,created_at.asc`, { headers: authHeaders() });
    if(!res.ok) return [];
    const data = await res.json();
    if(Array.isArray(data)){
      SmartCache.set('writing_topics', data);
    }
    return data;
  }catch(e){ console.error(e); return []; }
}
async function addWritingTopicToBackend(partId, topicAr){
  if(!SESSION_TOKEN){ setLastBackendError('—', 'SESSION_TOKEN yo\'q (Telegram orqali kirilmagan)'); return null; }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_add_writing_topic`, {
      method:"POST", headers: authHeaders(),
      body: JSON.stringify({ p_part_id: partId, p_topic_ar: topicAr })
    });
    if(!res.ok){ setLastBackendError(res.status, await res.text()); return null; }
    SmartCache.invalidate('writing_topics');
    const text = await res.text();
    return text ? JSON.parse(text) : true;
  }catch(e){ setLastBackendError('—', e.message); return null; }
}
async function editWritingTopicOnBackend(id, topicAr){
  if(!SESSION_TOKEN){ setLastBackendError('—', 'SESSION_TOKEN yo\'q (Telegram orqali kirilmagan)'); return null; }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_edit_writing_topic`, {
      method:"POST", headers: authHeaders(),
      body: JSON.stringify({ p_topic_id: id, p_topic_ar: topicAr })
    });
    if(!res.ok){ setLastBackendError(res.status, await res.text()); return null; }
    SmartCache.invalidate('writing_topics');
    const text = await res.text();
    return text ? JSON.parse(text) : true;
  }catch(e){ setLastBackendError('—', e.message); return null; }
}
async function deleteWritingTopicOnBackend(id){
  if(!SESSION_TOKEN){ setLastBackendError('—', 'SESSION_TOKEN yo\'q (Telegram orqali kirilmagan)'); return null; }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_delete_writing_topic`, {
      method:"POST", headers: authHeaders(),
      body: JSON.stringify({ p_topic_id: id })
    });
    if(!res.ok){ setLastBackendError(res.status, await res.text()); return null; }
    SmartCache.invalidate('writing_topics');
    const text = await res.text();
    return text ? JSON.parse(text) : true;
  }catch(e){ setLastBackendError('—', e.message); return null; }
}
async function loadAdminUsersFromBackend(){
  if(!SESSION_TOKEN) return [];
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_list_users`, {
      method:"POST", headers: authHeaders(), body: JSON.stringify({})
    });
    return res.ok ? await res.json() : [];
  }catch(e){ console.error(e); return []; }
}

function hasArabicText(str){
  if(!str) return false;
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(str);
}

function renderGreetingFromProfile(){
  let firstName = '';
  if (TELEGRAM_PROFILE.name && TELEGRAM_PROFILE.name !== 'Mehmon' && TELEGRAM_PROFILE.name !== 'Foydalanuvchi') {
    // Foydalanuvchi profilida o'zi kiritgan nik (masalan "أبو مريم" kabi ikki
    // so'zli kunya) bo'lishi mumkin — shuning uchun bo'sh joy bo'yicha bo'lib,
    // faqat birinchi so'zni olish emas, to'liq nomni ko'rsatamiz.
    firstName = TELEGRAM_PROFILE.name.trim();
  } else if (window.Telegram?.WebApp?.initDataUnsafe?.user?.first_name) {
    firstName = window.Telegram.WebApp.initDataUnsafe.user.first_name.trim();
  } else if (TELEGRAM_PROFILE.username) {
    firstName = TELEGRAM_PROFILE.username.replace(/^@/, '').trim();
  }

  const nameFont = hasArabicText(firstName) ? "'Graphik Arabic', 'Noto Sans Arabic', sans-serif" : "'Onest', sans-serif";

  const dashGreeting = document.getElementById('dashGreetingName');
  if(dashGreeting) {
    dashGreeting.style.fontFamily = "";
    if(firstName){
      dashGreeting.innerHTML = `Assalamu alaykum <span style="font-family:${nameFont};">${escapeHtml(firstName)}</span>!`;
    } else {
      dashGreeting.textContent = `Assalamu alaykum!`;
    }
  }

  const dashAvatar = document.getElementById('dashUserAvatar');
  if(dashAvatar) dashAvatar.innerHTML = avatarContent();

  const gName = document.getElementById('greetingName');
  if(gName) {
    gName.style.fontFamily = "";
    if(firstName){
      gName.innerHTML = `Assalomu alaykum, <span style="font-family:${nameFont};">${escapeHtml(firstName)}</span>! 👋`;
    } else {
      gName.textContent = `Assalomu alaykum! 👋`;
    }
  }

  const topAvatar = document.getElementById('topAvatar');
  if(topAvatar) topAvatar.innerHTML = avatarContent();
  const sbAvatar = document.getElementById('sidebarUserAvatar');
  if(sbAvatar) sbAvatar.innerHTML = avatarContent();
  const sbName = document.getElementById('sidebarUserName');
  const pa = document.getElementById('profileAvatar');
  if(pa) pa.innerHTML = avatarContent();
  const pn = document.getElementById('profileName');
  const displayName = TELEGRAM_PROFILE.name || (firstName || 'Foydalanuvchi');
  if(pn) {
    pn.textContent = displayName;
    pn.style.fontFamily = hasArabicText(displayName) ? "'Graphik Arabic', 'Noto Sans Arabic', sans-serif" : "'Onest', sans-serif";
  }
  if(sbName) {
    sbName.textContent = displayName;
    sbName.style.fontFamily = hasArabicText(displayName) ? "'Graphik Arabic', 'Noto Sans Arabic', sans-serif" : "'Onest', sans-serif";
  }
  const pUsername = document.getElementById('profileUsername');
  if(pUsername){
    let uName = TELEGRAM_PROFILE.username;
    if(!uName || uName.trim() === '' || uName === '-'){
      pUsername.textContent = 'username: hozircha mavjud emas';
    } else {
      if(!uName.startsWith('@')) uName = '@' + uName;
      pUsername.textContent = `username: ${uName}`;
    }
  }
  const pId = document.getElementById('profileId');
  if(pId){
    const uid = (TELEGRAM_PROFILE.id && TELEGRAM_PROFILE.id !== '-') ? TELEGRAM_PROFILE.id : (TELEGRAM_PROFILE.rawId || '-');
    pId.textContent = `ID: ${uid}`;
  }

  const isAdmin = !!(TELEGRAM_PROFILE.rawId && ADMIN_TELEGRAM_IDS.includes(TELEGRAM_PROFILE.rawId));
  showDebug(`ℹ️ rawId=${TELEGRAM_PROFILE.rawId} (${typeof TELEGRAM_PROFILE.rawId}), ADMIN_TELEGRAM_IDS=[${ADMIN_TELEGRAM_IDS.join(',')}], isAdmin=${isAdmin}`);
  // Hardcoded ro'yxatdagi adminlar uchun tugmalar darhol (kechikishsiz) ko'rinadi.
  showAdminButtons(isAdmin);
  // Faqat ADMIN_TELEGRAM_IDS ro'yxatidagilar "bosh admin" (super admin) hisoblanadi —
  // faqat ular boshqa adminlarni qo'sha/o'chira/olib tashlay oladi.
  setSuperAdminUI(isAdmin);
}

async function bootApp(){
  // Savollar banki keshi: internet/serverdan javob kelguncha, oldingi safar
  // saqlangan savollar shu yerda darhol qo'llaniladi. Shu tufayli foydalanuvchi
  // ilovani ochgan zahoti biror mahoratga kirsa ham, "hali savol yo'q" degan
  // xato ko'rinmaydi — pastda haqiqiy (yangi) ma'lumot kelgach avtomatik yangilanadi.
  try{
    const cachedQuestions = JSON.parse(localStorage.getItem('arab_questions_cache_v1') || 'null');
    if(Array.isArray(cachedQuestions) && cachedQuestions.length) applyLiveQuestions(cachedQuestions);
  }catch(e){}
  const user = await tgInitAndAuth();
  const tgUser = window.Telegram?.WebApp?.initDataUnsafe?.user;
  const savedPhoto = (function(){ try { return localStorage.getItem('arabication_saved_photo_url'); }catch(e){ return null; } })();
  const tgPhoto = (user && user.photo_url) || tgUser?.photo_url || savedPhoto || null;

  if(user){
    TELEGRAM_PROFILE = {
      name: [user.first_name, user.last_name].filter(Boolean).join(' ') || (tgUser ? [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ') : 'Foydalanuvchi'),
      username: user.username ? `@${user.username}` : (tgUser?.username ? `@${tgUser.username}` : ''),
      id: String(user.id || tgUser?.id || ''),
      rawId: user.id || tgUser?.id || null,
      photoUrl: tgPhoto,
    };
  } else {
    // Telegram tashqarisida yoki to'g'ridan-to'g'ri brauzerda ochilganda (Mehmon rejimi)
    if(tgUser){
      TELEGRAM_PROFILE = {
        name: [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ') || 'Foydalanuvchi',
        username: tgUser.username ? `@${tgUser.username}` : '',
        id: String(tgUser.id),
        rawId: tgUser.id,
        photoUrl: tgPhoto,
      };
    } else {
      TELEGRAM_PROFILE = {
        name: 'Mehmon',
        username: '',
        id: '',
        rawId: null,
        photoUrl: tgPhoto,
        gender: 'unspecified'
      };
    }
    if(!SESSION_TOKEN) SESSION_TOKEN = SUPABASE_ANON_KEY;
  }
  if(TELEGRAM_PROFILE.photoUrl){
    try{ localStorage.setItem('arabication_saved_photo_url', TELEGRAM_PROFILE.photoUrl); }catch(e){}
  }
  try{
    const savedName = localStorage.getItem('arabication_custom_name');
    if(savedName && savedName.trim()){
      TELEGRAM_PROFILE.name = savedName.trim();
    }
    const savedGender = localStorage.getItem('arabication_user_gender');
    if(savedGender){
      TELEGRAM_PROFILE.gender = savedGender;
    }
  }catch(e){}
  renderGreetingFromProfile();
  applyProfileHeader(null);
  try{ checkPendingDuelInvite(); }catch(e){ console.error('[checkPendingDuelInvite]', e); }

  async function safeBootStep(label, fn){
    try{ await fn(); }
    catch(e){
      console.error(`[bootApp] "${label}" bosqichida xato:`, e);
      toast(`⚠️ "${label}" yuklanmadi: ${(e && e.message) || e}`, 7000);
    }
  }

  // Onboarding holatini endi localStorage'dan emas, shu yerda bir marta yuklanadigan
  // dashboard javobidan (get_user_dashboard RPC, onboarding_completed/display_name/gender
  // maydonlari) olamiz — shu sababli qo'shimcha Supabase so'rovi (egress) qo'shilmaydi.
  let __dashForOnboarding = null;
  if(TELEGRAM_PROFILE.rawId){
    await safeBootStep('Dashboard', async ()=>{
      const dash = await loadDashboardFromBackend(TELEGRAM_PROFILE.rawId);
      __dashForOnboarding = dash;
      applyBackendSkillScores(dash);
      applyProfileStats(dash);
      applyProfileHeader(dash);
      if(dash && dash.display_name && dash.display_name.trim()){
        TELEGRAM_PROFILE.name = dash.display_name.trim();
      }
      if(dash && dash.gender){
        TELEGRAM_PROFILE.gender = dash.gender;
      }
      // Rasmni yashirish sozlamasini backenddagi haqiqiy qiymat (users.show_avatar) bilan
      // sinxronlaymiz va endi TELEGRAM_PROFILE.rawId ma'lum bo'lgani uchun shu foydalanuvchiga
      // xos (namespaced) kalitga qayta yozamiz — shu qurilmada boshqa akkauntdan qolgan eski
      // qiymat bu foydalanuvchiga ta'sir qilmasligi uchun.
      try{
        const dashShowAvatar = pick(dash || {}, ['show_avatar','show_photo','avatar_visible'], null);
        if(dashShowAvatar !== null){
          const onOff = (dashShowAvatar === false || dashShowAvatar === 'off' || dashShowAvatar === 'false') ? 'off' : 'on';
          localStorage.setItem(avatarSettingKey(), onOff);
        }
      }catch(e){}
      applyAvatarSetting();
      renderGreetingFromProfile();
      const sub = document.getElementById('greetingSub');
      if(sub && dash) sub.textContent = `Bugungi maqsadingizga ${dash.daily_pct ?? 0}% yetdingiz.`;
    });

    await safeBootStep('Tarix/xatolar', async ()=>{
      window.HISTORY_DATA_LIVE = await loadHistoryFromBackend(TELEGRAM_PROFILE.rawId);
      window.USER_ERRORS_LIVE = await loadErrorsFromBackend(TELEGRAM_PROFILE.rawId);
      applyLiveHistory();
      applyLiveErrors();
    });
  }

  // Umumiy (barcha foydalanuvchilar va mehmonlar uchun) kontentlar:
  await safeBootStep('Reyting', async ()=>{
    const lb = await loadLeaderboardFromBackend();
    applyLiveLeaderboard(lb);
  });

  await safeBootStep('Grammatika mavzulari', async ()=>{
    const liveTopics = await loadGrammarTopicsFromBackend();
    applyLiveGrammarTopics(liveTopics);
  });

  await safeBootStep('Savollar banki', async ()=>{
    const liveQuestions = await loadQuestionsFromBackend();
    applyLiveQuestions(liveQuestions);
  });

  await safeBootStep('Mock testlar', async ()=>{
    const liveMocks = await loadMocksFromBackend();
    if(liveMocks) applyLiveMocks(liveMocks);
  });

  await safeBootStep('Qiroa', refreshQiroaFromBackend);
  await safeBootStep('Istima', refreshIstimaFromBackend);
  await safeBootStep('Muhavara', refreshSpeakingFromBackend);
  await safeBootStep('Kitaba', refreshKitabaFromBackend);

  if(TELEGRAM_PROFILE.rawId){
    await safeBootStep('Lug\'atim (Flashcard)', syncVocabularyFromBackend);

    await safeBootStep('Admin huquqi', async ()=>{
      if(ADMIN_TELEGRAM_IDS.includes(TELEGRAM_PROFILE.rawId)){
        const liveAdminUsers = await loadAdminUsersFromBackend();
        applyLiveAdminUsers(liveAdminUsers);
        loadExamReportsFromBackend().then(rows => {
          rawExamReportsData = (Array.isArray(rows) ? rows : []).map(r => ({
            id: r.id || null,
            userId: r.user_id || r.userId || null,
            type: r.exam_type || r.type || 'Noma\u2018lum',
            date: r.exam_date || r.date || '',
            center: r.center || '',
            sections: Array.isArray(r.sections) ? r.sections : (r.sections ? [r.sections] : []),
            seat: r.seat || '',
            text: r.report_text || r.text || '',
            rawCreatedAt: r.created_at || '',
            submittedAt: r.created_at ? new Date(r.created_at).toLocaleString('uz-UZ') : '',
            name: r.name || 'Noma\u2018lum foydalanuvchi',
            username: (r.username || '').replace(/^@+/, ''),
          }));
          updateAdminReportsBadge();
        }).catch(()=>{});
      } else {
        const isBackendAdmin = await checkBackendAdminAccess(TELEGRAM_PROFILE.rawId);
        if(isBackendAdmin){
          showAdminButtons(true);
          const liveAdminUsers = await loadAdminUsersFromBackend();
          applyLiveAdminUsers(liveAdminUsers);
          loadExamReportsFromBackend().then(rows => {
            rawExamReportsData = (Array.isArray(rows) ? rows : []).map(r => ({
              id: r.id || null,
              userId: r.user_id || r.userId || null,
              type: r.exam_type || r.type || 'Noma\u2018lum',
              date: r.exam_date || r.date || '',
              center: r.center || '',
              sections: Array.isArray(r.sections) ? r.sections : (r.sections ? [r.sections] : []),
              seat: r.seat || '',
              text: r.report_text || r.text || '',
              rawCreatedAt: r.created_at || '',
              submittedAt: r.created_at ? new Date(r.created_at).toLocaleString('uz-UZ') : '',
              name: r.name || 'Noma\u2018lum foydalanuvchi',
              username: (r.username || '').replace(/^@+/, ''),
            }));
            updateAdminReportsBadge();
          }).catch(()=>{});
        }
      }
    });
  }
  window.APP_READY = true;
  renderDashboardPracticeCards();
  checkOnboardingRegistration(__dashForOnboarding);
}

/* ---------------- Theme (dark / light) ---------------- */
function applyTheme(theme){
  document.documentElement.setAttribute('data-theme', theme);
  const sw = document.getElementById('themeSettingSwitch');
  const sub = document.getElementById('themeSettingSub');
  if(sw) sw.checked = (theme==='light');
  if(sub) sub.textContent = theme==='light' ? "Yorug' mavzu" : "Qorong'i mavzu";
  const drPage = document.getElementById('drPage');
  if(drPage){
    const isDark = theme !== 'light';
    const type = drPage.querySelector('.dr-title.dr-victory') ? 'victory' : 'defeat';
    drPage.classList.toggle('dr-dark', isDark);
    const meshEl = document.getElementById('drMesh');
    if(meshEl){ meshEl.innerHTML = drBuildMesh(type, isDark, Math.max(drPage.clientWidth||0, 320)); }
  }
}
function toggleTheme(){
  const current = document.documentElement.getAttribute('data-theme')==='light' ? 'light' : 'dark';
  const next = current==='light' ? 'dark' : 'light';
  try{ localStorage.setItem('arabication-theme', next); }catch(e){}
  applyTheme(next);
  toast(next==='light' ? "Yorug' mavzu yoqildi ☀️" : "Qorong'i mavzu yoqildi 🌙");
}
(function initTheme(){
  let saved = null;
  try{ saved = localStorage.getItem('arabication-theme'); }catch(e){}
  applyTheme(saved==='light' ? 'light' : 'dark');
})();
(function initAvatarSetting(){
  applyAvatarSetting();
})();

/* ---------------- Ilova xavfsizlik paroli (6 xonali PIN / App Lock) ---------------- */
let APP_LOCK_PIN_BUFFER = "";

function getStoredAppPasscode(){
  try{
    const p = localStorage.getItem('arabication_app_passcode');
    return (p && /^\d{6}$/.test(p.trim())) ? p.trim() : null;
  }catch(e){
    return null;
  }
}

function updatePasscodeStatusText(){
  const sub = document.getElementById('passcodeSettingSub');
  if(!sub) return;
  const pass = getStoredAppPasscode();
  if(pass){
    sub.innerHTML = '<span style="color:var(--green);font-weight:600;">🔒 Faol o‘rnatilgan (6 xonali)</span>';
  } else {
    sub.textContent = "O'rnatilmagan";
  }
}

function renderLockDots(){
  const container = document.getElementById('appLockDots');
  if(!container) return;
  const dots = container.querySelectorAll('.pin-dot');
  dots.forEach((dot, idx) => {
    if(idx < APP_LOCK_PIN_BUFFER.length){
      dot.classList.add('filled');
      dot.textContent = '●';
    } else {
      dot.classList.remove('filled');
      dot.textContent = '';
    }
  });
}

function checkAppLockOnStartup(){
  const pass = getStoredAppPasscode();
  const overlay = document.getElementById('appLockOverlay');
  if(!overlay) return;
  
  if(pass){
    APP_LOCK_PIN_BUFFER = "";
    overlay.style.display = 'flex';
    overlay.classList.remove('unlocking');
    const err = document.getElementById('appLockError');
    if(err) { err.textContent = ''; err.style.display = 'none'; }
    renderLockDots();
  } else {
    overlay.style.display = 'none';
  }
  updatePasscodeStatusText();
}

function handleLockKeyInput(digit){
  if(!/^\d$/.test(digit)) return;
  if(APP_LOCK_PIN_BUFFER.length >= 6) return;

  APP_LOCK_PIN_BUFFER += digit;
  renderLockDots();

  const err = document.getElementById('appLockError');
  if(err) { err.textContent = ''; err.style.display = 'none'; }

  if(APP_LOCK_PIN_BUFFER.length === 6){
    setTimeout(verifyAppUnlock, 120);
  }
}

function handleLockKeyBackspace(){
  if(APP_LOCK_PIN_BUFFER.length > 0){
    APP_LOCK_PIN_BUFFER = APP_LOCK_PIN_BUFFER.slice(0, -1);
    renderLockDots();
    const err = document.getElementById('appLockError');
    if(err) { err.textContent = ''; err.style.display = 'none'; }
  }
}

function handleLockKeyClear(){
  APP_LOCK_PIN_BUFFER = "";
  renderLockDots();
  const err = document.getElementById('appLockError');
  if(err) { err.textContent = ''; err.style.display = 'none'; }
}

function verifyAppUnlock(){
  const pass = getStoredAppPasscode();
  const overlay = document.getElementById('appLockOverlay');
  const card = document.getElementById('appLockCard');
  const err = document.getElementById('appLockError');

  if(!pass){
    if(overlay) overlay.style.display = 'none';
    return;
  }

  if(APP_LOCK_PIN_BUFFER === pass){
    if(err) { err.textContent = ''; err.style.display = 'none'; }
    if(overlay){
      overlay.classList.add('unlocking');
      setTimeout(()=>{
        overlay.style.display = 'none';
        overlay.classList.remove('unlocking');
        APP_LOCK_PIN_BUFFER = "";
        renderLockDots();
      }, 240);
    }
  } else {
    if(err){
      err.textContent = "PIN kod noto‘g‘ri. Qayta urinib ko‘ring.";
      err.style.display = 'block';
    }
    if(card){
      card.classList.remove('shake-anim');
      void card.offsetWidth;
      card.classList.add('shake-anim');
      setTimeout(()=>{ card.classList.remove('shake-anim'); }, 450);
    }
    APP_LOCK_PIN_BUFFER = "";
    renderLockDots();
  }
}

/* Modal PIN Keypad State */
let MODAL_PIN_MODE = 'setup'; // 'setup' | 'change' | 'remove'
let MODAL_PIN_STEP = 1;
let MODAL_PIN_BUFFER = "";
let MODAL_TEMP_PIN = "";
let MODAL_CURR_VERIFIED = false;

function openPasscodeSettingsModal(){
  const overlay = document.getElementById('passcodeModalOverlay');
  if(!overlay) return;

  const currentPass = getStoredAppPasscode();
  MODAL_PIN_MODE = currentPass ? 'change' : 'setup';
  MODAL_PIN_STEP = 1;
  MODAL_PIN_BUFFER = "";
  MODAL_TEMP_PIN = "";
  MODAL_CURR_VERIFIED = false;

  renderPasscodeModalContent();
  overlay.style.display = 'flex';
}

function closePasscodeModal(){
  const overlay = document.getElementById('passcodeModalOverlay');
  if(overlay) overlay.style.display = 'none';
  MODAL_PIN_BUFFER = "";
  MODAL_TEMP_PIN = "";
  updatePasscodeStatusText();
}

function switchPasscodeTab(mode){
  MODAL_PIN_MODE = mode;
  MODAL_PIN_STEP = 1;
  MODAL_PIN_BUFFER = "";
  MODAL_TEMP_PIN = "";
  MODAL_CURR_VERIFIED = false;
  renderPasscodeModalContent();
}

function renderModalDots(){
  const container = document.getElementById('modalPinDots');
  if(!container) return;
  const dots = container.querySelectorAll('.pin-dot');
  dots.forEach((dot, idx) => {
    if(idx < MODAL_PIN_BUFFER.length){
      dot.classList.add('filled');
      dot.textContent = '●';
    } else {
      dot.classList.remove('filled');
      dot.textContent = '';
    }
  });
}

function getModalStepInfo(){
  if(MODAL_PIN_MODE === 'setup'){
    if(MODAL_PIN_STEP === 1){
      return {
        title: "Yangi PIN kodni kiriting",
        sub: "6 ta raqamdan iborat xavfsizlik kodini tanlang"
      };
    } else {
      return {
        title: "PIN kodni tasdiqlang",
        sub: "Tasdiqlash uchun o‘sha 6 ta raqamni qayta kiriting"
      };
    }
  } else if(MODAL_PIN_MODE === 'change'){
    if(MODAL_PIN_STEP === 1){
      return {
        title: "Joriy PIN kodni kiriting",
        sub: "O‘zgartirish uchun hozirgi 6 xonali PIN kodingizni kiriting"
      };
    } else if(MODAL_PIN_STEP === 2){
      return {
        title: "Yangi PIN kodni kiriting",
        sub: "6 ta raqamdan iborat yangi PIN kodni tanlang"
      };
    } else {
      return {
        title: "Yangi PIN kodni tasdiqlang",
        sub: "Tasdiqlash uchun yangi PIN kodni qayta kiriting"
      };
    }
  } else {
    return {
      title: "Joriy PIN kodni kiriting",
      sub: "Parol himoyasini olib tashlash uchun hozirgi PIN kodni kiriting"
    };
  }
}

function renderPasscodeModalContent(){
  const body = document.getElementById('passcodeModalBody');
  const titleEl = document.getElementById('passcodeModalTitle');
  if(!body) return;

  const currentPass = getStoredAppPasscode();
  const info = getModalStepInfo();
  if(titleEl) titleEl.textContent = currentPass ? "Ilova PIN kodi (6 xonali)" : "PIN kod o'rnatish";

  body.innerHTML = `
    ${currentPass ? `
      <div class="passcode-tab-nav" style="margin-bottom:16px;">
        <button type="button" class="passcode-tab-btn ${MODAL_PIN_MODE==='change' ? 'active' : ''}" onclick="switchPasscodeTab('change')">O'zgartirish</button>
        <button type="button" class="passcode-tab-btn ${MODAL_PIN_MODE==='remove' ? 'active' : ''}" onclick="switchPasscodeTab('remove')">Olib tashlash</button>
      </div>
    ` : ''}

    <div id="modalPinCard" style="display:flex;flex-direction:column;align-items:center;text-align:center;">
      <div style="font-size:18px;font-weight:700;color:var(--text);margin-bottom:4px;" id="modalStepTitle">${info.title}</div>
      <div style="font-size:13px;color:var(--text-dim);margin-bottom:20px;max-width:270px;line-height:1.4;" id="modalStepSub">${info.sub}</div>

      <!-- 6-digit PIN Dots -->
      <div class="pin-dots-container" id="modalPinDots" style="margin-bottom:20px;">
        <div class="pin-dot"></div>
        <div class="pin-dot"></div>
        <div class="pin-dot"></div>
        <div class="pin-dot"></div>
        <div class="pin-dot"></div>
        <div class="pin-dot"></div>
      </div>

      <div id="modalPinError" class="app-lock-error" style="display:none;margin-bottom:14px;"></div>

      <!-- Keypad -->
      <div class="pin-keypad" id="modalPinKeypad">
        <button type="button" class="pin-key" onclick="handleModalKeyInput('1')">1</button>
        <button type="button" class="pin-key" onclick="handleModalKeyInput('2')">2</button>
        <button type="button" class="pin-key" onclick="handleModalKeyInput('3')">3</button>
        <button type="button" class="pin-key" onclick="handleModalKeyInput('4')">4</button>
        <button type="button" class="pin-key" onclick="handleModalKeyInput('5')">5</button>
        <button type="button" class="pin-key" onclick="handleModalKeyInput('6')">6</button>
        <button type="button" class="pin-key" onclick="handleModalKeyInput('7')">7</button>
        <button type="button" class="pin-key" onclick="handleModalKeyInput('8')">8</button>
        <button type="button" class="pin-key" onclick="handleModalKeyInput('9')">9</button>
        <button type="button" class="pin-key key-action" onclick="handleModalKeyClear()" aria-label="Tozalash">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
        <button type="button" class="pin-key" onclick="handleModalKeyInput('0')">0</button>
        <button type="button" class="pin-key key-action" onclick="handleModalKeyBackspace()" aria-label="O'chirish">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/><line x1="18" y1="9" x2="12" y2="15"/><line x1="12" y1="9" x2="18" y2="15"/></svg>
        </button>
      </div>
    </div>
  `;

  renderModalDots();
}

function handleModalKeyInput(digit){
  if(!/^\d$/.test(digit)) return;
  if(MODAL_PIN_BUFFER.length >= 6) return;

  MODAL_PIN_BUFFER += digit;
  renderModalDots();

  const err = document.getElementById('modalPinError');
  if(err) { err.textContent = ''; err.style.display = 'none'; }

  if(MODAL_PIN_BUFFER.length === 6){
    setTimeout(processModalStep, 130);
  }
}

function handleModalKeyBackspace(){
  if(MODAL_PIN_BUFFER.length > 0){
    MODAL_PIN_BUFFER = MODAL_PIN_BUFFER.slice(0, -1);
    renderModalDots();
    const err = document.getElementById('modalPinError');
    if(err) { err.textContent = ''; err.style.display = 'none'; }
  }
}

function handleModalKeyClear(){
  MODAL_PIN_BUFFER = "";
  renderModalDots();
  const err = document.getElementById('modalPinError');
  if(err) { err.textContent = ''; err.style.display = 'none'; }
}

function showModalPinError(msg){
  const err = document.getElementById('modalPinError');
  const card = document.getElementById('modalPinCard');
  if(err){
    err.textContent = msg;
    err.style.display = 'block';
  }
  if(card){
    card.classList.remove('shake-anim');
    void card.offsetWidth;
    card.classList.add('shake-anim');
    setTimeout(()=>{ card.classList.remove('shake-anim'); }, 450);
  }
  MODAL_PIN_BUFFER = "";
  renderModalDots();
}

function processModalStep(){
  const saved = getStoredAppPasscode();

  if(MODAL_PIN_MODE === 'setup'){
    if(MODAL_PIN_STEP === 1){
      MODAL_TEMP_PIN = MODAL_PIN_BUFFER;
      MODAL_PIN_BUFFER = "";
      MODAL_PIN_STEP = 2;
      renderPasscodeModalContent();
    } else {
      if(MODAL_PIN_BUFFER === MODAL_TEMP_PIN){
        try{
          localStorage.setItem('arabication_app_passcode', MODAL_TEMP_PIN);
          closePasscodeModal();
          toast("6 xonali PIN kod muvaffaqiyatli o‘rnatildi 🔒", 3000);
        }catch(e){
          showModalPinError("Xotirada saqlashda xatolik yuz berdi.");
        }
      } else {
        showModalPinError("PIN kodlar mos kelmadi. Boshidan kiriting.");
        MODAL_PIN_STEP = 1;
        MODAL_TEMP_PIN = "";
        setTimeout(renderPasscodeModalContent, 600);
      }
    }
  } else if(MODAL_PIN_MODE === 'change'){
    if(MODAL_PIN_STEP === 1){
      if(MODAL_PIN_BUFFER === saved){
        MODAL_PIN_BUFFER = "";
        MODAL_PIN_STEP = 2;
        renderPasscodeModalContent();
      } else {
        showModalPinError("Joriy PIN kod noto‘g‘ri kiritildi.");
      }
    } else if(MODAL_PIN_STEP === 2){
      MODAL_TEMP_PIN = MODAL_PIN_BUFFER;
      MODAL_PIN_BUFFER = "";
      MODAL_PIN_STEP = 3;
      renderPasscodeModalContent();
    } else {
      if(MODAL_PIN_BUFFER === MODAL_TEMP_PIN){
        try{
          localStorage.setItem('arabication_app_passcode', MODAL_TEMP_PIN);
          closePasscodeModal();
          toast("PIN kod muvaffaqiyatli yangilandi ✅", 3000);
        }catch(e){
          showModalPinError("Xotirada saqlashda xatolik yuz berdi.");
        }
      } else {
        showModalPinError("Yangi PIN kodlar mos kelmadi. Boshidan kiriting.");
        MODAL_PIN_STEP = 2;
        MODAL_TEMP_PIN = "";
        setTimeout(renderPasscodeModalContent, 600);
      }
    }
  } else if(MODAL_PIN_MODE === 'remove'){
    if(MODAL_PIN_BUFFER === saved){
      try{
        localStorage.removeItem('arabication_app_passcode');
        closePasscodeModal();
        toast("PIN kod himoyasi olib tashlandi 🔓", 3000);
      }catch(e){
        showModalPinError("Xotirani tozalashda xatolik yuz berdi.");
      }
    } else {
      showModalPinError("Joriy PIN kod noto‘g‘ri kiritildi.");
    }
  }
}

/* Global physical keyboard input listener */
window.addEventListener('keydown', (e) => {
  const appLockOverlay = document.getElementById('appLockOverlay');
  const passcodeModalOverlay = document.getElementById('passcodeModalOverlay');

  const isLockActive = appLockOverlay && appLockOverlay.style.display !== 'none' && !appLockOverlay.classList.contains('unlocking');
  const isModalActive = passcodeModalOverlay && passcodeModalOverlay.style.display !== 'none';

  if(!isLockActive && !isModalActive) return;

  if(e.key >= '0' && e.key <= '9'){
    e.preventDefault();
    if(isLockActive) handleLockKeyInput(e.key);
    else if(isModalActive) handleModalKeyInput(e.key);
  } else if(e.key === 'Backspace'){
    e.preventDefault();
    if(isLockActive) handleLockKeyBackspace();
    else if(isModalActive) handleModalKeyBackspace();
  } else if(e.key === 'Escape'){
    e.preventDefault();
    if(isLockActive) handleLockKeyClear();
    else if(isModalActive) closePasscodeModal();
  }
});

(function initAppLockImmediately(){
  checkAppLockOnStartup();
})();

/* ---------------- Imtihon matn o'lchami (barcha bo'limlar uchun umumiy) ----------------
   Quiz-head ichidagi A−/A+ tugmalari --exam-font-scale CSS o'zgaruvchisini o'zgartiradi,
   shu o'zgaruvchidan .passage/.q-text/.q-sub/.option/.opt-circle/.write-area/.qiroa-title-btn
   kabi barcha imtihon matnlari font-size'ini hisoblab oladi (qarang: calc(...*var(--exam-font-scale))).
   Tanlov localStorage'da saqlanadi — foydalanuvchi bir marta sozlasa, hamma bo'limda va
   keyingi safar ochganda ham shu o'lcham qo'llanadi. */
const EXAM_FONT_MIN = 0.8, EXAM_FONT_MAX = 1.6, EXAM_FONT_STEP = 0.1;
function getExamFontScale(){
  let v = null;
  try{ v = parseFloat(localStorage.getItem('arab_exam_font_scale')); }catch(e){}
  if(!v || isNaN(v)) v = 1;
  return Math.min(EXAM_FONT_MAX, Math.max(EXAM_FONT_MIN, v));
}
function applyExamFontScale(v){
  document.documentElement.style.setProperty('--exam-font-scale', v);
}
function examFontStep(dir){
  let v = getExamFontScale();
  v = Math.round((v + dir*EXAM_FONT_STEP) * 100) / 100;
  v = Math.min(EXAM_FONT_MAX, Math.max(EXAM_FONT_MIN, v));
  try{ localStorage.setItem('arab_exam_font_scale', v); }catch(e){}
  applyExamFontScale(v);
}
applyExamFontScale(getExamFontScale());

/* ---------------- Navigation ---------------- */
const views = ['dashboard','attanal','fullexamintro','skillintro','miccheck','imtihon','grammar','quiz','results','history','natijalar','xatolar','profil','hamjamiyat','sozlamalar','rank','admin','flashcards','marathon','duel','duelresult','duelskillselect','duelvocabselect','duelvocabtopics','duelhistory','dostlarim'];
let viewHistory = ['dashboard'];

/* Imtihon bo'limida biror cardga (masalan At-Tanal) kirilgach, undan keyingi
   barcha ichki sahifalarda (mahorat tanlash, mikrofon tekshiruvi, test/imtihon
   jarayoni, natija) pastki menyu (bottom-nav) yopiq turadi — sahifa "full"
   bo'lib qolishi uchun. Faqat pastdagi menyuning o'z tugmalariga mos asosiy
   bo'limlarda (bosh sahifa, imtihon, grammatika, reyting, profil, admin)
   menyu ko'rinadi. */
const NO_BOTTOM_NAV_VIEWS = new Set(['attanal','fullexamintro','skillintro','miccheck','quiz','results','flashcards','marathon','duelresult','duelskillselect','duelvocabselect','duelvocabtopics','duelhistory','dostlarim']);

/* Qulflangan/yashirilgan imtihon cardlariga har qanday yo'l orqali (dashboard
   tugmasi, bottom nav, tezkor havolalar va h.k.) kirishni bloklaydi — faqat
   cardning o'zini bosishni emas. Admin panelda saqlangan holatni to'g'ridan-to'g'ri
   localStorage'dan o'qiydi, shuning uchun tarmoq/auth kutilmasdan, sinxron ishlaydi
   va sahifa ochilgan zahotiyoq to'g'ri natija beradi.
   NAVBTN_* — pastki menyu (bottom-nav) tugmalari uchun ham xuddi shu mexanizm,
   faqat cardId'lar 'navbtn_<view>' prefiksi bilan (qarang: REAL ADMIN EXTENSION,
   NAV_BTN_CONFIG / applyNavBtnLockState) — shuning uchun bitta umumiy
   exam_cards saqlash joyi orqali ham cardlar, ham grammatika, ham menyu
   tugmalari boshqariladi. */
const VIEW_CARD_MAP = {
  attanal: 'attanal_full',
  fullexamintro: 'attanal_full_exam',
  dashboard: 'navbtn_dashboard',
  imtihon: 'navbtn_imtihon',
  grammar: 'navbtn_grammar',
  duel: 'navbtn_duel',
  rank: 'navbtn_rank',
  profil: 'navbtn_profil'
};
function getExamCardLockState(cardId){
  try{
    const cfg = JSON.parse(localStorage.getItem('arab_app_config_cache'));
    if(cfg && cfg.exam_cards && cfg.exam_cards[cardId]) return cfg.exam_cards[cardId];
  }catch(e){}
  try{
    const legacy = JSON.parse(localStorage.getItem('arab_ext_exam_cards'));
    if(legacy && legacy[cardId]) return legacy[cardId];
  }catch(e){}
  return { visible:true, locked:false };
}
function isAttanalLocked(){
  const st = getExamCardLockState('attanal_full');
  return !!(st.locked || st.visible === false);
}
function isFullExamLocked(){
  const st = getExamCardLockState('attanal_full_exam');
  return !!(st.locked || st.visible === false);
}

function updateTelegramBackButton(viewName){
  try {
    const tg = window.Telegram?.WebApp;
    if (!tg || !tg.BackButton) return;

    // 1. Agar biror modal ochiq bo'lsa
    const activeModal = document.querySelector('.modal-overlay.show, .overlay.show, .as-overlay.show, .onboarding-overlay.show, #userMsgPanel.show');
    if (activeModal && activeModal.style.display !== 'none') {
      tg.BackButton.show();
      return;
    }

    const curView = viewName || (viewHistory[viewHistory.length - 1]) || 'dashboard';

    // 2. Bosh sahifada bo'lsa
    if (curView === 'dashboard') {
      tg.BackButton.hide();
      return;
    }

    // 3. To'liq imtihon faol bo'lsa
    if (typeof FULL_EXAM !== 'undefined' && FULL_EXAM && FULL_EXAM.active) {
      tg.BackButton.hide();
      return;
    }

    // 4. Joriy sahifaning o'zida "Ortga" (.back-row) tugmasi bormi va ko'rinyaptimi?
    const viewEl = document.getElementById('view-' + curView);
    const backRow = viewEl ? viewEl.querySelector('.back-row') : null;
    const hasVisibleBackRow = !!(backRow && backRow.style.display !== 'none' && !backRow.hidden);

    if (hasVisibleBackRow) {
      // Platformaning o'zida "Ortga" tugmasi bor — Telegram native tugmasi YASHIRILADI
      tg.BackButton.hide();
    } else {
      // Platformada "Ortga" tugmasi yo'q sahifalarda (masalan profil, admin va h.k.) — Telegram native tugmasi KO'RSATILADI
      tg.BackButton.show();
    }
  } catch(e){}
}

function handleTelegramNativeBack(){
  try {
    // 1. Agar biror modal ochiq bo'lsa, modalni yopamiz
    const activeModal = document.querySelector('.modal-overlay.show, .overlay.show, .as-overlay.show, .onboarding-overlay.show');
    if (activeModal) {
      if (typeof closeModal === 'function') closeModal();
      else activeModal.classList.remove('show');
      return;
    }
    // 2. Agar bildirishnomalar paneli ochiq bo'lsa, uni yopamiz
    const userMsgPanel = document.getElementById('userMsgPanel');
    if (userMsgPanel && userMsgPanel.style.display !== 'none' && userMsgPanel.classList.contains('show')) {
      userMsgPanel.classList.remove('show');
      return;
    }
    // 3. To'liq imtihon faol bo'lsa
    if (typeof FULL_EXAM !== 'undefined' && FULL_EXAM && FULL_EXAM.active) {
      toast("To'liq imtihonda orqaga qaytish mumkin emas", 2000);
      return;
    }
    // 4. Joriy faol ko'rinish
    const curView = viewHistory[viewHistory.length - 1] || 'dashboard';
    if (curView === 'dashboard') {
      return;
    }
    if (curView === 'quiz') {
      if (typeof handleQuizBack === 'function') handleQuizBack();
      else goBack();
      return;
    }
    if (curView === 'skillintro') {
      if (typeof handleSkillIntroBack === 'function') handleSkillIntroBack();
      else goBack();
      return;
    }
    if (curView === 'results') {
      if (typeof handleResultsBack === 'function') handleResultsBack();
      else goBack();
      return;
    }
    if (curView === 'duelresult') {
      if (typeof returnFromDuelResult === 'function') returnFromDuelResult();
      else goBack();
      return;
    }
    if (curView === 'fullexamintro' || curView === 'miccheck') {
      showView('attanal');
      return;
    }
    goBack();
  } catch(e){
    goBack();
  }
}

// Telegram BackButton click hodisasini ulash
try {
  if (window.Telegram?.WebApp?.BackButton) {
    window.Telegram.WebApp.BackButton.onClick(handleTelegramNativeBack);
  }
} catch(e){}

function showView(name, push=true){
  if(FULL_EXAM && FULL_EXAM.active && !['quiz','miccheck'].includes(name)){
    toast("To'liq imtihon davom etmoqda — avval uni yakunlang", 2000);
    return;
  }
  if(name !== 'miccheck'){ try{ stopMicCheckStream(); }catch(e){} }
  const cardId = VIEW_CARD_MAP[name];
  if(cardId){
    const st = getExamCardLockState(cardId);
    if(st.locked){ toast("🔒 Bu bo'lim hozircha qulflangan"); return; }
    if(st.visible === false){ toast("Bu bo'lim vaqtincha mavjud emas"); return; }
  }
  views.forEach(v=>{
    const el = document.getElementById('view-'+v);
    if(el) el.classList.toggle('active', v===name);
  });
  document.querySelectorAll('.navlink').forEach(b=>b.classList.toggle('active', b.dataset.view===name));
  document.querySelectorAll('.bn-btn').forEach(b=>b.classList.toggle('active', b.dataset.view===name));
  // Pastki menyuni to'liq yopib, sahifani "full" qilish (qarang: NO_BOTTOM_NAV_VIEWS yuqorida)
  const hideBottomNav = NO_BOTTOM_NAV_VIEWS.has(name);
  document.getElementById('bottomNav')?.classList.toggle('nav-hidden', hideBottomNav);
  document.body.classList.toggle('no-bottom-nav', hideBottomNav);
  const topGreeting = document.getElementById('topGreeting');
  if(topGreeting) topGreeting.style.display = 'none';
  const topbarEl = document.getElementById('mainTopbar');
  if(topbarEl){
    const hideTopbar = (name === 'duelresult');
    topbarEl.style.display = hideTopbar ? 'none' : 'flex';
    topbarEl.classList.remove('hero-banner');
  }
  const isSpeakingQuiz = (name === 'quiz' && window.currentQuiz && (window.currentQuiz.skillId === 'muhavara' || window.currentQuiz.type === 'speaking'));
  document.body.classList.toggle('speaking-quiz-active', !!isSpeakingQuiz);
  if(name !== 'quiz' || !isSpeakingQuiz){
    document.body.classList.remove('speaking-recording-active');
    const quizHeadEl = document.getElementById('quizHead');
    if(quizHeadEl) quizHeadEl.classList.remove('quiz-head-collapsed');
  }
  const topbarRightEl = document.querySelector('#mainTopbar .topbar-right');
  if(topbarRightEl){
    topbarRightEl.style.display = isSpeakingQuiz ? 'none' : 'flex';
  }
  const themeToggleBtn = document.getElementById('themeToggleBtn');
  if(themeToggleBtn) themeToggleBtn.style.display = isSpeakingQuiz ? 'none' : '';
  const topAvatarEl = document.getElementById('topAvatar');
  if(topAvatarEl){
    const hideAvatar = (name === 'dashboard' || name === 'profil' || name === 'sozlamalar' || isSpeakingQuiz);
    topAvatarEl.style.display = hideAvatar ? 'none' : 'flex';
  }
  if(push){
    if(viewHistory.length === 0 || viewHistory[viewHistory.length - 1] !== name){
      viewHistory.push(name);
    }
  }
  updateTelegramBackButton(name);
  document.getElementById('content').scrollTo?.(0,0);
  window.scrollTo(0,0);
  closeSidebar();
  const activeEl = document.getElementById('view-'+name);
  if(activeEl) runEntranceAnimations(activeEl, false, name === 'dashboard');
  if(name==='admin') renderAdminPanel();
  if(name==='hamjamiyat') renderCommunityView();
  if(name==='grammar') switchGrammarTab('practice');
  if(name==='duelhistory') renderDuelHub();
  if(name==='dostlarim') renderFriendsHub();
  if(name==='skillintro') switchSkillTab('practice');
  if(name==='sozlamalar' || name==='profil') updatePasscodeStatusText();
  if(name==='dashboard') renderDashboardPracticeCards();
  if(name==='flashcards') renderFlashcardsView();
  if(name==='marathon') renderMarathonHub();
  // Rank bo'limi ochilganda backenddan ENG SO'NGGI ma'lumotni qayta so'raymiz
  // (avval bu yerda faqat eski/keshlangan RANK_DATASETS qayta chizilardi —
  // shu sabab yangi to'plangan XP darhol ko'rinmasdi).
  if(name==='rank') refreshRankFromBackend();
}

/* ---------------- Universal Number Animation Helper ---------------- */
const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function animateNumber(targetEl, targetVal, options = {}){
  const el = (typeof targetEl === 'string') ? document.getElementById(targetEl) : targetEl;
  if(!el) return;

  const target = parseFloat(targetVal);
  if(isNaN(target)){
    el.textContent = targetVal ?? '';
    return;
  }

  const dur = options.duration ?? 850;
  const prefix = options.prefix ?? '';
  const suffix = options.suffix ?? '';
  const decimals = options.decimals ?? 0;
  const useLocale = options.locale ?? (decimals === 0);
  const startVal = options.from !== undefined ? parseFloat(options.from) : 0;

  if(reduceMotion || dur <= 0){
    const formatted = useLocale ? target.toLocaleString('ru-RU') : (decimals > 0 ? target.toFixed(decimals) : Math.round(target));
    el.textContent = prefix + formatted + suffix;
    if(options.onComplete) options.onComplete();
    return;
  }

  if(el._numAnimId) cancelAnimationFrame(el._numAnimId);

  const startTime = performance.now();
  function step(now){
    const p = Math.min(1, (now - startTime) / dur);
    // Smooth custom cubic ease-out curve (fast initial climb, graceful deceleration)
    const eased = 1 - Math.pow(1 - p, 3);
    const curr = startVal + (target - startVal) * eased;
    let formatted;
    if(decimals > 0){
      formatted = curr.toFixed(decimals);
    } else {
      const rounded = Math.round(curr);
      formatted = useLocale ? rounded.toLocaleString('ru-RU') : String(rounded);
    }
    el.textContent = prefix + formatted + suffix;
    if(p < 1){
      el._numAnimId = requestAnimationFrame(step);
    } else {
      el._numAnimId = null;
      if(options.onComplete) options.onComplete();
    }
  }
  el._numAnimId = requestAnimationFrame(step);
}

/* ---------------- Entrance animations (bars, rings, counters) ---------------- */
function runEntranceAnimations(root, force = false, instant = false){
  if(!root) return;
  const selector = force ? '.num-target[data-target]' : '.num-target[data-target]:not([data-animated])';
  const nums = root.querySelectorAll(selector);
  nums.forEach(n=>{
    n.setAttribute('data-animated','1');
    const target = parseFloat(n.dataset.target);
    const decimals = parseInt(n.dataset.decimals || '0', 10);
    const prefix = n.dataset.prefix || '';
    const suffix = n.dataset.suffix || '';
    const dur = instant ? 0 : parseInt(n.dataset.duration || '900', 10);
    animateNumber(n, target, { duration: dur, decimals, prefix, suffix, from: 0 });
  });

  const barSelector = force ? '.bar-fill[data-target]' : '.bar-fill[data-target]:not([data-animated])';
  const ringSelector = force ? '.ring-progress[data-target-offset]' : '.ring-progress[data-target-offset]:not([data-animated])';
  const bars = root.querySelectorAll(barSelector);
  const rings = root.querySelectorAll(ringSelector);
  if(reduceMotion || instant){
    bars.forEach(b=>{ b.style.width = b.dataset.target+'%'; b.setAttribute('data-animated','1'); });
    rings.forEach(r=>{ r.setAttribute('stroke-dashoffset', r.dataset.targetOffset); r.setAttribute('data-animated','1'); });
    return;
  }
  requestAnimationFrame(()=>{
    setTimeout(()=>{
      bars.forEach(b=>{ b.style.width = b.dataset.target+'%'; b.setAttribute('data-animated','1'); });
      rings.forEach(r=>{ r.setAttribute('stroke-dashoffset', r.dataset.targetOffset); r.setAttribute('data-animated','1'); });
    }, 120);
  });
}

/* ---------------- canvas-confetti orqali ekranning yon taraflaridan otiluvchi Side Confetti ---------------- */
function fireSideConfetti(opts = {}){
  if(typeof reduceMotion !== 'undefined' && reduceMotion) return;
  const isMarathon = opts.mode === 'marathon';
  const fullPalette = [
    '#2563EB', '#3B82F6', '#00D2FF', '#06B6D4', '#10B981',
    '#22C55E', '#84CC16', '#EAB308', '#FFD700', '#FF9800',
    '#FF5722', '#EF4444', '#F43F5E', '#EC4899', '#D946EF',
    '#A855F7', '#8B5CF6', '#6366F1', '#4F46E5', '#14B8A6'
  ];

  if(typeof confetti === 'function'){
    if(isMarathon){
      // Marafonda to'g'ri javob uchun: ikki yon tomondan yorqin va rang-barang otilish
      confetti({
        particleCount: 32,
        angle: 60,
        spread: 55,
        origin: { x: 0, y: 0.72 },
        colors: fullPalette,
        disableForReducedMotion: true
      });
      confetti({
        particleCount: 32,
        angle: 120,
        spread: 55,
        origin: { x: 1, y: 0.72 },
        colors: fullPalette,
        disableForReducedMotion: true
      });
    } else {
      // Imtihon, duel g'alabasi va bayramona natijalar uchun aynan 0.7 soniya davomida to'lqinli side-cannon
      const duration = 700; // 0.7 soniya
      const end = Date.now() + duration;

      (function frame(){
        // Har bir kadrda ranglarni aralashtirib to'liq spektrni chiqarish
        const shuffledColors = fullPalette.slice().sort(() => Math.random() - 0.5);
        confetti({
          particleCount: 6,
          angle: 60,
          spread: 65,
          origin: { x: 0, y: 0.75 },
          colors: shuffledColors,
          disableForReducedMotion: true
        });
        confetti({
          particleCount: 6,
          angle: 120,
          spread: 65,
          origin: { x: 1, y: 0.75 },
          colors: shuffledColors.slice().reverse(),
          disableForReducedMotion: true
        });

        if(Date.now() < end){
          requestAnimationFrame(frame);
        }
      }());
    }
    return;
  }

  // Fallback (agar kutubxona yuklanmay qolsa)
  triggerFallbackConfetti(isMarathon, fullPalette);
}

function triggerFallbackConfetti(isMarathon, colors){
  const count = isMarathon ? 35 : 80;
  for(let i = 0; i < count; i++){
    const el = document.createElement('div');
    el.style.cssText = `position:fixed;width:6px;height:9px;background:${colors[i%colors.length]};top:65vh;left:${i%2===0 ? '5vw' : '95vw'};pointer-events:none;z-index:999999;border-radius:2px;`;
    document.body.appendChild(el);
    const dx = (i % 2 === 0 ? 1 : -1) * (100 + Math.random() * 240);
    const dy = -(180 + Math.random() * 260);
    const rot = (Math.random() - 0.5) * 720;
    const dur = 900 + Math.random() * 500;
    el.animate([
      { transform: 'translate(0,0) rotate(0deg)', opacity: 1 },
      { transform: `translate(${dx}px, ${dy + 350}px) rotate(${rot}deg)`, opacity: 0 }
    ], { duration: dur, easing: 'cubic-bezier(.22,.9,.32,1)' });
    setTimeout(()=> el.remove(), dur + 50);
  }
}

function fireConfetti(){
  fireSideConfetti({ mode: 'celebration' });
}
/* Muhavara (so'zlashuv) yozib olish jarayonida sahifadan chiqib ketilsa (orqaga
   tugmasi yoki "Testni yakunlash" orqali), MediaRecorder'ni to'xtatishdan oldin
   onstop handlerini o'chirib qo'yamiz — aks holda onstop hali ham ishga tushib,
   javobni AI'ga yuborib yuboradi va foydalanuvchi allaqachon chiqib ketgan
   bo'lsa ham urinish yakunlanib, natija/XP berilib ketishi mumkin edi. */
function stopQuizMediaSilently(){
  if(muhavaraRecorder && muhavaraRecorder.state !== 'inactive'){
    muhavaraRecorder.onstop = null;
    try{ muhavaraRecorder.stop(); }catch(e){}
  }
  if(muhavaraStream){ muhavaraStream.getTracks().forEach(t=>t.stop()); muhavaraStream = null; }
  stopMuhavaraLevelMeter();
}
function goBack(){
  if(FULL_EXAM && FULL_EXAM.active){ toast("To'liq imtihonda orqaga qaytish mumkin emas", 2000); return; }
  clearInterval(timerInterval); clearInterval(mcqTimerInterval);
  if(typeof _duelStopAnswerPolling === 'function') _duelStopAnswerPolling();
  if(typeof _duelStopResultPolling === 'function') _duelStopResultPolling();
  stopQuizMediaSilently();
  viewHistory.pop();
  while(viewHistory.length > 0 && (
    viewHistory[viewHistory.length - 1] === 'quiz' || 
    viewHistory[viewHistory.length - 1] === 'results' ||
    viewHistory[viewHistory.length - 1] === 'duelresult'
  )){
    viewHistory.pop();
  }
  const prev = viewHistory[viewHistory.length-1] || 'dashboard';
  showView(prev, false);
}
/* "Testni yakunlash" (side-panel qizil tugma) endi testni MAJBURIY tugatib
   natija chiqarmaydi — u ham xuddi orqaga tugmasi kabi shunchaki testdan
   chiqib ketish hisoblanadi: bu urinish uchun XP berilmaydi, tarixga
   yozilmaydi va natija sahifasi ko'rsatilmaydi. Faqat testni oxirigacha
   (oxirgi savolni "Yakunlash" tugmasi bilan) yechib tugatgandagina natija
   chiqadi va tarixga yoziladi. */
function confirmExitQuiz(){
  if(FULL_EXAM && FULL_EXAM.active){ toast("To'liq imtihonda testni tark etish mumkin emas", 2000); return; }
  if(!currentQuiz){ goBack(); return; }
  document.getElementById('modalTitle').textContent = "Testdan chiqish";
  document.getElementById('modalBody').innerHTML = `
    <div style="text-align:center;padding:10px 4px 6px;">
      <div style="font-size:38px;margin-bottom:12px;">⚠️</div>
      <div style="font-size:15.5px;font-weight:700;color:var(--text);margin-bottom:8px;">Testni hozir tark etmoqchimisiz?</div>
      <p style="font-size:13.5px;color:var(--text-dim);line-height:1.55;margin:0 0 20px;">Test oxirigacha yechilmaganligi sababli bu urinish uchun XP berilmaydi va tarixga yozilmaydi.</p>
      <div style="display:flex;gap:10px;">
        <button class="btn btn-outline" style="flex:1;padding:12px;" onclick="document.getElementById('modalOverlay').classList.remove('show')">Davom etish</button>
        <button class="btn btn-primary" style="flex:1;padding:12px;background:var(--red);border-color:var(--red);" onclick="document.getElementById('modalOverlay').classList.remove('show');exitQuizAbandoned()">Ha, chiqish</button>
      </div>
    </div>
  `;
  document.getElementById('modalOverlay').classList.add('show');
}
function exitQuizAbandoned(){
  clearInterval(timerInterval); clearInterval(mcqTimerInterval);
  if(typeof _duelStopAnswerPolling === 'function') _duelStopAnswerPolling();
  stopQuizMediaSilently();
  handleQuizBack();
  currentQuiz = null;
}
document.querySelectorAll('[data-view]').forEach(el=>{
  el.addEventListener('click', ()=> showView(el.dataset.view));
});

/* ---- Custom dropdown (native <select> popup'ini ilova dizayniga mos qilib
   bo'yash mumkin emasligi sababli — to'liq JS bilan yasalgan almashtiruvchi). ----
   initCustomDropdown('wrapId', { label, options:[{value,label}], value, onChange }) */
let CUSTOM_DROPDOWN_STATE = {};
function initCustomDropdown(id, config){
  CUSTOM_DROPDOWN_STATE[id] = { ...config };
  renderCustomDropdown(id);
}
function updateCustomDropdown(id, patch){
  const st = CUSTOM_DROPDOWN_STATE[id];
  if(!st) return;
  Object.assign(st, patch);
  renderCustomDropdown(id);
}
function renderCustomDropdown(id){
  const st = CUSTOM_DROPDOWN_STATE[id];
  const wrap = document.getElementById(id);
  if(!st || !wrap) return;
  wrap.classList.add('cd-wrap');
  const opt = st.options.find(o=>o.value===st.value) || st.options[0];
  wrap.innerHTML = `
    <label>${escapeHtml(st.label)}</label>
    <button type="button" class="cd-trigger"><span class="cd-value">${escapeHtml(opt?opt.label:'')}</span></button>
    <svg class="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
    <div class="cd-panel" id="${id}__panel">
      ${st.options.map(o=>`<button type="button" class="cd-option ${o.value===st.value?'active':''}" data-dd-id="${id}" data-dd-val="${escapeHtml(o.value)}">${escapeHtml(o.label)}</button>`).join('')}
    </div>
  `;
}
document.addEventListener('click', (e)=>{
  const optBtn = e.target.closest('.cd-option');
  if(optBtn){
    const id = optBtn.dataset.ddId, val = optBtn.dataset.ddVal;
    const st = CUSTOM_DROPDOWN_STATE[id];
    if(st){
      st.value = val;
      renderCustomDropdown(id);
      if(st.onChange) st.onChange(val);
    }
    return;
  }
  const trigger = e.target.closest('.cd-trigger');
  if(trigger){
    const wrapEl = trigger.closest('.cd-wrap');
    const panel = wrapEl ? document.getElementById(wrapEl.id + '__panel') : null;
    document.querySelectorAll('.cd-panel.show').forEach(p=>{ if(p !== panel) p.classList.remove('show'); });
    document.querySelectorAll('.native-calendar-popup.show').forEach(p=>p.classList.remove('show'));
    if(panel) panel.classList.toggle('show');
    return;
  }
  document.querySelectorAll('.cd-panel.show').forEach(p=>p.classList.remove('show'));
  document.querySelectorAll('.native-calendar-popup.show').forEach(p=>p.classList.remove('show'));
});

/* ---------- Sidebar Controls ---------- */
function openSidebar(e){
  if(e && e.stopPropagation) e.stopPropagation();
  const sb = document.getElementById('sidebar');
  const ov = document.getElementById('overlay');
  if(sb) sb.classList.add('open');
  if(ov) ov.classList.add('show');
}
function closeSidebar(e){
  if(e && e.stopPropagation) e.stopPropagation();
  const sb = document.getElementById('sidebar');
  const ov = document.getElementById('overlay');
  if(sb) sb.classList.remove('open');
  if(ov) ov.classList.remove('show');
}
function toggleSidebar(e){
  if(e && e.stopPropagation) e.stopPropagation();
  const sb = document.getElementById('sidebar');
  if(sb && sb.classList.contains('open')){
    closeSidebar(e);
  } else {
    openSidebar(e);
  }
}
window.openSidebar = openSidebar;
window.closeSidebar = closeSidebar;
window.toggleSidebar = toggleSidebar;

// Sidebar navigation link clicks & escape key
document.addEventListener('click', (e) => {
  const navBtn = e.target.closest('#sidebar .navlink, #sidebar .admin-link');
  if(navBtn){
    const targetView = navBtn.getAttribute('data-view');
    if(targetView && typeof showView === 'function'){
      showView(targetView);
    }
    closeSidebar();
  }
});

document.addEventListener('keydown', (e) => {
  if(e.key === 'Escape'){
    closeSidebar();
  }
});

/* view-dashboard is default active in HTML already */
document.querySelector('.bn-btn[data-view="dashboard"]').classList.add('active');

/* ---------------- Toast Notification (Minimalist Bottom-Right Glassmorphism with Dynamic SVGs) ---------------- */
const TOAST_ICONS = {
  success: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  error: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  warning: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  info: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
  delete: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`,
  sun: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`,
  moon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>`,
  lock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
  unlock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>`,
  loading: `<svg class="toast-loading-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`,
  audio: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`
};

function getToastDefaultTitle(type){
  switch(type){
    case 'sun': return "Yorug' mavzu";
    case 'moon': return "Qorong'i mavzu";
    case 'delete': return "O'chirildi";
    case 'warning': return "Ogohlantirish";
    case 'info': return "Ma'lumot";
    case 'lock': case 'unlock': return "Xavfsizlik";
    case 'loading': return "Kuting...";
    case 'audio': return "Audio";
    case 'error': return "Xatolik";
    case 'success': default: return "Muvaffaqiyatli";
  }
}

function resolveToastCategory(rawMsg, explicitType){
  if(explicitType && TOAST_ICONS[explicitType]){
    return { type: explicitType, title: getToastDefaultTitle(explicitType) };
  }
  const str = String(rawMsg || '');
  const lower = str.toLowerCase();

  // Dark / light mode
  if(str.includes('☀️') || lower.includes("yorug'") || lower.includes("light mode") || lower.includes("kunduzgi")){
    return { type: 'sun', title: "Yorug' mavzu" };
  }
  if(str.includes('🌙') || lower.includes("qorong'i") || lower.includes("dark mode") || lower.includes("tungi")){
    return { type: 'moon', title: "Qorong'i mavzu" };
  }

  // Lock / unlock PIN
  if(str.includes('🔓') || lower.includes("qulfdan chiqarildi") || lower.includes("himoyasi olib tashlandi")){
    return { type: 'unlock', title: "Xavfsizlik" };
  }
  if(str.includes('🔒') || lower.includes("qulflangan") || lower.includes("pin kod") || lower.includes("parol o‘rnatildi") || lower.includes("parol o'rnatildi") || (lower.includes("parol") && !lower.includes("xato"))){
    return { type: 'lock', title: "Xavfsizlik" };
  }

  // Delete / Trash
  if(str.includes('🗑️') || lower.includes("o'chirildi") || lower.includes("tozalandi") || lower.includes("olib tashlandi") || lower.includes("o'chirish") || lower.includes("tozalash")){
    return { type: 'delete', title: "O'chirildi" };
  }

  // Audio / Sound
  if(str.includes('🔊') || str.includes('🎧') || lower.includes("audio") || lower.includes("ijro") || lower.includes("eshittirilmoqda")){
    return { type: 'audio', title: "Audio" };
  }

  // Loading / Progress
  if(str.includes('⏳') || lower.includes("yuklanmoqda") || lower.includes("saqlanmoqda") || lower.includes("kuting") || lower.includes("tekshirilmoqda")){
    return { type: 'loading', title: "Kuting..." };
  }

  // Warnings / Alerts
  if(str.includes('⚠️') || lower.includes("ogohlantirish") || lower.includes("diqqat") || lower.includes("kutilmagan") || lower.includes("limit") || lower.includes("ruxsat yo‘q") || lower.includes("ruxsat yo'q") || lower.includes("topilmadi") || lower.includes("mavjud emas")){
    return { type: 'warning', title: "Ogohlantirish" };
  }

  // Errors
  if(str.includes('❌') || lower.includes("xato") || lower.includes("error") || lower.includes("muvaffaqiyatsiz") || lower.includes("saqlanmadi") || lower.includes("rad etildi") || lower.includes("mos kelmadi") || lower.includes("noto‘g‘ri") || lower.includes("noto'g'ri")){
    return { type: 'error', title: "Xatolik" };
  }

  // Info
  if(str.includes('ℹ️') || lower.includes("ma'lumot") || lower.includes("yo'riqnoma") || lower.includes("eslatma") || lower.includes("info") || lower.includes("username:")){
    return { type: 'info', title: "Ma'lumot" };
  }

  // Positive / Success (default for positive or completed actions)
  return { type: 'success', title: "Muvaffaqiyatli" };
}

function cleanToastMessage(str){
  if(!str) return '';
  return str
    .replace(/^[\s\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}🔒🔓✅❌⚠️⏳ℹ️☀️🌙🗑️🔊🎧💡]+/gu, '')
    .replace(/[\s\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}🔒🔓✅❌⚠️⏳ℹ️☀️🌙🗑️🔊🎧💡]+$/gu, '')
    .trim();
}

function showToast(title, message, type = 'success', duration = 4000){
  let container = document.getElementById('toast-container');
  if(!container){
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }

  const iconSvg = TOAST_ICONS[type] || TOAST_ICONS.success;
  const toastEl = document.createElement('div');
  toastEl.className = `toast-item toast-${type}`;

  const closeIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

  function escapeHtml(str){
    if(!str) return '';
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  const titleText = title || getToastDefaultTitle(type);

  toastEl.innerHTML = `
    <div class="toast-icon">
      ${iconSvg}
    </div>
    <div class="toast-body">
      <div class="toast-title">${escapeHtml(titleText)}</div>
      ${message ? `<div class="toast-message">${escapeHtml(message)}</div>` : ''}
    </div>
    <button class="toast-close-btn" aria-label="Yopish" type="button">
      ${closeIcon}
    </button>
  `;

  let timer = null;
  function dismiss(){
    if(timer) clearTimeout(timer);
    toastEl.classList.remove('toast-show');
    toastEl.classList.add('toast-hide');
    setTimeout(()=>{
      if(toastEl.parentNode){
        toastEl.parentNode.removeChild(toastEl);
      }
    }, 320);
  }

  const closeBtn = toastEl.querySelector('.toast-close-btn');
  if(closeBtn){
    closeBtn.addEventListener('click', (e)=>{
      e.stopPropagation();
      dismiss();
    });
  }

  container.appendChild(toastEl);

  requestAnimationFrame(()=>{
    requestAnimationFrame(()=>{
      toastEl.classList.add('toast-show');
    });
  });

  if(duration && duration > 0){
    timer = setTimeout(dismiss, duration);
  }
}

// Global wrapper for toast(msg, duration, explicitType)
function toast(msg, duration = 4000, explicitType = null){
  if(!msg) return;
  const { type, title } = resolveToastCategory(msg, explicitType);
  const cleanMsg = cleanToastMessage(msg);
  showToast(title, cleanMsg || msg, type, duration);
}

/* ---------------- Skill hub ---------------- */
/* Boshlang'ich (default) qiymatlar 0 — bular loadDashboardFromBackend() orqali
   haqiqiy foydalanuvchi ballari bilan almashtiriladi (renderSkillHub() qayta chaqiriladi). */
const SKILLS = [
  {id:'grammatika', name:'Grammatika', ar:'القواعد', score:0, total:30, pct:0, color:'var(--grammatika)', bg:'var(--grammatika-bg)', icon:'📗', btn:'Testni boshlash', qCount:30, mins:30, grad:'sb-qiroa', desc:"Ushbu bo'limda arab tili grammatikasi (nahv, sarf va boshqa mavzular) bo'yicha savollarga javob berasiz. Har bir savol uchun 1 daqiqadan vaqt beriladi."},
  {id:'qiroa', name:"O'qish", ar:'القراءة', score:0, total:30, pct:0, color:'var(--qiroa)', bg:'var(--qiroa-bg)', icon:'📖', btn:'Testni boshlash', qCount:18, mins:33, grad:'sb-grammatika', desc:"Ushbu bo'limda 3 juz matn beriladi — har birini o'qib, mazmuni bo'yicha 6 tadan savolga javob berasiz. Matnni diqqat bilan o'qing, tayyor bo'lsangiz vaqtdan oldin ham savollarga o'tishingiz mumkin."},
  {id:'istima', name:'Tinglash', ar:'الاستماع', score:0, total:18, pct:0, color:'var(--istima)', bg:'var(--istima-bg)', icon:'🎧', btn:'Testni boshlash', qCount:18, mins:10, grad:'sb-istima', desc:"Ushbu bo'lim 3 qismdan iborat. Har qismda avval audio eshittiriladi (cheklangan marta), so'ng savollarga (har biriga 1 daqiqadan) javob berasiz. Audioni oxirigacha tinglashni istamasangiz, 'Savollarga o'tish' tugmasi orqali darhol savollarga o'tishingiz mumkin."},
  {id:'muhavara', name:"So'zlashuv", ar:'المحادثة', score:0, total:30, pct:0, color:'var(--muhavara)', bg:'var(--muhavara-bg)', icon:'🎙️', btn:'Mashqni boshlash', qCount:6, mins:8, grad:'sb-muhavara', desc:"Ushbu bo'limda 3 qismdan (har birida 2 tadan) jami 6 ta savolga ovozli javob berasiz. Har savoldan oldin tayyorgarlik vaqti beriladi, so'ng javobingiz yozib olinadi va sun'iy intellekt tomonidan baholanadi."},
  {id:'kitaba', name:'Yozish', ar:'الكتابة', score:0, total:30, pct:0, color:'var(--kitaba)', bg:'var(--kitaba-bg)', icon:'✍️', btn:'Topshiriqni boshlash', qCount:3, mins:65, grad:'sb-kitaba', desc:"Ushbu bo'lim 3 qismdan iborat:<br>• 1-qism (100+ so'z, 15 daqiqa)<br>• 2-qism (150+ so'z, 20 daqiqa)<br>• 3-qism (200+ so'z, 30 daqiqa)<br>Har bir qism uchun avtomatik ravishda arabcha mavzu beriladi va AI matningizni punktuatsiya, imlo, lug'at, matn tuzilishi, fikrlarning aniqligi va mavzuni ochish bo'yicha 0-10 ball bilan baholaydi."},
];
function applyBackendSkillScores(dash){
  if(!dash) return;
  const map = {grammatika:'grammatika_score', qiroa:'qiroa_score', istima:'istima_score', muhavara:'muhavara_score', kitaba:'kitaba_score'};
  SKILLS.forEach(s=>{
    const val = dash[map[s.id]];
    if(typeof val === 'number'){ s.score = val; s.pct = Math.round((val/s.total)*100); }
  });
  renderSkillHub();
}
/* Bo'lim nomi -> ikonka/rang, tarix va xatolar ro'yxatini backend qatoridan chizish uchun */
const SKILL_META = {};
SKILLS.forEach(s=>{ SKILL_META[s.id] = {name:s.name, section:s.name, icon:s.icon, color:s.color, bg:s.bg}; });
/* "To'liq At-Tanal imtihoni" backendga skillId:'attanal' bilan yoziladi (finishFullExam),
   lekin bu SKILLS ro'yxatida yo'q — shu sabab uni ham shu yerga qo'shamiz, aks holda
   Tarix ro'yxatida u xom "attanal" nomi va grammatika ikonkasi/rangi bilan chiqib qolardi. */
SKILL_META['attanal'] = {name:'Imtihon', section:'Imtihon', icon:'🎓', color:'var(--indigo-600)', bg:'var(--indigo-100)'};
/* Backend qator shakli aniq bo'lmagani uchun bir nechta mumkin bo'lgan ustun nomini sinab ko'radi */
function pick(obj, keys, fallback){
  for(const k of keys){ if(obj && obj[k]!==undefined && obj[k]!==null) return obj[k]; }
  return fallback;
}
function fmtBackendDate(iso){
  if(!iso) return {date:'', time:''};
  const d = new Date(iso);
  if(isNaN(d)) return {date:'', time:''};
  const now = new Date();
  const diffDays = Math.floor((now - d) / 86400000);
  let date;
  if(diffDays<=0) date = 'Bugun';
  else if(diffDays===1) date = 'Kecha';
  else if(diffDays<7) date = diffDays+' kun oldin';
  else date = d.toLocaleDateString('uz-UZ', {day:'numeric', month:'long', year:'numeric'});
  const time = d.toLocaleTimeString('uz-UZ', {hour:'2-digit', minute:'2-digit'});
  const dateGroup = diffDays<7 ? '7kun' : (diffDays<31 ? 'oy' : 'hammasi');
  return {date, time, dateGroup};
}
const SKILL_ICONS = {
  qiroa:'<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  istima:'<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3ZM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3Z"/>',
  grammatika:'<path d="M3 3v18h18"/><path d="M18 17V9M13 17V5M8 17v-3"/>',
  muhavara:'<path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4M9 22h6"/>',
  kitaba:'<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  attanal:'<path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/>',
  imtihon:'<path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/>'
};

function getSkillSvgMeta(item){
  if(!item) return { svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${SKILL_ICONS.attanal}</svg>`, color:'var(--indigo-600)', bg:'var(--indigo-100)' };
  const sid = (item.skillId || item.skill_id || item.skill || '').toLowerCase();
  const sec = (item.section || '').toLowerCase();
  const top = (item.topic || item.topicName || item.topic_name || '').toLowerCase();

  if(sid === 'qiroa' || sec.includes("o'qish") || sec.includes('qiroa') || top.includes('qiroa') || top.includes("o'qish")){
    return {
      svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${SKILL_ICONS.qiroa}</svg>`,
      color: 'var(--qiroa)',
      bg: 'var(--qiroa-bg)'
    };
  }
  if(sid === 'istima' || sec.includes('tinglash') || sec.includes('istima') || top.includes('istima') || top.includes('tinglash')){
    return {
      svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${SKILL_ICONS.istima}</svg>`,
      color: 'var(--istima)',
      bg: 'var(--istima-bg)'
    };
  }
  if(sid === 'grammatika' || sec.includes('grammatika') || sec.includes('qoidalar') || top.includes('grammatika') || top.includes('nahv') || top.includes('sarf') || top.includes('imlo') || top.includes('xatolar')){
    return {
      svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${SKILL_ICONS.grammatika}</svg>`,
      color: 'var(--grammatika)',
      bg: 'var(--grammatika-bg)'
    };
  }
  if(sid === 'muhavara' || sec.includes("so'zlashuv") || sec.includes('muhavara') || top.includes('muhavara') || top.includes("so'zlashuv") || top.includes('speaking')){
    return {
      svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${SKILL_ICONS.muhavara}</svg>`,
      color: 'var(--muhavara)',
      bg: 'var(--muhavara-bg)'
    };
  }
  if(sid === 'kitaba' || sec.includes('yozish') || sec.includes('kitaba') || top.includes('kitaba') || top.includes('yozish') || top.includes('writing')){
    return {
      svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${SKILL_ICONS.kitaba}</svg>`,
      color: 'var(--kitaba)',
      bg: 'var(--kitaba-bg)'
    };
  }
  return {
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${SKILL_ICONS.attanal}</svg>`,
    color: 'var(--indigo-600)',
    bg: 'var(--indigo-100)'
  };
}

/* Tarix qatori (backend/local snapshot) haqiqatan ham MOCK test urinishimi
   yoki yo'qmi — shu YAGONA joyda tekshiriladi. Boshqa hech qayerda (masalan
   Dashboarddagi "MOCK TESTLAR" kartasida) bu tekshiruvni alohida/qisqartirilgan
   holda qayta yozmang — aks holda ikkalasi orasida farq paydo bo'lib, ba'zi
   haqiqiy mock urinishlar "mock emas" deb noto'g'ri aniqlanadi.
   Avvalo backenddagi ISHONCHLI is_mock ustuniga qaraladi (2-bosqichdan keyin
   yozilgan urinishlar uchun aniq). Bu ustun mavjud bo'lmagan ESKI yozuvlar
   uchun esa matn asosidagi taxmin zaxira sifatida ishlatiladi. */
function isMockHistoryRow(r){
  if(!r) return false;
  if(r.is_mock === true || r.is_mock === 'true' || r.is_mock === 1) return true;
  return !!(
    r.type === 'mock' ||
    r.mockId ||
    String(r.topic || '').toLowerCase().includes('mock') ||
    String(r.topicName || '').toLowerCase().includes('mock') ||
    String(r.topic_name || '').toLowerCase().includes('mock') ||
    String(r.label || '').toLowerCase().includes('mock')
  );
}
function formatHistoryDisplayTitle(r){
  if(!r) return '';
  const isFullExam = (r.skillId === 'attanal' || r.section === 'Imtihon' || String(r.topic||'').toLowerCase().includes('at-tanal') || String(r.topic||'').toLowerCase().includes("to'liq"));
  const isMock = isMockHistoryRow(r);

  if(isFullExam){
    return isMock ? "To'liq At-Tanal imtihoni (Mock)" : "To'liq At-Tanal imtihoni";
  }

  const sid = (r.skillId || r.skill_id || '').toLowerCase();
  const sec = (r.section || '').toLowerCase();
  const top = (r.topic || r.topicName || r.topic_name || '').toLowerCase();

  let baseName = '';
  if(sid === 'kitaba' || sec.includes('yozish') || sec.includes('kitaba') || top.includes('kitaba') || top.includes('yozish') || top.includes('writing')){
    baseName = 'Yozish';
  } else if(sid === 'muhavara' || sec.includes("so'zlashuv") || sec.includes('muhavara') || top.includes('muhavara') || top.includes("so'zlashuv") || top.includes('speaking')){
    baseName = "So'zlashuv";
  } else if(sid === 'qiroa' || sec.includes("o'qish") || sec.includes('qiroa') || top.includes('qiroa') || top.includes("o'qish")){
    baseName = "O'qish";
  } else if(sid === 'istima' || sec.includes('tinglash') || sec.includes('istima') || top.includes('istima') || top.includes('tinglash')){
    baseName = 'Tinglash';
  } else if(sid === 'grammatika' || sec.includes('grammatika') || top.includes('grammatika')){
    baseName = 'Grammatika';
  } else {
    baseName = r.section || r.topic || 'Imtihon';
  }

  if(isMock){
    return `${baseName} (Mock)`;
  }
  return baseName;
}
function ringSvg(pct, color){
  const r=46, c=2*Math.PI*r;
  const off = c - (pct/100)*c;
  return `<svg viewBox="0 0 110 110" width="112" height="112">
    <circle cx="55" cy="55" r="${r}" fill="none" stroke="var(--indigo-100)" stroke-width="10"/>
    <circle class="ring-progress" cx="55" cy="55" r="${r}" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round"
      stroke-dasharray="${c}" stroke-dashoffset="${c}" data-target-offset="${off}" transform="rotate(-90 55 55)"/>
  </svg>`;
}
const hubGrid = document.getElementById('hubGrid');
function renderSkillHub(){
  hubGrid.innerHTML = SKILLS.map(s=>`
    <button class="skill-banner ${s.grad}" onclick="openSkillIntro('${s.id}')">
      <div class="skill-banner-left">
        <div class="skill-banner-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${SKILL_ICONS[s.id]}</svg>
        </div>
        <div>
          <div class="skill-banner-title ar">${s.ar}</div>
          <div class="skill-banner-meta">
            <span><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h5"/></svg>${s.qCount} ta savol</span>
            <span><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>${s.mins} daqiqa</span>
          </div>
        </div>
      </div>
      <div class="skill-banner-arrow-btn" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m10 8 4 4-4 4"/></svg>
      </div>
    </button>
  `).join('');
}
renderSkillHub();

/* ---------------- Skill / Grammar Tab Switchers (Mashq qilish / Mocklar) ---------------- */
/* Ba'zi joylardan (masalan Dashboarddagi "Mock testlar" kartasi, yoki testdan/
   natijadan "Ortga" bilan qaytish) foydalanuvchi skillintro sahifasiga TO'G'RIDAN
   TO'G'RI Mocklar tabida kirib keladi — bu holatda bu bitta yagona harakat
   hisoblanadi, shuning uchun "Ortga" bosilganda avval "Mashq qilish" tabiga
   qaytmasdan, to'g'ridan-to'g'ri oldingi sahifaga (masalan Dashboard) chiqib
   ketishi kerak. Aksincha, foydalanuvchi sahifaning o'zida turib tab tugmasini
   bosib Mocklarga o'tgan bo'lsa, "Ortga" avval Mashq qilish tabiga qaytarishi
   kerak (bu ham alohida bitta harakatni bekor qilish hisoblanadi). Shu farqni
   ushbu flag orqali kuzatamiz. */
let skillIntroMocksIsEntryTab = false;
function switchSkillTab(tab, isDirectEntry = false){
  skillIntroMocksIsEntryTab = (tab === 'mocks') ? isDirectEntry : false;
  const tabToggle = document.getElementById('skillTabToggle');
  const mockTitle = document.getElementById('skillIntroMockTitle');
  const btnPractice = document.getElementById('skillTabPractice');
  const btnMocks = document.getElementById('skillTabMocks');
  const panePractice = document.getElementById('skillPanePractice');
  const paneMocks = document.getElementById('skillPaneMocks');

  const hasNoMocks = pendingSkillId === 'muhavara' || pendingSkillId === 'kitaba';

  if(hasNoMocks){
    if(tabToggle) tabToggle.style.display = 'none';
    if(mockTitle) mockTitle.style.display = 'none';
    if(paneMocks) paneMocks.style.display = 'none';
    if(panePractice) panePractice.style.display = 'block';
    return;
  }

  if(tab === 'mocks'){
    if(tabToggle) tabToggle.style.display = 'none';
    if(mockTitle) mockTitle.style.display = 'block';
    if(btnPractice){ btnPractice.classList.remove('active'); btnPractice.setAttribute('aria-selected', 'false'); }
    if(btnMocks){ btnMocks.classList.add('active'); btnMocks.setAttribute('aria-selected', 'true'); }
    if(panePractice) panePractice.style.display = 'none';
    if(paneMocks) paneMocks.style.display = 'block';
    renderSkillMockPanes();
  } else {
    if(tabToggle) tabToggle.style.display = 'flex';
    if(mockTitle) mockTitle.style.display = 'none';
    if(btnMocks){ btnMocks.classList.remove('active'); btnMocks.setAttribute('aria-selected', 'false'); }
    if(btnPractice){ btnPractice.classList.add('active'); btnPractice.setAttribute('aria-selected', 'true'); }
    if(paneMocks) paneMocks.style.display = 'none';
    if(panePractice) panePractice.style.display = 'block';
  }
}

function handleSkillIntroBack(){
  const paneMocks = document.getElementById('skillPaneMocks');
  if(paneMocks && paneMocks.style.display !== 'none' && !skillIntroMocksIsEntryTab){
    switchSkillTab('practice');
  } else {
    goBack();
  }
}

function handleQuizBack(){
  while(viewHistory.length > 0 && viewHistory[viewHistory.length - 1] === 'quiz'){
    viewHistory.pop();
  }
  if(currentQuiz && (currentQuiz.type === 'mock' || currentQuiz.mockId)){
    const sId = currentQuiz.skillId || 'grammatika';
    clearInterval(timerInterval); clearInterval(mcqTimerInterval);
    currentQuiz = null;
    openSkillIntro(sId);
    switchSkillTab('mocks', true);
    if(viewHistory.length === 0 || viewHistory[viewHistory.length - 1] !== 'skillintro'){
      viewHistory.push('skillintro');
    }
    showView('skillintro', false);
    return;
  }
  goBack();
}

function handleResultsBack(){
  while(viewHistory.length > 0 && (viewHistory[viewHistory.length - 1] === 'results' || viewHistory[viewHistory.length - 1] === 'quiz')){
    viewHistory.pop();
  }
  if(currentQuiz && currentQuiz.originView){
    const dest = currentQuiz.originView;
    currentQuiz.originView = null;
    showView(dest, false);
    return;
  }
  if(window.lastCompletedQuiz && (window.lastCompletedQuiz.type === 'mock' || window.lastCompletedQuiz.mockId)){
    const sId = window.lastCompletedQuiz.skillId || 'grammatika';
    openSkillIntro(sId);
    switchSkillTab('mocks', true);
    if(viewHistory.length === 0 || viewHistory[viewHistory.length - 1] !== 'skillintro'){
      viewHistory.push('skillintro');
    }
    showView('skillintro', false);
    return;
  }
  if(viewHistory.length > 0){
    const prev = viewHistory.pop();
    showView(prev, false);
    return;
  }
  showView('attanal', false);
}

function switchGrammarTab(tab){
  const btnPractice = document.getElementById('grammarTabPractice');
  const btnMocks = document.getElementById('grammarTabMocks');
  const panePractice = document.getElementById('grammarPanePractice');
  const paneMocks = document.getElementById('grammarPaneMocks');

  if(tab === 'mocks'){
    if(btnPractice){ btnPractice.classList.remove('active'); btnPractice.setAttribute('aria-selected', 'false'); }
    if(btnMocks){ btnMocks.classList.add('active'); btnMocks.setAttribute('aria-selected', 'true'); }
    if(panePractice) panePractice.style.display = 'none';
    if(paneMocks) paneMocks.style.display = 'block';
    renderSkillMockPanes();
  } else {
    if(btnMocks){ btnMocks.classList.remove('active'); btnMocks.setAttribute('aria-selected', 'false'); }
    if(btnPractice){ btnPractice.classList.add('active'); btnPractice.setAttribute('aria-selected', 'true'); }
    if(paneMocks) paneMocks.style.display = 'none';
    if(panePractice) panePractice.style.display = 'block';
  }
}

/* ---------------- Kunlik limit (mahorat bo'yicha) ----------------
   Admin panelda "Kunlik limitlar" bo'limida belgilangan qiymatlar
   window.SKILL_DAILY_LIMITS ichida (admin extension skripti tomonidan,
   HAR BIR foydalanuvchi uchun ilova ochilganda yuklanadi). Bu yerda esa
   shu limitni HAQIQATDA majburlaymiz: limitga yetilgan bo'lsa, testni
   boshlovchi HAR QANDAY yo'l (hub tugmasi, mavzu tugmasi, mikrofon
   tekshiruvi, kitaba) shu yerda to'xtatiladi va toast chiqadi. */
function getSkillDailyLimitValue(skillId){
  const map = window.SKILL_DAILY_LIMITS;
  const v = map && map[skillId];
  return (typeof v === 'number' && v > 0) ? v : 0;
}
function countSkillAttemptsToday(skillId){
  const rows = Array.isArray(window.HISTORY_DATA_LIVE) ? window.HISTORY_DATA_LIVE : [];
  const todayStr = new Date().toDateString();
  let n = 0;
  rows.forEach(r=>{
    const sid = pick(r, ['skill_id','skillId'], null);
    if(sid !== skillId) return;
    const iso = pick(r, ['created_at','createdAt','inserted_at'], null);
    if(!iso) return;
    const d = new Date(iso);
    if(!isNaN(d) && d.toDateString() === todayStr) n++;
  });
  return n;
}
/* true = ruxsat bor (davom etsa bo'ladi), false = limit tugagan (bloklandi + toast chiqdi)
   MUHIM: to'liq mock imtihon (FULL_EXAM.active) davomida bu tekshiruv butunlay
   o'chiriladi — aks holda, masalan, foydalanuvchi alohida mashqda Grammatika
   limitini tugatgan bo'lsa, keyin to'liq imtihonni boshlaganda aynan Grammatika
   bosqichiga yetganda imtihon "qotib qolar" edi (orqaga qaytish ham qulflangan
   bo'lgani uchun chiqib ketolmasdi). Kunlik limit faqat alohida (mock imtihondan
   tashqari) mashq/test boshlashga tegishli. */
function checkSkillDailyLimit(skillId){
  if(FULL_EXAM && FULL_EXAM.active) return true;
  const limit = getSkillDailyLimitValue(skillId);
  if(!limit) return true; // 0 yoki belgilanmagan = cheksiz
  const used = countSkillAttemptsToday(skillId);
  if(used >= limit){
    const meta = (typeof SKILLS !== 'undefined') ? SKILLS.find(s=>s.id===skillId) : null;
    const label = meta ? meta.name : skillId;
    toast(`⛔ ${label}: bugungi limitga yetdingiz (kuniga ${limit} marta). Ertaga qayta urinib ko'ring.`, 5000);
    return false;
  }
  return true;
}

/* ---------------- Skill intro screen ---------------- */
let pendingSkillId = null;
function openSkillIntro(id){
  const s = SKILLS.find(x=>x.id===id);
  if(!s) return;
  pendingSkillId = id;
  switchSkillTab('practice');
  const icon = document.getElementById('skillIntroIcon');
  icon.style.background = s.bg; icon.style.color = s.color;
  icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${SKILL_ICONS[s.id]}</svg>`;
  document.getElementById('skillIntroAr').textContent = s.ar;
  document.getElementById('skillIntroUz').textContent = s.name;
  document.getElementById('skillIntroDesc').innerHTML = s.desc;
  document.getElementById('skillIntroMeta').innerHTML = `
    <div class="meta-pill"><svg style="color:${s.color}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h5"/></svg><span>${s.qCount} ta savol</span></div>
    <div class="meta-pill"><svg style="color:${s.color}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg><span>${s.mins} daqiqa</span></div>
    <div class="meta-pill"><svg style="color:${s.color}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg><span>Max: ${s.total} ball</span></div>
  `;
  const btn = document.getElementById('skillIntroBtn');
  btn.textContent = s.btn;
  btn.style.background = s.color;
  showView('skillintro');
}
function beginPendingSkill(){
  if(!pendingSkillId) return;
  if(!checkSkillDailyLimit(pendingSkillId)) return;
  if(pendingSkillId==='kitaba'){ startKitabaExam(); }
  else if(pendingSkillId==='muhavara'){ openMicCheck(); }
  else{ startQuiz(pendingSkillId); }
}

/* ---------------- Mikrofonni tekshirish (Muhovara boshlanishidan oldin) ----------------
   Speaking bo'limi butunlay ovoz yozishga tayanadi — shuning uchun test boshlanishidan
   oldin, prep vaqti behuda ketmasligi uchun, mikrofon ruxsati va ishlashini alohida
   ekranda tekshiramiz. Faqat ruxsat berilgani emas, balki haqiqatan ham signal
   kelayotgani (RMS darajasi) tekshiriladi. */
let micCheckStream = null;
let micCheckAudioCtx = null;
let micCheckRaf = null;
let micCheckConfirmed = false;
let micCheckTimeoutHandled = false;
function openMicCheck(){
  micCheckConfirmed = false;
  micCheckTimeoutHandled = false;
  const statusEl = document.getElementById('micCheckStatus');
  statusEl.className = 'mic-check-status';
  statusEl.textContent = "Tekshirish uchun tugmani bosing, so'ng biror narsa gapiring";
  document.getElementById('micLevelFill').style.width = '0%';
  const btn = document.getElementById('micCheckBtn');
  btn.style.display = ''; btn.disabled = false; btn.textContent = '🎤 Mikrofonni tekshirish';
  document.getElementById('micStartExamBtn').style.display = 'none';
  showView('miccheck');
}
function stopMicCheckStream(){
  if(micCheckRaf){ cancelAnimationFrame(micCheckRaf); micCheckRaf = null; }
  if(micCheckStream){ micCheckStream.getTracks().forEach(t=>t.stop()); micCheckStream = null; }
  if(micCheckAudioCtx){ try{ micCheckAudioCtx.close(); }catch(e){} micCheckAudioCtx = null; }
}
async function runMicCheck(){
  const statusEl = document.getElementById('micCheckStatus');
  const btn = document.getElementById('micCheckBtn');
  const fill = document.getElementById('micLevelFill');
  stopMicCheckStream();
  micCheckConfirmed = false;
  micCheckTimeoutHandled = false;
  btn.disabled = true;
  statusEl.className = 'mic-check-status';
  statusEl.textContent = "Ruxsat so'ralmoqda...";
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    btn.disabled = false;
    btn.textContent = '🎤 Qayta urinish';
    statusEl.className = 'mic-check-status err';
    statusEl.textContent = "❌ Brauzeringiz yoki muhit mikrofonni qo'llab-quvvatlamaydi. Ilovani yangi oynada ochib ko'ring.";
    return;
  }
  try{
    micCheckStream = await navigator.mediaDevices.getUserMedia({audio:true});
  }catch(e){
    btn.disabled = false;
    btn.textContent = '🎤 Qayta urinish';
    statusEl.className = 'mic-check-status err';
    if(e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError'){
      statusEl.textContent = "❌ Mikrofonga ruxsat berilmadi yoki bloklangan. Brauzer manzillar qatoridagi 🔒 (yoki 🎤) belgisidan ruxsat bering.";
    } else {
      statusEl.textContent = "❌ Mikrofon topilmadi yoki ruxsat berilmadi: " + (e.message || e.name || '');
    }
    return;
  }
  btn.disabled = false;
  btn.textContent = '🔴 Tinglanmoqda...';
  statusEl.textContent = "Endi biror narsa gapiring — ovoz darajasi pastda ko'rinadi";
  micCheckAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = micCheckAudioCtx.createMediaStreamSource(micCheckStream);
  const analyser = micCheckAudioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  let peak = 0;
  const startedAt = Date.now();
  function tick(){
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for(let i=0;i<data.length;i++){ const v=(data[i]-128)/128; sum += v*v; }
    const rms = Math.sqrt(sum/data.length);
    const level = Math.min(100, Math.round(rms*260));
    fill.style.width = level+'%';
    if(level > peak) peak = level;
    if(!micCheckConfirmed && peak > 12){
      micCheckConfirmed = true;
      statusEl.className = 'mic-check-status ok';
      statusEl.textContent = "✅ Mikrofon ishlayapti! Imtihonni boshlashingiz mumkin.";
      btn.style.display = 'none';
      document.getElementById('micStartExamBtn').style.display = '';
    }
    if(!micCheckConfirmed && !micCheckTimeoutHandled && Date.now()-startedAt > 8000){
      micCheckTimeoutHandled = true;
      statusEl.className = 'mic-check-status err';
      statusEl.textContent = "🔇 Ovoz eshitilmayapti. Mikrofon tanlovini tekshiring yoki baribir davom eting.";
      btn.textContent = '🎤 Qayta urinish';
      document.getElementById('micStartExamBtn').style.display = '';
    }
    micCheckRaf = requestAnimationFrame(tick);
  }
  tick();
}
function confirmMicCheckAndStartMuhavara(){
  stopMicCheckStream();
  startQuiz('muhavara');
}

/* ---------------- Grammar topics ---------------- */
const GRAMMAR_CATEGORIES = [
  {id:'nahv', name:'Nahv', ar:'النحو', desc:"Gap tuzilishi va i'rob qoidalari", icon:'<rect x="9" y="2" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>', color:'var(--istima)', bg:'var(--istima-bg)'},
  {id:'sarf', name:'Sarf', ar:'الصرف', desc:"So'z yasalishi va shakllanishi", icon:'<path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>', color:'var(--qiroa)', bg:'var(--qiroa-bg)'},
  {id:'imlo', name:'Imlo', ar:'الإملاء', desc:"To'g'ri yozish (imlo) qoidalari", icon:'<path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h0c1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V21z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h0c1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V21z"/>', color:'var(--muhavara)', bg:'var(--muhavara-bg)'},
  {id:'xatolar', name:'Umumiy xatolar', ar:'الأخطاء الشائعة', desc:"Ko'p uchraydigan xatolarni bartaraf etish", icon:'<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>', color:'var(--red)', bg:'var(--red-bg)'},
];
/* STATIK MA'LUMOT OLIB TASHLANDI: mavzular ro'yxati endi to'liq backenddan
   (Supabase "grammar_topics" jadvali) keladi — pastga qarang loadGrammarTopicsFromBackend()
   va applyLiveGrammarTopics(). Backendda hali mavzu bo'lmasa, bu massiv bo'sh qoladi va
   admin panel ("Grammatika mavzulari" bo'limi) orqali 0 dan qo'shiladi. */
let GRAMMAR_TOPICS = [];
let grammarProgressLoaded = false;
/* Backend qatorini ilova ichida ishlatiladigan shaklga o'giradi. */
function mapBackendGrammarTopic(row){
  return { id: row.id, category: row.category, name: row.name, ar: row.ar, pct:0, attempted:false };
}
function applyLiveGrammarTopics(rows){
  GRAMMAR_TOPICS = (Array.isArray(rows) ? rows : []).map(mapBackendGrammarTopic);
  computeGrammarTopicProgress();
  renderGrammarCategories();
  if(typeof renderAdminQuestions==='function' && document.getElementById('adminTab-questions')) renderAdminQuestions();
}
/* HISTORY_DATA_LIVE (backend "quiz_attempts" jadvali) ichidan har bir grammatika
   mavzusi bo'yicha ENG SO'NGGI urinishni topib, GRAMMAR_TOPICS[].pct'ni shu bilan
   yangilaydi. Hali umuman urinish bo'lmagan mavzular attempted:false bo'lib qoladi. */
function computeGrammarTopicProgress(){
  const rows = Array.isArray(window.HISTORY_DATA_LIVE) ? window.HISTORY_DATA_LIVE : [];
  const byTopic = {};
  rows.forEach(r=>{
    const skillId = pick(r, ['skill_id','skillId'], null);
    const topicId = pick(r, ['topic_id','topicId'], null);
    if(skillId !== 'grammatika' || !topicId) return;
    const createdAt = pick(r, ['created_at','createdAt','inserted_at'], null);
    if(!byTopic[topicId]) byTopic[topicId] = [];
    byTopic[topicId].push({
      correct: Number(pick(r, ['correct'], 0)) || 0,
      total: Number(pick(r, ['total'], 0)) || 0,
      createdAt,
    });
  });
  GRAMMAR_TOPICS.forEach(t=>{
    const attempts = byTopic[t.id];
    if(attempts && attempts.length){
      attempts.sort((a,b)=> new Date(b.createdAt||0) - new Date(a.createdAt||0));
      const last = attempts[0];
      t.pct = last.total ? Math.round((last.correct/last.total)*100) : 0;
      t.attempted = true;
    } else {
      t.pct = 0;
      t.attempted = false;
    }
  });
  grammarProgressLoaded = true;
}
let grammarTopicsLoaded = false;
function renderGrammarCategories(){
  const wrap = document.getElementById('grammarCatGrid');
  if(!wrap) return;
  if(!grammarTopicsLoaded && (!GRAMMAR_TOPICS || !GRAMMAR_TOPICS.length)){
    wrap.innerHTML = GRAMMAR_CATEGORIES.map(cat=>`
      <div class="grammar-cat-wrap">
        <div class="skel-grammar-card">
          <div class="skel skel-circle" style="width:40px;height:40px;border-radius:12px;"></div>
          <div style="flex:1;display:flex;flex-direction:column;gap:6px;">
            <div class="skel skel-line" style="width:40%;height:15px;"></div>
            <div class="skel skel-line" style="width:65%;height:11px;"></div>
          </div>
          <div class="skel skel-box" style="width:48px;height:24px;border-radius:12px;"></div>
        </div>
      </div>
    `).join('');
    return;
  }
  wrap.innerHTML = GRAMMAR_CATEGORIES.map(cat=>{
    const topics = GRAMMAR_TOPICS.filter(t=>t.category===cat.id);
    const attemptedTopics = topics.filter(t=>t.attempted);
    const avgPct = attemptedTopics.length ? Math.round(attemptedTopics.reduce((s,t)=>s+t.pct,0)/attemptedTopics.length) : null;
    const avgLabel = avgPct===null ? (grammarProgressLoaded ? '—' : '···') : avgPct+'%';
    return `
    <div class="grammar-cat-wrap fade-in-enter" data-cat="${cat.id}">
      <div class="grammar-cat-card gcat-${cat.id}" onclick="toggleGrammarCat('${cat.id}')">
        <div class="grammar-cat-icon"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${cat.icon}</svg></div>
        <div class="grammar-cat-main">
          <div class="grammar-cat-name">${cat.ar}</div>
          <div class="grammar-cat-desc">${cat.desc} · ${topics.length} ta mavzu</div>
        </div>
        <div class="grammar-cat-pct">${avgLabel}</div>
        <svg class="grammar-cat-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
      </div>
      <div class="grammar-cat-topics" id="cat-topics-${cat.id}">
        <div class="grammar-cat-topics-inner">
          ${topics.map(t=>`
            <div class="topic-item">
              <div class="topic-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
              </div>
              <div>
                <div class="t ar">${t.ar}</div>
              </div>
              <div class="topic-mini">
                <span class="pct">${t.attempted ? t.pct+'%' : (grammarProgressLoaded ? '—' : '···')}</span>
                <button class="topic-start-btn" aria-label="Testni boshlash" onclick="event.stopPropagation();startQuiz('grammatika','${t.name.replace(/'/g,"\\'")}','${t.id}')">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m10 8 4 4-4 4"/></svg>
                </button>
              </div>
            </div>`).join('')}
        </div>
      </div>
    </div>`;
  }).join('');
  /* Grammatika cardlari admin panelda yashirilgan/qulflangan bo'lishi mumkin — bu holat
     localStorage/backend'dan keladi (qarang: REAL ADMIN EXTENSION, applyGrammarCardLockState).
     innerHTML har safar qayta yozilganda shu holatni qayta tiklab qo'yamiz. */
  if(typeof window.applyGrammarCardLockState === 'function') window.applyGrammarCardLockState();
}
function toggleGrammarCat(id){
  const w = document.querySelector(`.grammar-cat-wrap[data-cat="${id}"]`);
  if(w) w.classList.toggle('open');
}
renderGrammarCategories();

/* ---- Grammatika bo'limi tarixi (Hammasi / Xatolar / To'g'ri) ---- */
let grammarHistFilterVal = 'hammasi';
function renderGrammarHistory(){
  const list = HISTORY_DATA.filter(r=>{
    if(r.section!=='Grammatika') return false;
    const pct = Math.round(r.correct/r.total*100);
    if(grammarHistFilterVal==='xato') return pct<60;
    if(grammarHistFilterVal==='togri') return pct>=60;
    return true;
  });
  const el = document.getElementById('grammarHistList');
  const empty = document.getElementById('grammarHistEmpty');
  if(!el) return;
  if(!historyLoaded){
    if(empty) empty.style.display = 'none';
    el.innerHTML = Array.from({length:2}).map(()=>`
      <div class="card history-item skel-history-item">
        <div class="skel skel-circle" style="width:38px;height:38px;border-radius:10px;"></div>
        <div class="history-main" style="display:flex;flex-direction:column;gap:6px;">
          <div class="skel skel-line" style="width:50%;height:13px;"></div>
          <div class="skel skel-line" style="width:30%;height:11px;"></div>
        </div>
        <div class="skel skel-box" style="width:48px;height:22px;border-radius:8px;"></div>
      </div>
    `).join('');
    return;
  }
  if(empty) empty.style.display = list.length? 'none':'block';
  el.innerHTML = list.map(r=>{
    const pct = Math.round(r.correct/r.total*100);
    const gt = GRAMMAR_TOPICS.find(t=>t.id===r.topicId);
    const mainLine = gt
      ? `<div class="t ar">${gt.ar}</div>`
      : `<div class="t">${escapeHtml(r.topic)}</div>`;
    const attemptIdStr = String(r.id).replace(/'/g, "\\'");
    const meta = getSkillSvgMeta(r);
    return `
    <div class="card history-item fade-in-enter">
      <div class="history-icon" style="background:${meta.bg};color:${meta.color};">${meta.svg}</div>
      <div class="history-main">
        ${mainLine}
        <div class="s" style="margin-top:3px;">${r.date}, ${r.time}</div>
      </div>
      <div class="history-score"><b>${r.correct}/${r.total}</b><div class="p">${pct}%</div></div>
      <button type="button" class="history-btn-analyze" onclick="openAttemptResults('${attemptIdStr}')">
        <span>Tahlil</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>
      </button>
    </div>`;
  }).join('');
}
const grammarHistFilterEl = document.getElementById('grammarHistFilter');
if(grammarHistFilterEl){
  grammarHistFilterEl.addEventListener('click', e=>{
    const btn = e.target.closest('.filter-chip'); if(!btn) return;
    document.querySelectorAll('#grammarHistFilter .filter-chip').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active'); grammarHistFilterVal = btn.dataset.val; renderGrammarHistory();
  });
}

/* ================= HISTORY (Tarix) VA SAQLANGAN URINISHLAR ================= */
const ATTEMPTS_STORE_KEY = 'at_tanal_full_attempts_store_v3';
let ATTEMPTS_STORE_MAP = {};
try {
  const raw = localStorage.getItem(ATTEMPTS_STORE_KEY);
  if(raw) ATTEMPTS_STORE_MAP = JSON.parse(raw);
} catch(e){
  ATTEMPTS_STORE_MAP = {};
}

function saveFullAttemptSnapshot(attempt){
  if(!attempt || !attempt.id) return;
  try {
    const key = String(attempt.id);
    ATTEMPTS_STORE_MAP[key] = attempt;
    const keys = Object.keys(ATTEMPTS_STORE_MAP);
    if(keys.length > 200){
      keys.slice(0, keys.length - 200).forEach(k => delete ATTEMPTS_STORE_MAP[k]);
    }
    localStorage.setItem(ATTEMPTS_STORE_KEY, JSON.stringify(ATTEMPTS_STORE_MAP));
  } catch(e){
    console.warn("Attempt store saving error", e);
  }
}

let HISTORY_DATA = [];
let historyLoaded = false;

/* Backend qatorini (quiz_attempts) ekranda ishlatiladigan shaklga o'giradi */
function mapBackendHistoryRow(row, idx){
  const skillId = pick(row, ['skill_id','skillId'], 'grammatika');
  const meta = SKILL_META[skillId] || {section:skillId, icon:'📘', color:'var(--grammatika)', bg:'var(--grammatika-bg)'};
  const topicName = pick(row, ['topic_name','topicName'], null);
  const topicId = pick(row, ['topic_id','topicId'], undefined);
  const {date, time, dateGroup} = fmtBackendDate(pick(row, ['created_at','createdAt','inserted_at'], null));
  const id = pick(row, ['id'], 'b_att_' + (idx+1));
  const correct = pick(row, ['correct'], 0);
  const total = pick(row, ['total'], 1);

  // Lokal saqlangan savollar snapshotini qidiramiz
  const saved = ATTEMPTS_STORE_MAP[String(id)] ||
                Object.values(ATTEMPTS_STORE_MAP).find(s =>
                  (topicId && s.topicId === topicId && s.correct === correct && s.total === total) ||
                  (topicName && s.topic && s.topic.includes(topicName) && s.correct === correct)
                );

  return {
    id: id,
    skillId,
    section: meta.section,
    topic: topicName ? `${meta.section} — ${topicName}` : meta.section,
    topicId,
    date, time, dateGroup,
    correct,
    total,
    wrong: total - correct,
    pct: total > 0 ? Math.round((correct/total)*100) : 0,
    icon: meta.icon, color: meta.color, bg: meta.bg,
    questions: saved?.questions || null,
    mistakes: saved?.mistakes || null,
    elapsed: saved?.elapsed || '',
    xp: saved?.xp || correct,
    level: saved?.level || null,
    createdAt: pick(row, ['created_at','createdAt','inserted_at'], new Date().toISOString())
  };
}

function applyLiveHistory(){
  historyLoaded = true;
  let backendList = [];
  if(Array.isArray(window.HISTORY_DATA_LIVE) && window.HISTORY_DATA_LIVE.length){
    backendList = window.HISTORY_DATA_LIVE.map(mapBackendHistoryRow);
  }

  // Lokal saqlangan urinishlarni ham qo'shamiz (backendda hali bo'lmaganlari).
  // MUHIM: bu yerda faqat ID bo'yicha solishtirib bo'lmaydi — lokal urinish
  // tugagan zahoti mijozda o'zi uchun o'ylab topilgan ID (att_...) bilan
  // saqlanadi, keyin backendga yuboriladi va u yerda Supabase o'zining
  // BUTUNLAY BOSHQA ID'sini beradi. Shu sabab ID bo'yicha solishtirsak,
  // hech qachon mos kelmaydi va bitta urinish ikki marta (bittasi lokal
  // saqlangan "22-avg" formatidagi sana bilan, ikkinchisi backenddan kelib,
  // "Bugun" kabi nisbiy sana bilan) Tarixda qatorlanib qolaveradi. Shuning
  // uchun mahorat+mavzu+ball+vaqt yaqinligiga qarab solishtiramiz.
  const localList = Object.values(ATTEMPTS_STORE_MAP).filter(loc => {
    const locTime = loc.createdAt ? new Date(loc.createdAt).getTime() : 0;
    return !backendList.some(b => {
      if(String(b.id) === String(loc.id)) return true;
      const sameSkill = b.skillId === loc.skillId;
      const sameTopic = (b.topicId ?? null) === (loc.topicId ?? null);
      const sameScore = b.correct === loc.correct && b.total === loc.total;
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      const closeTime = !!locTime && !!bTime && Math.abs(bTime - locTime) < 10*60*1000; // 10 daqiqa ichida
      return sameSkill && sameTopic && sameScore && closeTime;
    });
  });

  HISTORY_DATA = [...localList, ...backendList].sort((a,b) => {
    const da = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const db = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return db - da;
  });

  renderHistoryStats();
  renderHistoryList();
  renderGrammarHistory();
  computeGrammarTopicProgress();
  if(document.getElementById('view-grammar')?.classList.contains('active')) renderGrammarCategories();
  renderDashboardPracticeCards();
}

/* ================= XATOLARIM (foydalanuvchi xato javob bergan savollar) ================= */
/* MOSLASHTIRING: user_errors jadvalingizdagi ustun nomlari boshqacha bo'lsa, pick() ro'yxatiga qo'shing. */
let errorsLoaded = false;
function mapBackendErrorRow(row, idx){
  const skillId = pick(row, ['skill_id','skillId'], 'grammatika');
  const meta = SKILL_META[skillId] || {section:skillId, icon:'📘', color:'var(--grammatika)', bg:'var(--grammatika-bg)'};
  const {date, time} = fmtBackendDate(pick(row, ['created_at','createdAt','inserted_at'], null));
  return {
    id: pick(row, ['id'], idx+1),
    section: meta.section,
    topic: pick(row, ['topic_name','topicName'], meta.section),
    icon: meta.icon, bg: meta.bg,
    q: pick(row, ['question','question_text','q'], ''),
    picked: pick(row, ['picked_answer','user_answer','picked'], '—'),
    correctAns: pick(row, ['correct_answer','correct','answer'], '—'),
    exp: pick(row, ['explanation','exp'], ''),
    date, time,
  };
}
function applyLiveErrors(){
  errorsLoaded = true;
  const wrap = document.getElementById('errorsListWrap');
  const empty = document.getElementById('errorsEmpty');
  if(!wrap) return;
  const rows = Array.isArray(window.USER_ERRORS_LIVE) ? window.USER_ERRORS_LIVE.map(mapBackendErrorRow) : [];
  if(!rows.length){
    wrap.innerHTML = '';
    if(empty) empty.style.display = 'block';
    return;
  }
  if(empty) empty.style.display = 'none';
  wrap.innerHTML = rows.map(r=>`
    <div class="card mistake-item">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
        <div class="history-icon" style="background:${r.bg};width:32px;height:32px;font-size:15px;">${r.icon}</div>
        <div style="min-width:0;">
          <div style="font-size:12.5px;font-weight:600;">${r.section}${r.topic && r.topic!==r.section ? ' · '+r.topic : ''}</div>
          <div style="font-size:11px;color:var(--text-faint);font-weight:600;">${r.date}${r.time?', '+r.time:''}</div>
        </div>
      </div>
      <div class="mistake-q">${r.q}</div>
      <div class="mistake-row wrong">✕ Sizning javobingiz: ${r.picked}</div>
      <div class="mistake-row right">✓ To'g'ri javob: ${r.correctAns}</div>
      ${r.exp ? `<div class="mistake-exp">💡 ${r.exp}</div>` : ''}
    </div>
  `).join('');
}
let historyFilters = {section:'Barchasi', date:'7kun'};

function statusOf(pct){
  if(pct>=85) return {label:"A'lo", cls:'badge-elite'};
  if(pct>=60) return {label:'Yaxshi', cls:'badge-good'};
  return {label:'Qoniqarsiz', cls:'badge-poor'};
}
function renderHistoryStats(){
  // Tarix sahifasidagi umumiy statistika kartalari foydalanuvchi talabiga ko'ra olib tashlangan
}
function renderHistoryList(){
  const el = document.getElementById('historyList');
  if(!el) return;
  if(!historyLoaded){
    const emptyEl = document.getElementById('historyEmpty');
    if(emptyEl) emptyEl.style.display = 'none';
    el.innerHTML = Array.from({length:4}).map(()=>`
      <div class="card history-item skel-history-item">
        <div class="skel skel-circle" style="width:42px;height:42px;border-radius:12px;"></div>
        <div class="history-main" style="display:flex;flex-direction:column;gap:6px;">
          <div class="skel skel-line" style="width:55%;height:14px;"></div>
          <div class="skel skel-line" style="width:35%;height:11px;"></div>
        </div>
        <div class="skel skel-box" style="width:52px;height:24px;border-radius:8px;"></div>
        <div class="skel skel-box" style="width:64px;height:22px;border-radius:12px;"></div>
      </div>
    `).join('');
    return;
  }
  const list = HISTORY_DATA.filter(r=>{
    const sOk = historyFilters.section==='Barchasi' || r.section===historyFilters.section;
    const dOk = historyFilters.date==='hammasi' || r.dateGroup===historyFilters.date || (historyFilters.date==='oy' && r.dateGroup==='7kun');
    return sOk && dOk;
  });
  document.getElementById('historyEmpty').style.display = list.length? 'none':'block';
  el.innerHTML = list.map(r=>{
    const pct = Math.round(r.correct/r.total*100);
    const attemptIdStr = String(r.id).replace(/'/g, "\\'");
    const isWritingOrSpeaking = (r.skillId === 'kitaba' || r.skillId === 'muhavara' || r.type === 'writing' || r.type === 'speaking' || String(r.topic||'').toLowerCase().includes('kitab') || String(r.topic||'').toLowerCase().includes('muhav') || String(r.section||'').toLowerCase().includes('yozish') || String(r.section||'').toLowerCase().includes('so\'zlash'));
    const scoreDisplay = isWritingOrSpeaking ? `${r.correct}/${r.total} ball` : `${r.correct}/${r.total}`;
    const meta = getSkillSvgMeta(r);
    return `
    <div class="card history-item fade-in-enter">
      <div class="history-icon" style="background:${meta.bg};color:${meta.color};">${meta.svg}</div>
      <div class="history-main">
        <div class="t">${escapeHtml(formatHistoryDisplayTitle(r))}</div>
        <div class="s">${r.date}, ${r.time}</div>
      </div>
      <div class="history-score"><b>${scoreDisplay}</b><div class="p">${pct}%</div></div>
      <button type="button" class="history-btn-analyze" onclick="openAttemptResults('${attemptIdStr}')">
        <span>Tahlil</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>
      </button>
    </div>`;
  }).join('');
}
initCustomDropdown('historySkillDropdown', {
  label: 'Mahorat',
  options: [{ value: 'Barchasi', label: 'Barchasi' }].concat(SKILLS.map(s => ({ value: s.name, label: s.name }))).concat([{ value: 'Imtihon', label: 'Imtihon' }]),
  value: historyFilters.section,
  onChange: (val) => {
    historyFilters.section = val;
    renderHistoryList();
  }
});

initCustomDropdown('historyPeriodDropdown', {
  label: 'Davr',
  options: [
    { value: '7kun', label: 'Oxirgi 7 kun' },
    { value: 'oy', label: 'Shu oy' },
    { value: 'hammasi', label: 'Butun davr' },
  ],
  value: historyFilters.date,
  onChange: (val) => {
    historyFilters.date = val;
    renderHistoryList();
  }
});

renderHistoryStats();
renderHistoryList();
renderGrammarHistory();

/* mistake modal (reused for history review) */
const ATTEMPT_MISTAKES_STORAGE_KEY = 'at_tanal_attempt_mistakes_v2';
let ATTEMPT_MISTAKES_MAP = {};
try {
  const raw = localStorage.getItem(ATTEMPT_MISTAKES_STORAGE_KEY);
  if(raw) ATTEMPT_MISTAKES_MAP = JSON.parse(raw);
} catch(e){
  ATTEMPT_MISTAKES_MAP = {};
}

function saveMistakesForAttempt(attemptKey, mistakes){
  if(!attemptKey || !Array.isArray(mistakes)) return;
  try {
    ATTEMPT_MISTAKES_MAP[String(attemptKey)] = mistakes;
    const keys = Object.keys(ATTEMPT_MISTAKES_MAP);
    if(keys.length > 150){
      keys.slice(0, keys.length - 150).forEach(k => delete ATTEMPT_MISTAKES_MAP[k]);
    }
    localStorage.setItem(ATTEMPT_MISTAKES_STORAGE_KEY, JSON.stringify(ATTEMPT_MISTAKES_MAP));
  } catch(e){}
}

function retryQuizFromHistory(section, topicId, topicLabel){
  const sStr = String(section || '').toLowerCase();
  const skill = SKILLS.find(s => s.name.toLowerCase() === sStr || s.id.toLowerCase() === sStr);
  const skillId = skill ? skill.id : (topicId ? 'grammatika' : 'grammatika');
  startQuiz(skillId, topicLabel || skill?.name, topicId || null);
}

/* ============================================================
   URINISHDAGI BARCHA SAVOLLAR VA NATIJANI OCHISH (REVIEW SCREEN)
   ============================================================ */
function openAttemptResults(id){
  const idStr = String(id || '');
  let rec = ATTEMPTS_STORE_MAP[idStr] ||
            HISTORY_DATA.find(r => String(r.id) === idStr) ||
            (Array.isArray(window.HISTORY_DATA_LIVE) ? window.HISTORY_DATA_LIVE.find(r => String(r.id) === idStr) : null);

  if(!rec){
    rec = HISTORY_DATA.find(r => String(r.id).includes(idStr) || (r.topic && r.topic === idStr));
  }

  // 1. Agar Kitaba (Yozish) yoki Muhavara (So'zlashuv) bo'lsa — maxsus tahlil modalini ochamiz
  const isWritingOrSpeaking = rec && (
    rec.skillId === 'kitaba' || rec.skillId === 'muhavara' ||
    rec.type === 'writing' || rec.type === 'speaking' ||
    String(rec.topic||'').toLowerCase().includes('kitab') ||
    String(rec.topic||'').toLowerCase().includes('yozma') ||
    String(rec.topic||'').toLowerCase().includes('muhav') ||
    String(rec.topic||'').toLowerCase().includes('so\'zlash') ||
    String(rec.section||'').toLowerCase().includes('yozish') ||
    String(rec.section||'').toLowerCase().includes('so\'zlash')
  );

  if(isWritingOrSpeaking){
    openSpeakingOrWritingAttemptModal(rec, idStr);
    return;
  }

  const savedQuestions = (rec && Array.isArray(rec.questions) && rec.questions.length > 0)
    ? rec.questions
    : (ATTEMPTS_STORE_MAP[idStr] && Array.isArray(ATTEMPTS_STORE_MAP[idStr].questions) ? ATTEMPTS_STORE_MAP[idStr].questions : null);

  const activeViewEl = document.querySelector('.view.active');
  const activeViewName = activeViewEl ? activeViewEl.id.replace('view-', '') : 'history';

  // 2. Agar ushbu urinishda tushgan savollarning to'liq ro'yxati (va user bergan javoblari) mavjud bo'lsa:
  // Natijalar ekrani (view-results)ni ochib, to'liq Savollar bo'yicha tahlilni ko'rsatamiz!
  if(savedQuestions && savedQuestions.length > 0){
    const total = savedQuestions.length;
    const correct = savedQuestions.filter(q => q.picked === q.a).length;
    const wrong = total - correct;
    const pct = total > 0 ? Math.round((correct / total) * 100) : (rec && rec.total ? Math.round((rec.correct / rec.total) * 100) : 0);
    const xp = correct;
    const sMeta = SKILL_META[rec?.skillId] || { section: rec?.section || 'Grammatika', color: rec?.color || 'var(--indigo-600)', bg: rec?.bg || 'var(--indigo-100)' };

    currentQuiz = {
      id: rec?.id || idStr,
      skillId: rec?.skillId || 'grammatika',
      topicId: rec?.topicId || null,
      label: rec?.label || rec?.topic || sMeta.section,
      mockId: rec?.mockId || null,
      type: rec?.type || 'quiz',
      color: rec?.color || sMeta.color,
      bg: rec?.bg || sMeta.bg,
      questions: savedQuestions,
      isReviewMode: true,
      originView: (activeViewName === 'results' || activeViewName === 'quiz') ? 'history' : activeViewName
    };

    window.lastCompletedQuiz = { ...currentQuiz };

    // Natijalar ekranidagi elementlarni yangilaymiz
    const topicEl = document.getElementById('resultTopic');
    if(topicEl) topicEl.textContent = currentQuiz.label;

    const isMock = !!(rec?.mockId || rec?.type === 'mock');
    const isSkillExam = !isMock && !rec?.topicId;
    const levelWrap = document.querySelector('.result-level-wrap');
    const levelTagEl = document.querySelector('.result-level-tag');
    if(levelWrap){
      levelWrap.style.display = (isSkillExam && rec?.level && pct >= 25) ? 'flex' : 'none';
      if(rec?.level && pct >= 25){
        if(levelTagEl) levelTagEl.style.display = '';
        const lvlEl = document.getElementById('resultLevel');
        if(lvlEl){
          lvlEl.style.display = '';
          lvlEl.textContent = rec.level;
          if(rec.level.length > 3){
            lvlEl.classList.add('is-message');
          } else {
            lvlEl.classList.remove('is-message');
          }
        }
      }
    }

    const resTimeEl = document.getElementById('resTime');
    if(resTimeEl) resTimeEl.textContent = rec?.elapsed || '00:00';

    const r = 52, c = 2 * Math.PI * r;
    const ring = document.getElementById('resultRing');
    if(ring){
      ring.style.stroke = currentQuiz.color;
      ring.setAttribute('stroke-dasharray', c);
      ring.setAttribute('stroke-dashoffset', c - (pct / 100) * c);
    }

    const cEl = document.getElementById('resultCorrect');
    const tEl = document.getElementById('resultTotal');
    const xpEl = document.getElementById('resultXP');
    const wEl = document.getElementById('resWrong');
    if(cEl) cEl.textContent = String(correct);
    if(tEl) tEl.textContent = String(total);
    if(xpEl) xpEl.textContent = `+${xp}`;
    if(wEl) wEl.textContent = String(wrong);

    const titleEl = document.getElementById('resultTitle');
    const subEl = document.getElementById('resultSub');
    if(pct < 25){
      if(levelTagEl) levelTagEl.style.display = 'none';
      titleEl.textContent = 'Daraja aniqlanmadi';
      subEl.textContent = "Ko'proq mashq qiling, keyingi safar albatta chiqadi!";
    } else {
      if(levelTagEl) levelTagEl.style.display = '';
      if(pct === 100){
        titleEl.textContent = 'Ajoyibsiz! 🎉';
        subEl.textContent = "Siz barcha savollarga to'g'ri javob berdingiz.";
      } else if(pct >= 80){
        titleEl.textContent = "Zo'r natija! 👏";
        subEl.textContent = `Siz ${total} tadan ${correct} tasiga to'g'ri javob berdingiz.`;
      } else if(pct >= 50){
        titleEl.textContent = 'Yaxshi harakat! 💪';
        subEl.textContent = "Yana biroz mashq qilsangiz, natija yanada yaxshilanadi.";
      } else {
        titleEl.textContent = 'Yaxshi harakat! 💪';
        subEl.textContent = "Yana biroz mashq qilsangiz, natija yanada yaxshilanadi.";
      }
    }

    const analyzeBtn = document.getElementById('analyzeBtn');
    if(analyzeBtn){
      analyzeBtn.textContent = 'Savollar tahlilini ko‘rish';
      analyzeBtn.onclick = showMistakes;
    }

    renderReviewGrid();
    showView('results');
    return;
  }

  // 3. Agar to'liq savollar ro'yxati yo'q bo'lsa (eski backend ma'lumoti) - xatolar tahlili modalini ochamiz
  openMistakeModalFallback(rec, idStr);
}

// Alias for backwards-compatibility
function openMistakeModal(id){
  openAttemptResults(id);
}

/* ================= Speaking (Muhavara) va Writing (Kitaba) uchun maxsus tahlil oynasi ================= */
function openSpeakingOrWritingAttemptModal(rec, idStr){
  const isWriting = rec && (
    rec.skillId === 'kitaba' || rec.type === 'writing' ||
    String(rec.topic||'').toLowerCase().includes('kitab') ||
    String(rec.topic||'').toLowerCase().includes('yozma') ||
    String(rec.section||'').toLowerCase().includes('yozish')
  );

  const totalScore = rec ? (rec.correct ?? 0) : 0;
  const maxScore = rec ? (rec.total || (isWriting ? 30 : 30)) : (isWriting ? 30 : 30);
  const pct = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;
  const cefr = getCEFRLevel(pct);
  const totalScoreDisplay = Math.round(totalScore * 10) / 10;

  const savedQuestions = (rec && Array.isArray(rec.questions) && rec.questions.length > 0)
    ? rec.questions
    : (ATTEMPTS_STORE_MAP[idStr] && Array.isArray(ATTEMPTS_STORE_MAP[idStr].questions) ? ATTEMPTS_STORE_MAP[idStr].questions : null);

  const overlay = document.getElementById('modalOverlay');
  const titleEl = document.getElementById('modalTitle');
  const bodyEl = document.getElementById('modalBody');

  if(isWriting){
    titleEl.textContent = `${rec?.topic || 'Yozish (Kitaba)'} — Natija va Tahlil`;
    let contentHtml = `
      <div class="prompt-box" style="text-align:center;margin-bottom:16px;">
        <div class="lbl">Natija</div>
        <div style="font-size:32px;font-weight:700;margin:6px 0;color:var(--text);">${totalScoreDisplay} / ${maxScore} ball</div>
        <div style="color:var(--text-faint);font-size:13px;font-weight:600;">${pct}% · ${cefr && cefr.length <= 3 ? cefr + ' daraja' : `<span style="font-size:12px;color:var(--text-dim);font-weight:600;">${cefr}</span>`}</div>
      </div>
    `;

    if(savedQuestions && savedQuestions.length > 0){
      contentHtml += `
        <div style="display:flex;flex-direction:column;gap:12px;margin-top:10px;">
          ${savedQuestions.map((q, idx) => `
            <div class="card" style="padding:16px;background:var(--card);border:1.5px solid var(--border);border-radius:14px;display:flex;flex-direction:column;gap:8px;">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <div class="t-name" style="font-size:13px;font-weight:700;color:var(--indigo-700);">${q.part?.name || `${idx + 1}-topshiriq`}</div>
                <div style="font-weight:700;font-size:15px;color:var(--text);">${q.score ?? 0}/10 ball</div>
              </div>
              <div dir="rtl" style="font-family:var(--font-ar);font-size:15.5px;line-height:1.7;color:var(--text);font-weight:600;background:var(--card-alt);padding:8px 12px;border-radius:10px;">
                ${escapeHtml(q.topic?.topicAr || q.topicAr || '')}
              </div>
              ${q.text ? `
                <div style="margin-top:4px;">
                  <div style="font-size:12px;font-weight:700;color:var(--text-faint);margin-bottom:4px;">Sizning yozgan matningiz:</div>
                  <div dir="rtl" style="font-family:var(--font-ar);font-size:14.5px;line-height:1.75;padding:10px 12px;border-radius:10px;background:var(--card-alt);border:1px solid var(--border);color:var(--text);">
                    ${escapeHtml(q.text)}
                  </div>
                </div>
              ` : ''}
              ${q.criteria ? `
                <div style="display:flex;flex-direction:column;gap:4px;margin-top:4px;padding:8px 10px;background:var(--card-alt);border-radius:10px;font-size:12px;font-weight:600;">
                  ${Object.entries(q.criteria).map(([k, v]) => `
                    <div style="display:flex;justify-content:space-between;">
                      <span style="color:var(--text-dim);">${escapeHtml(k)}:</span>
                      <span style="color:var(--text);">${escapeHtml(String(v))}</span>
                    </div>
                  `).join('')}
                </div>
              ` : ''}
              ${q.feedback ? `
                <div style="font-size:12.5px;color:var(--text-dim);background:var(--card-alt);padding:8px 12px;border-radius:10px;line-height:1.5;">
                  <b style="color:var(--indigo-700);">💡 AI izohi:</b> ${escapeHtml(q.feedback)}
                </div>
              ` : ''}
              ${q.corrected ? `
                <div style="margin-top:4px;">
                  <div style="font-size:12px;font-weight:700;color:var(--green);margin-bottom:4px;">Tavsiya etilgan to'g'ri matn:</div>
                  <div dir="rtl" style="font-family:var(--font-ar);font-size:14px;line-height:1.75;padding:8px 12px;border-radius:10px;background:var(--green-bg);border:1px solid rgba(18,167,104,0.25);color:var(--text);">
                    ${escapeHtml(q.corrected)}
                  </div>
                </div>
              ` : ''}
            </div>
          `).join('')}
        </div>
      `;
    } else {
      contentHtml += `
        <div class="placeholder-card" style="padding:22px 16px;text-align:center;">
          <div style="font-size:36px;margin-bottom:10px;">✍️</div>
          <p style="font-size:13.5px;color:var(--text-dim);margin:0 0 16px;line-height:1.55;">
            Ushbu urinishda <b>3 ta yozma topshiriq</b> bo'yicha jami <b>${totalScoreDisplay} / ${maxScore} ball</b> to'plangan.
          </p>
        </div>
      `;
    }

    contentHtml += `
      <div style="display:flex;gap:10px;margin-top:16px;">
        <button type="button" class="btn btn-primary" style="flex:1;" onclick="closeModal();startKitabaExam()">Qayta topshirish</button>
        <button type="button" class="btn btn-outline" style="flex:1;" onclick="closeModal()">Yopish</button>
      </div>
    `;

    bodyEl.innerHTML = contentHtml;
    overlay.classList.add('show');
    return;
  }

  // Speaking (Muhavara)
  titleEl.textContent = `${rec?.topic || 'So\'zlashuv (Muhavara)'} — Natija va Tahlil`;
  let contentHtml = `
    <div class="prompt-box" style="text-align:center;margin-bottom:16px;">
      <div class="lbl">Natija</div>
      <div style="font-size:32px;font-weight:700;margin:6px 0;color:var(--text);">${totalScoreDisplay} / ${maxScore} ball</div>
      <div style="color:var(--text-faint);font-size:13px;font-weight:600;">${pct}% · ${cefr && cefr.length <= 3 ? cefr + ' daraja' : `<span style="font-size:12px;color:var(--text-dim);font-weight:600;">${cefr}</span>`} · (6 ta savol, har biri 0–5 ball)</div>
    </div>
  `;

  if(savedQuestions && savedQuestions.length > 0){
    contentHtml += `
      <div style="display:flex;flex-direction:column;gap:12px;margin-top:10px;">
        ${savedQuestions.map((q, idx) => `
          <div class="card" style="padding:16px;background:var(--card);border:1.5px solid var(--border);border-radius:14px;display:flex;flex-direction:column;gap:8px;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <div class="t-name" style="font-size:13px;font-weight:700;color:var(--indigo-700);">${q.part?.name || 'So\'zlashuv'} · ${idx + 1}-savol</div>
              <div style="font-weight:700;font-size:15px;color:var(--text);">${q.score ?? 0} / 5 ball</div>
            </div>
            <div dir="rtl" style="font-family:var(--font-ar);font-size:15.5px;line-height:1.7;color:var(--text);font-weight:600;background:var(--card-alt);padding:8px 12px;border-radius:10px;">
              ${escapeHtml(q.prompt || '')}
            </div>
            ${q.transcript ? `
              <div style="font-size:13px;color:var(--text);background:var(--card-alt);padding:8px 12px;border-radius:10px;border:1px solid var(--border);line-height:1.5;">
                <b style="color:var(--indigo-700);">🎙 Sizning javobingiz:</b> "${escapeHtml(q.transcript)}"
              </div>
            ` : ''}
            ${q.feedback ? `
              <div style="font-size:12.5px;color:var(--text-dim);background:var(--card-alt);padding:8px 12px;border-radius:10px;line-height:1.5;">
                <b style="color:var(--indigo-700);">💡 AI izohi:</b> ${escapeHtml(q.feedback)}
              </div>
            ` : ''}
          </div>
        `).join('')}
      </div>
    `;
  } else {
    contentHtml += `
      <div class="placeholder-card" style="padding:22px 16px;text-align:center;">
        <div style="font-size:36px;margin-bottom:10px;">🎤</div>
        <p style="font-size:13.5px;color:var(--text-dim);margin:0 0 16px;line-height:1.55;">
          Ushbu urinishda <b>6 ta og'zaki savol</b> (har biri 0–5 ball) bo'yicha jami <b>${totalScoreDisplay} / ${maxScore} ball</b> to'plangan.
        </p>
      </div>
    `;
  }

  contentHtml += `
    <div style="display:flex;gap:10px;margin-top:16px;">
      <button type="button" class="btn btn-primary" style="flex:1;" onclick="closeModal();openMicCheck()">Qayta topshirish</button>
      <button type="button" class="btn btn-outline" style="flex:1;" onclick="closeModal()">Yopish</button>
    </div>
  `;

  bodyEl.innerHTML = contentHtml;
  overlay.classList.add('show');
}

function openMistakeModalFallback(rec, idStr){
  const topicName = rec ? (rec.topic || rec.topic_name || rec.section || 'Test') : 'Test';
  const totalCount = rec ? (rec.total || 0) : 0;
  const correctCount = rec ? (rec.correct || 0) : 0;
  const wrongCount = Math.max(0, totalCount - correctCount);
  const isPerfect = totalCount > 0 && correctCount >= totalCount;

  // 1. Agar barcha savollarga to'g'ri javob berilgan bo'lsa
  if(isPerfect){
    document.getElementById('modalTitle').textContent = `${topicName} — Natija`;
    document.getElementById('modalBody').innerHTML = `
      <div class="placeholder-card" style="padding:32px 20px;text-align:center;">
        <div style="font-size:44px;margin-bottom:12px;">🎉</div>
        <h3 style="font-size:17px;font-weight:700;color:var(--green);margin-bottom:6px;">Xatolik yo'q!</h3>
        <p style="font-size:13.5px;color:var(--text-dim);margin:0 0 18px 0;line-height:1.5;">
          Siz ushbu testdagi barcha <b>${totalCount} ta</b> savolga to'liq to'g'ri javob berdingiz (100% natija).
        </p>
        <button type="button" class="btn btn-primary" onclick="closeModal()">Yopish</button>
      </div>
    `;
    document.getElementById('modalOverlay').classList.add('show');
    return;
  }

  // 2. Xatolarni manbalardan qidirish
  let items = [];
  if(rec && Array.isArray(rec.mistakes) && rec.mistakes.length > 0){
    items = rec.mistakes;
  } else if(ATTEMPT_MISTAKES_MAP[idStr] && ATTEMPT_MISTAKES_MAP[idStr].length > 0){
    items = ATTEMPT_MISTAKES_MAP[idStr];
  } else if(rec && rec.id && ATTEMPT_MISTAKES_MAP[String(rec.id)] && ATTEMPT_MISTAKES_MAP[String(rec.id)].length > 0){
    items = ATTEMPT_MISTAKES_MAP[String(rec.id)];
  } else if(rec && rec.topicId && ATTEMPT_MISTAKES_MAP['topic_' + rec.topicId]){
    items = ATTEMPT_MISTAKES_MAP['topic_' + rec.topicId];
  } else if(rec && rec.topic && ATTEMPT_MISTAKES_MAP[rec.topic]){
    items = ATTEMPT_MISTAKES_MAP[rec.topic];
  } else if(rec && rec.section && ATTEMPT_MISTAKES_MAP['skill_' + rec.section]){
    items = ATTEMPT_MISTAKES_MAP['skill_' + rec.section];
  }

  if(items && items.length > 0){
    document.getElementById('modalTitle').textContent = `${topicName} — xatolar tahlili (${items.length} ta)`;
    document.getElementById('modalBody').innerHTML = `
      <div style="display:flex;flex-direction:column;gap:14px;padding:2px 0;">
        ${items.map((m, idx) => `
          <div class="card" style="padding:16px;background:var(--card);border:1.5px solid var(--border);border-radius:14px;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;">
              <span style="font-size:11.5px;font-weight:700;padding:3px 9px;border-radius:6px;background:var(--red-bg);color:var(--red);">
                ✕ ${idx + 1}-savol
              </span>
              ${m.category ? `<span style="font-size:11px;font-weight:600;color:var(--text-faint);">${escapeHtml(m.category)}</span>` : ''}
            </div>

            <div style="font-family:var(--font-ar);font-size:17px;line-height:1.7;direction:rtl;text-align:right;color:var(--text);font-weight:600;margin-bottom:12px;">
              ${escapeHtml(m.q)}
            </div>

            <div style="display:flex;flex-direction:column;gap:8px;">
              <div style="display:flex;align-items:center;gap:8px;padding:9px 12px;border-radius:10px;background:var(--red-bg);border:1px solid rgba(214,69,69,0.25);color:var(--red);font-size:13px;font-weight:600;">
                <span style="font-weight:800;">✕ Sizning javobingiz:</span>
                <span style="font-family:var(--font-ar);font-size:14.5px;direction:rtl;text-align:right;margin-left:auto;">${escapeHtml(m.picked || '—')}</span>
              </div>

              <div style="display:flex;align-items:center;gap:8px;padding:9px 12px;border-radius:10px;background:var(--green-bg);border:1px solid rgba(18,167,104,0.25);color:var(--green);font-size:13px;font-weight:600;">
                <span style="font-weight:800;">✓ To'g'ri javob:</span>
                <span style="font-family:var(--font-ar);font-size:14.5px;direction:rtl;text-align:right;margin-left:auto;">${escapeHtml(m.correct || '—')}</span>
              </div>
            </div>

            ${m.exp ? `
              <div style="margin-top:10px;padding:10px 12px;background:var(--card-alt);border-radius:10px;border:1px solid var(--border);font-size:12.5px;color:var(--text-dim);font-weight:500;line-height:1.5;">
                <b style="color:var(--indigo-700);">💡 Tushuntirish:</b> ${escapeHtml(m.exp)}
              </div>
            ` : ''}
          </div>
        `).join('')}

        <div style="display:flex;gap:10px;margin-top:6px;">
          ${rec ? `<button type="button" class="btn btn-primary btn-block" onclick="closeModal();retryQuizFromHistory('${rec.section||''}','${rec.topicId||''}','${(rec.topic||'').replace(/'/g,"\\'")}')">Qayta test topshirish</button>` : ''}
          <button type="button" class="btn btn-outline btn-block" onclick="closeModal()">Yopish</button>
        </div>
      </div>
    `;
    document.getElementById('modalOverlay').classList.add('show');
    return;
  }

  // 3. Fallback summarasi
  document.getElementById('modalTitle').textContent = `${topicName} — Natija`;
  document.getElementById('modalBody').innerHTML = `
    <div class="placeholder-card" style="padding:26px 18px;text-align:center;">
      <div style="font-size:38px;margin-bottom:12px;">📊</div>
      <h3 style="font-size:16px;font-weight:700;margin-bottom:8px;">
        Natija: ${correctCount}/${totalCount} (${wrongCount > 0 ? `${wrongCount} ta xato` : '0 ta xato'})
      </h3>
      <p style="font-size:13px;color:var(--text-dim);margin:0 0 18px 0;line-height:1.5;">
        ${wrongCount > 0
          ? `Ushbu urinishda <b>${totalCount} ta</b> savoldan <b>${wrongCount} tasiga</b> xato javob berilgan.`
          : `Ushbu testda barcha savollarga to'g'ri javob berilgan.`}
      </p>
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
        ${rec && rec.topicId ? `<button type="button" class="btn btn-outline" onclick="closeModal();viewTopicQuestions('${(rec.section||'').toLowerCase()==='grammatika'?'grammatika':rec.topicId}','${rec.topicId}')">Savollar bankini ko'rish</button>` : ''}
        ${rec ? `<button type="button" class="btn btn-primary" onclick="closeModal();retryQuizFromHistory('${rec.section||''}','${rec.topicId||''}','${(rec.topic||'').replace(/'/g,"\\'")}')">Qayta test topshirish</button>` : `<button type="button" class="btn btn-primary" onclick="closeModal()">Yopish</button>`}
      </div>
    </div>
  `;
  document.getElementById('modalOverlay').classList.add('show');
}
function closeModal(){ document.getElementById('modalOverlay').classList.remove('show'); }

/* Foydalanuvchi matnini xavfsiz HTML sifatida chiqarish uchun (XSS oldini olish). */
function escapeHtml(value){
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ================= Haqiqiy imtihon xabari (foydalanuvchi -> admin) ================= */
const EXAM_SECTIONS = ['Qiroa','Istima','Grammatika','Muhavara','Kitaba'];
const EXAM_TYPES = [
  {value:'at-Tanal', label:'At-Tanal'},
  {value:'CEFR', label:'CEFR'}
];
/* O'zbekiston viloyatlari (12 ta) — shahar matn maydoni o'rniga tanlash uchun */
const UZ_REGIONS = [
  "Andijon","Buxoro","Farg'ona","Jizzax","Xorazm","Namangan",
  "Navoiy","Qashqadaryo","Samarqand","Sirdaryo","Surxondaryo","Toshkent"
];
/* Har bir bo'lim tanlanganda pastda chiqadigan yozish maydoni — mahoratga mos
   sarlavha/izoh/placeholder bilan. Maqsad: variant emas, faqat mavzu va savol soni. */
const EXAM_SECTION_META = {
  Qiroa: {
    color:'var(--qiroa)',
    sub:"Qaysi juzdan matn keldi? Mavzusi va savollar soni",
    placeholder:"Masalan: 6-juz, dengiz haqida matn, 5 ta savol keldi"
  },
  Istima: {
    color:'var(--istima)',
    sub:"Qaysi qismda, qanday mavzuda audio keldi?",
    placeholder:"Masalan: 2-qism, do'kondagi suhbat mavzusida, 4 ta savol"
  },
  Grammatika: {
    color:'var(--grammatika)',
    sub:"Qaysi mavzu(lar)dan savollar tushdi?",
    placeholder:"Masalan: كان mavzusidan 3 ta savol, fe'l zamonlaridan 2 ta savol"
  },
  Muhavara: {
    color:'var(--muhavara)',
    sub:"Qanday mavzuda savol/suhbat berildi?",
    placeholder:"Masalan: oila va kasb tanlash haqida savollar berildi"
  },
  Kitaba: {
    color:'var(--kitaba)',
    sub:"Har bir qism bo'yicha mavzuni alohida yozing",
    placeholder:""
  }
};
/* Backendga ulanish uchun: submit_exam_report (yuborish) va admin_list_exam_reports
   (adminlar uchun ro'yxat) RPC'lari orqali ishlaydi. Quyidagi massiv faqat
   backenddan javob kelmagan holatlar uchun bo'sh boshlanadi. */
let examReports = [];
let examChipSelection = [];
let examRepType = 'at-Tanal';
let examRepRegion = '';
let examSectionTexts = {};      // {Qiroa:'...', Istima:'...', Grammatika:'...', Muhavara:'...'}
let examKitabaParts = {1:'',2:'',3:''};
let examRepDate = '';
let nativeCalendarYear = new Date().getFullYear();
let nativeCalendarMonth = new Date().getMonth();

const UZ_MONTH_NAMES = [
  'Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun',
  'Iyul', 'Avgust', 'Sentyabr', 'Oktyabr', 'Noyabr', 'Dekabr'
];
const UZ_WEEKDAYS = ['Du', 'Se', 'Cho', 'Pa', 'Ju', 'Sha', 'Ya'];

function formatUzbekDateDisplay(isoDateStr){
  if(!isoDateStr) return 'Sanani tanlang';
  const parts = isoDateStr.split('-');
  if(parts.length !== 3) return isoDateStr;
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10) - 1;
  const d = parseInt(parts[2], 10);
  return `${d}-${UZ_MONTH_NAMES[m] || ''}, ${y}`;
}

function renderNativeDatePicker(selectedIso){
  const wrap = document.getElementById('repDatePickerWrap');
  if(!wrap) return;
  if(!selectedIso){
    const today = new Date();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    selectedIso = `${today.getFullYear()}-${mm}-${dd}`;
  }
  examRepDate = selectedIso;
  const parts = selectedIso.split('-');
  const selY = parseInt(parts[0], 10);
  const selM = parseInt(parts[1], 10) - 1;
  const selD = parseInt(parts[2], 10);

  const viewY = nativeCalendarYear;
  const viewM = nativeCalendarMonth;
  const firstDayOfWeek = (new Date(viewY, viewM, 1).getDay() + 6) % 7; // Monday = 0
  const daysInMonth = new Date(viewY, viewM + 1, 0).getDate();
  const daysInPrevMonth = new Date(viewY, viewM, 0).getDate();

  const today = new Date();
  const todayY = today.getFullYear(), todayM = today.getMonth(), todayD = today.getDate();

  let daysHtml = '';
  for(let i = firstDayOfWeek - 1; i >= 0; i--){
    const d = daysInPrevMonth - i;
    daysHtml += `<button type="button" class="ncp-day other-month" disabled tabindex="-1">${d}</button>`;
  }
  for(let d = 1; d <= daysInMonth; d++){
    const isSelected = (viewY === selY && viewM === selM && d === selD);
    const isToday = (viewY === todayY && viewM === todayM && d === todayD);
    const dIso = `${viewY}-${String(viewM + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    let cls = 'ncp-day';
    if(isSelected) cls += ' selected';
    else if(isToday) cls += ' today';
    daysHtml += `<button type="button" class="${cls}" data-date="${dIso}">${d}</button>`;
  }

  wrap.innerHTML = `
    <input type="hidden" id="repDate" value="${selectedIso}">
    <button type="button" class="native-date-trigger" id="repDateTrigger">
      <span class="native-date-text">${formatUzbekDateDisplay(selectedIso)}</span>
      <span class="native-date-icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect width="18" height="18" x="3" y="4" rx="2" ry="2"/>
          <line x1="16" x2="16" y1="2" y2="6"/>
          <line x1="8" x2="8" y1="2" y2="6"/>
          <line x1="3" x2="21" y1="10" y2="10"/>
        </svg>
      </span>
    </button>
    <div class="native-calendar-popup" id="repCalendarPopup">
      <div class="ncp-header">
        <button type="button" class="ncp-nav-btn" id="ncpPrevMonth">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m15 18-6-6 6-6"/></svg>
        </button>
        <div class="ncp-title">${UZ_MONTH_NAMES[viewM]} ${viewY}</div>
        <button type="button" class="ncp-nav-btn" id="ncpNextMonth">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m9 18 6-6-6-6"/></svg>
        </button>
      </div>
      <div class="ncp-weekdays">
        ${UZ_WEEKDAYS.map(w => `<span>${w}</span>`).join('')}
      </div>
      <div class="ncp-days">
        ${daysHtml}
      </div>
      <div class="ncp-footer">
        <button type="button" class="ncp-today-btn" id="ncpTodayBtn">Bugun</button>
        <button type="button" class="ncp-today-btn" style="color:var(--text-faint);" id="ncpCloseBtn">Yopish</button>
      </div>
    </div>
  `;

  const trigger = document.getElementById('repDateTrigger');
  const popup = document.getElementById('repCalendarPopup');
  if(trigger && popup){
    trigger.addEventListener('click', (e)=>{
      e.stopPropagation();
      document.querySelectorAll('.cd-panel.show').forEach(p=>p.classList.remove('show'));
      popup.classList.toggle('show');
    });
    popup.addEventListener('click', (e)=>{
      e.stopPropagation();
      const dayBtn = e.target.closest('.ncp-day[data-date]');
      if(dayBtn){
        const chosen = dayBtn.dataset.date;
        renderNativeDatePicker(chosen);
        return;
      }
      if(e.target.id === 'ncpPrevMonth' || e.target.closest('#ncpPrevMonth')){
        nativeCalendarMonth--;
        if(nativeCalendarMonth < 0){
          nativeCalendarMonth = 11;
          nativeCalendarYear--;
        }
        renderNativeDatePicker(examRepDate);
        const p = document.getElementById('repCalendarPopup');
        if(p) p.classList.add('show');
        return;
      }
      if(e.target.id === 'ncpNextMonth' || e.target.closest('#ncpNextMonth')){
        nativeCalendarMonth++;
        if(nativeCalendarMonth > 11){
          nativeCalendarMonth = 0;
          nativeCalendarYear++;
        }
        renderNativeDatePicker(examRepDate);
        const p = document.getElementById('repCalendarPopup');
        if(p) p.classList.add('show');
        return;
      }
      if(e.target.id === 'ncpTodayBtn'){
        const td = new Date();
        nativeCalendarYear = td.getFullYear();
        nativeCalendarMonth = td.getMonth();
        const iso = `${td.getFullYear()}-${String(td.getMonth()+1).padStart(2,'0')}-${String(td.getDate()).padStart(2,'0')}`;
        renderNativeDatePicker(iso);
        return;
      }
      if(e.target.id === 'ncpCloseBtn'){
        popup.classList.remove('show');
      }
    });
  }
}

function openExamReportModal(){
  examChipSelection = [];
  examRepType = 'at-Tanal';
  examRepRegion = '';
  examSectionTexts = {};
  examKitabaParts = {1:'',2:'',3:''};
  nativeCalendarYear = new Date().getFullYear();
  nativeCalendarMonth = new Date().getMonth();
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  examRepDate = todayIso;

  document.getElementById('modalTitle').textContent = "Haqiqiy imtihonga kirdingizmi?";
  document.getElementById('modalBody').innerHTML = `
    <p class="form-hint" style="margin:0 0 18px 0;line-height:1.55;font-size:13px;">Ma'lumotlaringiz faqat administratorlarga ko'rinadi va boshqa o'quvchilarga tayyorgarlik uchun yordam beradi.</p>
    <div style="display:flex;flex-direction:column;gap:18px;">
      <div class="form-field">
        <label style="font-size:13px;font-weight:600;margin-bottom:8px;display:block;">Imtihon turi</label>
        <div class="rank-type-toggle" id="repTypeToggle">
          ${EXAM_TYPES.map((t,i)=>`<button type="button" class="rank-type-btn ${i===0?'active':''}" data-val="${t.value}">${t.label}</button>`).join('')}
        </div>
      </div>
      <div class="form-field">
        <label style="font-size:13px;font-weight:600;margin-bottom:8px;display:block;">Imtihon sanasi</label>
        <div class="native-date-picker-wrap" id="repDatePickerWrap"></div>
      </div>
      <div class="form-field">
        <label style="font-size:13px;font-weight:600;margin-bottom:8px;display:block;">Viloyat (ixtiyoriy)</label>
        <div class="rank-dropdown" id="repRegionDropdown"></div>
      </div>
      <div class="form-field">
        <label style="font-size:13px;font-weight:600;margin-bottom:8px;display:block;">Qaysi bo'lim(lar)dan savol tushdi?</label>
        <div class="rank-dropdown" id="repSectionDropdown" style="padding:0;"></div>
      </div>
      <div class="form-field" id="repSectionBlocksWrap" style="display:none;">
        <label style="font-size:13px;font-weight:600;margin-bottom:4px;display:block;">Qanday savollar tushganini yozib bering</label>
        <p class="form-hint" style="margin:0 0 10px 0;font-size:12px;">Javob variantlarini emas, mavzu va savollar sonini yozing.</p>
        <div class="rep-section-blocks" id="repSectionBlocks"></div>
      </div>
      <button class="btn btn-primary btn-block" style="margin-top:6px;padding:14px;border-radius:14px;font-size:14.5px;" onclick="submitExamReport()">Yuborish</button>
    </div>
  `;
  renderNativeDatePicker(todayIso);
  initCustomDropdown('repRegionDropdown', {
    label:'Viloyat',
    options:[{value:'', label:"Tanlanmagan"}, ...UZ_REGIONS.map(r=>({value:r, label:r}))],
    value:'',
    onChange:(val)=>{ examRepRegion = val; }
  });
  document.getElementById('repTypeToggle').addEventListener('click', e=>{
    const btn = e.target.closest('.rank-type-btn'); if(!btn) return;
    document.querySelectorAll('#repTypeToggle .rank-type-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    examRepType = btn.dataset.val;
  });
  renderExamSectionDropdown();
  renderExamSectionBlocks();
  document.getElementById('repSectionBlocks').addEventListener('input', e=>{
    if(e.target.id === 'repKitaba1') examKitabaParts[1] = e.target.value;
    else if(e.target.id === 'repKitaba2') examKitabaParts[2] = e.target.value;
    else if(e.target.id === 'repKitaba3') examKitabaParts[3] = e.target.value;
    else if(e.target.id && e.target.id.startsWith('repSec_')) examSectionTexts[e.target.id.slice(7)] = e.target.value;
  });
  document.getElementById('modalOverlay').classList.add('show');
}

/* ---- Bo'lim(lar) tanlash uchun ko'p tanlovli custom dropdown ---- */
function renderExamSectionDropdown(){
  const wrap = document.getElementById('repSectionDropdown');
  if(!wrap) return;
  const label = examChipSelection.length
    ? examChipSelection.join(', ')
    : "Bo'lim(lar)ni tanlang";
  wrap.innerHTML = `
    <button type="button" class="cd-trigger" id="repSectionTrigger" style="padding:12px 34px 12px 14px;">
      <span class="cd-value ${examChipSelection.length?'':'placeholder'}">${escapeHtml(label)}</span>
    </button>
    <svg class="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="right:14px;"><path d="m6 9 6 6 6-6"/></svg>
    <div class="cd-panel" id="repSectionPanel" style="scrollbar-width:none;-ms-overflow-style:none;">
      ${EXAM_SECTIONS.map(s=>{
        const active = examChipSelection.includes(s);
        return `<button type="button" class="cd-option cd-option-multi ${active?'active':''}" data-sec="${s}">
          <span class="cdm-box"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3"><path d="M20 6 9 17l-5-5"/></svg></span>
          <span>${s}</span>
        </button>`;
      }).join('')}
    </div>
  `;
  wrap.classList.add('cd-wrap');
  const trigger = document.getElementById('repSectionTrigger');
  const panel = document.getElementById('repSectionPanel');
  trigger.addEventListener('click', (e)=>{
    e.stopPropagation();
    document.querySelectorAll('.cd-panel.show').forEach(p=>{ if(p!==panel) p.classList.remove('show'); });
    panel.classList.toggle('show');
  });
  panel.addEventListener('click', (e)=>{
    e.stopPropagation();
    const opt = e.target.closest('.cd-option-multi'); if(!opt) return;
    const sec = opt.dataset.sec;
    examChipSelection = examChipSelection.includes(sec)
      ? examChipSelection.filter(s=>s!==sec)
      : [...examChipSelection, sec];
    renderExamSectionDropdown();
    document.getElementById('repSectionPanel').classList.add('show');
    renderExamSectionBlocks();
  });
}

/* ---- Tanlangan bo'limlarga qarab pastda mahoratga mos yozish maydonlarini chizadi ---- */
function renderExamSectionBlocks(){
  const outerWrap = document.getElementById('repSectionBlocksWrap');
  const holder = document.getElementById('repSectionBlocks');
  if(!outerWrap || !holder) return;
  if(examChipSelection.length===0){
    outerWrap.style.display = 'none';
    holder.innerHTML = '';
    return;
  }
  outerWrap.style.display = '';
  holder.innerHTML = examChipSelection.map(sec=>{
    const meta = EXAM_SECTION_META[sec] || {color:'var(--indigo-700)', sub:'', placeholder:''};
    if(sec === 'Kitaba'){
      return `
        <div class="rep-section-block" style="padding:14px 16px;border-radius:16px;">
          <div class="rsb-head"><span class="rsb-dot" style="background:${meta.color}"></span><span class="rsb-title">Kitaba</span></div>
          <div class="rsb-sub" style="margin:0 0 10px 0;">${meta.sub}</div>
          <div class="rep-kitaba-parts" style="gap:10px;">
            <div><label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px;">1-qism mavzusi</label><input type="text" id="repKitaba1" placeholder="Masalan: oila haqida" value="${escapeHtml(examKitabaParts[1]||'')}" style="padding:10px 12px;border-radius:10px;"></div>
            <div><label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px;">2-qism mavzusi</label><input type="text" id="repKitaba2" placeholder="Masalan: sayohat haqida" value="${escapeHtml(examKitabaParts[2]||'')}" style="padding:10px 12px;border-radius:10px;"></div>
            <div><label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px;">3-qism mavzusi</label><input type="text" id="repKitaba3" placeholder="Masalan: ta'lim haqida" value="${escapeHtml(examKitabaParts[3]||'')}" style="padding:10px 12px;border-radius:10px;"></div>
          </div>
        </div>`;
    }
    return `
      <div class="rep-section-block" style="padding:14px 16px;border-radius:16px;">
        <div class="rsb-head"><span class="rsb-dot" style="background:${meta.color}"></span><span class="rsb-title">${sec}</span></div>
        <div class="rsb-sub" style="margin:0 0 10px 0;">${meta.sub}</div>
        <textarea id="repSec_${sec}" placeholder="${escapeHtml(meta.placeholder)}" style="padding:10px 12px;border-radius:10px;min-height:70px;"></textarea>
      </div>`;
  }).join('');
}

function collectExamSectionText(){
  const parts = [];
  examChipSelection.forEach(sec=>{
    if(sec === 'Kitaba'){
      const k1 = (document.getElementById('repKitaba1')||{}).value?.trim() || '';
      const k2 = (document.getElementById('repKitaba2')||{}).value?.trim() || '';
      const k3 = (document.getElementById('repKitaba3')||{}).value?.trim() || '';
      const kitabaLine = ['1-qism: '+k1, '2-qism: '+k2, '3-qism: '+k3].filter((_,i)=>[k1,k2,k3][i]).join('; ');
      if(kitabaLine) parts.push(`Kitaba — ${kitabaLine}`);
    } else {
      const el = document.getElementById('repSec_'+sec);
      const v = el ? el.value.trim() : '';
      if(v) parts.push(`${sec}: ${v}`);
    }
  });
  return parts.join('\n');
}

async function submitExamReport(){
  const type = examRepType;
  const date = document.getElementById('repDate').value;
  const center = examRepRegion;
  const text = collectExamSectionText();
  if(!date || examChipSelection.length===0 || !text){
    toast("Iltimos, sana, bo'lim va savollar haqida ma'lumotni to'ldiring");
    return;
  }
  const btn = document.querySelector('#modalBody .btn-primary');
  if(btn){ btn.disabled = true; btn.textContent = 'Yuborilmoqda...'; }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/submit_exam_report`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        p_type: type,
        p_date: date,
        p_center: center || null,
        p_sections: examChipSelection,
        p_seat: null,
        p_text: text
      })
    });
    if(!res.ok){
      const errText = await res.text();
      throw new Error(errText || ('HTTP ' + res.status));
    }
    closeModal();
    toast("Ma'lumot yuborildi! Administratorlarga yetkazildi ✅");
  }catch(e){
    console.error(e);
    toast('❌ Yuborilmadi: ' + (e.message || 'Supabase xatosi').slice(0,180), 5000);
    if(btn){ btn.disabled = false; btn.textContent = 'Yuborish'; }
  }
}
/* ================= ADMIN PANEL — asosiy mantiq ================= */
function showAdminTab(tab){
  document.querySelectorAll('#adminTabs .admin-tab').forEach(b=>b.classList.toggle('active', b.dataset.atab===tab));
  ['overview','users','questions','mocks','reports','vocabularies'].forEach(t=>{
    const el = document.getElementById('adminTab-'+t);
    if(el) el.style.display = (t===tab) ? '' : 'none';
  });
  if(tab==='overview') renderAdminOverview();
  if(tab==='users') renderAdminUsers();
  if(tab==='questions') renderAdminQuestions();
  if(tab==='mocks') renderAdminMocks();
  if(tab==='reports') renderAdminReports();
  if(tab==='vocabularies') renderAdminVocabularies();
}

function renderAdminPanel(){
  const active = document.querySelector('#adminTabs .admin-tab.active');
  showAdminTab(active ? active.dataset.atab : 'overview');
}

const ADMIN_TAB_TITLES = {
  overview:'Umumiy', users:'Foydalanuvchilar', questions:'Savollar banki', mocks:'Mocklar',
  vocabularies:"Lug'atlar bazasi", reports:'Imtihon xabarlari', examcards:'Imtihon cardlari',
  gramorder:'Grammatika tartibi', sendmsg:'Xabar yuborish', admins:'Adminlar',
  community:'Hamjamiyat', skilllimits:'Kunlik limitlar', speakingduel:'Speaking Duel savollari'
};
function openAdminPanelModal(tab){
  showAdminTab(tab);
  const t = document.getElementById('adminPanelModalTitle');
  if(t) t.textContent = ADMIN_TAB_TITLES[tab] || '';
  const overlay = document.getElementById('adminPanelModalOverlay');
  if(overlay) overlay.classList.add('show');
}
function closeAdminPanelModal(){
  const overlay = document.getElementById('adminPanelModalOverlay');
  if(overlay) overlay.classList.remove('show');
}

/* ---- 1) UMUMIY KO'RINISH ---- */
function formatLastActive(dateVal){
  if(!dateVal || dateVal === '-' || dateVal === 'null' || dateVal === 'undefined') return '-';

  const d = new Date(dateVal);
  if(isNaN(d.getTime())){
    return String(dateVal);
  }

  const pad = n => String(n).padStart(2, '0');
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());
  const timeStr = `${hours}:${minutes}:${seconds}`;

  const now = new Date();
  const isSameDay = (d1, d2) =>
    d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate();

  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);

  if(isSameDay(d, now)){
    return `Bugun ${timeStr}`;
  }
  if(isSameDay(d, yesterday)){
    return `Kecha ${timeStr}`;
  }

  const day = pad(d.getDate());
  const month = pad(d.getMonth() + 1);
  const year = d.getFullYear();
  return `${day}.${month}.${year} ${timeStr}`;
}

function formatRegDate(dateVal){
  if(!dateVal || dateVal === '-' || dateVal === 'null' || dateVal === 'undefined') return '-';
  const d = new Date(dateVal);
  if(isNaN(d.getTime())){
    return String(dateVal);
  }
  const pad = n => String(n).padStart(2, '0');
  const day = pad(d.getDate());
  const month = pad(d.getMonth() + 1);
  const year = d.getFullYear();
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  return `${day}.${month}.${year} ${hours}:${minutes}`;
}

function isUserActiveToday(dateVal){
  if(!dateVal || dateVal === '-' || dateVal === 'null' || dateVal === 'undefined') return false;
  if(typeof dateVal === 'string' && dateVal.startsWith('Bugun')) return true;
  const d = new Date(dateVal);
  if(isNaN(d.getTime())) return false;
  const now = new Date();
  return d.getFullYear() === now.getFullYear() &&
         d.getMonth() === now.getMonth() &&
         d.getDate() === now.getDate();
}

window.formatLastActive = formatLastActive;
window.formatRegDate = formatRegDate;
window.isUserActiveToday = isUserActiveToday;

let currentAdminUserStatusFilter = 'all';
function setUserStatusFilter(filter){
  currentAdminUserStatusFilter = filter || 'all';
  document.querySelectorAll('.user-status-filter .status-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.sfilter === currentAdminUserStatusFilter);
  });
  renderAdminUsers();
}
window.setUserStatusFilter = setUserStatusFilter;

function renderAdminOverview(){
  const grid0 = document.getElementById('adminStatGrid');
  if(!adminUsersLoaded && grid0){
    grid0.innerHTML = `<div class="loading-inline" style="grid-column:1/-1;"><span class="loading-spinner"></span>Statistika yuklanmoqda…</div>`;
    document.getElementById('adminSkillBars').innerHTML = '';
    return;
  }
  const totalUsers = ADMIN_USERS.length;
  const totalXp = ADMIN_USERS.reduce((s,u)=>s+u.xp,0);
  const totalQuestions = Object.values(QUESTION_BANKS).reduce((s,b)=> s + (b.questions?.length||0), 0)
    + Object.values(GRAMMAR_TOPIC_BANKS).reduce((s,arr)=> s + arr.length, 0)
    + Object.values(QIROA_TESTS).reduce((s,arr)=> s + arr.reduce((s2,t)=> s2 + t.questions.length, 0), 0);
  const activeToday = ADMIN_USERS.filter(u=>isUserActiveToday(u.rawLastActive || u.lastActive)).length;

  const grid = document.getElementById('adminStatGrid');
  grid.innerHTML = `
    <div class="stat-card">
      <div class="stat-icon" style="background:var(--indigo-100);color:var(--indigo-700);">👥</div>
      <div class="stat-val"><span class="num-target" data-target="${totalUsers}">0</span></div>
      <div class="stat-label">Jami foydalanuvchi</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon" style="background:var(--grammatika-bg);color:var(--grammatika);">🔥</div>
      <div class="stat-val"><span class="num-target" data-target="${activeToday}">0</span></div>
      <div class="stat-label">Bugun faol</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon" style="background:var(--kitaba-bg);color:var(--kitaba);">⚡</div>
      <div class="stat-val"><span class="num-target" data-target="${totalXp}">0</span></div>
      <div class="stat-label">Jami XP</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon" style="background:var(--qiroa-bg);color:var(--qiroa);">📝</div>
      <div class="stat-val"><span class="num-target" data-target="${totalQuestions}">0</span></div>
      <div class="stat-label">Jami savollar soni</div>
    </div>
  `;
  runEntranceAnimations(grid, true);

  const skillAvg = SKILLS.map(s=>{
    const avg = ADMIN_USERS.length
      ? Math.round(ADMIN_USERS.reduce((sum,u)=> sum + (u.skills?.[s.id] ?? 0), 0) / ADMIN_USERS.length)
      : 0;
    return {...s, avgPct: Math.round((avg/30)*100)};
  });
  document.getElementById('adminSkillBars').innerHTML = skillAvg.map(s=>`
    <div style="margin-bottom:14px;">
      <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:600;color:var(--text-dim);margin-bottom:6px;">
        <span>${s.name}</span><span>${s.avgPct}%</span>
      </div>
      <div style="height:8px;border-radius:99px;background:var(--bg);overflow:hidden;">
        <div style="height:100%;width:${s.avgPct}%;background:${s.color};border-radius:99px;"></div>
      </div>
    </div>
  `).join('');
}

/* ---- 2) FOYDALANUVCHILAR ---- */
/* DIQQAT: ilgari bu yerda ADMIN_USERS_MOCK namunaviy ma'lumot bo'lardi va u
   backend javob bermaguncha (yoki xato bo'lsa) doim ko'rinib turardi — shu
   sabab "userlar static" bo'lib ko'rinardi. Endi ro'yxat bo'sh boshlanadi,
   backend javob bergunga qadar "Yuklanmoqda" ko'rsatiladi. */
function renderAdminUsers(){
  const q = (document.getElementById('adminUserSearch')?.value || '').toLowerCase().trim();
  const body = document.getElementById('adminUsersBody');
  const countText = document.getElementById('adminUsersCountText');
  if(!body) return;
  if(!adminUsersLoaded){
    body.innerHTML = `<tr><td colspan="7"><div class="loading-inline"><span class="loading-spinner"></span>Foydalanuvchilar yuklanmoqda…</div></td></tr>`;
    if(countText) countText.textContent = `Yuklanmoqda...`;
    return;
  }
  
  const filtered = ADMIN_USERS.filter(u => {
    const matchesQ = !q ||
      u.name.toLowerCase().includes(q) ||
      u.username.toLowerCase().includes(q) ||
      String(u.id).includes(q);

    if(!matchesQ) return false;

    if(currentAdminUserStatusFilter === 'active'){
      return !u.isBlocked;
    }
    if(currentAdminUserStatusFilter === 'blocked'){
      return u.isBlocked;
    }
    return true;
  });

  if(countText){
    const totalCount = ADMIN_USERS.length;
    const activeCount = ADMIN_USERS.filter(u => !u.isBlocked).length;
    const blockedCount = ADMIN_USERS.filter(u => u.isBlocked).length;
    countText.textContent = `Ko'rsatilmoqda: ${filtered.length} / ${totalCount} ta (🟢 Faol: ${activeCount}, 🔴 Bloklagan: ${blockedCount})`;
  }

  if(filtered.length === 0){
    body.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:30px;color:var(--text-faint);">Hech qanday foydalanuvchi topilmadi</td></tr>`;
    return;
  }

  body.innerHTML = filtered.map(u => {
    const isBlocked = Boolean(u.isBlocked);
    const regDateStr = formatRegDate(u.createdAt || u.raw?.created_at || u.raw?.joined_at || u.raw?.registered_at);
    const lastActiveStr = formatLastActive(u.rawLastActive || u.lastActive || u.raw?.last_active);
    const uname = (u.username || '').replace(/^@+/, '');
    const unameHtml = uname
      ? `<a href="https://t.me/${uname}" target="_blank" rel="noopener noreferrer" style="color:var(--indigo-600);text-decoration:none;font-weight:600;" onclick="event.stopPropagation()">@${escapeHtml(uname)}</a>`
      : `<span style="color:var(--text-faint);">-</span>`;

    return `
      <tr>
        <td>
          <div class="u-name">
            <div class="u-avatar" style="${isBlocked ? 'background:rgba(239,68,68,0.15);color:#dc2626;' : ''}">${escapeHtml((u.name || '?').charAt(0))}</div>
            <div>
              <div style="font-weight:700;color:var(--text);">${escapeHtml(u.name)}</div>
              <div style="font-weight:600;font-size:11px;display:flex;align-items:center;gap:6px;margin-top:2px;">
                ${unameHtml}
                <span style="color:var(--text-faint);font-size:10.5px;">(ID: ${u.id})</span>
              </div>
            </div>
          </div>
        </td>
        <td style="text-align:center;"><span class="rank-chip-sm">${escapeHtml(u.level || 'A1')}</span></td>
        <td style="text-align:right;font-weight:700;color:var(--indigo-700);">${(u.xp || 0).toLocaleString()}</td>
        <td style="text-align:center;">
          ${isBlocked
            ? `<span class="badge-status badge-blocked" title="Foydalanuvchi botni bloklagan"><span class="badge-dot dot-red"></span>Bloklagan</span>`
            : `<span class="badge-status badge-active" title="Bot bilan aloqada"><span class="badge-dot dot-green"></span>Faol</span>`}
        </td>
        <td style="text-align:center;font-size:11.5px;color:var(--text-dim);white-space:nowrap;">${regDateStr}</td>
        <td style="text-align:center;font-size:11.5px;color:var(--text-dim);white-space:nowrap;">${lastActiveStr}</td>
        <td style="text-align:center;"><button class="row-btn" onclick="viewAdminUser(${u.id})">Batafsil</button></td>
      </tr>
    `;
  }).join('');
}

function viewAdminUser(userId){
  const u = ADMIN_USERS.find(x=>x.id===userId);
  if(!u) return;
  const isBlocked = Boolean(u.isBlocked);
  const regDateStr = formatRegDate(u.createdAt || u.raw?.created_at || u.raw?.joined_at || u.raw?.registered_at);
  const lastActiveStr = formatLastActive(u.rawLastActive || u.lastActive || u.raw?.last_active);
  const uname = (u.username || '').replace(/^@+/, '');

  document.getElementById('modalTitle').textContent = u.name;
  document.getElementById('modalBody').innerHTML = `
    <div style="padding:14px 4px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;flex-wrap:wrap;">
        <div style="font-size:12.5px;color:var(--text-faint);font-weight:600;">
          ${uname ? `<a href="https://t.me/${uname}" target="_blank" rel="noopener noreferrer" style="color:var(--indigo-600);text-decoration:none;font-weight:700;">@${escapeHtml(uname)}</a> · ` : ''}ID: <code style="background:var(--bg);padding:2px 6px;border-radius:6px;border:1px solid var(--border);">${u.id}</code> · Daraja: <b style="color:var(--text);">${u.level}</b>
        </div>
        <div>
          ${isBlocked
            ? `<span class="badge-status badge-blocked"><span class="badge-dot dot-red"></span>Botni bloklagan</span>`
            : `<span class="badge-status badge-active"><span class="badge-dot dot-green"></span>Bot faol</span>`}
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px;">
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:10px 12px;">
          <div style="font-size:11px;color:var(--text-faint);font-weight:600;">Ro'yxatdan o'tgan</div>
          <div style="font-size:13px;font-weight:700;color:var(--text);margin-top:2px;">${regDateStr}</div>
        </div>
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:10px 12px;">
          <div style="font-size:11px;color:var(--text-faint);font-weight:600;">Oxirgi faollik</div>
          <div style="font-size:13px;font-weight:700;color:var(--text);margin-top:2px;">${lastActiveStr}</div>
        </div>
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;background:var(--card);border:1px solid var(--border);border-radius:14px;padding:12px 14px;margin-bottom:6px;">
        <div>
          <div style="font-size:11px;color:var(--text-faint);font-weight:600;">Joriy XP</div>
          <div style="font-size:22px;font-weight:600;" id="xpCurrentVal">${(u.xp || 0).toLocaleString()}</div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          <input type="number" id="xpAdjustAmount" min="1" step="1" placeholder="masalan: 50"
            style="width:92px;padding:9px 10px;border-radius:10px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-weight:600;font-size:13px;font-family:inherit;">
          <button type="button" class="icon-btn ib-add" title="XP qo'shish" onclick="applyUserXpAdjustment(${u.id},1)">${IB_ICON_ADD}</button>
          <button type="button" class="icon-btn ib-del" title="XP ayirish" onclick="applyUserXpAdjustment(${u.id},-1)">${IB_ICON_MINUS}</button>
        </div>
      </div>
      <div style="font-size:10.5px;color:var(--text-faint);font-weight:600;margin-bottom:18px;">
        ℹ️ Daraja (${u.level}) — CEFR imtihon natijasi, XP'ga bog'liq emas. XP — faqat bo'limlardagi faollik ko'rsatkichi.
      </div>

      ${SKILLS.map(s=>{
        const val = u.skills?.[s.id] ?? 0;
        const pct = Math.round((val/30)*100);
        return `<div style="margin-bottom:12px;">
          <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:600;color:var(--text-dim);margin-bottom:5px;">
            <span>${s.name}</span><span>${val}/30</span>
          </div>
          <div style="height:7px;border-radius:99px;background:var(--bg);overflow:hidden;">
            <div style="height:100%;width:${pct}%;background:${s.color};border-radius:99px;"></div>
          </div>
        </div>`;
      }).join('')}

      <div style="margin-top:20px;padding-top:14px;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:8px;">
        <button type="button" class="btn btn-outline danger btn-block" style="font-size:12.5px;padding:9px 12px;" onclick="clearUserDuelHistory(${u.id})">
          ⚔️ Foydalanuvchining duel tarixini tozalash
        </button>
      </div>
    </div>
  `;
  document.getElementById('modalOverlay').classList.add('show');
}

/* ---- Admin: Foydalanuvchining duel tarixini tozalash ---- */
async function clearUserDuelHistoryOnBackend(userId){
  if(!SESSION_TOKEN){ setLastBackendError('—', "SESSION_TOKEN yo'q (Telegram orqali kirilmagan)"); return null; }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_clear_user_duel_history`, {
      method:"POST", headers: authHeaders(),
      body: JSON.stringify({ p_user_id: userId })
    });
    if(!res.ok){ setLastBackendError(res.status, await res.text()); return null; }
    return await res.json();
  }catch(e){ setLastBackendError('—', e.message); return null; }
}

async function clearUserDuelHistory(userId){
  const u = ADMIN_USERS.find(x=>x.id===userId);
  const name = u ? (u.name || u.id) : userId;
  const ok = await showLiquidConfirm({
    title: "Duel tarixini tozalash",
    message: `"${name}" foydalanuvchisining barcha duel tarixi (yaratgan va qatnashgan duellari) o'chirilsinmi?`,
    subtext: "Bu amal qaytarilmaydi.",
    confirmLabel: "Ha, tozalansin",
    cancelLabel: "Bekor qilish",
    isDanger: true
  });
  if(!ok) return;

  toast("⏳ Duel tarixi tozalanmoqda...");
  const res = await clearUserDuelHistoryOnBackend(userId);
  if(res === null){
    toast("⚠️ Xatolik: Duel tarixi tozalanmadi (" + (window.LAST_BACKEND_ERROR || '') + ")");
    return;
  }
  toast(`✅ "${name}" foydalanuvchisining duel tarixi muvaffaqiyatli tozalandi!`);
  _duelHistoryCache = {};
}

/* ---- Admin: foydalanuvchi XP'sini qo'lda +/- qilish ---- */
async function adjustUserXpOnBackend(telegramId, delta){
  if(!SESSION_TOKEN){ setLastBackendError('—', "SESSION_TOKEN yo'q (Telegram orqali kirilmagan)"); return null; }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_adjust_user_xp`, {
      method:"POST", headers: authHeaders(),
      body: JSON.stringify({ p_telegram_id: telegramId, p_delta: delta })
    });
    if(!res.ok){ setLastBackendError(res.status, await res.text()); return null; }
    return await res.json(); // yangilangan xp qiymatini qaytaradi
  }catch(e){ setLastBackendError('—', e.message); return null; }
}
async function applyUserXpAdjustment(userId, sign){
  const input = document.getElementById('xpAdjustAmount');
  const raw = Number(input?.value);
  if(!raw || raw <= 0 || !Number.isFinite(raw)){ toast("⚠️ Avval to'g'ri (musbat) son kiriting"); return; }
  const delta = sign * Math.round(raw);
  const result = await adjustUserXpOnBackend(userId, delta);
  if(result === null){ toast("⚠️ Xatolik: XP o'zgartirilmadi"); return; }
  const newXp = Number(result?.xp ?? result) || 0;
  const u = ADMIN_USERS.find(x=>x.id===userId);
  if(u) u.xp = newXp;
  toast(`✅ XP yangilandi: ${newXp.toLocaleString()}`);
  if(input) input.value = '';
  renderAdminUsers();
  renderAdminPanel();
  viewAdminUser(userId);
}

/* ---- Admin: BARCHA foydalanuvchilarning XP'sini 0'ga qaytarish ---- */
async function resetAllUsersXpOnBackend(){
  if(!SESSION_TOKEN){ setLastBackendError('—', "SESSION_TOKEN yo'q (Telegram orqali kirilmagan)"); return null; }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_reset_all_xp`, {
      method:"POST", headers: authHeaders(), body: JSON.stringify({})
    });
    if(!res.ok){ setLastBackendError(res.status, await res.text()); return null; }
    return await res.json(); // nechta foydalanuvchi ta'sirlanganini qaytaradi
  }catch(e){ setLastBackendError('—', e.message); return null; }
}
async function resetAllUsersXp(){
  const n = ADMIN_USERS.length;
  const ok = await showLiquidConfirm({
    title: "Barcha foydalanuvchilar XP'sini 0 ga tushirish",
    message: `DIQQAT: Bu BARCHA foydalanuvchilarning (${n} ta) XP'sini butunlay 0 ga qaytaradi.`,
    subtext: "Reyting ro'yxati ham nolga tushadi. Bu amalni ORQAGA QAYTARIB BO'LMAYDI!",
    confirmLabel: "Ha, 0 ga tushirilsin",
    cancelLabel: "Bekor qilish",
    isDanger: true
  });
  if(!ok) return;
  const result = await resetAllUsersXpOnBackend();
  if(result === null){ toast("⚠️ Xatolik: XP tozalanmadi"); return; }
  toast(`✅ ${n} ta foydalanuvchining XP'si 0'ga tushirildi`);
  ADMIN_USERS = ADMIN_USERS.map(u=>({...u, xp:0}));
  renderAdminUsers();
  renderAdminPanel();
}

/* ---- Admin: BARCHA foydalanuvchilarning imtihon tarixini (quiz_attempts) tozalash ----
   Supabase'da `admin_clear_all_exam_history` RPC funksiyasi talab qilinadi — u
   `quiz_attempts` jadvalidagi BARCHA qatorlarni (hamma foydalanuvchi uchun) o'chirib,
   o'chirilgan qatorlar sonini qaytarishi kerak. Masalan:
   create or replace function admin_clear_all_exam_history()
   returns integer language plpgsql security definer as $$
   declare n integer; begin
     delete from quiz_attempts; get diagnostics n = row_count; return n;
   end; $$; */
/* ---- Ilova ichidagi (brauzerning tizim oynasi emas) tasdiqlash modali ----
   Native `confirm()` chaqirilsa, WebView/brauzer o'zining tashqi oynasini
   (yuqorisida sayt domeni yozilgan) ko'rsatadi — ilova dizayniga mos kelmaydi.
   Shu sabab mavjud #modalOverlay/#modalTitle/#modalBody tizimidan foydalanib,
   xuddi shunday ishlaydigan, lekin ilova ichida chiqadigan versiya yasaymiz. */
function showLiquidConfirm({
  title = "Tasdiqlash",
  message = "Harakatni tasdiqlaysizmi?",
  subtext = "",
  icon = "⚠️",
  confirmLabel = "Ha, tasdiqlayman",
  cancelLabel = "Bekor qilish",
  isDanger = true
}){
  return new Promise((resolve) => {
    const overlay = document.getElementById('modalOverlay');
    const titleEl = document.getElementById('modalTitle');
    const bodyEl = document.getElementById('modalBody');
    if(!overlay || !titleEl || !bodyEl){
      resolve(true);
      return;
    }
    titleEl.textContent = title;
    bodyEl.innerHTML = `
      <div style="text-align:center;padding:10px 4px 6px;">
        <div style="font-size:38px;margin-bottom:12px;">${icon}</div>
        <div style="font-size:15.5px;font-weight:700;color:var(--text);margin-bottom:8px;line-height:1.45;">${escapeHtml(message)}</div>
        ${subtext ? `<p style="font-size:13.5px;color:var(--text-dim);line-height:1.55;margin:0 0 20px;white-space:pre-line;">${escapeHtml(subtext)}</p>` : '<div style="margin-bottom:16px;"></div>'}
        <div style="display:flex;gap:10px;">
          <button type="button" class="btn btn-outline" style="flex:1;padding:12px;" id="liquidCancelBtn">${escapeHtml(cancelLabel)}</button>
          <button type="button" class="btn btn-primary" style="flex:1;padding:12px;${isDanger ? 'background:var(--red);border-color:var(--red);' : ''}" id="liquidConfirmBtn">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    `;
    overlay.classList.add('show');

    const cancelBtn = document.getElementById('liquidCancelBtn');
    const confirmBtn = document.getElementById('liquidConfirmBtn');

    function cleanup(){
      overlay.classList.remove('show');
      if(cancelBtn) cancelBtn.onclick = null;
      if(confirmBtn) confirmBtn.onclick = null;
    }

    if(cancelBtn){
      cancelBtn.onclick = () => {
        cleanup();
        resolve(false);
      };
    }
    if(confirmBtn){
      confirmBtn.onclick = () => {
        cleanup();
        resolve(true);
      };
    }
  });
}

function showConfirmModal({title, message, confirmLabel = 'Ha', cancelLabel = "Bekor qilish", onConfirm}){
  showLiquidConfirm({
    title,
    message,
    confirmLabel,
    cancelLabel,
    isDanger: true
  }).then(ok => {
    if(ok && typeof onConfirm === 'function') onConfirm();
  });
}
async function clearAllExamHistoryOnBackend(){
  if(!SESSION_TOKEN){ setLastBackendError('—', "SESSION_TOKEN yo'q (Telegram orqali kirilmagan)"); return null; }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_clear_all_exam_history`, {
      method:"POST", headers: authHeaders(), body: JSON.stringify({})
    });
    if(!res.ok){ setLastBackendError(res.status, await res.text()); return null; }
    return await res.json(); // nechta yozuv o'chirilganini qaytaradi
  }catch(e){ setLastBackendError('—', e.message); return null; }
}
/* MUHIM: serverdagi quiz_attempts jadvali tozalanganidan KEYIN, shu belgini
   ham yangilab qo'yamiz — aks holda boshqa foydalanuvchilarning telefonidagi
   eski lokal Tarix keshi (ATTEMPTS_STORE_MAP) hech qachon tozalanmay qoladi
   (pastdagi purgeLocalHistoryIfStale() shu belgini kutib turadi). Avvalgi
   holatda bu chaqiruv umuman yo'q edi — shuning uchun admin tozalasa ham
   boshqa userlarda eski tarix ko'rinishda davom etardi. */
async function setHistoryPurgeMarkerOnBackend(){
  if(!SESSION_TOKEN) return null;
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_set_history_purge_marker`, {
      method:"POST", headers: authHeaders(), body: JSON.stringify({})
    });
    if(!res.ok){ setLastBackendError(res.status, await res.text()); return null; }
    const text = await res.text();
    return text ? JSON.parse(text) : true;
  }catch(e){ setLastBackendError('—', e.message); return null; }
}
function clearAllExamHistory(){
  showConfirmModal({
    title: "Diqqat",
    message: "Bu BARCHA foydalanuvchilarning BARCHA imtihon tarixini (natijalar, urinishlar) butunlay o'chiradi. Foydalanuvchilarning o'zi, XP va darajasi bunga tegmaydi. Bu amalni ORQAGA QAYTARIB BO'LMAYDI!\n\nDavom etasizmi?",
    confirmLabel: "Davom etish",
    onConfirm: () => {
      showConfirmModal({
        title: "So'nggi tasdiq",
        message: "Haqiqatan ham BARCHA foydalanuvchilarning imtihon tarixini butunlay o'chirmoqchimisiz?",
        confirmLabel: "Ha, butunlay o'chirish",
        onConfirm: async () => {
          const result = await clearAllExamHistoryOnBackend();
          if(result === null){ toast("⚠️ O'chirilmadi: " + window.LAST_BACKEND_ERROR, 6000); return; }
          // Boshqa foydalanuvchilarning telefonidagi eski lokal keshni ham
          // tozalash uchun belgini yangilaymiz (tafsilot yuqoridagi izohda).
          await setHistoryPurgeMarkerOnBackend();
          toast(`🗑 Imtihon tarixi tozalandi (${result} ta yozuv o'chirildi)`);
          // Bu qurilmada (admin ham test yechgan bo'lsa) lokal keshni darhol tozalaymiz.
          // Boshqa foydalanuvchilarning qurilmalari esa keyingi loadAppConfig() chaqirilganda
          // (har 30 soniyada bir) purgeLocalHistoryIfStale() orqali o'z-o'zidan tozalanadi —
          // pastdagi izohga qarang.
          ATTEMPTS_STORE_MAP = {};
          try{ localStorage.setItem(ATTEMPTS_STORE_KEY, JSON.stringify(ATTEMPTS_STORE_MAP)); }catch(e){}
          window.HISTORY_DATA_LIVE = [];
          HISTORY_DATA = [];
          if(historyLoaded){ renderHistoryStats(); renderHistoryList(); renderGrammarHistory(); }
          renderAdminPanel();
        }
      });
    }
  });
}

/* ---- Admin: BARCHA duellar tarixini tozalash ---- */
async function clearAllDuelHistoryOnBackend(){
  if(!SESSION_TOKEN){ setLastBackendError('—', "SESSION_TOKEN yo'q (Telegram orqali kirilmagan)"); return null; }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_clear_all_duel_history`, {
      method:"POST", headers: authHeaders(), body: JSON.stringify({})
    });
    if(!res.ok){ setLastBackendError(res.status, await res.text()); return null; }
    return await res.json();
  }catch(e){ setLastBackendError('—', e.message); return null; }
}

async function clearAllDuelHistory(){
  const ok = await showLiquidConfirm({
    title: "Barcha duellar tarixini tozalash",
    message: "DIQQAT: Bu bazadagi BARCHA foydalanuvchilarning barcha duel natijalari va faol/tugagan duellarini butunlay o'chiradi.",
    subtext: "Bu amalni ORQAGA QAYTARIB BO'LMAYDI!",
    confirmLabel: "Ha, butunlay tozalansin",
    cancelLabel: "Bekor qilish",
    isDanger: true
  });
  if(!ok) return;

  toast("⏳ Barcha duel tarixi tozalanmoqda...");
  const res = await clearAllDuelHistoryOnBackend();
  if(res === null){
    toast("⚠️ O'chirilmadi: " + (window.LAST_BACKEND_ERROR || ''));
    return;
  }
  _duelHistoryCache = {};
  toast(`🗑 Barcha duel tarixi muvaffaqiyatli tozalandi (${typeof res === 'number' ? res + ' ta yozuv' : 'bajarildi'})`);
}

/* ---- BOSHQA qurilmalardagi eski lokal Tarix keshini tozalash mexanizmi ----
   Muammo: admin serverdagi `quiz_attempts` jadvalini tozalasa ham, har bir
   foydalanuvchining O'Z TELEFONIDA (localStorage, ATTEMPTS_STORE_MAP) test
   tugagach saqlangan lokal nusxa qolib ketadi — admin bu keshga
   to'g'ridan-to'g'ri tega olmaydi.

   Yechim: shu maqsad uchun ALOHIDA, kichkina jadval va ikkita funksiya
   yaratamiz (mavjud hech qanday jadval yoki funksiyaga tegilmaydi — xavfsiz).
   Admin "hammasini tozalash"ni bosganda shu jadvaldagi vaqt belgisi
   yangilanadi; har bir qurilma esa ilova ochilganda/30 soniyada bir shu
   belgini so'rab, agar u o'zining oxirgi ko'rgan belgisidan yangiroq bo'lsa —
   o'z lokal keshini tozalaydi.

   PASTDAGI SQL'NI SUPABASE > SQL EDITOR'DA BIR MARTA ISHGA TUSHIRING: */
const HISTORY_PURGE_ACK_KEY = 'history_purge_ack_v1';
async function purgeLocalHistoryIfStale(){
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_history_purge_marker`, {
      method:"POST", headers: authHeaders(), body: JSON.stringify({})
    });
    if(!res.ok) return;
    const text = await res.text();
    const serverMarker = text ? JSON.parse(text) : null;
    if(!serverMarker) return;
    const serverTime = new Date(serverMarker).getTime();
    if(isNaN(serverTime)) return;
    const ackRaw = localStorage.getItem(HISTORY_PURGE_ACK_KEY);
    const ackTime = ackRaw ? new Date(ackRaw).getTime() : 0;
    if(serverTime > ackTime){
      ATTEMPTS_STORE_MAP = {};
      localStorage.setItem(ATTEMPTS_STORE_KEY, JSON.stringify(ATTEMPTS_STORE_MAP));
      localStorage.setItem(HISTORY_PURGE_ACK_KEY, new Date(serverTime).toISOString());
      window.HISTORY_DATA_LIVE = [];
      HISTORY_DATA = [];
      if(historyLoaded){ renderHistoryStats(); renderHistoryList(); renderGrammarHistory(); }
    }
  }catch(e){ console.warn('[purgeLocalHistoryIfStale]', e); }
}
/* ---- Foydalanuvchi: FAQAT o'zining imtihon tarixini tozalash ----
   Admin funksiyasidan farqli o'laroq, bu faqat joriy foydalanuvchining
   quiz_attempts qatorlarini o'chiradi. Kerakli SQL pastda, admin funksiyasi
   bilan bir joyda. */
async function clearMyExamHistoryOnBackend(){
  if(!SESSION_TOKEN){ setLastBackendError('—', "SESSION_TOKEN yo'q (Telegram orqali kirilmagan)"); return null; }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/clear_my_exam_history`, {
      method:"POST", headers: authHeaders(),
      body: JSON.stringify({ p_user_id: TELEGRAM_PROFILE.rawId })
    });
    if(!res.ok){ setLastBackendError(res.status, await res.text()); return null; }
    return await res.json(); // nechta yozuv o'chirilganini qaytaradi
  }catch(e){ setLastBackendError('—', e.message); return null; }
}
function clearMyExamHistory(){
  showConfirmModal({
    title: "Test tarixini tozalash",
    message: "Bu SIZNING barcha test/imtihon tarixingizni (natijalar, urinishlar) butunlay o'chiradi. XP va darajangiz bunga tegmaydi. Bu amalni ORQAGA QAYTARIB BO'LMAYDI!\n\nDavom etasizmi?",
    confirmLabel: "Ha, o'chirish",
    onConfirm: async () => {
      const result = await clearMyExamHistoryOnBackend();
      if(result === null){ toast("⚠️ O'chirilmadi: " + window.LAST_BACKEND_ERROR, 6000); return; }
      // Lokal keshni ham tozalaymiz — aks holda eski urinishlar Tarixda yana chiqib qolaveradi
      ATTEMPTS_STORE_MAP = {};
      try{ localStorage.setItem(ATTEMPTS_STORE_KEY, JSON.stringify(ATTEMPTS_STORE_MAP)); }catch(e){}
      window.HISTORY_DATA_LIVE = [];
      HISTORY_DATA = [];
      renderHistoryStats();
      renderHistoryList();
      renderGrammarHistory();
      computeGrammarTopicProgress();
      toast(`🗑 Tarixingiz tozalandi (${result} ta yozuv o'chirildi)`);
    }
  });
}


/* ---- 3) SAVOLLAR BANKI ---- */
/* ---- "Amallar" action-sheet: joriy bo'limga (grammatika/qiroa/boshqa) mos ravishda
   qo'shish tugmalarini ko'rsatadi, backup/import/tozalash har doim bir xil qoladi. ---- */
const AS_ICON_PLUS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>`;
/* Mavzu/test qatorlaridagi amal tugmalari uchun umumiy ikonkalar */
const IB_ICON_VIEW = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/></svg>`;
const IB_ICON_ADD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>`;
const IB_ICON_EDIT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
const IB_ICON_DEL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="m19 6-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>`;
const IB_ICON_DOTS = `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="12" cy="19" r="1.9"/></svg>`;
/* ---- Mavzu/test qatorlari uchun umumiy 3-nuqtali "Amallar" menyusi ----
   Har bir qator o'z amallar ro'yxatini (ko'rish/qo'shish/tahrirlash/o'chirish)
   ROW_MENU_REGISTRY'ga ro'yxatdan o'tkazadi, tugma bosilganda shu ro'yxat
   pastdan chiqadigan action-sheet'da jadval qilib ko'rsatiladi. */
let ROW_MENU_REGISTRY = {};
let ROW_MENU_SEQ = 0;
function rowMenuBtn(items, title){
  const id = 'rm' + (++ROW_MENU_SEQ);
  ROW_MENU_REGISTRY[id] = { items, title: title || 'Amallar' };
  return `<button type="button" class="icon-btn ib-menu" title="Amallar" onclick="event.stopPropagation(); openRowMenu('${id}')">${IB_ICON_DOTS}</button>`;
}
function openRowMenu(id){
  const entry = ROW_MENU_REGISTRY[id];
  if(!entry) return;
  document.getElementById('rowMenuTitle').textContent = entry.title;
  const list = document.getElementById('rowMenuList');
  list.innerHTML = entry.items.map((it,i)=>`
    <button type="button" class="as-row ${it.danger?'danger':''}" ${it.disabled?'disabled style="opacity:.4;cursor:not-allowed;"':''} onclick="rowMenuChoose('${id}',${i})">
      <span class="as-icon ${it.danger?'r':'b'}">${it.icon}</span>
      <span class="as-t">${it.label}</span>
      <svg class="as-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 6 6 6-6 6"/></svg>
    </button>`).join('');
  document.getElementById('rowMenuOverlay').classList.add('show');
}
function closeRowMenu(){ document.getElementById('rowMenuOverlay').classList.remove('show'); }
function rowMenuChoose(id, i){
  const entry = ROW_MENU_REGISTRY[id];
  const it = entry && entry.items[i];
  closeRowMenu();
  if(!it || it.disabled) return;
  setTimeout(()=>{ it.run(); }, 180);
}

let adminActiveSkill = 'qiroa';
let adminSubFilter = 'all';
let adminQuestionSearchQuery = '';
let adminQuestionSearchAllSkills = false;

function normalizeArabicSearch(text){
  if(!text) return '';
  return String(text)
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '') // remove tashkeel/harakat, tanween, tatweel
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .toLowerCase()
    .trim();
}

function textMatchesQuery(sourceText, query){
  if(!sourceText || !query) return false;
  const sStr = String(sourceText);
  const qStr = String(query).trim();
  if(!qStr) return false;
  if(sStr.toLowerCase().includes(qStr.toLowerCase())) return true;
  const sNorm = normalizeArabicSearch(sStr);
  const qNorm = normalizeArabicSearch(qStr);
  if(qNorm && sNorm.includes(qNorm)) return true;
  return false;
}

function highlightSearchText(text, query){
  if(!text || !query) return escapeHtml(text || '');
  const escaped = escapeHtml(text);
  const qTrim = query.trim();
  if(!qTrim) return escaped;
  try {
    const escapedRegex = qTrim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escapedRegex})`, 'gi');
    return escaped.replace(regex, '<mark style="background:rgba(234,179,8,0.32);color:inherit;padding:1px 4px;border-radius:4px;font-weight:700;">$1</mark>');
  } catch(e) {
    return escaped;
  }
}

function toggleAdminQuestionSearch(){
  const box = document.getElementById('adminQSearchBox');
  const btn = document.getElementById('adminQSearchToggleBtn');
  const input = document.getElementById('adminQuestionSearchInput');
  if(!box) return;
  const isHidden = box.style.display === 'none' || !box.style.display;
  if(isHidden){
    box.style.display = 'flex';
    if(btn) { btn.classList.remove('btn-outline'); btn.classList.add('btn-primary'); }
    if(input) { input.focus(); }
  } else {
    box.style.display = 'none';
    if(btn) { btn.classList.remove('btn-primary'); btn.classList.add('btn-outline'); }
    if(adminQuestionSearchQuery){
      adminQuestionSearchQuery = '';
      if(input) input.value = '';
      const clearBtn = document.getElementById('adminQSearchClearBtn');
      if(clearBtn) clearBtn.style.display = 'none';
      renderAdminQuestions();
    }
  }
}

function handleAdminQuestionSearch(val){
  adminQuestionSearchQuery = (val || '').trim();
  const clearBtn = document.getElementById('adminQSearchClearBtn');
  if(clearBtn){
    clearBtn.style.display = adminQuestionSearchQuery ? 'inline-block' : 'none';
  }
  renderAdminQuestions();
}

function clearAdminQuestionSearch(){
  adminQuestionSearchQuery = '';
  const input = document.getElementById('adminQuestionSearchInput');
  if(input) input.value = '';
  const clearBtn = document.getElementById('adminQSearchClearBtn');
  if(clearBtn) clearBtn.style.display = 'none';
  if(input) input.focus();
  renderAdminQuestions();
}

function toggleAdminQuestionSearchAllSkills(checked){
  adminQuestionSearchAllSkills = !!checked;
  renderAdminQuestions();
}

function renderAdminSkillFilters(){
  let subLabel = 'Kategoriya', subItems = [];
  if(adminActiveSkill==='grammatika'){ subLabel = 'Kategoriya'; subItems = GRAMMAR_CATEGORIES; }
  else if(adminActiveSkill==='qiroa'){ subLabel = 'Juz'; subItems = QIROA_JUZ; }
  else if(adminActiveSkill==='istima'){ subLabel = 'Qism'; subItems = ISTIMA_JUZ; }
  else if(adminActiveSkill==='muhavara'){ subLabel = 'Qism'; subItems = MUHAVARA_PARTS; }
  else if(adminActiveSkill==='kitaba'){ subLabel = 'Qism'; subItems = KITABA_PARTS; }

  initCustomDropdown('adminSkillDropdown', {
    label: 'Mahorat',
    options: SKILLS.map(s=>({value:s.id, label:s.name})),
    value: adminActiveSkill,
    onChange: (val)=> setAdminSkill(val),
  });

  const subWrap = document.getElementById('adminSubFilterDropdown');
  if(subWrap) subWrap.style.display = subItems.length ? '' : 'none';
  if(subItems.length){
    initCustomDropdown('adminSubFilterDropdown', {
      label: subLabel,
      options: [{value:'all', label:'Barchasi'}].concat(subItems.map(it=>({value:it.id, label:it.name}))),
      value: adminSubFilter,
      onChange: (val)=> setAdminSubFilter(val),
    });
  }
}
function renderAdminQuestions(){
  renderAdminSkillFilters();

  const list = document.getElementById('adminQuestionsList');
  const countEl = document.getElementById('adminQuestionsCount');

  if(adminQuestionSearchQuery){
    const query = adminQuestionSearchQuery;
    const skillsToSearch = adminQuestionSearchAllSkills
      ? ['grammatika', 'qiroa', 'istima', 'muhavara', 'kitaba']
      : [adminActiveSkill];

    const results = [];

    skillsToSearch.forEach(sk => {
      if(sk === 'grammatika'){
        // 1) Topic banks
        const topics = adminSubFilter === 'all' || adminQuestionSearchAllSkills
          ? GRAMMAR_TOPICS
          : GRAMMAR_TOPICS.filter(t => t.category === adminSubFilter);
        topics.forEach(topic => {
          const qs = GRAMMAR_TOPIC_BANKS[topic.id] || [];
          qs.forEach((q, idx) => {
            const matchesQ = textMatchesQuery(q.q, query);
            const matchesOpts = q.opts && q.opts.some(o => textMatchesQuery(o, query));
            const matchesExp = textMatchesQuery(q.exp, query);
            const matchesTopic = textMatchesQuery(topic.name, query) || textMatchesQuery(topic.ar, query);
            const matchesCat = textMatchesQuery(q.category, query) || textMatchesQuery(topic.category, query);
            if(matchesQ || matchesOpts || matchesExp || matchesTopic || matchesCat){
              results.push({
                type: 'mcq',
                skillId: 'grammatika',
                skillName: 'Grammatika',
                skillColor: 'grammatika',
                topicId: topic.id,
                contextTitle: `${topic.name} (${topic.ar})`,
                category: q.category || topic.category || 'nahv',
                qIndex: idx,
                q: q.q,
                opts: q.opts || [],
                a: q.a,
                exp: q.exp,
                id: q.id
              });
            }
          });
        });
        // 2) Real exam questions
        if(adminSubFilter === 'all' || adminQuestionSearchAllSkills){
          const realExamPool = QUESTION_BANKS.grammatika.questions || [];
          realExamPool.forEach((q, idx) => {
            const matchesQ = textMatchesQuery(q.q, query);
            const matchesOpts = q.opts && q.opts.some(o => textMatchesQuery(o, query));
            const matchesExp = textMatchesQuery(q.exp, query);
            const matchesCat = textMatchesQuery(q.category, query);
            if(matchesQ || matchesOpts || matchesExp || matchesCat){
              results.push({
                type: 'mcq',
                skillId: 'grammatika',
                skillName: 'Grammatika',
                skillColor: 'grammatika',
                topicId: null,
                contextTitle: 'Real imtihon savoli',
                category: q.category || 'nahv',
                qIndex: idx,
                q: q.q,
                opts: q.opts || [],
                a: q.a,
                exp: q.exp,
                id: q.id
              });
            }
          });
        }
      } else if(sk === 'qiroa'){
        const juzList = adminSubFilter === 'all' || adminQuestionSearchAllSkills
          ? QIROA_JUZ
          : QIROA_JUZ.filter(j => j.id === adminSubFilter);
        juzList.forEach(juz => {
          const tests = QIROA_TESTS[juz.id] || [];
          tests.forEach((t, tIdx) => {
            const matchesPassage = textMatchesQuery(t.passage, query);
            const matchesTitle = textMatchesQuery(t.title, query);
            (t.questions || []).forEach((q, idx) => {
              const matchesQ = textMatchesQuery(q.q, query);
              const matchesOpts = q.opts && q.opts.some(o => textMatchesQuery(o, query));
              const matchesExp = textMatchesQuery(q.exp, query);
              if(matchesQ || matchesOpts || matchesExp || matchesPassage || matchesTitle){
                results.push({
                  type: 'mcq',
                  skillId: 'qiroa',
                  skillName: 'Qiroat',
                  skillColor: 'qiroa',
                  topicId: t.id,
                  contextTitle: `${juz.name} · Test ${tIdx+1}${t.title ? ` (${t.title})` : ''}`,
                  qIndex: idx,
                  q: q.q,
                  opts: q.opts || [],
                  a: q.a,
                  exp: q.exp,
                  id: q.id,
                  passage: t.passage,
                  testTitle: t.title
                });
              }
            });
          });
        });
      } else if(sk === 'istima'){
        const juzList = adminSubFilter === 'all' || adminQuestionSearchAllSkills
          ? ISTIMA_JUZ
          : ISTIMA_JUZ.filter(j => j.id === adminSubFilter);
        juzList.forEach(juz => {
          const tests = ISTIMA_TESTS[juz.id] || [];
          tests.forEach((t, tIdx) => {
            (t.questions || []).forEach((q, idx) => {
              const matchesQ = textMatchesQuery(q.q, query);
              const matchesOpts = q.opts && q.opts.some(o => textMatchesQuery(o, query));
              const matchesExp = textMatchesQuery(q.exp, query);
              if(matchesQ || matchesOpts || matchesExp){
                results.push({
                  type: 'mcq',
                  skillId: 'istima',
                  skillName: 'Istimo\'',
                  skillColor: 'istima',
                  topicId: t.id,
                  contextTitle: `${juz.name} · Test ${tIdx+1}`,
                  qIndex: idx,
                  q: q.q,
                  opts: q.opts || [],
                  a: q.a,
                  exp: q.exp,
                  id: q.id,
                  audioUrl: t.audioUrl
                });
              }
            });
          });
        });
      } else if(sk === 'muhavara'){
        const partsList = adminSubFilter === 'all' || adminQuestionSearchAllSkills
          ? MUHAVARA_PARTS
          : MUHAVARA_PARTS.filter(p => p.id === adminSubFilter);
        partsList.forEach(part => {
          const qs = MUHAVARA_QUESTIONS[part.id] || [];
          qs.forEach((q, idx) => {
            if(textMatchesQuery(q.prompt, query) || textMatchesQuery(part.name, query)){
              results.push({
                type: 'speaking',
                skillId: 'muhavara',
                skillName: 'Muhovara',
                skillColor: 'muhavara',
                partId: part.id,
                contextTitle: part.name,
                qIndex: idx,
                prompt: q.prompt,
                id: q.id
              });
            }
          });
        });
      } else if(sk === 'kitaba'){
        const partsList = adminSubFilter === 'all' || adminQuestionSearchAllSkills
          ? KITABA_PARTS
          : KITABA_PARTS.filter(p => p.id === adminSubFilter);
        partsList.forEach(part => {
          const topics = KITABA_TOPICS[part.id] || [];
          topics.forEach((t, idx) => {
            if(textMatchesQuery(t.topicAr, query) || textMatchesQuery(part.name, query)){
              results.push({
                type: 'writing',
                skillId: 'kitaba',
                skillName: 'Kitoba',
                skillColor: 'kitaba',
                partId: part.id,
                contextTitle: part.name,
                qIndex: idx,
                topicAr: t.topicAr,
                id: t.id
              });
            }
          });
        });
      } else {
        const bank = QUESTION_BANKS[sk];
        (bank?.questions || []).forEach((q, idx) => {
          if(textMatchesQuery(q.q, query) || (q.opts && q.opts.some(o => textMatchesQuery(o, query))) || textMatchesQuery(q.exp, query)){
            results.push({
              type: 'mcq',
              skillId: sk,
              skillName: SKILL_META[sk]?.name || sk,
              skillColor: 'indigo',
              topicId: null,
              contextTitle: SKILL_META[sk]?.name || sk,
              qIndex: idx,
              q: q.q,
              opts: q.opts || [],
              a: q.a,
              exp: q.exp,
              id: q.id
            });
          }
        });
      }
    });

    countEl.innerHTML = `🔍 Qidiruv natijasi: <b>${results.length} ta</b> savol topildi ("${escapeHtml(query)}")`;

    if(results.length === 0){
      list.innerHTML = `
        <div class="placeholder-card" style="padding:40px 20px;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:36px;height:36px;margin:0 auto 10px;color:var(--text-faint);"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
          <h3 style="font-size:15px;margin-bottom:6px;">Savol topilmadi</h3>
          <p style="font-size:12.5px;color:var(--text-faint);max-width:380px;margin:0 auto 14px;">"${escapeHtml(query)}" bo'yicha hech qanday savol, matn yoki javob varianti topilmadi.</p>
          <button type="button" class="btn btn-outline" style="font-size:12.5px;padding:8px 16px;" onclick="clearAdminQuestionSearch()">Qidiruvni tozalash</button>
        </div>`;
      return;
    }

    list.innerHTML = results.map((res, i) => {
      let actionsHtml = '';
      const safeTopicId = res.topicId || '';
      const qIdx = (res.qIndex !== undefined && res.qIndex !== null) ? res.qIndex : -1;
      const resId = res.id || '';

      if(res.type === 'mcq'){
        const actions = [
          { icon: IB_ICON_VIEW, label: "Savollar ro'yxatidagi o'rni", run: () => viewTopicQuestions(res.skillId, res.topicId, res.qIndex) },
          { icon: IB_ICON_EDIT, label: "Tahrirlash", run: () => openEditQuestionModal(res.skillId, res.topicId, res.qIndex) },
          { icon: IB_ICON_DEL, label: "O'chirish", danger: true, run: () => deleteQuestion(res.skillId, res.topicId, res.qIndex) }
        ];
        actionsHtml = rowMenuBtn(actions, `Savol ${i+1}`);
      } else if(res.type === 'speaking'){
        const actions = [
          { icon: IB_ICON_EDIT, label: "Tahrirlash", run: () => openEditSpeakingQuestionModal(res.id) },
          { icon: IB_ICON_DEL, label: "O'chirish", danger: true, run: () => deleteSpeakingQuestion(res.id) }
        ];
        actionsHtml = rowMenuBtn(actions, `Savol ${i+1}`);
      } else if(res.type === 'writing'){
        const actions = [
          { icon: IB_ICON_EDIT, label: "Tahrirlash", run: () => openEditKitabaTopicModal(res.id) },
          { icon: IB_ICON_DEL, label: "O'chirish", danger: true, run: () => deleteKitabaTopic(res.id) }
        ];
        actionsHtml = rowMenuBtn(actions, `Mavzu ${i+1}`);
      }

      const catObj = res.category ? GRAMMAR_CATEGORIES.find(c => c.id === res.category) : null;
      const catBadge = catObj ? `<span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:6px;background:var(--indigo-100);color:var(--indigo-700);">${catObj.name} (${catObj.ar})</span>` : '';

      if(res.type === 'mcq'){
        return `
          <div class="report-item search-result-card" style="position:relative;margin-bottom:12px;background:var(--card);" onclick="navigateToSearchedQuestion('${res.skillId}','${safeTopicId}',${qIdx},'${resId}')">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                <span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;background:var(--${res.skillColor}-bg, var(--indigo-100));color:var(--${res.skillColor}, var(--indigo-700));">${res.skillName}</span>
                <span style="font-size:11.5px;font-weight:600;color:var(--text-dim);">${escapeHtml(res.contextTitle)}</span>
                ${catBadge}
              </div>
              <div class="t-actions" onclick="event.stopPropagation()">${actionsHtml}</div>
            </div>
            <div style="font-weight:600;font-size:14px;direction:rtl;text-align:right;margin-bottom:10px;line-height:1.7;">
              ${highlightSearchText(res.q, query)}
            </div>
            <div style="display:flex;flex-direction:column;gap:6px;">
              ${(res.opts || []).map((opt, oi) => `
                <div style="font-size:12.5px;font-weight:600;direction:rtl;text-align:right;padding:4px 8px;border-radius:6px;background:${oi === res.a ? 'var(--green-bg)' : 'transparent'};color:${oi === res.a ? 'var(--green)' : 'var(--text-dim)'};">
                  ${oi === res.a ? '✓ ' : ''}${highlightSearchText(opt, query)}
                </div>
              `).join('')}
            </div>
            ${res.exp ? `<div style="font-size:11.5px;color:var(--text-faint);font-weight:600;margin-top:8px;padding-top:8px;border-top:1px solid var(--border);">${highlightSearchText(res.exp, query)}</div>` : ''}
          </div>
        `;
      } else if(res.type === 'speaking'){
        return `
          <div class="report-item search-result-card" style="position:relative;margin-bottom:12px;background:var(--card);" onclick="openEditSpeakingQuestionModal('${resId}')">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                <span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;background:var(--muhavara-bg);color:var(--muhavara);">${res.skillName}</span>
                <span style="font-size:11.5px;font-weight:600;color:var(--text-dim);">${escapeHtml(res.contextTitle)}</span>
              </div>
              <div class="t-actions" onclick="event.stopPropagation()">${actionsHtml}</div>
            </div>
            <div style="font-weight:600;font-size:14px;direction:rtl;text-align:right;line-height:1.7;">
              ${highlightSearchText(res.prompt, query)}
            </div>
          </div>
        `;
      } else if(res.type === 'writing'){
        return `
          <div class="report-item search-result-card" style="position:relative;margin-bottom:12px;background:var(--card);" onclick="openEditKitabaTopicModal('${resId}')">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                <span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;background:var(--kitaba-bg);color:var(--kitaba);">${res.skillName}</span>
                <span style="font-size:11.5px;font-weight:600;color:var(--text-dim);">${escapeHtml(res.contextTitle)}</span>
              </div>
              <div class="t-actions" onclick="event.stopPropagation()">${actionsHtml}</div>
            </div>
            <div style="font-weight:600;font-size:14px;direction:rtl;text-align:right;line-height:1.7;">
              ${highlightSearchText(res.topicAr, query)}
            </div>
          </div>
        `;
      }
    }).join('');
    return;
  }

  if(adminActiveSkill==='grammatika'){
    const topics = adminSubFilter==='all' ? GRAMMAR_TOPICS : GRAMMAR_TOPICS.filter(t=>t.category===adminSubFilter);
    const total = topics.reduce((s,t)=> s + (GRAMMAR_TOPIC_BANKS[t.id]?.length||0), 0);
    const realExamPool = QUESTION_BANKS.grammatika.questions || [];
    const realExamCount = realExamPool.length;
    const catCounts = { nahv: 0, sarf: 0, imlo: 0, xatolar: 0 };
    realExamPool.forEach(q => {
      const c = q.category || 'nahv';
      if(catCounts[c] !== undefined) catCounts[c]++;
      else catCounts.nahv++;
    });
    countEl.textContent = `${topics.length} ta mavzu · ${total} ta amaliyot savoli · ${realExamCount} ta real imtihon savoli`;
    const realExamRow = (adminSubFilter==='all') ? `<div class="topic-row" style="border-inline-start:2px solid var(--indigo-500);padding-inline-start:10px;">
        <div>
          <div class="t-name">🎓 Grammatika mahorati (real imtihon — 30 ta savol)</div>
          <div class="t-meta" style="margin-top:2px;">
            Jami: <b>${realExamCount} ta</b> savol · Nisbat: Nahv (${catCounts.nahv}/15), Sarf (${catCounts.sarf}/7), Imlo (${catCounts.imlo}/4), Xatolar (${catCounts.xatolar}/4)
          </div>
        </div>
        <div class="t-actions">${rowMenuBtn([
          {icon:IB_ICON_VIEW, label:"Ko'rish", run:()=>viewTopicQuestions('grammatika', null)},
          {icon:IB_ICON_ADD, label:"Savol qo'shish", run:()=>openAddQuestionModal('grammatika', null)},
        ], 'Grammatika mahorati')}</div>
      </div>` : '';
    if(topics.length===0 && !realExamRow){
      list.innerHTML = `<div class="placeholder-card"><h3>Hali mavzu yo'q</h3><p>"Amallar" tugmasi orqali birinchi grammatika mavzusini qo'shing, so'ng unga savollar kiriting.</p></div>`;
      return;
    }
    list.innerHTML = realExamRow + topics.map(t=>{
      const n = GRAMMAR_TOPIC_BANKS[t.id]?.length || 0;
      const cat = GRAMMAR_CATEGORIES.find(c=>c.id===t.category);
      const menu = rowMenuBtn([
        {icon:IB_ICON_VIEW, label:"Ko'rish", run:()=>viewTopicQuestions('grammatika', t.id)},
        {icon:IB_ICON_ADD, label:"Savol qo'shish", run:()=>openAddQuestionModal('grammatika', t.id)},
        {icon:IB_ICON_EDIT, label:'Tahrirlash', run:()=>openEditTopicModal(t.id)},
        {icon:IB_ICON_DEL, label:"O'chirish", danger:true, run:()=>deleteTopic(t.id)},
      ], t.name);
      return `<div class="topic-row">
        <div>
          <div class="t-name">${t.name}</div>
          <div class="t-meta">${n} ta savol · ${t.ar}${cat?' · '+cat.name:''}</div>
        </div>
        <div class="t-actions">${menu}</div>
      </div>`;
    }).join('');
  } else if(adminActiveSkill==='qiroa'){
    const juzList = adminSubFilter==='all' ? QIROA_JUZ : QIROA_JUZ.filter(j=>j.id===adminSubFilter);
    const totalTests = juzList.reduce((s,j)=> s + (QIROA_TESTS[j.id]?.length||0), 0);
    const totalQ = juzList.reduce((s,j)=> s + (QIROA_TESTS[j.id]||[]).reduce((s2,t)=>s2+t.questions.length,0), 0);
    countEl.textContent = `${juzList.length} ta juz · ${totalTests} ta test · ${totalQ} ta savol`;
    list.innerHTML = juzList.map(j=>{
      const tests = QIROA_TESTS[j.id] || [];
      const testRows = tests.length
        ? tests.map((t,idx)=>{
            const n = t.questions.length;
            const excerpt = (t.passage||'').trim().slice(0,40) || '(matn kiritilmagan)';
            const excerptLine = t.title
              ? `📌 ${escapeHtml(t.title)}`
              : `${escapeHtml(excerpt)}${(t.passage||'').length>40?'…':''}`;
            const menu = rowMenuBtn([
              {icon:IB_ICON_VIEW, label:"Ko'rish", run:()=>viewTopicQuestions('qiroa', t.id)},
              {icon:IB_ICON_ADD, label:"Savol qo'shish", disabled:n>=QIROA_MAX_Q_PER_TEST, run:()=>openAddQuestionModal('qiroa', t.id)},
              {icon:IB_ICON_EDIT, label:'Matnni tahrirlash', run:()=>openEditQiroaTextModal(t.id)},
              {icon:IB_ICON_DEL, label:"O'chirish", danger:true, run:()=>deleteQiroaTest(t.id)},
            ], `${j.name} · Test ${idx+1}`);
            return `<div class="topic-row" style="margin-inline-start:14px;border-inline-start:2px solid var(--qiroa);padding-inline-start:10px;">
              <div>
                <div class="t-name" style="font-size:13px;">${j.name} · Test ${idx+1}</div>
                <div class="t-meta" dir="rtl" style="text-align:left;direction:ltr;">${excerptLine}</div>
                <div class="t-meta">${n} / ${QIROA_MAX_Q_PER_TEST} ta savol</div>
              </div>
              <div class="t-actions">${menu}</div>
            </div>`;
          }).join('')
        : `<div class="t-meta" style="margin-inline-start:14px;">Hali test yo'q</div>`;
      return `<div class="topic-row" style="align-items:flex-start;">
        <div style="flex:1;">
          <div class="t-name">${j.name}</div>
          <div class="t-meta">${tests.length} ta test · O'qish: ${j.readMins} daq · Savollar: ${j.qMins} daq</div>
          <div style="margin-top:8px;display:flex;flex-direction:column;gap:8px;">${testRows}</div>
        </div>
      </div>`;
    }).join('');
  } else if(adminActiveSkill==='istima'){
    const juzList = adminSubFilter==='all' ? ISTIMA_JUZ : ISTIMA_JUZ.filter(j=>j.id===adminSubFilter);
    const totalTests = juzList.reduce((s,j)=> s + (ISTIMA_TESTS[j.id]?.length||0), 0);
    const totalQ = juzList.reduce((s,j)=> s + (ISTIMA_TESTS[j.id]||[]).reduce((s2,t)=>s2+t.questions.length,0), 0);
    countEl.textContent = `${juzList.length} ta qism · ${totalTests} ta test · ${totalQ} ta savol`;
    list.innerHTML = juzList.map(j=>{
      const tests = ISTIMA_TESTS[j.id] || [];
      const testRows = tests.length
        ? tests.map((t,idx)=>{
            const n = t.questions.length;
            const complete = n >= j.qCount;
            const menu = rowMenuBtn([
              {icon:IB_ICON_VIEW, label:"Ko'rish", run:()=>viewTopicQuestions('istima', t.id)},
              {icon:IB_ICON_ADD, label:"Savol qo'shish", disabled:n>=j.qCount, run:()=>openAddQuestionModal('istima', t.id)},
              {icon:IB_ICON_EDIT, label:"Audio URL'ni tahrirlash", run:()=>openEditIstimaAudioModal(t.id)},
              {icon:IB_ICON_DEL, label:"O'chirish", danger:true, run:()=>deleteIstimaTest(t.id)},
            ], `${j.name} · Test ${idx+1}`);
            return `<div class="topic-row" style="margin-inline-start:14px;border-inline-start:2px solid var(--istima);padding-inline-start:10px;">
              <div>
                <div class="t-name" style="font-size:13px;">${j.name} · Test ${idx+1}</div>
                <div class="t-meta">${t.audioUrl ? `<a href="${escapeHtml(t.audioUrl)}" target="_blank" rel="noopener" style="color:var(--istima);text-decoration:none;">🔊 Audio havolasi</a>` : '<span style="opacity:.6;">Audio URL kiritilmagan</span>'}</div>
                <div class="t-meta">${n} / ${j.qCount} ta savol ${complete?'✅':''}</div>
              </div>
              <div class="t-actions">${menu}</div>
            </div>`;
          }).join('')
        : `<div class="t-meta" style="margin-inline-start:14px;">Hali test yo'q</div>`;
      return `<div class="topic-row" style="align-items:flex-start;">
        <div style="flex:1;">
          <div class="t-name">${j.name}</div>
          <div class="t-meta">${tests.length} ta test · har testda ${j.qCount} ta savol · audio ${j.maxPlays} marta ijro etiladi</div>
          <div style="margin-top:8px;display:flex;flex-direction:column;gap:8px;">${testRows}</div>
        </div>
      </div>`;
    }).join('');
  } else if(adminActiveSkill==='muhavara'){
    const partsList = adminSubFilter==='all' ? MUHAVARA_PARTS : MUHAVARA_PARTS.filter(p=>p.id===adminSubFilter);
    const total = partsList.reduce((s,p)=> s + (MUHAVARA_QUESTIONS[p.id]?.length||0), 0);
    countEl.textContent = `${partsList.length} ta qism · ${total} ta savol`;
    list.innerHTML = partsList.map(p=>{
      const qs = MUHAVARA_QUESTIONS[p.id] || [];
      const n = qs.length;
      const rows = qs.length
        ? qs.map(q=>{
            const menu = rowMenuBtn([
              {icon:IB_ICON_EDIT, label:'Tahrirlash', run:()=>openEditSpeakingQuestionModal(q.id)},
              {icon:IB_ICON_DEL, label:"O'chirish", danger:true, run:()=>deleteSpeakingQuestion(q.id)},
            ], p.name);
            return `<div class="topic-row" style="margin-inline-start:14px;border-inline-start:2px solid var(--muhavara);padding-inline-start:10px;">
            <div>
              <div class="t-meta" dir="rtl" style="text-align:left;direction:rtl;font-size:14px;color:var(--text);">${escapeHtml(q.prompt)}</div>
            </div>
            <div class="t-actions">${menu}</div>
          </div>`;}).join('')
        : `<div class="t-meta" style="margin-inline-start:14px;">Hali savol yo'q</div>`;
      return `<div class="topic-row" style="align-items:flex-start;">
        <div style="flex:1;">
          <div class="t-name">${p.name}</div>
          <div class="t-meta">${n} ta savol (bank) · Imtihonda: ${MUHAVARA_MAX_Q_PER_PART} ta tasodifiy · Tayyorgarlik: ${p.prepSecs}s · Javob: ${p.answerSecs}s</div>
          <div style="margin-top:8px;display:flex;flex-direction:column;gap:8px;">${rows}</div>
        </div>
        <div class="t-actions">
          <button class="row-btn" onclick="openBulkAddSpeakingQuestionModal('${p.id}')">Ommaviy</button>
          <button class="row-btn" onclick="openAddSpeakingQuestionModal('${p.id}')">+ Savol</button>
        </div>
      </div>`;
    }).join('');
  } else if(adminActiveSkill==='kitaba'){
    const partsList = adminSubFilter==='all' ? KITABA_PARTS : KITABA_PARTS.filter(p=>p.id===adminSubFilter);
    const total = partsList.reduce((s,p)=> s + (KITABA_TOPICS[p.id]?.length||0), 0);
    countEl.textContent = `${partsList.length} ta qism · ${total} ta mavzu`;
    list.innerHTML = partsList.map(p=>{
      const topics = KITABA_TOPICS[p.id] || [];
      const n = topics.length;
      const rows = topics.length
        ? topics.map(t=>{
            const menu = rowMenuBtn([
              {icon:IB_ICON_EDIT, label:'Tahrirlash', run:()=>openEditKitabaTopicModal(t.id)},
              {icon:IB_ICON_DEL, label:"O'chirish", danger:true, run:()=>deleteKitabaTopic(t.id)},
            ], p.name);
            return `<div class="topic-row" style="margin-inline-start:14px;border-inline-start:2px solid var(--kitaba);padding-inline-start:10px;">
            <div>
              <div class="t-meta" dir="rtl" style="text-align:left;direction:rtl;font-size:14px;color:var(--text);">${escapeHtml(t.topicAr)}</div>
            </div>
            <div class="t-actions">${menu}</div>
          </div>`;}).join('')
        : `<div class="t-meta" style="margin-inline-start:14px;">Hali mavzu yo'q</div>`;
      return `<div class="topic-row" style="align-items:flex-start;">
        <div style="flex:1;">
          <div class="t-name">${p.name}</div>
          <div class="t-meta">${n} ta mavzu · Kamida ${p.minWords} so'z · Vaqt: ${Math.round(p.seconds/60)} daqiqa</div>
          <div style="margin-top:8px;display:flex;flex-direction:column;gap:8px;">${rows}</div>
        </div>
      </div>`;
    }).join('');
  } else {
    const bank = QUESTION_BANKS[adminActiveSkill];
    const n = bank?.questions?.length || 0;
    countEl.textContent = `${n} ta savol`;
    if(n===0){
      list.innerHTML = `<div class="placeholder-card"><h3>Hali savol yo'q</h3><p>"Amallar" tugmasi orqali qo'shing.</p></div>`;
      return;
    }
    list.innerHTML = `<div class="topic-row">
      <div>
        <div class="t-name">${SKILL_META[adminActiveSkill]?.name || adminActiveSkill}</div>
        <div class="t-meta">${n} ta savol</div>
      </div>
      <div class="t-actions">
        <button class="row-btn" onclick="viewTopicQuestions('${adminActiveSkill}', null)">Ko'rish</button>
      </div>
    </div>`;
  }
}
function setAdminSkill(id){ adminActiveSkill = id; adminSubFilter = 'all'; renderAdminQuestions(); }
function setAdminSubFilter(val){ adminSubFilter = val; renderAdminQuestions(); }

const IB_ICON_UP = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`;
const IB_ICON_DOWN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12l7 7 7-7"/></svg>`;
const IB_ICON_MINUS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/></svg>`;
function renderAdminActionsSheet(){
  const grid = document.getElementById('asGrid');
  const primary = document.getElementById('asPrimary');
  if(!grid || !primary) return;
  const isGrammar = adminActiveSkill === 'grammatika';
  const isQiroa = adminActiveSkill === 'qiroa';
  const isIstima = adminActiveSkill === 'istima';
  const isKitaba = adminActiveSkill === 'kitaba';
  const isMuhavara = adminActiveSkill === 'muhavara';
  let gridHtml = '', primaryHtml = '';
  if(isGrammar){
    gridHtml = `
      <button class="as-card" onclick="adminActionsSheetChoose(()=>openAddTopicModal())">
        <span class="as-icon g">${AS_ICON_PLUS}</span><span class="as-t">Yangi mavzu</span>
      </button>
      <button class="as-card" onclick="adminActionsSheetChoose(()=>openBulkAddQuestionModal())">
        <span class="as-icon g">${AS_ICON_PLUS}</span><span class="as-t">Ommaviy qo'shish</span>
      </button>`;
    primaryHtml = `<button class="as-primary" onclick="adminActionsSheetChoose(()=>openAddQuestionModal())">
        <span class="as-icon">${AS_ICON_PLUS}</span><span class="as-t">Yangi savol qo'shish</span>
      </button>`;
  } else if(isQiroa){
    gridHtml = `
      <button class="as-card" style="grid-column:1 / -1;" onclick="adminActionsSheetChoose(()=>openBulkAddQiroaTestsModal())">
        <span class="as-icon g">${AS_ICON_PLUS}</span><span class="as-t">Bir nechta test (JSON)</span>
      </button>`;
    primaryHtml = `<button class="as-primary" onclick="adminActionsSheetChoose(()=>openAddQiroaFullTestModal())">
        <span class="as-icon">${AS_ICON_PLUS}</span><span class="as-t">Yangi test qo'shish</span>
      </button>`;
  } else if(isIstima){
    gridHtml = `
      <button class="as-card" style="grid-column:1 / -1;" onclick="adminActionsSheetChoose(()=>openBulkAddIstimaTestsModal())">
        <span class="as-icon g">${AS_ICON_PLUS}</span><span class="as-t">Bir nechta test (JSON)</span>
      </button>`;
    primaryHtml = `<button class="as-primary" onclick="adminActionsSheetChoose(()=>openAddIstimaFullTestModal())">
        <span class="as-icon">${AS_ICON_PLUS}</span><span class="as-t">Yangi test qo'shish</span>
      </button>`;
  } else if(isKitaba){
    gridHtml = '';
    primaryHtml = `<button class="as-primary" onclick="adminActionsSheetChoose(()=>openAddKitabaTopicModal())">
        <span class="as-icon">${AS_ICON_PLUS}</span><span class="as-t">Yangi mavzu qo'shish</span>
      </button>`;
  } else if(isMuhavara){
    gridHtml = `
      <button class="as-card" style="grid-column:1 / -1;" onclick="adminActionsSheetChoose(()=>openBulkAddSpeakingQuestionModal())">
        <span class="as-icon g">${AS_ICON_PLUS}</span><span class="as-t">Bir nechta savol (ommaviy)</span>
      </button>`;
    primaryHtml = `<button class="as-primary" onclick="adminActionsSheetChoose(()=>openAddSpeakingQuestionModal())">
        <span class="as-icon">${AS_ICON_PLUS}</span><span class="as-t">Yangi savol qo'shish</span>
      </button>`;
  } else {
    gridHtml = `
      <button class="as-card" style="grid-column:1 / -1;" onclick="adminActionsSheetChoose(()=>openBulkAddQuestionModal())">
        <span class="as-icon g">${AS_ICON_PLUS}</span><span class="as-t">Ommaviy qo'shish</span>
      </button>`;
    primaryHtml = `<button class="as-primary" onclick="adminActionsSheetChoose(()=>openAddQuestionModal())">
        <span class="as-icon">${AS_ICON_PLUS}</span><span class="as-t">Yangi savol qo'shish</span>
      </button>`;
  }
  grid.innerHTML = gridHtml;
  primary.innerHTML = primaryHtml;
}
function openAdminActionsSheet(){
  renderAdminActionsSheet();
  document.getElementById('adminActionsOverlay').classList.add('show');
}
function closeAdminActionsSheet(){
  document.getElementById('adminActionsOverlay').classList.remove('show');
}
/* Sheetdagi biror amalni tanlaganda: avval sheet yopiladi, so'ng haqiqiy funksiya chaqiriladi
   (aks holda ochilayotgan yangi modal action-sheet ortida yashiringan bo'lib qolardi). */
function adminActionsSheetChoose(fn){
  closeAdminActionsSheet();
  setTimeout(fn, 180);
}

/* ---- Grammatika mavzularini boshqarish (qo'shish / tahrirlash / o'chirish) ---- */
function openAddTopicModal(){
  document.getElementById('modalTitle').textContent = "Yangi grammatika mavzusi";
  document.getElementById('modalBody').innerHTML = `
    <form id="adminTopicForm" style="display:flex;flex-direction:column;gap:14px;padding:6px 4px;" onsubmit="return submitNewTopic(event)">
      <div class="form-field">
        <label>Kategoriya</label>
        <select id="tCategory">
          ${GRAMMAR_CATEGORIES.map(c=>`<option value="${c.id}">${c.name} (${c.ar})</option>`).join('')}
        </select>
      </div>
      <div class="form-field">
        <label>Mavzu nomi (o'zbekcha)</label>
        <input type="text" id="tName" placeholder="Masalan: Ism va uning turlari" required>
      </div>
      <div class="form-field">
        <label>Mavzu nomi (arabcha)</label>
        <input type="text" id="tAr" dir="rtl" placeholder="الاسم وأنواعه" required>
      </div>
      <button type="submit" class="btn btn-primary btn-block">Saqlash</button>
    </form>
  `;
  document.getElementById('modalOverlay').classList.add('show');
}
async function submitNewTopic(e){
  e.preventDefault();
  const category = document.getElementById('tCategory').value;
  const name = document.getElementById('tName').value.trim();
  const ar = document.getElementById('tAr').value.trim();
  if(!name || !ar) return false;
  const saved = await saveGrammarTopicToBackend({category, name, ar});
  if(!saved){
    toast("❌ Mavzu saqlanmadi: " + window.LAST_BACKEND_ERROR, 6000);
    return false;
  }
  const row = Array.isArray(saved) ? saved[0] : saved;
  GRAMMAR_TOPICS.push(mapBackendGrammarTopic({ id: row.id, category, name, ar }));
  closeModal();
  renderAdminQuestions();
  renderGrammarCategories();
  toast("✅ Mavzu qo'shildi — endi hamma foydalanuvchida ko'rinadi");
  return false;
}
function openEditTopicModal(id){
  const t = GRAMMAR_TOPICS.find(x=>x.id===id);
  if(!t) return;
  document.getElementById('modalTitle').textContent = "Mavzuni tahrirlash";
  document.getElementById('modalBody').innerHTML = `
    <form id="adminTopicEditForm" style="display:flex;flex-direction:column;gap:14px;padding:6px 4px;" onsubmit="return submitEditTopic(event,'${id}')">
      <div class="form-field">
        <label>Kategoriya</label>
        <select id="tCategory">
          ${GRAMMAR_CATEGORIES.map(c=>`<option value="${c.id}" ${c.id===t.category?'selected':''}>${c.name} (${c.ar})</option>`).join('')}
        </select>
      </div>
      <div class="form-field">
        <label>Mavzu nomi (o'zbekcha)</label>
        <input type="text" id="tName" value="${escapeHtml(t.name)}" required>
      </div>
      <div class="form-field">
        <label>Mavzu nomi (arabcha)</label>
        <input type="text" id="tAr" dir="rtl" value="${escapeHtml(t.ar)}" required>
      </div>
      <button type="submit" class="btn btn-primary btn-block">Saqlash</button>
    </form>
  `;
  document.getElementById('modalOverlay').classList.add('show');
}
async function submitEditTopic(e, id){
  e.preventDefault();
  const t = GRAMMAR_TOPICS.find(x=>x.id===id);
  if(!t) return false;
  const category = document.getElementById('tCategory').value;
  const name = document.getElementById('tName').value.trim();
  const ar = document.getElementById('tAr').value.trim();
  const ok = await updateGrammarTopicOnBackend({id, category, name, ar});
  if(!ok){
    toast("❌ Saqlanmadi: " + window.LAST_BACKEND_ERROR, 6000);
    return false;
  }
  t.category = category; t.name = name; t.ar = ar;
  closeModal();
  renderAdminQuestions();
  renderGrammarCategories();
  toast("✅ Mavzu yangilandi");
  return false;
}
async function deleteTopic(id){
  const t = GRAMMAR_TOPICS.find(x=>x.id===id);
  if(!t) return;
  const n = GRAMMAR_TOPIC_BANKS[id]?.length || 0;
  const ok = await showLiquidConfirm({
    title: "Mavzuni o'chirish",
    message: n ? `Bu mavzuda ${n} ta savol bor. Mavzu va uning barcha savollarini o'chirmoqchimisiz?` : "Bu mavzuni rostdan ham o'chirmoqchimisiz?",
    subtext: "Bu amalni ortga qaytarib bo'lmaydi.",
    confirmLabel: "Ha, o'chirilsin",
    cancelLabel: "Bekor qilish",
    isDanger: true
  });
  if(!ok) return;
  const deleted = await deleteGrammarTopicOnBackend(id);
  if(!deleted){
    toast("❌ O'chirilmadi: " + window.LAST_BACKEND_ERROR, 6000);
    return;
  }
  GRAMMAR_TOPICS = GRAMMAR_TOPICS.filter(x=>x.id!==id);
  delete GRAMMAR_TOPIC_BANKS[id];
  renderAdminQuestions();
  renderGrammarCategories();
  toast("✅ Mavzu o'chirildi");
}

function navigateToSearchedQuestion(skillId, topicId, qIndex, questionId){
  if(skillId === 'muhavara'){
    openEditSpeakingQuestionModal(questionId);
    return;
  }
  if(skillId === 'kitaba'){
    openEditKitabaTopicModal(questionId);
    return;
  }
  viewTopicQuestions(skillId, topicId, qIndex);
}

let CURRENT_TOPIC_Q_CAT_FILTER = 'all';

function viewTopicQuestions(skillId, topicId, highlightIdx = null, selectedCat = null){
  if(selectedCat !== null && selectedCat !== undefined){
    CURRENT_TOPIC_Q_CAT_FILTER = selectedCat;
  } else if(highlightIdx !== null && highlightIdx !== undefined && highlightIdx >= 0) {
    CURRENT_TOPIC_Q_CAT_FILTER = 'all';
  }
  const items = getQuestionItems(skillId, topicId);
  renderTopicQuestionsModal(skillId, topicId, items || [], highlightIdx, CURRENT_TOPIC_Q_CAT_FILTER);
  document.getElementById('modalOverlay').classList.add('show');
  if(highlightIdx !== null && highlightIdx !== undefined && highlightIdx >= 0){
    setTimeout(()=>{
      const targetEl = document.getElementById(`topicQItem_${highlightIdx}`);
      if(targetEl){
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 150);
  }
}

function filterTopicQuestionsModalCategory(skillId, topicId, selectedCat){
  CURRENT_TOPIC_Q_CAT_FILTER = selectedCat;
  const items = getQuestionItems(skillId, topicId);
  renderTopicQuestionsModal(skillId, topicId, items || [], null, selectedCat);
}

/* Savollar ro'yxatini beruvchi umumiy funksiya — edit/delete/move ham shundan foydalanadi.
   MUHIM: grammatika uchun topicId bo'lmasa (mavzusiz) — bu "faqat real imtihon" uchun
   ajratilgan alohida savollar banki (QUESTION_BANKS.grammatika.questions), amaliyot
   mavzulari (GRAMMAR_TOPIC_BANKS) bilan ARALASHMAYDI. */
function getQuestionItems(skillId, topicId){
  if(skillId==='grammatika') return topicId ? GRAMMAR_TOPIC_BANKS[topicId] : QUESTION_BANKS.grammatika.questions;
  if(skillId==='qiroa') return QIROA_TEST_BY_ID[topicId]?.questions;
  if(skillId==='istima') return ISTIMA_TEST_BY_ID[topicId]?.questions;
  return QUESTION_BANKS[skillId]?.questions;
}

function renderTopicQuestionsModal(skillId, topicId, items, highlightIdx = null, selectedCat = 'all'){
  const isGrammar = skillId === 'grammatika';

  let availableCats = [];
  if(isGrammar){
    availableCats = GRAMMAR_CATEGORIES.map(cat => ({
      id: cat.id,
      name: cat.name,
      ar: cat.ar,
      count: items.filter(q => (q.category || 'nahv') === cat.id).length
    }));
  } else {
    const catMap = new Map();
    items.forEach(q => {
      if(q.category){
        const count = (catMap.get(q.category) || 0) + 1;
        catMap.set(q.category, count);
      }
    });
    if(catMap.size > 0){
      catMap.forEach((count, catId) => {
        const catObj = GRAMMAR_CATEGORIES.find(c => c.id === catId);
        availableCats.push({
          id: catId,
          name: catObj ? catObj.name : catId,
          ar: catObj ? catObj.ar : '',
          count
        });
      });
    }
  }

  const indexedItems = items.map((q, i) => ({ q, originalIndex: i }));
  let filteredItems = indexedItems;
  if(selectedCat && selectedCat !== 'all'){
    filteredItems = indexedItems.filter(({ q }) => (q.category || 'nahv') === selectedCat);
  }

  if(selectedCat && selectedCat !== 'all'){
    const currentCatObj = availableCats.find(c => c.id === selectedCat) || GRAMMAR_CATEGORIES.find(c => c.id === selectedCat);
    const catLabel = currentCatObj ? currentCatObj.name : selectedCat;
    document.getElementById('modalTitle').textContent = `Savollar (${filteredItems.length}/${items.length} ta · ${catLabel})`;
  } else {
    document.getElementById('modalTitle').textContent = `Savollar (${items.length} ta)`;
  }

  let filterBarHtml = '';
  if(isGrammar || availableCats.length > 0){
    filterBarHtml = `
      <div style="margin-bottom:14px;background:var(--card);border:1.5px solid var(--border);border-radius:12px;padding:9px 12px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
        <div style="display:flex;align-items:center;gap:6px;">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--indigo-600);flex-shrink:0;"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
          <span style="font-size:12.5px;font-weight:700;color:var(--text);">Kategoriya filtri:</span>
        </div>
        <div style="flex:1;min-width:180px;max-width:280px;position:relative;">
          <select id="modalTopicCategoryFilter" onchange="filterTopicQuestionsModalCategory('${skillId}','${topicId||''}',this.value)" style="width:100%;appearance:none;-webkit-appearance:none;box-sizing:border-box;padding:7px 30px 7px 11px;border-radius:9px;border:1.5px solid var(--border);background:var(--card);color:var(--text);font-family:inherit;font-size:12.5px;font-weight:600;cursor:pointer;outline:none;">
            <option value="all" ${selectedCat==='all'?'selected':''}>Barcha kategoriyalar (${items.length} ta)</option>
            ${availableCats.map(c => `
              <option value="${c.id}" ${selectedCat===c.id?'selected':''}>${c.name} ${c.ar ? `(${c.ar})` : ''} — ${c.count} ta</option>
            `).join('')}
          </select>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--text-faint);"><path d="m6 9 6 6 6-6"/></svg>
        </div>
      </div>
    `;
  }

  const itemsHtml = filteredItems.map(({ q, originalIndex })=>{
    const isGrammarItem = skillId === 'grammatika' || q.category;
    const cat = isGrammarItem ? (GRAMMAR_CATEGORIES.find(c=>c.id===q.category) || {name: q.category || 'Nahv', ar:'النحو'}) : null;
    const catBadge = cat ? `<span style="display:inline-block;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:700;background:var(--indigo-100);color:var(--indigo-700);margin-bottom:6px;">${cat.name} (${cat.ar})</span>` : '';
    const isTarget = (originalIndex === highlightIdx);

    return `
      <div class="report-item ${isTarget ? 'target-highlight-item' : ''}" id="topicQItem_${originalIndex}" style="position:relative; ${isTarget ? 'border:2px solid var(--indigo-600);background:rgba(99,102,241,0.08);box-shadow:0 4px 16px rgba(99,102,241,0.18);' : ''}">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            ${catBadge}
            ${isTarget ? `<span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:6px;background:var(--indigo-700);color:#fff;">🎯 Qidiruvdan tanlangan savol (#${originalIndex+1})</span>` : ''}
          </div>
        </div>
        <div style="font-weight:600;font-size:14px;direction:rtl;text-align:right;margin-bottom:8px;">${originalIndex+1}. ${escapeHtml(q.q)}</div>
        <div style="display:flex;flex-direction:column;gap:5px;">
          ${q.opts.map((o,oi)=>`<div style="font-size:12.5px;font-weight:600;direction:rtl;text-align:right;color:${oi===q.a?'var(--grammatika)':'var(--text-dim)'};">${oi===q.a?'✓ ':''}${escapeHtml(o)}</div>`).join('')}
        </div>
        ${q.exp?`<div style="font-size:11.5px;color:var(--text-faint);font-weight:600;margin-top:8px;padding-top:8px;border-top:1px solid var(--border);">${escapeHtml(q.exp)}</div>`:''}
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px solid var(--border);">
          <div class="icon-btn-row">
            <button type="button" class="icon-btn ib-add" title="Yuqoriga" onclick="moveQuestion('${skillId}','${topicId||''}',${originalIndex},-1)" ${originalIndex===0?'disabled':''}>${IB_ICON_UP}</button>
            <button type="button" class="icon-btn ib-add" title="Pastga" onclick="moveQuestion('${skillId}','${topicId||''}',${originalIndex},1)" ${originalIndex===items.length-1?'disabled':''}>${IB_ICON_DOWN}</button>
            <button type="button" class="icon-btn ib-edit" title="Tahrirlash" onclick="openEditQuestionModal('${skillId}','${topicId||''}',${originalIndex})">${IB_ICON_EDIT}</button>
            <button type="button" class="icon-btn ib-del" title="O'chirish" onclick="deleteQuestion('${skillId}','${topicId||''}',${originalIndex})">${IB_ICON_DEL}</button>
          </div>
          ${!q.id?'<span style="font-size:11px;color:var(--text-faint);font-weight:600;">namunaviy (backendda emas)</span>':''}
        </div>
      </div>
    `;
  }).join('');

  document.getElementById('modalBody').innerHTML = filterBarHtml + (itemsHtml || `<div class="placeholder-card"><h3>Bu kategoriyada savol yo'q</h3><p>Boshqa kategoriya tanlang yoki barcha savollarni ko'ring.</p></div>`);
}

function openEditQuestionModal(skillId, topicId, idx){
  const items = getQuestionItems(skillId, topicId);
  const q = items?.[idx];
  if(!q) return;
  const isGrammar = skillId === 'grammatika';
  const qCat = q.category || (topicId ? GRAMMAR_TOPICS.find(t=>t.id===topicId)?.category : null) || 'nahv';

  document.getElementById('modalTitle').textContent = "Savolni tahrirlash";
  document.getElementById('modalBody').innerHTML = `
    <form id="adminQEditForm" style="display:flex;flex-direction:column;gap:14px;padding:6px 4px;" onsubmit="return submitEditQuestion(event,'${skillId}','${topicId||''}',${idx})">
      ${isGrammar ? `
      <div class="form-field">
        <label>Kategoriya (Imtihon nisbati: Nahv 15 ta, Sarf 7 ta, Imlo 4 ta, Keng tarqalgan xatolar 4 ta)</label>
        <select id="eqCategory">
          ${GRAMMAR_CATEGORIES.map(c=>{
            const countLabel = c.id==='nahv'?'15 ta': c.id==='sarf'?'7 ta': c.id==='imlo'?'4 ta':'4 ta';
            return `<option value="${c.id}" ${c.id===qCat?'selected':''}>${c.name} (${c.ar}) — imtihonda ${countLabel}</option>`;
          }).join('')}
        </select>
      </div>` : ''}
      <div class="form-field">
        <label>Savol matni (arabcha)</label>
        <textarea id="eqText" dir="rtl" required>${escapeHtml(q.q)}</textarea>
      </div>
      <div class="form-field">
        <label>Javob variantlari (to'g'risini belgilang)</label>
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${[0,1,2,3].map(i=>`
            <div class="q-opt-row">
              <input type="radio" name="eqCorrect" value="${i}" ${i===q.a?'checked':''} required>
              <input type="text" id="eqOpt${i}" value="${escapeHtml(q.opts[i]||'')}" dir="rtl" required>
            </div>
          `).join('')}
        </div>
      </div>
      <div class="form-field">
        <label>Tushuntirish (o'zbekcha, ixtiyoriy)</label>
        <textarea id="eqExp">${escapeHtml(q.exp||'')}</textarea>
      </div>
      <button type="submit" class="btn btn-primary btn-block">Saqlash</button>
      <button type="button" class="btn btn-block" onclick="viewTopicQuestions('${skillId}','${topicId||''}',${idx})">Bekor qilish</button>
    </form>
  `;
}
async function submitEditQuestion(e, skillId, topicId, idx){
  e.preventDefault();
  const items = getQuestionItems(skillId, topicId);
  const q = items?.[idx];
  if(!q) return false;
  q.q = document.getElementById('eqText').value;
  q.opts = [0,1,2,3].map(i=>document.getElementById('eqOpt'+i).value);
  q.a = Number(document.querySelector('input[name="eqCorrect"]:checked').value);
  q.exp = document.getElementById('eqExp').value;
  if(skillId === 'grammatika'){
    q.category = document.getElementById('eqCategory')?.value || q.category || 'nahv';
  }
  renderAdminQuestions();
  viewTopicQuestions(skillId, topicId, idx);
  if(q.id){
    const ok = await updateQuestionOnBackend({id:q.id, q:q.q, opts:q.opts, a:q.a, exp:q.exp});
    toast(ok ? "✅ Savol yangilandi" : "❌ Saqlanmadi: " + window.LAST_BACKEND_ERROR, ok?2200:6000);
  } else {
    toast("⚠️ Bu namunaviy savol — o'zgarish faqat shu seansda ko'rinadi (backendda saqlanmagan)");
  }
  return false;
}
async function deleteQuestion(skillId, topicId, idx){
  const items = getQuestionItems(skillId, topicId);
  const q = items?.[idx];
  if(!q) return;
  const ok = await showLiquidConfirm({
    title: "Savolni o'chirish",
    message: "Ushbu savolni rostdan ham o'chirmoqchimisiz?",
    subtext: "Bu amalni ortga qaytarib bo'lmaydi.",
    confirmLabel: "Ha, o'chirilsin",
    cancelLabel: "Bekor qilish",
    isDanger: true
  });
  if(!ok) return;
  items.splice(idx,1);
  renderAdminQuestions();
  viewTopicQuestions(skillId, topicId);
  if(q.id){
    const delOk = await deleteQuestionOnBackend(q.id);
    toast(delOk ? "✅ Savol o'chirildi" : "❌ O'chirilmadi: " + window.LAST_BACKEND_ERROR, delOk?2200:6000);
  } else {
    toast("⚠️ Bu namunaviy savol — o'chirish faqat shu seansda amal qildi (backendda saqlanmagan)");
  }
}
async function moveQuestion(skillId, topicId, idx, dir){
  const items = getQuestionItems(skillId, topicId);
  const newIdx = idx + dir;
  if(!items || newIdx<0 || newIdx>=items.length) return;
  [items[idx], items[newIdx]] = [items[newIdx], items[idx]];
  viewTopicQuestions(skillId, topicId);
  const ids = items.map(x=>x.id).filter(Boolean);
  if(ids.length === items.length){
    const ok = await reorderQuestionsOnBackend(ids);
    if(!ok) toast("⚠️ Tartib faqat shu seansda saqlandi: " + window.LAST_BACKEND_ERROR, 6000);
  } else {
    toast("⚠️ Tartib faqat shu seansda saqlandi (ro'yxatda namunaviy savollar bor)");
  }
}

/* ---- Qiroa: bir juz ichida YANGI test (matn) qo'shish ---- */
function openAddQiroaTextModal(juzId){
  const juz = QIROA_JUZ.find(j=>j.id===juzId);
  if(!juz) return;
  const n = (QIROA_TESTS[juzId]||[]).length;
  document.getElementById('modalTitle').textContent = `${juz.name} — yangi matn (Test ${n+1})`;
  document.getElementById('modalBody').innerHTML = `
    <form id="qiroaPassageForm" style="display:flex;flex-direction:column;gap:14px;padding:6px 4px;" onsubmit="return submitNewQiroaText(event,'${juzId}')">
      <p class="form-hint">Bu matn — "${juz.name}"dagi yangi, mustaqil test. Saqlagach, shu matnga tegishli 6 ta savolni "+ Savol" yoki "Ommaviy qo'shish" orqali kiritasiz — bu savollar faqat shu matn bilan birga chiqadi.</p>
      <div class="form-field">
        <label>Mavzu nomi</label>
        <input type="text" id="qiroaTitleText" placeholder="Masalan: Oilaviy hayot haqida matn" maxlength="120">
        <p class="form-hint">Imtihon paytida foydalanuvchiga uzun matn o'rniga shu nom ko'rsatiladi — bosilgandagina matnning o'zi ochiladi. Bo'sh qoldirsangiz, matn to'g'ridan-to'g'ri ko'rinadi.</p>
      </div>
      <div class="form-field">
        <label>Matn (arabcha)</label>
        <textarea id="qiroaPassageText" dir="rtl" style="min-height:160px;" placeholder="نَصّ الْقِرَاءَة..." required></textarea>
      </div>
      <button type="submit" class="btn btn-primary btn-block">Saqlash</button>
    </form>
  `;
  document.getElementById('modalOverlay').classList.add('show');
}
async function submitNewQiroaText(e, juzId){
  e.preventDefault();
  const text = document.getElementById('qiroaPassageText').value;
  const title = document.getElementById('qiroaTitleText').value.trim();
  closeModal();
  toast('⏳ Matn saqlanmoqda...');
  const saved = await addQiroaTextToBackend(juzId, text, title);
  if(!saved){ toast("⚠️ Backendga yuborilmadi: " + window.LAST_BACKEND_ERROR, 6000); return false; }
  await refreshQiroaFromBackend();
  renderAdminQuestions();
  toast("✅ Matn qo'shildi — endi shu matnga savol qo'shishingiz mumkin");
  return false;
}
/* ---- Qiroa: mavjud test matnini tahrirlash ---- */
function openEditQiroaTextModal(testId){
  const test = QIROA_TEST_BY_ID[testId];
  if(!test) return;
  const juz = QIROA_JUZ.find(j=>j.id===test.juzId);
  document.getElementById('modalTitle').textContent = `${juz?.name||''} — matnni tahrirlash`;
  document.getElementById('modalBody').innerHTML = `
    <form id="qiroaPassageForm" style="display:flex;flex-direction:column;gap:14px;padding:6px 4px;" onsubmit="return submitEditQiroaText(event,'${testId}')">
      <div class="form-field">
        <label>Mavzu nomi</label>
        <input type="text" id="qiroaTitleText" placeholder="Masalan: Oilaviy hayot haqida matn" maxlength="120" value="${escapeHtml(test.title||'')}">
        <p class="form-hint">Imtihon paytida foydalanuvchiga uzun matn o'rniga shu nom ko'rsatiladi — bosilgandagina matnning o'zi ochiladi. Bo'sh qoldirsangiz, matn to'g'ridan-to'g'ri ko'rinadi.</p>
      </div>
      <div class="form-field">
        <label>Matn (arabcha)</label>
        <textarea id="qiroaPassageText" dir="rtl" style="min-height:160px;" placeholder="نَصّ الْقِرَاءَة..." required>${escapeHtml(test.passage||'')}</textarea>
      </div>
      <button type="submit" class="btn btn-primary btn-block">Saqlash</button>
    </form>
  `;
  document.getElementById('modalOverlay').classList.add('show');
}
async function submitEditQiroaText(e, testId){
  e.preventDefault();
  const text = document.getElementById('qiroaPassageText').value;
  const title = document.getElementById('qiroaTitleText').value.trim();
  closeModal();
  toast('⏳ Saqlanmoqda...');
  const saved = await editQiroaTextOnBackend(testId, text, title);
  if(!saved){ toast("⚠️ Backendga yuborilmadi: " + window.LAST_BACKEND_ERROR, 6000); return false; }
  await refreshQiroaFromBackend();
  renderAdminQuestions();
  toast("✅ Matn yangilandi");
  return false;
}
/* ---- Qiroa: testni (matn + unga bog'liq barcha savollarni) o'chirish ---- */
async function deleteQiroaTest(testId){
  const test = QIROA_TEST_BY_ID[testId];
  if(!test) return;
  const n = test.questions.length;
  const ok = await showLiquidConfirm({
    title: "Testni o'chirish",
    message: `Bu testni (matn${n?` + ${n} ta savol`:''}) butunlay o'chirmoqchimisiz?`,
    subtext: "Bu amalni ortga qaytarib bo'lmaydi.",
    confirmLabel: "Ha, o'chirilsin",
    cancelLabel: "Bekor qilish",
    isDanger: true
  });
  if(!ok) return;
  const result = await deleteQiroaTextOnBackend(testId);
  if(result === null){ toast("⚠️ O'chirilmadi: " + window.LAST_BACKEND_ERROR, 6000); return; }
  await refreshQiroaFromBackend();
  renderAdminQuestions();
  toast("🗑 Test o'chirildi");
}

/* ---- Muhavara: savol qo'shish / tahrirlash / o'chirish (ochiq savol, variant yo'q) ----
   Bu yer — savollar BANKI: har qismga istalgancha savol qo'shish mumkin (cheklov yo'q),
   imtihonda esa shu bankdan tasodifiy MUHAVARA_MAX_Q_PER_PART tadan savol tanlanadi
   (qarang: startMuhavaraQuiz). */
function openAddSpeakingQuestionModal(presetPartId){
  const partId0 = presetPartId || MUHAVARA_PARTS[0]?.id;
  const part = MUHAVARA_PARTS.find(p=>p.id===partId0);
  if(!part) return;
  document.getElementById('modalTitle').textContent = "Yangi savol qo'shish (Muhovara)";
  document.getElementById('modalBody').innerHTML = `
    <form style="display:flex;flex-direction:column;gap:14px;padding:6px 4px;" onsubmit="return submitAddSpeakingQuestion(event)">
      <div class="form-field">
        <label>Qism</label>
        <select id="spPart" onchange="renderAddSpeakingHint(this.value)">
          ${MUHAVARA_PARTS.map(p=>`<option value="${p.id}" ${p.id===partId0?'selected':''}>${p.name}</option>`).join('')}
        </select>
      </div>
      <p class="form-hint" id="spQHint">Javob vaqti: ${part.answerSecs} soniya. Savol ochiq — variant kerak emas, AI foydalanuvchi javobini tinglab (matnga o'girib) baholaydi.</p>
      <div class="form-field">
        <label>Savol matni (arabcha)</label>
        <textarea id="spQText" dir="rtl" style="min-height:100px;" placeholder="مَاذَا تَفْعَلُ فِي وَقْتِ فَرَاغِكَ؟" required></textarea>
      </div>
      <button type="submit" class="btn btn-primary btn-block">Saqlash</button>
    </form>
  `;
  document.getElementById('modalOverlay').classList.add('show');
}
function renderAddSpeakingHint(partId){
  const part = MUHAVARA_PARTS.find(p=>p.id===partId);
  const hint = document.getElementById('spQHint');
  if(part && hint) hint.textContent = `Javob vaqti: ${part.answerSecs} soniya. Savol ochiq — variant kerak emas, AI foydalanuvchi javobini tinglab (matnga o'girib) baholaydi.`;
}
async function submitAddSpeakingQuestion(e){
  e.preventDefault();
  const partId = document.getElementById('spPart').value;
  const prompt = document.getElementById('spQText').value;
  closeModal();
  toast('⏳ Saqlanmoqda...');
  const saved = await addSpeakingQuestionToBackend(partId, prompt);
  if(!saved){ toast("⚠️ Backendga yuborilmadi: " + window.LAST_BACKEND_ERROR, 6000); return false; }
  await refreshSpeakingFromBackend();
  renderAdminQuestions();
  toast("✅ Savol qo'shildi");
  return false;
}

/* ---- Muhavara: savollarni ommaviy (bulk) qo'shish ----
   Admin bitta qismni tanlaydi, so'ng bir nechta savol matnini (har bir qatorda bittadan,
   yoki JSON massiv ko'rinishida) joylashtirib, hammasini bittada backendga yuboradi.
   Variant/to'g'ri javob kerak emas — savollar ochiq (qarang: openAddSpeakingQuestionModal). */
function openBulkAddSpeakingQuestionModal(presetPartId){
  const validSub = MUHAVARA_PARTS.some(p=>p.id===adminSubFilter) ? adminSubFilter : null;
  const partId0 = presetPartId || validSub || MUHAVARA_PARTS[0]?.id;
  document.getElementById('modalTitle').textContent = "Savollarni ommaviy qo'shish (Muhovara)";
  document.getElementById('modalBody').innerHTML = `
    <form id="adminBulkSpForm" style="display:flex;flex-direction:column;gap:14px;padding:6px 4px;" onsubmit="return submitBulkSpeakingQuestions(event)">
      <div class="form-field">
        <label>Qism</label>
        <select id="bspPart">
          ${MUHAVARA_PARTS.map(p=>`<option value="${p.id}" ${p.id===partId0?'selected':''}>${p.name}</option>`).join('')}
        </select>
      </div>
      <div class="form-field">
        <label>Savollar</label>
        <textarea id="bspText" rows="12" placeholder="Har bir savolni yangi qatorga yozing, masalan:&#10;مَاذَا تَفْعَلُ فِي وَقْتِ فَرَاغِكَ؟&#10;كَيْفَ تَقْضِي يَوْمَكَ؟&#10;&#10;Yoki JSON massiv: [&quot;...&quot;, &quot;...&quot;]" required dir="rtl" style="min-height:220px;"></textarea>
        <div style="font-size:11.5px;color:var(--text-faint);margin-top:6px;">
          Har bir qatorga bitta savol matnini yozing (bo'sh qatorlar e'tiborga olinmaydi). JSON massiv (<code>["...","..."]</code>) shaklida ham joylashtirish mumkin. Variant/to'g'ri javob kerak emas — savol ochiq, AI ovozli javobni tinglab baholaydi.
        </div>
      </div>
      <button type="submit" class="btn btn-primary btn-block">Hammasini saqlash</button>
    </form>
  `;
  document.getElementById('modalOverlay').classList.add('show');
}
async function submitBulkSpeakingQuestions(e){
  e.preventDefault();
  const partId = document.getElementById('bspPart').value;
  const raw = document.getElementById('bspText').value.trim();
  if(!raw){ toast("❌ Savollarni kiriting", 5000); return false; }

  let prompts = [];
  const trimmed = raw.trim();
  if(trimmed.startsWith('[')){
    try{
      const parsed = JSON.parse(trimmed);
      if(!Array.isArray(parsed)) throw new Error('Massiv emas');
      prompts = parsed.map(x => (typeof x === 'string' ? x : (x && x.q) || (x && x.prompt) || '').trim()).filter(Boolean);
    }catch(err){
      toast("❌ JSON noto'g'ri: " + err.message, 6000);
      return false;
    }
  } else {
    prompts = raw.split('\n').map(s=>s.trim()).filter(Boolean);
  }
  if(!prompts.length){ toast("❌ Kamida bitta savol kerak", 5000); return false; }

  closeModal();
  toast(`⏳ ${prompts.length} ta savol yuborilmoqda...`);
  const items = prompts.map(prompt => ({ partId, prompt }));
  const result = await saveSpeakingQuestionsBulkToBackend(items);
  if(!result){ toast("⚠️ Backendga yuborilmadi: " + window.LAST_BACKEND_ERROR, 6000); return false; }
  await refreshSpeakingFromBackend();
  renderAdminQuestions();
  const insertedCount = Array.isArray(result) ? result.length : (result.inserted_count ?? prompts.length);
  toast(`✅ ${insertedCount} ta savol qo'shildi`, 5000);
  return false;
}
function openEditSpeakingQuestionModal(id){
  let q = null;
  for(const p of MUHAVARA_PARTS){ const found = (MUHAVARA_QUESTIONS[p.id]||[]).find(x=>x.id===id); if(found){ q = found; break; } }
  if(!q) return;
  document.getElementById('modalTitle').textContent = "Savolni tahrirlash";
  document.getElementById('modalBody').innerHTML = `
    <form style="display:flex;flex-direction:column;gap:14px;padding:6px 4px;" onsubmit="return submitEditSpeakingQuestion(event,'${id}')">
      <div class="form-field">
        <label>Savol matni (arabcha)</label>
        <textarea id="spQEditText" dir="rtl" style="min-height:100px;" required>${escapeHtml(q.prompt)}</textarea>
      </div>
      <button type="submit" class="btn btn-primary btn-block">Saqlash</button>
    </form>
  `;
  document.getElementById('modalOverlay').classList.add('show');
}
async function submitEditSpeakingQuestion(e, id){
  e.preventDefault();
  const prompt = document.getElementById('spQEditText').value;
  closeModal();
  toast('⏳ Saqlanmoqda...');
  const saved = await editSpeakingQuestionOnBackend(id, prompt);
  if(!saved){ toast("⚠️ Backendga yuborilmadi: " + window.LAST_BACKEND_ERROR, 6000); return false; }
  await refreshSpeakingFromBackend();
  renderAdminQuestions();
  toast("✅ Yangilandi");
  return false;
}
async function deleteSpeakingQuestion(id){
  const ok = await showLiquidConfirm({
    title: "Savolni o'chirish",
    message: "Bu savolni butunlay o'chirmoqchimisiz?",
    subtext: "Bu amalni ortga qaytarib bo'lmaydi.",
    confirmLabel: "Ha, o'chirilsin",
    cancelLabel: "Bekor qilish",
    isDanger: true
  });
  if(!ok) return;
  const result = await deleteSpeakingQuestionOnBackend(id);
  if(result === null){ toast("⚠️ O'chirilmadi: " + window.LAST_BACKEND_ERROR, 6000); return; }
  await refreshSpeakingFromBackend();
  renderAdminQuestions();
  toast("🗑 Savol o'chirildi");
}

/* ---- Kitaba: har bir qism (1/2/3) uchun mavzular banki — qo'shish / tahrirlash / o'chirish ----
   Mavzular faqat arabcha kiritiladi (o'quvchi imtihonda ko'radigan matn shu). Har imtihon
   boshlanganda shu bankdan tasodifiy bitta mavzu tanlanadi — bu yerda AI ishtirok etmaydi. */
function openAddKitabaTopicModal(presetPartId){
  const partId0 = presetPartId || KITABA_PARTS[0]?.id;
  const part = KITABA_PARTS.find(p=>p.id===partId0);
  if(!part) return;
  document.getElementById('modalTitle').textContent = "Yangi mavzu qo'shish (Kitaba)";
  document.getElementById('modalBody').innerHTML = `
    <form style="display:flex;flex-direction:column;gap:14px;padding:6px 4px;" onsubmit="return submitAddKitabaTopic(event)">
      <div class="form-field">
        <label>Qism</label>
        <select id="ktPart" onchange="renderAddKitabaTopicHint(this.value)">
          ${KITABA_PARTS.map(p=>`<option value="${p.id}" ${p.id===partId0?'selected':''}>${p.name}</option>`).join('')}
        </select>
      </div>
      <p class="form-hint" id="ktTopicHint">Talab: kamida ${part.minWords} so'z, ${Math.round(part.seconds/60)} daqiqa. Imtihon boshlanganda bu qism uchun bankdagi mavzulardan tasodifiy bittasi tanlanadi.</p>
      <div class="form-field">
        <label>Mavzu matni (arabcha)</label>
        <textarea id="ktTopicText" dir="rtl" style="min-height:90px;" placeholder="اُكْتُبْ عَنْ أَهَمِّيَّةِ تَعَلُّمِ اللُّغَةِ الْعَرَبِيَّةِ" required></textarea>
      </div>
      <button type="submit" class="btn btn-primary btn-block">Saqlash</button>
    </form>
  `;
  document.getElementById('modalOverlay').classList.add('show');
}
function renderAddKitabaTopicHint(partId){
  const part = KITABA_PARTS.find(p=>p.id===partId);
  const hint = document.getElementById('ktTopicHint');
  if(part && hint) hint.textContent = `Talab: kamida ${part.minWords} so'z, ${Math.round(part.seconds/60)} daqiqa. Imtihon boshlanganda bu qism uchun bankdagi mavzulardan tasodifiy bittasi tanlanadi.`;
}
async function submitAddKitabaTopic(e){
  e.preventDefault();
  const partId = document.getElementById('ktPart').value;
  const topicAr = document.getElementById('ktTopicText').value.trim();
  if(!topicAr) return false;
  closeModal();
  toast('⏳ Saqlanmoqda...');
  const saved = await addWritingTopicToBackend(partId, topicAr);
  if(!saved){ toast("⚠️ Backendga yuborilmadi: " + window.LAST_BACKEND_ERROR, 6000); return false; }
  await refreshKitabaFromBackend();
  renderAdminQuestions();
  toast("✅ Mavzu qo'shildi");
  return false;
}
function openEditKitabaTopicModal(id){
  let t = null;
  for(const p of KITABA_PARTS){ const found = (KITABA_TOPICS[p.id]||[]).find(x=>x.id===id); if(found){ t = found; break; } }
  if(!t) return;
  document.getElementById('modalTitle').textContent = "Mavzuni tahrirlash";
  document.getElementById('modalBody').innerHTML = `
    <form style="display:flex;flex-direction:column;gap:14px;padding:6px 4px;" onsubmit="return submitEditKitabaTopic(event,'${id}')">
      <div class="form-field">
        <label>Mavzu matni (arabcha)</label>
        <textarea id="ktTopicEditText" dir="rtl" style="min-height:90px;" required>${escapeHtml(t.topicAr)}</textarea>
      </div>
      <button type="submit" class="btn btn-primary btn-block">Saqlash</button>
    </form>
  `;
  document.getElementById('modalOverlay').classList.add('show');
}
async function submitEditKitabaTopic(e, id){
  e.preventDefault();
  const topicAr = document.getElementById('ktTopicEditText').value.trim();
  if(!topicAr) return false;
  closeModal();
  toast('⏳ Saqlanmoqda...');
  const saved = await editWritingTopicOnBackend(id, topicAr);
  if(!saved){ toast("⚠️ Backendga yuborilmadi: " + window.LAST_BACKEND_ERROR, 6000); return false; }
  await refreshKitabaFromBackend();
  renderAdminQuestions();
  toast("✅ Yangilandi");
  return false;
}
async function deleteKitabaTopic(id){
  const ok = await showLiquidConfirm({
    title: "Mavzuni o'chirish",
    message: "Bu mavzuni butunlay o'chirmoqchimisiz?",
    subtext: "Bu amalni ortga qaytarib bo'lmaydi.",
    confirmLabel: "Ha, o'chirilsin",
    cancelLabel: "Bekor qilish",
    isDanger: true
  });
  if(!ok) return;
  const result = await deleteWritingTopicOnBackend(id);
  if(result === null){ toast("⚠️ O'chirilmadi: " + window.LAST_BACKEND_ERROR, 6000); return; }
  await refreshKitabaFromBackend();
  renderAdminQuestions();
  toast("🗑 Mavzu o'chirildi");
}

/* ================= Qiroa: YAXLIT "Test qo'shish" oynasi =================
   Faqat Qiroa bo'limi uchun: Juz tanlanadi → Matn kiritiladi → shu matn bo'yicha
   6 ta savol, har birida 4 ta variant to'ldiriladi → hammasi BITTA amal bilan
   (avval matn, so'ng 6 savol bulk) backendga yuboriladi. Boshqa bo'limlarga
   (Grammatika, Istima, Muhavara, Kitaba) bu funksiya umuman ta'sir qilmaydi —
   ular eski openAddQuestionModal() / openBulkAddQuestionModal() orqali ishlaydi. */
function openAddQiroaFullTestModal(presetJuzId){
  const juzId0 = presetJuzId || QIROA_JUZ[0]?.id || '';
  document.getElementById('modalTitle').textContent = "Yangi test qo'shish (Qiroa)";
  const questionBlocks = Array.from({length:QIROA_MAX_Q_PER_TEST}).map((_,i)=>`
    <div class="card" style="padding:14px;border-color:var(--qiroa);">
      <div style="font-weight:600;font-size:13px;color:var(--qiroa);margin-bottom:10px;">${i+1}-savol</div>
      <div class="form-field">
        <label>Savol matni (arabcha)</label>
        <textarea id="qtQ${i}" dir="rtl" placeholder="أَيْنَ ذَهَبَ..." required></textarea>
      </div>
      <div class="form-field">
        <label>Javob variantlari (to'g'risini belgilang)</label>
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${[0,1,2,3].map(k=>`
            <div class="q-opt-row">
              <input type="radio" name="qtCorrect${i}" value="${k}" ${k===0?'checked':''} required>
              <input type="text" id="qtOpt${i}_${k}" placeholder="Variant ${k+1}" dir="rtl" required>
            </div>
          `).join('')}
        </div>
      </div>
      <div class="form-field">
        <label>Tushuntirish (o'zbekcha, ixtiyoriy)</label>
        <textarea id="qtExp${i}" placeholder="Nima uchun bu javob to'g'ri..."></textarea>
      </div>
    </div>
  `).join('');
  document.getElementById('modalBody').innerHTML = `
    <form id="qiroaFullTestForm" style="display:flex;flex-direction:column;gap:14px;padding:6px 4px;" onsubmit="return submitQiroaFullTest(event)">
      <p class="form-hint">Avval juzni tanlang, matnni kiriting, so'ng shu matn bo'yicha 6 ta savolni to'ldiring. "Saqlash" bosilganda matn va barcha 6 ta savol birgalikda (bitta test sifatida) qo'shiladi.</p>
      <div class="form-field">
        <label>Juz</label>
        <select id="qtJuz">
          ${QIROA_JUZ.map(j=>`<option value="${j.id}" ${j.id===juzId0?'selected':''}>${j.name}</option>`).join('')}
        </select>
      </div>
      <div class="form-field">
        <label>Matn (arabcha)</label>
        <textarea id="qtPassage" dir="rtl" style="min-height:150px;" placeholder="نَصّ الْقِرَاءَة..." required></textarea>
      </div>
      <div style="display:flex;flex-direction:column;gap:12px;">
        ${questionBlocks}
      </div>
      <button type="submit" class="btn btn-primary btn-block">Testni saqlash (matn + 6 savol)</button>
    </form>
  `;
  document.getElementById('modalOverlay').classList.add('show');
}
async function submitQiroaFullTest(e){
  e.preventDefault();
  const juzId = document.getElementById('qtJuz').value;
  const passage = document.getElementById('qtPassage').value;
  if(!passage.trim()){
    toast("❌ Matnni kiriting");
    return false;
  }
  const questions = [];
  for(let i=0;i<QIROA_MAX_Q_PER_TEST;i++){
    const qText = document.getElementById(`qtQ${i}`)?.value || '';
    const opts = [0,1,2,3].map(k=>document.getElementById(`qtOpt${i}_${k}`)?.value || '');
    const correctEl = document.querySelector(`input[name="qtCorrect${i}"]:checked`);
    const exp = document.getElementById(`qtExp${i}`)?.value || '';
    if(!qText.trim() || opts.some(o=>!o.trim()) || !correctEl){
      toast(`❌ ${i+1}-savolni (matn va barcha 4 variantni) to'liq to'ldiring`, 6000);
      return false;
    }
    questions.push({ q:qText, opts, a:Number(correctEl.value), exp });
  }
  closeModal();
  toast('⏳ Matn saqlanmoqda...');
  const savedText = await addQiroaTextToBackend(juzId, passage);
  if(!savedText){ toast("⚠️ Matn saqlanmadi: " + window.LAST_BACKEND_ERROR, 6000); return false; }
  const testId = Array.isArray(savedText) ? savedText[0]?.id : savedText?.id;
  if(!testId){ toast("⚠️ Yangi matn id'si backenddan qaytmadi", 6000); return false; }

  toast('⏳ 6 ta savol yuborilmoqda...');
  const items = questions.map(row => ({
    skillId:'qiroa', topicId:testId,
    q:row.q, opts:row.opts, a:row.a, exp:row.exp,
  }));
  const result = await saveQuestionsBulkWithTopicsToBackend(items);
  await refreshQiroaFromBackend();
  adminActiveSkill = 'qiroa';
  renderAdminQuestions();
  if(result){
    const insertedCount = result.inserted_count ?? questions.length;
    toast(`✅ Yangi test qo'shildi — matn + ${insertedCount} ta savol`, 6000);
  } else {
    toast("⚠️ Matn saqlandi, lekin savollar yuborilmadi: " + window.LAST_BACKEND_ERROR + " — testga savollarni \"+ Savol\" tugmasi orqali qo'shishingiz mumkin", 8000);
  }
  return false;
}

/* ---- Qiroa: BIR NECHTA to'liq testni (har biri: juz + matn + 6 savol) bittada,
   JSON massiv orqali qo'shish. Har bir test o'z alohida matnini yaratadi va
   o'ziga tegishli savollarni o'sha matnga bog'lab yuboradi. Faqat Qiroa bo'limiga
   tegishli — boshqa bo'limlarning bulk qo'shish oynasiga (openBulkAddQuestionModal)
   hech qanday ta'sir qilmaydi. */
function openBulkAddQiroaTestsModal(){
  document.getElementById('modalTitle').textContent = "Bir nechta test qo'shish (Qiroa, JSON)";
  document.getElementById('modalBody').innerHTML = `
    <form id="bulkQiroaTestForm" style="display:flex;flex-direction:column;gap:14px;padding:6px 4px;" onsubmit="return submitBulkQiroaTests(event)">
      <p class="form-hint">Bir nechta TO'LIQ testni (har biri: juz + matn + savollar) bitta JSON massiv orqali kiriting. Har bir test o'ziga alohida matn yaratadi va shu matnga tegishli savollarni bog'laydi.</p>
      <div class="form-field">
        <label>Testlar (JSON massiv)</label>
        <textarea id="bqtJson" rows="18" required style="font-family:monospace;font-size:12px;direction:ltr;" placeholder='[
  {
    "juz": "juz1",
    "passage": "نَصّ الْقِرَاءَة...",
    "questions": [
      {"q":"...","opts":["...","...","...","..."],"a":0,"exp":"ixtiyoriy"},
      {"q":"...","opts":["...","...","...","..."],"a":1},
      {"q":"...","opts":["...","...","...","..."],"a":2},
      {"q":"...","opts":["...","...","...","..."],"a":3},
      {"q":"...","opts":["...","...","...","..."],"a":0},
      {"q":"...","opts":["...","...","...","..."],"a":1}
    ]
  },
  { "juz": "juz2", "passage": "...", "questions": [ "... yana 6 ta savol ..." ] }
]'></textarea>
        <div style="font-size:11.5px;color:var(--text-faint);margin-top:6px;">
          <b>juz</b> — ${QIROA_JUZ.map(j=>`<code>${j.id}</code> (${j.name})`).join(', ')} dan biri.<br>
          <b>passage</b> — shu testning matni (arabcha).<br>
          <b>questions</b> — bitta testda ko'pi bilan ${QIROA_MAX_Q_PER_TEST} ta savol; har biri <b>q</b> (savol), <b>opts</b> (4 ta variant), <b>a</b> (to'g'ri variant indeksi, 0-3), <b>exp</b> (izoh, ixtiyoriy).<br>
          Massivda nechta test bo'lsa — shuncha yangi matn va ularga tegishli savollar birdaniga yaratiladi.
        </div>
      </div>
      <button type="submit" class="btn btn-primary btn-block">Barcha testlarni saqlash</button>
    </form>
  `;
  document.getElementById('modalOverlay').classList.add('show');
}
async function submitBulkQiroaTests(e){
  e.preventDefault();
  let parsed;
  try{
    parsed = JSON.parse(document.getElementById('bqtJson').value);
    if(!Array.isArray(parsed) || !parsed.length) throw new Error("Bo'sh yoki massiv emas");
  }catch(err){
    toast("❌ JSON noto'g'ri: " + err.message, 6000);
    return false;
  }
  for(const [i, t] of parsed.entries()){
    if(!t.juz || !QIROA_JUZ.some(j=>j.id===t.juz)){
      toast(`❌ ${i+1}-testda "juz" noto'g'ri — ${QIROA_JUZ.map(j=>j.id).join('/')} dan biri bo'lishi kerak`, 7000);
      return false;
    }
    if(!t.passage || !String(t.passage).trim()){
      toast(`❌ ${i+1}-testda "passage" (matn) kiritilmagan`, 6000);
      return false;
    }
    if(!Array.isArray(t.questions) || !t.questions.length || t.questions.length > QIROA_MAX_Q_PER_TEST){
      toast(`❌ ${i+1}-testda savollar soni noto'g'ri (1-${QIROA_MAX_Q_PER_TEST} ta bo'lishi kerak)`, 7000);
      return false;
    }
    for(const [qi, row] of t.questions.entries()){
      if(!row.q || !Array.isArray(row.opts) || row.opts.length !== 4 || typeof row.a !== 'number'){
        toast(`❌ ${i+1}-test, ${qi+1}-savol formati noto'g'ri (q, opts[4], a talab qilinadi)`, 7000);
        return false;
      }
    }
  }

  closeModal();
  toast(`⏳ ${parsed.length} ta test (matn) yaratilmoqda...`);
  const allItems = [];
  let failedTexts = 0;
  for(const [i, t] of parsed.entries()){
    const savedText = await addQiroaTextToBackend(t.juz, t.passage);
    if(!savedText){
      failedTexts++;
      toast(`⚠️ ${i+1}-test matni saqlanmadi: ` + window.LAST_BACKEND_ERROR, 7000);
      continue;
    }
    const testId = Array.isArray(savedText) ? savedText[0]?.id : savedText?.id;
    if(!testId){ failedTexts++; continue; }
    t.questions.forEach(row=>{
      allItems.push({ skillId:'qiroa', topicId:testId, q:row.q, opts:row.opts, a:row.a, exp:row.exp||'' });
    });
  }

  if(!allItems.length){
    await refreshQiroaFromBackend();
    adminActiveSkill = 'qiroa';
    renderAdminQuestions();
    toast('⚠️ Hech qanday savol yuborilmadi', 6000);
    return false;
  }

  toast(`⏳ ${allItems.length} ta savol yuborilmoqda...`);
  const result = await saveQuestionsBulkWithTopicsToBackend(allItems);
  await refreshQiroaFromBackend();
  adminActiveSkill = 'qiroa';
  renderAdminQuestions();
  if(result){
    const insertedCount = result.inserted_count ?? allItems.length;
    const okTests = parsed.length - failedTexts;
    let msg = `✅ ${okTests} ta test qo'shildi (${insertedCount} ta savol)`;
    if(failedTexts>0) msg += ` — ${failedTexts} ta test matni saqlanmadi`;
    toast(msg, 8000);
  } else {
    toast("⚠️ Matn(lar) saqlandi, lekin savollar yuborilmadi: " + window.LAST_BACKEND_ERROR, 8000);
  }
  return false;
}

/* ================= Istima: tahrirlash / o'chirish ================= */
function openEditIstimaAudioModal(testId){
  const test = ISTIMA_TEST_BY_ID[testId];
  if(!test) return;
  const juz = ISTIMA_JUZ.find(j=>j.id===test.juzId);
  document.getElementById('modalTitle').textContent = `${juz?.name||''} — audio URL'ni tahrirlash`;
  document.getElementById('modalBody').innerHTML = `
    <form id="istimaAudioForm" style="display:flex;flex-direction:column;gap:14px;padding:6px 4px;" onsubmit="return submitEditIstimaAudio(event,'${testId}')">
      <div class="form-field">
        <label>Audio fayl URL manzili</label>
        <input type="url" id="istimaAudioUrlInput" placeholder="https://...supabase.co/storage/v1/object/public/istima/....mp3" value="${escapeHtml(test.audioUrl||'')}" required>
        <div style="font-size:11.5px;color:var(--text-faint);margin-top:6px;">Supabase Storage'dagi ochiq (public) audio faylining to'g'ridan-to'g'ri havolasi.</div>
      </div>
      <button type="submit" class="btn btn-primary btn-block">Saqlash</button>
    </form>
  `;
  document.getElementById('modalOverlay').classList.add('show');
}
async function submitEditIstimaAudio(e, testId){
  e.preventDefault();
  const url = document.getElementById('istimaAudioUrlInput').value.trim();
  if(!url){ toast('❌ Audio URL kiritilmagan'); return false; }
  closeModal();
  toast('⏳ Saqlanmoqda...');
  const saved = await editIstimaAudioOnBackend(testId, url);
  if(!saved){ toast("⚠️ Backendga yuborilmadi: " + window.LAST_BACKEND_ERROR, 6000); return false; }
  await refreshIstimaFromBackend();
  renderAdminQuestions();
  toast("✅ Audio URL yangilandi");
  return false;
}
async function deleteIstimaTest(testId){
  const test = ISTIMA_TEST_BY_ID[testId];
  if(!test) return;
  const n = test.questions.length;
  const ok = await showLiquidConfirm({
    title: "Testni o'chirish",
    message: `Bu testni (audio${n?` + ${n} ta savol`:''}) butunlay o'chirmoqchimisiz?`,
    subtext: "Bu amalni ortga qaytarib bo'lmaydi.",
    confirmLabel: "Ha, o'chirilsin",
    cancelLabel: "Bekor qilish",
    isDanger: true
  });
  if(!ok) return;
  const result = await deleteIstimaAudioOnBackend(testId);
  if(result === null){ toast("⚠️ O'chirilmadi: " + window.LAST_BACKEND_ERROR, 6000); return; }
  await refreshIstimaFromBackend();
  renderAdminQuestions();
  toast("🗑 Test o'chirildi");
}

/* ================= Istima: YAXLIT "Test qo'shish" oynasi =================
   Qiroa'dagi bilan bir xil g'oya: Qism (juz) tanlanadi → Audio URL kiritiladi → shu audioga
   tegishli savollar (1-qismda 1 ta, 2/3-qismda 6 ta), har birida 4 ta variant to'ldiriladi →
   hammasi BITTA amal bilan (avval audio, so'ng savollar bulk) backendga yuboriladi. */
function istimaQCountFor(juzId){
  return (ISTIMA_JUZ.find(j=>j.id===juzId) || ISTIMA_JUZ[0]).qCount;
}
function openAddIstimaFullTestModal(presetJuzId){
  const juzId0 = presetJuzId || ISTIMA_JUZ[0]?.id || '';
  renderAddIstimaFullTestForm(juzId0);
  document.getElementById('modalOverlay').classList.add('show');
}
function renderAddIstimaFullTestForm(juzId){
  const qCount = istimaQCountFor(juzId);
  document.getElementById('modalTitle').textContent = "Yangi test qo'shish (Istima)";
  const questionBlocks = Array.from({length:qCount}).map((_,i)=>`
    <div class="card" style="padding:14px;border-color:var(--istima);">
      <div style="font-weight:600;font-size:13px;color:var(--istima);margin-bottom:10px;">${i+1}-savol</div>
      <div class="form-field">
        <label>Savol matni (arabcha)</label>
        <textarea id="itQ${i}" dir="rtl" placeholder="مَاذَا سَمِعْتَ..." required></textarea>
      </div>
      <div class="form-field">
        <label>Javob variantlari (to'g'risini belgilang)</label>
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${[0,1,2,3].map(k=>`
            <div class="q-opt-row">
              <input type="radio" name="itCorrect${i}" value="${k}" ${k===0?'checked':''} required>
              <input type="text" id="itOpt${i}_${k}" placeholder="Variant ${k+1}" dir="rtl" required>
            </div>
          `).join('')}
        </div>
      </div>
      <div class="form-field">
        <label>Tushuntirish (o'zbekcha, ixtiyoriy)</label>
        <textarea id="itExp${i}" placeholder="Nima uchun bu javob to'g'ri..."></textarea>
      </div>
    </div>
  `).join('');
  document.getElementById('modalBody').innerHTML = `
    <form id="istimaFullTestForm" style="display:flex;flex-direction:column;gap:14px;padding:6px 4px;" onsubmit="return submitIstimaFullTest(event)">
      <p class="form-hint">Avval qismni tanlang, audio URL manzilini kiriting, so'ng shu audio bo'yicha ${qCount} ta savolni to'ldiring. "Saqlash" bosilganda audio va barcha savollar birgalikda (bitta test sifatida) qo'shiladi.</p>
      <div class="form-field">
        <label>Qism</label>
        <select id="itJuz" onchange="renderAddIstimaFullTestForm(this.value)">
          ${ISTIMA_JUZ.map(j=>`<option value="${j.id}" ${j.id===juzId?'selected':''}>${j.name} (${j.qCount} ta savol)</option>`).join('')}
        </select>
      </div>
      <div class="form-field">
        <label>Audio fayl URL manzili</label>
        <input type="url" id="itAudioUrl" placeholder="https://...supabase.co/storage/v1/object/public/istima/....mp3" required>
        <div style="font-size:11.5px;color:var(--text-faint);margin-top:6px;">Supabase Storage'ga yuklangan ochiq (public) audio faylining to'g'ridan-to'g'ri havolasi.</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:12px;">
        ${questionBlocks}
      </div>
      <button type="submit" class="btn btn-primary btn-block">Testni saqlash (audio + ${qCount} ta savol)</button>
    </form>
  `;
}
async function submitIstimaFullTest(e){
  e.preventDefault();
  const juzId = document.getElementById('itJuz').value;
  const audioUrl = document.getElementById('itAudioUrl').value.trim();
  const qCount = istimaQCountFor(juzId);
  if(!audioUrl){
    toast("❌ Audio URL manzilini kiriting");
    return false;
  }
  const questions = [];
  for(let i=0;i<qCount;i++){
    const qText = document.getElementById(`itQ${i}`)?.value || '';
    const opts = [0,1,2,3].map(k=>document.getElementById(`itOpt${i}_${k}`)?.value || '');
    const correctEl = document.querySelector(`input[name="itCorrect${i}"]:checked`);
    const exp = document.getElementById(`itExp${i}`)?.value || '';
    if(!qText.trim() || opts.some(o=>!o.trim()) || !correctEl){
      toast(`❌ ${i+1}-savolni (matn va barcha 4 variantni) to'liq to'ldiring`, 6000);
      return false;
    }
    questions.push({ q:qText, opts, a:Number(correctEl.value), exp });
  }
  closeModal();
  toast('⏳ Audio saqlanmoqda...');
  const savedAudio = await addIstimaAudioToBackend(juzId, audioUrl);
  if(!savedAudio){ toast("⚠️ Audio saqlanmadi: " + window.LAST_BACKEND_ERROR, 6000); return false; }
  const testId = Array.isArray(savedAudio) ? savedAudio[0]?.id : savedAudio?.id;
  if(!testId){ toast("⚠️ Yangi audio id'si backenddan qaytmadi", 6000); return false; }

  toast(`⏳ ${qCount} ta savol yuborilmoqda...`);
  const items = questions.map(row => ({
    skillId:'istima', topicId:testId,
    q:row.q, opts:row.opts, a:row.a, exp:row.exp,
  }));
  const result = await saveQuestionsBulkWithTopicsToBackend(items);
  await refreshIstimaFromBackend();
  adminActiveSkill = 'istima';
  renderAdminQuestions();
  if(result){
    const insertedCount = result.inserted_count ?? questions.length;
    toast(`✅ Yangi test qo'shildi — audio + ${insertedCount} ta savol`, 6000);
  } else {
    toast("⚠️ Audio saqlandi, lekin savollar yuborilmadi: " + window.LAST_BACKEND_ERROR + " — testga savollarni \"+ Savol\" tugmasi orqali qo'shishingiz mumkin", 8000);
  }
  return false;
}

/* ---- Istima: BIR NECHTA to'liq testni (har biri: qism + audio + savollar) bittada,
   JSON massiv orqali qo'shish. */
function openBulkAddIstimaTestsModal(){
  document.getElementById('modalTitle').textContent = "Bir nechta test qo'shish (Istima, JSON)";
  document.getElementById('modalBody').innerHTML = `
    <form id="bulkIstimaTestForm" style="display:flex;flex-direction:column;gap:14px;padding:6px 4px;" onsubmit="return submitBulkIstimaTests(event)">
      <p class="form-hint">Bir nechta TO'LIQ testni (har biri: qism + audio URL + savollar) bitta JSON massiv orqali kiriting.</p>
      <div class="form-field">
        <label>Testlar (JSON massiv)</label>
        <textarea id="bitJson" rows="18" required style="font-family:monospace;font-size:12px;direction:ltr;" placeholder='[
  {
    "juz": "juz1",
    "audioUrl": "https://.../audio1.mp3",
    "questions": [
      {"q":"...","opts":["...","...","...","..."],"a":0,"exp":"ixtiyoriy"}
    ]
  },
  {
    "juz": "juz2",
    "audioUrl": "https://.../audio2.mp3",
    "questions": [ "... 6 ta savol ..." ]
  }
]'></textarea>
        <div style="font-size:11.5px;color:var(--text-faint);margin-top:6px;">
          <b>juz</b> — ${ISTIMA_JUZ.map(j=>`<code>${j.id}</code> (${j.name}, ${j.qCount} ta savol)`).join(', ')}.<br>
          <b>audioUrl</b> — shu testning audio fayl havolasi.<br>
          <b>questions</b> — har biri <b>q</b> (savol), <b>opts</b> (4 ta variant), <b>a</b> (to'g'ri variant indeksi, 0-3), <b>exp</b> (izoh, ixtiyoriy). Savollar soni tanlangan qismga mos bo'lishi kerak (1-qism: 1 ta, 2/3-qism: 6 ta).
        </div>
      </div>
      <button type="submit" class="btn btn-primary btn-block">Barcha testlarni saqlash</button>
    </form>
  `;
  document.getElementById('modalOverlay').classList.add('show');
}
async function submitBulkIstimaTests(e){
  e.preventDefault();
  let parsed;
  try{
    parsed = JSON.parse(document.getElementById('bitJson').value);
    if(!Array.isArray(parsed) || !parsed.length) throw new Error("Bo'sh yoki massiv emas");
  }catch(err){
    toast("❌ JSON noto'g'ri: " + err.message, 6000);
    return false;
  }
  for(const [i, t] of parsed.entries()){
    const juzMeta = ISTIMA_JUZ.find(j=>j.id===t.juz);
    if(!juzMeta){
      toast(`❌ ${i+1}-testda "juz" noto'g'ri — ${ISTIMA_JUZ.map(j=>j.id).join('/')} dan biri bo'lishi kerak`, 7000);
      return false;
    }
    if(!t.audioUrl || !String(t.audioUrl).trim()){
      toast(`❌ ${i+1}-testda "audioUrl" kiritilmagan`, 6000);
      return false;
    }
    if(!Array.isArray(t.questions) || t.questions.length !== juzMeta.qCount){
      toast(`❌ ${i+1}-testda savollar soni noto'g'ri (${juzMeta.name} uchun ${juzMeta.qCount} ta bo'lishi kerak)`, 7000);
      return false;
    }
    for(const [qi, row] of t.questions.entries()){
      if(!row.q || !Array.isArray(row.opts) || row.opts.length !== 4 || typeof row.a !== 'number'){
        toast(`❌ ${i+1}-test, ${qi+1}-savol formati noto'g'ri (q, opts[4], a talab qilinadi)`, 7000);
        return false;
      }
    }
  }

  closeModal();
  toast(`⏳ ${parsed.length} ta test (audio) yaratilmoqda...`);
  const allItems = [];
  let failedAudios = 0;
  for(const [i, t] of parsed.entries()){
    const savedAudio = await addIstimaAudioToBackend(t.juz, t.audioUrl);
    if(!savedAudio){
      failedAudios++;
      toast(`⚠️ ${i+1}-test audiosi saqlanmadi: ` + window.LAST_BACKEND_ERROR, 7000);
      continue;
    }
    const testId = Array.isArray(savedAudio) ? savedAudio[0]?.id : savedAudio?.id;
    if(!testId){ failedAudios++; continue; }
    t.questions.forEach(row=>{
      allItems.push({ skillId:'istima', topicId:testId, q:row.q, opts:row.opts, a:row.a, exp:row.exp||'' });
    });
  }

  if(!allItems.length){
    await refreshIstimaFromBackend();
    adminActiveSkill = 'istima';
    renderAdminQuestions();
    toast('⚠️ Hech qanday savol yuborilmadi', 6000);
    return false;
  }

  toast(`⏳ ${allItems.length} ta savol yuborilmoqda...`);
  const result = await saveQuestionsBulkWithTopicsToBackend(allItems);
  await refreshIstimaFromBackend();
  adminActiveSkill = 'istima';
  renderAdminQuestions();
  if(result){
    const insertedCount = result.inserted_count ?? allItems.length;
    const okTests = parsed.length - failedAudios;
    let msg = `✅ ${okTests} ta test qo'shildi (${insertedCount} ta savol)`;
    if(failedAudios>0) msg += ` — ${failedAudios} ta test audiosi saqlanmadi`;
    toast(msg, 8000);
  } else {
    toast("⚠️ Audio(lar) saqlandi, lekin savollar yuborilmadi: " + window.LAST_BACKEND_ERROR, 8000);
  }
  return false;
}

/* ================= MOCKLAR BOSHQARUVI (ADMIN & O'QUVCHI) ================= */
let adminActiveMockSkill = 'all';

function getMockResultsMap(){
  try {
    const raw = localStorage.getItem('arab_app_mock_results');
    return raw ? JSON.parse(raw) : {};
  } catch(e){
    return {};
  }
}

function getMockResult(mockId){
  const map = getMockResultsMap();
  return map[mockId] || null;
}

function recordMockResult(mockId, correct, total, wrong){
  if(!mockId) return;
  try {
    const map = getMockResultsMap();
    map[mockId] = {
      correct: Number(correct) || 0,
      total: Number(total) || 0,
      wrong: Number(wrong) || 0,
      pct: total ? Math.round((correct / total) * 100) : 0,
      completedAt: new Date().toISOString(),
      attempts: ((map[mockId] && map[mockId].attempts) || 0) + 1
    };
    localStorage.setItem('arab_app_mock_results', JSON.stringify(map));
  } catch(e){
    console.error("Failed to record mock result", e);
  }
}

function loadMocksData(){
  try {
    const raw = localStorage.getItem('arab_app_mocks_data');
    if(raw){
      const parsed = JSON.parse(raw);
      if(Array.isArray(parsed)){
        return parsed.map(m => ({
          ...m,
          title: (m.title || '').replace(/Mock\s*#\s*(\d+)/gi, 'Mock $1')
        }));
      }
    }
  } catch(e){
    console.error("Mocks data load error:", e);
  }
  return [];
}

let MOCKS_DATA = loadMocksData();

/* ---------- Mocklar: BACKEND (Supabase) bilan sinxronizatsiya ----------
   EGRESS OPTIMIZATSIYASI: 15 daqiqa SmartCache bilan keshlanadi. */
async function loadMocksFromBackend(forceRefresh = false){
  if(!forceRefresh){
    const cached = SmartCache.get('mocks');
    if(cached) return cached;
  }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/mocks?select=id,skill,title,duration_mins,questions,created_at&order=created_at.asc`, { headers: authHeaders() });
    if(!res.ok){ setLastBackendError(res.status, await res.text()); return null; }
    const rows = await res.json();
    const data = rows.map(r => ({
      id: r.id,
      skill: r.skill,
      title: r.title,
      durationMins: r.duration_mins,
      questions: r.questions || [],
      createdAt: r.created_at,
    }));
    if(Array.isArray(data)){
      SmartCache.set('mocks', data);
    }
    return data;
  }catch(e){ console.error("Mocks backend load error:", e); return null; }
}

function applyLiveMocks(list){
  if(Array.isArray(list)){
    MOCKS_DATA = list.map(m => ({
      ...m,
      title: (m.title || '').replace(/Mock\s*#\s*(\d+)/gi, 'Mock $1')
    }));
    try{ localStorage.setItem('arab_app_mocks_data', JSON.stringify(MOCKS_DATA)); }catch(e){}
  }
  renderAdminMocks();
  renderSkillMockPanes();
}

/* Bitta mockni (sarlavha/vaqt/savollar) backendga to'liq holatda yozib qo'yadi
   (insert yoki update — admin_upsert_mock RPC "ON CONFLICT (id) DO UPDATE"
   qiladi). Faqat admin sessiyasida ishlaydi. */
async function persistMockToBackend(mock){
  if(!mock) return;
  if(!SESSION_TOKEN){ setLastBackendError('—', 'SESSION_TOKEN yo\'q (Telegram orqali kirilmagan)'); toast("⚠️ Backendga saqlanmadi: sessiya topilmadi", 5000); return; }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_upsert_mock`, {
      method:"POST", headers: authHeaders(),
      body: JSON.stringify({
        p_id: mock.id,
        p_skill: mock.skill,
        p_title: mock.title,
        p_duration_mins: mock.durationMins || 30,
        p_questions: mock.questions || [],
      })
    });
    if(!res.ok){
      setLastBackendError(res.status, await res.text());
      toast("⚠️ Mock backendga saqlanmadi: " + window.LAST_BACKEND_ERROR, 6000);
    } else {
      SmartCache.invalidate('mocks');
    }
  }catch(e){
    setLastBackendError('—', e.message);
    toast("⚠️ Tarmoq xatosi: mock backendga saqlanmadi", 5000);
  }
}

async function deleteMockFromBackend(mockId){
  if(!SESSION_TOKEN){ setLastBackendError('—', 'SESSION_TOKEN yo\'q (Telegram orqali kirilmagan)'); toast("⚠️ Backenddan o'chirilmadi: sessiya topilmadi", 5000); return; }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_delete_mock`, {
      method:"POST", headers: authHeaders(),
      body: JSON.stringify({ p_id: mockId })
    });
    if(!res.ok){
      setLastBackendError(res.status, await res.text());
      toast("⚠️ Mock backenddan o'chirilmadi: " + window.LAST_BACKEND_ERROR, 6000);
    } else {
      SmartCache.invalidate('mocks');
    }
  }catch(e){
    setLastBackendError('—', e.message);
    toast("⚠️ Tarmoq xatosi: mock backenddan o'chirilmadi", 5000);
  }
}

/* mockId berilsa — o'sha mock darhol backendga ham yoziladi (admin CRUD
   amallaridan keyin chaqiriladi). mockId berilmasa — faqat local keshni
   (localStorage) va UI'ni yangilaydi (masalan o'chirishdan keyin, chunki
   o'chirish alohida deleteMockFromBackend() orqali bajariladi). */
function saveMocksData(mockId){
  try {
    localStorage.setItem('arab_app_mocks_data', JSON.stringify(MOCKS_DATA));
  } catch(e){
    console.error("Mocks data save error:", e);
  }
  renderAdminMocks();
  renderSkillMockPanes();
  if(mockId){
    const mock = MOCKS_DATA.find(m => m.id === mockId);
    if(mock) persistMockToBackend(mock);
  }
}

function nextMockNumberForSkill(skillId){
  const skillMocks = MOCKS_DATA.filter(m => m.skill === skillId);
  return skillMocks.length + 1;
}

function renderAdminMockSkillFilters(){
  const mockSkills = [
    { value: 'all', label: 'Barchasi' },
    ...SKILLS.filter(s => s.id !== 'muhavara' && s.id !== 'kitaba').map(s => ({ value: s.id, label: s.name }))
  ];
  initCustomDropdown('adminMockSkillDropdown', {
    label: 'Mahorat',
    options: mockSkills,
    value: adminActiveMockSkill,
    onChange: (val) => {
      adminActiveMockSkill = val;
      renderAdminMocks();
    }
  });
}

function renderAdminMocks(){
  renderAdminMockSkillFilters();
  const list = document.getElementById('adminMocksList');
  const countEl = document.getElementById('adminMocksCount');
  if(!list) return;

  const filteredMocks = adminActiveMockSkill === 'all'
    ? MOCKS_DATA
    : MOCKS_DATA.filter(m => m.skill === adminActiveMockSkill);

  if(countEl){
    countEl.textContent = `${filteredMocks.length} ta mock`;
  }

  if(filteredMocks.length === 0){
    list.innerHTML = `
      <div class="placeholder-card" style="padding:28px 16px;">
        <div style="font-size:32px;margin-bottom:8px;">📝</div>
        <h3 style="margin-bottom:4px;">Hozircha mock testlar yo'q</h3>
        <p style="margin-bottom:14px;color:var(--text-faint);font-size:13px;">"${adminActiveMockSkill === 'all' ? 'Barcha mahoratlar' : (SKILL_META[adminActiveMockSkill]?.name || adminActiveMockSkill)}" bo'yicha yangi mock yaratish uchun yuqoridagi tugmani bosing.</p>
        <button class="btn btn-primary" onclick="openAddMockModal('${adminActiveMockSkill === 'all' ? 'grammatika' : adminActiveMockSkill}')">+ Yangi mock yaratish</button>
      </div>
    `;
    return;
  }

  list.innerHTML = filteredMocks.map(m => {
    const skillMeta = SKILL_META[m.skill] || { name: m.skill, color: 'var(--indigo-600)', bg: 'var(--indigo-100)' };
    const qCount = (m.questions || []).length;
    const isComplete = qCount >= 30;
    const statusBadge = isComplete 
      ? `<span class="badge-status badge-elite" style="font-size:11px;">30/30 savol (To'liq) ✅</span>`
      : `<span class="badge-status badge-good" style="font-size:11px;">${qCount}/30 savol</span>`;

    const menu = rowMenuBtn([
      { icon: IB_ICON_VIEW, label: "Ko'rish / Savollar", run: () => viewMockQuestions(m.id) },
      { icon: IB_ICON_ADD, label: "+ Savol qo'shish", disabled: qCount >= 30, run: () => openAddMockQuestionModal(m.id) },
      { icon: AS_ICON_PLUS || IB_ICON_ADD, label: "Ommaviy savol qo'shish (JSON)", disabled: qCount >= 30, run: () => openBulkAddMockQuestionModal(m.id) },
      { icon: IB_ICON_EDIT, label: "Mock nomini tahrirlash", run: () => openEditMockModal(m.id) },
      { icon: IB_ICON_DEL, label: "O'chirish", danger: true, run: () => deleteMock(m.id) },
    ], m.title);

    return `
      <div class="topic-row" style="align-items:center;padding:14px 12px;border-bottom:1px solid var(--border);">
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap;">
            <span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:99px;background:${skillMeta.bg};color:${skillMeta.color};">${skillMeta.name}</span>
            <div class="t-name" style="font-size:14.5px;font-weight:700;">${escapeHtml(m.title)}</div>
            ${statusBadge}
          </div>
          <div class="t-meta" style="font-size:12px;color:var(--text-faint);">
            30 ta savol · ${m.durationMins || 30} daqiqa · ${qCount} ta mavjud savol
          </div>
        </div>
        <div class="t-actions">
          <button class="row-btn" onclick="viewMockQuestions('${m.id}')" style="display:inline-flex;align-items:center;gap:5px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
            Savollar (${qCount})
          </button>
          ${menu}
        </div>
      </div>
    `;
  }).join('');
}

function openAddMockModal(presetSkill){
  const skill = presetSkill && presetSkill !== 'all' ? presetSkill : (adminActiveMockSkill !== 'all' ? adminActiveMockSkill : 'grammatika');
  const nextNum = nextMockNumberForSkill(skill);
  
  document.getElementById('modalTitle').textContent = "Yangi Mock qo'shish";
  document.getElementById('modalBody').innerHTML = `
    <form id="newMockForm" style="display:flex;flex-direction:column;gap:14px;padding:6px 4px;" onsubmit="return submitNewMock(event)">
      <div class="form-field">
        <label>Mahoratni tanlang</label>
        <select id="mockSkillSelect" onchange="updateMockAutoNumber(this.value)">
          ${SKILLS.filter(s => s.id !== 'muhavara' && s.id !== 'kitaba').map(s => `<option value="${s.id}" ${s.id === skill ? 'selected' : ''}>${s.name}</option>`).join('')}
        </select>
      </div>
      <div class="form-field">
        <label>Mock nomi (avtomatik raqamlangan)</label>
        <input type="text" id="mockTitleInput" value="Mock ${nextNum}" required>
        <div class="form-hint">Har bir yangi mock avtomatik raqamlanadi (masalan: Mock 1, Mock 2).</div>
      </div>
      <div class="form-field">
        <label>Savollar soni</label>
        <input type="number" value="30" disabled style="background:var(--bg);color:var(--text-faint);cursor:not-allowed;">
        <div class="form-hint">Har bir mock standart 30 ta savoldan iborat bo'ladi.</div>
      </div>
      <div class="form-field">
        <label>Ajratilgan vaqt (daqiqa)</label>
        <input type="number" id="mockDurationInput" value="30" min="5" max="180" required>
      </div>
      <button type="submit" class="btn btn-primary btn-block" style="margin-top:6px;">Mockni yaratish</button>
    </form>
  `;
  document.getElementById('modalOverlay').classList.add('show');
}

function updateMockAutoNumber(skillId){
  const nextNum = nextMockNumberForSkill(skillId);
  const input = document.getElementById('mockTitleInput');
  if(input) input.value = `Mock ${nextNum}`;
}

function submitNewMock(e){
  e.preventDefault();
  const skill = document.getElementById('mockSkillSelect').value;
  const title = document.getElementById('mockTitleInput').value.trim();
  const durationMins = Number(document.getElementById('mockDurationInput').value) || 30;

  if(!title){
    toast("⚠️ Mock nomini kiriting");
    return false;
  }

  const newMock = {
    id: 'mock_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
    skill,
    title,
    durationMins,
    questions: [],
    createdAt: new Date().toISOString()
  };

  MOCKS_DATA.push(newMock);
  saveMocksData(newMock.id);
  closeModal();
  toast(`✅ "${title}" yaratildi! Endi 30 ta savol qo'shishingiz mumkin.`);
  viewMockQuestions(newMock.id);
  return false;
}

function openEditMockModal(mockId){
  const mock = MOCKS_DATA.find(m => m.id === mockId);
  if(!mock) return;

  document.getElementById('modalTitle').textContent = "Mockni tahrirlash";
  document.getElementById('modalBody').innerHTML = `
    <form style="display:flex;flex-direction:column;gap:14px;padding:6px 4px;" onsubmit="return submitEditMock(event, '${mock.id}')">
      <div class="form-field">
        <label>Mock nomi</label>
        <input type="text" id="editMockTitleInput" value="${escapeHtml(mock.title)}" required>
      </div>
      <div class="form-field">
        <label>Ajratilgan vaqt (daqiqa)</label>
        <input type="number" id="editMockDurationInput" value="${mock.durationMins || 30}" min="5" max="180" required>
      </div>
      <button type="submit" class="btn btn-primary btn-block">Saqlash</button>
    </form>
  `;
  document.getElementById('modalOverlay').classList.add('show');
}

function submitEditMock(e, mockId){
  e.preventDefault();
  const mock = MOCKS_DATA.find(m => m.id === mockId);
  if(!mock) return false;

  mock.title = document.getElementById('editMockTitleInput').value.trim();
  mock.durationMins = Number(document.getElementById('editMockDurationInput').value) || 30;

  saveMocksData(mock.id);
  closeModal();
  toast("✅ Mock ma'lumotlari yangilandi");
  return false;
}

async function deleteMock(mockId){
  const mock = MOCKS_DATA.find(m => m.id === mockId);
  if(!mock) return;
  const ok = await showLiquidConfirm({
    title: "Mock testni o'chirish",
    message: `"${mock.title}" mock testini butunlay o'chirmoqchimisiz?`,
    subtext: "Bu amalni ortga qaytarib bo'lmaydi.",
    confirmLabel: "Ha, o'chirilsin",
    cancelLabel: "Bekor qilish",
    isDanger: true
  });
  if(!ok) return;
  MOCKS_DATA = MOCKS_DATA.filter(m => m.id !== mockId);
  saveMocksData();
  await deleteMockFromBackend(mockId);
  toast("🗑 Mock test o'chirildi");
}

function viewMockQuestions(mockId){
  const mock = MOCKS_DATA.find(m => m.id === mockId);
  if(!mock) return;

  const qList = mock.questions || [];
  const skillMeta = SKILL_META[mock.skill] || { name: mock.skill };

  document.getElementById('modalTitle').textContent = `${mock.title} — Savollar (${qList.length}/30)`;
  
  const content = `
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;padding-bottom:10px;border-bottom:1px solid var(--border);">
        <div style="font-size:12.5px;color:var(--text-faint);font-weight:600;">
          Mahorat: <b style="color:var(--text);">${skillMeta.name}</b> · Jami: <b style="color:var(--text);">${qList.length}/30</b>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="btn btn-outline" style="font-size:12px;padding:6px 12px;" onclick="openBulkAddMockQuestionModal('${mock.id}')" ${qList.length >= 30 ? 'disabled' : ''}>Ommaviy (JSON)</button>
          <button class="btn btn-primary" style="font-size:12px;padding:6px 12px;" onclick="openAddMockQuestionModal('${mock.id}')" ${qList.length >= 30 ? 'disabled' : ''}>+ Yangi savol</button>
        </div>
      </div>
      
      ${qList.length === 0 ? `
        <div class="placeholder-card" style="padding:24px 14px;">
          <h3 style="margin-bottom:6px;">Bu mockda hali savol yo'q</h3>
          <p style="margin-bottom:12px;color:var(--text-faint);font-size:13px;">30 ta savol kiritish uchun yuqoridagi tugmalardan foydalaning.</p>
          <button class="btn btn-primary" onclick="openAddMockQuestionModal('${mock.id}')">+ Birinchi savolni qo'shish</button>
        </div>
      ` : `
        <div style="display:flex;flex-direction:column;gap:12px;max-height:60vh;overflow-y:auto;padding-right:4px;">
          ${qList.map((q, idx) => `
            <div class="card" style="padding:14px;background:var(--card-alt);border:1px solid var(--border);">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:8px;">
                <span style="font-weight:700;font-size:12.5px;color:var(--indigo-600);">${idx + 1}-savol</span>
                <div style="display:flex;gap:4px;">
                  <button class="btn btn-outline" style="padding:3px 7px;font-size:11px;" onclick="moveMockQuestion('${mock.id}', ${idx}, -1)" ${idx === 0 ? 'disabled' : ''}>▲</button>
                  <button class="btn btn-outline" style="padding:3px 7px;font-size:11px;" onclick="moveMockQuestion('${mock.id}', ${idx}, 1)" ${idx === qList.length - 1 ? 'disabled' : ''}>▼</button>
                  <button class="btn btn-outline" style="padding:3px 7px;font-size:11px;" onclick="openEditMockQuestionModal('${mock.id}', ${idx})">Tahrirlash</button>
                  <button class="btn btn-outline" style="padding:3px 7px;font-size:11px;color:var(--red);border-color:var(--red);" onclick="deleteMockQuestion('${mock.id}', ${idx})">O'chirish</button>
                </div>
              </div>
              <div dir="rtl" style="font-size:15px;font-weight:700;margin-bottom:10px;text-align:right;font-family:'Noto Sans Arabic',var(--font-ar),sans-serif;line-height:1.5;">${escapeHtml(q.q)}</div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px;">
                ${(q.opts || []).map((opt, oIdx) => `
                  <div dir="rtl" style="padding:7px 10px;border-radius:8px;font-size:13px;background:${oIdx === q.a ? 'var(--green-bg)' : 'var(--card)'};border:1.5px solid ${oIdx === q.a ? 'var(--green)' : 'var(--border)'};color:${oIdx === q.a ? 'var(--green)' : 'var(--text)'};font-weight:${oIdx === q.a ? '700' : '500'};text-align:right;">
                    ${oIdx === q.a ? '✓ ' : ''}${escapeHtml(opt)}
                  </div>
                `).join('')}
              </div>
              ${q.exp ? `<div style="font-size:11.5px;color:var(--text-faint);background:var(--card);padding:6px 10px;border-radius:6px;border:1px dashed var(--border);">💡 ${escapeHtml(q.exp)}</div>` : ''}
            </div>
          `).join('')}
        </div>
      `}
    </div>
  `;

  document.getElementById('modalBody').innerHTML = content;
  document.getElementById('modalOverlay').classList.add('show');
}

function openAddMockQuestionModal(mockId){
  const mock = MOCKS_DATA.find(m => m.id === mockId);
  if(!mock) return;
  if((mock.questions || []).length >= 30){
    toast("⚠️ Ushbu mock testda allaqachon 30 ta savol to'lgan!");
    return;
  }

  document.getElementById('modalTitle').textContent = `${mock.title} — Yangi savol qo'shish`;
  document.getElementById('modalBody').innerHTML = `
    <form style="display:flex;flex-direction:column;gap:14px;padding:6px 4px;" onsubmit="return submitAddMockQuestion(event, '${mock.id}')">
      <div class="form-field">
        <label>Savol matni (arabcha)</label>
        <textarea id="mqText" dir="rtl" placeholder="أَيْنَ ذَهَبَ..." required></textarea>
      </div>
      <div class="form-field">
        <label>Javob variantlari (to'g'risini belgilang)</label>
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${[0,1,2,3].map(i => `
            <div class="q-opt-row">
              <input type="radio" name="mqCorrect" value="${i}" ${i === 0 ? 'checked' : ''} required>
              <input type="text" id="mqOpt${i}" placeholder="Variant ${i + 1}" dir="rtl" required>
            </div>
          `).join('')}
        </div>
      </div>
      <div class="form-field">
        <label>Tushuntirish (o'zbekcha, ixtiyoriy)</label>
        <textarea id="mqExp" placeholder="Nima uchun bu javob to'g'ri..."></textarea>
      </div>
      <button type="submit" class="btn btn-primary btn-block">Savolni saqlash</button>
    </form>
  `;
  document.getElementById('modalOverlay').classList.add('show');
}

function submitAddMockQuestion(e, mockId){
  e.preventDefault();
  const mock = MOCKS_DATA.find(m => m.id === mockId);
  if(!mock) return false;
  if(!mock.questions) mock.questions = [];
  if(mock.questions.length >= 30){
    toast("⚠️ 30 tadan ortiq savol qo'shib bo'lmaydi");
    return false;
  }

  const q = document.getElementById('mqText').value.trim();
  const opts = [0,1,2,3].map(i => document.getElementById('mqOpt' + i).value.trim());
  const a = Number(document.querySelector('input[name="mqCorrect"]:checked').value);
  const exp = document.getElementById('mqExp').value.trim();

  mock.questions.push({
    id: 'mq_' + Date.now() + '_' + Math.random().toString(36).substr(2,6),
    q, opts, a, exp
  });

  saveMocksData(mockId);
  toast("✅ Savol qo'shildi");
  viewMockQuestions(mockId);
  return false;
}

function openEditMockQuestionModal(mockId, qIdx){
  const mock = MOCKS_DATA.find(m => m.id === mockId);
  if(!mock || !mock.questions || !mock.questions[qIdx]) return;
  const qObj = mock.questions[qIdx];

  document.getElementById('modalTitle').textContent = `${mock.title} — ${qIdx + 1}-savolni tahrirlash`;
  document.getElementById('modalBody').innerHTML = `
    <form style="display:flex;flex-direction:column;gap:14px;padding:6px 4px;" onsubmit="return submitEditMockQuestion(event, '${mock.id}', ${qIdx})">
      <div class="form-field">
        <label>Savol matni (arabcha)</label>
        <textarea id="mqEditText" dir="rtl" required>${escapeHtml(qObj.q)}</textarea>
      </div>
      <div class="form-field">
        <label>Javob variantlari (to'g'risini belgilang)</label>
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${[0,1,2,3].map(i => `
            <div class="q-opt-row">
              <input type="radio" name="mqEditCorrect" value="${i}" ${i === qObj.a ? 'checked' : ''} required>
              <input type="text" id="mqEditOpt${i}" value="${escapeHtml(qObj.opts ? qObj.opts[i] || '' : '')}" dir="rtl" required>
            </div>
          `).join('')}
        </div>
      </div>
      <div class="form-field">
        <label>Tushuntirish (o'zbekcha, ixtiyoriy)</label>
        <textarea id="mqEditExp">${escapeHtml(qObj.exp || '')}</textarea>
      </div>
      <button type="submit" class="btn btn-primary btn-block">O'zgarishlarni saqlash</button>
    </form>
  `;
  document.getElementById('modalOverlay').classList.add('show');
}

function submitEditMockQuestion(e, mockId, qIdx){
  e.preventDefault();
  const mock = MOCKS_DATA.find(m => m.id === mockId);
  if(!mock || !mock.questions || !mock.questions[qIdx]) return false;

  mock.questions[qIdx].q = document.getElementById('mqEditText').value.trim();
  mock.questions[qIdx].opts = [0,1,2,3].map(i => document.getElementById('mqEditOpt' + i).value.trim());
  mock.questions[qIdx].a = Number(document.querySelector('input[name="mqEditCorrect"]:checked').value);
  mock.questions[qIdx].exp = document.getElementById('mqEditExp').value.trim();

  saveMocksData(mockId);
  toast("✅ Savol yangilandi");
  viewMockQuestions(mockId);
  return false;
}

async function deleteMockQuestion(mockId, qIdx){
  const mock = MOCKS_DATA.find(m => m.id === mockId);
  if(!mock || !mock.questions || !mock.questions[qIdx]) return;
  const ok = await showLiquidConfirm({
    title: "Savolni o'chirish",
    message: `${qIdx + 1}-savolni o'chirmoqchimisiz?`,
    subtext: "Bu amalni ortga qaytarib bo'lmaydi.",
    confirmLabel: "Ha, o'chirilsin",
    cancelLabel: "Bekor qilish",
    isDanger: true
  });
  if(!ok) return;
  mock.questions.splice(qIdx, 1);
  saveMocksData(mockId);
  toast("🗑 Savol o'chirildi");
  viewMockQuestions(mockId);
}

function moveMockQuestion(mockId, qIdx, dir){
  const mock = MOCKS_DATA.find(m => m.id === mockId);
  if(!mock || !mock.questions) return;
  const targetIdx = qIdx + dir;
  if(targetIdx < 0 || targetIdx >= mock.questions.length) return;
  const temp = mock.questions[qIdx];
  mock.questions[qIdx] = mock.questions[targetIdx];
  mock.questions[targetIdx] = temp;
  saveMocksData(mockId);
  viewMockQuestions(mockId);
}

function openBulkAddMockQuestionModal(mockId){
  const mock = MOCKS_DATA.find(m => m.id === mockId);
  if(!mock) return;
  const availableSlots = 30 - (mock.questions || []).length;
  if(availableSlots <= 0){
    toast("⚠️ Mockda allaqachon 30 ta savol bor");
    return;
  }

  document.getElementById('modalTitle').textContent = `${mock.title} — Ommaviy savol qo'shish`;
  document.getElementById('modalBody').innerHTML = `
    <form style="display:flex;flex-direction:column;gap:14px;padding:6px 4px;" onsubmit="return submitBulkAddMockQuestions(event, '${mock.id}')">
      <div class="form-field">
        <label>JSON formatdagi savollar ro'yxati</label>
        <textarea id="mockBulkJson" style="min-height:160px;font-family:monospace;font-size:12px;" placeholder='[&#10;  {&#10;    "q": "كَتَبَ الطَّالِبُ...",&#10;    "opts": ["الدَّرْسَ", "الدَّرْسُ", "الدَّرْسِ", "دَرْسٌ"],&#10;    "a": 0,&#10;    "exp": "Izoh..."&#10;  }&#10;]' required></textarea>
        <div class="form-hint">Maksimal qolgan joy: <b>${availableSlots}</b> ta savol (jami 30 ta).</div>
      </div>
      <button type="submit" class="btn btn-primary btn-block">Qo'shish</button>
    </form>
  `;
  document.getElementById('modalOverlay').classList.add('show');
}

function submitBulkAddMockQuestions(e, mockId){
  e.preventDefault();
  const mock = MOCKS_DATA.find(m => m.id === mockId);
  if(!mock) return false;
  if(!mock.questions) mock.questions = [];

  const raw = document.getElementById('mockBulkJson').value.trim();
  try {
    const parsed = JSON.parse(raw);
    if(!Array.isArray(parsed) || !parsed.length){
      toast("⚠️ JSON massiv bo'lishi kerak!");
      return false;
    }
    const availableSlots = 30 - mock.questions.length;
    const toAdd = parsed.slice(0, availableSlots).map(item => ({
      id: 'mq_' + Date.now() + '_' + Math.random().toString(36).substr(2,6),
      q: item.q || item.question || '',
      opts: Array.isArray(item.opts) ? item.opts : (Array.isArray(item.options) ? item.options : ['','','','']),
      a: typeof item.a === 'number' ? item.a : (typeof item.correct === 'number' ? item.correct : 0),
      exp: item.exp || item.explanation || ''
    })).filter(q => q.q && q.opts.length === 4);

    if(!toAdd.length){
      toast("⚠️ Yaroqli savollar topilmadi");
      return false;
    }

    mock.questions.push(...toAdd);
    saveMocksData(mockId);
    toast(`✅ ${toAdd.length} ta savol qo'shildi`);
    viewMockQuestions(mockId);
  } catch(err){
    toast("⚠️ JSON formati noto'g'ri: " + err.message);
    return false;
  }
  return false;
}

function renderMockCardHtml(m, skillMeta, idx){
  const result = getMockResult(m.id);
  const testNumber = (typeof idx === 'number') ? (idx + 1) : 1;
  const qCount = (m.questions && m.questions.length) ? m.questions.length : 30;
  const subtitle = `${qCount} ta savol · ${qCount} daqiqa`;
  const cleanTitle = (m.title || `Mock ${testNumber}`).replace(/Mock\s*#\s*(\d+)/gi, 'Mock $1').replace(/#(\d+)/g, '$1');

  let footerHtml = '';
  if(result && result.total > 0 && result.wrong === 0){
    // 1-kabi: 100% to'g'ri ishlangan (COMPLETED + 0 ta xato)
    footerHtml = `
      <div class="mock-card-footer mock-footer-completed">
        <div class="mock-completed-label">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
          </svg>
          <span>COMPLETED</span>
        </div>
        <div class="mock-error-chip zero">0 ta xato</div>
      </div>
    `;
  } else if(result && result.total > 0 && result.wrong > 0){
    // 2-kabi: Chala / xatosi bor (Progress bar + to'g'ri/jami & X ta xato)
    const pct = Math.min(100, Math.max(10, Math.round((result.correct / result.total) * 100)));
    footerHtml = `
      <div class="mock-card-footer mock-footer-progress">
        <div class="mock-bar-track">
          <div class="mock-bar-fill" style="width:${pct}%;"></div>
        </div>
        <div class="mock-progress-meta-row">
          <span>${result.correct}/${result.total} to'g'ri</span>
          <span class="mock-error-chip wrong">${result.wrong} ta xato</span>
        </div>
      </div>
    `;
  } else {
    // 3-kabi: Ishlanmagan (toza)
    footerHtml = `<div class="mock-card-footer mock-footer-untested"></div>`;
  }

  return `
    <div class="mock-card card" id="mockCard_${m.id}" onclick="startMockQuiz('${m.id}')" role="button" tabindex="0">
      <div style="display:flex; flex-direction:column; gap:12px;">
        <div class="mock-card-header">
          <div class="mock-card-book-icon">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 4.5C10.6 3.5 8.8 3 7 3c-2.4 0-4.5.9-6 2.3v13.9C2.5 17.8 4.6 17 7 17c1.8 0 3.6.5 5 1.5 1.4-1 3.2-1.5 5-1.5 2.4 0 4.5.8 6 2.2V5.3C21.5 3.9 19.4 3 17 3c-1.8 0-3.6.5-5 1.5zm-1 10.8c-1.2-.8-2.6-1.3-4-1.3-1.6 0-3.1.6-4.3 1.6V6.6C3.9 5.6 5.4 5 7 5c1.4 0 2.8.5 4 1.3v9zm10 0c-1.2-1-2.7-1.6-4.3-1.6-1.4 0-2.8.5-4 1.3V6.3c1.2-.8 2.6-1.3 4-1.3 1.6 0 3.1.6 4.3 1.6v8.7z"/>
            </svg>
          </div>
          <div class="mock-card-arrow">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m9 18 6-6-6-6"/></svg>
          </div>
        </div>
        <div class="mock-card-body">
          <div class="mock-card-title">${escapeHtml(cleanTitle)}</div>
          <div class="mock-card-sub">${escapeHtml(subtitle)}</div>
        </div>
      </div>
      ${footerHtml}
    </div>
  `;
}

function renderSkillMockPanes(){
  const grammarMockEl = document.getElementById('grammarPaneMocks');
  if(grammarMockEl){
    const grammarMocks = MOCKS_DATA.filter(m => m.skill === 'grammatika');
    const skillMeta = SKILL_META['grammatika'] || { name: 'Grammatika', icon: '📘', bg: 'var(--grammatika-bg)', color: 'var(--grammatika)' };
    if(grammarMocks.length === 0){
      grammarMockEl.innerHTML = `
        <div class="placeholder-card" style="padding:32px 16px;">
          <div style="font-size:32px;margin-bottom:8px;">📝</div>
          <h3 style="font-size:16px;font-weight:700;margin-bottom:6px;">Hozircha mock testlar mavjud emas</h3>
          <p style="font-size:13px;color:var(--text-faint);">Grammatika bo'yicha mock testlar admin tomonidan tez orada joylanadi.</p>
        </div>
      `;
    } else {
      grammarMockEl.innerHTML = `
        <div class="mock-cards-list">
          ${grammarMocks.map((m, idx) => renderMockCardHtml(m, skillMeta, idx)).join('')}
        </div>
      `;
    }
  }

  const skillMockEl = document.getElementById('skillPaneMocks');
  if(skillMockEl && pendingSkillId){
    const skillMocks = MOCKS_DATA.filter(m => m.skill === pendingSkillId);
    const skillMeta = SKILL_META[pendingSkillId] || { name: pendingSkillId, icon: '📝', bg: 'var(--indigo-100)', color: 'var(--indigo-600)' };
    if(skillMocks.length === 0){
      skillMockEl.innerHTML = `
        <div class="placeholder-card" style="padding:32px 16px;">
          <div style="font-size:32px;margin-bottom:8px;">📝</div>
          <h3 style="font-size:16px;font-weight:700;margin-bottom:6px;">Hozircha mock testlar mavjud emas</h3>
          <p style="font-size:13px;color:var(--text-faint);">${skillMeta.name} bo'yicha mock testlar admin tomonidan tez orada joylanadi.</p>
        </div>
      `;
    } else {
      skillMockEl.innerHTML = `
        <div class="mock-cards-list">
          ${skillMocks.map((m, idx) => renderMockCardHtml(m, skillMeta, idx)).join('')}
        </div>
      `;
    }
  }
}

function startMockQuiz(mockId){
  const mock = MOCKS_DATA.find(m => m.id === mockId);
  if(!mock) return;
  if(!mock.questions || mock.questions.length === 0){
    toast("⚠️ Ushbu mock testda hali savollar yo'q!");
    return;
  }
  const skillMeta = SKILL_META[mock.skill] || { name: mock.skill, color: 'var(--indigo-600)', bg: 'var(--indigo-100)' };
  currentQuiz = {
    skillId: mock.skill,
    topicId: mock.id,
    type: 'mock',
    mockId: mock.id,
    mockTitle: mock.title,
    questions: mock.questions.map(q => ({
      ...q,
      picked: null,
      timeLeft: q.timeLeft !== undefined ? q.timeLeft : 60,
      expired: false
    })),
    color: skillMeta.color || 'var(--indigo-600)',
    bg: skillMeta.bg || 'var(--indigo-100)',
    label: `${skillMeta.name} — ${mock.title}`,
    idx: 0,
    startedAt: Date.now()
  };
  const qTag = document.getElementById('quizTag');
  if(qTag){
    qTag.textContent = currentQuiz.label;
    qTag.style.background = skillMeta.bg || 'var(--indigo-100)';
    qTag.style.color = skillMeta.color || 'var(--indigo-600)';
  }
  buildQGrid();
  showView('quiz');
  renderQuestion();
  if(mock.skill !== 'grammatika'){
    const qCount = currentQuiz.questions.length;
    const durationSeconds = Math.max(60, qCount * 60);
    startTimer(durationSeconds, () => finishQuiz());
  }
}

function openAddQuestionModal(presetSkill, presetTopic, presetText = '', presetOpts = null, presetExp = '', onSavedCallback = null){
  const skillId = presetSkill || adminActiveSkill;
  const isGrammar = skillId === 'grammatika';
  const isQiroa = skillId === 'qiroa';
  const isIstima = skillId === 'istima';
  window._adminQOnSavedCallback = onSavedCallback;
  if(isQiroa && presetTopic){
    const n = QIROA_TEST_BY_ID[presetTopic]?.questions.length || 0;
    if(n >= QIROA_MAX_Q_PER_TEST){
      toast(`⚠️ Bu testda allaqachon ${QIROA_MAX_Q_PER_TEST} ta savol bor`);
      return;
    }
  }
  if(isIstima && presetTopic){
    const test = ISTIMA_TEST_BY_ID[presetTopic];
    const cap = test ? istimaQCountFor(test.juzId) : 0;
    if(test && test.questions.length >= cap){
      toast(`⚠️ Bu testda allaqachon ${cap} ta savol bor`);
      return;
    }
  }
  const allTests = QIROA_JUZ.flatMap(j => (QIROA_TESTS[j.id]||[]).map((t,idx)=>({...t, juzName:j.name, label:`${j.name} · Test ${idx+1}`})));
  if(isQiroa && !allTests.length){
    toast("⚠️ Avval Qiroa bo'limida biror juzga matn (test) qo'shing — \"+ Yangi matn\"", 6000);
    return;
  }
  const allIstimaTests = ISTIMA_JUZ.flatMap(j => (ISTIMA_TESTS[j.id]||[]).map((t,idx)=>({...t, juzName:j.name, cap:j.qCount, label:`${j.name} · Test ${idx+1}`})));
  if(isIstima && !allIstimaTests.length){
    toast("⚠️ Avval Istima bo'limida biror qismga test (audio) qo'shing — \"+ Yangi test\"", 6000);
    return;
  }

  const initialTopicObj = presetTopic ? GRAMMAR_TOPICS.find(t=>t.id===presetTopic) : null;
  const initialCategory = initialTopicObj ? initialTopicObj.category : 'nahv';

  document.getElementById('modalTitle').textContent = "Yangi savol qo'shish";
  document.getElementById('modalBody').innerHTML = `
    <form id="adminQForm" style="display:flex;flex-direction:column;gap:14px;padding:6px 4px;" onsubmit="return submitNewQuestion(event)">
      <div class="form-field">
        <label>Bo'lim</label>
        <select id="qSkill" onchange="toggleGrammarTopicField()">
          ${SKILLS.map(s=>`<option value="${s.id}" ${s.id===skillId?'selected':''}>${s.name}</option>`).join('')}
        </select>
      </div>
      <div class="form-field" id="qTopicField" style="${isGrammar?'':'display:none;'}">
        <label>Mavzu</label>
        <select id="qTopic" onchange="onGrammarTopicChange()">
          <option value="" ${!presetTopic?'selected':''}>— Mavzusiz (faqat "Grammatika mahorati" — real imtihon uchun) —</option>
          ${GRAMMAR_TOPICS.map(t=>`<option value="${t.id}" ${t.id===presetTopic?'selected':''}>${t.name}</option>`).join('')}
        </select>
        <div style="font-size:11px;color:var(--text-faint);font-weight:600;margin-top:5px;">Mavzu tanlansa — savol shu mavzuning amaliyot testiga (Umumiy grammatika bo'limi) tushadi. Mavzu tanlanmasa — savol faqat to'liq imtihondagi "Grammatika mahorati"da chiqadi.</div>
      </div>
      <div class="form-field" id="qCategoryField" style="${isGrammar?'':'display:none;'}">
        <label>Kategoriya (Imtihon nisbati: Nahv 15 ta, Sarf 7 ta, Imlo 4 ta, Keng tarqalgan xatolar 4 ta)</label>
        <select id="qCategory">
          ${GRAMMAR_CATEGORIES.map(c=>{
            const countLabel = c.id==='nahv'?'15 ta': c.id==='sarf'?'7 ta': c.id==='imlo'?'4 ta':'4 ta';
            return `<option value="${c.id}" ${c.id===initialCategory?'selected':''}>${c.name} (${c.ar}) — imtihonda ${countLabel}</option>`;
          }).join('')}
        </select>
        <div style="font-size:11px;color:var(--text-faint);font-weight:600;margin-top:5px;">Imtihonda savollar aynan shu 4 kategoriya bo'yicha belgilangan nisbatda (jami 30 ta) random tanlanadi.</div>
      </div>
      <div class="form-field" id="qJuzField" style="${isQiroa?'':'display:none;'}">
        <label>Test (matn)</label>
        <select id="qJuz">
          ${allTests.map(t=>{
            const n = t.questions.length;
            const full = n >= QIROA_MAX_Q_PER_TEST;
            return `<option value="${t.id}" ${t.id===presetTopic?'selected':''} ${full?'disabled':''}>${t.label} (${n}/${QIROA_MAX_Q_PER_TEST})${full?' — to\u2018la':''}</option>`;
          }).join('')}
        </select>
      </div>
      <div class="form-field" id="qIstimaField" style="${isIstima?'':'display:none;'}">
        <label>Test (audio)</label>
        <select id="qIstima">
          ${allIstimaTests.map(t=>{
            const n = t.questions.length;
            const full = n >= t.cap;
            return `<option value="${t.id}" ${t.id===presetTopic?'selected':''} ${full?'disabled':''}>${t.label} (${n}/${t.cap})${full?' — to\u2018la':''}</option>`;
          }).join('')}
        </select>
      </div>
      <div class="form-field">
        <label>Savol matni (arabcha)</label>
        <textarea id="qText" dir="rtl" placeholder="أَيْنَ ذَهَبَ..." required>${escapeHtml(presetText||'')}</textarea>
      </div>
      <div class="form-field">
        <label>Javob variantlari (to'g'risini belgilang)</label>
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${[0,1,2,3].map(i=>`
            <div class="q-opt-row">
              <input type="radio" name="qCorrect" value="${i}" ${i===0?'checked':''} required>
              <input type="text" id="qOpt${i}" placeholder="Variant ${i+1}" dir="rtl" value="${escapeHtml((presetOpts && presetOpts[i]) || '')}" required>
            </div>
          `).join('')}
        </div>
      </div>
      <div class="form-field">
        <label>Tushuntirish (o'zbekcha, ixtiyoriy)</label>
        <textarea id="qExp" placeholder="Nima uchun bu javob to'g'ri...">${escapeHtml(presetExp||'')}</textarea>
      </div>
      <button type="submit" class="btn btn-primary btn-block">Saqlash</button>
    </form>
  `;
  document.getElementById('modalOverlay').classList.add('show');
}
function toggleGrammarTopicField(){
  const val = document.getElementById('qSkill').value;
  const isGrammar = val==='grammatika';
  document.getElementById('qTopicField').style.display = isGrammar ? '' : 'none';
  const catField = document.getElementById('qCategoryField');
  if(catField) catField.style.display = isGrammar ? '' : 'none';
  document.getElementById('qJuzField').style.display = val==='qiroa' ? '' : 'none';
  const istimaField = document.getElementById('qIstimaField');
  if(istimaField) istimaField.style.display = val==='istima' ? '' : 'none';
}
function onGrammarTopicChange(){
  const topicId = document.getElementById('qTopic')?.value;
  if(topicId){
    const t = GRAMMAR_TOPICS.find(x=>x.id===topicId);
    if(t && t.category){
      const catSel = document.getElementById('qCategory');
      if(catSel) catSel.value = t.category;
    }
  }
}
async function submitNewQuestion(e){
  e.preventDefault();
  const skillId = document.getElementById('qSkill').value;
  const topicId = skillId==='grammatika'
    ? document.getElementById('qTopic')?.value
    : skillId==='qiroa' ? document.getElementById('qJuz')?.value
    : skillId==='istima' ? document.getElementById('qIstima')?.value
    : null;
  const category = (skillId==='grammatika')
    ? (document.getElementById('qCategory')?.value || (topicId ? GRAMMAR_TOPICS.find(t=>t.id===topicId)?.category : null) || 'nahv')
    : null;
  if(skillId==='qiroa'){
    const n = QIROA_TEST_BY_ID[topicId]?.questions.length || 0;
    if(n >= QIROA_MAX_Q_PER_TEST){
      toast(`⚠️ Bu testda allaqachon ${QIROA_MAX_Q_PER_TEST} ta savol bor`);
      return false;
    }
  }
  if(skillId==='istima'){
    const test = ISTIMA_TEST_BY_ID[topicId];
    const cap = test ? istimaQCountFor(test.juzId) : 0;
    if(test && test.questions.length >= cap){
      toast(`⚠️ Bu testda allaqachon ${cap} ta savol bor`);
      return false;
    }
  }
  const newQ = {
    id: null, skillId, topicId: topicId || null,
    category: category || null,
    q: document.getElementById('qText').value,
    opts: [0,1,2,3].map(i=>document.getElementById('qOpt'+i).value),
    a: Number(document.querySelector('input[name="qCorrect"]:checked').value),
    exp: document.getElementById('qExp').value,
  };
  // Avval ekranga darhol qo'shamiz (tezkor tuyulishi uchun), so'ng backendga yuboramiz —
  // shunda savol Supabase "questions" jadvaliga yoziladi va boshqa foydalanuvchilar
  // ilovani keyingi ochganda uni ko'radi.
  if(skillId==='grammatika'){
    if(topicId){
      if(!GRAMMAR_TOPIC_BANKS[topicId]) GRAMMAR_TOPIC_BANKS[topicId] = [];
      GRAMMAR_TOPIC_BANKS[topicId].push(newQ);
    } else {
      // Mavzu tanlanmagan — bu savol amaliyot (Umumiy grammatika) mavzulariga emas,
      // faqat "Grammatika mahorati" (real At-Tanal imtihoni) savollar bankiga tushadi.
      QUESTION_BANKS.grammatika.questions.push(newQ);
    }
  } else if(skillId==='qiroa'){
    if(QIROA_TEST_BY_ID[topicId]) QIROA_TEST_BY_ID[topicId].questions.push(newQ);
  } else if(skillId==='istima'){
    if(ISTIMA_TEST_BY_ID[topicId]) ISTIMA_TEST_BY_ID[topicId].questions.push(newQ);
  } else {
    if(!QUESTION_BANKS[skillId].questions) QUESTION_BANKS[skillId].questions = [];
    QUESTION_BANKS[skillId].questions.push(newQ);
  }
  closeModal();
  adminActiveSkill = skillId;
  renderAdminQuestions();

  if(typeof window._adminQOnSavedCallback === 'function'){
    try { window._adminQOnSavedCallback(newQ); } catch(err){ console.error(err); }
    window._adminQOnSavedCallback = null;
  }

  const saved = await saveQuestionToBackend({ skillId, topicId, category, q:newQ.q, opts:newQ.opts, a:newQ.a, exp:newQ.exp });
  if(saved){
    // Backend id'sini shu savolga biriktiramiz — shu bilan uni darhol tahrirlash/o'chirish mumkin bo'ladi.
    const savedId = Array.isArray(saved) ? saved[0]?.id : saved?.id;
    if(savedId) newQ.id = savedId;
    toast("✅ Savol qo'shildi — endi hamma foydalanuvchida ko'rinadi");
  } else {
    toast("⚠️ Backendga yuborilmadi: " + window.LAST_BACKEND_ERROR, 6000);
  }
  return false;
}

/* ---------- Savollarni ommaviy (bulk) qo'shish ----------
   Admin bir nechta savolni bitta JSON massiv ko'rinishida joylashtirib, hammasini
   bittada Supabase'ga yuboradi. Format: har bir element
   {"q":"...","opts":["...","...","...","..."],"a":0,"exp":"..."} (exp ixtiyoriy). */
function openBulkAddQuestionModal(){
  const skillId = adminActiveSkill;
  const isGrammar = skillId === 'grammatika';
  const isQiroa = skillId === 'qiroa';
  document.getElementById('modalTitle').textContent = "Savollarni ommaviy qo'shish";
  document.getElementById('modalBody').innerHTML = `
    <form id="adminBulkQForm" style="display:flex;flex-direction:column;gap:14px;padding:6px 4px;" onsubmit="return submitBulkQuestions(event)">
      <div class="form-field">
        <label>Bo'lim</label>
        <select id="bqSkill" onchange="toggleBulkGrammarTopicField()">
          ${SKILLS.map(s=>`<option value="${s.id}" ${s.id===skillId?'selected':''}>${s.name}</option>`).join('')}
        </select>
      </div>
      <div class="form-field" id="bqJuzField" style="${isQiroa?'':'display:none;'}">
        <label>Juz</label>
        <select id="bqJuz" onchange="toggleBulkQiroaTestField()">
          ${QIROA_JUZ.map(j=>`<option value="${j.id}">${j.name}</option>`).join('')}
        </select>
      </div>
      <div class="form-field" id="bqQiroaModeField" style="${isQiroa?'':'display:none;'}">
        <label>Bu savollar qaysi testga tegishli?</label>
        <select id="bqQiroaMode" onchange="toggleBulkQiroaTestField()">
          <option value="new">🆕 Yangi matn (test) yarataman</option>
          <option value="existing">Mavjud testga qo'shaman</option>
        </select>
      </div>
      <div class="form-field" id="bqQiroaNewTextField" style="${isQiroa?'':'display:none;'}">
        <label>Yangi matn (arabcha)</label>
        <textarea id="bqQiroaPassage" dir="rtl" style="min-height:140px;" placeholder="نَصّ الْقِرَاءَة..."></textarea>
        <div style="font-size:11.5px;color:var(--text-faint);margin-top:6px;">Bu matn saqlanadi va pastdagi JSON'dagi savollar shu YANGI matnga bog'lanadi.</div>
      </div>
      <div class="form-field" id="bqQiroaExistingTestField" style="display:none;">
        <label>Mavjud test</label>
        <select id="bqQiroaTestId"></select>
      </div>
      <div id="bqGrammarFields" style="${isGrammar?'':'display:none;'}display:flex;flex-direction:column;gap:14px;">
        <div class="form-field">
          <label>Standart mavzu (tanlansa — amaliyot uchun, Umumiy grammatika bo'limiga tushadi. Tanlanmasa — bu savollar FAQAT "Grammatika mahorati" (real imtihon)da chiqadi)</label>
          <select id="bqTopic" onchange="onBulkGrammarTopicChange()">
            <option value="">— Mavzusiz (faqat "Grammatika mahorati" — real imtihon uchun) —</option>
            ${GRAMMAR_TOPICS.map(t=>`<option value="${t.id}">${t.name}</option>`).join('')}
          </select>
        </div>
        <div class="form-field">
          <label>Standart kategoriya (Imtihon nisbati: Nahv 15 ta, Sarf 7 ta, Imlo 4 ta, Keng tarqalgan xatolar 4 ta)</label>
          <select id="bqCategory">
            ${GRAMMAR_CATEGORIES.map(c=>{
              const countLabel = c.id==='nahv'?'15 ta': c.id==='sarf'?'7 ta': c.id==='imlo'?'4 ta':'4 ta';
              return `<option value="${c.id}">${c.name} (${c.ar}) — imtihonda ${countLabel}</option>`;
            }).join('')}
          </select>
          <div style="font-size:11px;color:var(--text-faint);font-weight:600;margin-top:5px;">JSON'da "category" ko'rsatilmagan savollar uchun shu kategoriya ishlatiladi.</div>
        </div>
      </div>
      <div class="form-field">
        <label>Savollar (JSON massiv)</label>
        <textarea id="bqJson" rows="12" placeholder='[
  {"category":"nahv","q":"أَيْنَ ذَهَبَ زَيْدٌ؟","opts":["إِلَى الْمَدْرَسَةِ","فِي الْمَدْرَسَةِ","عَنِ الْمَدْرَسَةِ","مِنَ الْمَدْرَسَةِ"],"a":0,"exp":"Nahv qoidasi"},
  {"category":"sarf","q":"مَا هُوَ وَزْنُ كَلِمَةِ \\"اسْتَغْفَرَ\\"؟","opts":["اسْتَفْعَلَ","افْتَعَلَ","تَفَاعَلَ","فَعَّلَ"],"a":0,"exp":"Sarf qoidasi"},
  {"category":"imlo","q":"كَيْفَ تُكْتَبُ هَمْزَةُ \\"سَأَلَ\\"؟","opts":["عَلَى الأَلِفِ","عَلَى الْوَاوِ","عَلَى الْيَاءِ","عَلَى السَّطْرِ"],"a":0,"exp":"Imlo qoidasi"},
  {"category":"xatolar","q":"عَيِّنِ الْجُمْلَةَ الصَّحِيحَةَ:","opts":["قَرَأْتُ كِتَابًا مُفِيدًا","قَرَأْتُ كِتَابٌ مُفِيدٌ","قَرَأْتُ كِتَابٍ مُفِيدٍ","قَرَأْتُ كِتَابَ مُفِيدٍ"],"a":0,"exp":"Xatolarni tuzatish"}
]' required style="font-family:monospace;font-size:12.5px;direction:ltr;"></textarea>
        <div style="font-size:11.5px;color:var(--text-faint);margin-top:6px;">
          Har bir savol: <b>q</b> — savol matni, <b>opts</b> — 4 ta variant, <b>a</b> — to'g'ri variant indeksi (0-3), <b>exp</b> — izoh (ixtiyoriy).<br>
          ${isGrammar ? `Grammatika uchun: <b>category</b> — savol qaysi kategoriyaga tushishi: <code>nahv</code> (15 ta), <code>sarf</code> (7 ta), <code>imlo</code> (4 ta) yoki <code>xatolar</code> (4 ta). Agar JSON'da category ko'rsatilmasa, yuqoridagi "Standart kategoriya" olinadi. <b>topic</b> — mavzu nomi (ixtiyoriy, agar Umumiy grammatika amaliyot mavzusiga qo'shmoqchi bo'lsangiz).` : ''}
          ${isQiroa ? `Qiroa uchun: yuqorida tanlangan <b>testga</b> (matnga) qo'shiladi — bitta testda ko'pi bilan ${QIROA_MAX_Q_PER_TEST} ta savol bo'lishi kerak. "Yangi matn" tanlansa, avval matn saqlanadi, so'ng shu savollar o'sha yangi matnga bog'lanadi.` : ''}
        </div>
      </div>
      <button type="submit" class="btn btn-primary btn-block">Hammasini saqlash</button>
    </form>
  `;
  document.getElementById('modalOverlay').classList.add('show');
  if(isQiroa) toggleBulkQiroaTestField();
}
function toggleBulkGrammarTopicField(){
  const val = document.getElementById('bqSkill').value;
  document.getElementById('bqGrammarFields').style.display = val==='grammatika' ? 'flex' : 'none';
  const isQiroa = val==='qiroa';
  ['bqJuzField','bqQiroaModeField','bqQiroaNewTextField'].forEach(id=>{
    const el = document.getElementById(id);
    if(el) el.style.display = isQiroa ? '' : 'none';
  });
  if(isQiroa) toggleBulkQiroaTestField();
  else{
    const existingField = document.getElementById('bqQiroaExistingTestField');
    if(existingField) existingField.style.display = 'none';
  }
}
function onBulkGrammarTopicChange(){
  const topicId = document.getElementById('bqTopic')?.value;
  if(topicId){
    const t = GRAMMAR_TOPICS.find(x=>x.id===topicId);
    if(t && t.category){
      const catSel = document.getElementById('bqCategory');
      if(catSel) catSel.value = t.category;
    }
  }
}
/* Qiroa bulk formasida: tanlangan Juz + rejim (yangi matn / mavjud test)ga qarab
   tegishli maydonlarni ko'rsatadi/yashiradi va "mavjud test" ro'yxatini to'ldiradi. */
function toggleBulkQiroaTestField(){
  const juzId = document.getElementById('bqJuz')?.value;
  const mode = document.getElementById('bqQiroaMode')?.value || 'new';
  const newTextField = document.getElementById('bqQiroaNewTextField');
  const existingField = document.getElementById('bqQiroaExistingTestField');
  if(newTextField) newTextField.style.display = mode==='new' ? '' : 'none';
  if(existingField) existingField.style.display = mode==='existing' ? '' : 'none';
  const sel = document.getElementById('bqQiroaTestId');
  if(sel && juzId){
    const tests = QIROA_TESTS[juzId] || [];
    sel.innerHTML = tests.length
      ? tests.map((t,idx)=>{
          const n = t.questions.length;
          const full = n >= QIROA_MAX_Q_PER_TEST;
          return `<option value="${t.id}" ${full?'disabled':''}>Test ${idx+1} (${n}/${QIROA_MAX_Q_PER_TEST})${full?' — to\u2018la':''}</option>`;
        }).join('')
      : `<option value="">— bu juzda hali test yo'q —</option>`;
  }
}
async function submitBulkQuestions(e){
  e.preventDefault();
  const skillId = document.getElementById('bqSkill').value;
  const isGrammar = skillId === 'grammatika';
  const isQiroa = skillId === 'qiroa';
  const defaultTopicId = isGrammar ? (document.getElementById('bqTopic')?.value || '') : '';
  const category = isGrammar ? (document.getElementById('bqCategory')?.value || '') : '';

  let parsed;
  try{
    parsed = JSON.parse(document.getElementById('bqJson').value);
    if(!Array.isArray(parsed) || !parsed.length) throw new Error('Bo\'sh yoki massiv emas');
  }catch(err){
    toast("❌ JSON noto'g'ri: " + err.message, 6000);
    return false;
  }
  for(const [i, row] of parsed.entries()){
    if(!row.q || !Array.isArray(row.opts) || row.opts.length !== 4 || typeof row.a !== 'number'){
      toast(`❌ ${i+1}-savol formati noto'g'ri (q, opts[4], a talab qilinadi)`, 6000);
      return false;
    }
  }

  let qiroaTestId = null;
  if(isQiroa){
    const juzId = document.getElementById('bqJuz')?.value;
    const mode = document.getElementById('bqQiroaMode')?.value || 'new';
    if(mode === 'new'){
      const passage = document.getElementById('bqQiroaPassage')?.value || '';
      if(!passage.trim()){
        toast("❌ Yangi matn matnini kiriting", 6000);
        return false;
      }
      if(parsed.length > QIROA_MAX_Q_PER_TEST){
        toast(`❌ Bitta testda ko'pi bilan ${QIROA_MAX_Q_PER_TEST} ta savol bo'lishi kerak, siz ${parsed.length} ta yubordingiz`, 7000);
        return false;
      }
      toast('⏳ Matn saqlanmoqda...');
      const saved = await addQiroaTextToBackend(juzId, passage);
      if(!saved){ toast("⚠️ Matn saqlanmadi: " + window.LAST_BACKEND_ERROR, 6000); return false; }
      qiroaTestId = Array.isArray(saved) ? saved[0]?.id : saved?.id;
      if(!qiroaTestId){ toast("⚠️ Yangi matn id'si backenddan qaytmadi", 6000); return false; }
    } else {
      qiroaTestId = document.getElementById('bqQiroaTestId')?.value || '';
      if(!qiroaTestId){
        toast("❌ Mavjud test tanlang (yoki avval shu juzga yangi matn qo'shing)", 6000);
        return false;
      }
      const existing = QIROA_TEST_BY_ID[qiroaTestId]?.questions.length || 0;
      if(existing + parsed.length > QIROA_MAX_Q_PER_TEST){
        toast(`❌ Bu testda ${existing} ta savol bor, ${parsed.length} ta qo'shsangiz ${existing+parsed.length} ta bo'ladi — max ${QIROA_MAX_Q_PER_TEST} ta bo'lishi kerak`, 7000);
        return false;
      }
    }
  }

  const items = parsed.map(row => ({
    skillId,
    topicId: isGrammar ? (defaultTopicId || null) : (isQiroa ? qiroaTestId : null),
    topicName: isGrammar ? (row.topic || null) : null,
    topicAr: isGrammar ? (row.topicAr || null) : null,
    category: isGrammar ? (row.category || category || null) : null,
    q: row.q, opts: row.opts, a: row.a, exp: row.exp || '',
  }));
  closeModal();
  toast(`⏳ ${items.length} ta savol yuborilmoqda...`);

  const result = await saveQuestionsBulkWithTopicsToBackend(items);
  if(result){
    const insertedCount = result.inserted_count ?? 0;
    const skippedCount = result.skipped_count ?? 0;
    let msg = `✅ ${insertedCount} ta savol qo'shildi`;
    if(skippedCount > 0) msg += ` — ${skippedCount} ta takroriy savol (allaqachon bor edi) o'tkazib yuborildi`;
    toast(msg, 7000);
    // Yangi mavzular avtomatik yaratilgan bo'lishi mumkin — shu sabab mavzular va
    // savollarni backenddan to'liq qayta yuklab, ekranni yangilaymiz (optimistik
    // lokal qo'shish o'rniga — chunki mavzu id'lari oldindan noma'lum edi).
    const liveTopics = await loadGrammarTopicsFromBackend();
    applyLiveGrammarTopics(liveTopics);
    await refreshQiroaFromBackend();
    adminActiveSkill = skillId;
    renderAdminQuestions();
  } else {
    toast("⚠️ Backendga yuborilmadi: " + window.LAST_BACKEND_ERROR, 6000);
  }
  return false;
}

/* ================= LUG'ATLAR BAZASI (ADMIN & DATA LAYER) ================= */
let ADMIN_VOCABULARIES = [];
let adminVocabSearchQuery = '';
let adminVocabBookFilter = 'all';
let adminVocabTopicFilter = 'all';
let adminVocabExpandedBooks = new Set();
let adminVocabExpandedTopics = new Set();
let adminVocabInitializedExpand = false;

function getLocalVocabularies() {
  try {
    const raw = localStorage.getItem('arab_admin_vocabularies_v1');
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function saveLocalVocabularies(list) {
  try {
    localStorage.setItem('arab_admin_vocabularies_v1', JSON.stringify(list || []));
  } catch (e) {}
}

async function loadVocabulariesFromBackend() {
  if (SESSION_TOKEN) {
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_list_vocabularies`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({})
      });
      if (res.ok) {
        const rows = await res.json();
        if (Array.isArray(rows)) {
          ADMIN_VOCABULARIES = rows.map(r => ({
            id: r.id || r.vocab_id || String(Date.now() + Math.random()),
            book_name: r.book_name || r.book || '',
            description: r.description || r.desc || '',
            topic: r.topic || r.topic_name || '',
            word: r.word || r.arabic || r.word_ar || '',
            translation: r.translation || r.meaning || r.uz || '',
            created_at: r.created_at || new Date().toISOString()
          }));
          saveLocalVocabularies(ADMIN_VOCABULARIES);
          return ADMIN_VOCABULARIES;
        }
      }
    } catch (e) {
      console.warn("admin_list_vocabularies RPC mavjud emas yoki xatolik:", e);
    }
  }

  // Fallback to local storage
  ADMIN_VOCABULARIES = getLocalVocabularies();
  return ADMIN_VOCABULARIES;
}

async function saveVocabulariesBulkToBackend(items) {
  if (!items || !items.length) return null;

  if (SESSION_TOKEN) {
    try {
      const payload = items.map(it => ({
        p_book_name: it.book_name || it.book || '',
        p_description: it.description || it.desc || '',
        p_topic: it.topic || it.topic_name || '',
        p_word: it.word || it.word_ar || it.arabic || '',
        p_translation: it.translation || it.meaning || it.uz || ''
      }));

      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_bulk_add_vocabularies`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ p_items: payload })
      });

      if (res.ok) {
        const text = await res.text();
        const json = text ? JSON.parse(text) : { inserted_count: items.length };
        return json;
      } else {
        setLastBackendError(res.status, await res.text());
      }
    } catch (e) {
      setLastBackendError('—', e.message);
    }
  }

  // Fallback: Local storage persistence
  const existing = getLocalVocabularies();
  const newItems = items.map((it, idx) => ({
    id: it.id || 'voc_' + Date.now() + '_' + idx + '_' + Math.random().toString(36).substr(2, 4),
    book_name: it.book_name || it.book || '',
    description: it.description || it.desc || '',
    topic: it.topic || it.topic_name || '',
    word: it.word || it.word_ar || it.arabic || '',
    translation: it.translation || it.meaning || it.uz || '',
    created_at: new Date().toISOString()
  }));
  const merged = [...newItems, ...existing];
  saveLocalVocabularies(merged);
  ADMIN_VOCABULARIES = merged;
  return { inserted_count: items.length, local_fallback: true };
}

async function deleteVocabularyFromBackend(id) {
  if (SESSION_TOKEN) {
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_delete_vocabulary`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ p_id: id })
      });
      if (res.ok) {
        // Success
      }
    } catch (e) {
      console.warn("admin_delete_vocabulary RPC failed, removing locally", e);
    }
  }
  ADMIN_VOCABULARIES = ADMIN_VOCABULARIES.filter(v => String(v.id) !== String(id));
  saveLocalVocabularies(ADMIN_VOCABULARIES);
}

async function deleteVocabBookFromBackend(bookName) {
  if (SESSION_TOKEN) {
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_delete_vocabulary_book`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ p_book_name: bookName })
      });
      if (res.ok) {
        // Success
      }
    } catch (e) {
      console.warn("admin_delete_vocabulary_book RPC failed, removing locally", e);
    }
  }
  ADMIN_VOCABULARIES = ADMIN_VOCABULARIES.filter(v => (v.book_name || '') !== bookName);
  saveLocalVocabularies(ADMIN_VOCABULARIES);
}

async function deleteVocabTopicFromBackend(bookName, topicName) {
  if (SESSION_TOKEN) {
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_delete_vocabulary_topic`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ p_book_name: bookName, p_topic: topicName })
      });
      if (res.ok) {
        // Success
      }
    } catch (e) {
      console.warn("admin_delete_vocabulary_topic RPC failed, removing locally", e);
    }
  }
  ADMIN_VOCABULARIES = ADMIN_VOCABULARIES.filter(v => !((v.book_name || '') === bookName && (v.topic || '') === topicName));
  saveLocalVocabularies(ADMIN_VOCABULARIES);
}

async function updateVocabularyInBackend(id, fields) {
  if (SESSION_TOKEN) {
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_update_vocabulary`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          p_id: id,
          p_book_name: fields.book_name || '',
          p_description: fields.description || '',
          p_topic: fields.topic || '',
          p_word: fields.word || '',
          p_translation: fields.translation || ''
        })
      });
      if (res.ok) {
        // Success
      }
    } catch (e) {
      console.warn("admin_update_vocabulary RPC failed, updating locally", e);
    }
  }

  const idx = ADMIN_VOCABULARIES.findIndex(v => String(v.id) === String(id));
  if (idx !== -1) {
    ADMIN_VOCABULARIES[idx] = { ...ADMIN_VOCABULARIES[idx], ...fields };
    saveLocalVocabularies(ADMIN_VOCABULARIES);
  }
}

function getVocabTopicOrder(bookName) {
  try {
    const raw = localStorage.getItem('arab_vocab_topic_order');
    if (!raw) return [];
    const map = JSON.parse(raw);
    return Array.isArray(map[bookName]) ? map[bookName] : [];
  } catch (e) {
    return [];
  }
}

function saveVocabTopicOrder(bookName, orderArray) {
  try {
    const raw = localStorage.getItem('arab_vocab_topic_order');
    const map = raw ? JSON.parse(raw) : {};
    map[bookName] = orderArray;
    localStorage.setItem('arab_vocab_topic_order', JSON.stringify(map));
  } catch (e) {
    console.error("saveVocabTopicOrder error:", e);
  }

  // In-place sort in ADMIN_VOCABULARIES so items within the book preserve order without shifting other books
  if (Array.isArray(ADMIN_VOCABULARIES) && ADMIN_VOCABULARIES.length) {
    const bookWords = ADMIN_VOCABULARIES.filter(v => (v.book_name || '') === bookName);
    bookWords.sort((a, b) => {
      const topA = a.topic || '';
      const topB = b.topic || '';
      const ia = orderArray.indexOf(topA);
      const ib = orderArray.indexOf(topB);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return 0;
    });
    let bIdx = 0;
    ADMIN_VOCABULARIES = ADMIN_VOCABULARIES.map(v => {
      if ((v.book_name || '') === bookName) {
        return bookWords[bIdx++];
      }
      return v;
    });
    saveLocalVocabularies(ADMIN_VOCABULARIES);
  }
}

async function moveVocabTopic(bookName, topicName, dir) {
  // Keep the current book expanded so it doesn't close
  adminVocabExpandedBooks.add(bookName);
  // Do not force expand the topic items so it stays compact

  const words = (Array.isArray(ADMIN_VOCABULARIES) && ADMIN_VOCABULARIES.length) 
    ? ADMIN_VOCABULARIES.filter(v => (v.book_name || 'Umumiy kitob') === bookName)
    : getLocalVocabularies().filter(v => (v.book_name || 'Umumiy kitob') === bookName);

  const rawTopics = Array.from(new Set(words.map(v => (v.topic || 'Umumiy mavzu')).filter(Boolean)));
  const customOrder = getVocabTopicOrder(bookName);
  
  const currentList = rawTopics.sort((a, b) => {
    const ia = customOrder.indexOf(a);
    const ib = customOrder.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b, 'uz', { numeric: true });
  });

  const idx = currentList.indexOf(topicName);
  if (idx === -1) return;
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= currentList.length) return;

  const item = currentList.splice(idx, 1)[0];
  currentList.splice(newIdx, 0, item);

  saveVocabTopicOrder(bookName, currentList);
  await renderAdminVocabularies(false);
  toast("✅ Mavzu tartibi saqlandi", 1800);
}

function initVocabTopicDragDrop(bookBodyEl, bookName) {
  if (!bookBodyEl) return;
  const topicCards = Array.from(bookBodyEl.querySelectorAll('.vocab-topic-item[data-topic-name]'));
  if (topicCards.length <= 1) return;

  let dragEl = null;

  topicCards.forEach(card => {
    card.setAttribute('draggable', 'true');

    card.addEventListener('dragstart', function(e) {
      if (e.target.closest('button') || e.target.closest('input') || e.target.closest('table')) {
        e.preventDefault();
        return;
      }
      dragEl = this;
      this.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', this.dataset.topicName || '');
    });

    card.addEventListener('dragend', function() {
      this.classList.remove('dragging');
      bookBodyEl.querySelectorAll('.vocab-topic-item').forEach(el => {
        el.classList.remove('drag-over-top', 'drag-over-bottom');
      });
      dragEl = null;
      saveTopicOrderFromDOM(bookBodyEl, bookName);
    });

    card.addEventListener('dragover', function(e) {
      e.preventDefault();
      if (!dragEl || dragEl === this) return;
      const box = this.getBoundingClientRect();
      const mid = box.top + box.height / 2;
      if (e.clientY < mid) {
        this.classList.add('drag-over-top');
        this.classList.remove('drag-over-bottom');
        bookBodyEl.insertBefore(dragEl, this);
      } else {
        this.classList.add('drag-over-bottom');
        this.classList.remove('drag-over-top');
        bookBodyEl.insertBefore(dragEl, this.nextSibling);
      }
    });

    card.addEventListener('dragleave', function() {
      this.classList.remove('drag-over-top', 'drag-over-bottom');
    });

    // Touch Drag (Mobile)
    const handle = card.querySelector('.vocab-drag-handle') || card.querySelector('.vocab-topic-header');
    if (handle) {
      let touchStartY = 0;
      let isTouching = false;
      let activeTouchEl = null;

      handle.addEventListener('touchstart', function(e) {
        if (e.target.closest('button') || e.target.closest('input')) return;
        const touch = e.touches[0];
        touchStartY = touch.clientY;
        isTouching = true;
        activeTouchEl = card;
      }, { passive: true });

      handle.addEventListener('touchmove', function(e) {
        if (!isTouching || !activeTouchEl) return;
        const touch = e.touches[0];
        const deltaY = Math.abs(touch.clientY - touchStartY);
        if (deltaY > 10) {
          activeTouchEl.classList.add('dragging', 'touch-active-drag');
          const targetEl = document.elementFromPoint(touch.clientX, touch.clientY)?.closest('.vocab-topic-item');
          if (targetEl && targetEl !== activeTouchEl && targetEl.parentNode === bookBodyEl) {
            const box = targetEl.getBoundingClientRect();
            if (touch.clientY < box.top + box.height / 2) {
              bookBodyEl.insertBefore(activeTouchEl, targetEl);
            } else {
              bookBodyEl.insertBefore(activeTouchEl, targetEl.nextSibling);
            }
          }
        }
      }, { passive: true });

      handle.addEventListener('touchend', function() {
        if (activeTouchEl && activeTouchEl.classList.contains('dragging')) {
          activeTouchEl.classList.remove('dragging', 'touch-active-drag');
          saveTopicOrderFromDOM(bookBodyEl, bookName);
        }
        isTouching = false;
        activeTouchEl = null;
      });

      handle.addEventListener('touchcancel', function() {
        if (activeTouchEl) {
          activeTouchEl.classList.remove('dragging', 'touch-active-drag');
        }
        isTouching = false;
        activeTouchEl = null;
      });
    }
  });
}

function saveTopicOrderFromDOM(bookBodyEl, bookName) {
  if (!bookBodyEl) return;
  adminVocabExpandedBooks.add(bookName);
  const items = Array.from(bookBodyEl.querySelectorAll('.vocab-topic-item[data-topic-name]'));
  const newOrder = items.map(el => el.dataset.topicName).filter(Boolean);
  if (newOrder.length) {
    saveVocabTopicOrder(bookName, newOrder);
    renderAdminVocabularies(false);
    toast("✅ Mavzular tartibi saqlandi", 1800);
  }
}

function toggleAdminVocabBook(bookName) {
  if (adminVocabExpandedBooks.has(bookName)) {
    adminVocabExpandedBooks.delete(bookName);
  } else {
    adminVocabExpandedBooks.add(bookName);
  }
  renderAdminVocabularies(false);
}

function toggleAdminVocabTopic(bookName, topicName) {
  const key = `${bookName}:::${topicName}`;
  if (adminVocabExpandedTopics.has(key)) {
    adminVocabExpandedTopics.delete(key);
  } else {
    adminVocabExpandedTopics.add(key);
  }
  renderAdminVocabularies(false);
}

function toggleAllAdminVocabTrees(expandAll = true) {
  if (expandAll) {
    ADMIN_VOCABULARIES.forEach(v => {
      if (v.book_name) adminVocabExpandedBooks.add(v.book_name);
      if (v.book_name && v.topic) adminVocabExpandedTopics.add(`${v.book_name}:::${v.topic}`);
    });
  } else {
    adminVocabExpandedBooks.clear();
    adminVocabExpandedTopics.clear();
  }
  renderAdminVocabularies(false);
}

async function renderAdminVocabularies(rebuildFilters = true) {
  const container = document.getElementById('adminVocabTree');
  if (!container) return;

  if (!ADMIN_VOCABULARIES.length) {
    await loadVocabulariesFromBackend();
  }

  if (rebuildFilters) {
    updateAdminVocabFilterOptions();
  }

  const searchInput = document.getElementById('adminVocabSearch');
  adminVocabSearchQuery = (searchInput?.value || '').toLowerCase().trim();

  const bookSel = document.getElementById('adminVocabBookFilter');
  adminVocabBookFilter = bookSel?.value || 'all';

  const topicSel = document.getElementById('adminVocabTopicFilter');
  adminVocabTopicFilter = topicSel?.value || 'all';

  // Default initial expand: keep collapsed by default for clean and fast overview
  if (!adminVocabInitializedExpand) {
    adminVocabExpandedBooks.clear();
    adminVocabExpandedTopics.clear();
    adminVocabInitializedExpand = true;
  }

  // Filter items
  let filtered = ADMIN_VOCABULARIES.filter(v => {
    if (adminVocabBookFilter !== 'all' && (v.book_name || '') !== adminVocabBookFilter) return false;
    if (adminVocabTopicFilter !== 'all' && (v.topic || '') !== adminVocabTopicFilter) return false;
    if (adminVocabSearchQuery) {
      const fullText = `${v.book_name || ''} ${v.topic || ''} ${v.word || ''} ${v.translation || ''} ${v.description || ''}`.toLowerCase();
      if (!fullText.includes(adminVocabSearchQuery)) return false;
    }
    return true;
  });

  // Grouping: Book -> Topic -> Words
  const bookMap = new Map();
  let totalWordsCount = 0;
  let totalTopicsCount = 0;

  filtered.forEach(v => {
    const bookName = v.book_name || 'Umumiy kitob';
    const topicName = v.topic || 'Umumiy mavzu';

    if (!bookMap.has(bookName)) {
      bookMap.set(bookName, new Map());
    }
    const topicMap = bookMap.get(bookName);
    if (!topicMap.has(topicName)) {
      topicMap.set(topicName, []);
      totalTopicsCount++;
    }
    topicMap.get(topicName).push(v);
    totalWordsCount++;
  });

  const stats = document.getElementById('adminVocabStatsCount');
  if (stats) {
    stats.textContent = `${bookMap.size} ta kitob · ${totalTopicsCount} ta mavzu · ${totalWordsCount} ta lug'at`;
  }

  if (bookMap.size === 0) {
    container.innerHTML = `
      <div class="placeholder-card" style="padding:36px 16px;text-align:center;background:var(--card);border:1px solid var(--border);border-radius:16px;">
        <div style="font-size:32px;margin-bottom:8px;">📚</div>
        <h3 style="margin-bottom:6px;font-size:16px;font-weight:700;color:var(--text);">Lug'atlar topilmadi</h3>
        <p style="margin-bottom:16px;color:var(--text-faint);font-size:13px;">
          ${adminVocabSearchQuery ? "Qidiruv so'rovi bo'yicha hech qanday lug'at topilmadi." : "Hozircha tizimda kitoblar va lug'atlar mavjud emas."}
        </p>
        <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
          <button type="button" class="btn btn-primary" onclick="openAddVocabModal()">+ Yangi lug'at qo'shish</button>
          <button type="button" class="btn btn-outline" onclick="openBulkAddVocabModal()">Ommaviy yuklash (JSON)</button>
        </div>
      </div>
    `;
    return;
  }

  // If search is active, expand all matching groups automatically
  const isSearching = !!adminVocabSearchQuery;

  let html = '';

  const sortedBookEntries = Array.from(bookMap.entries()).sort(([bookA], [bookB]) => {
    return bookA.localeCompare(bookB, 'uz', { numeric: true, sensitivity: 'base' });
  });

  sortedBookEntries.forEach(([bookName, topicsMap]) => {
    let bookWordCount = 0;
    topicsMap.forEach(words => { bookWordCount += words.length; });
    const isBookExpanded = isSearching || adminVocabExpandedBooks.has(bookName);

    const customOrder = getVocabTopicOrder(bookName);
    const sortedTopicEntries = Array.from(topicsMap.entries()).sort(([topA], [topB]) => {
      const ia = customOrder.indexOf(topA);
      const ib = customOrder.indexOf(topB);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return 0;
    });

    const bookMenu = rowMenuBtn([
      { icon: IB_ICON_ADD, label: "+ So'z qo'shish", run: () => openAddVocabModal(bookName, '') },
      { icon: AS_ICON_PLUS || IB_ICON_ADD, label: "Ommaviy yuklash (JSON)", run: () => openBulkAddVocabModal(bookName, '') },
      { icon: IB_ICON_DEL, label: "Kitobni o'chirish", danger: true, run: () => confirmDeleteVocabBook(bookName) }
    ], bookName);

    html += `
      <div class="vocab-book-card ${isBookExpanded ? 'expanded' : ''}" id="vocabBookCard_${encodeURIComponent(bookName)}">
        <div class="vocab-book-header" onclick="toggleAdminVocabBook('${escapeHtml(bookName).replace(/'/g, "\\'")}')">
          <div class="vocab-book-title-wrap">
            <div class="vocab-book-icon">📚</div>
            <div>
              <div class="vocab-book-title">${escapeHtml(bookName)}</div>
              <div class="vocab-book-meta">
                <span class="vocab-badge indigo">${sortedTopicEntries.length} ta mavzu</span>
                <span class="vocab-badge emerald">${bookWordCount} ta so'z</span>
              </div>
            </div>
          </div>
          <div class="vocab-book-actions">
            <div class="icon-btn-row">
              ${bookMenu}
            </div>
            <div class="vocab-chevron">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>
            </div>
          </div>
        </div>

        <div class="vocab-book-body" id="vocabBookBody_${encodeURIComponent(bookName)}" data-book-name="${escapeHtml(bookName)}">
    `;

    sortedTopicEntries.forEach(([topicName, words], topicIdx) => {
      const topicKey = `${bookName}:::${topicName}`;
      const isTopicExpanded = isSearching || adminVocabExpandedTopics.has(topicKey);

      const topicMenu = rowMenuBtn([
        { icon: IB_ICON_ADD, label: "+ So'z qo'shish", run: () => openAddVocabModal(bookName, topicName) },
        { icon: IB_ICON_DEL, label: "Mavzuni o'chirish", danger: true, run: () => confirmDeleteVocabTopic(bookName, topicName) }
      ], topicName);

      html += `
        <div class="vocab-topic-item ${isTopicExpanded ? 'expanded' : ''}" 
             data-book-name="${escapeHtml(bookName)}" 
             data-topic-name="${escapeHtml(topicName)}">
          <div class="vocab-topic-header" onclick="toggleAdminVocabTopic('${escapeHtml(bookName).replace(/'/g, "\\'")}', '${escapeHtml(topicName).replace(/'/g, "\\'")}')">
            <div class="vocab-topic-title-wrap">
              <span class="vocab-drag-handle" onclick="event.stopPropagation()" title="Mavzuni surish uchun ushlab torting">⠿</span>
              <span class="vocab-topic-icon">📑</span>
              <span class="vocab-topic-title">${escapeHtml(topicName)}</span>
              <span class="vocab-badge" style="font-size:10.5px;">${words.length} ta so'z</span>
            </div>
            <div class="vocab-topic-actions">
              <div class="icon-btn-row">
                <button type="button" class="icon-btn ib-add" onclick="event.stopPropagation(); moveVocabTopic('${escapeHtml(bookName).replace(/'/g, "\\'")}', '${escapeHtml(topicName).replace(/'/g, "\\'")}', -1)" ${topicIdx === 0 ? 'disabled' : ''} title="Mavzuni yuqoriga surish">${IB_ICON_UP}</button>
                <button type="button" class="icon-btn ib-add" onclick="event.stopPropagation(); moveVocabTopic('${escapeHtml(bookName).replace(/'/g, "\\'")}', '${escapeHtml(topicName).replace(/'/g, "\\'")}', 1)" ${topicIdx === sortedTopicEntries.length - 1 ? 'disabled' : ''} title="Mavzuni pastga surish">${IB_ICON_DOWN}</button>
                ${topicMenu}
              </div>
              <div class="vocab-chevron">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>
              </div>
            </div>
          </div>

          <div class="vocab-topic-body">
            <div style="overflow-x:auto;">
              <table class="vocab-words-table">
                <thead>
                  <tr>
                    <th style="text-align:right;width:28%;min-width:140px;">Arabcha so'z</th>
                    <th style="text-align:left;width:30%;min-width:150px;">Tarjimasi</th>
                    <th style="text-align:left;min-width:160px;">Tavsifi / Izoh</th>
                    <th style="text-align:center;width:90px;">Amallar</th>
                  </tr>
                </thead>
                <tbody>
                  ${words.map(w => `
                    <tr>
                      <td style="text-align:right;">
                        <div style="font-family:'Noto Sans Arabic','Noto Sans',sans-serif;font-size:16px;font-weight:700;color:var(--emerald-700, #047857);direction:rtl;" class="notranslate">
                          ${escapeHtml(w.word || '—')}
                        </div>
                      </td>
                      <td>
                        <div style="font-weight:600;color:var(--text);font-size:13px;">
                          ${escapeHtml(w.translation || '—')}
                        </div>
                      </td>
                      <td>
                        <div style="font-size:12px;color:var(--text-faint);line-height:1.4;">
                          ${w.description ? escapeHtml(w.description) : '<span style="opacity:0.4;">—</span>'}
                        </div>
                      </td>
                      <td style="text-align:center;white-space:nowrap;">
                        <div class="icon-btn-row" style="justify-content:center;gap:5px;">
                          <button type="button" class="icon-btn ib-edit" style="width:30px;height:30px;" onclick="openEditVocabModal('${w.id}')" title="Tahrirlash">${IB_ICON_EDIT}</button>
                          <button type="button" class="icon-btn ib-del" style="width:30px;height:30px;" onclick="confirmDeleteVocab('${w.id}')" title="O'chirish">${IB_ICON_DEL}</button>
                        </div>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      `;
    });

    html += `
        </div>
      </div>
    `;
  });

  container.innerHTML = html;

  // Initialize drag & drop for each rendered book body
  container.querySelectorAll('.vocab-book-body[data-book-name]').forEach(bodyEl => {
    const bName = bodyEl.dataset.bookName;
    if (bName) {
      initVocabTopicDragDrop(bodyEl, bName);
    }
  });
}

function updateAdminVocabFilterOptions() {
  const bookSel = document.getElementById('adminVocabBookFilter');
  const topicSel = document.getElementById('adminVocabTopicFilter');
  if (!bookSel || !topicSel) return;

  const currentBook = bookSel.value || 'all';
  const currentTopic = topicSel.value || 'all';

  const books = Array.from(new Set(ADMIN_VOCABULARIES.map(v => v.book_name).filter(Boolean))).sort();
  bookSel.innerHTML = `<option value="all">Barcha kitoblar (${ADMIN_VOCABULARIES.length})</option>` +
    books.map(b => `<option value="${escapeHtml(b)}" ${b === currentBook ? 'selected' : ''}>${escapeHtml(b)}</option>`).join('');

  let relevantTopics;
  if (currentBook !== 'all') {
    const rawT = Array.from(new Set(ADMIN_VOCABULARIES.filter(v => v.book_name === currentBook).map(v => v.topic).filter(Boolean)));
    const cOrder = getVocabTopicOrder(currentBook);
    relevantTopics = rawT.sort((a, b) => {
      const ia = cOrder.indexOf(a);
      const ib = cOrder.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.localeCompare(b);
    });
  } else {
    relevantTopics = Array.from(new Set(ADMIN_VOCABULARIES.map(v => v.topic).filter(Boolean))).sort();
  }

  topicSel.innerHTML = `<option value="all">Barcha mavzular</option>` +
    relevantTopics.map(t => `<option value="${escapeHtml(t)}" ${t === currentTopic ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('');
}

function onAdminVocabBookFilterChange() {
  const topicSel = document.getElementById('adminVocabTopicFilter');
  if (topicSel) topicSel.value = 'all';
  renderAdminVocabularies(true);
}

function openAddVocabModal(defaultBook = '', defaultTopic = '') {
  document.getElementById('modalTitle').textContent = "Yangi lug'at qo'shish";
  document.getElementById('modalBody').innerHTML = `
    <form id="addVocabForm" style="display:flex;flex-direction:column;gap:14px;padding:6px 4px;" onsubmit="return submitAddVocab(event)">
      <div class="form-field">
        <label>Kitob nomi <span style="color:var(--red);">*</span></label>
        <input type="text" id="vBookName" value="${escapeHtml(defaultBook)}" placeholder="Masalan: Durusul lug'ah 1-jild" required list="vocabBookSuggestions">
        <datalist id="vocabBookSuggestions">
          ${Array.from(new Set(ADMIN_VOCABULARIES.map(v => v.book_name).filter(Boolean))).map(b => `<option value="${escapeHtml(b)}">`).join('')}
        </datalist>
      </div>

      <div class="form-field">
        <label>Lug'at mavzusi <span style="color:var(--red);">*</span></label>
        <input type="text" id="vTopic" value="${escapeHtml(defaultTopic)}" placeholder="Masalan: 1-dars: Uy jihozlari" required list="vocabTopicSuggestions">
        <datalist id="vocabTopicSuggestions">
          ${Array.from(new Set(ADMIN_VOCABULARIES.map(v => v.topic).filter(Boolean))).map(t => `<option value="${escapeHtml(t)}">`).join('')}
        </datalist>
      </div>

      <div class="form-field">
        <label>Lug'at (Arabcha so'z) <span style="color:var(--red);">*</span></label>
        <input type="text" id="vWord" dir="rtl" placeholder="بَيْتٌ" required style="font-family:'Noto Sans Arabic','Noto Sans',sans-serif;font-size:17px;font-weight:700;">
      </div>

      <div class="form-field">
        <label>Tarjimasi (O'zbekcha) <span style="color:var(--red);">*</span></label>
        <input type="text" id="vTranslation" placeholder="Uy / hovli" required>
      </div>

      <div class="form-field">
        <label>Tavsifi (Izoh / qo'shimcha ma'lumot)</label>
        <textarea id="vDescription" rows="3" placeholder="Masalan: Ko'pligi: بُيُوتٌ (buyutun). Ism jinsida muzakkar."></textarea>
      </div>

      <button type="submit" class="btn btn-primary btn-block">Lug'atni saqlash</button>
    </form>
  `;
  document.getElementById('modalOverlay').classList.add('show');
}

async function submitAddVocab(e) {
  e.preventDefault();
  const book = document.getElementById('vBookName')?.value.trim();
  const topic = document.getElementById('vTopic')?.value.trim();
  const word = document.getElementById('vWord')?.value.trim();
  const translation = document.getElementById('vTranslation')?.value.trim();
  const description = document.getElementById('vDescription')?.value.trim() || '';

  if (!book || !topic || !word || !translation) {
    toast("❌ Barcha majburiy maydonlarni to'ldiring");
    return false;
  }

  const item = {
    book_name: book,
    topic: topic,
    word: word,
    translation: translation,
    description: description
  };

  closeModal();
  toast("⏳ Lug'at saqlanmoqda...");
  const res = await saveVocabulariesBulkToBackend([item]);
  if (res) {
    adminVocabExpandedBooks.add(book);
    adminVocabExpandedTopics.add(`${book}:::${topic}`);
    toast("✅ Yangi lug'at qo'shildi!");
    await renderAdminVocabularies(true);
  } else {
    toast("⚠️ Saqlashda xatolik yuz berdi: " + (window.LAST_BACKEND_ERROR || ''));
  }
  return false;
}

function openBulkAddVocabModal(defaultBook = '', defaultTopic = '') {
  document.getElementById('modalTitle').textContent = "Lug'atlarni ommaviy qo'shish (Bulk / JSON)";
  document.getElementById('modalBody').innerHTML = `
    <form id="bulkVocabForm" style="display:flex;flex-direction:column;gap:14px;padding:6px 4px;" onsubmit="return submitBulkVocab(event)">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div class="form-field">
          <label>Standart kitob nomi (ixtiyoriy)</label>
          <input type="text" id="bvDefaultBook" value="${escapeHtml(defaultBook)}" placeholder="Masalan: Durusul lug'ah" list="vocabBookSuggestions">
          <div style="font-size:11px;color:var(--text-faint);margin-top:4px;">JSON'da kitob ko'rsatilmagan bo'lsa ishlatiladi</div>
        </div>
        <div class="form-field">
          <label>Standart mavzu (ixtiyoriy)</label>
          <input type="text" id="bvDefaultTopic" value="${escapeHtml(defaultTopic)}" placeholder="Masalan: 1-dars" list="vocabTopicSuggestions">
          <div style="font-size:11px;color:var(--text-faint);margin-top:4px;">JSON'da mavzu ko'rsatilmagan bo'lsa ishlatiladi</div>
        </div>
      </div>

      <div class="form-field">
        <label>Lug'atlar (JSON massiv)</label>
        <textarea id="bvJson" rows="13" placeholder='[
  {
    "book_name": "${escapeHtml(defaultBook || "Durusul lug'ah 1")}",
    "topic": "${escapeHtml(defaultTopic || "1-dars")}",
    "word": "بَيْتٌ",
    "translation": "Uy",
    "description": "Ko\\'pligi: بُيُوتٌ"
  },
  {
    "book_name": "${escapeHtml(defaultBook || "Durusul lug'ah 1")}",
    "topic": "${escapeHtml(defaultTopic || "1-dars")}",
    "word": "مَسْجِدٌ",
    "translation": "Masjid",
    "description": "Ko\\'pligi: مَسَاجِدُ"
  },
  {
    "book_name": "${escapeHtml(defaultBook || "Durusul lug'ah 1")}",
    "topic": "${escapeHtml(defaultTopic || "1-dars")}",
    "word": "بَابٌ",
    "translation": "Eshik",
    "description": "Ko\\'pligi: أَبْوَابٌ"
  }
]' required style="font-family:monospace;font-size:12.5px;direction:ltr;"></textarea>
        <div style="font-size:11.5px;color:var(--text-faint);margin-top:6px;line-height:1.5;">
          Har bir element parametrlari:<br>
          • <b>book_name</b> (yoki <b>book</b>) — Kitob nomi<br>
          • <b>topic</b> (yoki <b>mavzu</b>) — Lug'at mavzusi / dars<br>
          • <b>word</b> (yoki <b>lugat</b>, <b>arabic</b>) — Arabcha so'z<br>
          • <b>translation</b> (yoki <b>tarjimasi</b>, <b>uz</b>) — Tarjimasi<br>
          • <b>description</b> (yoki <b>tavsifi</b>) — Tavsifi / qo'shimcha ma'lumot (ixtiyoriy)
        </div>
      </div>

      <button type="submit" class="btn btn-primary btn-block">Barcha lug'atlarni saqlash</button>
    </form>
  `;
  document.getElementById('modalOverlay').classList.add('show');
}

async function submitBulkVocab(e) {
  e.preventDefault();
  const defaultBook = document.getElementById('bvDefaultBook')?.value.trim() || '';
  const defaultTopic = document.getElementById('bvDefaultTopic')?.value.trim() || '';
  const rawJson = document.getElementById('bvJson')?.value.trim();

  let parsed;
  try {
    parsed = JSON.parse(rawJson);
    if (!Array.isArray(parsed) || !parsed.length) throw new Error('Massiv bo\'sh');
  } catch (err) {
    toast("❌ JSON formati noto'g'ri: " + err.message, 6000);
    return false;
  }

  const items = [];
  for (let i = 0; i < parsed.length; i++) {
    const row = parsed[i];
    const book = row.book_name || row.book || row.kitob || defaultBook;
    const topic = row.topic || row.mavzu || row.topic_name || defaultTopic;
    const word = row.word || row.lugat || row.word_ar || row.arabic || '';
    const translation = row.translation || row.tarjimasi || row.meaning || row.uz || '';
    const description = row.description || row.tavsifi || row.desc || '';

    if (!word || !translation) {
      toast(`❌ ${i + 1}-qatorda arabcha so'z yoki tarjimasi kiritilmagan`, 6000);
      return false;
    }

    items.push({
      book_name: book || 'Umumiy kitob',
      topic: topic || 'Umumiy mavzu',
      word: word,
      translation: translation,
      description: description
    });
  }

  closeModal();
  toast(`⏳ ${items.length} ta lug'at yuklanmoqda...`);

  const res = await saveVocabulariesBulkToBackend(items);
  if (res) {
    const count = res.inserted_count ?? items.length;
    items.forEach(it => {
      adminVocabExpandedBooks.add(it.book_name);
      adminVocabExpandedTopics.add(`${it.book_name}:::${it.topic}`);
    });
    toast(`✅ ${count} ta lug'at muvaffaqiyatli saqlandi!`, 6000);
    await renderAdminVocabularies(true);
  } else {
    toast("⚠️ Backendga yuborilmadi: " + (window.LAST_BACKEND_ERROR || ''));
  }
  return false;
}

function openEditVocabModal(id) {
  const item = ADMIN_VOCABULARIES.find(v => String(v.id) === String(id));
  if (!item) return;

  document.getElementById('modalTitle').textContent = "Lug'atni tahrirlash";
  document.getElementById('modalBody').innerHTML = `
    <form id="editVocabForm" style="display:flex;flex-direction:column;gap:14px;padding:6px 4px;" onsubmit="return submitEditVocab(event, '${id}')">
      <div class="form-field">
        <label>Kitob nomi <span style="color:var(--red);">*</span></label>
        <input type="text" id="evBookName" value="${escapeHtml(item.book_name || '')}" required>
      </div>

      <div class="form-field">
        <label>Lug'at mavzusi <span style="color:var(--red);">*</span></label>
        <input type="text" id="evTopic" value="${escapeHtml(item.topic || '')}" required>
      </div>

      <div class="form-field">
        <label>Lug'at (Arabcha so'z) <span style="color:var(--red);">*</span></label>
        <input type="text" id="evWord" dir="rtl" value="${escapeHtml(item.word || '')}" required style="font-family:'Noto Sans Arabic','Noto Sans',sans-serif;font-size:17px;font-weight:700;">
      </div>

      <div class="form-field">
        <label>Tarjimasi (O'zbekcha) <span style="color:var(--red);">*</span></label>
        <input type="text" id="evTranslation" value="${escapeHtml(item.translation || '')}" required>
      </div>

      <div class="form-field">
        <label>Tavsifi (Izoh / qo'shimcha ma'lumot)</label>
        <textarea id="evDescription" rows="3">${escapeHtml(item.description || '')}</textarea>
      </div>

      <div style="display:flex;gap:10px;margin-top:6px;">
        <button type="button" class="btn btn-outline" style="flex:1;" onclick="closeModal()">Bekor qilish</button>
        <button type="submit" class="btn btn-primary" style="flex:1;">O'zgarishlarni saqlash</button>
      </div>
    </form>
  `;
  document.getElementById('modalOverlay').classList.add('show');
}

async function submitEditVocab(e, id) {
  e.preventDefault();
  const book = document.getElementById('evBookName')?.value.trim();
  const topic = document.getElementById('evTopic')?.value.trim();
  const word = document.getElementById('evWord')?.value.trim();
  const translation = document.getElementById('evTranslation')?.value.trim();
  const description = document.getElementById('evDescription')?.value.trim() || '';

  if (!book || !topic || !word || !translation) {
    toast("❌ Majburiy maydonlarni to'ldiring");
    return false;
  }

  closeModal();
  toast("⏳ Saqlanmoqda...");
  await updateVocabularyInBackend(id, {
    book_name: book,
    topic: topic,
    word: word,
    translation: translation,
    description: description
  });
  toast("✅ Lug'at muvaffaqiyatli yangilandi!");
  await renderAdminVocabularies(true);
  return false;
}

async function confirmDeleteVocab(id) {
  const item = ADMIN_VOCABULARIES.find(v => String(v.id) === String(id));
  if (!item) return;

  const ok = typeof showLiquidConfirm === 'function'
    ? await showLiquidConfirm({
        title: "Lug'atni o'chirish",
        message: `"${item.word}" (${item.translation}) lug'atini o'chirmoqchimisiz?`,
        subtext: "Bu amal orqali lug'at bazadan butunlay o'chiriladi.",
        confirmLabel: "Ha, o'chirilsin",
        cancelLabel: "Bekor qilish",
        isDanger: true
      })
    : confirm(`"${item.word}" lug'atini o'chirmoqchimisiz?`);

  if (!ok) return;

  toast("⏳ O'chirilmoqda...");
  await deleteVocabularyFromBackend(id);
  toast("✅ Lug'at o'chirildi");
  await renderAdminVocabularies(true);
}

async function confirmDeleteVocabBook(bookName) {
  const wordsInBook = ADMIN_VOCABULARIES.filter(v => (v.book_name || '') === bookName);
  const count = wordsInBook.length;

  const ok = typeof showLiquidConfirm === 'function'
    ? await showLiquidConfirm({
        title: "Kitobni o'chirish",
        message: `"${bookName}" kitobi va uning ichidagi barcha ${count} ta lug'atni o'chirmoqchimisiz?`,
        subtext: "Bu amal orqali kitob va uning barcha mavzulari hamda so'zlari butunlay o'chiriladi.",
        confirmLabel: "Ha, butunlay o'chirilsin",
        cancelLabel: "Bekor qilish",
        isDanger: true
      })
    : confirm(`"${bookName}" kitobini barcha ${count} ta lug'ati bilan o'chirishni tasdiqlaysizmi?`);

  if (!ok) return;

  toast("⏳ Kitob o'chirilmoqda...");
  await deleteVocabBookFromBackend(bookName);
  adminVocabExpandedBooks.delete(bookName);
  toast(`✅ "${bookName}" kitobi barcha so'zlari bilan o'chirildi`);
  await renderAdminVocabularies(true);
}

async function confirmDeleteVocabTopic(bookName, topicName) {
  const wordsInTopic = ADMIN_VOCABULARIES.filter(v => (v.book_name || '') === bookName && (v.topic || '') === topicName);
  const count = wordsInTopic.length;

  const ok = typeof showLiquidConfirm === 'function'
    ? await showLiquidConfirm({
        title: "Mavzuni o'chirish",
        message: `"${topicName}" mavzusidagi barcha ${count} ta lug'atni o'chirmoqchimisiz?`,
        subtext: `Kitob: "${bookName}". Ushbu mavzudagi barcha lug'atlar o'chiriladi.`,
        confirmLabel: "Ha, mavzuni o'chirish",
        cancelLabel: "Bekor qilish",
        isDanger: true
      })
    : confirm(`"${topicName}" mavzusini (${count} ta so'z) o'chirishni tasdiqlaysizmi?`);

  if (!ok) return;

  toast("⏳ Mavzu o'chirilmoqda...");
  await deleteVocabTopicFromBackend(bookName, topicName);
  adminVocabExpandedTopics.delete(`${bookName}:::${topicName}`);
  toast(`✅ "${topicName}" mavzusi o'chirildi`);
  await renderAdminVocabularies(true);
}

/* ================= ADMIN IMTIHON XABARLARI BOSHQARUV TIZIMI ================= */
const REPORT_STATUS_CONFIG = {
  yangi: { label: 'Yangi', color: '#EF4444', bg: 'rgba(239,68,68,0.1)', border: 'rgba(239,68,68,0.25)', dot: '#EF4444' },
  korildi: { label: 'Ko\u2018rib chiqildi', color: '#3B82F6', bg: 'rgba(59,130,246,0.1)', border: 'rgba(59,130,246,0.25)', dot: '#3B82F6' },
  qoshildi: { label: 'Bankka qo\u2018shildi', color: '#10B981', bg: 'rgba(16,185,129,0.1)', border: 'rgba(16,185,129,0.25)', dot: '#10B981' },
  arxiv: { label: 'Arxiv', color: '#6B7280', bg: 'rgba(107,114,128,0.1)', border: 'rgba(107,114,128,0.25)', dot: '#6B7280' }
};

let rawExamReportsData = [];
let adminReportSearchQuery = '';
let adminReportStatusFilter = 'all';
let adminReportExamFilter = 'all';
let adminReportSectionFilter = 'all';
let adminReportSortOrder = 'newest';

function getExamReportsMeta(){
  try{
    return JSON.parse(localStorage.getItem('arab_exam_reports_meta_v2') || '{}');
  }catch(e){
    return {};
  }
}
function saveExamReportsMeta(meta){
  try{
    localStorage.setItem('arab_exam_reports_meta_v2', JSON.stringify(meta));
  }catch(e){}
}

function getReportKey(r){
  if(r.id) return String(r.id);
  const base = `${r.type||r.exam_type||''}_${r.date||r.exam_date||''}_${r.userId||r.user_id||r.name||''}_${r.rawCreatedAt||r.created_at||''}`;
  return base.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function getReportMetaItem(reportKey){
  const meta = getExamReportsMeta();
  return meta[reportKey] || { status: 'yangi', note: '', deleted: false };
}

function updateReportMetaItem(reportKey, changes){
  const meta = getExamReportsMeta();
  meta[reportKey] = { ...(meta[reportKey] || { status: 'yangi', note: '', deleted: false }), ...changes };
  saveExamReportsMeta(meta);
  updateAdminReportsBadge();
}

function updateAdminReportsBadge(){
  const badge = document.getElementById('adminReportsTabBadge');
  const sub = document.getElementById('adminReportsTabSub');
  if(!badge) return;
  const meta = getExamReportsMeta();
  let unreadCount = 0;
  let totalActive = 0;
  rawExamReportsData.forEach(r => {
    const k = getReportKey(r);
    const m = meta[k] || { status: 'yangi', deleted: false };
    if(!m.deleted){
      totalActive++;
      if(m.status === 'yangi') unreadCount++;
    }
  });

  if(unreadCount > 0){
    badge.style.display = 'inline-flex';
    badge.textContent = `${unreadCount} yangi`;
    if(sub) sub.textContent = `${unreadCount} ta yangi hisobot`;
  } else {
    badge.style.display = totalActive > 0 ? 'inline-flex' : 'none';
    badge.style.background = 'var(--indigo-600)';
    badge.textContent = `${totalActive} ta`;
    if(sub) sub.textContent = totalActive > 0 ? `${totalActive} ta xabar mavjud` : `O\u2018quvchi hisobotlari`;
  }
}

/* Admin — real imtihon xabarlari ro'yxati (backend: admin_list_exam_reports RPC). */
async function loadExamReportsFromBackend(){
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_list_exam_reports`, {
    method:"POST", headers: authHeaders(), body: JSON.stringify({})
  });
  if(!res.ok){
    const errText = await res.text().catch(()=> '');
    throw new Error(errText || ('HTTP ' + res.status));
  }
  return await res.json();
}

async function renderAdminReports(){
  const list = document.getElementById('adminReportsList');
  if(!list) return;

  list.innerHTML = `<div class="card" style="padding:24px;text-align:center;"><p style="color:var(--text-faint);font-size:13px;font-weight:500;">Xabarlar yuklanmoqda...</p></div>`;

  let rows;
  try{
    rows = await loadExamReportsFromBackend();
    rawExamReportsData = (Array.isArray(rows) ? rows : []).map(r => ({
      id: r.id || null,
      userId: r.user_id || r.userId || null,
      type: r.exam_type || r.type || 'Noma\u2018lum',
      date: r.exam_date || r.date || '',
      center: r.center || '',
      sections: Array.isArray(r.sections) ? r.sections : (r.sections ? [r.sections] : []),
      seat: r.seat || '',
      text: r.report_text || r.text || '',
      rawCreatedAt: r.created_at || '',
      submittedAt: r.created_at ? new Date(r.created_at).toLocaleString('uz-UZ') : '',
      name: r.name || 'Noma\u2018lum foydalanuvchi',
      username: (r.username || '').replace(/^@+/, ''),
    }));
  }catch(e){
    console.error(e);
    list.innerHTML = `<div class="placeholder-card"><svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="var(--red)" stroke-width="2" style="margin-bottom:8px;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg><h3>Xabarlarni yuklab bo'lmadi</h3><p style="word-break:break-word;">${escapeHtml(e.message || 'Nomalum xato')}</p></div>`;
    return;
  }

  updateAdminReportsBadge();
  renderAdminReportsContent();
}

function renderAdminReportsContent(){
  const list = document.getElementById('adminReportsList');
  const statsContainer = document.getElementById('adminReportStatsStrip');
  const filterContainer = document.getElementById('adminReportFilterBar');
  if(!list) return;

  const meta = getExamReportsMeta();
  const allReports = rawExamReportsData.map(r => {
    const k = getReportKey(r);
    const m = meta[k] || { status: 'yangi', note: '', deleted: false };
    return { ...r, reportKey: k, status: m.status || 'yangi', note: m.note || '', deleted: !!m.deleted };
  });

  const activeReports = allReports.filter(r => !r.deleted);

  // Stats calculation
  const totalCount = activeReports.length;
  const yangiCount = activeReports.filter(r => r.status === 'yangi').length;
  const korildiCount = activeReports.filter(r => r.status === 'korildi').length;
  const qoshildiCount = activeReports.filter(r => r.status === 'qoshildi').length;
  const arxivCount = activeReports.filter(r => r.status === 'arxiv').length;

  if(statsContainer){
    statsContainer.innerHTML = `
      <div class="report-stat-pill">
        <div class="lbl-wrap">
          <span class="report-stat-dot" style="background:var(--indigo-500);"></span>
          <span class="lbl">Jami xabarlar</span>
        </div>
        <span class="num">${totalCount}</span>
      </div>
      <div class="report-stat-pill">
        <div class="lbl-wrap">
          <span class="report-stat-dot" style="background:${REPORT_STATUS_CONFIG.yangi.dot};"></span>
          <span class="lbl">Yangi</span>
        </div>
        <span class="num" style="color:${REPORT_STATUS_CONFIG.yangi.color};">${yangiCount}</span>
      </div>
      <div class="report-stat-pill">
        <div class="lbl-wrap">
          <span class="report-stat-dot" style="background:${REPORT_STATUS_CONFIG.korildi.dot};"></span>
          <span class="lbl">Ko\u2018rib chiqildi</span>
        </div>
        <span class="num" style="color:${REPORT_STATUS_CONFIG.korildi.color};">${korildiCount}</span>
      </div>
      <div class="report-stat-pill">
        <div class="lbl-wrap">
          <span class="report-stat-dot" style="background:${REPORT_STATUS_CONFIG.qoshildi.dot};"></span>
          <span class="lbl">Bankka qo\u2018shildi</span>
        </div>
        <span class="num" style="color:${REPORT_STATUS_CONFIG.qoshildi.color};">${qoshildiCount}</span>
      </div>
      <div class="report-stat-pill">
        <div class="lbl-wrap">
          <span class="report-stat-dot" style="background:${REPORT_STATUS_CONFIG.arxiv.dot};"></span>
          <span class="lbl">Arxiv</span>
        </div>
        <span class="num" style="color:${REPORT_STATUS_CONFIG.arxiv.color};">${arxivCount}</span>
      </div>
    `;
  }

  // Unique exams & sections for filters
  const uniqueExams = Array.from(new Set(activeReports.map(r => r.type).filter(Boolean)));
  const uniqueSections = Array.from(new Set(activeReports.flatMap(r => r.sections).filter(Boolean)));

  if(filterContainer){
    filterContainer.innerHTML = `
      <div class="report-search-wrap">
        <span class="report-search-icon">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        </span>
        <input type="text" placeholder="Xabar matni, ism, @username yoki sana bo\u2018yicha qidiruv..." value="${escapeHtml(adminReportSearchQuery)}" oninput="handleReportSearch(this.value)">
        ${adminReportSearchQuery ? `<button class="report-search-clear" onclick="clearReportSearch()" title="Tozalash"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg></button>` : ''}
      </div>

      <div class="report-status-pills">
        <button class="report-status-btn ${adminReportStatusFilter==='all'?'active':''}" onclick="setAdminReportStatusFilter('all')">
          Barchasi <span class="badge-num">${totalCount}</span>
        </button>
        <button class="report-status-btn ${adminReportStatusFilter==='yangi'?'active':''}" onclick="setAdminReportStatusFilter('yangi')">
          Yangi <span class="badge-num">${yangiCount}</span>
        </button>
        <button class="report-status-btn ${adminReportStatusFilter==='korildi'?'active':''}" onclick="setAdminReportStatusFilter('korildi')">
          Ko\u2018rib chiqildi <span class="badge-num">${korildiCount}</span>
        </button>
        <button class="report-status-btn ${adminReportStatusFilter==='qoshildi'?'active':''}" onclick="setAdminReportStatusFilter('qoshildi')">
          Bankka qo\u2018shildi <span class="badge-num">${qoshildiCount}</span>
        </button>
        <button class="report-status-btn ${adminReportStatusFilter==='arxiv'?'active':''}" onclick="setAdminReportStatusFilter('arxiv')">
          Arxiv <span class="badge-num">${arxivCount}</span>
        </button>
      </div>

      <div class="report-filter-dropdowns">
        <select class="report-filter-select" onchange="setAdminReportExamFilter(this.value)">
          <option value="all" ${adminReportExamFilter==='all'?'selected':''}>Barcha imtihonlar</option>
          ${uniqueExams.map(ex => `<option value="${escapeHtml(ex)}" ${adminReportExamFilter===ex?'selected':''}>${escapeHtml(ex)}</option>`).join('')}
        </select>

        <select class="report-filter-select" onchange="setAdminReportSectionFilter(this.value)">
          <option value="all" ${adminReportSectionFilter==='all'?'selected':''}>Barcha bo\u2018limlar</option>
          ${uniqueSections.map(sec => `<option value="${escapeHtml(sec)}" ${adminReportSectionFilter===sec?'selected':''}>${escapeHtml(sec)}</option>`).join('')}
        </select>

        <select class="report-filter-select" onchange="setAdminReportSortOrder(this.value)">
          <option value="newest" ${adminReportSortOrder==='newest'?'selected':''}>Eng yangilari oldinda</option>
          <option value="oldest" ${adminReportSortOrder==='oldest'?'selected':''}>Eng eskilari oldinda</option>
        </select>
      </div>
    `;
  }

  // Filtering
  let filtered = activeReports.filter(r => {
    if(adminReportStatusFilter !== 'all' && r.status !== adminReportStatusFilter) return false;
    if(adminReportExamFilter !== 'all' && r.type !== adminReportExamFilter) return false;
    if(adminReportSectionFilter !== 'all' && !r.sections.includes(adminReportSectionFilter)) return false;
    if(adminReportSearchQuery.trim()){
      const q = adminReportSearchQuery.toLowerCase();
      const matchText = (r.text||'').toLowerCase().includes(q);
      const matchName = (r.name||'').toLowerCase().includes(q);
      const matchUser = (r.username||'').toLowerCase().includes(q);
      const matchCenter = (r.center||'').toLowerCase().includes(q);
      const matchDate = (r.date||'').toLowerCase().includes(q);
      const matchSeat = (r.seat||'').toLowerCase().includes(q);
      const matchNote = (r.note||'').toLowerCase().includes(q);
      if(!matchText && !matchName && !matchUser && !matchCenter && !matchDate && !matchSeat && !matchNote) return false;
    }
    return true;
  });

  // Sorting
  filtered.sort((a, b) => {
    const timeA = a.rawCreatedAt ? new Date(a.rawCreatedAt).getTime() : 0;
    const timeB = b.rawCreatedAt ? new Date(b.rawCreatedAt).getTime() : 0;
    return adminReportSortOrder === 'oldest' ? (timeA - timeB) : (timeB - timeA);
  });

  if(filtered.length === 0){
    list.innerHTML = `
      <div class="placeholder-card" style="padding:36px 16px;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width:36px;height:36px;margin-bottom:8px;color:var(--text-faint);"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        <h3 style="font-size:14px;margin-bottom:4px;">Hech qanday xabar topilmadi</h3>
        <p style="font-size:12px;color:var(--text-dim);">Qidiruv yoki filtr parametrlarini o\u2018zgartirib ko\u2018ring.</p>
      </div>
    `;
    return;
  }

  list.innerHTML = filtered.map(r => {
    const statusCfg = REPORT_STATUS_CONFIG[r.status] || REPORT_STATUS_CONFIG.yangi;
    const tgUsernameClean = (r.username || '').replace(/^@+/, '');
    const tgProfileUrl = tgUsernameClean ? `https://t.me/${tgUsernameClean}` : (r.userId ? `tg://user?id=${r.userId}` : null);

    return `
      <div class="report-card-modern" id="reportCard_${r.reportKey}">
        <div class="report-card-top">
          <div class="report-user-wrap">
            <span class="report-user-name">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              ${escapeHtml(r.name || 'Foydalanuvchi')}
            </span>

            ${tgUsernameClean ? `
              <a href="${tgProfileUrl}" target="_blank" rel="noopener noreferrer" class="report-tg-link" title="Telegram profilini ochish">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.75-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z"/></svg>
                @${escapeHtml(tgUsernameClean)}
              </a>
            ` : (r.userId ? `<span style="font-size:11px;color:var(--text-faint);font-weight:600;">ID: ${r.userId}</span>` : '')}

            <span style="font-size:11.5px;color:var(--text-faint);display:inline-flex;align-items:center;gap:4px;">
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              ${escapeHtml(r.submittedAt)}
            </span>
          </div>

          <div style="display:flex;align-items:center;gap:6px;">
            <span class="report-status-badge" style="background:${statusCfg.bg};color:${statusCfg.color};border:1px solid ${statusCfg.border};">
              <span style="width:6px;height:6px;border-radius:50%;background:${statusCfg.dot};display:inline-block;"></span>
              ${statusCfg.label}
            </span>
            <select class="report-status-select" onchange="changeReportStatus('${r.reportKey}', this.value)">
              <option value="yangi" ${r.status==='yangi'?'selected':''}>Yangi</option>
              <option value="korildi" ${r.status==='korildi'?'selected':''}>Ko\u2018rib chiqildi</option>
              <option value="qoshildi" ${r.status==='qoshildi'?'selected':''}>Bankka qo\u2018shildi</option>
              <option value="arxiv" ${r.status==='arxiv'?'selected':''}>Arxiv</option>
            </select>
          </div>
        </div>

        <div class="report-meta-row">
          <span class="report-meta-pill" style="font-weight:600;color:var(--indigo-600);background:rgba(99,102,241,0.08);border-color:rgba(99,102,241,0.2);">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/></svg>
            ${escapeHtml(r.type)} imtihoni
          </span>
          ${r.date ? `
            <span class="report-meta-pill">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
              ${escapeHtml(r.date)}
            </span>
          ` : ''}
          ${r.center ? `
            <span class="report-meta-pill">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
              ${escapeHtml(r.center)}
            </span>
          ` : ''}
          ${r.seat ? `
            <span class="report-meta-pill">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="M15 3v18"/><path d="M3 9h18"/><path d="M3 15h18"/></svg>
              ${escapeHtml(r.seat)}
            </span>
          ` : ''}
          ${r.sections.map(s => `
            <span class="report-meta-pill">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="m19 21-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
              ${escapeHtml(s)}
            </span>
          `).join('')}
        </div>

        <div class="report-content-box">
          ${escapeHtml(r.text)}
        </div>

        <!-- Admin Internal Note -->
        <div class="report-note-container" id="noteContainer_${r.reportKey}">
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <span style="font-size:11px;font-weight:600;color:var(--text-dim);display:inline-flex;align-items:center;gap:4px;">
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              Ichki eslatma
            </span>
            <button class="btn btn-sm" style="padding:1px 6px;font-size:11px;background:none;border:none;color:var(--indigo-600);cursor:pointer;font-weight:600;" onclick="toggleEditReportNote('${r.reportKey}')">
              ${r.note ? 'Tahrirlash' : '+ Eslatma qo\u2018shish'}
            </button>
          </div>
          <div id="noteText_${r.reportKey}" class="report-note-text" style="${r.note ? '' : 'color:var(--text-faint);font-style:italic;'}">
            ${r.note ? escapeHtml(r.note) : 'Hali ichki eslatma yozilmagan'}
          </div>
          <div id="noteForm_${r.reportKey}" style="display:none;flex-direction:column;gap:6px;margin-top:4px;">
            <textarea id="noteInput_${r.reportKey}" style="width:100%;box-sizing:border-box;padding:6px 8px;border-radius:6px;border:1px solid var(--border);font-family:inherit;font-size:12px;" rows="2" placeholder="Ushbu xabar bo\u2018yicha admin izohi...">${escapeHtml(r.note || '')}</textarea>
            <div style="display:flex;gap:6px;justify-content:flex-end;">
              <button class="btn btn-sm" onclick="toggleEditReportNote('${r.reportKey}')" style="font-size:11px;padding:3px 8px;">Bekor qilish</button>
              <button class="btn btn-sm btn-primary" onclick="saveReportNote('${r.reportKey}')" style="font-size:11px;padding:3px 10px;">Saqlash</button>
            </div>
          </div>
        </div>

        <div class="report-action-buttons">
          <button class="report-btn report-btn-primary" onclick="openReportReplyModal('${r.reportKey}')" title="Foydalanuvchiga javob yozish">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            Javob yozish
          </button>

          <button class="report-btn report-btn-success" onclick="convertReportToQuestion('${r.reportKey}')" title="Savollar bankiga qo\u2018shish">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
            Savolga aylantirish
          </button>

          <button class="report-btn" onclick="copyReportDetails('${r.reportKey}')" title="Xabar matnini nusxalash">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            Nusxalash
          </button>

          ${r.status !== 'arxiv' ? `
            <button class="report-btn" onclick="changeReportStatus('${r.reportKey}', 'arxiv')" title="Arxivga o\u2018tkazish">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
              Arxivlash
            </button>
          ` : `
            <button class="report-btn" onclick="changeReportStatus('${r.reportKey}', 'yangi')" title="Arxivdan qaytarish">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
              Arxivdan chiqarish
            </button>
          `}

          <button class="report-btn report-btn-danger" style="margin-inline-start:auto;" onclick="deleteReportConfirm('${r.reportKey}')" title="Xabarni o\u2018chirish">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            O\u2018chirish
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function handleReportSearch(val){
  adminReportSearchQuery = val;
  renderAdminReportsContent();
}
function clearReportSearch(){
  adminReportSearchQuery = '';
  renderAdminReportsContent();
}
function setAdminReportStatusFilter(val){
  adminReportStatusFilter = val;
  renderAdminReportsContent();
}
function setAdminReportExamFilter(val){
  adminReportExamFilter = val;
  renderAdminReportsContent();
}
function setAdminReportSectionFilter(val){
  adminReportSectionFilter = val;
  renderAdminReportsContent();
}
function setAdminReportSortOrder(val){
  adminReportSortOrder = val;
  renderAdminReportsContent();
}

function changeReportStatus(reportKey, newStatus){
  updateReportMetaItem(reportKey, { status: newStatus });
  toast(`Holat o\u2018zgartirildi: ${REPORT_STATUS_CONFIG[newStatus]?.label || newStatus}`);
  renderAdminReportsContent();
}

function toggleEditReportNote(reportKey){
  const textEl = document.getElementById(`noteText_${reportKey}`);
  const formEl = document.getElementById(`noteForm_${reportKey}`);
  if(!textEl || !formEl) return;
  if(formEl.style.display === 'none' || !formEl.style.display){
    textEl.style.display = 'none';
    formEl.style.display = 'flex';
    const input = document.getElementById(`noteInput_${reportKey}`);
    if(input) input.focus();
  } else {
    textEl.style.display = 'block';
    formEl.style.display = 'none';
  }
}

function saveReportNote(reportKey){
  const input = document.getElementById(`noteInput_${reportKey}`);
  const val = input ? input.value.trim() : '';
  updateReportMetaItem(reportKey, { note: val });
  toast("Ichki eslatma saqlandi");
  renderAdminReportsContent();
}

async function deleteReportConfirm(reportKey){
  const ok = await showLiquidConfirm({
    title: "Xabarni o'chirish",
    message: "Haqiqatan ham ushbu xabarni ro\u2018yxatdan o\u2018chirmoqchimisiz?",
    subtext: "Bu amalni ortga qaytarib bo'lmaydi.",
    confirmLabel: "Ha, o'chirilsin",
    cancelLabel: "Bekor qilish",
    isDanger: true
  });
  if(!ok) return;
  updateReportMetaItem(reportKey, { deleted: true });
  toast("Xabar ro\u2018yxatdan o\u2018chirildi");
  renderAdminReportsContent();
}

function copyReportDetails(reportKey){
  const r = rawExamReportsData.find(x => getReportKey(x) === reportKey);
  if(!r) return;
  const meta = getReportMetaItem(reportKey);
  const text = `IMTIHON HISOBOTI\nImtihon: ${r.type}\nSana: ${r.date || '-'}\nMarkaz/Xona: ${r.center || '-'} ${r.seat ? '('+r.seat+')' : ''}\nYuboruvchi: ${r.name} ${r.username ? '(@'+r.username+')' : ''}\nBo'limlar: ${r.sections.join(', ')}\n\nXabar matni:\n${r.text}\n\n${meta.note ? 'Admin izohi: ' + meta.note : ''}`;
  
  navigator.clipboard.writeText(text).then(() => {
    toast("Xabar matni buferga nusxalandi");
  }).catch(() => {
    toast("Nusxalash imkoni bo'lmadi");
  });
}

function convertReportToQuestion(reportKey){
  const r = rawExamReportsData.find(x => getReportKey(x) === reportKey);
  if(!r) return;

  // Bo'limni aniqlash
  let detectedSkill = 'grammatika';
  const secStr = (r.sections || []).join(' ').toLowerCase();
  if(secStr.includes('qiroa') || secStr.includes('qiroat') || secStr.includes('matn')) detectedSkill = 'qiroa';
  else if(secStr.includes('istima') || secStr.includes('audio') || secStr.includes('tinglab')) detectedSkill = 'istima';
  else if(secStr.includes('muhavara') || secStr.includes('speaking') || secStr.includes('gapirish')) detectedSkill = 'muhavara';
  else if(secStr.includes('kitaba') || secStr.includes('yozish') || secStr.includes('insho')) detectedSkill = 'kitaba';

  // Savol matnini ajratish
  const presetText = r.text || '';
  const presetExp = `Manba: ${r.type} imtihoni (${r.date || 'real test'}). Yuboruvchi: ${r.name || 'O\u2018quvchi'}`;

  openAddQuestionModal(detectedSkill, null, presetText, ['', '', '', ''], presetExp, (newQ) => {
    updateReportMetaItem(reportKey, { status: 'qoshildi', note: (getReportMetaItem(reportKey).note ? getReportMetaItem(reportKey).note + ' | ' : '') + 'Savollar bankiga qo\u2018shildi' });
    toast("Savol bankka qo\u2018shildi va xabar holati yangilandi");
    renderAdminReportsContent();
  });
}

function openReportReplyModal(reportKey){
  const r = rawExamReportsData.find(x => getReportKey(x) === reportKey);
  if(!r) return;
  const tgUsernameClean = (r.username || '').replace(/^@+/, '');
  const tgProfileUrl = tgUsernameClean ? `https://t.me/${tgUsernameClean}` : (r.userId ? `tg://user?id=${r.userId}` : null);

  const tpl1 = "Assalomu alaykum! Haqiqiy imtihon savolini yuborganingiz uchun katta rahmat. Savol ko'rib chiqildi va savollar bankiga qo'shildi.";
  const tpl2 = "Tashakkur! Iltimos, bu savol qaysi bo'lim (masalan, Nahv yoki Sarf) bo'yicha tushganini aniqlashtira olasizmi?";
  const tpl3 = "Xabaringiz uchun rahmat! Taklifingiz va savolingiz tez orada platformaga kiritiladi.";

  document.getElementById('modalTitle').textContent = "Foydalanuvchiga javob yozish";
  document.getElementById('modalBody').innerHTML = `
    <div style="display:flex;flex-direction:column;gap:12px;padding:2px;">
      <div style="padding:10px 12px;border-radius:10px;background:var(--card-alt);border:1px solid var(--border);display:flex;flex-direction:column;gap:4px;">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;">
          <span style="font-weight:600;font-size:13px;color:var(--text);">Qabul qiluvchi: ${escapeHtml(r.name || 'Foydalanuvchi')}</span>
          ${tgUsernameClean ? `
            <a href="${tgProfileUrl}" target="_blank" rel="noopener noreferrer" class="report-tg-link">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.75-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z"/></svg>
              Telegramda yozish (@${escapeHtml(tgUsernameClean)})
            </a>
          ` : ''}
        </div>
        <div style="font-size:11.5px;color:var(--text-faint);">
          ${escapeHtml(r.type)} imtihoni ${r.date ? '(' + escapeHtml(r.date) + ')' : ''} ${r.userId ? '· ID: ' + r.userId : ''}
        </div>
      </div>

      <div style="display:flex;flex-direction:column;gap:5px;">
        <label style="font-size:11.5px;font-weight:600;color:var(--text-dim);">Tayyor shablonlar:</label>
        <button type="button" class="quick-template-chip" onclick="applyReplyTemplate('${escapeHtml(tpl1.replace(/'/g, "\\'"))}')">
          <b>Qo\u2018shildi:</b> "Savol ko'rib chiqildi va savollar bankiga qo'shildi."
        </button>
        <button type="button" class="quick-template-chip" onclick="applyReplyTemplate('${escapeHtml(tpl2.replace(/'/g, "\\'"))}')">
          <b>Aniqlashtirish:</b> "Savol qaysi bo'lim yoki mavzuga oid ekanini aniqlashtira olasizmi?"
        </button>
        <button type="button" class="quick-template-chip" onclick="applyReplyTemplate('${escapeHtml(tpl3.replace(/'/g, "\\'"))}')">
          <b>Tashakkur:</b> "Xabaringiz uchun rahmat, tez orada platformaga kiritiladi."
        </button>
      </div>

      <form onsubmit="return handleSendReportReply(event, '${r.reportKey}')" style="display:flex;flex-direction:column;gap:10px;">
        <div class="form-field">
          <label>Xabar sarlavhasi</label>
          <input type="text" id="replyMsgTitle" value="Imtihon hisobotingiz yuzasidan javob" required>
        </div>
        <div class="form-field">
          <label>Xabar matni</label>
          <textarea id="replyMsgBody" rows="3" placeholder="Foydalanuvchiga yuboriladigan javob xabari..." required></textarea>
        </div>
        <button type="submit" class="btn btn-primary btn-block" id="replySubmitBtn">
          Yuborish va ko\u2018rib chiqildi qilish
        </button>
      </form>
    </div>
  `;
  document.getElementById('modalOverlay').classList.add('show');
}

function applyReplyTemplate(text){
  const el = document.getElementById('replyMsgBody');
  if(el){
    el.value = text;
    el.focus();
  }
}

async function handleSendReportReply(e, reportKey){
  e.preventDefault();
  const r = rawExamReportsData.find(x => getReportKey(x) === reportKey);
  if(!r) return false;

  const title = document.getElementById('replyMsgTitle')?.value || 'Imtihon hisoboti';
  const body = document.getElementById('replyMsgBody')?.value || '';
  const btn = document.getElementById('replySubmitBtn');
  if(btn){
    btn.disabled = true;
    btn.textContent = "Yuborilmoqda...";
  }

  try{
    if(r.userId){
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_send_message`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          target_user_id: r.userId,
          title: title,
          body: body
        })
      });
      if(!res.ok){
        const errText = await res.text().catch(()=> '');
        console.warn("admin_send_message RPC xatosi:", errText);
      }
    }

    updateReportMetaItem(reportKey, { status: 'korildi' });
    closeModal();
    toast("Javob yuborildi va xabar holati yangilandi");
    renderAdminReportsContent();
  }catch(err){
    console.error(err);
    updateReportMetaItem(reportKey, { status: 'korildi' });
    closeModal();
    toast("Xabar ko\u2018rib chiqildi holatiga o\u2018tkazildi");
    renderAdminReportsContent();
  }
  return false;
}

/* ================= RANK (Reyting) ================= */
const RANK_COLORS = ['#A78BFA','#5FA6EE','#22C57F','#EB8C5E','#E3BE4E','#0E8F58','#F1706A'];
/* Super admin (ADMIN_TELEGRAM_IDS) uchun reytingda ko'rinadigan "tasdiqlangan"
   (premium uslubidagi) belgi — Telegram Premium yulduzchasiga o'xshash ko'k nishon. */
const VERIFIED_BADGE_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2.5px;flex-shrink:0;margin-inline-start:3px;" xmlns="http://www.w3.org/2000/svg"><path fill="#5FA6EE" d="M12 2 14.35 4.1 17.35 3.06 18.06 6.15 21 7.4 19.7 10.35 21.4 13.15 18.55 14.9 18.2 18.05 15.05 17.9 13.15 20.4 10.85 18.15 7.75 18.7 7.05 15.6 4 14.15 5.6 11.3 4.15 8.45 7.15 7.05 7.75 3.9 10.9 4.55Z"/><path stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none" d="m8.3 12.2 2.4 2.4 5-5.4"/></svg>`;
/* DIQQAT: bu yerda ilgari namunaviy (mock) foydalanuvchilar bo'lardi va ular
   backenddan haqiqiy reyting kelgunga qadar ekranda ko'rinib turardi — shu
   sabab reyting "static" ko'rinardi. Endi ro'yxatlar bo'sh boshlanadi va
   backend javob bergunga qadar "Yuklanmoqda" holati ko'rsatiladi (pastga
   qarang: rankLoaded, renderRank). */
let rankLoaded = false;
/* Backenddan kelgan xom leaderboard qatorlari shu yerda saqlanadi — davr (hafta/oy/
   hammasi) va mahorat (grammatika/qiroa/istima/muhavara/kitaba/hammasi) filtrlari
   endi RENDER vaqtida qo'llanadi (pastga qarang: sortedRank), shu sabab ular
   kombinatsiyalanib ishlay oladi. Endi tepadagi "Imtihon turi" (At-Tanal/CEFR)
   tugmalari ham xuddi shunday haqiqiy filtr sifatida ishlaydi (pastga qarang:
   currentRankType, renderRank).
   MUHIM: XP=0 bo'lgan foydalanuvchilar reytingda umuman ko'rsatilmaydi — faqat
   kamida 1 XP to'plagan foydalanuvchilar ro'yxatga kiradi (pastga qarang: sortedRank). */
let RANK_RAW_ROWS = [];
function applyLiveLeaderboard(rows){
  rankLoaded = true; // backenddan javob (bo'sh bo'lsa ham) keldi — endi "Yuklanmoqda" ko'rsatilmaydi
  RANK_RAW_ROWS = Array.isArray(rows) ? rows : [];
  if(document.getElementById('view-rank')?.classList.contains('active')) renderRank(currentRankPeriod, currentRankSkill, currentRankType);
}
let currentRankPeriod = 'hafta';
let currentRankSkill = 'hammasi'; // 'hammasi' yoki SKILLS ichidagi id (grammatika/qiroa/istima/muhavara/kitaba)
let currentRankType = 'tanal';    // 'tanal' yoki 'cefr' — tepadagi Imtihon turi filtri
function initials(name){ return name.split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase(); }
/* Mahorat (bo'lim) va davrga qarab XP ustuni nomini tanlaydi.
   DIQQAT: hozirgi leaderboard_view'da faqat umumiy XP bor (total_xp) — mahorat va
   davr bo'yicha alohida XP ustunlari (masalan grammatika_xp, xp_week va h.k.)
   backendda hali qo'shilmagan bo'lishi mumkin. Shu sabab har bir holat uchun bir
   nechta mumkin bo'lgan ustun nomi sinab ko'riladi va topilmasa eng yaqin mos
   qiymatga (masalan mahoratning umumiy balliga) tushiladi — backendda tegishli
   ustunlar qo'shilishi bilan reyting avtomatik to'g'ri ishlay boshlaydi. */
function rankXpKeys(skill, period){
  if(skill === 'hammasi'){
    if(period === 'hafta') return ['xp_week','xp_weekly','weekly_xp','total_xp'];
    if(period === 'oy') return ['xp_month','xp_monthly','monthly_xp','total_xp'];
    return ['xp_total','xp_all','total_xp','xp'];
  }
  const keys = [];
  if(period === 'hafta') keys.push(`${skill}_xp_week`, `xp_week_${skill}`);
  else if(period === 'oy') keys.push(`${skill}_xp_month`, `xp_month_${skill}`);
  keys.push(`${skill}_xp`, `xp_${skill}`, `${skill}Xp`, `${skill}_score`);
  return keys;
}
/* Ko'rsatiladigan "Daraja" — talab bo'yicha har doim foydalanuvchining ENG SO'NGGI
   TO'LIQ (5 mahorotli) imtihon natijasiga asoslanadi, XP'ga bog'liq emas:
   - "Hammasi" tanlansa: shu oxirgi to'liq imtihonning UMUMIY darajasi (backend 'level'
     ustuni — u XP'dan mustaqil, imtihon natijasi asosida saqlanadi).
   - Muayyan mahorat tanlansa: o'sha oxirgi to'liq imtihonda AYNAN o'sha mahorotdan
     olingan daraja (masalan '{skill}_level' ustuni). Bunday ustun hali backendda
     bo'lmasa, umumiy darajaga tushiladi (backendda qo'shilgach avtomatik ishlaydi). */
function rankLevelFor(r, skill){
  const overall = pick(r, ['level'], 'A1');
  if(skill === 'hammasi') return overall;
  return pick(r, [`${skill}_level`, `level_${skill}`, `${skill}Level`], overall);
}
/* "Barchasi" (hammasi) tanlanganda XP ko'rsatilmay qolish sababi: leaderboard_view'da
   umumiy XP uchun kutilgan ustunlar (xp_week/xp_total/total_xp va h.k.) hali mavjud
   emas yoki bo'sh — shu sabab pick() 0'ga tushadi va foydalanuvchi (xp>0 filtridan
   o'tolmay) reytingdan butunlay yo'qolib qoladi. Muayyan mahorat tanlanganda esa
   ${skill}_score ustuni (get_user_dashboard'da ham ishlatiladigan, haqiqatan mavjud
   ustun) topilib, XP to'g'ri chiqadi.
   YECHIM: "hammasi" uchun asosiy ustunlar topilmasa/0 bo'lsa, har bir mahoratning
   ALLAQACHON ISHLAYOTGAN ${skill}_score ustunlaridan yig'indi hisoblab, shuni
   umumiy XP sifatida ko'rsatamiz. Eslatma: bu yig'indi har doim UMUMIY (butun davr)
   ball asosida — agar backendda haftalik/oylik XP uchun alohida ustunlar hali
   qo'shilmagan bo'lsa, "Haftalik"/"Oylik" + "Barchasi" birikmasi ham shu umumiy
   ballni ko'rsatadi (backendga tegishli ustunlar qo'shilgach avtomatik tuzaladi). */
function rankXpFor(r, skill, period){
  const xpKeys = rankXpKeys(skill, period);
  const val = Number(pick(r, xpKeys, 0)) || 0;
  if(val > 0 || skill !== 'hammasi') return val;
  const skillScoreKeys = ['grammatika_score','qiroa_score','istima_score','muhavara_score','kitaba_score'];
  const sum = skillScoreKeys.reduce((acc,k)=> acc + (Number(r[k]) || 0), 0);
  return sum;
}
/* ---- XP qancha URINISH/TEST orqali yig'ilgani (2-bosqich talabi) ----
   XP raqami yonida "necha ta test yechilgan" (grammatika/qiroa/istima) yoki
   "necha marta urinilgan" (muhavara/kitaba — speaking/writing) ko'rsatiladi.
   Backendda quiz_attempts jadvalida FAQAT yakunlangan (demak XP bergan)
   urinishlar saqlanadi (chala qolganlari umuman yozilmaydi — kod ichidagi
   eski izohga qarang), shu sabab bu hisoblagich = shu jadvaldagi qatorlar soni,
   va u avtomatik ravishda faqat XP bergan urinishlarni anglatadi.
   Ustun nomlari hali backendda (leaderboard_view'da) mavjud bo'lmasligi mumkin —
   shu sabab rankXpKeys bilan bir xil pattern: bir nechta mumkin bo'lgan ustun
   nomi sinaladi, topilmasa 0 qaytadi (raqam ko'rsatilmaydi, lekin sahifa
   buzilmaydi). Backendda tegishli ustunlar qo'shilishi bilan avtomatik ishga
   tushadi — pastdagi SQN taklifiga qarang. */
function rankCountKeys(skill, period){
  if(skill === 'hammasi'){
    if(period === 'hafta') return ['attempts_count_week','attempts_week','count_week'];
    if(period === 'oy') return ['attempts_count_month','attempts_month','count_month'];
    return ['attempts_count_total','attempts_count','total_attempts'];
  }
  const keys = [];
  if(period === 'hafta') keys.push(`${skill}_count_week`, `${skill}_attempts_week`);
  else if(period === 'oy') keys.push(`${skill}_count_month`, `${skill}_attempts_month`);
  keys.push(`${skill}_count`, `${skill}_attempts`, `count_${skill}`);
  return keys;
}
/* Muhavara (speaking) va kitaba (writing) uchun "marta urinildi", qolganlarida
   "ta test yechildi". "Hammasi" tanlanganda ikkalasini ham qamrab oladigan
   umumiy "urinish" so'zi ishlatiladi. */
function rankCountUnit(skill){
  if(skill === 'muhavara' || skill === 'kitaba') return 'marta urinildi';
  if(skill === 'hammasi') return 'ta urinish';
  return 'ta test yechildi';
}
function rankCountFor(r, skill, period){
  const keys = rankCountKeys(skill, period);
  const val = Number(pick(r, keys, 0)) || 0;
  if(val > 0 || skill !== 'hammasi') return val;
  const skillCountKeys = ['grammatika_count','qiroa_count','istima_count','muhavara_count','kitaba_count'];
  return skillCountKeys.reduce((acc,k)=> acc + (Number(r[k]) || 0), 0);
}
function rankCountLabel(r, skill, period){
  const n = rankCountFor(r, skill, period);
  if(!n) return '';
  return `${n} ${rankCountUnit(skill)}`;
}
function sortedRank(period, skill){
  const myId = TELEGRAM_PROFILE.rawId;
  const list = RANK_RAW_ROWS.map(r=>{
    const rid = pick(r, ['user_id','telegram_id','id'], '');
    const isMe = String(rid) === String(myId);
    const showAvatarVal = pick(r, ['show_avatar','show_photo','avatar_visible'], null);
    const showAvatar = isMe ? getShowAvatarSetting() : (showAvatarVal !== false && showAvatarVal !== 'off' && showAvatarVal !== 'false');
    const rawPhoto = pick(r, ['photo_url','avatar_url','photo'], null);
    return {
      id: rid,
      name: pick(r, ['display_name','name','full_name'], null) || [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Foydalanuvchi',
      photo: showAvatar ? rawPhoto : null,
      showAvatar: showAvatar,
      level: rankLevelFor(r, skill),
      xp: rankXpFor(r, skill, period),
      count: rankCountFor(r, skill, period),
      me: isMe,
      isSuperAdmin: ADMIN_TELEGRAM_IDS.map(String).includes(String(rid)),
    };
  })
  .filter(u=>u.xp > 0); // XP to'plamagan foydalanuvchilar reytingda ko'rsatilmaydi
  return list.sort((a,b)=>b.xp-a.xp).map((u,i)=>({...u, rank:i+1}));
}
/* Profil rasmi bor bo'lsa uni, bo'lmasa harflardan iborat rangli doirani chizadi.

   Rasm yuklanmasa (buzilgan URL va h.k.) avtomatik harflarga qaytadi.
   Foydalanuvchi sozlamalarida profil rasmini yashirish yoqilgan bo'lsa (showAvatar===false),
   boshqa foydalanuvchilarda ham rasm o'rniga bosh harflar ko'rsatiladi. */
function rankAvatarHTML(u, color){
  const initialsText = escapeHtml(initials(u.name));
  const hidePhoto = (u.me && !getShowAvatarSetting()) || (u.showAvatar === false) || !u.photo;
  if(u.photo && !hidePhoto){
    return `<img src="${escapeHtml(u.photo)}" alt="" data-fallback="${initialsText}" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:this.dataset.fallback}))">`;
  }
  return initialsText;
}
function renderPodium(period, skill, type){
  const podiumEl = document.getElementById('podium');
  if(type === 'cefr'){
    podiumEl.innerHTML = `<div class="loading-inline" style="grid-column:1/-1;">CEFR reytingi tez orada qo'shiladi</div>`;
    return;
  }
  if(!rankLoaded){
    podiumEl.innerHTML = `
      <div class="podium-item second skel-podium-card">
        <div class="skel skel-avatar" style="width:48px;height:48px;margin:0 auto 10px;"></div>
        <div class="skel skel-line" style="width:65%;height:13px;margin:0 auto 8px;"></div>
        <div class="skel skel-line" style="width:40%;height:10px;margin:0 auto;"></div>
      </div>
      <div class="podium-item first skel-podium-card">
        <div class="skel skel-avatar" style="width:56px;height:56px;margin:0 auto 10px;"></div>
        <div class="skel skel-line" style="width:75%;height:15px;margin:0 auto 8px;"></div>
        <div class="skel skel-line" style="width:50%;height:11px;margin:0 auto;"></div>
      </div>
      <div class="podium-item third skel-podium-card">
        <div class="skel skel-avatar" style="width:44px;height:44px;margin:0 auto 10px;"></div>
        <div class="skel skel-line" style="width:60%;height:13px;margin:0 auto 8px;"></div>
        <div class="skel skel-line" style="width:35%;height:10px;margin:0 auto;"></div>
      </div>
    `;
    return;
  }
  const top3 = sortedRank(period, skill).slice(0,3);
  if(!top3.length){
    podiumEl.innerHTML = `<div class="loading-inline" style="grid-column:1/-1;">Hali reytingda hech kim yo'q</div>`;
    return;
  }
  const medals = ['🥇','🥈','🥉'];
  const order = [1,0,2]; // 2nd, 1st, 3rd visual order
  podiumEl.innerHTML = order.map(i=>{
    const u = top3[i]; if(!u) return '<div></div>';
    return `
    <div class="podium-item ${i===0?'first':(i===1?'second':'third')} fade-in-enter">
      <div class="podium-medal">${medals[i]}</div>
      <div class="podium-avatar" style="background:${RANK_COLORS[i]};">${rankAvatarHTML(u, RANK_COLORS[i])}</div>
      <div class="podium-name">${escapeHtml(u.name)}${u.isSuperAdmin?VERIFIED_BADGE_SVG:''}</div>
      <div class="podium-xp"><span class="num-target" data-target="${u.xp}">0</span> XP</div>
    </div>`;
  }).join('');
  runEntranceAnimations(podiumEl, true);
}
function renderLeaderboard(period, skill, type){
  const listEl = document.getElementById('leaderboardList');
  if(type === 'cefr'){
    listEl.innerHTML = `<div class="loading-inline">CEFR reytingi tez orada qo'shiladi</div>`;
    return;
  }
  if(!rankLoaded){
    listEl.innerHTML = Array.from({length:5}).map(()=>`
      <div class="lb-row" style="opacity:0.85;">
        <div class="skel" style="width:20px;height:16px;border-radius:4px;flex-shrink:0;"></div>
        <div class="skel skel-avatar" style="width:38px;height:38px;"></div>
        <div class="lb-info" style="gap:6px;">
          <div class="skel skel-line" style="width:55%;height:13px;"></div>
          <div class="skel skel-line" style="width:32%;height:11px;"></div>
        </div>
        <div class="skel" style="width:60px;height:22px;border-radius:8px;flex-shrink:0;"></div>
      </div>`).join('');
    return;
  }
  const data = sortedRank(period, skill);
  if(!data.length){
    listEl.innerHTML = `<div class="loading-inline">Bu filtr uchun ma'lumot yo'q</div>`;
    return;
  }
  listEl.innerHTML = data.map((u,i)=>{
    const countTxt = u.count > 0 ? `${u.count} ${rankCountUnit(skill)}` : '';
    return `
    <div class="lb-row ${u.me?'me':''} fade-in-enter">
      <div class="lb-rank">${u.rank}</div>
      <div class="lb-avatar" style="background:${RANK_COLORS[i%RANK_COLORS.length]};">${rankAvatarHTML(u, RANK_COLORS[i%RANK_COLORS.length])}</div>
      <div class="lb-info">
        <div class="n">${escapeHtml(u.name)}${u.isSuperAdmin?VERIFIED_BADGE_SVG:''}${u.me?'<span class="me-tag">Siz</span>':''}</div>
        ${countTxt ? `<div class="l">${escapeHtml(countTxt)}</div>` : ''}
      </div>
      <div class="lb-xp"><span class="num-target" data-target="${u.xp}">0</span><span style="font-size:10.5px;color:var(--text-faint);font-weight:600;"> XP</span></div>
    </div>
  `;
  }).join('');
  runEntranceAnimations(listEl, true);
}
function renderRankTop(period, skill, type){
  if(type === 'cefr'){
    document.getElementById('rankNum').textContent = '—';
    document.getElementById('rankXpNum').textContent = '—';
    document.getElementById('rankXpCountLbl').textContent = '';
    document.getElementById('rankGapNum').textContent = '—';
    document.getElementById('rankGapText').innerHTML = "CEFR reytingi tez orada qo'shiladi";
    document.getElementById('rankGapBar').style.width = '0%';
    return;
  }
  if(!rankLoaded){
    document.getElementById('rankNum').innerHTML = '<span class="skel" style="width:28px;height:22px;display:inline-block;border-radius:6px;background:rgba(255,255,255,0.35);"></span>';
    document.getElementById('rankXpNum').innerHTML = '<span class="skel" style="width:36px;height:22px;display:inline-block;border-radius:6px;background:rgba(255,255,255,0.35);"></span>';
    document.getElementById('rankXpCountLbl').textContent = '';
    document.getElementById('rankGapNum').innerHTML = '<span class="skel" style="width:32px;height:22px;display:inline-block;border-radius:6px;background:rgba(255,255,255,0.35);"></span>';
    document.getElementById('rankGapText').innerHTML = '<span class="skel skel-line" style="width:55%;height:12px;display:inline-block;background:rgba(255,255,255,0.35);"></span>';
    document.getElementById('rankGapBar').style.width = '0%';
    return;
  }
  const data = sortedRank(period, skill);
  const me = data.find(u=>u.me);
  if(!me){
    document.getElementById('rankNum').textContent = '—';
    document.getElementById('rankXpNum').textContent = '—';
    document.getElementById('rankXpCountLbl').textContent = '';
    document.getElementById('rankGapNum').textContent = '—';
    document.getElementById('rankGapText').innerHTML = 'Hali XP to\'plamagansiz';
    document.getElementById('rankGapBar').style.width = '0%';
    return;
  }
  const above = data[data.indexOf(me)-1];
  animateNumber('rankNum', me.rank, { prefix: '#', duration: 750 });
  animateNumber('rankXpNum', me.xp, { duration: 900 });
  document.getElementById('rankXpCountLbl').textContent = me.count > 0 ? `${me.count} ${rankCountUnit(skill)}` : '';
  const gapBar = document.getElementById('rankGapBar');
  if(above){
    const gap = above.xp - me.xp;
    const pct = Math.max(4, Math.min(100, Math.round((me.xp/above.xp)*100)));
    animateNumber('rankGapNum', gap, { duration: 900 });
    document.getElementById('rankGapText').innerHTML = "Keyingi o'ringgacha qolgan XP";
    if(gapBar){
      gapBar.style.transition = 'width 0.9s cubic-bezier(0.16, 1, 0.3, 1)';
      gapBar.style.width = pct+'%';
    }
  } else {
    document.getElementById('rankGapNum').textContent = '🏆';
    document.getElementById('rankGapText').innerHTML = "🎉 Siz ro'yxat boshida turibsiz!";
    if(gapBar){
      gapBar.style.transition = 'width 0.9s cubic-bezier(0.16, 1, 0.3, 1)';
      gapBar.style.width = '100%';
    }
  }
}
function renderRank(period, skill, type){
  currentRankPeriod = period;
  currentRankSkill = skill;
  currentRankType = type || currentRankType || 'tanal';
  renderRankTop(period, skill, currentRankType);
  renderPodium(period, skill, currentRankType);
  renderLeaderboard(period, skill, currentRankType);
}
/* Tepadagi "Imtihon turi" (At-Tanal/CEFR) — endi Davr/Mahorat dropdownlari kabi
   haqiqiy filtr sifatida ishlaydi: bosilganda holat (currentRankType) o'zgaradi
   va reyting shu turga mos qayta chiziladi. CEFR uchun hozircha backendda
   ma'lumot yo'q, shu sabab tegishli "tez orada" holati ko'rsatiladi. */
document.getElementById('rankTypeToggle').addEventListener('click', e=>{
  const btn = e.target.closest('.rank-type-btn'); if(!btn) return;
  document.querySelectorAll('#rankTypeToggle .rank-type-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  renderRank(currentRankPeriod, currentRankSkill, btn.dataset.type);
});
/* Mahorat va Davr filtrlarini custom dropdown (JS) sifatida yasaydi — SKILLS
   ro'yxatidan avtomatik, shu bilan bo'lim nomlari boshqa joylar bilan mos keladi. */
initCustomDropdown('rankSkillDropdown', {
  label: 'Mahorat',
  options: [{value:'hammasi', label:'Barchasi'}].concat(SKILLS.map(s=>({value:s.id, label:s.name}))),
  value: currentRankSkill,
  onChange: (val)=> renderRank(currentRankPeriod, val, currentRankType),
});
initCustomDropdown('rankPeriodDropdown', {
  label: 'Davr',
  options: [
    {value:'hafta', label:'Haftalik'},
    {value:'oy', label:'Oylik'},
    {value:'hammasi', label:'Butun davr'},
  ],
  value: currentRankPeriod,
  onChange: (val)=> renderRank(val, currentRankSkill, currentRankType),
});
renderRank(currentRankPeriod, currentRankSkill, currentRankType);

/* ================= PROFILE ================= */
/* Boshlang'ich (default) qiymatlar 0 — bular applyProfileStats() orqali backenddan
   (get_user_dashboard) kelgan haqiqiy XP/mavzular/aniqlik bilan almashtiriladi. */
let PROFILE_STATS = { xp:0, topicsDone:0, topicsTotal:40, accuracy:0, accuracyDeltaText:'' };
function renderProfileStats(){
  // Profil statistikasi (Jami ball, Tugatilgan mavzular, Umumiy aniqlik) foydalanuvchi talabi bilan olib tashlandi
}
renderProfileStats();
/* Backend get_user_dashboard javobidan XP/mavzular/aniqlikni oladi.
   MOSLASHTIRING: view'ingizdagi ustun nomlari boshqacha bo'lsa, pick() ro'yxatiga qo'shing. */
function applyProfileStats(dash){
  if(!dash) return;
  PROFILE_STATS.xp = Number(pick(dash, ['total_xp','xp'], PROFILE_STATS.xp)) || 0;
  PROFILE_STATS.topicsDone = Number(pick(dash, ['topics_done','completed_topics'], PROFILE_STATS.topicsDone)) || 0;
  PROFILE_STATS.topicsTotal = Number(pick(dash, ['topics_total'], PROFILE_STATS.topicsTotal)) || PROFILE_STATS.topicsTotal;
  const acc = pick(dash, ['accuracy_pct','accuracy'], null);
  if(acc!==null) PROFILE_STATS.accuracy = Number(acc) || 0;
  const delta = pick(dash, ['accuracy_delta_pct','accuracy_delta'], null);
  PROFILE_STATS.accuracyDeltaText = (delta!==null && delta!==undefined) ? `${Number(delta)>=0?'+':''}${delta}% bu oy` : '';
  renderProfileStats();
}
/* Profil sarlavhasidagi daraja belgisi va ro'yxatdan o'tgan sana — backenddan keladi,
   bo'lmasa umumiy % asosida hisoblanadi (statik "B1" endi yo'q). */
function applyProfileHeader(dash){
  // A1 daraja va Ro'yxatdan o'tgan matnlari foydalanuvchi talabi bo'yicha olib tashlandi
}

/* ================= EDIT PROFILE & ONBOARDING (Telegram / Web) ================= */
/* Endi bu ma'lumot Telegram autentifikatsiyasidan (tgInitAndAuth) real vaqtda keladi.
   rawId — bazadagi bigint id (RPC chaqiruvlarida ishlatiladi), id — ko'rsatish uchun matn. */
let TELEGRAM_PROFILE = {
  name: '',
  username: '',
  id: '',
  rawId: null,
  photoUrl: (function(){
    try {
      return (window.Telegram?.WebApp?.initDataUnsafe?.user?.photo_url) || localStorage.getItem('arabication_saved_photo_url') || null;
    } catch(e) { return null; }
  })(),
  gender: 'unspecified' // 'male' | 'female' | 'unspecified'
};

let ONBOARDING_TEMP_NAME = '';
let ONBOARDING_SELECTED_GENDER = 'unspecified';
let EDIT_TEMP_GENDER = 'unspecified';

function handleObNameInput(input){
  if(!input) return;
  input.style.fontFamily = hasArabicText(input.value) ? "'Graphik Arabic', 'Noto Sans Arabic', sans-serif" : "'Onest', sans-serif";
}

/* Onboarding holati endi qurilma localStorage'iga emas, foydalanuvchining bazadagi
   yozuviga (users.onboarding_completed, get_user_dashboard RPC orqali) bog'langan.
   `dash` — bootApp() allaqachon yuklab bo'lgan dashboard javobi (qo'shimcha so'rov yo'q).
   Faqat Telegram tashqarisidagi mehmon/dev holat (rawId yo'q) uchun eski localStorage
   yo'li qoladi, chunki u holatda bazadagi haqiqiy foydalanuvchi yozuvi umuman bo'lmaydi. */
function checkOnboardingRegistration(dash){
  let onboarded = false;

  if(TELEGRAM_PROFILE.rawId){
    onboarded = !!(dash && (dash.onboarding_completed === true || dash.onboarding_completed === 't' || dash.onboarding_completed === 1));
    // Agar backend javobi (dash) hali kelmagan/muvaffaqiyatsiz bo'lsa yoki bu maydonni
    // qaytarmasa, shu qurilmada avval onboarding tugallanganligini localStorage'dan
    // tekshiramiz — aks holda vaqtinchalik tarmoq/backend xatosi tufayli onboarding
    // har safar ilova ochilganda qayta-qayta chiqib qolardi.
    if(!onboarded){
      try{ onboarded = localStorage.getItem('arabication_onboarded_v1_' + TELEGRAM_PROFILE.rawId) === 'true'; }catch(e){}
    }
  } else {
    try{ onboarded = localStorage.getItem('arabication_onboarded_v1') === 'true'; }catch(e){}
  }

  // Custom name va gender uchun mahalliy zaxira (dash'da yo'q bo'lsa yoki mehmon rejimida)
  try{
    if(!(dash && dash.display_name && dash.display_name.trim())){
      const savedName = localStorage.getItem('arabication_custom_name');
      if(savedName && savedName.trim()){
        TELEGRAM_PROFILE.name = savedName.trim();
      }
    }
    if(!(dash && dash.gender)){
      const savedGender = localStorage.getItem('arabication_user_gender');
      if(savedGender){
        TELEGRAM_PROFILE.gender = savedGender;
      }
    }
  }catch(e){}

  if(!onboarded){
    setTimeout(()=>{
      openOnboardingModal();
    }, 200);
  }
}

function openOnboardingModal(){
  const overlay = document.getElementById('onboardingOverlay');
  if(!overlay) return;
  
  // Dastlabki ism: Telegram profile nomi yoki username yoki bo'sh
  let prefillName = '';
  if(TELEGRAM_PROFILE.name && TELEGRAM_PROFILE.name !== 'Mehmon' && TELEGRAM_PROFILE.name !== 'Foydalanuvchi'){
    prefillName = TELEGRAM_PROFILE.name.trim();
  } else if(window.Telegram?.WebApp?.initDataUnsafe?.user?.first_name){
    prefillName = [window.Telegram.WebApp.initDataUnsafe.user.first_name, window.Telegram.WebApp.initDataUnsafe.user.last_name].filter(Boolean).join(' ').trim();
  } else if(TELEGRAM_PROFILE.username){
    prefillName = TELEGRAM_PROFILE.username.replace(/^@/, '').trim();
  }

  const nameInput = document.getElementById('obNameInput');
  if(nameInput){
    nameInput.value = prefillName;
    handleObNameInput(nameInput);
  }

  ONBOARDING_TEMP_NAME = prefillName;
  ONBOARDING_SELECTED_GENDER = TELEGRAM_PROFILE.gender || 'unspecified';
  selectObGender(ONBOARDING_SELECTED_GENDER);

  showObStep(1);
  overlay.style.display = 'flex';
}

function showObStep(step){
  const s1 = document.getElementById('obStep1');
  const s2 = document.getElementById('obStep2');
  const p1 = document.getElementById('obStepPill1');
  const p2 = document.getElementById('obStepPill2');

  if(step === 1){
    if(s1) s1.style.display = 'block';
    if(s2) s2.style.display = 'none';
    if(p1) p1.classList.add('active');
    if(p2) p2.classList.remove('active');
    const input = document.getElementById('obNameInput');
    if(input) setTimeout(()=>input.focus(), 150);
  } else {
    if(s1) s1.style.display = 'none';
    if(s2) s2.style.display = 'block';
    if(p1) p1.classList.add('active');
    if(p2) p2.classList.add('active');
  }
}

function nextOnboardingStep(){
  const nameInput = document.getElementById('obNameInput');
  let val = nameInput ? nameInput.value.trim() : '';
  if(!val){
    val = (TELEGRAM_PROFILE.name && TELEGRAM_PROFILE.name !== 'Mehmon' && TELEGRAM_PROFILE.name !== 'Foydalanuvchi') ? TELEGRAM_PROFILE.name : 'Foydalanuvchi';
  }
  ONBOARDING_TEMP_NAME = val;
  showObStep(2);
}

function prevOnboardingStep(){
  showObStep(1);
}

function selectObGender(gender){
  ONBOARDING_SELECTED_GENDER = gender;
  ['male','female','unspecified'].forEach(g => {
    const el = document.getElementById('obGender' + g.charAt(0).toUpperCase() + g.slice(1));
    if(el){
      if(g === gender) el.classList.add('selected');
      else el.classList.remove('selected');
    }
  });
}

async function completeOnboarding(){
  const finalName = ONBOARDING_TEMP_NAME || 'Foydalanuvchi';
  const finalGender = ONBOARDING_SELECTED_GENDER || 'unspecified';

  // Mahalliy keshga ham yozib qo'yamiz: keyingi ochilishda dashboard javobi
  // kelmagunicha ekran darhol to'g'ri ism/jinsni ko'rsatadi (0 ms flash-fix),
  // lekin haqiqiy manba (source of truth) endi bazadagi users yozuvi.
  try{
    localStorage.setItem('arabication_onboarded_v1', 'true');
    if(TELEGRAM_PROFILE.rawId){
      localStorage.setItem('arabication_onboarded_v1_' + TELEGRAM_PROFILE.rawId, 'true');
    }
    localStorage.setItem('arabication_custom_name', finalName);
    localStorage.setItem('arabication_user_gender', finalGender);
  }catch(e){}

  TELEGRAM_PROFILE.name = finalName;
  TELEGRAM_PROFILE.gender = finalGender;

  renderGreetingFromProfile();

  const overlay = document.getElementById('onboardingOverlay');
  if(overlay) overlay.style.display = 'none';

  toast(`Xush kelibsiz, ${finalName}! 🎉`, 4000);

  // Bazaga bitta yengil yozuv: bu shu foydalanuvchi Telegram ID'siga (rawId) bog'lanadi,
  // shuning uchun boshqa qurilmadan kirsa ham onboarding qayta chiqmaydi.
  // Mehmon/dev rejimida (rawId yo'q) bu qadam o'tkazib yuboriladi.
  if(TELEGRAM_PROFILE.rawId){
    try{
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/complete_onboarding`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          p_user_id: TELEGRAM_PROFILE.rawId,
          p_name: finalName,
          p_gender: finalGender
        })
      });
      if(!res.ok){
        const errText = await res.text();
        console.error("Onboarding bazaga yozilmadi:", errText);
      }
    }catch(e){
      console.error('[completeOnboarding] RPC xatosi:', e);
    }
  }
}

function setEditProfileGender(gender){
  EDIT_TEMP_GENDER = gender;
  ['male','female','unspecified'].forEach(g => {
    const btn = document.getElementById('editGenderBtn_' + g);
    if(btn){
      if(g === gender) btn.classList.add('selected');
      else btn.classList.remove('selected');
    }
  });
}

function openEditProfile(){
  document.getElementById('modalTitle').textContent = 'Profilni tahrirlash';
  const currentName = TELEGRAM_PROFILE.name || document.getElementById('profileName').textContent;
  EDIT_TEMP_GENDER = TELEGRAM_PROFILE.gender || 'unspecified';
  const initialFont = hasArabicText(currentName) ? "'Graphik Arabic', 'Noto Sans Arabic', sans-serif" : "'Onest', sans-serif";
  document.getElementById('modalBody').innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;gap:8px;margin-bottom:18px;">
      <div class="avatar" style="width:64px;height:64px;font-size:22px;" id="editAvatarPreview">${avatarContent()}</div>
      <div style="font-size:11.5px;color:var(--text-faint);font-weight:600;">Profil rasmi Telegram akkauntingizdan avtomatik olinadi</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:14px;">
      <label style="display:flex;flex-direction:column;gap:6px;">
        <span style="font-size:12.5px;font-weight:600;color:var(--text-dim);">Ism</span>
        <input type="text" id="editNameInput" value="${escapeHtml(currentName)}" oninput="handleObNameInput(this)" style="padding:11px 13px;border:1px solid var(--border);border-radius:11px;font-family:${initialFont};font-size:14px;">
      </label>
      <label style="display:flex;flex-direction:column;gap:6px;">
        <span style="font-size:12.5px;font-weight:600;color:var(--text-dim);">Jins</span>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;" id="editGenderSelectGroup">
          <button type="button" id="editGenderBtn_male" class="ob-gender-card ${EDIT_TEMP_GENDER==='male'?'selected':''}" style="padding:10px 8px;justify-content:center;border-radius:9999px;" onclick="setEditProfileGender('male')">
            <span style="font-size:12.5px;font-weight:700;">Muzakkar</span>
          </button>
          <button type="button" id="editGenderBtn_female" class="ob-gender-card ${EDIT_TEMP_GENDER==='female'?'selected':''}" style="padding:10px 8px;justify-content:center;border-radius:9999px;" onclick="setEditProfileGender('female')">
            <span style="font-size:12.5px;font-weight:700;">Muannas</span>
          </button>
          <button type="button" id="editGenderBtn_unspecified" class="ob-gender-card ${EDIT_TEMP_GENDER==='unspecified'?'selected':''}" style="padding:10px 8px;justify-content:center;border-radius:9999px;" onclick="setEditProfileGender('unspecified')">
            <span style="font-size:12.5px;font-weight:700;">Maxfiy</span>
          </button>
        </div>
      </label>
      <label style="display:flex;flex-direction:column;gap:6px;">
        <span style="font-size:12.5px;font-weight:600;color:var(--text-dim);">Telegram ma'lumotlari</span>
        <input type="text" value="${(TELEGRAM_PROFILE.username || 'hozircha mavjud emas')} · ID: ${(TELEGRAM_PROFILE.id && TELEGRAM_PROFILE.id !== '-') ? TELEGRAM_PROFILE.id : (TELEGRAM_PROFILE.rawId || '-')}" disabled style="padding:11px 13px;border:1px solid var(--border);border-radius:11px;font-family:'Onest',sans-serif;font-size:13.5px;background:var(--bg);color:var(--text-faint);">
      </label>
      <button class="btn btn-primary" style="margin-top:6px;" onclick="saveProfile()">Saqlash</button>
    </div>
  `;
  document.getElementById('modalOverlay').classList.add('show');
}
/* profil rasmi: dashboard, header va profil sahifasida DOIM ko'rinadi (agar mavjud
   bo'lsa) — "rasmni yashirish" sozlamasi faqat reyting(leaderboard)dagi ko'rinishga
   ta'sir qiladi, bu yerga emas. */
function avatarContent(){
  if(TELEGRAM_PROFILE.photoUrl){
    const initial = (TELEGRAM_PROFILE.name || '?').trim().charAt(0).toUpperCase();
    return `<img src="${escapeHtml(TELEGRAM_PROFILE.photoUrl)}" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover;" onerror="this.onerror=null;this.replaceWith(Object.assign(document.createElement('span'),{textContent:'${escapeHtml(initial)}'}))">`;
  }
  const initial = (TELEGRAM_PROFILE.name || '?').trim().charAt(0).toUpperCase();
  return initial || '?';
}
async function saveProfile(){
  const newName = document.getElementById('editNameInput').value.trim();
  const nameChanged = newName && newName !== TELEGRAM_PROFILE.name;
  const newGender = EDIT_TEMP_GENDER || 'unspecified';
  const genderChanged = newGender !== (TELEGRAM_PROFILE.gender || 'unspecified');
  if(newName){
    TELEGRAM_PROFILE.name = newName;
    try{ localStorage.setItem('arabication_custom_name', newName); }catch(e){}
  }
  TELEGRAM_PROFILE.gender = newGender;
  try{ localStorage.setItem('arabication_user_gender', newGender); }catch(e){}

  renderGreetingFromProfile();
  closeModal();

  /* MUHIM: ism/jins faqat localStorage'da qolsa, reyting (leaderboard_view) va boshqa
     joylar buni hech qachon ko'rmaydi — chunki ular backenddan o'qiydi, TELEGRAM_PROFILE
     obyektidan emas. Shu sabab ikkalasini ham backenddagi users jadvaliga yozamiz
     (RLS'ni chetlab o'tadigan RPC orqali — qarang update_display_name / update_gender). */
  let backendOk = true;
  if(nameChanged && TELEGRAM_PROFILE.rawId && SESSION_TOKEN){
    try{
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/update_display_name`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ p_user_id: TELEGRAM_PROFILE.rawId, p_display_name: newName })
      });
      if(!res.ok){
        backendOk = false;
        console.error('[saveProfile] Ism bazaga yozilmadi:', await res.text());
      }
    }catch(e){ backendOk = false; console.error('[saveProfile] RPC xatosi (ism):', e); }
  }
  if(genderChanged && TELEGRAM_PROFILE.rawId && SESSION_TOKEN){
    try{
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/update_gender`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ p_user_id: TELEGRAM_PROFILE.rawId, p_gender: newGender })
      });
      if(!res.ok){
        backendOk = false;
        console.error('[saveProfile] Jins bazaga yozilmadi:', await res.text());
      }
    }catch(e){ backendOk = false; console.error('[saveProfile] RPC xatosi (jins):', e); }
  }

  if(!backendOk){
    toast('⚠️ Saqlandi, lekin reyting/boshqa joylarda yangilanishi kechikishi mumkin', 3500);
  } else {
    toast('Profil yangilandi ✅');
    if((nameChanged || genderChanged)){
      try{
        if(document.getElementById('view-rank')?.classList.contains('active')){
          refreshRankFromBackend();
        }
      }catch(e){}
    }
  }
}


/* ---------------- Profil rasmini reytingda ko'rsatish / yashirish sozlamasi ----------------
   localStorage'da saqlanadi (mavzu tanlovi kabi) — bu sozlama FAQAT reyting (leaderboard/
   podium)dagi "Siz" qatoringizga ta'sir qiladi. Dashboard, header va profil sahifasidagi
   rasm bu sozlamadan qat'i nazar doim ko'rinadi (agar Telegram rasmi mavjud bo'lsa). */
/* Sozlama endi har bir foydalanuvchining o'z Telegram ID'siga bog'langan kalitda
   saqlanadi (masalan 'arabication-show-avatar-123456'), umumiy/global kalitda emas.
   Shu tufayli bitta qurilma/brauzerda boshqa Telegram akkaunt bilan kirilsa ham,
   oldingi foydalanuvchining "rasmni yashirish" holati yangi foydalanuvchiga
   o'tib ketmaydi — bu sozlama faqat o'sha aniq foydalanuvchining o'ziga tegishli. */
function avatarSettingKey(){
  return TELEGRAM_PROFILE.rawId ? ('arabication-show-avatar-' + TELEGRAM_PROFILE.rawId) : 'arabication-show-avatar';
}
function getShowAvatarSetting(){
  let v = null;
  try{ v = localStorage.getItem(avatarSettingKey()); }catch(e){}
  return v !== 'off'; // default: yoqilgan
}
function applyAvatarSetting(){
  const on = getShowAvatarSetting();
  const sw = document.getElementById('avatarSettingSwitch');
  const sub = document.getElementById('avatarSettingSub');
  if(sw) sw.checked = on;
  if(sub) sub.textContent = on ? "Reytingda profil rasmingiz ko'rinadi" : "Reytingda rasmingiz o'rniga harf ko'rsatiladi";
  try{
    if(document.getElementById('view-rank')?.classList.contains('active')){
      renderRank(currentRankPeriod, currentRankSkill, currentRankType);
    }
  }catch(e){ /* TELEGRAM_PROFILE hali ishga tushmagan bo'lishi mumkin — bootApp keyinroq chaqiradi */ }
}
function toggleAvatarVisibility(){
  const next = getShowAvatarSetting() ? 'off' : 'on';
  try{ localStorage.setItem(avatarSettingKey(), next); }catch(e){}
  applyAvatarSetting();
  if(TELEGRAM_PROFILE.rawId && SESSION_TOKEN){
    fetch(`${SUPABASE_URL}/rest/v1/rpc/update_show_avatar`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ p_user_id: TELEGRAM_PROFILE.rawId, p_show_avatar: next === 'on' })
    }).then(async (res)=>{
      /* DIQQAT: avvalgi versiyada bu yerdagi xato butunlay yashirilardi (.catch(()=>{})),
         shu sabab agar bazaga yozish muvaffaqiyatsiz bo'lsa (RLS, ustun mavjud emasligi va
         h.k.) siz bundan bexabar qolardingiz — sizga har doim "ishladi"dek ko'rinardi,
         chunki reytingda O'ZINGIZ uchun localStorage'dagi qiymat ishlatiladi, backend emas.
         Boshqa foydalanuvchilar esa faqat backenddagi (leaderboard_view) qiymatga qaraydi —
         demak yozish muvaffaqiyatsiz bo'lsa, ular hech qachon yangilanishni ko'rmaydi. */
      if(!res.ok){
        const errText = await res.text();
        console.error('[toggleAvatarVisibility] Bazaga yozilmadi:', errText);
        toast('⚠️ Sozlama saqlandi, lekin boshqalarga ko\'rinishi kechikishi mumkin', 4000);
      } else {
        toast(next==='on' ? 'Profil rasmi ko\'rsatiladi' : 'Profil rasmi endi ko\'rsatilmaydi');
      }
    }).catch((e)=>{
      console.error('[toggleAvatarVisibility] RPC xatosi:', e);
      toast('⚠️ Sozlama saqlandi, lekin boshqalarga ko\'rinishi kechikishi mumkin', 4000);
    });
  } else {
    toast(next==='on' ? 'Profil rasmi ko\'rsatiladi' : 'Profil rasmi endi ko\'rsatilmaydi');
  }
}

/* ---------------- Question banks ---------------- */
/* STATIK NAMUNAVIY SAVOLLAR OLIB TASHLANDI. Har bir bo'lim endi bo'sh boshlanadi va
   to'liq backenddan (Supabase "questions" jadvali) to'ldiriladi — qarang applyLiveQuestions(). */
const QUESTION_BANKS = {
  istima:{ type:'listening', audioLabel:'', questions:[] },
  grammatika:{ type:'mcq', questions:[] },
};
let currentQuiz = null;
const ARABIC_OPT_LETTERS = ['أ','ب','ج','د','هـ','و'];

/* ---------------- To'liq At-Tanal imtihoni (5 mahorat ketma-ket) ----------------
   FULL_EXAM.active=true bo'lganda har bir mahorat (grammatika->qiroa->istima->
   muhavara->kitaba) o'z odatdagi oqimi bilan ishga tushadi, lekin har biri
   tugagach ORALIQ natija ekrani ko'rsatilmaydi — o'rniga darhol keyingi
   mahoratga o'tiladi. Har bir mahorat natijasi (correct/total) FULL_EXAM.results
   ichida to'planadi, oxirida esa umumiy (5 mahorat yig'indisi) natija ekrani
   ko'rsatiladi. Har bir mahorat baribir alohida-alohida backendga (odatdagidek)
   yoziladi — shu sabab bu funksiya alohida backend jadvali talab qilmaydi. */
const FULL_EXAM_ORDER = ['grammatika','qiroa','istima','break','muhavara','kitaba'];
let FULL_EXAM = null;
function openFullExamIntro(){
  if(isAttanalLocked() || isFullExamLocked()){ toast("🔒 Bu bo'lim hozircha qulflangan"); return; }
  showView('fullexamintro');
}
function fullExamStepLabel(id){
  if(id==='break') return 'Tanaffus';
  const meta = SKILLS.find(s=>s.id===id);
  return meta ? meta.name : id;
}
/* Imtihon boshlanganda: orqaga tugmasini (quiz/miccheck ekranlarida) yashiradi —
   foydalanuvchi qat'iy ketma-ketlikdan chiqib keta olmasligi kerak. */
function setFullExamChromeLocked(locked){
  document.querySelectorAll('#view-quiz .back-row, #view-miccheck .back-row').forEach(el=>{
    el.style.display = locked ? 'none' : '';
  });
}
function runFullExamStep(){
  if(!FULL_EXAM || !FULL_EXAM.active) return;
  const skillId = FULL_EXAM.order[FULL_EXAM.stepIndex];
  if(!skillId){ showFullExamResults(); return; }
  if(skillId==='break'){ runFullExamBreakStep(); return; }
  if(skillId==='muhavara'){ openMicCheck(); return; }
  if(skillId==='kitaba'){ startKitabaExam(); return; }
  startQuiz(skillId);
}
function runFullExamBreakStep(){
  const side = document.getElementById('quizSide');
  if(side) side.style.display = 'none';
  const tagEl = document.getElementById('quizTag');
  if(tagEl){ tagEl.textContent = '☕ Tanaffus'; tagEl.style.background = 'color-mix(in srgb, var(--amber, #E3BE4E) 20%, white)'; tagEl.style.color = 'var(--amber, #92400E)'; }
  document.getElementById('quizBody').innerHTML = `
    <div class="prompt-box" style="text-align:center;">
      <div class="lbl">☕ Tanaffus</div>
      <div style="font-size:15px;margin:10px 0;font-weight:600;">Listening bo'limi yakunlandi.</div>
      <div style="font-size:13px;color:var(--text-dim);">5 daqiqalik qisqa tanaffusdan so'ng Speaking (Muhovara) bo'limi avtomatik boshlanadi. Mikrofoningiz tayyor turishiga ishonch hosil qiling.</div>
    </div>
    <button class="btn btn-primary btn-block" style="margin-top:20px;" onclick="skipFullExamBreak()">Hoziroq davom etish</button>
  `;
  showView('quiz');
  startTimer(5*60, ()=> continueFullExamAfterBreak());
}
function skipFullExamBreak(){ clearInterval(timerInterval); continueFullExamAfterBreak(); }
function continueFullExamAfterBreak(){
  if(!FULL_EXAM) return;
  FULL_EXAM.stepIndex++;
  runFullExamStep();
}
function advanceFullExam(){
  if(!FULL_EXAM) return;
  const finishedId = FULL_EXAM.order[FULL_EXAM.stepIndex];
  FULL_EXAM.stepIndex++;
  const nextId = FULL_EXAM.order[FULL_EXAM.stepIndex];
  clearInterval(timerInterval); clearInterval(mcqTimerInterval);
  if(!nextId){ showFullExamResults(); return; }
  toast(`✅ ${fullExamStepLabel(finishedId)} yakunlandi. Keyingi bo'lim: ${fullExamStepLabel(nextId)}`, 2200);
  setTimeout(runFullExamStep, 1400);
}
function showFullExamResults(){
  setFullExamChromeLocked(false);
  const timerEl = document.getElementById('quizTimer');
  if(timerEl) timerEl.textContent = '';
  const tagEl = document.getElementById('quizTag');
  if(tagEl){ tagEl.textContent = "To'liq At-Tanal imtihoni — natija"; tagEl.style.background='var(--indigo-100)'; tagEl.style.color='var(--indigo-700)'; }
  const side = document.getElementById('quizSide');
  if(side) side.style.display = 'none';
  let sumCorrect = 0, sumTotal = 0;
  let allMistakes = [];
  const rows = FULL_EXAM.order.filter(id=>id!=='break').map(id=>{
    const r = FULL_EXAM.results[id] || {correct:0, total:0};
    sumCorrect += (r.correct||0); sumTotal += (r.total||0);
    if(Array.isArray(r.mistakes)) allMistakes.push(...r.mistakes);
    const meta = SKILLS.find(s=>s.id===id);
    const pct = r.total ? Math.round((r.correct/r.total)*100) : 0;
    return `
      <div class="topic-row" style="align-items:center;">
        <div style="flex:1;">
          <div class="t-name" style="font-size:13px;">${meta?meta.name:id}</div>
          <div class="t-meta">${pct}% · ${getCEFRLevel(pct) && getCEFRLevel(pct).length <= 3 ? getCEFRLevel(pct) + ' daraja' : `<span style="font-size:11.5px;color:var(--text-dim);font-weight:600;">${getCEFRLevel(pct)}</span>`}</div>
        </div>
        <div style="font-weight:600;font-size:16px;flex-shrink:0;">${Math.round((r.correct||0)*10)/10}/${Math.round((r.total||0)*10)/10}</div>
      </div>`;
  }).join('');
  const overallPct = sumTotal ? Math.round((sumCorrect/sumTotal)*100) : 0;
  const sumCorrectDisplay = Math.round(sumCorrect*10)/10;
  const sumTotalDisplay = Math.round(sumTotal*10)/10;

  // Tarixga to'liq imtihon natijasini va xatolarini yozamiz
  const attemptId = 'exam_' + Date.now();
  saveMistakesForAttempt(attemptId, allMistakes);
  saveMistakesForAttempt("To'liq At-Tanal imtihoni", allMistakes);
  const now = new Date();
  const fullExamHistoryRow = {
    id: attemptId,
    section: 'Imtihon',
    topic: "To'liq At-Tanal imtihoni",
    date: now.toLocaleDateString('uz-UZ', { day:'numeric', month:'short' }),
    time: now.toLocaleTimeString('uz-UZ', { hour:'2-digit', minute:'2-digit' }),
    dateGroup: '7kun',
    correct: Math.round(sumCorrect),
    total: Math.round(sumTotal),
    icon: '🎓',
    color: 'var(--indigo-600)',
    bg: 'var(--indigo-100)',
    mistakes: allMistakes
  };
  HISTORY_DATA.unshift(fullExamHistoryRow);
  renderHistoryStats();
  renderHistoryList();

  if(TELEGRAM_PROFILE.rawId){
    submitQuizResultToBackend({
      skillId: 'attanal',
      topicId: 'full_exam',
      topicName: "To'liq At-Tanal imtihoni",
      correct: Math.round(sumCorrect),
      total: Math.round(sumTotal)
    });
  }

  const body = document.getElementById('quizBody');
  body.innerHTML = `
    <div class="prompt-box" style="text-align:center;">
      <div class="lbl">Umumiy natija</div>
      <div style="font-size:34px;font-weight:600;margin:8px 0;"><span class="num-target" data-target="${sumCorrectDisplay}" data-decimals="${sumCorrectDisplay % 1 !== 0 ? 1 : 0}">0</span> / <span class="num-target" data-target="${sumTotalDisplay}" data-decimals="${sumTotalDisplay % 1 !== 0 ? 1 : 0}">0</span> ball</div>
      <div style="color:var(--text-faint);font-size:13px;"><span class="num-target" data-target="${overallPct}" data-suffix="%">0%</span> · ${getCEFRLevel(overallPct) && getCEFRLevel(overallPct).length <= 3 ? getCEFRLevel(overallPct) + ' daraja' : `<span style="font-size:12px;color:var(--text-dim);font-weight:600;">${getCEFRLevel(overallPct)}</span>`}</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:10px;margin-top:16px;">${rows}</div>
    <button class="btn btn-primary btn-block" style="margin-top:20px;" onclick="finishFullExamAndGoHome()">Bosh sahifaga qaytish</button>
  `;
  runEntranceAnimations(body, true);
  if(overallPct >= 25) fireSideConfetti({ mode: 'celebration' });
}
function finishFullExamAndGoHome(){
  FULL_EXAM = null;
  showView('dashboard');
}
function startFullExam(){
  if(isAttanalLocked() || isFullExamLocked()){ toast("🔒 Bu bo'lim hozircha qulflangan"); return; }
  FULL_EXAM = { active:true, order: FULL_EXAM_ORDER.slice(), stepIndex:0, results:{} };
  setFullExamChromeLocked(true);
  toast("🎓 To'liq At-Tanal imtihoni boshlandi: Grammar", 2200);
  runFullExamStep();
}

/* ---------------- Qiroa: 3 juz, har bir juzda BIR NECHTA "test" (matn+6 savol) ---------------- */
/* Har bir juz ichida bir nechta mustaqil "test" bo'lishi mumkin (masalan 1-juzda 10 ta test).
   Har bir test — o'z matni (passage) va o'sha matnga tegishli 6 ta savoldan iborat YAXLIT
   birlik: bir testning savollari boshqa testning matni/savollari bilan hech qachon aralashmaydi.
   Foydalanuvchi shu juzni ishlaganda, tizim shu juzdagi testlardan BITTASINI tasodifiy tanlaydi,
   uning matnini ko'rsatadi, so'ng FAQAT o'sha testning 6 ta savolini beradi.
   Backend: "qiroa_texts" jadvali (id, juz_id, passage) — qarang loadQiroaTextsFromBackend().
   Savollar esa "questions" jadvalida skill_id='qiroa', topic_id = shu testning id'si orqali
   bog'lanadi (applyLiveQuestions() ichida QIROA_TEST_BY_ID orqali joylashtiriladi). */
const QIROA_JUZ = [
  {id:'juz1', name:'1-juz', readMins:2, qMins:6},
  {id:'juz2', name:'2-juz', readMins:5, qMins:6},
  {id:'juz3', name:'3-juz', readMins:8, qMins:6},
];
const QIROA_MAX_Q_PER_TEST = 6;
/* QIROA_TESTS[juzId] = [ {id, juzId, passage, questions:[...]} , ... ] */
let QIROA_TESTS = { juz1:[], juz2:[], juz3:[] };
/* Tez qidirish uchun: testId -> shu test obyekti (QIROA_TESTS ichidagilar bilan bir xil referens). */
let QIROA_TEST_BY_ID = {};

/* Barcha Qiroa matnlarini (testlarini) backenddan yuklaydi.
   EGRESS OPTIMIZATSIYASI: Doimiy SmartCache bilan keshlanadi. */
async function loadQiroaTextsFromBackend(forceRefresh = false){
  if(!forceRefresh){
    const cached = SmartCache.get('qiroa_texts');
    if(cached) return cached;
  }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/qiroa_texts?select=id,juz_id,passage,title&order=juz_id.asc,created_at.asc`, { headers: authHeaders() });
    if(!res.ok) return [];
    const data = await res.json();
    if(Array.isArray(data)){
      SmartCache.set('qiroa_texts', data);
    }
    return data;
  }catch(e){ console.error(e); return []; }
}
/* Backenddan kelgan qiroa_texts qatorlarini QIROA_TESTS / QIROA_TEST_BY_ID ichiga joylaydi.
   DIQQAT: bu funksiya har chaqirilganda QIROA_TESTS'ni to'liq qayta quradi — shu sabab har doim
   applyLiveQiroaTexts() dan KEYIN applyLiveQuestions() chaqirilishi kerak (aks holda savollar
   eski (bo'sh) testlar ustiga emas, yangilariga joylanmay qoladi). */
function applyLiveQiroaTexts(rows){
  QIROA_TESTS = { juz1:[], juz2:[], juz3:[] };
  QIROA_TEST_BY_ID = {};
  if(!Array.isArray(rows)) return;
  rows.forEach(r=>{
    if(!QIROA_TESTS[r.juz_id]) return;
    const test = { id: r.id, juzId: r.juz_id, passage: r.passage || '', title: r.title || '', questions: [] };
    QIROA_TESTS[r.juz_id].push(test);
    QIROA_TEST_BY_ID[r.id] = test;
  });
}
/* Yangi Qiroa matni (test) yaratadi — backendda "admin_add_qiroa_text" RPC talab qilinadi.
   p_title — admin bergan mavzu nomi (masalan "Oilaviy hayot haqida matn"): imtihon paytida
   foydalanuvchiga uzun matn o'rniga shu nom ko'rsatiladi, bosilganda matn ochiladi. RPC
   `qiroa_texts` jadvaliga `title` ustunini ham yozishi kerak (agar hali yo'q bo'lsa, ustun
   qo'shib, funksiyani shunga mos yangilash lozim). */
async function addQiroaTextToBackend(juzId, passage, title){
  if(!SESSION_TOKEN){ setLastBackendError('—', 'SESSION_TOKEN yo\'q (Telegram orqali kirilmagan)'); return null; }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_add_qiroa_text`, {
      method:"POST", headers: authHeaders(),
      body: JSON.stringify({ p_juz_id: juzId, p_passage: passage, p_title: title || '' })
    });
    if(!res.ok){ setLastBackendError(res.status, await res.text()); return null; }
    SmartCache.invalidate('qiroa_texts');
    const text = await res.text();
    return text ? JSON.parse(text) : true;
  }catch(e){ setLastBackendError('—', e.message); return null; }
}
/* Mavjud Qiroa matnini (va mavzu nomini) tahrirlaydi — backendda "admin_edit_qiroa_text"
   RPC talab qilinadi, p_title parametrini ham qabul qilishi kerak. */
async function editQiroaTextOnBackend(testId, passage, title){
  if(!SESSION_TOKEN){ setLastBackendError('—', 'SESSION_TOKEN yo\'q (Telegram orqali kirilmagan)'); return null; }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_edit_qiroa_text`, {
      method:"POST", headers: authHeaders(),
      body: JSON.stringify({ p_text_id: testId, p_passage: passage, p_title: title || '' })
    });
    if(!res.ok){ setLastBackendError(res.status, await res.text()); return null; }
    SmartCache.invalidate('qiroa_texts');
    const text = await res.text();
    return text ? JSON.parse(text) : true;
  }catch(e){ setLastBackendError('—', e.message); return null; }
}
/* Qiroa matnini (va unga bog'liq barcha savollarni) o'chiradi — backendda
   "admin_delete_qiroa_text" RPC talab qilinadi (bog'liq savollarni ham kaskad o'chirishi kerak). */
async function deleteQiroaTextOnBackend(testId){
  if(!SESSION_TOKEN){ setLastBackendError('—', 'SESSION_TOKEN yo\'q (Telegram orqali kirilmagan)'); return null; }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_delete_qiroa_text`, {
      method:"POST", headers: authHeaders(),
      body: JSON.stringify({ p_text_id: testId })
    });
    if(!res.ok){ setLastBackendError(res.status, await res.text()); return null; }
    SmartCache.invalidate('qiroa_texts');
    SmartCache.invalidate('questions');
    const text = await res.text();
    return text ? JSON.parse(text) : true;
  }catch(e){ setLastBackendError('—', e.message); return null; }
}
/* Qiroa matnlarini + savollarni backenddan qayta yuklab, mahalliy holatni yangilaydi.
   Tartib MUHIM: avval testlar (bo'sh questions bilan), keyin savollar — aks holda
   savollar hali yaratilmagan testlar "qutisi"ga tushmay, jim tarzda yo'qolib qoladi
   (aynan shu ilgari topilgan xatoning ildizi). */
async function refreshQiroaFromBackend(){
  const texts = await loadQiroaTextsFromBackend();
  applyLiveQiroaTexts(texts);
  const liveQuestions = await loadQuestionsFromBackend();
  applyLiveQuestions(liveQuestions);
}

/* ---------------- Istima: 3 qism (juz), har bir qismda BIR NECHTA "test" (audio+savollar) ----------------
   1-qism: har bir test — 1 ta QISQA audio + shu audioga oid 1 ta savol (4 variant).
   2-qism va 3-qism: har bir test — 1 ta UZUNROQ dialog audio + shu audioga oid 6 ta savol.
   Bir foydalanuvchi Istima'ni ishlaganda, HAR BIR qismdan (agar shu qismda kamida bitta TO'LIQ
   test — audio + kerakli sondagi savol bo'lsa) TASODIFIY bitta test tanlanadi, uning audiosi
   cheklangan marta (maxPlays) ijro etiladi, so'ng shu testning savollari beriladi.
   Backend: "istima_audio" jadvali (id, juz_id, audio_url) — qarang loadIstimaAudioFromBackend().
   Savollar esa "questions" jadvalida skill_id='istima', topic_id = shu testning id'si orqali
   bog'lanadi (applyLiveQuestions() ichida ISTIMA_TEST_BY_ID orqali joylashtiriladi). */
const ISTIMA_JUZ = [
  {id:'juz1', name:'1-qism', qCount:1, maxPlays:2},
  {id:'juz2', name:'2-qism', qCount:6, maxPlays:2},
  {id:'juz3', name:'3-qism', qCount:6, maxPlays:2},
];
/* ISTIMA_TESTS[juzId] = [ {id, juzId, audioUrl, questions:[...]} , ... ] */
let ISTIMA_TESTS = { juz1:[], juz2:[], juz3:[] };
/* Tez qidirish uchun: testId -> shu test obyekti (ISTIMA_TESTS ichidagilar bilan bir xil referens). */
let ISTIMA_TEST_BY_ID = {};

/* Barcha Istima audiolarini (testlarini) backenddan yuklaydi.
   EGRESS OPTIMIZATSIYASI: Doimiy SmartCache bilan keshlanadi. */
async function loadIstimaAudioFromBackend(forceRefresh = false){
  if(!forceRefresh){
    const cached = SmartCache.get('istima_audio');
    if(cached) return cached;
  }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/istima_audio?select=id,juz_id,audio_url&order=juz_id.asc,created_at.asc`, { headers: authHeaders() });
    if(!res.ok) return [];
    const data = await res.json();
    if(Array.isArray(data)){
      SmartCache.set('istima_audio', data);
    }
    return data;
  }catch(e){ console.error(e); return []; }
}
/* Backenddan kelgan istima_audio qatorlarini ISTIMA_TESTS / ISTIMA_TEST_BY_ID ichiga joylaydi.
   DIQQAT: qiroa'dagi kabi, bu funksiya ham har chaqirilganda ISTIMA_TESTS'ni to'liq qayta quradi —
   shu sabab har doim applyLiveIstimaAudio() dan KEYIN applyLiveQuestions() chaqirilishi kerak. */
function applyLiveIstimaAudio(rows){
  ISTIMA_TESTS = { juz1:[], juz2:[], juz3:[] };
  ISTIMA_TEST_BY_ID = {};
  if(!Array.isArray(rows)) return;
  rows.forEach(r=>{
    if(!ISTIMA_TESTS[r.juz_id]) return;
    const test = { id: r.id, juzId: r.juz_id, audioUrl: r.audio_url || '', questions: [] };
    ISTIMA_TESTS[r.juz_id].push(test);
    ISTIMA_TEST_BY_ID[r.id] = test;
  });
}
/* Yangi Istima audiosi (test) yaratadi — backendda "admin_add_istima_audio" RPC talab qilinadi. */
async function addIstimaAudioToBackend(juzId, audioUrl){
  if(!SESSION_TOKEN){ setLastBackendError('—', 'SESSION_TOKEN yo\'q (Telegram orqali kirilmagan)'); return null; }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_add_istima_audio`, {
      method:"POST", headers: authHeaders(),
      body: JSON.stringify({ p_juz_id: juzId, p_audio_url: audioUrl })
    });
    if(!res.ok){ setLastBackendError(res.status, await res.text()); return null; }
    SmartCache.invalidate('istima_audio');
    const text = await res.text();
    return text ? JSON.parse(text) : true;
  }catch(e){ setLastBackendError('—', e.message); return null; }
}
/* Mavjud Istima audio URL'ini tahrirlaydi — backendda "admin_edit_istima_audio" RPC talab qilinadi. */
async function editIstimaAudioOnBackend(testId, audioUrl){
  if(!SESSION_TOKEN){ setLastBackendError('—', 'SESSION_TOKEN yo\'q (Telegram orqali kirilmagan)'); return null; }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_edit_istima_audio`, {
      method:"POST", headers: authHeaders(),
      body: JSON.stringify({ p_audio_id: testId, p_audio_url: audioUrl })
    });
    if(!res.ok){ setLastBackendError(res.status, await res.text()); return null; }
    SmartCache.invalidate('istima_audio');
    const text = await res.text();
    return text ? JSON.parse(text) : true;
  }catch(e){ setLastBackendError('—', e.message); return null; }
}
/* Istima testini (audio + unga bog'liq barcha savollarni) o'chiradi — backendda
   "admin_delete_istima_audio" RPC talab qilinadi (bog'liq savollarni ham kaskad o'chirishi kerak). */
async function deleteIstimaAudioOnBackend(testId){
  if(!SESSION_TOKEN){ setLastBackendError('—', 'SESSION_TOKEN yo\'q (Telegram orqali kirilmagan)'); return null; }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_delete_istima_audio`, {
      method:"POST", headers: authHeaders(),
      body: JSON.stringify({ p_audio_id: testId })
    });
    if(!res.ok){ setLastBackendError(res.status, await res.text()); return null; }
    SmartCache.invalidate('istima_audio');
    SmartCache.invalidate('questions');
    const text = await res.text();
    return text ? JSON.parse(text) : true;
  }catch(e){ setLastBackendError('—', e.message); return null; }
}
/* Istima audio+savollarni backenddan qayta yuklab, mahalliy holatni yangilaydi. Tartib MUHIM:
   avval testlar (bo'sh questions bilan), keyin savollar. */
async function refreshIstimaFromBackend(){
  const rows = await loadIstimaAudioFromBackend();
  applyLiveIstimaAudio(rows);
  const liveQuestions = await loadQuestionsFromBackend();
  applyLiveQuestions(liveQuestions);
}

/* ---------------- Muhavara (Speaking): 3 qism, har birida 2 tadan savol (jami 6) ----------------
   Qiroa/Istima'dan farqi: bu yerda "test" tushunchasi yo'q — har qismda ANIQ 2 ta savol bo'lib,
   TEST BOSHLANGANDA HAMMASI (6 tasi ham) ketma-ket beriladi (tasodifiy tanlanmaydi).
   Har savol uchun: avval prepSecs soniya tayyorgarlik (yozib olinmaydi), so'ng answerSecs soniya
   davomida ovoz yoziladi. Savollar ochiq (variant/to'g'ri javob yo'q) — shuning uchun umumiy
   "questions" jadvali o'rniga alohida "speaking_questions" jadvali ishlatiladi.
   Backend: "speaking_questions" jadvali (id, part_id, prompt) — qarang loadSpeakingQuestionsFromBackend().
   Baholash: har javob ovozi Supabase Edge Function ("evaluate-speaking") orqali Groq AI'ga
   yuboriladi, u matnga o'giradi (Whisper) va 0-5 ball + izoh bilan baholaydi (LLM). */
const MUHAVARA_PARTS = [
  {id:'part1', name:'1-qism', prepSecs:60, answerSecs:30},
  {id:'part2', name:'2-qism', prepSecs:60, answerSecs:45},
  {id:'part3', name:'3-qism', prepSecs:60, answerSecs:60},
];
const MUHAVARA_MAX_Q_PER_PART = 2;
/* MUHAVARA_QUESTIONS[partId] = [ {id, partId, prompt}, ... ] (ko'pi bilan 2 tadan) */
let MUHAVARA_QUESTIONS = { part1:[], part2:[], part3:[] };

async function loadSpeakingQuestionsFromBackend(forceRefresh = false){
  if(!forceRefresh){
    const cached = SmartCache.get('speaking_questions');
    if(cached) return cached;
  }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/speaking_questions?select=id,part_id,prompt&order=part_id.asc,created_at.asc`, { headers: authHeaders() });
    if(!res.ok) return [];
    const data = await res.json();
    if(Array.isArray(data)){
      SmartCache.set('speaking_questions', data);
    }
    return data;
  }catch(e){ console.error(e); return []; }
}
function applyLiveSpeakingQuestions(rows){
  MUHAVARA_QUESTIONS = { part1:[], part2:[], part3:[] };
  if(!Array.isArray(rows)) return;
  rows.forEach(r=>{
    if(!MUHAVARA_QUESTIONS[r.part_id]) return;
    MUHAVARA_QUESTIONS[r.part_id].push({ id:r.id, partId:r.part_id, prompt:r.prompt });
  });
}
/* Yangi Muhavara savoli qo'shadi — backendda "admin_add_speaking_question" RPC talab qilinadi. */
async function addSpeakingQuestionToBackend(partId, prompt){
  if(!SESSION_TOKEN){ setLastBackendError('—', 'SESSION_TOKEN yo\'q (Telegram orqali kirilmagan)'); return null; }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_add_speaking_question`, {
      method:"POST", headers: authHeaders(),
      body: JSON.stringify({ p_part_id: partId, p_prompt: prompt })
    });
    if(!res.ok){ setLastBackendError(res.status, await res.text()); return null; }
    SmartCache.invalidate('speaking_questions');
    const text = await res.text();
    return text ? JSON.parse(text) : true;
  }catch(e){ setLastBackendError('—', e.message); return null; }
}
/* Bir nechta Muhavara savolini bittada qo'shadi — backendda "admin_bulk_add_speaking_questions"
   RPC bo'lsa bitta so'rovda yuboradi, agar bazada bu funksiya hali yaratilmagan bo'lsa (404/PGRST202),
   avtomatik ravishda "admin_add_speaking_question" orqali bittalab qo'shib chiqadi (fallback). */
async function saveSpeakingQuestionsBulkToBackend(items){
  if(!SESSION_TOKEN){ setLastBackendError('—', 'SESSION_TOKEN yo\'q (Telegram orqali kirilmagan)'); return null; }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_bulk_add_speaking_questions`, {
      method:"POST", headers: authHeaders(),
      body: JSON.stringify({ p_items: items.map(it => ({ part_id: it.partId, prompt: it.prompt })) })
    });
    if(res.ok){
      SmartCache.invalidate('speaking_questions');
      const text = await res.text();
      return text ? JSON.parse(text) : true;
    }
    // Agar admin_bulk_add_speaking_questions bazada mavjud bo'lmasa (404/PGRST202),
    // avtomatik fallback: mavjud admin_add_speaking_question orqali birma-bir yuborish
    if(res.status === 404 || res.status === 400){
      let count = 0;
      let lastErr = null;
      for(const it of items){
        const singleRes = await addSpeakingQuestionToBackend(it.partId, it.prompt);
        if(singleRes){
          count++;
        } else {
          lastErr = window.LAST_BACKEND_ERROR;
        }
      }
      if(count > 0){
        SmartCache.invalidate('speaking_questions');
        return { inserted_count: count };
      }
      if(lastErr){
        setLastBackendError(res.status, lastErr);
      }
      return null;
    }
    const errText = await res.text();
    setLastBackendError(res.status, errText);
    return null;
  }catch(e){ setLastBackendError('—', e.message); return null; }
}
async function editSpeakingQuestionOnBackend(id, prompt){
  if(!SESSION_TOKEN){ setLastBackendError('—', 'SESSION_TOKEN yo\'q (Telegram orqali kirilmagan)'); return null; }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_edit_speaking_question`, {
      method:"POST", headers: authHeaders(),
      body: JSON.stringify({ p_question_id: id, p_prompt: prompt })
    });
    if(!res.ok){ setLastBackendError(res.status, await res.text()); return null; }
    SmartCache.invalidate('speaking_questions');
    const text = await res.text();
    return text ? JSON.parse(text) : true;
  }catch(e){ setLastBackendError('—', e.message); return null; }
}
async function deleteSpeakingQuestionOnBackend(id){
  if(!SESSION_TOKEN){ setLastBackendError('—', 'SESSION_TOKEN yo\'q (Telegram orqali kirilmagan)'); return null; }
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_delete_speaking_question`, {
      method:"POST", headers: authHeaders(),
      body: JSON.stringify({ p_question_id: id })
    });
    if(!res.ok){ setLastBackendError(res.status, await res.text()); return null; }
    SmartCache.invalidate('speaking_questions');
    const text = await res.text();
    return text ? JSON.parse(text) : true;
  }catch(e){ setLastBackendError('—', e.message); return null; }
}
async function refreshSpeakingFromBackend(){
  const rows = await loadSpeakingQuestionsFromBackend();
  applyLiveSpeakingQuestions(rows);
}

/* ---------------- Kitaba (Yozma) — 3 qism, har biri o'z talablari bilan (100, 150, 200 so'z) ---------------- */
const KITABA_PARTS = [
  {id:'part1', name:'1-qism', minWords:100, unlockWords:50, seconds:15*60},
  {id:'part2', name:'2-qism', minWords:150, unlockWords:75, seconds:20*60},
  {id:'part3', name:'3-qism', minWords:200, unlockWords:100, seconds:30*60},
];

/* Tashkeel/harakat belgilari: Fatha, Damma, Kasra, Sukun, Shadda, Tanwin va boshqalar (\u064B-\u065F, \u0670) */
const ARABIC_DIACRITICS_REGEX = /[\u064B-\u065F\u0670\u06D6-\u06ED]/g;

/* Arabcha so'zlarni sanash:
   1. Har bir so'zdan tashkeel/harakat belgilarini olib tashlaymiz.
   2. Kamida 2 ta haqiqiy arab harfidan iborat bo'lgan bo'laklar 1 ta so'z deb hisoblanadi (masalan: و و و bitta harfliklar hisoblanmaydi, وَو yoki وو 2 harflik bo'lgani uchun 1 ta so'z). */
function countArabicWords(text){
  if(!text || typeof text !== 'string') return 0;
  // Barcha arab harfli bloklarni ajratib olamiz
  const tokens = text.trim().match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]+/g);
  if(!tokens) return 0;
  let validCount = 0;
  for(const token of tokens){
    // Harakatlarni (fatha, kasra, damma, sukun, shadda...) tozalaymiz
    const cleanLetters = token.replace(ARABIC_DIACRITICS_REGEX, '');
    // Kamida 2 ta haqiqiy arab harfi bo'lsa bitta so'z
    if(cleanLetters.length >= 2){
      validCount++;
    }
  }
  return validCount;
}

/* Faqat arab harflari, arab va oddiy tinish belgilari, raqamlar va probellarga ruxsat berish:
   Matnni to'g'ridan-to'g'ri tozalash uchun (EN/RUS harflarini avtomatik kiritmaslik) */
function sanitizeArabicInput(text){
  if(!text || typeof text !== 'string') return '';
  // Lotin va Kirill harflarini to'liq olib tashlash
  return text.replace(/[a-zA-Z\u0400-\u04FF\u0500-\u052F]/g, '');
}

function containsNonArabicLetters(text){
  if(!text || typeof text !== 'string') return false;
  return /[a-zA-Z\u0400-\u04FF\u0500-\u052F]/.test(text);
}
/* KITABA_TOPICS[partId] = [ {id, partId, topicAr}, ... ] — admin panelda kiritilgan
   mavzular banki, backenddan ("writing_topics" jadvali) yuklanadi. */
let KITABA_TOPICS = { part1:[], part2:[], part3:[] };
function applyLiveWritingTopics(rows){
  KITABA_TOPICS = { part1:[], part2:[], part3:[] };
  if(!Array.isArray(rows)) return;
  rows.forEach(r=>{
    if(!KITABA_TOPICS[r.part_id]) return;
    KITABA_TOPICS[r.part_id].push({ id:r.id, partId:r.part_id, topicAr:r.topic_ar });
  });
}
async function refreshKitabaFromBackend(){
  const rows = await loadWritingTopicsFromBackend();
  applyLiveWritingTopics(rows);
}

/* ---------------- Timer (overall, for reading/listening/writing) ---------------- */
let timerInterval = null;
function startTimer(seconds, onExpire){
  clearInterval(timerInterval);
  let remaining = seconds;
  const isSpeaking = currentQuiz && (currentQuiz.skillId === 'muhavara' || currentQuiz.type === 'speaking');
  const el = document.getElementById('quizTimer');
  if(el){
    if(isSpeaking){
      el.innerHTML = '';
      el.style.display = 'none';
    } else {
      el.style.display = '';
      el.style.color = ''; el.style.borderColor = '';
    }
  }
  function render(){
    const m = Math.floor(remaining/60), s = remaining%60;
    const formatted = String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');
    if(el && !isSpeaking){
      el.innerHTML = '<span class="timer-icon">⏱</span><span class="timer-digits">' + formatted + '</span>';
    }
    const bigTimer = document.getElementById('muhavaraBigTimer');
    if(bigTimer){
      bigTimer.textContent = formatted;
    }
    const recTimer = document.getElementById('muhavaraRecTimer');
    if(recTimer){
      recTimer.textContent = formatted;
    }
  }
  render();
  timerInterval = setInterval(()=>{
    remaining--; render();
    if(remaining<=0){ clearInterval(timerInterval); (onExpire||finishQuiz)(); }
  },1000);
}

/* ---------------- Per-question Timer (Grammatika / Istima savollari: 1 daqiqa har savol uchun) ---------------- */
let mcqTimerInterval = null;
function clearQuestionTimer(){
  if(mcqTimerInterval){
    clearInterval(mcqTimerInterval);
    mcqTimerInterval = null;
  }
}

function disableQuestionOptions(){
  const opts = document.querySelectorAll('#quizBody .option');
  opts.forEach(opt => {
    opt.classList.add('disabled', 'is-expired');
    opt.setAttribute('aria-disabled', 'true');
  });
}

function startQuestionTimer(){
  clearQuestionTimer();
  if(!currentQuiz || !currentQuiz.questions || !currentQuiz.questions[currentQuiz.idx]) return;
  const q = currentQuiz.questions[currentQuiz.idx];
  const el = document.getElementById('quizTimer');

  if(q.timeLeft === undefined){
    q.timeLeft = 60;
  }

  function paint(){
    if(!el) return;
    const remaining = Math.max(0, q.timeLeft);
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    
    if(q.expired || remaining <= 0){
      el.innerHTML = '<span class="timer-icon">⏱</span><span class="timer-digits">0:00</span>';
      el.style.color = 'var(--red)';
      el.style.borderColor = 'var(--red)';
    } else {
      el.innerHTML = '<span class="timer-icon">⏱</span><span class="timer-digits">' + m + ':' + String(s).padStart(2,'0') + '</span>';
      if(remaining <= 10){
        el.style.color = 'var(--red)';
        el.style.borderColor = 'var(--red)';
      } else if(remaining <= 30){
        el.style.color = 'var(--amber)';
        el.style.borderColor = 'var(--amber)';
      } else {
        el.style.color = '';
        el.style.borderColor = '';
      }
    }
    if(currentQuiz && currentQuiz.isDuel) updateDuelVsTimer();
  }

  // Agar bu savolning vaqti allaqachon tugagan bo'lsa
  if(q.expired || q.timeLeft <= 0){
    q.timeLeft = 0;
    q.expired = true;
    paint();
    disableQuestionOptions();
    return;
  }

  paint();

  mcqTimerInterval = setInterval(()=>{
    if(!currentQuiz || !currentQuiz.questions || !currentQuiz.questions[currentQuiz.idx]){
      clearQuestionTimer();
      return;
    }
    const curQ = currentQuiz.questions[currentQuiz.idx];
    if(curQ !== q){
      clearQuestionTimer();
      return;
    }

    if(q.timeLeft > 0){
      q.timeLeft--;
      paint();
    }

    if(q.timeLeft <= 0){
      q.timeLeft = 0;
      q.expired = true;
      clearQuestionTimer();
      paint();
      disableQuestionOptions();
      updateQGrid();
      if(currentQuiz && currentQuiz.isDuel){
        _duelStopAnswerPolling();
        if(q.picked === null || q.picked === undefined){
          apiSubmitDuelAnswer(currentQuiz.duelId, currentQuiz.idx, null);
        }
      }
      toast("⏰ Vaqt tugadi! Keyingi savolga o'tilmoqda...", 1200);
      setTimeout(()=>{
        if(!currentQuiz || !currentQuiz.questions) return;
        if(currentQuiz.questions[currentQuiz.idx] === q){
          nextQ();
        }
      }, 700);
    }
  }, 1000);
}

/* ---------------- Grammatika: har bir mavzu uchun alohida savollar bazasi ---------------- */
/* STATIK NAMUNAVIY SAVOLLAR OLIB TASHLANDI. Har bir grammatika mavzusi uchun savollar
   endi to'liq backenddan (Supabase "questions" jadvali, topic_id ustuni orqali) keladi. */
const GRAMMAR_TOPIC_BANKS = {};

/* Backend "questions" jadvalidan kelgan savollarni QUESTION_BANKS / GRAMMAR_TOPIC_BANKS
   ichiga joylaydi — shu orqali admin qo'shgan har bir savol BARCHA foydalanuvchilarda
   (ilova qayta ochilganda) ko'rinadi. Backend bo'sh bo'lsa, savollar ro'yxati bo'sh
   qoladi (static namunaviy savollar butunlay olib tashlangan).
   Har bir savolga backenddagi haqiqiy `id` (va skillId/topicId) ham biriktiriladi —
   buni admin panelda tahrirlash/o'chirish/tartib almashtirish uchun ishlatamiz.
   MUHIM: bu funksiya ilova davomida (refreshQiroaFromBackend orqali) bir necha marta
   qayta-qayta chaqiriladi. Oldin push() faqat qo'shar, hech qachon tozalamas edi —
   shu sabab har chaqirilganda bir xil savollar ustma-ust qo'shilib, "klonlanib"
   ko'payib borar edi. Shuning oldini olish uchun har safar avval barcha mahalliy
   savol massivlarini bo'shatib, so'ng backenddan kelgan qatorlar bilan qayta to'ldiramiz. */
function applyLiveQuestions(rows){
  // rows === null -> tarmoq/server xatosi (loadQuestionsFromBackend() shuni bildiradi).
  // Bu holda hech narsaga tegmaymiz — mavjud (kesh yoki oldingi muvaffaqiyatli
  // yuklangan) savollar banki o'zgarishsiz qoladi, chunki bu "haqiqatan ham
  // savol yo'q" degani emas, shunchaki javob kelmadi degani.
  if(rows === null || rows === undefined) return;
  Object.keys(GRAMMAR_TOPIC_BANKS).forEach(topicId=>{ GRAMMAR_TOPIC_BANKS[topicId] = []; });
  Object.values(QIROA_TEST_BY_ID).forEach(test=>{ test.questions = []; });
  Object.values(ISTIMA_TEST_BY_ID).forEach(test=>{ test.questions = []; });
  Object.keys(QUESTION_BANKS).forEach(skillId=>{ if(QUESTION_BANKS[skillId]) QUESTION_BANKS[skillId].questions = []; });
  if(!Array.isArray(rows) || !rows.length) return;
  // Savollar banki keshi: keyingi safar ilova ochilganda, tarmoqdan yangi javob
  // kelguncha shu kesh darhol ko'rsatiladi — shu bilan "hali savol yo'q" degan
  // vaqtinchalik (noto'g'ri) ko'rinish oldini oladi.
  try{ localStorage.setItem('arab_questions_cache_v1', JSON.stringify(rows)); }catch(e){}
  rows.forEach(r=>{
    const item = {
      id: r.id,
      skillId: r.skill_id,
      topicId: r.topic_id || null,
      category: r.category || (r.topic_id ? GRAMMAR_TOPICS.find(t=>t.id===r.topic_id)?.category : null) || 'nahv',
      q: r.q,
      opts: r.opts,
      a: r.correct_index ?? r.a,
      exp: r.exp || ''
    };
    if(r.skill_id === 'grammatika' && r.topic_id){
      if(!GRAMMAR_TOPIC_BANKS[r.topic_id]) GRAMMAR_TOPIC_BANKS[r.topic_id] = [];
      GRAMMAR_TOPIC_BANKS[r.topic_id].push(item);
    } else if(r.skill_id === 'qiroa' && r.topic_id && QIROA_TEST_BY_ID[r.topic_id]){
      QIROA_TEST_BY_ID[r.topic_id].questions.push(item);
    } else if(r.skill_id === 'istima' && r.topic_id && ISTIMA_TEST_BY_ID[r.topic_id]){
      ISTIMA_TEST_BY_ID[r.topic_id].questions.push(item);
    } else if(QUESTION_BANKS[r.skill_id]){
      if(!QUESTION_BANKS[r.skill_id].questions) QUESTION_BANKS[r.skill_id].questions = [];
      QUESTION_BANKS[r.skill_id].questions.push(item);
    }
  });
  renderDashboardPracticeCards();
}

/* ---------------- Grammatika: umumiy imtihon uchun kategoriya bo'yicha taqsimot ----------------
   Umumiy "Grammatika mahorati" (real imtihon) 30 ta savoldan iborat:
   - 15 ta النحو (nahv)
   - 7 ta الصرف (sarf)
   - 4 ta الإملاء (imlo)
   - 4 ta الأخطاء الشائعة (xatolar)
   Jami: 30 ta savol shu nisbatda tasodifiy tanlanadi. */
const GRAMMAR_EXAM_DISTRIBUTION = { nahv: 15, sarf: 7, imlo: 4, xatolar: 4 };
function shuffleArray(arr){
  const a = arr.slice();
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}

/* ==================== SAVOL/TEST ROTATSIYASI ====================
   Muammo: har safar mustaqil random.choice/shuffle+slice qilinganda, avval chiqqan
   savol/test tasodifan yana chiqib qolishi mumkin edi (statistik jihatdan normal,
   lekin foydalanuvchi buni "xato" deb qabul qiladi).

   Yechim — har bir tanlash nuqtasi uchun "kim ko'rsatilgan / kim hali ko'rsatilmagan"
   holatini localStorage'da saqlaymiz:

   - CORRECTNESS rejimi (masalan A/B/C kabi mustaqil MCQ savollar banki): foydalanuvchi
     TO'G'RI javob bergan savol — qolgan barcha (hali tushmagan) savollar aylanib
     chiqmaguncha qayta tushmaydi. XATO javob berilgan savol esa darhol yana tushishi
     mumkin (rotatsiyadan chiqarilmaydi / bor bo'lsa olib tashlanadi).
     -> rotationPickN/rotationPick1 bilan tanlanadi, keyin natija chiqqach
        rotationMarkResult(poolKey, savol, toGri_mi) chaqiriladi.

   - SEEN rejimi (masalan qiroa/istima testi, kitaba mavzusi, muhavara savoli — bularda
     "to'g'ri/xato" tushunchasi yo'q yoki bitta birlik bir nechta kichik savoldan
     iborat): tanlangan birlik ko'rsatilishi bilanoq "ko'rilgan" deb belgilanadi va
     qolgan barcha birliklar tugamaguncha qayta tanlanmaydi.
     -> rotationPickN/rotationPick1 bilan tanlab, darhol rotationMarkSeen(poolKey, ...)
        chaqiriladi.

   Har ikkala rejimda ham: agar hali "ko'rilmagan/xato" elementlar soni kerakli
   miqdordan kam bo'lsa, demak bitta aylanish tugagan — rotatsiya avtomatik reset
   bo'ladi (hammasi qayta faollashadi) va tanlash shu yangi to'liq to'plamdan davom
   etadi. Shu tarzda: bitta test/urinish ICHIDA hech qachon bir xil element ikki marta
   tanlanmaydi, va KETMA-KET urinishlar orasida ham butun bank aylanib chiqmasdan
   turib bironta element ikkinchi marta tushmaydi. */
const ROTATION_LS_KEY = 'attanal_rotation_v1';
function _rotationLoadAll(){
  try{
    const raw = localStorage.getItem(ROTATION_LS_KEY);
    return raw ? JSON.parse(raw) : {};
  }catch(e){ return {}; }
}
function _rotationSaveAll(all){
  try{ localStorage.setItem(ROTATION_LS_KEY, JSON.stringify(all)); }catch(e){}
}
function _rotationQId(q){
  // Barqaror identifikator: id bo'lsa shundan, bo'lmasa matn/audio/passage bo'yicha.
  if(!q) return '';
  if(q.id !== undefined && q.id !== null && q.id !== '') return 'id:'+String(q.id);
  const fallback = q.q || q.audioUrl || q.passage || q.topic || JSON.stringify(q).slice(0,160);
  return 'txt:'+String(fallback).slice(0,160);
}
/* poolKey — shu tanlash nuqtasining noyob kaliti (masalan 'grammar_exam_nahv',
   'istima_juz2'). fullPool — shu turdagi barcha mavjud elementlar. n — nechta kerak.
   Natija — TAKRORLANMAYDIGAN, iloji boricha "hali ko'rilmagan/xato" elementlardan
   iborat massiv (n tagacha, yoki fullPool.length dan oshmaydi). */
function rotationPickN(poolKey, fullPool, n){
  if(!Array.isArray(fullPool) || fullPool.length === 0 || n <= 0) return [];
  const all = _rotationLoadAll();
  const retired = new Set(all[poolKey] || []);
  let eligible = fullPool.filter(q => !retired.has(_rotationQId(q)));
  const need = Math.min(n, fullPool.length);
  if(eligible.length < need){
    // Bitta aylanish tugadi — rotatsiya reset, hammasi qayta faollashadi.
    eligible = fullPool.slice();
  }
  return shuffleArray(eligible).slice(0, need);
}
function rotationPick1(poolKey, fullPool){
  const picked = rotationPickN(poolKey, fullPool, 1);
  return picked.length ? picked[0] : null;
}
/* SEEN rejimi: tanlangan birlik(lar)ni darhol "ko'rilgan" (retired) deb belgilaydi. */
function rotationMarkSeen(poolKey, items){
  const all = _rotationLoadAll();
  const retired = new Set(all[poolKey] || []);
  (Array.isArray(items) ? items : [items]).forEach(q=>{ if(q) retired.add(_rotationQId(q)); });
  all[poolKey] = Array.from(retired);
  _rotationSaveAll(all);
}
/* CORRECTNESS rejimi: to'g'ri javob -> rotatsiyadan chiqariladi (retired),
   xato javob -> darhol qayta faollashtiriladi (retired'dan olib tashlanadi). */
function rotationMarkResult(poolKey, question, isCorrect){
  const all = _rotationLoadAll();
  const retired = new Set(all[poolKey] || []);
  const qid = _rotationQId(question);
  if(isCorrect) retired.add(qid); else retired.delete(qid);
  all[poolKey] = Array.from(retired);
  _rotationSaveAll(all);
}
function buildGrammarExamQuestions(){
  const byCategory = {
    nahv: [],
    sarf: [],
    imlo: [],
    xatolar: []
  };

  // 1. Asosiy manba: mavzusiz real imtihon savollar banki (QUESTION_BANKS.grammatika.questions)
  const examPool = QUESTION_BANKS.grammatika?.questions || [];
  examPool.forEach(q=>{
    const cat = q.category || 'nahv';
    if(byCategory[cat]) byCategory[cat].push(q);
    else byCategory.nahv.push(q);
  });

  // 2. Agar mavzularda ham savollar bo'lsa (va real imtihon bankida hali dublikat bo'lmasa), zaxira sifatida foydalanish
  GRAMMAR_TOPICS.forEach(t=>{
    const cat = t.category || 'nahv';
    const qs = GRAMMAR_TOPIC_BANKS[t.id] || [];
    qs.forEach(q=>{
      const isAlreadyIn = examPool.some(ep => (ep.id && ep.id === q.id) || ep.q === q.q);
      if(!isAlreadyIn){
        if(byCategory[cat]) byCategory[cat].push(q);
        else byCategory.nahv.push(q);
      }
    });
  });

  let result = [];
  const shortage = [];
  const details = [];

  Object.keys(GRAMMAR_EXAM_DISTRIBUTION).forEach(cat=>{
    const need = GRAMMAR_EXAM_DISTRIBUTION[cat];
    const catMeta = GRAMMAR_CATEGORIES.find(c=>c.id===cat) || { name: cat };
    // Rotatsiya: to'g'ri javob berilgan savol qolganlar tugamaguncha qayta tushmaydi
    // (natija rotationMarkResult orqali finishQuiz'da yoziladi), xato javob berilgani
    // esa darhol qayta faollashadi.
    const picked = rotationPickN('grammar_exam_'+cat, byCategory[cat] || [], need);
    
    result = result.concat(picked);
    details.push(`${catMeta.name}: ${picked.length}/${need}`);
    
    if(picked.length < need){
      shortage.push(`${catMeta.name} (${picked.length}/${need})`);
    }
  });

  // Agar umumiy savollar soni 30 tadan kam bo'lsa, mavjud boshqa barcha savollar ichidan to'ldiramiz
  if(result.length < 30){
    const selectedKeys = new Set(result.map(q => q.id || q.q));
    const allRemaining = [];
    Object.values(byCategory).forEach(list=>{
      list.forEach(q=>{
        if(!selectedKeys.has(q.id || q.q)){
          allRemaining.push(q);
        }
      });
    });
    const extraNeeded = 30 - result.length;
    const extra = shuffleArray(allRemaining).slice(0, extraNeeded);
    result = result.concat(extra);
  }

  return { questions: shuffleArray(result), shortage, details };
}

/* Admin — real foydalanuvchilar ro'yxati. */
let ADMIN_USERS = [];
let adminUsersLoaded = false;
function applyLiveAdminUsers(rows){
  adminUsersLoaded = true; // backend javob berdi (bo'sh bo'lsa ham) — "Yuklanmoqda" tugadi
  if(Array.isArray(rows) && rows.length){
    ADMIN_USERS = rows.map(u=>({
      id: pick(u, ['telegram_id','id','user_id'], 0),
      name: pick(u, ['name','full_name','first_name'], 'Foydalanuvchi'),
      username: pick(u, ['username'], ''),
      level: pick(u, ['level'], 'A1'),
      xp: Number(pick(u, ['xp'], 0)) || 0,
      lastActive: formatLastActive(pick(u, ['last_active','lastActive','last_seen'], '-')),
      rawLastActive: pick(u, ['last_active','lastActive','last_seen'], null),
      createdAt: pick(u, ['created_at','registered_at','joined_at','reg_date','createdAt','regDate'], null),
      isBlocked: Boolean(u.is_blocked || u.blocked || u.is_bot_blocked || u.bot_blocked || (typeof u.status === 'string' && u.status.toLowerCase().includes('block'))),
      skills: u.skills || {},
      raw: u
    }));
  } else {
    ADMIN_USERS = [];
  }
  if(document.getElementById('view-admin')?.classList.contains('active')) renderAdminPanel();
}

/* Ba'zan foydalanuvchi ilovani ochgan zahoti (savollar banki hali serverdan
   to'liq yuklanib ulgurmasdan) biror mahoratga kirsa, bank vaqtincha bo'sh
   ko'rinib, "hali savol yo'q" degan NOTO'G'RI xabar chiqib ketardi (bir necha
   soniyadan keyin qayta bossa ishlab ketardi). Bu funksiya buni tuzatadi:
   agar ilova hali APP_READY bo'lmagan bo'lsa (ma'lumotlar hali yuklanmoqda),
   xato ko'rsatish o'rniga foydalanuvchini kutadi va yuklanish tugashi bilan
   urinishni o'zi avtomatik qayta boshlaydi. Agar ilova ALLAQACHON APP_READY
   bo'lsa (ya'ni ma'lumot rostdan ham yo'q — masalan admin hali qo'shmagan),
   false qaytaradi va chaqiruvchi joydagi asl xato xabari ko'rsatiladi. */
function retryWhenDataReady(retryFn){
  if(typeof APP_READY !== 'undefined' && APP_READY) return false;
  toast("⏳ Ma'lumotlar hali yuklanmoqda, biroz kuting...", 3000);
  const start = Date.now();
  const iv = setInterval(()=>{
    const ready = (typeof APP_READY !== 'undefined' && APP_READY);
    if(ready || Date.now() - start > 10000){
      clearInterval(iv);
      retryFn();
    }
  }, 300);
  return true;
}

/* ---------------- Start quiz ---------------- */
/* ==================== DUEL (asinxron bellashuv) ====================
   HOZIRCHA: backend yo'q, shu sabab quyidagi apiXxx() funksiyalar vaqtincha
   localStorage'da ishlaydi (faqat shu qurilmada ko'rinadi, ikkinchi tomon
   buni real ko'ra olmaydi). Backend (Supabase RPC: create_duel / join_duel /
   submit_duel_result / get_my_duels) ulanganda, FAQAT shu apiXxx()
   funksiyalar ichini fetch/RPC chaqiruviga almashtirish kifoya — qolgan
   UI/render kodi (renderDuelHub, renderDuelCard, startDuelQuiz,
   renderDuelResultScreen) o'zgarishsiz qoladi. */
const DUEL_QUESTION_COUNT = 10;
const DUEL_QUESTION_SECONDS = 30; /* Duelda har bir savol uchun vaqt */

/* ---------- Duel — Supabase RPC orqali haqiqiy backend ----------
   Barcha apiXxx() funksiyalari endi localStorage o'rniga
   SUPABASE_URL + authHeaders() (allaqachon ilovaning yuqorisida
   ta'riflangan) yordamida haqiqiy RPC chaqiruvlarini bajaradi.
   Kerakli SQL migratsiya (jadval + RPC funksiyalar) alohida
   duel_backend.sql faylida berilgan — uni Supabase SQL Editor'da
   bir marta ishga tushirish kifoya. */
const LOCAL_DUELS_KEY = 'mishkat_local_duels_cache';

function getCachedLocalDuels(){
  try {
    const raw = localStorage.getItem(LOCAL_DUELS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch(e){ return []; }
}

function setCachedLocalDuels(duels){
  try {
    if(Array.isArray(duels)){
      localStorage.setItem(LOCAL_DUELS_KEY, JSON.stringify(duels.slice(0, 50)));
    }
  } catch(e){}
}

async function duelRpc(name, body){
  if(!SUPABASE_URL || typeof fetch === 'undefined') return null;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify(body || {})
  });
  const text = await res.text();
  if(!res.ok){ throw new Error(text || ('HTTP ' + res.status)); }
  return text ? JSON.parse(text) : null;
}
function _duelUnwrap(data){ return Array.isArray(data) ? (data[0] || null) : data; }

function _duelMyRawId(){
  return (typeof TELEGRAM_PROFILE !== 'undefined' && TELEGRAM_PROFILE) ? TELEGRAM_PROFILE.rawId : null;
}
function _duelRequireAuth(){
  if(_duelMyRawId() == null){
    toast("⚠️ Duel funksiyasi uchun avval Telegram orqali kiring");
    return false;
  }
  return true;
}
function _duelMyId(){
  const p = (typeof TELEGRAM_PROFILE !== 'undefined') ? TELEGRAM_PROFILE : null;
  return String((p && (p.rawId != null ? p.rawId : p.id)) || 'me');
}
function _duelMyName(){ return (typeof TELEGRAM_PROFILE !== 'undefined' && TELEGRAM_PROFILE.name) || 'Siz'; }

/* Backenddan kelgan qator (snake_case)ni ilovaning boshqa joylarida
   ishlatiladigan eski (camelCase, nested challenger/opponent) shaklga
   o'giradi — shu tufayli renderDuelHub/renderDuelCard/renderDuelResultScreen
   va boshqa UI kodi butunlay o'zgarishsiz qoladi. */
function _duelFromRow(row){
  if(!row) return null;
  return {
    id: row.id,
    token: row.token,
    skillId: row.skill_id,
    count: row.count,
    category: row.category,
    questions: row.questions || [],
    duelType: row.duel_type || 'grammar',
    expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : null,
    challenger: { id: String(row.challenger_id), name: row.challenger_name, photoUrl: row.challenger_photo_url || null },
    opponent: (row.opponent_id != null) ? { id: String(row.opponent_id), name: row.opponent_name, photoUrl: row.opponent_photo_url || null } : null,
    challengerResult: row.challenger_result || null,
    opponentResult: row.opponent_result || null,
    status: row.status,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
  };
}
/* "Aralash savollar" duelida qat'iy nisbat: Nahv 5, Sarf 3, Imlo 1, Xato 1 (jami 10 ta) */
const DUEL_MIX_RATIO = { nahv:5, sarf:3, imlo:1, xatolar:1 };

function _duelBuildSnapshot(skillId, count, category){
  if(skillId === 'vocabularies'){
    return _duelBuildVocabSnapshot(category, count);
  }
  const fullBank = (QUESTION_BANKS[skillId] && QUESTION_BANKS[skillId].questions) || [];
  const toQ = q => ({ id: q.id, q: q.q, opts: q.opts, a: q.a, exp: q.exp || '', category: q.category || '' });

  if(!category || category === 'aralash'){
    let mixed = [];
    Object.keys(DUEL_MIX_RATIO).forEach(cat=>{
      const need = DUEL_MIX_RATIO[cat];
      const catBank = shuffleArray(fullBank.filter(q => q.category === cat));
      mixed = mixed.concat(catBank.slice(0, need));
    });
    /* Agar biror kategoriyada yetarli savol topilmasa, qolgan o'rinlarni
       ishlatilmagan savollardan to'ldiramiz (jami sonni saqlab qolish uchun) */
    if(mixed.length < count){
      const usedIds = new Set(mixed.map(q=>q.id));
      const filler = shuffleArray(fullBank.filter(q=>!usedIds.has(q.id)));
      mixed = mixed.concat(filler.slice(0, count - mixed.length));
    }
    return shuffleArray(mixed).slice(0, count).map(toQ);
  }

  const bank = fullBank.filter(q => q.category === category);
  return shuffleArray(bank).slice(0, count).map(toQ);
}

/* Lug'atlar bazasidan duel uchun 10 ta test savollarini avtomatik tuzish */
function _duelBuildVocabSnapshot(categoryParam, count = 10){
  let pool = Array.isArray(ADMIN_VOCABULARIES) && ADMIN_VOCABULARIES.length ? ADMIN_VOCABULARIES : getLocalVocabularies();
  if(!pool || !pool.length){
    // Agar umuman bo'sh bo'lsa
    toast("⚠️ Lug'atlar bazasi bo'sh. Avval lug'at qo'shing.");
    return [];
  }

  let bookName = categoryParam || 'all';
  let topicName = 'all';
  if(categoryParam && typeof categoryParam === 'string' && categoryParam.includes(':::')){
    const parts = categoryParam.split(':::');
    bookName = parts[0] || 'all';
    topicName = parts[1] || 'all';
  }

  let targetWords = pool;
  if(bookName && bookName !== 'all'){
    targetWords = targetWords.filter(v => (v.book_name || '').trim() === bookName.trim());
  }
  if(topicName && topicName !== 'all'){
    targetWords = targetWords.filter(v => (v.topic || '').trim() === topicName.trim());
  }

  if(!targetWords.length){
    targetWords = (bookName && bookName !== 'all')
      ? pool.filter(v => (v.book_name || '').trim() === bookName.trim())
      : pool;
  }
  if(!targetWords.length) targetWords = pool;

  const shuffledTargets = shuffleArray([...targetWords]);
  const selectedTargets = shuffledTargets.slice(0, count);

  // 10 taga yetmasa takrorlash orqali to'ldirish
  while(selectedTargets.length < count && targetWords.length > 0){
    selectedTargets.push(targetWords[Math.floor(Math.random() * targetWords.length)]);
  }

  const questions = selectedTargets.map((item, idx) => {
    const isArToUz = Math.random() > 0.35; // Arabchadan o'zbekchaga yoki aksincha
    const wordSafe = (item.word || '—').trim();
    const transSafe = (item.translation || '—').trim();
    const bookTitle = item.book_name || 'Lug\'at';
    const topicTitle = item.topic ? ` · ${item.topic}` : '';

    if(isArToUz){
      const correctOpt = transSafe;
      const wrongPool = shuffleArray(pool.filter(w => (w.translation || '').trim() !== correctOpt));
      const wrongOpts = [];
      const used = new Set([correctOpt]);
      for(const w of wrongPool){
        const t = (w.translation || '').trim();
        if(t && !used.has(t)){
          wrongOpts.push(t);
          used.add(t);
          if(wrongOpts.length === 3) break;
        }
      }
      while(wrongOpts.length < 3){
        wrongOpts.push(`Boshqa variant ${wrongOpts.length + 1}`);
      }
      const allOpts = shuffleArray([correctOpt, ...wrongOpts]);
      const correctIdx = allOpts.indexOf(correctOpt);

      return {
        id: item.id || `vq_${idx}_${Date.now()}`,
        q: `<div style="font-family:'Noto Sans Arabic','Noto Sans',sans-serif;font-size:22px;font-weight:700;color:var(--emerald-700,#047857);direction:rtl;margin-bottom:6px;" class="notranslate">${escapeHtml(wordSafe)}</div> so'zining to'g'ri ma'nosini toping:`,
        opts: allOpts,
        a: correctIdx,
        exp: `${wordSafe} — ${transSafe} (${bookTitle}${topicTitle})`,
        category: item.topic ? `${bookTitle} · ${item.topic}` : bookTitle
      };
    } else {
      const correctOpt = wordSafe;
      const wrongPool = shuffleArray(pool.filter(w => (w.word || '').trim() !== correctOpt));
      const wrongOpts = [];
      const used = new Set([correctOpt]);
      for(const w of wrongPool){
        const wAr = (w.word || '').trim();
        if(wAr && !used.has(wAr)){
          wrongOpts.push(wAr);
          used.add(wAr);
          if(wrongOpts.length === 3) break;
        }
      }
      while(wrongOpts.length < 3){
        wrongOpts.push(`—`);
      }
      const allOpts = shuffleArray([correctOpt, ...wrongOpts]);
      const correctIdx = allOpts.indexOf(correctOpt);

      return {
        id: item.id || `vq_${idx}_${Date.now()}`,
        q: `«<b>${escapeHtml(transSafe)}</b>» so'zining arabcha tarjimasini toping:`,
        opts: allOpts,
        a: correctIdx,
        exp: `${wordSafe} — ${transSafe} (${bookTitle}${topicTitle})`,
        category: item.topic ? `${bookTitle} · ${item.topic}` : bookTitle
      };
    }
  });

  return questions;
}

/* Supabase RPC create_duel(p_challenger_id, p_challenger_name, p_skill_id, p_count, p_category, p_questions) */
async function apiCreateDuel(skillId, count, category){
  if(!_duelRequireAuth()) return null;
  const questions = (skillId === 'vocabularies') 
    ? _duelBuildVocabSnapshot(category, count) 
    : _duelBuildSnapshot(skillId, count, category);

  if(!questions || !questions.length){
    toast("⚠️ Duel uchun savollar topilmadi");
    return null;
  }
  try{
    const row = _duelUnwrap(await duelRpc('create_duel', {
      p_challenger_id: _duelMyRawId(),
      p_challenger_name: _duelMyName(),
      p_skill_id: skillId,
      p_count: count,
      p_category: category || 'aralash',
      p_questions: questions,
      p_challenger_photo_url: (typeof TELEGRAM_PROFILE !== 'undefined' && TELEGRAM_PROFILE.photoUrl) || null
    }));
    return _duelFromRow(row);
  }catch(e){
    console.error('[apiCreateDuel]', e);
    toast('⚠️ Duel yaratilmadi: ' + (e.message||'').slice(0,140), 5000);
    return null;
  }
}
/* Supabase RPC create_speaking_duel(p_challenger_id, p_challenger_name, p_challenger_photo_url)
   Speaking duel — Grammatika duelidan farqli, savollar snapshot frontendda
   emas, backendda (SQL RPC ichida) tasodifiy tanlanadi (duel_speaking_questions
   bankidan). expires_at = yaratilgan vaqt + 24 soat (SQL tomonda o'rnatiladi). */
async function apiCreateSpeakingDuel(){
  if(!_duelRequireAuth()) return null;
  try{
    const row = _duelUnwrap(await duelRpc('create_speaking_duel', {
      p_challenger_id: _duelMyRawId(),
      p_challenger_name: _duelMyName(),
      p_challenger_photo_url: (typeof TELEGRAM_PROFILE !== 'undefined' && TELEGRAM_PROFILE.photoUrl) || null
    }));
    return _duelFromRow(row);
  }catch(e){
    console.error('[apiCreateSpeakingDuel]', e);
    toast('⚠️ Speaking duel yaratilmadi: ' + (e.message||'').slice(0,140), 5000);
    return null;
  }
}
/* Supabase RPC get_duel_by_token(p_token) */
async function apiGetDuelByToken(token){
  try{
    const row = _duelUnwrap(await duelRpc('get_duel_by_token', { p_token: token }));
    return _duelFromRow(row);
  }catch(e){ return null; }
}
/* Supabase RPC join_duel(p_token, p_opponent_id, p_opponent_name) */
async function apiJoinDuel(token){
  if(!_duelRequireAuth()) return null;
  try{
    const row = _duelUnwrap(await duelRpc('join_duel', {
      p_token: token,
      p_opponent_id: _duelMyRawId(),
      p_opponent_name: _duelMyName(),
      p_opponent_photo_url: (typeof TELEGRAM_PROFILE !== 'undefined' && TELEGRAM_PROFILE.photoUrl) || null
    }));
    const duelObj = _duelFromRow(row);
    if(duelObj){
      const cached = getCachedLocalDuels().filter(x => x.id !== duelObj.id);
      setCachedLocalDuels([duelObj, ...cached]);
    }
    return duelObj;
  }catch(e){
    toast("⚠️ Duelga qo'shilmadi: " + (e.message||'').slice(0,140), 5000);
    return null;
  }
}
/* Supabase RPC get_my_duels(p_user_id) */
async function apiGetMyDuels(){
  if(_duelMyRawId() == null) return getCachedLocalDuels();
  try{ await duelRpc('expire_stale_speaking_duels', {}); }catch(e){ /* jim, kritik emas */ }
  try{
    const rows = await duelRpc('get_my_duels', { p_user_id: _duelMyRawId() });
    const list = (Array.isArray(rows) ? rows : []).map(_duelFromRow);
    if(list && list.length > 0){
      setCachedLocalDuels(list);
    }
    return list.length ? list : getCachedLocalDuels();
  }catch(e){
    return getCachedLocalDuels();
  }
}
/* Supabase RPC submit_duel_result(p_duel_id, p_user_id, p_score, p_total, p_time_sec) */
async function apiSubmitDuelResult(duelId, res){
  if(!_duelRequireAuth()) return null;
  try{
    const row = _duelUnwrap(await duelRpc('submit_duel_result', {
      p_duel_id: duelId,
      p_user_id: _duelMyRawId(),
      p_score: res.score,
      p_total: res.total,
      p_time_sec: res.timeSec
    }));
    const duelObj = _duelFromRow(row);
    if(duelObj){
      const cached = getCachedLocalDuels().filter(x => x.id !== duelObj.id);
      setCachedLocalDuels([duelObj, ...cached]);
    }
    return duelObj;
  }catch(e){
    toast('⚠️ Natija saqlanmadi: ' + (e.message||'').slice(0,140), 6000);
    return null;
  }
}

/* ---------- Duel: har bir savol bo'yicha "jonli" holat (gibrid sinxron) ----------
   Har bir tomon javob berganda submit_duel_answer chaqiriladi (backendga yoziladi).
   Kutayotgan tomon esa get_duel_opponent_answer orqali pollaydi (1.5s'da bir marta)
   va raqib javob berishi bilan darhol keyingi savolga o'tadi. Agar raqib umuman
   javob bermasa — 30 soniyalik umumiy vaqt tugaganda avtomatik o'tiladi (mavjud
   startQuestionTimer/expired mexanizmi), yoki foydalanuvchi "Yolg'iz davom etish"
   tugmasi bilan kutmasdan o'tishi mumkin (bu faqat client-side qaror, backendga
   ta'sir qilmaydi). Supabase RPC: submit_duel_answer / get_duel_opponent_answer
   (duel_backend.sql ga qo'shiladi). */
async function apiSubmitDuelAnswer(duelId, questionIndex, picked){
  if(_duelMyRawId() == null) return;
  try{
    await duelRpc('submit_duel_answer', {
      p_duel_id: duelId,
      p_user_id: _duelMyRawId(),
      p_question_index: questionIndex,
      p_picked: (picked === null || picked === undefined) ? null : picked
    });
  }catch(e){}
}
async function apiGetDuelOpponentAnswer(duelId, questionIndex){
  if(_duelMyRawId() == null) return null;
  try{
    const row = _duelUnwrap(await duelRpc('get_duel_opponent_answer', {
      p_duel_id: duelId,
      p_user_id: _duelMyRawId(),
      p_question_index: questionIndex
    }));
    return row || null;
  }catch(e){ return null; }
}
/* Supabase RPC get_duel_answers(p_duel_id) — ikkala tomonning duel
   yakunlangandan keyingi to'liq javoblar ro'yxatini (har bir savol
   indeksi bo'yicha challenger_picked / opponent_picked) bitta so'rovda
   qaytaradi. Faqat submit_duel_answer orqali saqlangan (ya'ni yangi
   sxema bo'yicha o'ynalgan) duellarda ma'lumot bo'ladi — eski duellarda
   bo'sh massiv qaytadi va tahlil ko'rsatilmaydi. */
async function apiGetDuelAnswers(duelId){
  try{
    const rows = await duelRpc('get_duel_answers', { p_duel_id: duelId });
    return Array.isArray(rows) ? rows : [];
  }catch(e){ return []; }
}

async function apiGetDuelSpeakingAnswers(duelId){
  try{
    const rows = await duelRpc('get_duel_speaking_answers', { p_duel_id: duelId });
    return Array.isArray(rows) ? rows : [];
  }catch(e){ return []; }
}

/* Speaking Duel "Tahlil" — ikkala tarafning har savolga bergan transkripti,
   bali va AI izohini ketma-ket ko'rsatadi. Grid+detail popup (grammatika
   duelidagi kabi) o'rniga to'g'ridan-to'g'ri ro'yxat, chunki bu yerda
   "to'g'ri/noto'g'ri" belgisi yo'q, faqat matn+ball. */
async function openSpeakingDuelAnalysis(){
  const d = _duelCurrentResult;
  if(!d) return;
  document.getElementById('modalTitle').textContent = "Muhadasa — Tahlil";
  document.getElementById('modalBody').innerHTML = `<div style="text-align:center;padding:34px 0;color:var(--text-dim);font-size:13.5px;">Yuklanmoqda...</div>`;
  document.getElementById('modalOverlay').classList.add('show');

  const me = _duelMyId();
  const iAmChallenger = d.challenger.id === me;
  const myId = iAmChallenger ? d.challenger.id : d.opponent.id;
  const oppId = iAmChallenger ? d.opponent.id : d.challenger.id;
  const myName = _duelMyName();
  const oppName = (iAmChallenger ? d.opponent : d.challenger) ? (iAmChallenger ? d.opponent.name : d.challenger.name) : 'Raqib';

  const rows = await apiGetDuelSpeakingAnswers(d.id);
  const questions = Array.isArray(d.questions) ? d.questions : [];

  const byIdx = {};
  rows.forEach(r=>{
    const idx = r.question_index;
    if(!byIdx[idx]) byIdx[idx] = {};
    if(String(r.user_id) === String(myId)) byIdx[idx].mine = r;
    else if(String(r.user_id) === String(oppId)) byIdx[idx].opp = r;
  });

  const sideBlock = (label, r) => {
    if(!r){
      return `<div style="padding:10px 12px;border-radius:12px;background:var(--card-alt);border:1px solid var(--border);color:var(--text-faint);font-size:12.5px;font-weight:600;">${escapeHtml(label)}: hali javob bermagan</div>`;
    }
    return `
      <div style="padding:10px 12px;border-radius:12px;background:var(--card-alt);border:1px solid var(--border);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <span style="font-size:12px;font-weight:700;color:var(--text-dim);">${escapeHtml(label)}</span>
          <span style="font-size:13px;font-weight:800;">${r.score ?? 0}/5</span>
        </div>
        ${r.transcript ? `<div style="font-size:12.5px;line-height:1.5;margin-top:2px;">🎙 "${escapeHtml(r.transcript)}"</div>` : ''}
        ${r.feedback ? `<div style="font-size:12px;color:var(--text-faint);margin-top:4px;">💡 ${escapeHtml(r.feedback)}</div>` : ''}
      </div>`;
  };

  const bodyHtml = questions.map((q,i)=>{
    const entry = byIdx[i] || {};
    return `
      <div style="margin-bottom:16px;">
        <div style="font-family:var(--font-ar);font-size:16px;direction:rtl;text-align:right;line-height:1.6;font-weight:600;margin-bottom:8px;">${q.prompt_ar || ''}</div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${sideBlock(myName, entry.mine)}
        </div>
      </div>`;
  }).join('');

  document.getElementById('modalBody').innerHTML = `
    <div style="display:flex;flex-direction:column;">
      ${bodyHtml || `<div class="review-hint" style="margin:0;">Tahlil topilmadi</div>`}
      <button type="button" class="btn btn-primary btn-block" style="margin-top:6px;" onclick="document.getElementById('modalOverlay').classList.remove('show')">Yopish</button>
    </div>`;
}

/* Do'stlar ro'yxati alohida jadvalsiz — siz duel o'ynagan (yoki hali javob
   kutayotgan) raqiblardan get_my_duels natijasi asosida hisoblanadi. */
async function apiGetFriends(){
  const me = _duelMyId();
  const duels = (await apiGetMyDuels()).filter(d => d.opponent);
  const map = new Map();
  duels.forEach(d=>{
    const iAmChallenger = d.challenger.id === me;
    const friend = iAmChallenger ? d.opponent : d.challenger;
    if(!friend) return;
    if(!map.has(friend.id)){
      map.set(friend.id, { id:friend.id, name:friend.name, wins:0, losses:0, draws:0, total:0, lastAt:d.createdAt });
    }
    const entry = map.get(friend.id);
    entry.total++;
    if(d.createdAt > entry.lastAt) entry.lastAt = d.createdAt;
    if(d.status === 'completed'){
      const myR = iAmChallenger ? d.challengerResult : d.opponentResult;
      const oppR = iAmChallenger ? d.opponentResult : d.challengerResult;
      if(myR && oppR){
        if(myR.score === oppR.score){
          if(myR.timeSec === oppR.timeSec) entry.draws++;
          else if(myR.timeSec < oppR.timeSec) entry.wins++;
          else entry.losses++;
        } else if(myR.score > oppR.score) entry.wins++;
        else entry.losses++;
      }
    }
  });
  return Array.from(map.values()).sort((a,b)=> b.lastAt - a.lastAt);
}

async function renderFriendsHub(){
  const listEl = document.getElementById('friendsList');
  const emptyEl = document.getElementById('friendsEmpty');
  if(!listEl) return;
  const friends = await apiGetFriends();
  if(!friends.length){
    listEl.innerHTML = '';
    if(emptyEl) emptyEl.style.display = '';
    return;
  }
  if(emptyEl) emptyEl.style.display = 'none';
  listEl.innerHTML = friends.map(renderFriendCard).join('');
}

function renderFriendCard(f){
  const initial = escapeHtml((f.name || '?').trim().charAt(0).toUpperCase());
  const statsParts = [`${f.wins} g'alaba`, `${f.losses} mag'lubiyat`];
  if(f.draws) statsParts.push(`${f.draws} durrang`);
  const nameSafe = escapeHtml(f.name || "Do'st");
  return `
    <div class="card history-item">
      <div class="avatar" style="width:44px;height:44px;font-size:16px;flex-shrink:0;">${initial}</div>
      <div class="history-main">
        <div class="t">${nameSafe}</div>
        <div class="s" style="margin-top:3px;color:var(--text-faint);font-weight:600;font-size:12px;">${statsParts.join(' · ')}</div>
      </div>
      <button type="button" class="history-btn-analyze" onclick="openDuelSkillSelect()"><span>Duelga chaqirish</span></button>
    </div>`;
}

let _duelHistoryCache = {};

async function renderDuelHub(){
  const listEl = document.getElementById('duelList');
  const emptyEl = document.getElementById('duelEmpty');
  if(!listEl) return;
  const me = _duelMyId();
  const duels = (await apiGetMyDuels()).sort((a,b)=> b.createdAt - a.createdAt);
  _duelHistoryCache = {};
  duels.forEach(d=>{ 
    if(d && d.id != null) {
      _duelHistoryCache[String(d.id)] = d;
      _duelHistoryCache[d.id] = d;
    }
  });
  if(!duels.length){
    listEl.innerHTML = '';
    if(emptyEl) emptyEl.style.display = '';
    return;
  }
  if(emptyEl) emptyEl.style.display = 'none';
  listEl.innerHTML = duels.map(d=>renderDuelCard(d, me)).join('');
}

/* Tarix ro'yxatidagi duel obyektlarini id bo'yicha keshlab turadi — karta
   bosilganda qayta backendga so'rov yubormasdan, natija ekranini darhol
   ochish uchun ishlatiladi. */
function openDuelResultCard(duelId){
  const d = _duelHistoryCache[String(duelId)] || _duelHistoryCache[duelId];
  if(!d) return;
  showView('duelresult');
  renderDuelResultScreen(d);
}

function renderDuelCard(d, me){
  const iAmChallenger = d.challenger.id === me;
  const oppName = d.opponent ? (iAmChallenger ? d.opponent.name : d.challenger.name) : null;
  const oppPhoto = d.opponent ? (iAmChallenger ? d.opponent.photoUrl : d.challenger.photoUrl) : null;
  const myResult = iAmChallenger ? d.challengerResult : d.opponentResult;
  const oppResult = iAmChallenger ? d.opponentResult : d.challengerResult;
  const isSpeaking = d.duelType === 'speaking';
  const isVocab = d.skillId === 'vocabularies';
  const skillMeta = isSpeaking
    ? {name:'Muhadasa', color:'var(--muhavara,#8B5CF6)', bg:'rgba(139,92,246,0.12)'}
    : (isVocab
        ? {name:"Lug'atlar", color:'var(--emerald-600, #059669)', bg:'rgba(16,185,129,0.12)'}
        : (SKILLS.find(s=>s.id===d.skillId) || {name:'Grammatika', color:'var(--grammatika)', bg:'var(--grammatika-bg)'}));
  
  let catLabel = 'Aralash savollar';
  if(isSpeaking){
    catLabel = 'Muhadasa';
  } else if(isVocab){
    if(d.category && d.category.includes(':::')){
      const [b, t] = d.category.split(':::');
      catLabel = `${b} · ${t}`;
    } else if(d.category && d.category !== 'all'){
      catLabel = `${d.category} (Aralash)`;
    } else {
      catLabel = "Barcha kitoblar";
    }
  } else {
    const catMeta = GRAMMAR_CATEGORIES.find(c=>c.id===d.category);
    catLabel = catMeta ? catMeta.name : 'Aralash savollar';
  }
  const startFn = isSpeaking ? 'startSpeakingDuelQuiz' : 'startDuelQuiz';
  const resultFn = isSpeaking ? 'openSpeakingDuelResultCard' : 'openDuelResultCard';

  let statusHtml, actionHtml, cardStateClass = '', cardClickAttr = '';
  if(!d.opponent){
    statusHtml = `<span style="color:var(--text-faint);font-weight:600;font-size:12px;">⏳ Raqib kutilmoqda</span>`;
    actionHtml = `<button type="button" class="history-btn-analyze" onclick="reopenDuelInvite('${d.id}')"><span>Ulashish</span></button>`;
  } else if(d.status === 'completed'){
    let verdict;
    if(myResult.score === oppResult.score){
      if(myResult.timeSec === oppResult.timeSec){ verdict = "🤝 Durrang"; }
      else if(myResult.timeSec < oppResult.timeSec){ verdict = "🏆 Siz g'olib"; cardStateClass = 'duel-won'; }
      else { verdict = `🏆 ${escapeHtml(oppName)} g'olib`; cardStateClass = 'duel-lost'; }
    } else if(myResult.score > oppResult.score){
      verdict = "🏆 Siz g'olib"; cardStateClass = 'duel-won';
    } else {
      verdict = `🏆 ${escapeHtml(oppName)} g'olib`; cardStateClass = 'duel-lost';
    }
    statusHtml = `<span style="font-weight:700;font-size:12.5px;">${verdict}</span>`;
    actionHtml = `<div class="history-score"><b>${myResult.score}/${myResult.total}</b><div class="p">${escapeHtml(oppName)}: ${oppResult.score}/${oppResult.total}</div></div>`;
    cardClickAttr = ` onclick="${resultFn}('${d.id}')" style="cursor:pointer;"`;
  } else if(!myResult){
    statusHtml = `<span style="color:var(--indigo-700);font-weight:700;font-size:12.5px;">🎯 Sizning navbatingiz</span>`;
    actionHtml = `<button type="button" class="history-btn-analyze" onclick="${startFn}('${d.id}')"><span>Boshlash</span></button>`;
  } else {
    statusHtml = `<span style="color:var(--text-faint);font-weight:600;font-size:12px;">⏳ ${escapeHtml(oppName)} javobini kutmoqda</span>`;
    actionHtml = `<div class="history-score"><b>${myResult.score}/${myResult.total}</b></div>`;
    cardClickAttr = ` onclick="${resultFn}('${d.id}')" style="cursor:pointer;"`;
  }

  // Raqib qo'shilganda uning profil rasmi (yoki bosh harfi) ko'rsatiladi;
  // hali raqib yo'q bo'lsa — qilich ikonkasi qoladi.
  const avatarHtml = d.opponent
    ? (oppPhoto
        ? `<div class="history-icon" style="padding:0;overflow:hidden;"><img src="${oppPhoto}" alt="" style="width:100%;height:100%;object-fit:cover;"></div>`
        : `<div class="avatar" style="width:38px;height:38px;font-size:14px;">${escapeHtml((oppName||'?').trim().charAt(0).toUpperCase())}</div>`)
    : `<div class="history-icon" style="background:${skillMeta.bg};color:${skillMeta.color};">⚔️</div>`;

  return `
    <div class="card history-item ${cardStateClass}"${cardClickAttr}>
      ${avatarHtml}
      <div class="history-main">
        <div class="t">${d.opponent ? escapeHtml(oppName) : "Do'stni kuting"}</div>
        <div class="s" style="margin-top:2px;color:var(--text-faint);font-weight:600;font-size:11px;">${escapeHtml(catLabel)}</div>
        <div class="s" style="margin-top:3px;">${statusHtml}</div>
      </div>
      ${actionHtml}
    </div>`;
}

function shareDuelLink(token){
  // Agar WEBAPP_SHORT_NAME bo'sh bo'lsa — bot "Configure Mini App" (menyu tugmasi)
  // orqali ulangan, va havola short_name'siz t.me/<bot>?startapp=... shaklida bo'lishi kerak.
  // Agar WEBAPP_SHORT_NAME to'ldirilgan bo'lsa (BotFather /newapp orqali yaratilgan
  // nomlangan ilova) — t.me/<bot>/<short_name>?startapp=... shaklidan foydalaniladi.
  const url = WEBAPP_SHORT_NAME
    ? `https://t.me/${BOT_USERNAME}/${WEBAPP_SHORT_NAME}?startapp=duel_${token}`
    : `https://t.me/${BOT_USERNAME}?startapp=duel_${token}`;
  const text = `⚔️ Sizni arab tili bo'yicha bellashuvga chaqiraman! Qabul qiling — kim ko'proq to'g'ri javob berishini bilib olamiz.`;
  const tg = window.Telegram?.WebApp;
  if(tg && typeof tg.openTelegramLink === 'function'){
    tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`);
  } else if(navigator.share){
    navigator.share({ title:'Bellashuv', text, url }).catch(()=>{});
  } else if(navigator.clipboard){
    navigator.clipboard.writeText(`${text}\n${url}`);
    toast('Havola nusxalandi 📋');
  }
}

/* Bellashuv g'alabasini do'stlarga "ulashish" (natija ekranidagi yashil tugma). */
function shareDuelResultBrag(oppName, score, total, isSpeaking){
  const url = WEBAPP_SHORT_NAME
    ? `https://t.me/${BOT_USERNAME}/${WEBAPP_SHORT_NAME}`
    : `https://t.me/${BOT_USERNAME}`;
  const label = isSpeaking ? 'So\'zlashuv bellashuvida' : 'Grammatika bellashuvida';
  const text = `🏆 ${oppName}ni ${label} ${score}/${total} ball bilan mag'lub etdim! Meni yenga olasizmi?`;
  const tg = window.Telegram?.WebApp;
  if(tg && typeof tg.openTelegramLink === 'function'){
    tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`);
  } else if(navigator.share){
    navigator.share({ title:'Bellashuv g\'alabasi', text, url }).catch(()=>{});
  } else if(navigator.clipboard){
    navigator.clipboard.writeText(`${text}\n${url}`);
    toast('Nusxalandi 📋');
  }
}

async function startNewDuel(category){
  toast('⏳ Bellashuv yaratilmoqda...', 2000);
  const d = await apiCreateDuel('grammatika', DUEL_QUESTION_COUNT, category || 'aralash');
  if(!d) return; // xatolik bo'lsa apiCreateDuel o'zi toast chiqargan
  renderDuelHub();
  openDuelInviteScreen(d);
}

/* Duel uchun bo'lim tanlash oynasi: 2x2 Grid card style (iconsiz, toza matnli) */
function renderDuelSkillGrid(){
  const wrap = document.getElementById('duelSkillGrid');
  if(!wrap) return;

  const catConfigs = {
    nahv: { cardClass: 'card-duel-nahv' },
    sarf: { cardClass: 'card-duel-sarf' },
    imlo: { cardClass: 'card-duel-imlo' },
    xatolar: { cardClass: 'card-duel-xatolar' }
  };

  wrap.innerHTML = GRAMMAR_CATEGORIES.map(cat => {
    const cfg = catConfigs[cat.id] || catConfigs.nahv;
    const shortName = cat.id === 'xatolar' ? 'Xatolar' : cat.name;
    const shortAr = cat.id === 'xatolar' ? 'الأخطاء' : cat.ar;
    return `
      <div class="duel-grammar-card ${cfg.cardClass}" onclick="chooseDuelSkill('${cat.id}')" role="button" tabindex="0">
        <div class="dgc-top">
          <div class="dgc-ar font-ar-bold">${shortAr}</div>
          <div class="dgc-arrow">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </div>
        </div>
        <div class="dgc-bottom">
          <div class="dgc-name">${escapeHtml(shortName)}</div>
        </div>
      </div>
    `;
  }).join('');
}

function openDuelSkillSelect(){
  showView('duelskillselect');
}

async function openDuelGrammarSelect(){
  await startNewDuel('aralash');
}

async function chooseDuelSkill(category){
  await startNewDuel(category || 'aralash');
}

let CURRENT_DUEL_VOCAB_BOOK = '';

/* Duel — Lug'at kitobini tanlash (2-bosqich) */
async function openDuelVocabSelect(){
  showView('duelvocabselect');
  await renderDuelVocabGrid();
}

function formatBookDisplayName(name) {
  if (!name) return '';
  let clean = name.replace(/^manhaj(?:ul\s+ilmiya)?\s*[-_:]?\s*/i, '').trim();
  return clean || name;
}

function getBookLevelSubtitle(bookName) {
  const norm = (bookName || '').toLowerCase();
  if (norm.includes('a1')) return "Boshlang'ich";
  if (norm.includes('a2')) return "Elementar";
  if (norm.includes('b1')) return "O'rta daraja";
  if (norm.includes('b2')) return "Yuqori o'rta";
  if (norm.includes('c1')) return "Mukammal";
  if (norm.includes('c2')) return "Ilg'or";
  if (norm.includes('madina') || norm.includes('kurs')) return "Darslik";
  return "Lug'at to'plami";
}

async function renderDuelVocabGrid(){
  const grid = document.getElementById('duelVocabGrid');
  const allDesc = document.getElementById('duelVocabAllDesc');
  if(!grid) return;

  if(!ADMIN_VOCABULARIES || !ADMIN_VOCABULARIES.length){
    grid.innerHTML = `<div style="text-align:center;padding:24px;color:var(--text-faint);font-weight:600;">⏳ Lug'at kitoblari yuklanmoqda...</div>`;
    await loadVocabulariesFromBackend();
  }

  const pool = (Array.isArray(ADMIN_VOCABULARIES) && ADMIN_VOCABULARIES.length) ? ADMIN_VOCABULARIES : getLocalVocabularies();
  const totalWords = pool.length;
  const allBooks = Array.from(new Set(pool.map(v => (v.book_name || '').trim()).filter(Boolean))).sort();
  const totalTopics = Array.from(new Set(pool.map(v => `${(v.book_name||'').trim()}:::${(v.topic||'').trim()}`).filter(Boolean))).length;

  if(allDesc){
    allDesc.textContent = totalWords > 0 
      ? `Jami ${allBooks.length} ta kitob · ${totalTopics} ta bo'lim · ${totalWords} ta lug'at`
      : `Barcha mavzulardagi lug'atlardan test`;
  }

  if(!allBooks.length){
    grid.innerHTML = `
      <div style="text-align:center; padding:30px 16px; background:var(--card); border:1.5px dashed var(--border); border-radius:16px; grid-column:1 / -1;">
        <div style="font-size:32px;margin-bottom:8px;">📚</div>
        <div style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:4px;">Lug'at kitoblari topilmadi</div>
        <div style="font-size:12px;color:var(--text-dim);font-weight:600;">Admin panel orqali yangi lug'atlar va kitoblar qo'shishingiz mumkin</div>
      </div>
    `;
    return;
  }

  grid.innerHTML = allBooks.map((bookName) => {
    const words = pool.filter(v => (v.book_name || '').trim() === bookName);
    const topics = Array.from(new Set(words.map(v => (v.topic || '').trim()).filter(Boolean)));
    const topicCount = topics.length || 1;
    const wordCount = words.length;
    const displayName = formatBookDisplayName(bookName);
    const subTitle = getBookLevelSubtitle(bookName);

    return `
      <div class="duel-book-card" onclick="openDuelVocabBookTopics('${escapeHtml(bookName).replace(/'/g, "\\'")}')" role="button" tabindex="0">
        <div class="dbc-top">
          <div class="dbc-title">${escapeHtml(displayName)}</div>
          <div class="dbc-sub">${escapeHtml(subTitle)}</div>
        </div>
        <div class="dbc-bottom">
          <span class="dbc-meta-topics">${topicCount} ta mavzu</span>
          <span class="dbc-meta-words">${wordCount} ta so'z</span>
        </div>
      </div>
    `;
  }).join('');
}

function getDuelTopicTitles(topicName, topicWords = []){
  let uzTitle = '';
  let arTitle = '';

  for(const w of topicWords){
    if(w.topic_uz && String(w.topic_uz).trim()){
      uzTitle = String(w.topic_uz).trim();
      break;
    }
    if(w.topic_translation && String(w.topic_translation).trim()){
      uzTitle = String(w.topic_translation).trim();
      break;
    }
    if(w.topic_desc && String(w.topic_desc).trim()){
      uzTitle = String(w.topic_desc).trim();
      break;
    }
  }

  const raw = (topicName || '').trim();

  if(raw.includes(' - ') || raw.includes(' — ') || raw.includes(' : ') || raw.includes(' / ')){
    const parts = raw.split(/\s*[-—:/]\s*/).filter(Boolean);
    if(parts.length >= 2){
      if(hasArabicText(parts[0]) && !hasArabicText(parts[1])){
        arTitle = parts[0];
        if(!uzTitle) uzTitle = parts[1];
      } else if(!hasArabicText(parts[0]) && hasArabicText(parts[1])){
        arTitle = parts[1];
        if(!uzTitle) uzTitle = parts[0];
      } else if(hasArabicText(parts[0])){
        arTitle = parts[0];
        if(!uzTitle) uzTitle = parts.slice(1).join(' - ');
      }
    }
  }

  if(!arTitle){
    arTitle = raw;
  }

  if(!uzTitle){
    uzTitle = "Mavzu nomi";
  }

  return { arTitle, uzTitle };
}

/* Duel — Tanlangan kitob ichidagi mavzular (3-bosqich) */
function openDuelVocabBookTopics(bookName){
  CURRENT_DUEL_VOCAB_BOOK = bookName;
  const pool = (Array.isArray(ADMIN_VOCABULARIES) && ADMIN_VOCABULARIES.length) ? ADMIN_VOCABULARIES : getLocalVocabularies();
  const words = pool.filter(v => (v.book_name || '').trim() === bookName);
  const customOrder = getVocabTopicOrder(bookName);
  const rawTopics = Array.from(new Set(words.map(v => (v.topic || '').trim()).filter(Boolean)));
  const topics = rawTopics.sort((a, b) => {
    const ia = customOrder.indexOf(a);
    const ib = customOrder.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });
  const displayName = formatBookDisplayName(bookName);

  const titleEl = document.getElementById('duelVocabTopicBookTitle');
  const subEl = document.getElementById('duelVocabTopicBookSub');
  const mixTitleEl = document.getElementById('duelVocabBookMixTitle');
  const mixDescEl = document.getElementById('duelVocabBookMixDesc');
  const grid = document.getElementById('duelVocabTopicsGrid');

  if(titleEl) titleEl.textContent = displayName;
  if(subEl) subEl.textContent = `Ushbu kitobdagi qaysi mavzudan bellashmoqchisiz? (${words.length} ta so'z)`;
  if(mixTitleEl) mixTitleEl.textContent = `${displayName} (Aralash)`;
  if(mixDescEl) mixDescEl.textContent = `Kitobdagi barcha ${topics.length} ta bo'limdan aralash test (${words.length} ta so'z)`;

  if(grid){
    if(!topics.length){
      grid.innerHTML = `
        <div style="text-align:center; padding:24px; color:var(--text-faint); font-weight:600; background:var(--card); border:1.5px dashed var(--border); border-radius:14px;">
          Ushbu kitobda bo'limlar topilmadi
        </div>
      `;
    } else {
      grid.innerHTML = topics.map((topicName, idx) => {
        const topicWords = words.filter(v => (v.topic || '').trim() === topicName);
        const { arTitle, uzTitle } = getDuelTopicTitles(topicName, topicWords);
        return `
          <div class="topic-item duel-vocab-topic-item" onclick="chooseVocabDuel('${escapeHtml(bookName).replace(/'/g, "\\'")}', '${escapeHtml(topicName).replace(/'/g, "\\'")}')" role="button" tabindex="0">
            <div class="topic-icon topic-number">${idx + 1}</div>
            <div class="duel-topic-content">
              <div class="dvt-left">
                <div class="dvt-uz">${escapeHtml(uzTitle)}</div>
              </div>
              <div class="dvt-right">
                <div class="dvt-ar">${escapeHtml(arTitle)}</div>
                <div class="dvt-count">${topicWords.length} ta so'z</div>
              </div>
            </div>
            <div class="topic-mini">
              <button class="topic-start-btn" aria-label="Duelni boshlash" onclick="event.stopPropagation();chooseVocabDuel('${escapeHtml(bookName).replace(/'/g, "\\'")}', '${escapeHtml(topicName).replace(/'/g, "\\'")}')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10"/>
                  <path d="m10 8 4 4-4 4"/>
                </svg>
              </button>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  showView('duelvocabtopics');
}

async function chooseVocabDuel(bookName, topicName = 'all'){
  toast("⏳ Lug'at bellashuvi yaratilmoqda...", 2000);
  const categoryPayload = (topicName && topicName !== 'all') 
    ? `${bookName}:::${topicName}`
    : (bookName || 'all');
  const d = await apiCreateDuel('vocabularies', DUEL_QUESTION_COUNT, categoryPayload);
  if(!d) return;
  renderDuelHub();
  openDuelInviteScreen(d);
}

/* Speaking duel — Grammatika duelidan farqli, savol snapshot backendda
   tanlanadi, shuning uchun apiCreateDuel emas apiCreateSpeakingDuel chaqiriladi.
   Qolgan invite/kutish oqimi (openDuelInviteScreen, renderDuelHub) bir xil
   ishlaydi, chunki natija baribir _duelFromRow orqali normalizatsiya qilingan
   bir xil shakldagi obyekt. */
async function startNewSpeakingDuel(){
  toast('⏳ So\'zlashuv bellashuvi yaratilmoqda...', 2000);
  const d = await apiCreateSpeakingDuel();
  if(!d) return; // xatolik bo'lsa apiCreateSpeakingDuel o'zi toast chiqargan (masalan bankda 3 tadan kam savol bo'lsa)
  renderDuelHub();
  openDuelInviteScreen(d);
}
async function chooseSpeakingDuel(){
  await startNewSpeakingDuel();
}

/* Speaking Duel — real yozib olish oqimi. Mavjud Muhavara mexanizmini
   (startMuhavaraPrep/startMuhavaraRecording/storeMuhavaraAnswer) qayta
   ishlatadi: shu funksiyalar currentQuiz.questions[idx]/currentQuiz.phase
   bilan ishlaydi, duel-xos bo'lishidan qat'i nazar farq qilmaydi. Faqat
   currentQuiz.isSpeakingDuel=true bo'lganda, oxirida evaluateAllMuhavaraAnswers
   o'rniga evaluateAllSpeakingDuelAnswers chaqiriladi (storeMuhavaraAnswer
   ichida shu branch allaqachon qo'shilgan). Supabase Storage kerak emas —
   audio to'g'ridan-to'g'ri base64 orqali evaluate-speaking-batch'ga
   yuboriladi (oddiy Muhavaradagi kabi), submit_duel_speaking_answer'ga
   audio_url = null bilan yoziladi.
   10 soniya tayyorgarlik / 30 soniya yozish — spec bo'yicha. */
async function startSpeakingDuelQuiz(duelId){
  let d = _duelHistoryCache[String(duelId)] || _duelHistoryCache[duelId] || (await apiGetMyDuels()).find(x => String(x.id) === String(duelId));
  if(!d && duelId){
    d = await apiGetDuelByToken(duelId);
  }
  if(!d){ toast('Bellashuv topilmadi'); return; }
  if(!d.questions || d.questions.length < 3){
    if(d.token){
      const full = await apiGetDuelByToken(d.token);
      if(full && full.questions && full.questions.length >= 3){
        d = full;
        _duelHistoryCache[String(d.id)] = d;
      }
    }
  }
  if(!d.questions || d.questions.length < 3){ toast('Bellashuv savollari topilmadi'); return; }
  const meId = _duelMyId();
  const iAmChallenger = d.challenger && String(d.challenger.id) === String(meId);
  const oppInfo = iAmChallenger ? d.opponent : d.challenger;
  const speakingPart = { name: 'Muhadasa', prepSecs: 10, answerSecs: 30 };
  currentQuiz = {
    skillId: 'muhavara', topicId: null, type: 'speaking',
    questions: d.questions.map(q => ({
      id: q.id, prompt: q.prompt_ar, part: speakingPart,
      score: null, feedback: null, transcript: null
    })),
    idx: 0, phase: 'prep',
    color: 'var(--muhavara,#8B5CF6)', bg: 'rgba(139,92,246,0.12)', label: '🎙 Muhadasa',
    startedAt: Date.now(),
    isSpeakingDuel: true, duelId: d.id,
    duelOpponent: oppInfo ? { name: oppInfo.name, photoUrl: oppInfo.photoUrl || null } : null,
  };
  const qTag = document.getElementById('quizTag');
  if(qTag){ qTag.textContent = currentQuiz.label; qTag.style.background = currentQuiz.bg; qTag.style.color = currentQuiz.color; }
  document.getElementById('quizSide').style.display = 'none';
  showView('quiz');
  startMuhavaraPrep();
}

/* Barcha 3 ta javob yozib olingach — bitta so'rovda AI baholaydi (xuddi
   oddiy Muhavara batch baholash kabi), so'ng har biri alohida
   submit_duel_speaking_answer RPC orqali serverga yoziladi. */
async function evaluateAllSpeakingDuelAnswers(){
  currentQuiz.phase = 'evaluating';
  renderQuestion();
  try{
    const answers = currentQuiz.questions.map(q => ({
      question_id: q.id, part_id: 'speakingduel', prompt: q.prompt,
      audio_base64: q.audioBase64 || '', mime_type: q.mimeType || 'audio/webm'
    }));
    const res = await fetch(`${SUPABASE_URL}/functions/v1/evaluate-speaking-batch`, {
      method:'POST', headers: authHeaders(),
      body: JSON.stringify({ answers })
    });
    const data = await res.json().catch(()=>null);
    const results = data && Array.isArray(data.results) ? data.results : null;
    if(!res.ok || !results){
      toast("⚠️ AI baholay olmadi: " + (data?.error || ('HTTP '+res.status)), 6000);
      currentQuiz.questions.forEach(q=>{ q.score = 0; q.feedback = "Texnik sabab bilan baholanmadi."; q.transcript = q.transcript || ''; });
    } else {
      currentQuiz.questions.forEach((q, i)=>{
        const r = results[i] || results.find(x => x.question_id === q.id) || {};
        q.score = Math.max(0, Math.min(5, typeof r.score === 'number' ? r.score : 0));
        q.feedback = r.feedback || '';
        q.transcript = r.transcript || '';
      });
    }
  }catch(e){
    toast("⚠️ Tarmoq xatosi: " + e.message, 6000);
    currentQuiz.questions.forEach(q=>{ q.score = 0; q.feedback = "Tarmoq xatosi tufayli baholanmadi."; q.transcript = q.transcript || ''; });
  }
  currentQuiz.questions.forEach(q=>{ delete q.audioBase64; });
  await submitSpeakingDuelResults();
}

/* Har savol javobini submit_duel_speaking_answer RPC orqali ketma-ket
   yozadi. RPC har chaqiriqda eng yangi duels qatorini qaytaradi — oxirgisi
   (3-savoldan keyingisi) natija ekranida ishlatiladi. */
async function submitSpeakingDuelResults(){
  const duelId = currentQuiz.duelId;
  const myId = _duelMyRawId();
  let updated = null;
  for(let i=0; i<currentQuiz.questions.length; i++){
    const q = currentQuiz.questions[i];
    try{
      const row = _duelUnwrap(await duelRpc('submit_duel_speaking_answer', {
        p_duel_id: duelId, p_user_id: myId, p_question_index: i,
        p_question_id: q.id, p_audio_url: null,
        p_transcript: q.transcript || '', p_score: q.score || 0,
        p_feedback: q.feedback || null
      }));
      if(row) updated = _duelFromRow(row);
    }catch(e){
      console.error('[submitSpeakingDuelResults]', e);
    }
  }
  clearInterval(timerInterval);
  showView('duelresult');
  if(updated){
    _duelHistoryCache[updated.id] = updated;
    renderDuelResultScreen(updated);
  } else {
    const wrap = document.getElementById('duelResultBody');
    if(wrap) wrap.innerHTML = `
      <div class="card" style="padding:28px 22px;text-align:center;">
        <div style="font-size:15px;font-weight:700;margin-bottom:10px;">⚠️ Natija saqlanmadi</div>
        <div style="font-size:13px;color:var(--text-dim);margin-bottom:18px;line-height:1.5;">Internet aloqasini tekshiring — Do'stlarim/Bellashuvlar bo'limidan qayta kirib ko'ring.</div>
        <button type="button" class="btn btn-primary" style="width:100%;" onclick="returnFromDuelResult()">Bellashuvlar bo'limiga qaytish</button>
      </div>`;
  }
  renderDuelHub();
}

function openSpeakingDuelResultCard(duelId){
  const d = _duelHistoryCache[duelId];
  if(!d) return;
  showView('duelresult');
  renderDuelResultScreen(d);
}

/* Supabase RPC delete_duel(p_duel_id, p_user_id) — faqat hali raqibi
   qo'shilmagan, o'zi yaratgan duelni bekor qilish uchun (RPC ichida
   ham tekshiriladi). */
async function apiDeleteDuel(duelId){
  if(!_duelRequireAuth()) return;
  try{ await duelRpc('delete_duel', { p_duel_id: duelId, p_user_id: _duelMyRawId() }); }
  catch(e){}
}

let currentDuelInviteToken = null;
let currentDuelInviteId = null;
let duelInvitePollTimer = null;

function _duelStopInvitePolling(){
  if(duelInvitePollTimer){ clearInterval(duelInvitePollTimer); duelInvitePollTimer = null; }
}

/* Raqib havolani ochib duelga qo'shilishini real vaqtda kutish: har 3
   soniyada backenddan duel holatini so'raymiz. Raqib qo'shilishi bilan
   avtomatik ravishda savollar boshlanadi (hech kim qo'lda "Boshlash"
   bosishi shart emas). */
function _duelStartInvitePolling(d){
  _duelStopInvitePolling();
  duelInvitePollTimer = setInterval(async ()=>{
    const overlay = document.getElementById('duelInviteOverlay');
    if(!overlay || !overlay.classList.contains('show') || currentDuelInviteToken !== d.token){
      _duelStopInvitePolling();
      return;
    }
    const fresh = await apiGetDuelByToken(d.token);
    if(fresh && fresh.opponent){
      _duelStopInvitePolling();
      const statusEl = document.querySelector('#duelInviteOverlay .duel-invite-status');
      if(statusEl) statusEl.innerHTML = `${escapeHtml(fresh.opponent.name)} qo'shildi! 🎉`;
      const oppNameEl = document.querySelector('#duelInviteOverlay .duel-invite-side:last-child .duel-invite-name');
      if(oppNameEl) oppNameEl.textContent = fresh.opponent.name;
      renderDuelHub();
      setTimeout(()=>{
        closeDuelInviteScreen();
        startDuelQuiz(fresh.id, fresh);
      }, 900);
    }
  }, 3000);
}

/* Do'stni duelga chaqirgandan so'ng ko'rsatiladigan to'liq ekranli "kutish" oynasi:
   o'z rasmi vs "?" (raqib) — raqib joyida sonar/puls effekti bilan. */
function openDuelInviteScreen(d){
  currentDuelInviteToken = d.token;
  currentDuelInviteId = d.id;
  const avatarEl = document.getElementById('duelInviteMyAvatar');
  const nameEl = document.getElementById('duelInviteMyName');
  const photoUrl = (typeof TELEGRAM_PROFILE !== 'undefined' && TELEGRAM_PROFILE.photoUrl) || '';
  const name = _duelMyName();
  if(avatarEl){
    avatarEl.innerHTML = photoUrl
      ? `<img src="${photoUrl}" alt="">`
      : `<span class="duel-invite-avatar-fallback">${escapeHtml((name||'?').trim().charAt(0).toUpperCase())}</span>`;
  }
  if(nameEl){
    nameEl.textContent = name;
    nameEl.classList.toggle('ar', /[\u0600-\u06FF]/.test(name));
  }
  const statusEl = document.querySelector('#duelInviteOverlay .duel-invite-status');
  if(statusEl) statusEl.innerHTML = `Do'st kutilmoqda<span class="dots"><span>.</span><span>.</span><span>.</span></span>`;
  const oppNameEl = document.querySelector('#duelInviteOverlay .duel-invite-side:last-child .duel-invite-name');
  if(oppNameEl) oppNameEl.textContent = 'Raqib';
  const overlay = document.getElementById('duelInviteOverlay');
  if(overlay) overlay.classList.add('show');
  _duelStartInvitePolling(d);
}

function closeDuelInviteScreen(){
  _duelStopInvitePolling();
  const overlay = document.getElementById('duelInviteOverlay');
  if(overlay) overlay.classList.remove('show');
  currentDuelInviteToken = null;
  currentDuelInviteId = null;
}

async function cancelDuelInviteScreen(){
  _duelStopInvitePolling();
  const idToDelete = currentDuelInviteId;
  closeDuelInviteScreen();
  toast("Bellashuv bekor qilindi");
  if(idToDelete){
    await apiDeleteDuel(idToDelete);
    renderDuelHub();
  }
}

async function reopenDuelInvite(duelId){
  let d = _duelHistoryCache[String(duelId)] || _duelHistoryCache[duelId] || (await apiGetMyDuels()).find(x => String(x.id) === String(duelId));
  if(!d && duelId){
    d = await apiGetDuelByToken(duelId);
  }
  if(!d){ toast('Bellashuv topilmadi'); return; }
  openDuelInviteScreen(d);
  if(d.token){
    shareDuelLink(d.token);
  }
}

/* ---------- Duel: VS boshlig'i (avatar + vaqt paneli) render/yangilash ---------- */
function renderDuelVsHead(){
  const wrap = document.getElementById('duelVsHead');
  const namesWrap = document.getElementById('duelVsNames');
  if(!wrap) return;
  if(!currentQuiz || !currentQuiz.isDuel){
    wrap.style.display = 'none';
    if(namesWrap) namesWrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'flex';
  if(namesWrap) namesWrap.style.display = 'flex';

  const myAv = document.getElementById('duelVsMyAvatar');
  const oppAv = document.getElementById('duelVsOppAvatar');
  const myNameEl = document.getElementById('duelVsMyName');
  const oppNameEl = document.getElementById('duelVsOppName');
  const myName = _duelMyName();
  const myPhoto = (typeof TELEGRAM_PROFILE !== 'undefined' && TELEGRAM_PROFILE.photoUrl) || '';
  if(myAv){
    myAv.innerHTML = myPhoto ? `<img src="${myPhoto}" alt="">` : escapeHtml((myName||'?').trim().charAt(0).toUpperCase());
  }
  if(myNameEl) myNameEl.textContent = myName || 'Siz';
  const opp = currentQuiz.duelOpponent || {};
  const oppName = opp.name || 'Raqib';
  if(oppAv){
    oppAv.innerHTML = opp.photoUrl ? `<img src="${opp.photoUrl}" alt="">` : escapeHtml((oppName||'?').trim().charAt(0).toUpperCase());
  }
  if(oppNameEl) oppNameEl.textContent = oppName;
  updateDuelVsTimer();
}
function updateDuelVsTimer(){
  if(!currentQuiz || !currentQuiz.isDuel || !currentQuiz.questions) return;
  const q = currentQuiz.questions[currentQuiz.idx];
  if(!q) return;
  const total = DUEL_QUESTION_SECONDS;
  const remaining = Math.max(0, q.timeLeft === undefined ? total : q.timeLeft);
  const pct = Math.max(0, Math.min(100, (remaining/total)*100));
  const fill = document.getElementById('duelVsMyFill');
  const answered = q.picked !== null && q.picked !== undefined;
  if(fill){
    fill.classList.toggle('snap', answered);
    fill.style.width = (answered ? 100 : pct) + '%';
  }
  const myAv = document.getElementById('duelVsMyAvatar');
  if(myAv) myAv.classList.toggle('answered', answered);
}
/* Raqibning shu savolga javob berish holati — get_duel_opponent_answer pollingi
   orqali raqib javob bergani aniqlanganda shu funksiya chaqiriladi va uning
   paneli silliq animatsiya bilan to'ldiriladi (pastdagi "gibrid jonli sinxron"
   blokiga qarang). */
function duelMarkOpponentAnsweredEarly(){
  const fill = document.getElementById('duelVsOppFill');
  const oppAv = document.getElementById('duelVsOppAvatar');
  if(fill){ fill.classList.add('snap'); fill.style.width = '100%'; }
  if(oppAv) oppAv.classList.add('answered');
}

/* ==================== Duel: mustaqil tezlikda ravon va to'siqsiz o'tish ====================
   Har bir ishtirokchi 10 ta savolni o'z tezligida, hech qanday kutishsiz yechadi.
   Javob tanlanganda javob tahlil uchun backendga yoziladi va qisqa (350-400ms) silliq
   kechikish bilan avtomatik yoki "Keyingi" tugmasi orqali to'xtovsiz keyingi savolga o'tiladi.
   Raqibni har bir savolda kutib o'tirish yo'q. Yakuniy g'olib to'g'ri javoblar soni va
   ketgan umumiy vaqt (sekund) bo'yicha aniqlanadi. */
const DUEL_CONTINUE_ALONE_DELAY_MS = 4000;
let duelAnswerPollTimer = null;
let duelContinueAloneTimer = null;
let duelAutoAdvanceTimer = null;

function _duelStopAnswerPolling(){
  if(duelAnswerPollTimer){ clearInterval(duelAnswerPollTimer); duelAnswerPollTimer = null; }
  if(duelContinueAloneTimer){ clearTimeout(duelContinueAloneTimer); duelContinueAloneTimer = null; }
  if(duelAutoAdvanceTimer){ clearTimeout(duelAutoAdvanceTimer); duelAutoAdvanceTimer = null; }
}

function duelContinueAlone(){
  _duelStopAnswerPolling();
  nextQ();
}

/* Foydalanuvchi javob berganda (yoki vaqt tugab, javobsiz o'tilganda) chaqiriladi. */
function handleDuelAnswerSubmitted(q, qIdx){
  if(!currentQuiz || !currentQuiz.isDuel) return;
  const duelId = currentQuiz.duelId;
  apiSubmitDuelAnswer(duelId, qIdx, (q.picked === undefined ? null : q.picked));

  _duelStopAnswerPolling();
  // Tanlangan variantni qisqa ko'rsatib, darhol keyingi savolga ravon o'tadi
  duelAutoAdvanceTimer = setTimeout(()=>{
    if(currentQuiz && currentQuiz.isDuel && currentQuiz.idx === qIdx){
      nextQ();
    }
  }, 380);
}

/* "Keyingi" tugmasi o'rniga: kutish paneli endi kerak emas */
function renderDuelWaitPanel(){
  // Kutish paneli olib tashlandi — foydalanuvchi o'z tezligida to'xtovsiz harakatlanadi
}

async function startDuelQuiz(duelId, dOverride){
  let d = dOverride || _duelHistoryCache[String(duelId)] || _duelHistoryCache[duelId] || (await apiGetMyDuels()).find(x => String(x.id) === String(duelId));
  if(!d && duelId){
    d = await apiGetDuelByToken(duelId);
  }
  if(!d){ toast('Duel topilmadi'); return; }
  if(!d.questions || !d.questions.length){
    if(d.token){
      const full = await apiGetDuelByToken(d.token);
      if(full && full.questions && full.questions.length){
        d = full;
        _duelHistoryCache[String(d.id)] = d;
      }
    }
  }
  if(!d.questions || !d.questions.length){ toast('Duel savollari topilmadi'); return; }
  const isVocab = d.skillId === 'vocabularies';
  const skillMeta = isVocab
    ? { id:'vocabularies', name:"Lug'atlar", color:'var(--emerald-600, #059669)', bg:'rgba(16,185,129,0.12)' }
    : (SKILLS.find(s=>s.id===d.skillId) || SKILLS.find(s=>s.id==='grammatika'));
  
  let catDisplay = '';
  if(isVocab){
    if(d.category && d.category.includes(':::')){
      const [b, t] = d.category.split(':::');
      catDisplay = `${b} · ${t}`;
    } else if(d.category && d.category !== 'all'){
      catDisplay = `${d.category} (Aralash)`;
    } else {
      catDisplay = "Barcha kitoblar";
    }
  }
  const duelLabel = isVocab
    ? `⚔️ Bellashuv — Lug'atlar (${catDisplay})`
    : `⚔️ Bellashuv — ${skillMeta.name}`;
  const meId = _duelMyId();
  const iAmChallenger = d.challenger && String(d.challenger.id) === String(meId);
  const oppInfo = iAmChallenger ? d.opponent : d.challenger;
  currentQuiz = {
    skillId: d.skillId, topicId: null, type: 'mcq', passage: null,
    questions: d.questions.map(q=>({...q, picked:null, timeLeft:DUEL_QUESTION_SECONDS, expired:false})),
    color: skillMeta.color, bg: skillMeta.bg, label: duelLabel,
    idx:0, startedAt: Date.now(), duration: 20*60,
    isDuel: true, duelId: d.id,
    duelOpponent: oppInfo ? { name: oppInfo.name, photoUrl: oppInfo.photoUrl || null } : null,
  };
  const qTag = document.getElementById('quizTag');
  if(qTag){ qTag.textContent = currentQuiz.label; qTag.style.background = skillMeta.bg; qTag.style.color = skillMeta.color; }
  // Duel paytida test kartasi qat'iy (frame) turishi uchun, va Telegram'ning
  // vertikal swipe orqali yopilishi ehtimoli bilan to'qnashmasligi uchun.
  try{
    const tg = window.Telegram && window.Telegram.WebApp;
    if(tg && typeof tg.disableVerticalSwipes === 'function') tg.disableVerticalSwipes();
  }catch(e){}
  buildQGrid();
  renderQuestion();
  showView('quiz');
}

async function handleDuelFinish(){
  clearInterval(timerInterval); clearInterval(mcqTimerInterval);
  _duelStopAnswerPolling();
  const total = currentQuiz.questions.length;
  const correct = currentQuiz.questions.filter(q=>q.picked===q.a).length;
  const elapsedSeconds = Math.round((Date.now() - (currentQuiz.startedAt || Date.now())) / 1000);
  const duelId = currentQuiz.duelId;
  showView('duelresult');
  const wrap = document.getElementById('duelResultBody');
  if(wrap) wrap.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;min-height:70vh;text-align:center;padding:24px;">
      <div style="font-size:15px;font-weight:600;color:var(--text-dim);display:flex;align-items:center;gap:10px;">
        <span style="font-size:24px;">⏳</span> Natija yuborilmoqda...
      </div>
    </div>`;
  const updated = await apiSubmitDuelResult(duelId, { score: correct, total, timeSec: elapsedSeconds });
  if(!updated){
    if(wrap) wrap.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:70vh;text-align:center;padding:32px 20px;">
        <div style="font-size:36px;margin-bottom:12px;">⚠️</div>
        <div style="font-size:17px;font-weight:800;color:var(--text);margin-bottom:8px;">Natija saqlanmadi</div>
        <div style="font-size:13.5px;color:var(--text-dim);margin-bottom:20px;line-height:1.5;max-width:320px;">Internet aloqasini tekshirib qayta urinib ko'ring — javoblaringiz hozircha saqlanib turibdi.</div>
        <button type="button" class="btn btn-primary" style="padding:12px 24px;border-radius:12px;font-weight:700;" onclick="handleDuelFinish()">Qayta urinish</button>
      </div>`;
    return;
  }
  renderDuelHub();
  renderDuelResultScreen(updated);
}

let duelResultPollTimer = null;
function _duelStopResultPolling(){
  if(duelResultPollTimer){ clearInterval(duelResultPollTimer); duelResultPollTimer = null; }
}

const DR_VICTORY_TROPHY = `
<div style="position:relative;width:155px;height:160px;display:flex;align-items:flex-end;justify-content:center;">
  <div class="dr-sparkle-1" style="position:absolute;top:6px;left:2px;color:#FBBF24;">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0L14.59 9.41L24 12L14.59 14.59L12 24L9.41 14.59L0 12L9.41 9.41L12 0Z"/></svg>
  </div>
  <div class="dr-sparkle-2" style="position:absolute;top:58px;left:-6px;color:#F59E0B;">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0L14.59 9.41L24 12L14.59 14.59L12 24L9.41 14.59L0 12L9.41 9.41L12 0Z"/></svg>
  </div>
  <div class="dr-sparkle-3" style="position:absolute;top:14px;right:0;color:#FBBF24;">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0L14.59 9.41L24 12L14.59 14.59L12 24L9.41 14.59L0 12L9.41 9.41L12 0Z"/></svg>
  </div>
  <div class="dr-sparkle-4" style="position:absolute;bottom:44px;right:-2px;color:#FCD34D;">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0L14.59 9.41L24 12L14.59 14.59L12 24L9.41 14.59L0 12L9.41 9.41L12 0Z"/></svg>
  </div>
  <div class="dr-trophy-inner">
  <svg width="150" height="158" viewBox="0 0 115 120" fill="none" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="drGoldCupGrad" x1="20" y1="20" x2="95" y2="85" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#FFF275"/><stop offset="25%" stop-color="#FFD000"/>
        <stop offset="60%" stop-color="#FFAE00"/><stop offset="90%" stop-color="#FF8800"/>
        <stop offset="100%" stop-color="#E66A00"/>
      </linearGradient>
      <linearGradient id="drCupRimGrad" x1="25" y1="18" x2="90" y2="28" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#FFF9C4"/><stop offset="50%" stop-color="#FFE082"/><stop offset="100%" stop-color="#FFA000"/>
      </linearGradient>
      <linearGradient id="drHandleLeftGrad" x1="5" y1="22" x2="35" y2="52" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#FFF9A6"/><stop offset="50%" stop-color="#FFC107"/><stop offset="100%" stop-color="#FF8F00"/>
      </linearGradient>
      <linearGradient id="drHandleRightGrad" x1="110" y1="22" x2="80" y2="52" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#FFF9A6"/><stop offset="50%" stop-color="#FFC107"/><stop offset="100%" stop-color="#FF8F00"/>
      </linearGradient>
      <linearGradient id="drPedestalGrad" x1="40" y1="88" x2="75" y2="108" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#FFC107"/><stop offset="40%" stop-color="#FF9800"/><stop offset="100%" stop-color="#E65100"/>
      </linearGradient>
      <linearGradient id="drStarGrad" x1="57.5" y1="36" x2="57.5" y2="60" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#FFFFFF"/><stop offset="50%" stop-color="#FFF176"/><stop offset="100%" stop-color="#FFA000"/>
      </linearGradient>
      <radialGradient id="drGroundShadow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#FF8F00" stop-opacity="0.4"/>
        <stop offset="60%" stop-color="#FFB300" stop-opacity="0.15"/>
        <stop offset="100%" stop-color="#FFD54F" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <ellipse cx="57.5" cy="114" rx="36" ry="6" fill="url(#drGroundShadow)"/>
    <path d="M 33 26 C 14 26 8 38 12 50 C 15 59 26 59 36 53" stroke="url(#drHandleLeftGrad)" stroke-width="5" stroke-linecap="round" fill="none"/>
    <path d="M 82 26 C 101 26 107 38 103 50 C 100 59 89 59 79 53" stroke="url(#drHandleRightGrad)" stroke-width="5" stroke-linecap="round" fill="none"/>
    <path d="M 30 20 H 85 C 85 45 78 68 57.5 73 C 37 68 30 45 30 20 Z" fill="url(#drGoldCupGrad)"/>
    <ellipse cx="57.5" cy="20" rx="27.5" ry="6" fill="url(#drCupRimGrad)"/>
    <ellipse cx="57.5" cy="20" rx="25" ry="4.5" fill="#FAAD14" opacity="0.6"/>
    <path d="M 37 24 C 36 38 40 56 50 66 C 45 61 41 45 42 25 Z" fill="#FFFBE6" opacity="0.6"/>
    <path d="M 57.5 35 L 61.2 44.5 L 71 45.2 L 63.4 51.5 L 65.8 61 L 57.5 55.8 L 49.2 61 L 51.6 51.5 L 44 45.2 L 53.8 44.5 Z" fill="url(#drStarGrad)" stroke="#FFE58F" stroke-width="0.8"/>
    <path d="M 52 72 H 63 V 86 C 63 87 61 88 57.5 88 C 54 88 52 87 52 86 Z" fill="#D48806"/>
    <ellipse cx="57.5" cy="74" rx="7" ry="2" fill="#FFE58F"/>
    <ellipse cx="57.5" cy="85" rx="10" ry="2.5" fill="#FFC53D"/>
    <path d="M 43 88 L 72 88 L 76 107 C 76 108.5 74 109 57.5 109 C 41 109 39 108.5 39 107 Z" fill="url(#drPedestalGrad)"/>
    <ellipse cx="57.5" cy="88" rx="14.5" ry="2.2" fill="#D48806"/>
    <circle cx="57.5" cy="98.5" r="4.8" fill="#FAAD14" stroke="#FFF1B8" stroke-width="0.8"/>
    <circle cx="57.5" cy="98.5" r="2.8" fill="#D48806"/>
    <line x1="57.5" y1="98.5" x2="57.5" y2="96.5" stroke="#FFF" stroke-width="0.8" stroke-linecap="round"/>
    <line x1="57.5" y1="98.5" x2="59" y2="98.5" stroke="#FFF" stroke-width="0.8" stroke-linecap="round"/>
  </svg>
  </div>
</div>`;

const DR_DEFEAT_TROPHY = `
<div style="position:relative;width:155px;height:160px;display:flex;align-items:flex-end;justify-content:center;margin-left:-24px;">
  <div class="dr-petal-1" style="position:absolute;top:6px;left:6px;color:#CBD5E1;">
    <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor"><path d="M5 0C8 5 10 9 7 14C5 16 3 14 2 11C1 7 3 3 5 0Z"/></svg>
  </div>
  <div class="dr-petal-2" style="position:absolute;top:14px;right:10px;color:#CBD5E1;">
    <svg width="12" height="17" viewBox="0 0 10 16" fill="currentColor"><path d="M5 0C8 5 10 9 7 14C5 16 3 14 2 11C1 7 3 3 5 0Z"/></svg>
  </div>
  <div class="dr-petal-3" style="position:absolute;top:44px;right:0;color:#CBD5E1;">
    <svg width="8" height="14" viewBox="0 0 10 16" fill="currentColor"><path d="M5 0C8 5 10 9 7 14C5 16 3 14 2 11C1 7 3 3 5 0Z"/></svg>
  </div>
  <div class="dr-petal-4" style="position:absolute;bottom:14px;left:10px;color:#CBD5E1;">
    <svg width="9" height="15" viewBox="0 0 10 16" fill="currentColor" transform="rotate(-35)"><path d="M5 0C8 5 10 9 7 14C5 16 3 14 2 11C1 7 3 3 5 0Z"/></svg>
  </div>
  <div class="dr-trophy-inner">
  <svg width="150" height="158" viewBox="0 0 115 120" fill="none" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="drFallenFloorShadow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#94A3B8" stop-opacity="0.55"/>
        <stop offset="60%" stop-color="#CBD5E1" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="#E2E8F0" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="drFallenCupGrad" x1="20" y1="20" x2="95" y2="85" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#FFFFFF"/><stop offset="30%" stop-color="#E2E8F0"/>
        <stop offset="70%" stop-color="#CBD5E1"/><stop offset="100%" stop-color="#94A3B8"/>
      </linearGradient>
      <linearGradient id="drFallenRimGrad" x1="25" y1="18" x2="90" y2="28" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#F8FAFC"/><stop offset="50%" stop-color="#E2E8F0"/><stop offset="100%" stop-color="#94A3B8"/>
      </linearGradient>
      <linearGradient id="drFallenHandleLeft" x1="5" y1="22" x2="35" y2="52" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#F8FAFC"/><stop offset="60%" stop-color="#CBD5E1"/><stop offset="100%" stop-color="#94A3B8"/>
      </linearGradient>
      <linearGradient id="drFallenHandleRight" x1="110" y1="22" x2="80" y2="52" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#F8FAFC"/><stop offset="60%" stop-color="#CBD5E1"/><stop offset="100%" stop-color="#94A3B8"/>
      </linearGradient>
      <linearGradient id="drFallenPedestalGrad" x1="40" y1="88" x2="75" y2="108" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#94A3B8"/><stop offset="50%" stop-color="#64748B"/><stop offset="100%" stop-color="#475569"/>
      </linearGradient>
      <linearGradient id="drFallenStarGrad" x1="57.5" y1="36" x2="57.5" y2="60" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#CBD5E1"/><stop offset="60%" stop-color="#94A3B8"/><stop offset="100%" stop-color="#64748B"/>
      </linearGradient>
    </defs>
    <ellipse cx="57.5" cy="114" rx="42" ry="5.5" fill="url(#drFallenFloorShadow)"/>
    <g transform="translate(-32, -10) rotate(52, 57.5, 95)">
      <path d="M 33 26 C 14 26 8 38 12 50 C 15 59 26 59 36 53" stroke="url(#drFallenHandleLeft)" stroke-width="5" stroke-linecap="round" fill="none"/>
      <path d="M 82 26 C 101 26 107 38 103 50 C 100 59 89 59 79 53" stroke="url(#drFallenHandleRight)" stroke-width="5" stroke-linecap="round" fill="none"/>
      <path d="M 30 20 H 85 C 85 45 78 68 57.5 73 C 37 68 30 45 30 20 Z" fill="url(#drFallenCupGrad)"/>
      <ellipse cx="57.5" cy="20" rx="27.5" ry="6" fill="url(#drFallenRimGrad)"/>
      <ellipse cx="57.5" cy="20" rx="25" ry="4.5" fill="#94A3B8" opacity="0.45"/>
      <path d="M 37 24 C 36 38 40 56 50 66 C 45 61 41 45 42 25 Z" fill="#FFFFFF" opacity="0.6"/>
      <path d="M 57.5 35 L 61.2 44.5 L 71 45.2 L 63.4 51.5 L 65.8 61 L 57.5 55.8 L 49.2 61 L 51.6 51.5 L 44 45.2 L 53.8 44.5 Z" fill="url(#drFallenStarGrad)" stroke="#E2E8F0" stroke-width="0.8"/>
      <path d="M 52 72 H 63 V 86 C 63 87 61 88 57.5 88 C 54 88 52 87 52 86 Z" fill="#64748B"/>
      <ellipse cx="57.5" cy="74" rx="7" ry="2" fill="#E2E8F0"/>
      <ellipse cx="57.5" cy="85" rx="10" ry="2.5" fill="#94A3B8"/>
      <path d="M 43 88 L 72 88 L 76 107 C 76 108.5 74 109 57.5 109 C 41 109 39 108.5 39 107 Z" fill="url(#drFallenPedestalGrad)"/>
      <ellipse cx="57.5" cy="88" rx="14.5" ry="2.2" fill="#64748B"/>
      <circle cx="57.5" cy="98.5" r="5" fill="#CBD5E1" stroke="#F1F5F9" stroke-width="0.8"/>
      <circle cx="57.5" cy="98.5" r="3" fill="#64748B"/>
      <line x1="57.5" y1="98.5" x2="57.5" y2="96.5" stroke="#FFF" stroke-width="0.8" stroke-linecap="round"/>
      <line x1="57.5" y1="98.5" x2="59" y2="98.5" stroke="#FFF" stroke-width="0.8" stroke-linecap="round"/>
    </g>
  </svg>
  </div>
</div>`;

/* Uchburchak "mesh" fon — g'alabada oltin, mag'lubiyatda kumush tusda (420px balandlik). */
function drBuildMesh(type, dark, containerWidth){
  const height = 420;
  const targetTileWidth = 22;
  const cols = Math.max(14, Math.round(containerWidth / targetTileWidth));
  const rows = 20;
  const dx = containerWidth / cols;
  const dy = height / rows;
  const points = [];
  for(let r=0; r<=rows; r++){
    points[r] = [];
    for(let c=0; c<=cols; c++){
      const jitterX = (c>0 && c<cols) ? (Math.sin(r*17+c*11)*0.35*dx) : 0;
      const jitterY = (r>0 && r<rows) ? (Math.cos(r*11+c*13)*0.35*dy) : 0;
      points[r][c] = [c*dx+jitterX, r*dy+jitterY];
    }
  }
  const goldPaletteLight = ['#FFF8DE','#FFEAA3','#FFF2BA','#FFE38C','#FFFBF0','#FFDE7A','#FFF5C6','#FFE899','#FFFDF4','#FFDC70'];
  const silverPaletteLight = ['#FFFFFF','#F8FAFC','#F1F5F9','#E8EDF3','#DFE6EE','#F4F6F8','#ECEFF4','#FFFFFF','#F1F4F8','#E2E8F0'];
  const goldPaletteDark = ['#2C2508','#382E0A','#201B04','#43370B','#1B1703','#4E3F0E','#2E2608','#3B310B','#44390D','#241E04'];
  const silverPaletteDark = ['#1A2C23','#14231C','#1E342A','#111E18','#233C30','#162720','#1B2F25','#13201A','#22382D','#182A21'];
  const palette = dark
    ? (type==='victory' ? goldPaletteDark : silverPaletteDark)
    : (type==='victory' ? goldPaletteLight : silverPaletteLight);
  let polys = '';
  for(let r=0; r<rows; r++){
    for(let c=0; c<cols; c++){
      const p1=points[r][c], p2=points[r][c+1], p3=points[r+1][c], p4=points[r+1][c+1];
      const rowFade = Math.max(0, 1-Math.pow(r/rows,1.35));
      const ci1 = (r*7+c*3) % palette.length;
      const baseOp1 = dark ? (type==='victory'?0.26:0.36) : 0.28;
      const op1 = (baseOp1 + (Math.sin(r*3+c*5)*(dark?0.12:0.16))) * rowFade;
      const strokeOp = op1*0.4;
      polys += `<polygon points="${p1[0]},${p1[1]} ${p2[0]},${p2[1]} ${p3[0]},${p3[1]}" fill="${palette[ci1]}" fill-opacity="${op1}" stroke="${palette[ci1]}" stroke-width="0.3" stroke-opacity="${strokeOp}"/>`;
      const ci2 = (r*11+c*5+2) % palette.length;
      const baseOp2 = dark ? (type==='victory'?0.30:0.40) : 0.32;
      const op2 = (baseOp2 + (Math.cos(r*5+c*3)*(dark?0.12:0.16))) * rowFade;
      polys += `<polygon points="${p2[0]},${p2[1]} ${p4[0]},${p4[1]} ${p3[0]},${p3[1]}" fill="${palette[ci2]}" fill-opacity="${op2}" stroke="${palette[ci2]}" stroke-width="0.3" stroke-opacity="${strokeOp}"/>`;
    }
  }
  let fadeTop, fadeMid, fadeLow, fadeEnd;
  if(dark){
    fadeTop = type==='victory' ? '#1E2B1A' : '#17271F';
    fadeMid = type==='victory' ? '#15241B' : '#122019';
    fadeLow = type==='victory' ? '#101B15' : '#0E1914';
    fadeEnd = '#0D1713';
  } else {
    fadeTop = type==='victory' ? '#FFF6D3' : '#F1F5F9';
    fadeMid = type==='victory' ? '#FFFBEA' : '#F8FAFC';
    fadeLow = type==='victory' ? '#FFFEFB' : '#FCFDFE';
    fadeEnd = '#FFFFFF';
  }
  const groupOpacity = dark ? (type==='victory'?'0.7':'0.85') : '0.9';
  const uid = type + (dark?'dark':'light');
  return `<svg viewBox="0 0 ${containerWidth} ${height}" style="width:100%;height:100%;display:block;">
    <defs>
      <linearGradient id="drFade-${uid}" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="${fadeTop}" stop-opacity="${dark?(type==='victory'?'0.75':'0.9'):'0.85'}"/>
        <stop offset="50%" stop-color="${fadeMid}" stop-opacity="${dark?(type==='victory'?'0.55':'0.75'):'0.65'}"/>
        <stop offset="80%" stop-color="${fadeLow}" stop-opacity="${dark?(type==='victory'?'0.3':'0.45'):'0.3'}"/>
        <stop offset="100%" stop-color="${fadeEnd}" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="drFadeMask-${uid}" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.95"/>
        <stop offset="60%" stop-color="#FFFFFF" stop-opacity="0.8"/>
        <stop offset="85%" stop-color="#FFFFFF" stop-opacity="0.45"/>
        <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
      </linearGradient>
      <mask id="drMask-${uid}"><rect width="${containerWidth}" height="${height}" fill="url(#drFadeMask-${uid})"/></mask>
    </defs>
    <rect width="${containerWidth}" height="${height}" fill="url(#drFade-${uid})"/>
    <g mask="url(#drMask-${uid})" opacity="${groupOpacity}">${polys}</g>
  </svg>`;
}

function drPlayBars(root){
  root.querySelectorAll('.dr-bar-fill').forEach(el=>{ el.style.width = '0%'; });
  requestAnimationFrame(()=>{
    setTimeout(()=>{
      root.querySelectorAll('.dr-bar-fill').forEach(el=>{ el.style.width = el.dataset.w + '%'; });
    }, 250);
  });
}

function drBurstConfetti(){
  fireSideConfetti({ mode: 'celebration' });
}

function returnFromDuelResult(){
  _duelStopResultPolling();
  // Natija, test yoki oraliq duel tanlov sahifalarini tarixdan tozalaymiz
  while(viewHistory.length > 0 && (
    viewHistory[viewHistory.length - 1] === 'duelresult' ||
    viewHistory[viewHistory.length - 1] === 'quiz' ||
    viewHistory[viewHistory.length - 1] === 'results' ||
    viewHistory[viewHistory.length - 1] === 'duelskillselect' ||
    viewHistory[viewHistory.length - 1] === 'duelvocabselect' ||
    viewHistory[viewHistory.length - 1] === 'duelvocabtopics'
  )){
    viewHistory.pop();
  }

  // Agar tarixdan oldin 'duelhistory' mavjud bo'lsa, to'g'ridan-to'g'ri o'shanga o'tamiz
  if(viewHistory.length > 0 && viewHistory[viewHistory.length - 1] === 'duelhistory'){
    showView('duelhistory', false);
    return;
  }

  // Tarix zanjirini toza holatga keltiramiz: dashboard -> duel -> duelhistory
  const duelIdx = viewHistory.lastIndexOf('duel');
  if(duelIdx !== -1){
    viewHistory = viewHistory.slice(0, duelIdx + 1);
  } else {
    viewHistory = ['dashboard', 'duel'];
  }
  viewHistory.push('duelhistory');
  showView('duelhistory', false);
}

function renderDuelResultScreen(d){
  _duelStopResultPolling();
  const wrap = document.getElementById('duelResultBody');
  if(!wrap || !d) return;
  _duelCurrentResult = d;
  const me = _duelMyId();
  const iAmChallenger = d.challenger.id === me;
  const isSpeaking = d.duelType === 'speaking';
  const myR = iAmChallenger ? d.challengerResult : d.opponentResult;
  const oppR = iAmChallenger ? d.opponentResult : d.challengerResult;
  const oppInfo = iAmChallenger ? d.opponent : d.challenger;
  const oppName = oppInfo ? oppInfo.name : 'Raqib';
  const myName = _duelMyName();
  const myPhoto = (typeof TELEGRAM_PROFILE !== 'undefined' && TELEGRAM_PROFILE.photoUrl) || '';
  const oppPhoto = oppInfo ? oppInfo.photoUrl : null;
  const fmt = s => `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';

  if(d.status !== 'completed'){
    wrap.innerHTML = `
      <div class="dr-page ${isDark ? 'dr-dark' : ''}" id="drPage" style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 20px;min-height:85vh;text-align:center;">
        <div style="width:100%;max-width:360px;margin:0 auto;display:flex;flex-direction:column;align-items:center;">
          <div style="width:68px;height:68px;border-radius:50%;background:rgba(99,102,241,0.12);display:flex;align-items:center;justify-content:center;font-size:32px;margin-bottom:18px;">
            ⏳
          </div>
          <div style="font-size:20px;font-weight:800;color:var(--text);margin-bottom:8px;letter-spacing:-0.01em;">Natijangiz saqlandi</div>
          <div style="font-size:14px;color:var(--text-dim);line-height:1.55;max-width:320px;margin:0 0 24px;">
            <strong style="color:var(--text);font-weight:700;">${escapeHtml(oppName)}</strong> hali javob bermadi — u yakunlagach natija shu yerda avtomatik ko'rinadi.
          </div>
          <div>
            <div class="back-row" style="margin:0;cursor:pointer;justify-content:center;padding:8px 12px;" onclick="returnFromDuelResult()">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><path d="m15 18-6-6 6-6"/></svg>
              Bellashuvlarga qaytish
            </div>
          </div>
        </div>
      </div>`;
    duelResultPollTimer = setInterval(async ()=>{
      const resultView = document.getElementById('view-duelresult');
      if(!resultView || !resultView.classList.contains('active')){ _duelStopResultPolling(); return; }
      const fresh = await apiGetDuelByToken(d.token);
      if(fresh && fresh.status === 'completed'){
        _duelStopResultPolling();
        renderDuelHub();
        renderDuelResultScreen(fresh);
      }
    }, 4000);
    return;
  }

  let state; // 'win' | 'lose' | 'draw'
  if(myR.score === oppR.score){
    state = myR.timeSec === oppR.timeSec ? 'draw' : (myR.timeSec < oppR.timeSec ? 'win' : 'lose');
  } else {
    state = myR.score > oppR.score ? 'win' : 'lose';
  }
  const isVictory = state !== 'lose'; // durrang ham "win" uslubida ko'rsatiladi
  const type = isVictory ? 'victory' : 'defeat';
  const title = state === 'win' ? "G'ALABA!" : (state === 'draw' ? 'DURRANG' : "MAG'LUBIYAT");
  const subtitle = state === 'win' ? "Bellashuvda g'olib bo'ldingiz!" : (state === 'draw' ? 'Bellashuv durrang yakunlandi' : "Bellashuvda mag'lub bo'ldingiz!");
  const tipHtml = isVictory
    ? `<div class="dr-reward">${state==='draw' ? "Ikkalangiz teng kuchdasiz" : "Ajoyib natija!"}</div>`
    : `<button type="button" class="dr-defeat-tip" onclick="showView('grammar')">Ko'proq mashq qiling!</button>`;
  const actionLabel = isVictory ? 'Ulashish' : 'Qaytarish';
  const actionOnclick = isVictory
    ? `shareDuelResultBrag('${oppName.replace(/'/g,"\\'")}', ${myR.score}, ${myR.total}, ${isSpeaking}); drBurstConfetti();`
    : (isSpeaking ? `openDuelSkillSelect()` : `openDuelSkillSelect()`);
  const trophySvg = isVictory ? DR_VICTORY_TROPHY : DR_DEFEAT_TROPHY;

  const myAvatarInner = myPhoto ? `<img src="${myPhoto}" alt="">` : escapeHtml((myName||'?').trim().charAt(0).toUpperCase());
  const oppAvatarInner = oppPhoto ? `<img src="${oppPhoto}" alt="">` : escapeHtml((oppName||'?').trim().charAt(0).toUpperCase());

  const scorePct = _duelCmpPct(myR.score, oppR.score, false);
  const timePct = _duelCmpPct(myR.timeSec, oppR.timeSec, true);

  wrap.innerHTML = `
    <div class="dr-page ${isDark ? 'dr-dark' : ''}" id="drPage">
      <div class="dr-mesh-wrap" id="drMesh"></div>
      <div class="dr-content">
        <div class="dr-top-row">
          <div class="dr-left-col">
            <div>
              <h1 class="dr-title dr-${type==='victory'?'victory':'defeat'} dr-anim-title">${title}</h1>
              <div class="dr-subtitle dr-anim-subtitle">${subtitle}</div>
              <div class="dr-anim-tip">${tipHtml}</div>
            </div>
            <div class="dr-action-btn-wrap dr-anim-btn">
              <button type="button" class="dr-action-btn dr-${type==='victory'?'victory':'defeat'}" onclick="${actionOnclick}">${actionLabel}</button>
            </div>
          </div>
          <div class="dr-trophy-col">${trophySvg}</div>
        </div>
        <div class="dr-bottom-section">
          <div class="dr-compare-row">
            <div class="dr-compare-user">
              <div class="dr-avatar-lg dr-p1">${myAvatarInner}</div>
              <span class="dr-compare-name">Siz</span>
            </div>
            <div class="dr-compare-score">${myR.score}-${oppR.score}</div>
            <div class="dr-compare-user">
              <div class="dr-avatar-lg dr-p2">${oppAvatarInner}</div>
              <span class="dr-compare-name">${escapeHtml(oppName)}</span>
            </div>
          </div>
          <div class="dr-btn-row">
            <button type="button" class="btn btn-outline dr-back-btn" onclick="returnFromDuelResult()">Bellashuvlarga qaytish</button>
            <button type="button" class="btn btn-primary dr-analyze-btn" onclick="${isSpeaking ? 'openSpeakingDuelAnalysis()' : 'openDuelAnalysis()'}">Tahlil</button>
          </div>
        </div>
      </div>
    </div>`;

  const pageEl = document.getElementById('drPage');
  const meshEl = document.getElementById('drMesh');
  if(meshEl && pageEl){
    const w = Math.max(pageEl.clientWidth || window.innerWidth || 0, 320);
    meshEl.innerHTML = drBuildMesh(type, isDark, w);
  }
  if(state === 'win'){
    setTimeout(()=>{
      fireSideConfetti({ mode: 'celebration' });
    }, 220);
  }
}

// Admin/Dasturchi uchun preview sinovi: window.previewDuelResult('win' | 'lose' | 'draw')
window.previewDuelResult = function(type = 'win'){
  const me = _duelMyId();
  const myName = _duelMyName();
  const mockDuel = {
    token: 'preview_test_token',
    status: 'completed',
    duelType: 'grammar',
    skill: 'grammar',
    challenger: { id: me, name: myName },
    opponent: { id: 'opp_preview', name: 'Sardorbek' },
    challengerResult: {
      score: type === 'win' ? 9 : (type === 'lose' ? 5 : 8),
      total: 10,
      timeSec: type === 'win' ? 42 : (type === 'lose' ? 78 : 55)
    },
    opponentResult: {
      score: type === 'win' ? 6 : (type === 'lose' ? 9 : 8),
      total: 10,
      timeSec: type === 'win' ? 64 : (type === 'lose' ? 48 : 55)
    }
  };
  showView('duelresult');
  renderDuelResultScreen(mockDuel);
};

/* ---------- Duel: "Tahlil" — savollar bo'yicha ikkala tomon javoblarini
   solishtirish. Faqat submit_duel_answer orqali saqlangan (yangi sxema)
   savollarda ma'lumot bo'ladi; eski duellarda (get_duel_answers bo'sh yoki
   savol uchun yozuv topilmasa) o'sha savol katakchasi bosilmaydigan holatda
   ("tahlil mavjud emas") ko'rsatiladi. ---------- */
let _duelCurrentResult = null;
let _duelAnalysisCtx = null;

async function openDuelAnalysis(){
  const d = _duelCurrentResult;
  if(!d) return;
  document.getElementById('modalTitle').textContent = "Savollar bo'yicha tahlil";
  document.getElementById('modalBody').innerHTML = `<div style="text-align:center;padding:34px 0;color:var(--text-dim);font-size:13.5px;">Yuklanmoqda...</div>`;
  document.getElementById('modalOverlay').classList.add('show');

  const me = _duelMyId();
  const iAmChallenger = d.challenger.id === me;
  const myId = iAmChallenger ? d.challenger.id : d.opponent.id;
  const oppId = iAmChallenger ? d.opponent.id : d.challenger.id;
  const myName = _duelMyName();
  const oppName = (iAmChallenger ? d.opponent : d.challenger) ? (iAmChallenger ? d.opponent.name : d.challenger.name) : 'Raqib';

  const rows = await apiGetDuelAnswers(d.id);
  const ansMap = {};
  rows.forEach(r=>{
    const idx = r.question_index;
    if(!ansMap[idx]) ansMap[idx] = { minePresent:false, mine:null, oppPresent:false, opp:null };
    if(String(r.user_id) === String(myId)){ ansMap[idx].minePresent = true; ansMap[idx].mine = r.picked; }
    else if(String(r.user_id) === String(oppId)){ ansMap[idx].oppPresent = true; ansMap[idx].opp = r.picked; }
  });

  _duelAnalysisCtx = { d, ansMap, myName, oppName };
  renderDuelAnalysisGrid();
}

function renderDuelAnalysisGrid(){
  const ctx = _duelAnalysisCtx;
  if(!ctx) return;
  const { d, ansMap } = ctx;
  const questions = Array.isArray(d.questions) ? d.questions : [];
  const anyData = Object.keys(ansMap).length > 0;

  const cellsHtml = questions.map((q,i)=>{
    const entry = ansMap[i];
    const hasData = !!(entry && entry.minePresent);
    if(!hasData){
      return `
        <div class="review-card" data-idx="${i}">
          <div class="review-icon unanswered" style="opacity:.55;">${reviewIconSVG.wrong}</div>
          <div class="review-label">Savol ${i+1}</div>
        </div>`;
    }
    const isUnanswered = entry.mine === null || entry.mine === undefined;
    const correct = !isUnanswered && (entry.mine === q.a);
    const iconClass = isUnanswered ? 'unanswered' : (correct ? 'correct' : 'wrong');
    return `
      <div class="review-card clickable" data-idx="${i}" onclick="duelShowAnswerDetail(${i})">
        <div class="review-icon ${iconClass}">${correct?reviewIconSVG.correct:reviewIconSVG.wrong}</div>
        <div class="review-label">Savol ${i+1}</div>
      </div>`;
  }).join('');

  const hint = anyData
    ? "Tahlilini ko'rish uchun savol ustiga bosing"
    : "Bu duel uchun batafsil tahlil mavjud emas (eski duel)";

  document.getElementById('modalBody').innerHTML = `
    <div style="display:flex;flex-direction:column;gap:14px;">
      <div class="review-hint" style="margin:0;">${hint}</div>
      <div class="review-grid">${cellsHtml}</div>
      <button type="button" class="btn btn-primary btn-block" onclick="document.getElementById('modalOverlay').classList.remove('show')">Yopish</button>
    </div>`;
}

function duelShowAnswerDetail(i){
  const ctx = _duelAnalysisCtx;
  if(!ctx) return;
  const { d, ansMap, myName, oppName } = ctx;
  const q = d.questions[i];
  const entry = ansMap[i];
  if(!q || !entry || !entry.minePresent) return;

  const myPicked = entry.mine;
  const oppPicked = entry.oppPresent ? entry.opp : undefined;
  const optText = (opts, idx) => (opts && idx !== null && idx !== undefined && opts[idx] !== undefined) ? escapeHtml(opts[idx]) : "Javob berilmagan";

  const rowHtml = (label, pickedIdx, present) => {
    if(!present){
      return `
        <div style="display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:12px;background:var(--card-alt);border:1px solid var(--border);color:var(--text-faint);">
          <span style="font-size:16px;font-weight:800;line-height:1;">–</span>
          <div style="font-size:13.5px;font-weight:600;line-height:1.4;flex:1;">
            <span style="font-size:12px;opacity:0.85;display:block;margin-bottom:2px;">${label}:</span>
            <span style="font-size:13px;">Ma'lumot yo'q</span>
          </div>
        </div>`;
    }
    const isNull = pickedIdx === null || pickedIdx === undefined;
    const isCorrect = !isNull && pickedIdx === q.a;
    const bg = isNull ? 'var(--card-alt)' : (isCorrect ? 'var(--green-bg)' : 'var(--red-bg)');
    const border = isNull ? 'var(--border)' : (isCorrect ? 'rgba(18,167,104,0.3)' : 'rgba(214,69,69,0.3)');
    const color = isNull ? 'var(--text-dim)' : (isCorrect ? 'var(--green)' : 'var(--red)');
    const mark = isNull ? '–' : (isCorrect ? '✓' : '✕');
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:12px;background:${bg};border:1px solid ${border};color:${color};">
        <span style="font-size:16px;font-weight:800;line-height:1;">${mark}</span>
        <div style="font-size:13.5px;font-weight:600;line-height:1.4;flex:1;">
          <span style="font-size:12px;opacity:0.85;display:block;margin-bottom:2px;">${label}:</span>
          <span style="font-family:var(--font-ar);font-size:16px;font-weight:600;direction:rtl;display:block;">${isNull ? "Javob berilmagan" : optText(q.opts, pickedIdx)}</span>
        </div>
      </div>`;
  };

  const prevIdx = (() => { for(let k=i-1;k>=0;k--){ if(ansMap[k] && ansMap[k].minePresent) return k; } return undefined; })();
  const nextIdx = (() => { for(let k=i+1;k<d.questions.length;k++){ if(ansMap[k] && ansMap[k].minePresent) return k; } return undefined; })();

  document.getElementById('modalTitle').textContent = `${i+1}-savol tahlili`;
  document.getElementById('modalBody').innerHTML = `
    <div style="display:flex;flex-direction:column;gap:16px;">
      <div style="background:var(--bg);padding:16px;border-radius:14px;border:1px solid var(--border);">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;">
          <span style="font-size:11.5px;font-weight:700;color:var(--text-faint);text-transform:uppercase;letter-spacing:0.5px;">Savol</span>
          ${q.category ? `<span style="font-size:11px;font-weight:600;color:var(--indigo-700);">${escapeHtml(q.category)}</span>` : ''}
        </div>
        <div style="font-family:var(--font-ar);font-size:20px;line-height:1.7;direction:rtl;text-align:right;color:var(--text);font-weight:600;">
          ${escapeHtml(q.q)}
        </div>
      </div>

      <div style="display:flex;flex-direction:column;gap:9px;">
        ${rowHtml(myName, myPicked, entry.minePresent)}
        ${rowHtml(oppName, oppPicked, entry.oppPresent)}
        <div style="display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:12px;background:var(--green-bg);border:1px solid rgba(18,167,104,0.3);color:var(--green);">
          <span style="font-size:16px;font-weight:800;line-height:1;">✓</span>
          <div style="font-size:13.5px;font-weight:600;line-height:1.4;flex:1;">
            <span style="font-size:12px;opacity:0.85;display:block;margin-bottom:2px;">To'g'ri javob:</span>
            <span style="font-family:var(--font-ar);font-size:16px;font-weight:600;direction:rtl;display:block;">${optText(q.opts, q.a)}</span>
          </div>
        </div>
      </div>

      ${q.exp ? `
        <div style="background:var(--card-alt);padding:14px 16px;border-radius:14px;border:1px solid var(--border);">
          <div style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:var(--indigo-700);margin-bottom:6px;">
            <span>💡</span> Tushuntirish / Izoh:
          </div>
          <div style="font-size:13.5px;line-height:1.6;color:var(--text);font-weight:500;">
            ${escapeHtml(q.exp)}
          </div>
        </div>
      ` : ''}

      <div style="display:flex;gap:10px;margin-top:4px;">
        <button type="button" class="btn btn-outline" style="flex:1;" ${prevIdx !== undefined ? `onclick="duelShowAnswerDetail(${prevIdx})"` : 'disabled style="opacity:0.4;cursor:not-allowed;"'}>⬅ Oldingi</button>
        <button type="button" class="btn btn-outline" style="flex:1;" ${nextIdx !== undefined ? `onclick="duelShowAnswerDetail(${nextIdx})"` : 'disabled style="opacity:0.4;cursor:not-allowed;"'}>Keyingi ➡</button>
      </div>
      <button type="button" class="btn btn-outline btn-block" onclick="renderDuelAnalysisGrid()">⬅ Savollar ro'yxatiga qaytish</button>
    </div>
  `;
}

/* Ikki qiymatni diverging (markazdan ikki tomonga) progress-bar sifatida
   solishtirish uchun foizlarni hisoblaydi. invert=true bo'lsa (masalan
   vaqt — kamroq yaxshi), kichikroq qiymat kattaroq foiz oladi. */
function _duelCmpPct(myVal, oppVal, invert){
  const a = invert ? 1/Math.max(myVal,0.001) : Math.max(myVal,0);
  const b = invert ? 1/Math.max(oppVal,0.001) : Math.max(oppVal,0);
  const maxV = Math.max(a,b) || 1;
  return { mine:(a/maxV)*100, opp:(b/maxV)*100 };
}

/* Havola orqali duelga qo'shilish: Telegram start_param 'duel_<token>' bo'lsa,
   tasdiqlash oynasini ko'rsatamiz. checkPendingDuelInvite() ilova ishga
   tushgach (auth tugagach) chaqiriladi. */
async function checkPendingDuelInvite(){
  const startParam = window.Telegram?.WebApp?.initDataUnsafe?.start_param || '';
  if(!startParam.startsWith('duel_')) return;
  const token = startParam.slice(5);
  const d = await apiGetDuelByToken(token);
  if(!d){ toast("⚠️ Bu duel havolasi topilmadi yoki eskirgan"); return; }
  const me = _duelMyId();
  if(d.challenger.id === me){ showView('duelhistory'); return; } // o'zi yuborgan havola
  if(d.opponent){
    if(d.opponent.id === me){
      // Bu foydalanuvchi allaqachon qo'shilgan — davom ettiramiz
      if(!d.opponentResult){ startDuelQuiz(d.id, d); } else { showView('duelhistory'); }
    } else {
      toast("⚠️ Bu duelga allaqachon boshqa foydalanuvchi qo'shilgan");
    }
    return;
  }
  document.getElementById('modalTitle').textContent = 'Duelga taklif';
  document.getElementById('modalBody').innerHTML = `
    <div style="text-align:center;padding:10px 4px 6px;">
      <div style="font-size:38px;margin-bottom:12px;">⚔️</div>
      <div style="font-size:15.5px;font-weight:700;margin-bottom:8px;">${escapeHtml(d.challenger.name)} sizni Grammatika bo'yicha duelga chaqirdi!</div>
      <p style="font-size:13.5px;color:var(--text-dim);line-height:1.55;margin:0 0 20px;">${d.count} ta savol, vaqt cheklovi yo'q. Qabul qilib, hoziroq yechishingiz mumkin.</p>
      <div style="display:flex;gap:10px;">
        <button class="btn btn-outline" style="flex:1;padding:12px;" onclick="closeModal();showView('duel')">Keyinroq</button>
        <button class="btn btn-primary" style="flex:1;padding:12px;" onclick="closeModal();acceptDuelInvite('${token}')">Qabul qilish</button>
      </div>
    </div>`;
  document.getElementById('modalOverlay').classList.add('show');
}
async function acceptDuelInvite(token){
  toast('⏳ Duelga qo\'shilmoqda...', 1500);
  const d = await apiJoinDuel(token);
  if(!d){ return; } // xatolik bo'lsa apiJoinDuel o'zi toast chiqargan
  if(d.opponent && d.opponent.id !== _duelMyId()){
    toast("⚠️ Bu duelga allaqachon boshqa foydalanuvchi qo'shilgan");
    showView('duelhistory');
    return;
  }
  startDuelQuiz(d.id, d);
}

function startQuiz(skillId, customLabel, topicId){
  if(isAttanalLocked()){ toast("🔒 Bu bo'lim hozircha qulflangan"); return; }
  if(!checkSkillDailyLimit(skillId)) return;
  if(skillId === 'qiroa'){ startQiroaQuiz(customLabel); return; }
  if(skillId === 'istima'){ startIstimaQuiz(customLabel); return; }
  if(skillId === 'muhavara'){ startMuhavaraQuiz(customLabel); return; }
  const bank = QUESTION_BANKS[skillId] || QUESTION_BANKS.grammatika;
  let questions = bank.questions;
  if(skillId==='grammatika' && topicId && GRAMMAR_TOPIC_BANKS[topicId]){
    questions = GRAMMAR_TOPIC_BANKS[topicId];
  } else if(skillId==='grammatika' && !topicId){
    // "Grammatika mahorati" (real At-Tanal / mock imtihon) — 30 ta savol belgilangan nisbatda:
    // Nahv 15 ta, Sarf 7 ta, Imlo 4 ta, Keng tarqalgan xatolar 4 ta
    const examBuild = buildGrammarExamQuestions();
    questions = examBuild.questions;
    if(examBuild.shortage.length > 0 && questions.length < 30){
      toast(`⚠️ Real imtihon uchun savollar yetarli emas (${questions.length}/30 ta): ${examBuild.shortage.join(', ')}. Admin panelda kategoriya bo'yicha savol qo'shing.`, 6000);
    }
  }
  if(!questions || !questions.length){
    if(retryWhenDataReady(()=> startQuiz(skillId, customLabel, topicId))) return;
    toast("⚠️ Bu bo'lim/mavzu uchun hali savollar qo'shilmagan. Admin panelda qo'shing.");
    return;
  }
  const skillMeta = SKILLS.find(s=>s.id===skillId) || SKILLS.find(s=>s.id==='grammatika');
  currentQuiz = {
    skillId, topicId: topicId||null, type: bank.type, passage: bank.passage||null,
    questions: questions.map(q=>({...q, picked:null, timeLeft: q.timeLeft !== undefined ? q.timeLeft : 60, expired: false})),
    color: skillMeta.color, bg: skillMeta.bg, label: customLabel || skillMeta.name,
    idx:0, startedAt:Date.now(), duration: bank.type==='reading'?18*60: bank.type==='listening'?10*60:20*60,
  };
  const qTag = document.getElementById('quizTag');
  if(qTag){
    qTag.textContent = currentQuiz.label;
    qTag.style.background = skillMeta.bg;
    qTag.style.color = skillMeta.color;
  }
  buildQGrid();
  renderQuestion();
  if(bank.type !== 'mcq'){ startTimer(currentQuiz.duration); }
  showView('quiz');
}

/* ---------------- Qiroa: juz-ma-juz o'qish + savollar oqimi ---------------- */
function startQiroaQuiz(customLabel){
  // Har bir juzdan (agar shu juzda kamida 1 ta to'liq test — matn+savol bo'lsa) TASODIFIY
  // bitta test tanlanadi. Shu tanlangan testning savollari boshqa testlar bilan aralashmaydi.
  const availableJuz = QIROA_JUZ
    .map(meta => {
      const tests = (QIROA_TESTS[meta.id]||[]).filter(t => t.questions.length > 0);
      if(!tests.length) return null;
      // Rotatsiya: shu juzdagi testlar hammasi ko'rsatilib chiqmaguncha bitta test
      // ikkinchi marta tanlanmaydi.
      const picked = rotationPick1('qiroa_'+meta.id, tests);
      rotationMarkSeen('qiroa_'+meta.id, picked);
      return { ...meta, passage: picked.passage || '', title: picked.title || '', questions: picked.questions.map(q=>({...q, picked:null, timeLeft: q.timeLeft !== undefined ? q.timeLeft : 60, expired: false})) };
    })
    .filter(Boolean);
  if(availableJuz.length === 0){
    if(retryWhenDataReady(()=> startQiroaQuiz(customLabel))) return;
    toast("⚠️ Qiroa bo'limi uchun hali matn/savollar qo'shilmagan. Admin panelda qo'shing.");
    return;
  }
  let flat = [];
  const juzMeta = availableJuz.map(j=>{
    const startIdx = flat.length;
    flat = flat.concat(j.questions);
    return { id:j.id, name:j.name, passage:j.passage, title:j.title, readMins:j.readMins, qMins:j.qMins, startIdx, endIdx: flat.length-1 };
  });
  const skillMeta = SKILLS.find(s=>s.id==='qiroa');
  currentQuiz = {
    skillId:'qiroa', topicId:null, type:'reading-juz',
    questions: flat, juz: juzMeta, juzPointer:0, phase:'reading',
    color: skillMeta.color, bg: skillMeta.bg, label: customLabel || skillMeta.name,
    idx: juzMeta[0].startIdx, startedAt: Date.now(),
  };
  const qTag = document.getElementById('quizTag');
  if(qTag){
    qTag.textContent = currentQuiz.label;
    qTag.style.background = skillMeta.bg;
    qTag.style.color = skillMeta.color;
  }
  buildQGrid();
  showView('quiz');
  startQiroaJuzReading();
}
function startQiroaJuzReading(){
  const juz = currentQuiz.juz[currentQuiz.juzPointer];
  currentQuiz.phase = 'reading';
  currentQuiz.idx = juz.startIdx;
  renderQuestion();
  updateQGrid();
  startTimer(juz.readMins*60, ()=> startQiroaJuzQuestions());
}
function startQiroaJuzQuestions(){
  const juz = currentQuiz.juz[currentQuiz.juzPointer];
  currentQuiz.phase = 'questions';
  currentQuiz.idx = juz.startIdx;
  renderQuestion();
  updateQGrid();
  startTimer(juz.qMins*60, ()=> advanceAfterQiroaJuz());
}
function skipQiroaReading(){
  clearInterval(timerInterval);
  startQiroaJuzQuestions();
}
function advanceAfterQiroaJuz(){
  if(currentQuiz.juzPointer < currentQuiz.juz.length-1){
    currentQuiz.juzPointer++;
    startQiroaJuzReading();
  } else {
    finishQuiz();
  }
}
/* ---------------- Istima: qism-ma-qism audio + savollar oqimi ----------------
   1-qism: 6 ta qisqa audio va har birining o'z savoli ketma-ket (Audio 1 -> Savol 1 -> Audio 2 -> Savol 2 ... -> Audio 6 -> Savol 6)
   2-qism: 1 ta dialog audio + 6 ta savol (7-12)
   3-qism: 1 ta monolog/ma'ruza audio + 6 ta savol (13-18)
   Jami: 18 ta savol. */
function startIstimaQuiz(customLabel){
  // 1-qism uchun bankdan 6 ta test (har birida 1 audio + 1 savol) tanlaymiz
  const juz1Pool = (ISTIMA_TESTS['juz1'] || []).filter(t => t.questions && t.questions.length >= 1);
  // Rotatsiya: bank yetarlicha katta bo'lsa (>=6 ta test), hammasi ko'rsatilib
  // chiqmaguncha bitta audio-savol ikkinchi marta tanlanmaydi. Bank 6 tadan kichik
  // bo'lsagina (haqiqatan takrorlashning ILOJI yo'q), eskicha to'ldirish ishlatiladi.
  let pickedJuz1 = [];
  if(juz1Pool.length >= 6){
    pickedJuz1 = rotationPickN('istima_juz1', juz1Pool, 6);
    rotationMarkSeen('istima_juz1', pickedJuz1);
  } else if(juz1Pool.length > 0){
    const shuffledJuz1 = shuffleArray(juz1Pool);
    for(let i = 0; i < 6; i++){
      pickedJuz1.push(shuffledJuz1[i % shuffledJuz1.length]);
    }
  }

  // 2-qism va 3-qism uchun bittadan to'liq test tanlaymiz (rotatsiya bilan)
  const juz2Pool = (ISTIMA_TESTS['juz2'] || []).filter(t => t.questions && t.questions.length >= 1);
  const pickedJuz2 = rotationPick1('istima_juz2', juz2Pool);
  if(pickedJuz2) rotationMarkSeen('istima_juz2', pickedJuz2);

  const juz3Pool = (ISTIMA_TESTS['juz3'] || []).filter(t => t.questions && t.questions.length >= 1);
  const pickedJuz3 = rotationPick1('istima_juz3', juz3Pool);
  if(pickedJuz3) rotationMarkSeen('istima_juz3', pickedJuz3);

  if(pickedJuz1.length === 0 && !pickedJuz2 && !pickedJuz3){
    if(retryWhenDataReady(()=> startIstimaQuiz(customLabel))) return;
    toast("⚠️ Istima bo'limi uchun hali audio/savollar to'liq qo'shilmagan. Admin panelda qo'shing.");
    return;
  }

  let flat = [];
  const juzMeta = [];

  // 1-qism: 6 ta mustaqil audio-savol juftligi
  pickedJuz1.forEach((t, idx) => {
    const qObj = t.questions[0];
    const qCopy = {
      ...qObj,
      picked: null,
      timeLeft: qObj.timeLeft !== undefined ? qObj.timeLeft : 60,
      expired: false
    };
    const startIdx = flat.length;
    flat.push(qCopy);
    const endIdx = flat.length - 1;
    juzMeta.push({
      id: 'juz1',
      partNum: 1,
      name: '1-qism',
      audioIndex: idx + 1,
      totalAudiosInPart: pickedJuz1.length,
      audioUrl: t.audioUrl || '',
      maxPlays: (FULL_EXAM && FULL_EXAM.active) ? Infinity : 2,
      startIdx,
      endIdx
    });
  });

  // 2-qism: 1 ta dialog audio va 6 ta savol
  if(pickedJuz2){
    const startIdx = flat.length;
    const qCopies = (pickedJuz2.questions || []).map(q => ({
      ...q,
      picked: null,
      timeLeft: q.timeLeft !== undefined ? q.timeLeft : 60,
      expired: false
    }));
    flat = flat.concat(qCopies);
    const endIdx = flat.length - 1;
    juzMeta.push({
      id: 'juz2',
      partNum: 2,
      name: '2-qism',
      audioUrl: pickedJuz2.audioUrl || '',
      maxPlays: (FULL_EXAM && FULL_EXAM.active) ? Infinity : 2,
      startIdx,
      endIdx
    });
  }

  // 3-qism: 1 ta monolog/ma'ruza audio va 6 ta savol
  if(pickedJuz3){
    const startIdx = flat.length;
    const qCopies = (pickedJuz3.questions || []).map(q => ({
      ...q,
      picked: null,
      timeLeft: q.timeLeft !== undefined ? q.timeLeft : 60,
      expired: false
    }));
    flat = flat.concat(qCopies);
    const endIdx = flat.length - 1;
    juzMeta.push({
      id: 'juz3',
      partNum: 3,
      name: '3-qism',
      audioUrl: pickedJuz3.audioUrl || '',
      maxPlays: (FULL_EXAM && FULL_EXAM.active) ? Infinity : 2,
      startIdx,
      endIdx
    });
  }

  const skillMeta = SKILLS.find(s=>s.id==='istima');
  currentQuiz = {
    skillId:'istima', topicId:null, type:'listening-juz',
    questions: flat, juz: juzMeta, juzPointer:0, playsUsed:0,
    color: skillMeta.color, bg: skillMeta.bg, label: customLabel || skillMeta.name,
    idx: juzMeta[0].startIdx, startedAt: Date.now(),
  };
  const qTag = document.getElementById('quizTag');
  if(qTag){
    qTag.textContent = currentQuiz.label;
    qTag.style.background = skillMeta.bg;
    qTag.style.color = skillMeta.color;
  }
  buildQGrid();
  showView('quiz');
  startIstimaJuz();
}
function startIstimaJuz(){
  currentQuiz.idx = currentQuiz.juz[currentQuiz.juzPointer].startIdx;
  currentQuiz.playsUsed = 0;
  currentQuiz.phase = 'listening';
  clearInterval(timerInterval); clearQuestionTimer();
  const tEl = document.getElementById('quizTimer');
  if(tEl){ tEl.innerHTML = '<span class="timer-icon">⏱</span><span class="timer-digits">—:—</span>'; tEl.style.color=''; tEl.style.borderColor=''; }
  buildQGrid();
  renderQuestion();
  updateQGrid();
}
function advanceAfterIstimaJuz(){
  if(currentQuiz.juzPointer < currentQuiz.juz.length-1){
    currentQuiz.juzPointer++;
    startIstimaJuz();
  } else {
    finishQuiz();
  }
}
/* Yozma (Kitaba) topshiriq — 3 qismdan iborat, HAMMASI BITTA sessiyada ketma-ket
   ishlanadi (1-qism → 2-qism → 3-qism). Har bir qism uchun KITABA_TOPICS bankidan
   (admin panelda kiritilgan) TASODIFIY bitta arabcha mavzu tanlanadi — AI mavzu
   generatsiya qilmaydi. Har qism alohida AI tomonidan 0-10 ball bilan baholanadi,
   3 qismning yig'indisi (0-30) umumiy Kitaba balli hisoblanadi. */
function startKitabaExam(){
  if(isAttanalLocked()){ toast("🔒 Bu bo'lim hozircha qulflangan"); return; }
  if(!checkSkillDailyLimit('kitaba')) return;
  const parts = [];
  for(const part of KITABA_PARTS){
    const bank = KITABA_TOPICS[part.id] || [];
    if(bank.length === 0){
      if(retryWhenDataReady(()=> startKitabaExam())) return;
      toast(`⚠️ Kitaba ${part.name} uchun hali mavzu qo'shilmagan. Admin panelda qo'shing.`);
      return;
    }
    // Rotatsiya: shu qism uchun hamma mavzular ko'rsatilib chiqmaguncha bitta mavzu
    // ikkinchi marta tanlanmaydi.
    const topic = rotationPick1('kitaba_'+part.id, bank);
    rotationMarkSeen('kitaba_'+part.id, topic);
    parts.push({ part, topic, text:'', score:null, feedback:null, criteria:null, corrected:'' });
  }
  currentQuiz = {
    skillId:'kitaba', type:'writing', label:'Kitaba (Yozma)', color:'var(--kitaba)',
    questions: parts, idx:0, phase:'writing', startedAt:Date.now(),
  };
  document.getElementById('quizTag').textContent = 'Kitaba (Yozma)';
  document.getElementById('quizTag').style.background = 'var(--kitaba-bg)';
  document.getElementById('quizTag').style.color = 'var(--kitaba)';
  document.getElementById('quizSide').style.display = 'none';
  renderQuestion();
  startTimer(currentQuiz.questions[0].part.seconds, ()=> forceSubmitWriting());
  showView('quiz');
}

/* Speaking quiz has its own simplified entry through hub button too (skillId muhavara) */

function updateMarathonHeaderStats(){
  const timerEl = document.getElementById('quizTimer');
  if(!timerEl) return;
  let wrong = 0;
  let correct = 0;
  if(currentQuiz && currentQuiz.questions){
    currentQuiz.questions.forEach(q => {
      if(q.picked !== null && q.picked !== undefined){
        if(q.picked === q.a){
          correct++;
        } else {
          wrong++;
        }
      }
    });
  }
  timerEl.innerHTML = `<span style="display:inline-flex;align-items:center;gap:4px;font-weight:700;font-size:13.5px;font-variant-numeric:tabular-nums;"><span style="color:var(--red,#EF4444);">${wrong}</span><span style="color:var(--text-faint,#94a3b8);font-weight:500;">/</span><span style="color:var(--green,#10B981);">${correct}</span></span>`;
  timerEl.style.borderColor = 'var(--border)';
  timerEl.style.color = '';
  timerEl.style.minWidth = 'auto';
  timerEl.style.padding = '3px 8px';
}

function isQuestionAccessible(i){
  if(!currentQuiz || !Array.isArray(currentQuiz.questions) || !currentQuiz.questions[i]) return false;

  // Qiroa (O'qish): Har bir juzda avval matn o'qiladi, so'ng shu juz savollari yechiladi
  if(currentQuiz.skillId === 'qiroa' || currentQuiz.type === 'reading-juz'){
    if(currentQuiz.phase === 'reading') return false; // Matn o'qish paytida savollarga o'tib bo'lmaydi
    if(!currentQuiz.juz || !currentQuiz.juz[currentQuiz.juzPointer]) return false;
    const curJuz = currentQuiz.juz[currentQuiz.juzPointer];
    return i >= curJuz.startIdx && i <= curJuz.endIdx;
  }

  // Istima (Tinglash): Har bir qismda avval audio eshitiladi, so'ng savollar yechiladi
  if(currentQuiz.skillId === 'istima' || currentQuiz.type === 'listening-juz'){
    if(currentQuiz.phase === 'listening') return false; // Audio tinglash paytida savollarga o'tib bo'lmaydi
    if(!currentQuiz.juz || !currentQuiz.juz[currentQuiz.juzPointer]) return false;
    const curJuz = currentQuiz.juz[currentQuiz.juzPointer];
    return i >= curJuz.startIdx && i <= curJuz.endIdx;
  }

  // Grammatika, Mock testlar va boshqa bo'limlar:
  // Hali navbati kelmagan savollar qulflangan bo'ladi (faqat yetib kelingan savolgacha o'tish mumkin)
  const maxIdx = (currentQuiz.maxUnlockedIdx !== undefined) ? currentQuiz.maxUnlockedIdx : (currentQuiz.idx || 0);
  return i <= maxIdx;
}

function buildQGrid(){
  const grid = document.getElementById('qgrid');
  const wrap = document.getElementById('qgridWrap');
  const sideEl = document.getElementById('quizSide');
  if(!currentQuiz || !Array.isArray(currentQuiz.questions)){
    if(sideEl) sideEl.style.display = 'none';
    return;
  }
  const isSpeaking = currentQuiz.skillId === 'muhavara' || currentQuiz.type === 'speaking';
  const isWriting = currentQuiz.skillId === 'kitaba' || currentQuiz.type === 'writing';
  const isIstimaBeforeJuz2 = (currentQuiz.skillId === 'istima' || currentQuiz.type === 'listening-juz') && (
    !currentQuiz.juz || !currentQuiz.juz[currentQuiz.juzPointer] || currentQuiz.juz[currentQuiz.juzPointer].partNum < 2
  );
  const isExcluded = currentQuiz.isMarathon || currentQuiz.isDuel || isSpeaking || isWriting || isIstimaBeforeJuz2 || (FULL_EXAM && FULL_EXAM.active);
  if(isExcluded){
    if(sideEl) sideEl.style.display = 'none';
    return;
  }
  if(sideEl) sideEl.style.display = '';
  if(wrap) wrap.style.display = '';
  if(currentQuiz.maxUnlockedIdx === undefined){
    currentQuiz.maxUnlockedIdx = currentQuiz.idx || 0;
  }
  if(grid){
    grid.classList.toggle('qgrid-compact', currentQuiz.questions.length > 20);
    grid.innerHTML = currentQuiz.questions.map((q,i)=>`<button class="qbtn" data-i="${i}" onclick="jumpTo(${i})">${i+1}</button>`).join('');
  }
  updateQGrid();
}
function renderQuizCapsules(){
  const container = document.getElementById('quizCapsulesContainer');
  if(!container) return;
  const isSpeaking = !!(currentQuiz && (currentQuiz.skillId === 'muhavara' || currentQuiz.type === 'speaking' || currentQuiz.type === 'muhavara'));
  if(!isSpeaking || !currentQuiz || !Array.isArray(currentQuiz.questions) || currentQuiz.questions.length === 0 || currentQuiz.phase === 'done' || currentQuiz.phase === 'summary' || currentQuiz.phase === 'evaluating'){
    container.style.display = 'none';
    return;
  }
  container.style.display = 'flex';

  let partTitle = '1-qism';
  let startIdx = 0;
  let partQuestionsCount = 2;
  const curIdx = currentQuiz.idx || 0;

  const q = currentQuiz.questions[curIdx];
  if(q && q.part){
    partTitle = q.part.name || '1-qism';
    const partQs = currentQuiz.questions.filter(item => item.part && item.part.id === q.part.id);
    partQuestionsCount = partQs.length || 2;
    const fIdx = currentQuiz.questions.findIndex(item => item.part && item.part.id === q.part.id);
    startIdx = fIdx >= 0 ? fIdx : 0;
  } else {
    const partNum = Math.floor(curIdx / 2) + 1;
    partTitle = `${partNum}-qism`;
    startIdx = (partNum - 1) * 2;
    partQuestionsCount = 2;
  }

  const titleEl = document.getElementById('quizPartTitle');
  if(titleEl){
    titleEl.textContent = partTitle;
  }

  const rowEl = document.getElementById('quizCapsulesRow');
  if(rowEl){
    let capsulesHtml = '';
    for(let k = 0; k < partQuestionsCount; k++){
      const qIdx = startIdx + k;
      const q = currentQuiz.questions[qIdx];
      const isCurrent = (curIdx === qIdx);
      const isAnswered = !!(q && (q.picked !== null && q.picked !== undefined || q.answered || (q.userAnswer !== undefined && q.userAnswer !== null && q.userAnswer !== '')));

      let statusClass = 'upcoming';
      if(isCurrent){
        statusClass = 'current';
      } else if(isAnswered){
        statusClass = 'answered';
      }

      capsulesHtml += `<div class="quiz-capsule ${statusClass}" data-qidx="${qIdx}"></div>`;
    }
    rowEl.innerHTML = capsulesHtml;
  }
}

function updateQGrid(){
  if(currentQuiz){
    if(currentQuiz.maxUnlockedIdx === undefined){
      currentQuiz.maxUnlockedIdx = currentQuiz.idx || 0;
    } else {
      currentQuiz.maxUnlockedIdx = Math.max(currentQuiz.maxUnlockedIdx, currentQuiz.idx || 0);
    }
  }
  document.querySelectorAll('.qbtn').forEach((b,i)=>{
    const q = currentQuiz?.questions?.[i];
    const accessible = isQuestionAccessible(i);
    b.classList.toggle('current', i===currentQuiz?.idx);
    b.classList.toggle('answered', !!(q && q.picked!==null && q.picked!==undefined));
    b.classList.toggle('expired', !!(q && (q.expired || (q.timeLeft !== undefined && q.timeLeft <= 0))));
    b.classList.toggle('locked', !accessible);
    if(!accessible){
      b.setAttribute('disabled', 'true');
      b.setAttribute('aria-disabled', 'true');
      b.title = "Hali navbati kelmagan savol";
    } else {
      b.removeAttribute('disabled');
      b.removeAttribute('aria-disabled');
      b.removeAttribute('title');
    }
  });
  renderQuizCapsules();
}
function jumpTo(i){
  if(!isQuestionAccessible(i)) return;
  clearQuestionTimer();
  currentQuiz.idx = i;
  renderQuestion();
  updateQGrid();
  if(currentQuiz && currentQuiz.isMarathon){
    const state = getMarathonState();
    state.currentIndex = i;
    saveMarathonState(state);
  }
}

function renderQuestion(){
  const isSpeaking = !!(currentQuiz && (currentQuiz.skillId === 'muhavara' || currentQuiz.type === 'speaking'));
  const isSpeakingRec = isSpeaking && currentQuiz.phase === 'recording';
  document.body.classList.toggle('speaking-quiz-active', isSpeaking);
  document.body.classList.toggle('speaking-recording-active', isSpeakingRec);
  const quizHeadEl = document.getElementById('quizHead');
  if(quizHeadEl){
    quizHeadEl.style.display = '';
    quizHeadEl.classList.toggle('quiz-head-collapsed', isSpeakingRec);
  }
  const topbarRightEl = document.querySelector('#mainTopbar .topbar-right');
  if(topbarRightEl){
    topbarRightEl.style.display = isSpeaking ? 'none' : 'flex';
  }
  renderQuizCapsules();
  if(currentQuiz && currentQuiz.color){
    const quizWrapEl = document.getElementById('view-quiz');
    if(quizWrapEl) quizWrapEl.style.setProperty('--quiz-accent', currentQuiz.color);
    const legendSw = document.getElementById('legendCurrentSw');
    if(legendSw) legendSw.style.background = currentQuiz.color;
  }
  const qTag = document.getElementById('quizTag');
  if(qTag){
    if(isSpeaking){
      qTag.style.display = 'none';
    } else if(currentQuiz && currentQuiz.isMarathon){
      qTag.style.display = 'inline-flex';
      qTag.style.background = 'transparent';
      qTag.style.border = 'none';
      qTag.style.padding = '0';
      qTag.style.fontSize = '15px';
      qTag.style.fontWeight = '700';
      qTag.style.color = 'var(--text)';
      qTag.style.lineHeight = '1.2';
      qTag.textContent = `Savol ${currentQuiz.idx+1} / ${currentQuiz.questions.length}`;
    } else {
      qTag.style.display = 'inline-flex';
      qTag.style.background = currentQuiz.bg || '';
      qTag.style.color = currentQuiz.color || '';
      qTag.style.border = '';
      qTag.style.padding = '';
      qTag.style.fontSize = '';
      qTag.style.fontWeight = '';
      qTag.style.lineHeight = '';
      qTag.textContent = currentQuiz.label || 'Test';
    }
  }
  const sideCard = document.getElementById('quizSide');
  if(sideCard){
    const isSpeaking = currentQuiz && (currentQuiz.skillId === 'muhavara' || currentQuiz.type === 'speaking');
    const isWriting = currentQuiz && (currentQuiz.skillId === 'kitaba' || currentQuiz.type === 'writing');
    const isIstimaBeforeJuz2 = currentQuiz && (currentQuiz.skillId === 'istima' || currentQuiz.type === 'listening-juz') && (
      !currentQuiz.juz || !currentQuiz.juz[currentQuiz.juzPointer] || currentQuiz.juz[currentQuiz.juzPointer].partNum < 2
    );
    const hideSide = !currentQuiz || currentQuiz.isMarathon || currentQuiz.isDuel || isSpeaking || isWriting || isIstimaBeforeJuz2 || (FULL_EXAM && FULL_EXAM.active) || currentQuiz.phase === 'done' || currentQuiz.phase === 'evaluating';
    sideCard.style.display = hideSide ? 'none' : '';
  }
  const quizWrapForLock = document.querySelector('#view-quiz .quiz-wrap');
  if(quizWrapForLock) quizWrapForLock.classList.toggle('duel-locked', !!(currentQuiz && currentQuiz.isDuel));
  const fontCtrl = document.getElementById('examFontCtrl');
  if(fontCtrl){
    const hideZoom = currentQuiz && (currentQuiz.skillId === 'istima' || currentQuiz.skillId === 'muhavara' || currentQuiz.type === 'speaking' || currentQuiz.type === 'listening' || currentQuiz.skillId === 'kitaba' || currentQuiz.type === 'writing' || currentQuiz.phase === 'done' || currentQuiz.phase === 'evaluating');
    fontCtrl.style.display = hideZoom ? 'none' : 'flex';
  }
  const topTimerEl = document.getElementById('quizTimer');
  if(topTimerEl){
    const isSpeaking = currentQuiz && (currentQuiz.skillId === 'muhavara' || currentQuiz.type === 'speaking');
    const isWritingDone = currentQuiz && (currentQuiz.skillId === 'kitaba' || currentQuiz.type === 'writing') && (currentQuiz.phase === 'done' || currentQuiz.phase === 'evaluating');
    if(isSpeaking || isWritingDone || (currentQuiz && currentQuiz.isDuel)){
      topTimerEl.innerHTML = '';
      topTimerEl.style.display = 'none';
    } else {
      topTimerEl.style.display = '';
    }
  }
  renderDuelVsHead();
  const body = document.getElementById('quizBody');
  if(currentQuiz.type==='writing'){
    clearQuestionTimer();
    const cur = currentQuiz.questions[currentQuiz.idx];
    if(currentQuiz.phase === 'evaluating'){
      body.innerHTML = `
        <div class="prompt-box" style="text-align:center;">
          <div class="lbl">Barcha qismlar AI tomonidan tekshirilmoqda</div>
          <div style="margin-top:14px;">⏳ Punktuatsiya, imlo, lug'at, matn tuzilishi, fikrlarning aniqligi va mavzuni ochish bo'yicha baholanmoqda, biroz kuting...</div>
        </div>
      `;
      return;
    }
    if(currentQuiz.phase === 'done'){
      renderKitabaSummary();
      return;
    }
    const unlockTarget = cur.part.unlockWords || Math.round(cur.part.minWords / 2);
    body.innerHTML = `
      <div class="q-sub">${cur.part.name} · ${currentQuiz.idx+1} / ${currentQuiz.questions.length}</div>
      <div class="prompt-box">
        <div class="lbl">Mavzu</div>
        <div style="font-family:var(--font-ar);font-size:19px;direction:rtl;text-align:right;margin-bottom:10px;">${cur.topic.topicAr}</div>
        <div class="lbl" style="margin-top:10px;">Talablar:</div>
        <ul>
          <li>Faqat <strong>arab alifbosida</strong> yozish</li>
          <li>Talab qilingan hajm: <strong>${cur.part.minWords}+ so'z</strong></li>
          <li>Mavzudan chetga chiqmaslik va imloga e'tibor berish</li>
        </ul>
      </div>
      <textarea class="write-area" id="writeArea" dir="rtl" style="font-family:var(--font-ar);font-size:16.5px;line-height:1.7;min-height:180px;" placeholder="اكتب هنا باللغة العربية...">${escapeHtml(cur.text||'')}</textarea>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;flex-wrap:wrap;gap:6px;">
        <div class="wordcount" id="wcWrap"><span id="wcount">0</span> / ${cur.part.minWords}+ so'z</div>
      </div>
      <div style="display:flex;justify-content:center;margin-top:16px;">
        <button id="ktSubmitBtn" class="btn btn-primary" style="padding:12px 36px;border-radius:9999px;min-width:180px;" onclick="submitWriting()">Yuborish</button>
      </div>
    `;
    const ta = document.getElementById('writeArea');
    const wcWrap = document.getElementById('wcWrap');
    const btn = document.getElementById('ktSubmitBtn');
    let lastToastTime = 0;
    
    function count(){
      let val = ta.value;
      if(containsNonArabicLetters(val)){
        const now = Date.now();
        if(now - lastToastTime > 2000){
          toast("⚠️ Faqat arab alifbosida yozing!", 3000);
          lastToastTime = now;
        }
        val = sanitizeArabicInput(val);
        ta.value = val;
      }
      cur.text = val;
      const words = countArabicWords(val);
      
      const isUnlocked = words >= unlockTarget;
      if(ta) ta.style.borderColor = words >= cur.part.minWords ? 'var(--green)' : '';
      
      if(btn){
        btn.style.opacity = isUnlocked ? '1' : '0.55';
        btn.style.cursor = isUnlocked ? 'pointer' : 'not-allowed';
      }

      if(wcWrap){
        wcWrap.innerHTML = `<span style="font-weight:700;${words >= cur.part.minWords ? 'color:var(--green);' : ''}">${words}</span> / ${cur.part.minWords}+ so'z`;
      }
    }
    ta.addEventListener('input', count);
    count();
    return;
  }
  if(currentQuiz.skillId==='muhavara'){
    renderMuhavaraPhase();
    return;
  }
  if(currentQuiz.skillId==='qiroa'){
    clearQuestionTimer();
    renderQiroaPhase();
    return;
  }
  if(currentQuiz.skillId==='istima'){
    clearQuestionTimer();
    renderIstimaPhase();
    return;
  }
  const q = currentQuiz.questions[currentQuiz.idx];
  const isExpired = !currentQuiz.isMarathon && !!(q.expired || (q.timeLeft !== undefined && q.timeLeft <= 0));
  let html = '';
  if(currentQuiz.type==='reading' && currentQuiz.passage){
    html += `<div class="passage">${currentQuiz.passage}</div>`;
  }
  if(currentQuiz.type==='listening'){
    html += `
      <div class="prompt-box" style="display:flex;align-items:center;gap:14px;">
        <button onclick="toast('Audio ijro etilmoqda 🔊')" style="width:44px;height:44px;border-radius:50%;background:var(--istima);border:none;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </button>
        <div style="flex:1;">
          <div style="height:5px;background:var(--indigo-100);border-radius:99px;"><div style="width:38%;height:100%;background:var(--istima);border-radius:99px;"></div></div>
        </div>
        <span style="font-size:12px;color:var(--text-faint);font-weight:600;">0:32 / 1:24</span>
      </div>`;
  }
  
  if(!currentQuiz.isMarathon){
    html += `<div class="q-sub">Savol ${currentQuiz.idx+1} / ${currentQuiz.questions.length}</div>`;
  }
  html += `<div class="q-text">${q.q}</div>`;

  if(currentQuiz.isMarathon){
    const hasPicked = q.picked !== null && q.picked !== undefined;
    html += `<div class="options">` + q.opts.map((opt,oi)=>{
      let cls = '';
      if(hasPicked){
        if(oi === q.picked){
          cls = (q.picked === q.a) ? 'selected correct disabled' : 'selected incorrect disabled';
        } else if(oi === q.a && q.picked !== q.a){
          cls = 'correct disabled';
        } else {
          cls = 'disabled';
        }
      }
      const clickHandler = hasPicked ? '' : `onclick="pickOption(${oi})"`;
      const pointerStyle = hasPicked ? 'style="pointer-events:none;"' : '';
      return `<div class="option ${cls}" ${clickHandler} ${pointerStyle}>
        <span class="opt-circle">${ARABIC_OPT_LETTERS[oi]||''}</span><span class="opt-text">${opt}</span>
      </div>`;
    }).join('') + `</div>`;
  } else {
    const duelAnswered = currentQuiz.isDuel && q.picked !== null && q.picked !== undefined;
    html += `<div class="options">` + q.opts.map((opt,oi)=>`
      <div class="option ${q.picked===oi?'selected':''} ${(isExpired||duelAnswered)?'disabled is-expired':''}" onclick="pickOption(${oi})" ${(isExpired||duelAnswered)?'aria-disabled="true"':''}>
        <span class="opt-circle">${ARABIC_OPT_LETTERS[oi]||''}</span><span class="opt-text">${opt}</span>
      </div>`).join('') + `</div>`;
  }

  if(currentQuiz.isMarathon){
    const isLast = currentQuiz.idx === currentQuiz.questions.length - 1;
    const isSaved = isCurrentMarathonQuestionSaved();
    const hasPicked = (q.picked !== null && q.picked !== undefined);
    html += `<div class="q-nav-row marathon-nav-row">
        <button type="button" class="btn btn-outline q-nav-btn-compact" onclick="prevQ()" ${currentQuiz.idx===0?'disabled style="opacity:.4;cursor:default;"':''}>← Oldingi</button>
        <button type="button" class="btn-save-bookmark ${isSaved ? 'active' : ''} ${hasPicked ? 'visible' : ''}" id="marathonSaveBtn" onclick="toggleSaveCurrentMarathonQuestion()" title="${isSaved ? 'Saqlanganlardan olib tashlash' : 'Savolni saqlash'}" aria-label="Savolni saqlash">
          ${isSaved ? `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
            </svg>
          ` : `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
            </svg>
          `}
        </button>
        <button type="button" class="btn btn-primary q-nav-btn-compact" onclick="nextQ()">${isLast ? 'Yakunlash' : 'Keyingi →'}</button>
      </div>`;
  } else if(currentQuiz.isDuel){
    const isLast = currentQuiz.idx === currentQuiz.questions.length - 1;
    html += `<div class="q-nav-row" id="duelNavArea">
        <button type="button" class="btn btn-primary" style="width:100%;padding:14px;font-size:15px;font-weight:700;" onclick="nextQ()">${isLast ? 'Yakunlash' : 'Keyingi →'}</button>
      </div>`;
  } else {
    html += `<div class="q-nav-row">
        <button class="btn btn-outline" onclick="prevQ()" ${currentQuiz.idx===0?'disabled style="opacity:.4;cursor:default;"':''}>← Oldingi</button>
        <button class="btn btn-primary" onclick="nextQ()">${currentQuiz.idx===currentQuiz.questions.length-1?'Yakunlash':'Keyingi →'}</button>
      </div>`;
  }
  body.innerHTML = html;
  if(currentQuiz.isMarathon){
    clearQuestionTimer();
    updateMarathonHeaderStats();
  } else if(currentQuiz.type==='mcq' || currentQuiz.type==='mock' || currentQuiz.skillId==='grammatika'){
    startQuestionTimer();
  } else {
    clearQuestionTimer();
  }
  if(currentQuiz.isDuel){
    _duelStopAnswerPolling();
  }
}
function pickOption(oi){
  if(!currentQuiz || !currentQuiz.questions) return;
  const q = currentQuiz.questions[currentQuiz.idx];
  if(!q) return;

  if(currentQuiz.isMarathon){
    if(q.picked !== null && q.picked !== undefined) return;
    q.picked = oi;
    const isCorrect = (oi === q.a);
    if(isCorrect){
      fireSideConfetti({ mode: 'marathon' });
    }
    const optEls = document.querySelectorAll('#quizBody .option');
    optEls.forEach((el, idx)=>{
      el.classList.remove('selected', 'correct', 'incorrect');
      el.classList.add('disabled');
      el.style.pointerEvents = 'none';
      if(idx === oi){
        el.classList.add('selected', isCorrect ? 'correct' : 'incorrect');
      } else if(idx === q.a && !isCorrect){
        el.classList.add('correct');
      }
    });

    const saveBtn = document.getElementById('marathonSaveBtn');
    if(saveBtn){
      saveBtn.classList.add('visible');
    }

    const state = getMarathonState();
    if(!state.answers) state.answers = {};
    state.answers[currentQuiz.idx] = oi;
    state.currentIndex = currentQuiz.idx;
    state.completedCount = Object.keys(state.answers).length;
    saveMarathonState(state);

    updateMarathonHeaderStats();
    return;
  }

  if(q.expired || (q.timeLeft !== undefined && q.timeLeft <= 0)){
    toast("⏰ Ushbu savol uchun vaqt tugagan, javob berib bo'lmaydi");
    return;
  }

  if(currentQuiz.isDuel && q.picked !== null && q.picked !== undefined) return; // duelda javob tanlangach o'zgartirib bo'lmaydi

  q.picked = oi;
  const optEls = document.querySelectorAll('#quizBody .option');
  optEls.forEach((el, idx)=>{
    el.classList.toggle('selected', idx === oi);
    if(currentQuiz.isDuel) el.classList.add('disabled');
  });
  updateQGrid();
  if(currentQuiz.isDuel){
    updateDuelVsTimer();
    handleDuelAnswerSubmitted(q, currentQuiz.idx);
  }
}
function nextQ(){
  clearQuestionTimer();
  _duelStopAnswerPolling();
  if(currentQuiz.skillId==='qiroa' && currentQuiz.phase==='questions'){
    const juz = currentQuiz.juz[currentQuiz.juzPointer];
    if(currentQuiz.idx < juz.endIdx){ currentQuiz.idx++; renderQuestion(); updateQGrid(); }
    else { clearInterval(timerInterval); advanceAfterQiroaJuz(); }
    return;
  }
  if(currentQuiz.skillId==='istima'){
    const juz = currentQuiz.juz[currentQuiz.juzPointer];
    if(currentQuiz.idx < juz.endIdx){ currentQuiz.idx++; renderIstimaQuestionAnimated(); }
    else { advanceAfterIstimaJuz(); }
    return;
  }
  if(currentQuiz.idx < currentQuiz.questions.length-1){
    currentQuiz.idx++;
    if(currentQuiz.isMarathon){
      const state = getMarathonState();
      state.currentIndex = currentQuiz.idx;
      saveMarathonState(state);
    }
    renderQuestion();
    updateQGrid();
  }
  else finishQuiz();
}
function prevQ(){
  clearQuestionTimer();
  if(currentQuiz.skillId==='qiroa' && currentQuiz.phase==='questions'){
    const juz = currentQuiz.juz[currentQuiz.juzPointer];
    if(currentQuiz.idx > juz.startIdx){ currentQuiz.idx--; renderQuestion(); updateQGrid(); }
    return;
  }
  if(currentQuiz.skillId==='istima'){
    const juz = currentQuiz.juz[currentQuiz.juzPointer];
    if(currentQuiz.idx > juz.startIdx){ currentQuiz.idx--; renderQuestion(); updateQGrid(); }
    return;
  }
  if(currentQuiz.idx>0){
    currentQuiz.idx--;
    if(currentQuiz.isMarathon){
      const state = getMarathonState();
      state.currentIndex = currentQuiz.idx;
      saveMarathonState(state);
    }
    renderQuestion();
    updateQGrid();
  }
}

/* ---------------- Qiroa: joriy juz/fazaga qarab render qilish ---------------- */
function renderQiroaPhase(){
  const body = document.getElementById('quizBody');
  const juz = currentQuiz.juz[currentQuiz.juzPointer];
  const juzLabel = `${juz.name} / ${currentQuiz.juz.length}`;

  if(currentQuiz.phase==='reading'){
    /* Foydalanuvchiga imtihonda har doim matnning o'zi to'liq ko'rsatiladi — "mavzu nomi"
       faqat admin panelda testlar ro'yxatini ko'rishni qulaylashtirish uchun (pastda,
       renderAdminQuestions() ichida ishlatiladi), imtihon oynasiga taalluqli emas. */
    body.innerHTML = `
      <div class="q-sub" style="text-align:center;font-size:14px;font-weight:600;color:var(--text-faint);margin-bottom:14px;">Tayyorgarlik vaqti</div>
      <div style="display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:700;color:var(--indigo-700);background:var(--indigo-100);padding:6px 14px;border-radius:99px;margin-bottom:12px;">
        <span>💡</span> Tushunmagan so'zingiz ustiga bosing — 1 bosishda shaxsiy lug'atga saqlanadi
      </div>
      <div class="passage">${juz.passage ? juz.passage : '<span style="opacity:.5;">Bu juz uchun matn hali admin panelda kiritilmagan.</span>'}</div>
      <div class="q-nav-row" style="justify-content:center;">
        <button class="btn btn-primary" onclick="skipQiroaReading()">Savollarga o'tish →</button>
      </div>
    `;
    const passageEl = body.querySelector('.passage');
    if(passageEl) makeArabicPassageInteractive(passageEl);
    return;
  }

  const q = currentQuiz.questions[currentQuiz.idx];
  const isExpired = !!(q.expired || (q.timeLeft !== undefined && q.timeLeft <= 0));
  const localNum = currentQuiz.idx - juz.startIdx + 1;
  const localTotal = juz.endIdx - juz.startIdx + 1;
  let html = `<div class="q-sub">${juzLabel} · Savol ${localNum} / ${localTotal}</div>`;
  html += `<div class="q-text">${q.q}</div>`;
  html += `<div class="options">` + q.opts.map((opt,oi)=>`
    <div class="option ${q.picked===oi?'selected':''} ${isExpired?'disabled is-expired':''}" onclick="pickOption(${oi})" ${isExpired?'aria-disabled="true"':''}>
      <span class="opt-circle">${ARABIC_OPT_LETTERS[oi]||''}</span><span class="opt-text">${opt}</span>
    </div>`).join('') + `</div>`;
  const isVeryLast = currentQuiz.juzPointer===currentQuiz.juz.length-1 && currentQuiz.idx===juz.endIdx;
  html += `<div class="q-nav-row">
      <button class="btn btn-outline" onclick="prevQ()" ${currentQuiz.idx===juz.startIdx?'disabled style="opacity:.4;cursor:default;"':''}>← Oldingi</button>
      <button class="btn btn-primary" onclick="nextQ()">${isVeryLast?'Yakunlash':(currentQuiz.idx===juz.endIdx?'Keyingi juz →':'Keyingi →')}</button>
    </div>`;
  body.innerHTML = html;
}

/* Istima: savol almashishida ishlatiladigan silliq transition.
   Audio tugab avtomatik o'tishda ham, "Keyingi savol" tugmasi bosilganda ham
   xuddi shu funksiya orqali chaqiriladi — shu sabab ikkalasida ham bir xil animatsiya ishlaydi.
   Ketma-ketlik: qisqa pauza -> joriy savol chapga siljib yo'qoladi -> kontent almashadi
   -> yangi savol o'ngdan kirib keladi. Faqat #quizBody kontenti animatsiya qilinadi;
   header, timer va yon paneldagi progress grid alohida DOM elementlari bo'lgani uchun joyidan qimirlamaydi. */
function renderIstimaQuestionAnimated(){
  const body = document.getElementById('quizBody');
  if(!body || !body.firstElementChild){ renderQuestion(); updateQGrid(); return; }
  body.classList.remove('q-istima-in','q-istima-out');
  setTimeout(function(){
    body.classList.add('q-istima-out');
    setTimeout(function(){
      renderQuestion();
      updateQGrid();
      body.classList.remove('q-istima-out');
      body.classList.add('q-istima-in');
      setTimeout(function(){ body.classList.remove('q-istima-in'); }, 220);
    }, 160);
  }, 180);
}

/* ---------------- Istima: joriy qismga qarab render qilish (audio + savol) ---------------- */
function fmtPlays(n){ return isFinite(n) ? String(n) : '∞'; }
function fmtAudioTime(secs){
  if(isNaN(secs) || !isFinite(secs) || secs < 0) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return m + ':' + String(s).padStart(2,'0');
}

function renderIstimaPhase(){
  const body = document.getElementById('quizBody');
  const juz = currentQuiz.juz[currentQuiz.juzPointer];

  if(currentQuiz.phase === 'listening'){
    const playsLeft = Math.max(0, juz.maxPlays - currentQuiz.playsUsed);
    const canPlay = !!juz.audioUrl && playsLeft > 0;
    
    let titleText = juz.name || 'Istima · Tinglab tushunish';
    let subText = '';
    
    if(juz.partNum === 1){
      titleText = `1-qism · ${juz.audioIndex}-audio (${juz.audioIndex}/${juz.totalAudiosInPart || 6})`;
      subText = `${currentQuiz.idx + 1}-savol | Qolgan imkoniyat: ${fmtPlays(playsLeft)} / ${fmtPlays(juz.maxPlays)}`;
    } else if(juz.partNum === 2){
      titleText = `2-qism · Dialog audio`;
      const sNum = juz.startIdx + 1;
      const eNum = juz.endIdx + 1;
      subText = `${sNum}-${eNum}-savollar | Qolgan imkoniyat: ${fmtPlays(playsLeft)} / ${fmtPlays(juz.maxPlays)}`;
    } else if(juz.partNum === 3){
      titleText = `3-qism · Monolog / Ma'ruza audio`;
      const sNum = juz.startIdx + 1;
      const eNum = juz.endIdx + 1;
      subText = `${sNum}-${eNum}-savollar | Qolgan imkoniyat: ${fmtPlays(playsLeft)} / ${fmtPlays(juz.maxPlays)}`;
    } else {
      const currentQNumber = (juz.startIdx !== undefined ? juz.startIdx : currentQuiz.idx) + 1;
      subText = `${currentQNumber}-savol | Qolgan imkoniyat: ${fmtPlays(playsLeft)} / ${fmtPlays(juz.maxPlays)}`;
    }

    // 36 ta audio to'lqin balandliklari (Waveform bars)
    const waveHeights = [16, 24, 34, 44, 30, 18, 28, 42, 52, 38, 24, 18, 32, 46, 56, 42, 26, 18, 30, 44, 52, 38, 24, 18, 32, 46, 50, 36, 22, 16, 26, 40, 34, 22, 16, 12];
    const waveBarsHtml = waveHeights.map((h, i) => 
      `<div class="istima-wf-bar" id="istimaWfBar_${i}" style="height:${h}px;" data-idx="${i}"></div>`
    ).join('');

    body.innerHTML = `
      <div class="istima-card-container" id="istimaPlayerBox">
        
        <!-- Sarlavha va Qism ma'lumoti -->
        <div class="istima-card-head">
          <div class="istima-card-title">${titleText}</div>
          <div class="istima-card-sub" id="istimaCardSub">${subText}</div>
        </div>

        <!-- Waveform Progress Vizualizatori -->
        <div class="istima-wf-section">
          <div class="istima-wf-track" id="istimaWfTrack" onclick="onIstimaWfClick(event)" title="Audioni kerakli joyga o'tkazish">
            ${waveBarsHtml}
          </div>
          <div class="istima-wf-times">
            <span id="istimaCurTime">0:00</span>
            <span id="istimaDurTime">0:00</span>
          </div>
        </div>

        <!-- 5 ta boshqaruv tugmalari -->
        <div class="istima-ctrls-row">
          <!-- 1. Chap taraf: Faqat tezlik belgisi (1.0x, 1.25x, 1.5x, 0.75x) -->
          <button type="button" class="istima-speed-text-btn" id="istimaSpeedBtn" onclick="cycleIstimaSpeed()" title="Ijro tezligini o'zgartirish">
            <span id="istimaSpeedLabel">${(currentQuiz._audioSpeed || 1.0) === 1 ? '1.0x' : (currentQuiz._audioSpeed + 'x')}</span>
          </button>

          <!-- 2. 10 soniya orqaga (⟲ 10) -->
          <button type="button" class="istima-icon-btn" onclick="skipIstimaAudioSec(-10)" title="10 soniya orqaga" ${canPlay?'':'disabled'}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M1 4v6h6"/>
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
              <text x="12" y="15.8" font-size="7.5" font-weight="bold" fill="currentColor" stroke="none" text-anchor="middle">10</text>
            </svg>
          </button>

          <!-- 3. Markaziy Play/Pauza (Mavzu rangiga mos, yumshoq burchakli katta uchburchak) -->
          <button type="button" class="istima-center-play" id="istimaMainPlayBtn" onclick="toggleIstimaAudio()" ${canPlay?'':'disabled'} title="${canPlay ? 'Ijro etish' : 'Audio mavjud emas'}">
            <svg id="istimaPlayIcon" viewBox="0 0 24 24" fill="currentColor">
              <path d="M7.5 4.8c-1 .6-1.5 1.5-1.5 2.7v9c0 1.2.5 2.1 1.5 2.7 1 .6 2.1.5 3.1-.1l8-4.5c1-.6 1.5-1.5 1.5-2.6s-.5-2-1.5-2.6l-8-4.5c-1-.6-2.1-.7-3.1-.1z"/>
            </svg>
          </button>

          <!-- 4. 10 soniya oldinga (⟳ 10) -->
          <button type="button" class="istima-icon-btn" onclick="skipIstimaAudioSec(10)" title="10 soniya oldinga" ${canPlay?'':'disabled'}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M23 4v6h-6"/>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
              <text x="12" y="15.8" font-size="7.5" font-weight="bold" fill="currentColor" stroke="none" text-anchor="middle">10</text>
            </svg>
          </button>

          <!-- 5. O'ng taraf: Ovoz (Mute / Unmute) -->
          <button type="button" class="istima-icon-btn" id="istimaMuteBtn" onclick="toggleIstimaMute()" title="Ovozni o'chirish / yoqish">
            <svg id="istimaVolIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>
            </svg>
          </button>
        </div>

      </div>

      <audio id="istimaAudioEl" src="${juz.audioUrl||''}" preload="metadata" style="display:none;"></audio>
      
      <div class="q-nav-row" style="justify-content:center;margin-top:20px;">
        <button class="btn btn-primary" onclick="skipIstimaListening()" style="padding:13px 34px;font-size:14.5px;font-weight:700;border-radius:14px;box-shadow:none;">Savollarga o'tish →</button>
      </div>
      <div style="text-align:center;font-size:12px;color:var(--text-faint);font-weight:500;margin-top:12px;line-height:1.5;">Audioni tinglab bo'lgach savollar avtomatik boshlanadi — tayyor bo'lsangiz darhol savollarga o'tishingiz mumkin.</div>
    `;

    setupIstimaAudioEvents();
    return;
  }

  // phase === 'questions'
  const q = currentQuiz.questions[currentQuiz.idx];
  const isExpired = !!(q.expired || (q.timeLeft !== undefined && q.timeLeft <= 0));
  
  let sectionLabel = '';
  if(juz.partNum === 1){
    sectionLabel = `1-qism · ${juz.audioIndex}-audio (${juz.audioIndex}/${juz.totalAudiosInPart || 6})`;
  } else if(juz.partNum === 2){
    const localNum = currentQuiz.idx - juz.startIdx + 1;
    const localTotal = juz.endIdx - juz.startIdx + 1;
    sectionLabel = `2-qism · Savol ${localNum} / ${localTotal}`;
  } else if(juz.partNum === 3){
    const localNum = currentQuiz.idx - juz.startIdx + 1;
    const localTotal = juz.endIdx - juz.startIdx + 1;
    sectionLabel = `3-qism · Savol ${localNum} / ${localTotal}`;
  } else {
    const localNum = currentQuiz.idx - juz.startIdx + 1;
    const localTotal = juz.endIdx - juz.startIdx + 1;
    sectionLabel = `${juz.name} · Savol ${localNum} / ${localTotal}`;
  }
  const globalLabel = `Savol ${currentQuiz.idx + 1} / ${currentQuiz.questions.length}`;

  let html = `<div class="q-sub">${sectionLabel} · ${globalLabel}</div>`;
  html += `<div class="q-text">${q.q}</div>`;
  html += `<div class="options">` + q.opts.map((opt,oi)=>`
    <div class="option ${q.picked===oi?'selected':''} ${isExpired?'disabled is-expired':''}" onclick="pickOption(${oi})" ${isExpired?'aria-disabled="true"':''}>
      <span class="opt-circle">${ARABIC_OPT_LETTERS[oi]||''}</span><span class="opt-text">${opt}</span>
    </div>`).join('') + `</div>`;
  
  const isVeryLast = (currentQuiz.juzPointer === currentQuiz.juz.length - 1) && (currentQuiz.idx === juz.endIdx);
  let nextBtnText = 'Keyingi →';
  if(isVeryLast){
    nextBtnText = 'Yakunlash';
  } else if(currentQuiz.idx === juz.endIdx){
    if(juz.partNum === 1 && juz.audioIndex < (juz.totalAudiosInPart || 6)){
      nextBtnText = 'Keyingi audio →';
    } else {
      nextBtnText = 'Keyingi qism →';
    }
  }

  const canGoPrev = currentQuiz.idx > juz.startIdx;
  html += `<div class="q-nav-row">
      <button class="btn btn-outline" onclick="prevQ()" ${canGoPrev ? '' : 'disabled style="opacity:.4;cursor:default;"'}>← Oldingi</button>
      <button class="btn btn-primary" onclick="nextQ()">${nextBtnText}</button>
    </div>`;
  body.innerHTML = html;
  startQuestionTimer(); // har savol uchun qolgan vaqtdan davom etadi
}

/* Audio hodisalari va progress kuzatuvi */
function setupIstimaAudioEvents(){
  const audio = document.getElementById('istimaAudioEl');
  if(!audio) return;

  currentQuiz._audioSpeed = currentQuiz._audioSpeed || 1.0;
  audio.playbackRate = currentQuiz._audioSpeed;
  const speedLabel = document.getElementById('istimaSpeedLabel');
  if(speedLabel) speedLabel.textContent = currentQuiz._audioSpeed + 'x';

  audio.onloadedmetadata = function(){
    const durEl = document.getElementById('istimaDurTime');
    if(durEl && audio.duration && isFinite(audio.duration)){
      durEl.textContent = fmtAudioTime(audio.duration);
    }
  };

  audio.ontimeupdate = function(){
    const curEl = document.getElementById('istimaCurTime');
    const durEl = document.getElementById('istimaDurTime');

    if(curEl) curEl.textContent = fmtAudioTime(audio.currentTime);
    if(durEl && audio.duration && isFinite(audio.duration)){
      durEl.textContent = fmtAudioTime(audio.duration);
    }
    
    if(audio.duration && isFinite(audio.duration) && audio.duration > 0){
      const pct = audio.currentTime / audio.duration;
      const totalBars = 36;
      const activeCount = Math.floor(pct * totalBars);
      for(let i = 0; i < totalBars; i++){
        const bar = document.getElementById(`istimaWfBar_${i}`);
        if(bar){
          if(i <= activeCount){
            bar.classList.add('active');
          } else {
            bar.classList.remove('active');
          }
        }
      }
    }
  };

  audio.onplay = function(){
    const box = document.getElementById('istimaPlayerBox');
    if(box) box.classList.add('is-playing');
    const playIcon = document.getElementById('istimaPlayIcon');
    if(playIcon) playIcon.innerHTML = '<rect x="6" y="5" width="4.5" height="14" rx="2"/><rect x="13.5" y="5" width="4.5" height="14" rx="2"/>';
  };

  audio.onpause = function(){
    const box = document.getElementById('istimaPlayerBox');
    if(box) box.classList.remove('is-playing');
    const playIcon = document.getElementById('istimaPlayIcon');
    if(playIcon) playIcon.innerHTML = '<path d="M7.5 4.8c-1 .6-1.5 1.5-1.5 2.7v9c0 1.2.5 2.1 1.5 2.7 1 .6 2.1.5 3.1-.1l8-4.5c1-.6 1.5-1.5 1.5-2.6s-.5-2-1.5-2.6l-8-4.5c-1-.6-2.1-.7-3.1-.1z"/>';
  };

  audio.onended = function(){
    currentQuiz._activeAudioPlay = false;
    const box = document.getElementById('istimaPlayerBox');
    if(box) box.classList.remove('is-playing');
    const playIcon = document.getElementById('istimaPlayIcon');
    if(playIcon) playIcon.innerHTML = '<path d="M7.5 4.8c-1 .6-1.5 1.5-1.5 2.7v9c0 1.2.5 2.1 1.5 2.7 1 .6 2.1.5 3.1-.1l8-4.5c1-.6 1.5-1.5 1.5-2.6s-.5-2-1.5-2.6l-8-4.5c-1-.6-2.1-.7-3.1-.1z"/>';
    handleIstimaAudioEnded();
  };

  audio.onerror = function(){
    toast('⚠️ Audio faylni yuklashda xatolik yuz berdi');
  };
}

function onIstimaWfClick(e){
  const audio = document.getElementById('istimaAudioEl');
  const track = document.getElementById('istimaWfTrack');
  if(!audio || !track || !audio.duration || !isFinite(audio.duration)) return;
  const rect = track.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const pct = Math.max(0, Math.min(1, clickX / rect.width));
  audio.currentTime = pct * audio.duration;
  
  const totalBars = 36;
  const activeCount = Math.floor(pct * totalBars);
  for(let i = 0; i < totalBars; i++){
    const bar = document.getElementById(`istimaWfBar_${i}`);
    if(bar){
      if(i <= activeCount) bar.classList.add('active');
      else bar.classList.remove('active');
    }
  }
}

/* Audio ijro / pauza boshqaruvi */
function toggleIstimaAudio(){
  const juz = currentQuiz.juz[currentQuiz.juzPointer];
  const audio = document.getElementById('istimaAudioEl');
  if(!audio || !juz.audioUrl) return;

  if(!audio.paused){
    audio.pause();
    return;
  }

  // Agar yangi ijro boshlanayotgan bo'lsa (yoki audio tugab qayta boshlanayotgan bo'lsa)
  if(!currentQuiz._activeAudioPlay){
    const playsLeft = Math.max(0, juz.maxPlays - currentQuiz.playsUsed);
    if(playsLeft <= 0){
      toast("⚠️ Audioni qayta tinglash imkoniyati tugagan");
      return;
    }
    currentQuiz.playsUsed++;
    currentQuiz._activeAudioPlay = true;
    audio.currentTime = 0;
    
    // Qolgan imkoniyat va sarlavhani yangilash
    const newPlaysLeft = Math.max(0, juz.maxPlays - currentQuiz.playsUsed);
    const subEl = document.getElementById('istimaCardSub');
    if(subEl){
      let subText = '';
      if(juz.partNum === 1){
        subText = `${currentQuiz.idx + 1}-savol | Qolgan imkoniyat: ${fmtPlays(newPlaysLeft)} / ${fmtPlays(juz.maxPlays)}`;
      } else if(juz.partNum === 2 || juz.partNum === 3){
        const sNum = juz.startIdx + 1;
        const eNum = juz.endIdx + 1;
        subText = `${sNum}-${eNum}-savollar | Qolgan imkoniyat: ${fmtPlays(newPlaysLeft)} / ${fmtPlays(juz.maxPlays)}`;
      } else {
        const currentQNumber = (juz.startIdx !== undefined ? juz.startIdx : currentQuiz.idx) + 1;
        subText = `${currentQNumber}-savol | Qolgan imkoniyat: ${fmtPlays(newPlaysLeft)} / ${fmtPlays(juz.maxPlays)}`;
      }
      subEl.textContent = subText;
    }
  }

  audio.play().catch(()=>{
    currentQuiz._activeAudioPlay = false;
    toast('⚠️ Audio ijro etilmadi — URL manzilini tekshiring');
  });
}

function playIstimaAudio(){
  toggleIstimaAudio();
}

function restartIstimaAudio(){
  const audio = document.getElementById('istimaAudioEl');
  if(!audio) return;
  audio.currentTime = 0;
  if(audio.paused){
    toggleIstimaAudio();
  }
}

function onIstimaSeek(val){
  const audio = document.getElementById('istimaAudioEl');
  if(!audio || !audio.duration || !isFinite(audio.duration)) return;
  audio.currentTime = (Number(val) / 100) * audio.duration;
  const fillEl = document.getElementById('istimaTrackFill');
  if(fillEl) fillEl.style.width = val + '%';
  const curEl = document.getElementById('istimaCurTime');
  if(curEl) curEl.textContent = fmtAudioTime(audio.currentTime);
}

function skipIstimaAudioSec(seconds){
  const audio = document.getElementById('istimaAudioEl');
  if(!audio) return;
  const dur = (audio.duration && isFinite(audio.duration)) ? audio.duration : 99999;
  audio.currentTime = Math.max(0, Math.min(dur, audio.currentTime + seconds));
}

function cycleIstimaSpeed(){
  const audio = document.getElementById('istimaAudioEl');
  const speeds = [1.0, 1.25, 1.5, 0.75];
  const cur = currentQuiz._audioSpeed || 1.0;
  let idx = speeds.indexOf(cur);
  if(idx === -1) idx = 0;
  const next = speeds[(idx + 1) % speeds.length];
  currentQuiz._audioSpeed = next;
  if(audio) audio.playbackRate = next;
  const label = document.getElementById('istimaSpeedLabel');
  if(label) label.textContent = (next === 1 ? '1.0' : next) + 'x';
}

function toggleIstimaMute(){
  const audio = document.getElementById('istimaAudioEl');
  if(!audio) return;
  audio.muted = !audio.muted;
  const icon = document.getElementById('istimaVolIcon');
  const label = document.getElementById('istimaVolLabel');
  if(audio.muted){
    if(icon) icon.innerHTML = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>';
    if(label) label.textContent = 'Mute';
  } else {
    if(icon) icon.innerHTML = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>';
    if(label) label.textContent = '100%';
  }
}

/* Audio "tugadi" hodisasi: agar imkoni bo'lgan marta (maxPlays) ijro etilib bo'lgan bo'lsa,
   savollarga avtomatik o'tamiz. Agar hali qayta tinglash imkoni qolgan bo'lsa, foydalanuvchi
   o'zi qayta tinglashi yoki "Savollarga o'tish" tugmasini bosishi mumkin. */
function handleIstimaAudioEnded(){
  const juz = currentQuiz.juz[currentQuiz.juzPointer];
  const playsLeft = Math.max(0, juz.maxPlays - currentQuiz.playsUsed);
  const btn = document.getElementById('istimaMainPlayBtn');
  if(btn && playsLeft <= 0){
    btn.disabled = true;
    btn.title = "Imkoniyat tugadi";
  }
  if(playsLeft <= 0){
    advanceIstimaToQuestions();
  }
}

function skipIstimaListening(){ advanceIstimaToQuestions(); }

function advanceIstimaToQuestions(){
  if(!currentQuiz || currentQuiz.phase !== 'listening') return;
  const el = document.getElementById('istimaAudioEl');
  if(el){ el.onended = null; el.pause(); }
  currentQuiz.phase = 'questions';
  renderIstimaQuestionAnimated();
}

/* ================= Muhavara (Speaking) — mikrofon +  AI baholash ================= */
/* Oqim: har savol uchun avval "tayyorgarlik" (prepSecs, yozib olinmaydi), so'ng
   "yozib olish" (answerSecs, MediaRecorder orqali) fazasi bo'ladi. Yozib olish tugagach
   audio Supabase Edge Function'ga (evaluate-speaking) yuboriladi — u Groq Whisper bilan
   matnga o'giradi va Groq LLM bilan 0-5 ball + izoh qaytaradi. 6 savol tugagach umumiy
   ball (max 30, boshqa bo'limlar bilan bir xil shkala) backendga yoziladi. */
let muhavaraStream = null;
let muhavaraRecorder = null;
let muhavaraChunks = [];

function startMuhavaraQuiz(customLabel){
  // Har qism uchun bankdan tasodifiy MUHAVARA_MAX_Q_PER_PART tadan savol tanlanadi
  // (bank o'zi cheklanmagan — admin xohlagancha savol qo'shishi mumkin).
  const flat = [];
  MUHAVARA_PARTS.forEach(part=>{
    // Rotatsiya: shu qism uchun hamma savollar ko'rsatilib chiqmaguncha bitta savol
    // ikkinchi marta tanlanmaydi.
    const picked = rotationPickN('muhavara_'+part.id, MUHAVARA_QUESTIONS[part.id] || [], MUHAVARA_MAX_Q_PER_PART);
    rotationMarkSeen('muhavara_'+part.id, picked);
    picked.forEach(q=> flat.push({ ...q, part, score:null, feedback:null, transcript:null }));
  });
  if(flat.length === 0){
    if(retryWhenDataReady(()=> startMuhavaraQuiz(customLabel))) return;
    toast("⚠️ Muhavara bo'limi uchun hali savollar qo'shilmagan. Admin panelda qo'shing.");
    return;
  }
  const skillMeta = SKILLS.find(s=>s.id==='muhavara');
  currentQuiz = {
    skillId:'muhavara', topicId:null, type:'speaking',
    questions: flat, idx:0, phase:'prep',
    color: skillMeta.color, bg: skillMeta.bg, label: customLabel || skillMeta.name,
    startedAt: Date.now(),
  };
  const qTag = document.getElementById('quizTag');
  if(qTag){
    qTag.textContent = currentQuiz.label;
    qTag.style.background = skillMeta.bg;
    qTag.style.color = skillMeta.color;
  }
  document.getElementById('quizSide').style.display = 'none';
  showView('quiz');
  startMuhavaraPrep();
}
function startMuhavaraPrep(){
  currentQuiz.phase = 'prep';
  renderQuestion();
  startTimer(currentQuiz.questions[currentQuiz.idx].part.prepSecs, ()=> startMuhavaraRecording());
}
/* Foydalanuvchi tayyorgarlik vaqtini kutmasdan "Tayyorman" tugmasini bossa,
   qolgan sanoqni bekor qilib, darhol yozib olishni boshlaydi. */
function skipMuhavaraPrep(){
  if(!currentQuiz || currentQuiz.phase !== 'prep') return;
  clearInterval(timerInterval);
  startMuhavaraRecording();
}
async function startMuhavaraRecording(){
  try{
    const micPromise = navigator.mediaDevices.getUserMedia({audio:true});
    const timeoutPromise = new Promise((_,reject)=> setTimeout(()=> reject(new Error('TIMEOUT')), 8000));
    muhavaraStream = await Promise.race([micPromise, timeoutPromise]);
  }catch(e){
    const msg = (e && e.message === 'TIMEOUT')
      ? "🎤 Mikrofon javob bermadi (8 soniya kutildi). Telegram ilovasini yangilang yoki qayta ishga tushiring, so'ng qayta urinib ko'ring."
      : "🎤 Mikrofonga ruxsat berilmadi. Brauzer sozlamalaridan ruxsat bering va qayta urinib ko'ring.";
    toast(msg, 6000);
    currentQuiz.phase = 'prep';
    renderQuestion();
    return;
  }
  currentQuiz.phase = 'recording';
  renderQuestion();
  startMuhavaraLevelMeter();
  muhavaraChunks = [];
  muhavaraRecorder = new MediaRecorder(muhavaraStream);
  muhavaraRecorder.ondataavailable = e=>{ if(e.data.size>0) muhavaraChunks.push(e.data); };
  muhavaraRecorder.onstop = ()=>{
    stopMuhavaraLevelMeter();
    muhavaraStream.getTracks().forEach(t=>t.stop());
    muhavaraStream = null;
    const blob = new Blob(muhavaraChunks, { type: muhavaraRecorder.mimeType || 'audio/webm' });
    storeMuhavaraAnswer(blob);
  };
  muhavaraRecorder.start();
  startTimer(currentQuiz.questions[currentQuiz.idx].part.answerSecs, ()=> stopMuhavaraRecording());
}
/* Yozib olish paytida haqiqiy ovoz balandligini o'lchab, mic doirasi atrofidagi
   halqalarni jonlantiradi — foydalanuvchi mikrofon ishlayotganini ko'rib turadi. */
let muhavaraLevelAudioCtx = null;
let muhavaraLevelRaf = null;
function startMuhavaraLevelMeter(){
  try{
    muhavaraLevelAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = muhavaraLevelAudioCtx.createMediaStreamSource(muhavaraStream);
    const analyser = muhavaraLevelAudioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const startedAt = Date.now();
    function tick(){
      const ring1 = document.getElementById('micRing1');
      const ring2 = document.getElementById('micRing2');
      const ring3 = document.getElementById('micRing3');
      const glow1 = document.getElementById('micGlow1');
      const glow2 = document.getElementById('micGlow2');
      const glow3 = document.getElementById('micGlow3');
      if(!ring1 || !currentQuiz || currentQuiz.phase !== 'recording'){ muhavaraLevelRaf = null; return; }
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for(let i=0;i<data.length;i++){ const v=(data[i]-128)/128; sum += v*v; }
      const rms = Math.sqrt(sum/data.length);
      const level = Math.min(1, rms*5.5);
      // Doimiy, sokin "nafas olish" tempi (jim turgan paytda ham halqalar butunlay
      // to'xtab qolmasin — GIF'dagi kabi uzluksiz pulsatsiya), gapirganda esa haqiqiy
      // ovoz balandligi ustiga qo'shilib, halqalar sezilarli kattalashadi.
      const t = (Date.now() - startedAt) / 1000;
      const idle = 0.5 + 0.5 * Math.sin(t * 2.2);
      const boosted = Math.max(level, idle * 0.22);
      if(ring1){
        ring1.style.opacity = (0.75 + boosted*0.25).toFixed(2);
        ring1.style.transform = `scale(${(1 + boosted*0.08).toFixed(3)})`;
      }
      if(ring2){
        ring2.style.opacity = (0.65 + boosted*0.3).toFixed(2);
        ring2.style.transform = `scale(${(1 + boosted*0.14).toFixed(3)})`;
      }
      if(ring3){
        ring3.style.opacity = (0.5 + boosted*0.35).toFixed(2);
        ring3.style.transform = `scale(${(1 + boosted*0.2).toFixed(3)})`;
      }
      if(glow1){
        glow1.style.opacity = (0.4 + boosted*0.45).toFixed(2);
        glow1.style.transform = `scale(${(1 + boosted*0.18).toFixed(3)})`;
      }
      if(glow2){
        glow2.style.opacity = (0.3 + boosted*0.4).toFixed(2);
        glow2.style.transform = `scale(${(1 + boosted*0.28).toFixed(3)})`;
      }
      if(glow3){
        glow3.style.opacity = (0.2 + boosted*0.35).toFixed(2);
        glow3.style.transform = `scale(${(1 + boosted*0.42).toFixed(3)})`;
      }
      muhavaraLevelRaf = requestAnimationFrame(tick);
    }
    tick();
  }catch(e){ /* halqa ishlamasa ham yozib olishning o'ziga ta'sir qilmaydi */ }
}
function stopMuhavaraLevelMeter(){
  if(muhavaraLevelRaf){ cancelAnimationFrame(muhavaraLevelRaf); muhavaraLevelRaf = null; }
  if(muhavaraLevelAudioCtx){ try{ muhavaraLevelAudioCtx.close(); }catch(e){} muhavaraLevelAudioCtx = null; }
}
function stopMuhavaraRecording(){
  clearInterval(timerInterval);
  if(muhavaraRecorder && muhavaraRecorder.state !== 'inactive'){ muhavaraRecorder.stop(); }
}
function blobToBase64(blob){
  return new Promise((resolve,reject)=>{
    const reader = new FileReader();
    reader.onloadend = ()=> resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
/* Muhavara (So'zlashuv) — HAR BIR savolga ovozli javob berilgach AI'ga alohida
   so'rov yuborilmaydi: yozib olingan audio shu savol uchun saqlab qo'yiladi va
   navbatdagi savolga o'tiladi. Foydalanuvchi BARCHA savollarga javob berib
   tugatgandan so'ng, hammasi birgalikda YAGONA so'rov orqali AI'ga yuboriladi
   va baholanadi — bu tokenlarni tejaydi. */
async function storeMuhavaraAnswer(blob){
  const q = currentQuiz.questions[currentQuiz.idx];
  try{
    q.audioBase64 = await blobToBase64(blob);
    q.mimeType = blob.type || 'audio/webm';
  }catch(e){
    q.audioBase64 = '';
    q.mimeType = blob.type || 'audio/webm';
  }
  if(currentQuiz.idx < currentQuiz.questions.length-1){
    const frontCard = document.getElementById('quizStackFrontCard');
    if(frontCard){
      frontCard.classList.add('card-slide-out-left');
      setTimeout(()=>{
        currentQuiz.idx++;
        startMuhavaraPrep();
      }, 350);
    } else {
      currentQuiz.idx++;
      startMuhavaraPrep();
    }
  } else if(currentQuiz.isSpeakingDuel){
    evaluateAllSpeakingDuelAnswers();
  } else {
    evaluateAllMuhavaraAnswers();
  }
}
/* Barcha savollarga berilgan ovozli javoblar yig'ilgandan so'ng, ular BITTA
   so'rovda backendga (Supabase Edge Function "evaluate-speaking-batch")
   yuboriladi — u har bir javobni Groq AI'ga tekshirtirib, har biri uchun 0-5
   ball + izoh + transkript bilan javob qaytaradi. */
async function evaluateAllMuhavaraAnswers(){
  currentQuiz.phase = 'evaluating';
  renderQuestion();
  try{
    const answers = currentQuiz.questions.map(q => ({
      question_id: q.id, part_id: q.part.id, prompt: q.prompt,
      audio_base64: q.audioBase64 || '', mime_type: q.mimeType || 'audio/webm'
    }));
    const res = await fetch(`${SUPABASE_URL}/functions/v1/evaluate-speaking-batch`, {
      method:'POST', headers: authHeaders(),
      body: JSON.stringify({ answers })
    });
    const data = await res.json().catch(()=>null);
    const results = data && Array.isArray(data.results) ? data.results : null;
    if(!res.ok || !results){
      toast("⚠️ AI baholay olmadi: " + (data?.error || ('HTTP '+res.status)), 6000);
      currentQuiz.questions.forEach(q=>{ q.score = 0; q.feedback = "Texnik sabab bilan baholanmadi."; q.transcript = q.transcript || ''; });
    } else {
      currentQuiz.questions.forEach((q, i)=>{
        const r = results[i] || results.find(x => x.question_id === q.id) || {};
        q.score = Math.max(0, Math.min(5, typeof r.score === 'number' ? r.score : 0));
        q.feedback = r.feedback || '';
        q.transcript = r.transcript || '';
      });
    }
  }catch(e){
    toast("⚠️ Tarmoq xatosi: " + e.message, 6000);
    currentQuiz.questions.forEach(q=>{ q.score = 0; q.feedback = "Tarmoq xatosi tufayli baholanmadi."; q.transcript = q.transcript || ''; });
  }
  // Endi kerak emas — audioni xotirada saqlab turishning hojati yo'q
  currentQuiz.questions.forEach(q=>{ delete q.audioBase64; });
  finishMuhavaraQuiz();
}
function finishMuhavaraQuiz(){
  clearInterval(timerInterval);
  const totalScore = currentQuiz.questions.reduce((s,q)=> s+(q.score||0), 0);
  const maxScore = currentQuiz.questions.length * 5;
  const pct = Math.round((totalScore/maxScore)*100);

  const attemptId = 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const now = new Date();
  const dateStr = now.toLocaleDateString('uz-UZ', { day:'numeric', month:'short' });
  const timeStr = now.toLocaleTimeString('uz-UZ', { hour:'2-digit', minute:'2-digit' });
  const sMeta = SKILL_META['muhavara'] || {section:'So\'zlashuv', icon:'🎙', color:'var(--muhavara)', bg:'var(--muhavara-bg)'};

  const isMock = !!(currentQuiz && (currentQuiz.mockId || currentQuiz.type === 'mock'));
  const attemptSnapshot = {
    id: attemptId,
    skillId: 'muhavara',
    topicId: null,
    topic: isMock ? "So'zlashuv (Mock)" : (currentQuiz.label || "So'zlashuv"),
    label: isMock ? "So'zlashuv (Mock)" : (currentQuiz.label || "So'zlashuv"),
    type: isMock ? 'mock' : 'speaking',
    date: dateStr,
    time: timeStr,
    dateGroup: '7kun',
    correct: totalScore,
    total: maxScore,
    pct,
    xp: totalScore,
    level: getCEFRLevel(pct),
    icon: sMeta.icon || '🎙',
    color: sMeta.color,
    bg: sMeta.bg,
    questions: JSON.parse(JSON.stringify(currentQuiz.questions || [])),
    createdAt: now.toISOString()
  };

  saveFullAttemptSnapshot(attemptSnapshot);
  HISTORY_DATA.unshift(attemptSnapshot);
  renderHistoryStats();
  renderHistoryList();

  if(TELEGRAM_PROFILE.rawId){
    submitQuizResultToBackend({ skillId:'muhavara', topicId:null, topicName: currentQuiz.label, correct: totalScore, total: maxScore });
  }
  if(FULL_EXAM && FULL_EXAM.active){
    FULL_EXAM.results.muhavara = { correct: totalScore, total: maxScore, label: currentQuiz.label };
    advanceFullExam();
    return;
  }
  renderMuhavaraSummary(totalScore, maxScore);
}
function renderMuhavaraSummary(totalScore, maxScore){
  const quizHeadEl = document.getElementById('quizHead');
  if(quizHeadEl){
    quizHeadEl.style.display = 'none';
    quizHeadEl.classList.remove('quiz-head-collapsed');
  }
  const capsulesContainer = document.getElementById('quizCapsulesContainer');
  if(capsulesContainer) capsulesContainer.style.display = 'none';
  document.body.classList.remove('speaking-recording-active');
  document.body.classList.remove('speaking-quiz-active');
  const sideEl = document.getElementById('quizSide');
  if(sideEl) sideEl.style.display = 'none';
  const timerEl = document.getElementById('quizTimer');
  if(timerEl){ timerEl.innerHTML = ''; timerEl.style.display = 'none'; }
  const fontCtrl = document.getElementById('examFontCtrl');
  if(fontCtrl) fontCtrl.style.display = 'none';
  const pct = Math.round((totalScore/maxScore)*100);
  const body = document.getElementById('quizBody');
  body.innerHTML = `
    <div class="prompt-box" style="text-align:center;">
      <div class="lbl">Natija</div>
      <div style="font-size:34px;font-weight:600;margin:8px 0;"><span class="num-target" data-target="${totalScore}">0</span> / <span class="num-target" data-target="${maxScore}">0</span> ball</div>
      <div style="color:var(--text-faint);font-size:13px;"><span class="num-target" data-target="${pct}" data-suffix="%">0%</span> · ${getCEFRLevel(pct) && getCEFRLevel(pct).length <= 3 ? getCEFRLevel(pct) + ' daraja' : `<span style="font-size:12px;color:var(--text-dim);font-weight:600;">${getCEFRLevel(pct)}</span>`} · (6 ta savol, har biri 0–5 ball)</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:10px;margin-top:16px;">
      ${currentQuiz.questions.map((q,i)=>`
        <div class="topic-row" style="align-items:flex-start;">
          <div style="flex:1;">
            <div class="t-name" style="font-size:13px;font-weight:700;color:var(--indigo-700);">${q.part.name} · Savol ${i+1}</div>
            <div dir="rtl" style="font-size:15px;margin:6px 0;">${escapeHtml(q.prompt)}</div>
            ${q.transcript?`<div class="t-meta" style="margin-top:4px;"><b>🎙 Sizning javobingiz:</b> "${escapeHtml(q.transcript)}"</div>`:''}
            ${q.feedback?`<div class="t-meta" style="margin-top:4px;color:var(--text-dim);"><b>💡 AI izohi:</b> ${escapeHtml(q.feedback)}</div>`:''}
          </div>
          <div style="font-weight:700;font-size:16px;flex-shrink:0;color:var(--text);">${q.score ?? 0} / 5 ball</div>
        </div>
      `).join('')}
    </div>
    <button class="btn btn-primary btn-block" style="margin-top:20px;" onclick="showView('dashboard')">Bosh sahifaga qaytish</button>
  `;
  runEntranceAnimations(body, true);
  if(pct >= 25) fireSideConfetti({ mode: 'celebration' });
}
function renderMuhavaraPhase(){
  clearQuestionTimer();
  const body = document.getElementById('quizBody');
  const q = currentQuiz.questions[currentQuiz.idx];
  const qNum = currentQuiz.idx + 1;

  if(currentQuiz.phase==='prep'){
    const quizHeadEl = document.getElementById('quizHead');
    if(quizHeadEl) quizHeadEl.classList.remove('quiz-head-collapsed');
    document.body.classList.remove('speaking-recording-active');

    const prepSecs = q.part.prepSecs || 60;
    const prepMin = Math.floor(prepSecs / 60);
    const prepRemSec = prepSecs % 60;
    const prepFormatted = String(prepMin).padStart(2, '0') + ':' + String(prepRemSec).padStart(2, '0');

    body.innerHTML = `
      <div class="q-sub" style="text-align:center;font-size:14px;font-weight:600;color:var(--text-faint);margin-bottom:14px;margin-top:0px;">Tayyorgarlik vaqti</div>
      <div style="display:flex;justify-content:center;margin:16px 0 14px 0;">
        <div id="muhavaraBigTimer" style="font-size:46px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--text);letter-spacing:1px;line-height:1;display:inline-flex;align-items:center;justify-content:center;min-height:50px;margin-top:-11px;">${prepFormatted}</div>
      </div>
      <div class="quiz-card-stack" id="quizCardStackContainer">
        <div class="quiz-card-back quiz-card-back-2"></div>
        <div class="quiz-card-back quiz-card-back-1"></div>
        <div class="quiz-card-front" id="quizStackFrontCard">
          <div class="quiz-card-label">Savol ${qNum}</div>
          <div class="quiz-card-prompt">${escapeHtml(q.prompt || '')}</div>
        </div>
      </div>
      <div class="mic-hint" style="text-align:center;margin-top:16px;font-size:13.5px;color:var(--text-faint);width:160px;height:16px;padding-top:0px;margin-left:auto;margin-right:auto;">Tayyorlaning, yozib olish tez orada boshlanadi.</div>
      <div style="display:flex;justify-content:center;margin-top:60px;">
        <button class="btn btn-primary" style="width:120px;height:40px;border-radius:30px;padding:0;display:inline-flex;align-items:center;justify-content:center;font-weight:600;font-size:14px;border:1.5px solid #f97316;background-color:#f97316;background:#f97316;color:#ffffff;" onclick="skipMuhavaraPrep()">Tayyorman</button>
      </div>
    `;
    return;
  }
  if(currentQuiz.phase==='recording'){
    const quizHeadEl = document.getElementById('quizHead');
    if(quizHeadEl) quizHeadEl.classList.add('quiz-head-collapsed');
    document.body.classList.add('speaking-recording-active');

    const ansSecs = q.part.answerSecs || 60;
    const ansMin = Math.floor(ansSecs / 60);
    const ansRemSec = ansSecs % 60;
    const ansFormatted = String(ansMin).padStart(2, '0') + ':' + String(ansRemSec).padStart(2, '0');

    body.innerHTML = `
      <div class="muhavara-recording-view">
        <div class="q-sub" style="text-align:center;font-size:14px;font-weight:600;color:var(--text-faint);margin-bottom:14px;margin-top:-6px;">Gapirish vaqti</div>
        <div style="display:flex;justify-content:center;margin:16px 0 14px 0;">
          <div id="muhavaraRecTimer" style="font-size:46px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--red,#EF4444);letter-spacing:1px;line-height:1;display:inline-flex;align-items:center;justify-content:center;min-height:50px;margin-top:-11px;">${ansFormatted}</div>
        </div>
        <div class="quiz-card-stack" id="quizCardStackContainer">
          <div class="quiz-card-back quiz-card-back-2"></div>
          <div class="quiz-card-back quiz-card-back-1"></div>
          <div class="quiz-card-front" id="quizStackFrontCard">
            <div class="quiz-card-label">Savol ${qNum}</div>
            <div class="quiz-card-prompt">${escapeHtml(q.prompt || '')}</div>
          </div>
        </div>
        <div class="mic-wrap" style="margin-top:14px;">
          <div class="mic-circle-wrap recording">
            <div class="mic-glow mic-glow3" id="micGlow3"></div>
            <div class="mic-glow mic-glow2" id="micGlow2"></div>
            <div class="mic-glow mic-glow1" id="micGlow1"></div>
            <div class="mic-ring mic-ring3" id="micRing3"></div>
            <div class="mic-ring mic-ring2" id="micRing2"></div>
            <div class="mic-ring mic-ring1" id="micRing1"></div>
            <div class="mic-circle recording" id="micCircle">
              <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="2.5" width="6" height="11.5" rx="3"></rect>
                <path d="M5.5 10a6.5 6.5 0 0 0 13 0"></path>
                <line x1="12" y1="16.5" x2="12" y2="20.5"></line>
                <line x1="8.5" y1="20.5" x2="15.5" y2="20.5"></line>
              </svg>
            </div>
          </div>
          <button class="btn btn-outline" style="margin-top:38px;min-width:160px;" onclick="stopMuhavaraRecording()">Yakunlash</button>
        </div>
      </div>
    `;
    return;
  }
  body.innerHTML = `
    <div class="q-sub">Barcha javoblar AI baholamoqda</div>
    <div class="prompt-box" style="text-align:center;">
      <div class="lbl">Barcha javoblaringiz AI'ga yuborildi</div>
      <div style="margin-top:14px;">⏳ Baholanmoqda, biroz kuting...</div>
    </div>
  `;
}

function submitWriting(){
  const cur = currentQuiz.questions[currentQuiz.idx];
  const text = (cur.text||'').trim();
  if(containsNonArabicLetters(text)){
    toast("⚠️ Faqat arab alifbosida yozing! Lotin yoki kirill harflari qabul qilinmaydi.", 4000);
    return;
  }
  const words = countArabicWords(text);
  const unlockTarget = cur.part.unlockWords || Math.round(cur.part.minWords / 2);
  if(words < unlockTarget){
    toast(`⚠️ Kamida ${unlockTarget} ta so'z bo'lganda yuborish tugmasi ochiladi (hozir: ${words} ta)`, 4500);
    return;
  }
  storeWritingAnswer(text);
}
/* Vaqt tugaganda (timer 0'ga yetganda) joriy qismni tekshiradi:
   Agar minimal ruxsat etilgan so'zdan (unlockWords: 50/75/100) kam bo'lsa yoki noarabiy harflar bo'lsa,
   AI ga so'rov YUBORILMAYDI (0 token sarflanadi), avtomatik 0 ball beriladi va
   "Matn minimal hajmga yetmadi" deb keyingi qismga o'tkaziladi. */
function forceSubmitWriting(){
  if(!currentQuiz || currentQuiz.phase !== 'writing') return;
  const cur = currentQuiz.questions[currentQuiz.idx];
  const text = (cur.text||'').trim();
  storeWritingAnswer(text, true);
}
/* Kitaba (Yozish) — HAR BIR qism yozib bo'lingach AI'ga alohida so'rov
   yuborilmaydi: matn faqat shu qism uchun saqlab qo'yiladi va navbatdagi
   qismga o'tiladi. Foydalanuvchi BARCHA (3 ta) qismni yozib tugatgandan
   so'ng, hammasi birgalikda YAGONA so'rov orqali AI'ga yuboriladi va
   baholanadi — bu tokenlarni tejaydi. */
function storeWritingAnswer(text, isTimeUp = false){
  clearInterval(timerInterval);
  const cur = currentQuiz.questions[currentQuiz.idx];
  cur.text = text;

  const words = countArabicWords(text);
  const hasForeign = containsNonArabicLetters(text);
  const unlockTarget = cur.part.unlockWords || Math.round(cur.part.minWords / 2);

  // Zero-token guard: Agar matn minimal ochilish hajmiga yetmagan bo'lsa,
  // bu qism umuman AI'ga yuborilmaydi (keyinroq ham, yakuniy so'rovda ham) —
  // avtomatik 0 ball beriladi.
  if(words < unlockTarget || hasForeign){
    cur.score = 0;
    cur.feedback = hasForeign
      ? "Matnda lotin yoki kirill harflari ishlatilgani sababli AI tomonidan baholanmadi (0 ball)."
      : (isTimeUp
          ? `Vaqt tugadi. Matn minimal hajmga (${unlockTarget} ta so'z) yetmagani uchun 0 ball berildi.`
          : `Matn minimal hajmga (${unlockTarget} ta so'z) yetmagani uchun 0 ball berildi.`);
    cur.criteria = null;
    cur.corrected = '';
    cur.skipEvaluation = true;
  } else {
    cur.skipEvaluation = false;
  }

  if(currentQuiz.idx < currentQuiz.questions.length-1){
    currentQuiz.idx++;
    currentQuiz.phase = 'writing';
    renderQuestion();
    startTimer(currentQuiz.questions[currentQuiz.idx].part.seconds, ()=> forceSubmitWriting());
  } else {
    evaluateAllWritingAnswers();
  }
}
/* Barcha (3 ta) Kitaba qismi yozib bo'lingach, ular BITTA so'rovda backendga
   (Supabase Edge Function "evaluate-writing-batch") yuboriladi — u har bir
   qism matnini Groq AI'ga tekshirtirib, har biri uchun 0-10 ball + 6 mezon
   (punktuatsiya, imlo, lug'at, matn tuzilishi, fikrlarning aniqligi, mavzuni
   ochish) + izoh va tuzatilgan matn bilan javob qaytaradi. Minimal hajmga
   yetmagan (0 ball avtomatik berilgan) qismlar bu so'rovga umuman
   qo'shilmaydi — token behuda sarflanmasin uchun. */
async function evaluateAllWritingAnswers(){
  currentQuiz.phase = 'evaluating';
  renderQuestion();
  const toEvaluate = currentQuiz.questions.filter(q => !q.skipEvaluation);
  if(toEvaluate.length === 0){
    finishKitabaExam();
    return;
  }
  try{
    const answers = toEvaluate.map(q => ({
      part_id: q.part.id,
      text: q.text,
      prompt: q.topic.topicAr,
      min_words: q.part.unlockWords || Math.round(q.part.minWords / 2)
    }));
    const res = await fetch(`${SUPABASE_URL}/functions/v1/evaluate-writing-batch`, {
      method:'POST', headers: authHeaders(),
      body: JSON.stringify({ answers })
    });
    const data = await res.json().catch(()=>null);
    const results = data && Array.isArray(data.results) ? data.results : null;
    if(!res.ok || !results){
      toast("⚠️ AI baholay olmadi: " + (data?.error || ('HTTP '+res.status)), 6000);
      toEvaluate.forEach(q=>{ q.score = 0; q.feedback = "Texnik sabab bilan baholanmadi."; q.criteria = null; q.corrected = ''; });
    } else {
      toEvaluate.forEach((q, i)=>{
        const r = results[i] || results.find(x => x.part_id === q.part.id) || {};
        q.score = Math.max(0, Math.min(10, typeof r.score === 'number' ? r.score : 0));
        q.feedback = r.feedback || '';
        q.criteria = r.criteria || null;
        q.corrected = r.corrected_text || '';
      });
    }
  }catch(e){
    toast("⚠️ Tarmoq xatosi: " + e.message, 6000);
    toEvaluate.forEach(q=>{ q.score = 0; q.feedback = "Tarmoq xatosi tufayli baholanmadi."; q.criteria = null; q.corrected = ''; });
  }
  finishKitabaExam();
}
function finishKitabaExam(){
  clearInterval(timerInterval);
  currentQuiz.phase = 'done';
  const totalScore = currentQuiz.questions.reduce((s,q)=> s+(q.score||0), 0);
  const maxScore = currentQuiz.questions.length * 10;
  const pct = Math.round((totalScore/maxScore)*100);
  const totalScoreDisplay = Math.round(totalScore*10)/10;

  const attemptId = 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const now = new Date();
  const dateStr = now.toLocaleDateString('uz-UZ', { day:'numeric', month:'short' });
  const timeStr = now.toLocaleTimeString('uz-UZ', { hour:'2-digit', minute:'2-digit' });
  const sMeta = SKILL_META['kitaba'] || {section:'Yozish', icon:'✍️', color:'var(--kitaba)', bg:'var(--kitaba-bg)'};

  const isMock = !!(currentQuiz && (currentQuiz.mockId || currentQuiz.type === 'mock'));
  const attemptSnapshot = {
    id: attemptId,
    skillId: 'kitaba',
    topicId: null,
    topic: isMock ? "Yozish (Mock)" : (currentQuiz.label || "Yozish"),
    label: isMock ? "Yozish (Mock)" : (currentQuiz.label || "Yozish"),
    type: isMock ? 'mock' : 'writing',
    date: dateStr,
    time: timeStr,
    dateGroup: '7kun',
    correct: totalScoreDisplay,
    total: maxScore,
    pct,
    xp: Math.round(totalScore),
    level: getCEFRLevel(pct),
    icon: sMeta.icon || '✍️',
    color: sMeta.color,
    bg: sMeta.bg,
    questions: JSON.parse(JSON.stringify(currentQuiz.questions || [])),
    createdAt: now.toISOString()
  };

  saveFullAttemptSnapshot(attemptSnapshot);
  HISTORY_DATA.unshift(attemptSnapshot);
  renderHistoryStats();
  renderHistoryList();

  if(TELEGRAM_PROFILE.rawId){
    submitQuizResultToBackend({ skillId:'kitaba', topicId:null, topicName: currentQuiz.label, correct: Math.round(totalScore), total: maxScore });
  }
  if(FULL_EXAM && FULL_EXAM.active){
    FULL_EXAM.results.kitaba = { correct: totalScore, total: maxScore, label: currentQuiz.label };
    advanceFullExam();
    return;
  }
  renderQuestion();
}
function renderKitabaSummary(){
  const quizHeadEl = document.getElementById('quizHead');
  if(quizHeadEl){
    quizHeadEl.style.display = 'none';
    quizHeadEl.classList.remove('quiz-head-collapsed');
  }
  const capsulesContainer = document.getElementById('quizCapsulesContainer');
  if(capsulesContainer) capsulesContainer.style.display = 'none';
  const sideEl = document.getElementById('quizSide');
  if(sideEl) sideEl.style.display = 'none';
  const timerEl = document.getElementById('quizTimer');
  if(timerEl){ timerEl.innerHTML = ''; timerEl.style.display = 'none'; }
  const fontCtrl = document.getElementById('examFontCtrl');
  if(fontCtrl) fontCtrl.style.display = 'none';
  const totalScore = currentQuiz.questions.reduce((s,q)=> s+(q.score||0), 0);
  const maxScore = currentQuiz.questions.length * 10;
  const pct = Math.round((totalScore/maxScore)*100);
  const totalScoreDisplay = Math.round(totalScore*10)/10;
  const body = document.getElementById('quizBody');
  body.innerHTML = `
    <div class="prompt-box" style="text-align:center;">
      <div class="lbl">Natija</div>
      <div style="font-size:34px;font-weight:600;margin:8px 0;"><span class="num-target" data-target="${totalScoreDisplay}" data-decimals="${totalScoreDisplay % 1 !== 0 ? 1 : 0}">0</span> / <span class="num-target" data-target="${maxScore}">0</span> ball</div>
      <div style="color:var(--text-faint);font-size:13px;"><span class="num-target" data-target="${pct}" data-suffix="%">0%</span> · ${getCEFRLevel(pct) && getCEFRLevel(pct).length <= 3 ? getCEFRLevel(pct) + ' daraja' : `<span style="font-size:12px;color:var(--text-dim);font-weight:600;">${getCEFRLevel(pct)}</span>`} · (3 ta topshiriq, har biri 0–10 ball)</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:12px;margin-top:16px;">
      ${currentQuiz.questions.map(q=>`
        <div class="topic-row" style="flex-direction:column;align-items:stretch;gap:8px;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div class="t-name" style="font-size:13px;font-weight:700;color:var(--indigo-700);">${q.part.name}</div>
            <div style="font-weight:700;font-size:16px;color:var(--text);">${q.score ?? 0} / 10 ball</div>
          </div>
          <div dir="rtl" style="font-family:var(--font-ar);font-size:15px;background:var(--card-alt);padding:8px 12px;border-radius:10px;">${escapeHtml(q.topic.topicAr)}</div>
          ${q.text ? `
          <div style="margin-top:4px;">
            <div style="font-size:12px;font-weight:700;color:var(--text-faint);margin-bottom:4px;">Sizning yozgan matningiz:</div>
            <div dir="rtl" style="font-family:var(--font-ar);font-size:14px;line-height:1.75;padding:8px 12px;border-radius:10px;background:var(--card-alt);border:1px solid var(--border);color:var(--text);">${escapeHtml(q.text)}</div>
          </div>` : ''}
          ${q.criteria ? `
          <div style="display:flex;flex-direction:column;gap:4px;margin-top:2px;">
            ${Object.entries(q.criteria).map(([k,v])=>`<div style="display:flex;justify-content:space-between;font-size:12.5px;font-weight:600;"><span>${escapeHtml(k)}</span><span>${escapeHtml(String(v))}</span></div>`).join('')}
          </div>` : ''}
          ${q.feedback ? `<div class="t-meta" style="color:var(--text-dim);margin-top:4px;"><b>💡 AI izohi:</b> ${escapeHtml(q.feedback)}</div>` : ''}
          ${q.corrected ? `
          <div style="margin-top:6px;">
            <div class="t-name" style="font-size:12px;color:var(--green);">Tavsiya etilgan tuzatilgan matn</div>
            <div dir="rtl" style="margin-top:4px;font-family:var(--font-ar);font-size:14px;line-height:1.8;padding:8px 12px;border-radius:10px;background:var(--green-bg);border:1px solid rgba(18,167,104,0.25);color:var(--text);">${escapeHtml(q.corrected)}</div>
          </div>` : ''}
        </div>
      `).join('')}
    </div>
    <div style="display:flex;gap:10px;margin-top:20px;">
      <button class="btn btn-outline" style="flex:1;" onclick="reviseWriting()">Qayta boshlash</button>
      <button class="btn btn-primary" style="flex:1;" onclick="showView('dashboard')">Bosh sahifaga qaytish</button>
    </div>
  `;
  runEntranceAnimations(body, true);
  if(pct >= 25) fireSideConfetti({ mode: 'celebration' });
}
/* Natijadan keyin "Qayta boshlash" bosilsa — 3 qism uchun yangi (tasodifiy)
   mavzular bilan butun imtihon qaytadan boshlanadi. */
function reviseWriting(){
  startKitabaExam();
}

/* ---------------- Finish / results ---------------- */
function getCEFRLevel(pct, answeredCount = 1){
  if(answeredCount === 0 || pct < 25) return "Daraja aniqlanmadi — ko'proq mashq qiling, keyingi safar albatta chiqadi!";
  if(pct>=90) return 'C2';
  if(pct>=75) return 'C1';
  if(pct>=60) return 'B2';
  if(pct>=45) return 'B1';
  if(pct>=25) return 'A2';
  return "Daraja aniqlanmadi — ko'proq mashq qiling, keyingi safar albatta chiqadi!";
}
function finishQuiz(force = false){
  if(!currentQuiz || !currentQuiz.questions){ showView('attanal'); return; }
  
  // Agar foydalanuvchi barcha savollarni belgilamagan bo'lsa va majburiy yakunlash (force) bo'lmasa — ogohlantirish oynasini chiqaramiz
  if(!force){
    const unansweredCount = currentQuiz.questions.filter(q => q.picked === null || q.picked === undefined).length;
    if(unansweredCount > 0){
      document.getElementById('modalTitle').textContent = "Testni yakunlash";
      document.getElementById('modalBody').innerHTML = `
        <div style="text-align:center;padding:10px 4px 6px;">
          <div style="font-size:38px;margin-bottom:12px;">⚠️</div>
          <div style="font-size:15.5px;font-weight:700;color:var(--text);margin-bottom:8px;">Sizda ${unansweredCount} ta belgilanmagan savol qolgan!</div>
          <p style="font-size:13.5px;color:var(--text-dim);line-height:1.55;margin:0 0 20px;">Haqiqatdan ham testni hozir yakunlashni xohlaysizmi? Belgilanmagan savollar xato deb hisoblanadi.</p>
          <div style="display:flex;gap:10px;">
            <button class="btn btn-outline" style="flex:1;padding:12px;" onclick="document.getElementById('modalOverlay').classList.remove('show')">Davom etish</button>
            <button class="btn btn-primary" style="flex:1;padding:12px;background:var(--red);border-color:var(--red);" onclick="document.getElementById('modalOverlay').classList.remove('show');finishQuiz(true)">Ha, yakunlash</button>
          </div>
        </div>
      `;
      document.getElementById('modalOverlay').classList.add('show');
      return;
    }
  }

  // Duel — oddiy imtihon oqimidan butunlay ajratilgan: XP/tarix/reyting'ga
  // yozilmaydi, faqat ikkala tomonning duel natijasi solishtiriladi.
  if(currentQuiz.isDuel){ handleDuelFinish(); return; }

  clearInterval(timerInterval); clearInterval(mcqTimerInterval);
  window.lastCompletedQuiz = { ...currentQuiz };
  const total = currentQuiz.questions.length;
  const correct = currentQuiz.questions.filter(q=>q.picked===q.a).length;
  const wrong = total - correct;
  const pct = Math.round((correct/total)*100);
  const xp = correct; // har bir to'g'ri javob uchun 1 XP

  // Rotatsiya: "Grammatika mahorati" (real At-Tanal imtihoni, mavzusiz, marafon emas)
  // uchun har bir savolning natijasini yozib qo'yamiz — to'g'ri javob berilgan savol
  // qolgan savollar aylanib chiqmaguncha qayta tushmaydi, xato javob berilgani esa
  // darhol qayta faollashadi.
  if(currentQuiz.skillId === 'grammatika' && !currentQuiz.topicId && !currentQuiz.isMarathon){
    currentQuiz.questions.forEach(q=>{
      rotationMarkResult('grammar_exam_'+(q.category||'nahv'), q, q.picked===q.a);
    });
  }

  // Xato qilingan savollarni to'liq tahlil uchun ajratib olamiz
  const mistakeItems = (currentQuiz.questions || []).map((q, idx) => {
    const isCorrect = q.picked === q.a;
    if(isCorrect) return null;
    const isUnanswered = (q.picked === null || q.picked === undefined);
    const pickedText = isUnanswered ? "(Javob belgilanmagan)" : (q.opts && q.opts[q.picked] ? q.opts[q.picked] : String(q.picked));
    const correctText = (q.opts && q.opts[q.a] ? q.opts[q.a] : String(q.a));
    return {
      qIndex: idx,
      q: q.q,
      picked: pickedText,
      pickedIdx: q.picked,
      correct: correctText,
      correctIdx: q.a,
      opts: q.opts,
      exp: q.exp || '',
      category: q.category || '',
      passage: q.passage || '',
      skillId: currentQuiz.skillId,
      topicId: currentQuiz.topicId,
      topicName: currentQuiz.label || currentQuiz.skillId
    };
  }).filter(Boolean);

  const elapsedSeconds = Math.round((Date.now() - (currentQuiz.startedAt || Date.now())) / 1000);
  const elMin = Math.floor(elapsedSeconds / 60), elSec = elapsedSeconds % 60;
  const elapsedFormatted = String(elMin).padStart(2, '0') + ':' + String(elSec).padStart(2, '0');

  // Savollarning to'liq snapshotini nusxalaymiz
  const fullQuestionsSnapshot = JSON.parse(JSON.stringify(currentQuiz.questions || []));

  // Attempt ID yaratib, to'liq urinish va savollarni xotirada saqlaymiz
  const attemptId = 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const now = new Date();
  const dateStr = now.toLocaleDateString('uz-UZ', { day:'numeric', month:'short' });
  const timeStr = now.toLocaleTimeString('uz-UZ', { hour:'2-digit', minute:'2-digit' });
  const sMeta = SKILL_META[currentQuiz.skillId] || {section:currentQuiz.skillId, icon:'📘', color:'var(--grammatika)', bg:'var(--grammatika-bg)'};

  const isMock = !!(currentQuiz && (currentQuiz.mockId || currentQuiz.type === 'mock'));
  const isSkillExam = !isMock && !currentQuiz.topicId;
  const answeredCount = currentQuiz.questions.filter(q => q.picked !== null && q.picked !== undefined).length;
  const calculatedLevel = isSkillExam ? getCEFRLevel(pct, answeredCount) : null;

  const attemptSnapshot = {
    id: attemptId,
    skillId: currentQuiz.skillId,
    topicId: currentQuiz.topicId || null,
    topic: currentQuiz.label ? `${sMeta.section} — ${currentQuiz.label}` : sMeta.section,
    label: currentQuiz.label || sMeta.section,
    mockId: currentQuiz.mockId || null,
    type: currentQuiz.type || (currentQuiz.mockId ? 'mock' : 'quiz'),
    date: dateStr,
    time: timeStr,
    dateGroup: '7kun',
    correct,
    total,
    wrong,
    pct,
    xp,
    level: calculatedLevel,
    elapsed: elapsedFormatted,
    icon: sMeta.icon,
    color: sMeta.color,
    bg: sMeta.bg,
    questions: fullQuestionsSnapshot,
    mistakes: mistakeItems,
    createdAt: now.toISOString()
  };

  saveFullAttemptSnapshot(attemptSnapshot);
  saveMistakesForAttempt(attemptId, mistakeItems);
  if(currentQuiz.topicId) saveMistakesForAttempt('topic_' + currentQuiz.topicId, mistakeItems);
  saveMistakesForAttempt('skill_' + currentQuiz.skillId, mistakeItems);
  if(currentQuiz.label) saveMistakesForAttempt(currentQuiz.label, mistakeItems);

  // Tarix ro'yxatiga lokal yozuv qo'shamiz
  HISTORY_DATA.unshift(attemptSnapshot);
  renderHistoryStats();
  renderHistoryList();
  renderGrammarHistory();

  // Xatolarim bo'limiga ham qo'shamiz
  if(mistakeItems.length > 0){
    if(!Array.isArray(window.USER_ERRORS_LIVE)) window.USER_ERRORS_LIVE = [];
    mistakeItems.forEach(m => {
      window.USER_ERRORS_LIVE.unshift({
        id: 'err_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        skill_id: currentQuiz.skillId,
        topic_name: currentQuiz.label || currentQuiz.skillId,
        question: m.q,
        picked_answer: m.picked,
        correct_answer: m.correct,
        explanation: m.exp,
        created_at: new Date().toISOString()
      });
    });
    applyLiveErrors();
  }

  // Natijani backendga yuborish (foydalanuvchi Telegram orqali autentifikatsiyadan o'tgan bo'lsa)
  if(TELEGRAM_PROFILE.rawId){
    submitQuizResultToBackend({
      skillId: currentQuiz.skillId,
      topicId: currentQuiz.topicId,
      topicName: currentQuiz.label,
      correct, total,
      // MUHIM: shu bayroq backendga (quiz_attempts.is_mock) yoziladi — Dashboard
      // "MOCK TESTLAR" kartasi endi mock nomida "mock" so'zi bor-yo'qligiga
      // qarab taxmin qilmasdan, aynan shu ustunga qarab ishonchli aniqlaydi.
      isMock: !!(currentQuiz.mockId || currentQuiz.type === 'mock')
    });
  }

  // Mock test natijasini (va xatoliklar sonini) saqlash
  if(currentQuiz && (currentQuiz.mockId || currentQuiz.type === 'mock')){
    const mockKey = currentQuiz.mockId || currentQuiz.topicId;
    recordMockResult(mockKey, correct, total, wrong);
    renderSkillMockPanes();
  }

  if(FULL_EXAM && FULL_EXAM.active){
    FULL_EXAM.results[currentQuiz.skillId] = { correct, total, label: currentQuiz.label, mistakes: mistakeItems };
    advanceFullExam();
    return;
  }

  document.getElementById('resultTopic').textContent = currentQuiz.label || 'Test natijasi';
  
  // Daraja faqat Mahorat imtihonlarida ko'rsatiladi (Mock testlar va alohida mavzularda ko'rsatilmaydi)
  const levelWrap = document.querySelector('.result-level-wrap');
  if(levelWrap){
    levelWrap.style.display = (isSkillExam && pct >= 25) ? 'flex' : 'none';
  }
  if(isSkillExam && pct >= 25){
    const lvlEl = document.getElementById('resultLevel');
    if(lvlEl){
      lvlEl.style.display = '';
      lvlEl.textContent = calculatedLevel;
      if(calculatedLevel && calculatedLevel.length > 3){
        lvlEl.classList.add('is-message');
      } else {
        lvlEl.classList.remove('is-message');
      }
    }
  }

  document.getElementById('resTime').textContent = elapsedFormatted;

  const r = 52, c = 2*Math.PI*r;
  const ring = document.getElementById('resultRing');
  ring.style.stroke = currentQuiz.color;
  ring.setAttribute('stroke-dasharray', c);
  ring.style.transition = 'stroke-dashoffset 0.9s cubic-bezier(0.16, 1, 0.3, 1)';
  ring.setAttribute('stroke-dashoffset', c);
  setTimeout(()=>{
    ring.setAttribute('stroke-dashoffset', c-(pct/100)*c);
  }, 50);

  animateNumber('resultCorrect', correct, { duration: 850 });
  animateNumber('resultTotal', total, { duration: 600 });
  animateNumber('resultXP', xp, { duration: 850, prefix: '+' });
  animateNumber('resWrong', wrong, { duration: 700 });

  const titleEl = document.getElementById('resultTitle');
  const subEl = document.getElementById('resultSub');
  const levelTagEl = document.querySelector('.result-level-tag');
  if(pct < 25){
    if(levelTagEl) levelTagEl.style.display = 'none';
    if(isSkillExam){
      const lvlEl = document.getElementById('resultLevel');
      if(lvlEl) lvlEl.style.display = 'none';
    }
    titleEl.textContent = 'Daraja aniqlanmadi';
    subEl.textContent = "Ko'proq mashq qiling, keyingi safar albatta chiqadi!";
  } else {
    if(levelTagEl) levelTagEl.style.display = '';
    if(isSkillExam){
      const lvlEl = document.getElementById('resultLevel');
      if(lvlEl) lvlEl.style.display = '';
    }
    if(pct===100){
      titleEl.textContent = 'Ajoyibsiz! 🎉';
      subEl.textContent = "Siz barcha savollarga to'g'ri javob berdingiz.";
    } else if(pct>=80){
      titleEl.textContent = "Zo'r natija! 👏";
      subEl.textContent = `Siz ${total} tadan ${correct} tasiga to'g'ri javob berdingiz.`;
    } else if(pct>=50){
      titleEl.textContent = 'Yaxshi harakat! 💪';
      subEl.textContent = "Yana biroz mashq qilsangiz, natija yanada yaxshilanadi.";
    } else {
      titleEl.textContent = 'Yaxshi harakat! 💪';
      subEl.textContent = "Yana biroz mashq qilsangiz, natija yanada yaxshilanadi.";
    }
  }

  const analyzeBtn = document.getElementById('analyzeBtn');
  if(wrong===0){
    analyzeBtn.textContent = 'Bosh sahifaga qaytish';
    analyzeBtn.onclick = ()=>showView('dashboard');
  } else {
    analyzeBtn.textContent = 'Natijani tahlil qilish';
    analyzeBtn.onclick = showMistakes;
  }

  if(pct >= 25) fireSideConfetti({ mode: 'celebration' });

  renderReviewGrid();
  while(viewHistory.length > 0 && viewHistory[viewHistory.length - 1] === 'quiz'){
    viewHistory.pop();
  }
  showView('results');
}

/* ---- Review grid: har bir savol uchun to'g'ri/xato belgi, bossa to'liq tahlil chiqadi ---- */
const reviewIconSVG = {
  correct: `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
  wrong: `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`
};

function renderReviewGrid(){
  const grid = document.getElementById('reviewGrid');
  const detail = document.getElementById('reviewDetail');
  if(!grid || !currentQuiz || !Array.isArray(currentQuiz.questions)) return;
  grid.innerHTML = currentQuiz.questions.map((q,i)=>{
    const isUnanswered = q.picked === null || q.picked === undefined;
    const correct = !isUnanswered && (q.picked === q.a);
    const isWrong = !isUnanswered && !correct;
    const iconClass = correct ? 'correct' : (isUnanswered ? 'unanswered' : 'wrong');
    // Javob berilmagan va to'g'ri savollar tahlilga bosilmaydi — faqat xato javob berilgan savollargina tahlil qilinadi
    const canClick = isWrong;
    return `
      <div class="review-card ${canClick?'clickable':''}" data-idx="${i}" ${canClick?`onclick="toggleReviewDetail(${i})"`:''}>
        <div class="review-icon ${iconClass}">${correct?reviewIconSVG.correct:reviewIconSVG.wrong}</div>
        <div class="review-label">Savol ${i+1}</div>
      </div>`;
  }).join('');
  if(detail){
    detail.style.display = 'none';
    detail.innerHTML = '';
  }
}

function toggleReviewDetail(i){
  if(!currentQuiz || !Array.isArray(currentQuiz.questions)) return;
  const q = currentQuiz.questions[i];
  if(!q) return;

  // Javob berilmagan yoki to'g'ri bo'lgan savollar tahlili ochilmaydi
  const isUnanswered = q.picked === null || q.picked === undefined;
  const isCorrect = !isUnanswered && (q.picked === q.a);
  if(isUnanswered || isCorrect) return;

  // Faqat belgilangan va xato qilingan savollar ro'yxati
  const wrongIndices = currentQuiz.questions
    .map((item, idx) => (item.picked !== null && item.picked !== undefined && item.picked !== item.a) ? idx : -1)
    .filter(idx => idx !== -1);

  const currentMistakeNum = wrongIndices.indexOf(i) + 1;
  const totalMistakes = wrongIndices.length;

  const prevWrongIdx = wrongIndices.filter(idx => idx < i).pop();
  const nextWrongIdx = wrongIndices.find(idx => idx > i);

  document.getElementById('modalTitle').textContent = `${i+1}-savol xatosi (${currentMistakeNum}/${totalMistakes})`;
  document.getElementById('modalBody').innerHTML = `
    <div style="display:flex;flex-direction:column;gap:16px;">
      ${q.passage ? `
        <div style="background:var(--card-alt);padding:14px;border-radius:12px;border:1px solid var(--border);max-height:160px;overflow-y:auto;">
          <div style="font-size:11.5px;font-weight:700;color:var(--text-faint);text-transform:uppercase;margin-bottom:6px;">📖 Matn</div>
          <div dir="rtl" style="font-family:var(--font-ar);font-size:16px;line-height:1.7;color:var(--text);">${escapeHtml(q.passage)}</div>
        </div>
      ` : ''}

      <div style="background:var(--bg);padding:16px;border-radius:14px;border:1px solid var(--border);">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;">
          <span style="font-size:11.5px;font-weight:700;color:var(--text-faint);text-transform:uppercase;letter-spacing:0.5px;">Savol</span>
          ${q.category ? `<span style="font-size:11px;font-weight:600;color:var(--indigo-700);">${escapeHtml(q.category)}</span>` : ''}
        </div>
        <div style="font-family:var(--font-ar);font-size:20px;line-height:1.7;direction:rtl;text-align:right;color:var(--text);font-weight:600;">
          ${escapeHtml(q.q)}
        </div>
      </div>

      <div style="display:flex;flex-direction:column;gap:9px;">
        <div style="display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:12px;background:var(--red-bg);border:1px solid rgba(214,69,69,0.3);color:var(--red);">
          <span style="font-size:16px;font-weight:800;line-height:1;">✕</span>
          <div style="font-size:13.5px;font-weight:600;line-height:1.4;flex:1;">
            <span style="font-size:12px;opacity:0.85;display:block;margin-bottom:2px;">Sizning javobingiz:</span>
            <span style="font-family:var(--font-ar);font-size:16px;font-weight:600;direction:rtl;display:block;">${q.opts && q.opts[q.picked] !== undefined ? escapeHtml(q.opts[q.picked]) : String(q.picked)}</span>
          </div>
        </div>

        <div style="display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:12px;background:var(--green-bg);border:1px solid rgba(18,167,104,0.3);color:var(--green);">
          <span style="font-size:16px;font-weight:800;line-height:1;">✓</span>
          <div style="font-size:13.5px;font-weight:600;line-height:1.4;flex:1;">
            <span style="font-size:12px;opacity:0.85;display:block;margin-bottom:2px;">To'g'ri javob:</span>
            <span style="font-family:var(--font-ar);font-size:16px;font-weight:600;direction:rtl;display:block;">${q.opts && q.opts[q.a] !== undefined ? escapeHtml(q.opts[q.a]) : String(q.a)}</span>
          </div>
        </div>
      </div>

      ${q.exp ? `
        <div style="background:var(--card-alt);padding:14px 16px;border-radius:14px;border:1px solid var(--border);">
          <div style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:var(--indigo-700);margin-bottom:6px;">
            <span>💡</span> Tushuntirish / Izoh:
          </div>
          <div style="font-size:13.5px;line-height:1.6;color:var(--text);font-weight:500;">
            ${escapeHtml(q.exp)}
          </div>
        </div>
      ` : ''}

      <div style="display:flex;gap:10px;margin-top:4px;">
        <button type="button" class="btn btn-outline" style="flex:1;" ${prevWrongIdx !== undefined ? `onclick="toggleReviewDetail(${prevWrongIdx})"` : 'disabled style="opacity:0.4;cursor:not-allowed;"'}>⬅ Oldingi xato</button>
        <button type="button" class="btn btn-outline" style="flex:1;" ${nextWrongIdx !== undefined ? `onclick="toggleReviewDetail(${nextWrongIdx})"` : 'disabled style="opacity:0.4;cursor:not-allowed;"'}>Keyingi xato ➡</button>
      </div>
      <button type="button" class="btn btn-primary btn-block" onclick="document.getElementById('modalOverlay').classList.remove('show')">Yopish</button>
    </div>
  `;
  document.getElementById('modalOverlay').classList.add('show');
}
function showMistakes(){
  if(!currentQuiz || !Array.isArray(currentQuiz.questions)) return;
  const firstWrongIdx = currentQuiz.questions.findIndex(q => q.picked !== null && q.picked !== undefined && q.picked !== q.a);
  if(firstWrongIdx !== -1){
    toggleReviewDetail(firstWrongIdx);
  } else {
    toast("Ushbu testda xato javob berilgan savollar yo'q");
  }
}
function retryQuiz(){
  if(window.lastCompletedQuiz && (window.lastCompletedQuiz.type === 'mock' || window.lastCompletedQuiz.mockId)){
    startMockQuiz(window.lastCompletedQuiz.mockId);
    return;
  }
  if(!currentQuiz) return;
  startQuiz(currentQuiz.skillId, currentQuiz.label, currentQuiz.topicId);
}
function openTopic(id){
  const t = GRAMMAR_TOPICS.find(x=>x.id===id);
  if(t && GRAMMAR_TOPIC_BANKS[id]){ startQuiz('grammatika', t.name, id); }
  else { showView('grammar'); }
}

/* ============================================================
   MENING LUG'ATIM (FLASHCARDS / ANKI) VA DASHBOARD CARDLARI
   ============================================================ */

const DEFAULT_VOCABULARY_SEED = [
  {
    id: "fc_seed_1",
    ar: "سَعَى / يَسْعَى",
    uz: "Harakat qilmoq, intilmoq, yurmoq",
    exAr: "يَسْعَى الإِنْسَانُ دَائِمًا إِلَى النَّجَاحِ فِي حَيَاتِهِ.",
    exUz: "Inson hayotida doimo muvaffaqiyatga intiladi.",
    cat: "At-Tanal fe'llar",
    state: "learning",
    againCount: 0,
    goodCount: 0,
    easyCount: 0,
    lastReviewed: null
  }
];

function getStoredVocabulary(){
  try{
    const raw = localStorage.getItem('arabication_my_vocabulary');
    if(!raw){
      localStorage.setItem('arabication_my_vocabulary', JSON.stringify(DEFAULT_VOCABULARY_SEED));
      return [...DEFAULT_VOCABULARY_SEED];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [...DEFAULT_VOCABULARY_SEED];
  }catch(e){
    return [...DEFAULT_VOCABULARY_SEED];
  }
}

function saveStoredVocabulary(deck){
  try{
    localStorage.setItem('arabication_my_vocabulary', JSON.stringify(deck));
  }catch(e){}
  renderDashboardPracticeCards();
}

/* ============================================================
   LUG'AT (FLASHCARD) — SUPABASE BILAN SINXRONLASH
   Jadval: user_vocabulary (id text PK, user_id bigint, ar, uz, ex_ar, ex_uz,
   cat, state, again_count, good_count, easy_count, last_reviewed, created_at)
   Har bir so'z lokal (localStorage) keshda ham saqlanadi — internet bo'lmasa
   yoki Telegram tashqarisida ochilsa ham ilova ishlashda davom etadi.
   ============================================================ */
function vocabRowToWord(row){
  return {
    id: row.id,
    ar: row.ar,
    uz: row.uz,
    exAr: row.ex_ar || '',
    exUz: row.ex_uz || '',
    cat: row.cat || '',
    state: row.state || 'learning',
    againCount: row.again_count || 0,
    goodCount: row.good_count || 0,
    easyCount: row.easy_count || 0,
    lastReviewed: row.last_reviewed || null,
  };
}
function wordToVocabRow(word, userId){
  return {
    id: word.id,
    user_id: userId,
    ar: word.ar,
    uz: word.uz,
    ex_ar: word.exAr || null,
    ex_uz: word.exUz || null,
    cat: word.cat || null,
    state: word.state || 'learning',
    again_count: word.againCount || 0,
    good_count: word.goodCount || 0,
    easy_count: word.easyCount || 0,
    last_reviewed: word.lastReviewed || null,
  };
}
async function loadVocabularyFromBackend(userId){
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/user_vocabulary?user_id=eq.${userId}&order=created_at.desc`, {
      headers: authHeaders()
    });
    if(!res.ok) return null; // jadval mavjud emas yoki tarmoq/ruxsat xatosi — lokal keshda davom etamiz
    const rows = await res.json();
    return Array.isArray(rows) ? rows.map(vocabRowToWord) : null;
  }catch(e){ console.error('[loadVocabularyFromBackend]', e); return null; }
}
async function insertVocabularyWordToBackend(word){
  if(!TELEGRAM_PROFILE?.rawId) return false;
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/user_vocabulary`, {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify(wordToVocabRow(word, TELEGRAM_PROFILE.rawId))
    });
    return res.ok;
  }catch(e){ console.error('[insertVocabularyWordToBackend]', e); return false; }
}
async function updateVocabularyWordOnBackend(word){
  if(!TELEGRAM_PROFILE?.rawId) return false;
  try{
    const row = wordToVocabRow(word, TELEGRAM_PROFILE.rawId);
    delete row.id; delete row.user_id;
    const res = await fetch(`${SUPABASE_URL}/rest/v1/user_vocabulary?id=eq.${encodeURIComponent(word.id)}&user_id=eq.${TELEGRAM_PROFILE.rawId}`, {
      method: "PATCH", headers: authHeaders(), body: JSON.stringify(row)
    });
    return res.ok;
  }catch(e){ console.error('[updateVocabularyWordOnBackend]', e); return false; }
}
async function deleteVocabularyWordFromBackend(id){
  if(!TELEGRAM_PROFILE?.rawId) return false;
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/user_vocabulary?id=eq.${encodeURIComponent(id)}&user_id=eq.${TELEGRAM_PROFILE.rawId}`, {
      method: "DELETE", headers: authHeaders()
    });
    return res.ok;
  }catch(e){ console.error('[deleteVocabularyWordFromBackend]', e); return false; }
}
/* Ilova ochilganda chaqiriladi: backenddagi lug'at bu qurilmadagi lokal keshni
   almashtiradi (backend — asosiy manba). Agar backendda hali hech narsa bo'lmasa
   (foydalanuvchi birinchi marta ochyapti), joriy lokal/namunaviy lug'at backendga
   ko'chiriladi — shunda boshqa qurilmadan kirganda ham so'zlar ko'rinadi. */
async function syncVocabularyFromBackend(){
  if(!TELEGRAM_PROFILE?.rawId) return;
  const remote = await loadVocabularyFromBackend(TELEGRAM_PROFILE.rawId);
  if(remote === null) return; // tarmoq/jadval xatosi — lokal keshni tegmasdan qoldiramiz
  if(remote.length > 0){
    try{ localStorage.setItem('arabication_my_vocabulary', JSON.stringify(remote)); }catch(e){}
  } else {
    const local = getStoredVocabulary();
    for(const w of local){ await insertVocabularyWordToBackend(w); }
  }
  try{
    if(document.getElementById('view-flashcards')?.classList.contains('active')) renderFlashcardsView();
    renderDashboardPracticeCards();
  }catch(e){}
}

/* Flashcards session state */
let FC_CURRENT_TAB = 'anki'; // 'anki' | 'list'
let FC_FILTER_TYPE = 'all'; // 'all' | 'learning' | 'mastered'
let FC_SESSION_QUEUE = [];
let FC_SESSION_INDEX = 0;
let FC_IS_FLIPPED = false;

function openFlashcardsView(){
  showView('flashcards');
}

function renderFlashcardsView(){
  const deck = getStoredVocabulary();
  const badge = document.getElementById('fcTotalWordCountBadge');
  if(badge) badge.textContent = String(deck.length);

  if(FC_CURRENT_TAB === 'anki'){
    initFlashcardAnkiSession();
  } else {
    renderFlashcardWordsList();
  }
}

function switchFlashcardTab(tab){
  FC_CURRENT_TAB = tab;
  const btnAnki = document.getElementById('fcTabAnkiBtn');
  const btnList = document.getElementById('fcTabListBtn');
  const paneAnki = document.getElementById('fcPaneAnki');
  const paneList = document.getElementById('fcPaneList');

  if(tab === 'anki'){
    if(btnAnki) btnAnki.classList.add('active');
    if(btnList) btnList.classList.remove('active');
    if(paneAnki) paneAnki.style.display = 'block';
    if(paneList) paneList.style.display = 'none';
    initFlashcardAnkiSession();
  } else {
    if(btnAnki) btnAnki.classList.remove('active');
    if(btnList) btnList.classList.add('active');
    if(paneAnki) paneAnki.style.display = 'none';
    if(paneList) paneList.style.display = 'block';
    renderFlashcardWordsList();
  }
}

function initFlashcardAnkiSession(){
  const deck = getStoredVocabulary();
  if(deck.length === 0){
    FC_SESSION_QUEUE = [];
  } else {
    // Only queue words that are currently being learned (mastered words are excluded from active practice)
    const learning = deck.filter(w => w.state !== 'mastered');
    FC_SESSION_QUEUE = learning;
  }
  FC_SESSION_INDEX = 0;
  renderCurrentFlashcard();
}

function restartAllWordsSession(){
  const deck = getStoredVocabulary();
  deck.forEach(w => { w.state = 'learning'; });
  saveStoredVocabulary(deck);
  renderFlashcardsView();
  initFlashcardAnkiSession();
  toast("Barcha so'zlar mashqqa qaytarildi", 2000);
  // XATOLIK TUZATILDI: ilgari bu o'zgarish faqat localStorage'da qolib, Supabase'ga tushmasdi.
  for(const w of deck){ updateVocabularyWordOnBackend(w); }
}

function resetWordToLearning(id){
  const deck = getStoredVocabulary();
  const word = deck.find(w => w.id === id);
  if(word){
    word.state = 'learning';
    word.againCount = (word.againCount || 0) + 1;
    saveStoredVocabulary(deck);
    renderFlashcardsView();
    updateVocabularyWordOnBackend(word);
    toast("So'z mashq qilish ro'yxatiga qaytarildi", 2000);
  }
}

function renderCurrentFlashcard(){
  const cardBox = document.getElementById('fcCardBox');
  const counterEl = document.getElementById('fcProgressCounter');
  const barEl = document.getElementById('fcSessionProgressBar');
  const statusEl = document.getElementById('fcSessionStatusText');

  FC_IS_FLIPPED = false;
  if(cardBox) cardBox.classList.remove('flipped');

  if(FC_SESSION_QUEUE.length === 0){
    const deck = getStoredVocabulary();
    if(counterEl) counterEl.textContent = "0 / 0";
    if(barEl) barEl.style.width = "0%";
    if(deck.length === 0){
      if(statusEl) statusEl.textContent = "Lug'atingizda hali so'zlar yo'q";
      if(cardBox){
        const arEl = document.getElementById('fcFrontArabic');
        if(arEl) arEl.textContent = "Lug'at bo'sh";
      }
    } else {
      if(statusEl) statusEl.textContent = "Barcha so'zlar yodlangan";
      if(cardBox){
        const arEl = document.getElementById('fcFrontArabic');
        if(arEl) arEl.innerHTML = `<span style="font-size:22px;color:var(--green);font-weight:700;">Barcha so'zlar yodlangan!</span><div style="font-size:13px;color:var(--text-dim);margin-top:8px;font-family:'Onest',sans-serif;">Qayta takrorlash uchun so'zlar ro'yxatidan qaytarish tugmasini bosing yoki barchasini qaytadan boshlang</div><button type="button" class="btn btn-primary" onclick="restartAllWordsSession()" style="margin-top:12px;padding:8px 16px;font-size:13px;">Barchasini qayta takrorlash</button>`;
      }
    }
    return;
  }

  if(FC_SESSION_INDEX >= FC_SESSION_QUEUE.length){
    // Session complete
    if(counterEl) counterEl.textContent = `${FC_SESSION_QUEUE.length} / ${FC_SESSION_QUEUE.length}`;
    if(barEl) barEl.style.width = "100%";
    if(statusEl) statusEl.textContent = "Mashq tugadi. Barcha kartalar takrorlandi";
    if(cardBox){
      const arEl = document.getElementById('fcFrontArabic');
      if(arEl) arEl.innerHTML = `<span style="font-size:24px;color:var(--green);font-weight:700;">Muvaffaqiyatli</span><div style="font-size:14px;color:var(--text-dim);margin-top:8px;font-family:'Onest',sans-serif;">Qaytadan boshlash uchun bosing</div>`;
    }
    return;
  }

  const word = FC_SESSION_QUEUE[FC_SESSION_INDEX];
  const total = FC_SESSION_QUEUE.length;
  const currentNum = FC_SESSION_INDEX + 1;
  const pct = Math.round(((currentNum - 1) / total) * 100);

  if(counterEl) counterEl.textContent = `${currentNum} / ${total}`;
  if(barEl) barEl.style.width = `${pct}%`;
  if(statusEl) statusEl.textContent = word.state === 'mastered' ? "Yodlangan so'z" : "O'rganilayotgan so'z";

  const arEl = document.getElementById('fcFrontArabic');
  if(arEl) arEl.textContent = word.ar;

  const meaningEl = document.getElementById('fcBackMeaning');
  if(meaningEl) meaningEl.textContent = word.uz;

  const exBox = document.getElementById('fcBackExampleBox');
  const exArEl = document.getElementById('fcBackExampleAr');
  const exUzEl = document.getElementById('fcBackExampleUz');

  if(word.exAr || word.exUz){
    if(exBox) exBox.style.display = 'block';
    if(exArEl) exArEl.textContent = word.exAr || '';
    if(exUzEl) exUzEl.textContent = word.exUz || '';
  } else {
    if(exBox) exBox.style.display = 'none';
  }
}

function flipActiveFlashcard(){
  if(FC_SESSION_QUEUE.length === 0) return;
  if(FC_SESSION_INDEX >= FC_SESSION_QUEUE.length){
    initFlashcardAnkiSession();
    return;
  }
  const cardBox = document.getElementById('fcCardBox');
  if(!cardBox) return;
  FC_IS_FLIPPED = !FC_IS_FLIPPED;
  cardBox.classList.toggle('flipped', FC_IS_FLIPPED);
}

function handleAnkiAnswer(rating){
  if(FC_SESSION_QUEUE.length === 0 || FC_SESSION_INDEX >= FC_SESSION_QUEUE.length) return;
  const word = FC_SESSION_QUEUE[FC_SESSION_INDEX];
  const deck = getStoredVocabulary();
  const target = deck.find(w => w.id === word.id);

  if(target){
    target.lastReviewed = new Date().toISOString();
    if(rating === 'again'){
      target.againCount = (target.againCount || 0) + 1;
      target.state = 'learning';
      FC_SESSION_QUEUE.push(word);
    } else if(rating === 'good'){
      target.goodCount = (target.goodCount || 0) + 1;
    } else if(rating === 'easy'){
      target.easyCount = (target.easyCount || 0) + 1;
      target.state = 'mastered';
    }
    saveStoredVocabulary(deck);
    updateVocabularyWordOnBackend(target);
  }

  FC_SESSION_INDEX++;
  renderCurrentFlashcard();
}

/* Words list rendering and filter */
function setFlashcardFilter(filter){
  FC_FILTER_TYPE = filter;
  const btnAll = document.getElementById('fcFilterAllBtn');
  const btnLrn = document.getElementById('fcFilterLearningBtn');
  const btnMst = document.getElementById('fcFilterMasteredBtn');

  if(btnAll) btnAll.classList.toggle('active', filter === 'all');
  if(btnLrn) btnLrn.classList.toggle('active', filter === 'learning');
  if(btnMst) btnMst.classList.toggle('active', filter === 'mastered');

  renderFlashcardWordsList();
}

function renderFlashcardWordsList(){
  const grid = document.getElementById('fcWordsGrid');
  if(!grid) return;

  const deck = getStoredVocabulary();
  const searchInput = document.getElementById('fcSearchInput');
  const q = (searchInput ? searchInput.value : '').toLowerCase().trim();

  let filtered = deck;
  if(FC_FILTER_TYPE === 'learning'){
    filtered = filtered.filter(w => w.state !== 'mastered');
  } else if(FC_FILTER_TYPE === 'mastered'){
    filtered = filtered.filter(w => w.state === 'mastered');
  }

  if(q){
    filtered = filtered.filter(w => 
      (w.ar && w.ar.toLowerCase().includes(q)) || 
      (w.uz && w.uz.toLowerCase().includes(q)) || 
      (w.cat && w.cat.toLowerCase().includes(q))
    );
  }

  if(filtered.length === 0){
    grid.innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:36px 16px;background:var(--card);border-radius:18px;border:1px dashed var(--border);">
        <div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:4px;">Hech qanday so'z topilmadi</div>
        <p style="font-size:13px;color:var(--text-dim);max-width:320px;margin:0 auto 16px;">O'qish matnlaridan so'zni tanlang yoki yangi so'z qo'shing.</p>
        <button class="btn btn-primary" onclick="openAddFlashcardModal()">Yangi so'z qo'shish</button>
      </div>
    `;
    return;
  }

  grid.innerHTML = filtered.map(w => {
    const isMastered = w.state === 'mastered';
    return `
      <div class="fc-word-card ${isMastered ? 'mastered' : ''}">
        <div class="fc-word-head">
          <div class="fc-word-ar">${escapeHtml(w.ar)}</div>
          <div class="fc-word-tools">
            <button type="button" class="fc-tool-btn btn-reset" onclick="resetWordToLearning('${w.id}')" title="Mashqqa qaytarish (qayta o'rganish)" aria-label="Mashqqa qaytarish">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="1 4 1 10 7 10"/>
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
              </svg>
            </button>
            <button type="button" class="fc-tool-btn btn-edit" onclick="openEditFlashcardModal('${w.id}')" title="Tahrirlash" aria-label="Tahrirlash">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
              </svg>
            </button>
            <button type="button" class="fc-tool-btn btn-del" onclick="deleteFlashcardWord('${w.id}')" title="O'chirish" aria-label="O'chirish">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="fc-word-uz">${escapeHtml(w.uz)}</div>
        ${w.exAr ? `
          <div style="font-size:13px;color:var(--text-dim);margin-top:6px;direction:rtl;text-align:right;font-family:'Noto Sans Arabic',sans-serif;line-height:1.6;">
            ${escapeHtml(w.exAr)}
          </div>
        ` : ''}
        ${w.exUz ? `
          <div style="font-size:12px;color:var(--text-dim);margin-top:2px;">
            ${escapeHtml(w.exUz)}
          </div>
        ` : ''}
        <div class="fc-word-footer">
          <span class="badge" style="background:var(--indigo-100);color:var(--indigo-700);font-size:11px;">${escapeHtml(w.cat || "Lug'at")}</span>
          <button type="button" class="badge" onclick="toggleWordMastered('${w.id}')" style="cursor:pointer;border:none;background:${isMastered ? 'var(--green-bg)' : 'var(--card-alt)'};color:${isMastered ? 'var(--green)' : 'var(--text-dim)'};font-size:11px;font-weight:700;">
            ${isMastered ? 'Yodlangan' : "O'rganilmoqda"}
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function openAddFlashcardModal(){
  document.getElementById('flashcardModalTitle').textContent = "Yangi so'z qo'shish";
  document.getElementById('fcEditWordId').value = "";
  document.getElementById('fcInputAr').value = "";
  document.getElementById('fcInputUz').value = "";
  document.getElementById('fcInputExAr').value = "";
  document.getElementById('fcInputExUz').value = "";
  document.getElementById('fcInputCat').value = "Shaxsiy lug'at";
  const overlay = document.getElementById('flashcardModalOverlay');
  if(overlay) overlay.style.display = 'flex';
}

function openEditFlashcardModal(id){
  const deck = getStoredVocabulary();
  const word = deck.find(w => w.id === id);
  if(!word) return;

  document.getElementById('flashcardModalTitle').textContent = "So'zni tahrirlash";
  document.getElementById('fcEditWordId').value = word.id;
  document.getElementById('fcInputAr').value = word.ar || '';
  document.getElementById('fcInputUz').value = word.uz || '';
  document.getElementById('fcInputExAr').value = word.exAr || '';
  document.getElementById('fcInputExUz').value = word.exUz || '';
  document.getElementById('fcInputCat').value = word.cat || '';
  const overlay = document.getElementById('flashcardModalOverlay');
  if(overlay) overlay.style.display = 'flex';
}

function closeFlashcardModal(){
  const overlay = document.getElementById('flashcardModalOverlay');
  if(overlay) overlay.style.display = 'none';
}

function saveFlashcardModalData(){
  const id = document.getElementById('fcEditWordId').value;
  const ar = (document.getElementById('fcInputAr').value || '').trim();
  const uz = (document.getElementById('fcInputUz').value || '').trim();
  const exAr = (document.getElementById('fcInputExAr').value || '').trim();
  const exUz = (document.getElementById('fcInputExUz').value || '').trim();
  const cat = (document.getElementById('fcInputCat').value || '').trim() || "Shaxsiy lug'at";

  if(!ar || !uz){
    toast("Arabcha so'z va o'zbekcha tarjimasini kiriting", 3000, 'warning');
    return;
  }

  const deck = getStoredVocabulary();
  if(id){
    const target = deck.find(w => w.id === id);
    if(target){
      target.ar = ar;
      target.uz = uz;
      target.exAr = exAr;
      target.exUz = exUz;
      target.cat = cat;
      toast("So'z muvaffaqiyatli yangilandi", 2500);
    }
  } else {
    const newWord = {
      id: "fc_" + Date.now() + "_" + Math.random().toString(36).substr(2, 4),
      ar, uz, exAr, exUz, cat,
      state: "learning",
      againCount: 0, goodCount: 0, easyCount: 0,
      lastReviewed: null
    };
    deck.unshift(newWord);
    toast("Yangi so'z lug'atga qo'shildi", 2500);
  }

  saveStoredVocabulary(deck);
  closeFlashcardModal();
  renderFlashcardsView();

  if(id){
    const target = deck.find(w => w.id === id);
    if(target) updateVocabularyWordOnBackend(target);
  } else {
    insertVocabularyWordToBackend(deck[0]);
  }
}

function deleteFlashcardWord(id){
  const deck = getStoredVocabulary();
  const filtered = deck.filter(w => w.id !== id);
  saveStoredVocabulary(filtered);
  toast("So'z lug'atdan o'chirildi", 2000, 'delete');
  renderFlashcardsView();
  deleteVocabularyWordFromBackend(id);
}

function toggleWordMastered(id){
  const deck = getStoredVocabulary();
  const word = deck.find(w => w.id === id);
  if(word){
    word.state = (word.state === 'mastered') ? 'learning' : 'mastered';
    saveStoredVocabulary(deck);
    renderFlashcardsView();
    toast(word.state === 'mastered' ? "Yodlangan deb belgilandi" : "O'rganishga qaytarildi", 2000);
    updateVocabularyWordOnBackend(word);
  }
}

/* Quick Passage Word Save Modal */
let CURRENT_QUICK_SAVE_CONTEXT = "";

function openQuickPassageWordModal(word, example = ""){
  if(!word) return;
  const cleanWord = word.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()«»""]/g, "").trim();
  if(!cleanWord) return;

  CURRENT_QUICK_SAVE_CONTEXT = example || "";
  const arWordEl = document.getElementById('quickSaveArWord');
  const uzMeanInput = document.getElementById('quickSaveUzMeaning');
  const exInput = document.getElementById('quickSaveExample');
  const overlay = document.getElementById('quickPassageWordModalOverlay');

  if(arWordEl) arWordEl.textContent = cleanWord;
  if(uzMeanInput) uzMeanInput.value = "";
  if(exInput) exInput.value = example || "";

  if(overlay){
    overlay.style.display = 'flex';
    setTimeout(()=>{ if(uzMeanInput) uzMeanInput.focus(); }, 150);
  }
}

function closeQuickPassageWordModal(){
  const overlay = document.getElementById('quickPassageWordModalOverlay');
  if(overlay) overlay.style.display = 'none';
}

function saveWordFromPassageModal(){
  const arWord = document.getElementById('quickSaveArWord').textContent.trim();
  const uzMeaning = (document.getElementById('quickSaveUzMeaning').value || '').trim();
  const example = (document.getElementById('quickSaveExample').value || '').trim();

  if(!arWord){
    closeQuickPassageWordModal();
    return;
  }

  const deck = getStoredVocabulary();
  const existing = deck.find(w => w.ar === arWord);
  let isNewWord = false;
  if(existing){
    if(uzMeaning) existing.uz = uzMeaning;
    if(example) existing.exAr = example;
    toast("Lug'atdagi mavjud so'z yangilandi", 2500);
  } else {
    isNewWord = true;
    deck.unshift({
      id: "fc_" + Date.now() + "_" + Math.random().toString(36).substr(2, 4),
      ar: arWord,
      uz: uzMeaning || "Tarjimasi kiritilmagan",
      exAr: example || "",
      exUz: "",
      cat: "Qiroa matni",
      state: "learning",
      againCount: 0, goodCount: 0, easyCount: 0,
      lastReviewed: null
    });
    toast(`"${arWord}" so'zi lug'atga saqlandi`, 3000);
  }

  saveStoredVocabulary(deck);
  closeQuickPassageWordModal();

  // XATOLIK TUZATILDI: bu yerda ilgari Supabase'ga yuborish umuman yo'q edi —
  // so'z faqat shu qurilmaning localStorage'ida qolib, backendga tushmasdi.
  if(isNewWord){
    insertVocabularyWordToBackend(deck[0]);
  } else if(existing){
    updateVocabularyWordOnBackend(existing);
  }
}

/* Attach interactive word click listeners to Arabic reading passages */
function makeArabicPassageInteractive(containerEl){
  if(!containerEl) return;
  containerEl.style.cursor = 'pointer';
  containerEl.title = "Tushunmagan so'z ustiga bosing — lug'atga saqlanadi";

  containerEl.addEventListener('click', (e)=>{
    let selection = window.getSelection() ? window.getSelection().toString().trim() : '';
    if(selection && selection.length >= 2 && selection.length <= 60){
      openQuickPassageWordModal(selection);
      return;
    }

    let range = null;
    if(document.caretRangeFromPoint){
      range = document.caretRangeFromPoint(e.clientX, e.clientY);
    } else if(e.rangeParent && e.rangeOffset !== undefined){
      range = document.createRange();
      range.setStart(e.rangeParent, e.rangeOffset);
    }

    if(range && range.startContainer && range.startContainer.nodeType === Node.TEXT_NODE){
      const text = range.startContainer.textContent;
      const offset = range.startOffset;
      let start = offset;
      while(start > 0 && !/[\s.,!?;:()«»""''،؟]/.test(text[start - 1])) start--;
      let end = offset;
      while(end < text.length && !/[\s.,!?;:()«»""''،؟]/.test(text[end])) end++;
      const word = text.substring(start, end).trim();
      if(word && word.length >= 2){
        const sentStart = Math.max(0, start - 40);
        const sentEnd = Math.min(text.length, end + 40);
        const sentenceContext = text.substring(sentStart, sentEnd).trim();
        openQuickPassageWordModal(word, sentenceContext);
      }
    }
  });
}

/* ============================================================
   DASHBOARD 3 TA ASOSIY CARDLARNI CHIZISH (MOCK, LUG'AT, MARAFON)
   ============================================================ */

function renderDashboardPracticeCards(){
  // 1-Card: MOCK TESTLAR (Grammatika mock testlari)
  const valEl = document.getElementById('dashMockCardVal');
  const totalEl = document.getElementById('dashMockCardTotal');
  const subEl = document.getElementById('dashMockCardSub');
  const fillEl = document.getElementById('dashMockCardFill');
  const titleEl = document.getElementById('dashMockCardTitle');

  const history = Array.isArray(window.HISTORY_DATA_LIVE) && window.HISTORY_DATA_LIVE.length 
    ? window.HISTORY_DATA_LIVE 
    : (Array.isArray(HISTORY_DATA) ? HISTORY_DATA : []);

  // MUHIM: faqat HAQIQIY mock urinishlari (isMockHistoryRow orqali, boshqa
  // mahoratlar bilan bir xil to'liq tekshiruv). Ilgari bu yerda mock
  // topilmasa, oxirgi UMUMIY tarix qatoriga (istalgan mahorat) tushib
  // qolinardi — natijada karta boshqa mahoratning natijasini "mock" sifatida
  // ko'rsatib yuborardi. Endi mock topilmasa, "hali yechilmagan" holati
  // ko'rsatiladi (pastdagi else shoxobchasi).
  const mockAttempts = history.filter(isMockHistoryRow);
  const latestAttempt = mockAttempts.length > 0 ? mockAttempts[0] : null;

  if(latestAttempt){
    const correct = pick(latestAttempt, ['correct'], 0);
    const total = pick(latestAttempt, ['total'], 30);
    const pct = Math.min(100, Math.round((correct / Math.max(1, total)) * 100));
    const title = pick(latestAttempt, ['topic_name', 'topic', 'section'], 'Grammatika mock');
    const { date } = fmtBackendDate(pick(latestAttempt, ['created_at', 'createdAt', 'inserted_at', 'date'], null));

    if(valEl){
      valEl.setAttribute('data-target', String(correct));
      animateNumber(valEl, correct, { duration: 0 }); // Asosiy sahifa: animatsiyasiz, darhol
    }
    if(totalEl) totalEl.textContent = String(total);
    if(titleEl) titleEl.textContent = "MOCK TESTLAR";
    if(subEl) subEl.textContent = `${title} · ${date || "Yaqinda"}`;
    if(fillEl) fillEl.style.width = `${pct}%`;
  } else {
    if(valEl){
      valEl.setAttribute('data-target', '0');
      valEl.textContent = '0';
    }
    if(totalEl) totalEl.textContent = '100';
    if(titleEl) titleEl.textContent = "MOCK TESTLAR";
    if(subEl) subEl.textContent = "Grammatika mock testlar";
    if(fillEl) fillEl.style.width = '0%';
  }

  // 2-Card: LUG'ATLARIM (Mening Lug'atim)
  const fcValEl = document.getElementById('dashFlashCardVal');
  const fcTotalEl = document.getElementById('dashFlashCardTotal');
  const fcSubEl = document.getElementById('dashFlashCardSub');
  const fcFillEl = document.getElementById('dashFlashCardFill');

  const deck = getStoredVocabulary();
  const masteredCount = deck.filter(w => w.state === 'mastered').length;
  const totalCount = deck.length;
  const flashPct = totalCount > 0 ? Math.min(100, Math.round((masteredCount / totalCount) * 100)) : 0;

  if(fcValEl){
    fcValEl.setAttribute('data-target', String(masteredCount));
    animateNumber(fcValEl, masteredCount, { duration: 0 }); // Asosiy sahifa: animatsiyasiz, darhol
  }
  if(fcTotalEl) fcTotalEl.textContent = String(totalCount);
  if(fcSubEl) fcSubEl.textContent = totalCount > 0 ? `${totalCount} ta so'z · ${masteredCount} ta yodlangan` : "Mening lug‘atim (Anki)";
  if(fcFillEl) fcFillEl.style.width = `${flashPct}%`;

  // 3-Card: MARAFON (Grammatika marafoni - qat'iy tartibda barcha testlar)
  const marValEl = document.getElementById('dashMarathonCardVal');
  const marTotalEl = document.getElementById('dashMarathonCardTotal');
  const marSubEl = document.getElementById('dashMarathonCardSub');
  const marFillEl = document.getElementById('dashMarathonCardFill');
  const marTitleEl = document.getElementById('dashMarathonCardTitle');

  const allMarQuestions = getGrammarMarathonQuestions();
  const marTotal = allMarQuestions.length;
  const marState = getMarathonState();
  const marAnsweredCount = Object.keys(marState.answers || {}).length;
  const marPct = marTotal > 0 ? Math.min(100, Math.round((marAnsweredCount / marTotal) * 100)) : 0;

  if(marValEl){
    marValEl.setAttribute('data-target', String(marAnsweredCount));
    animateNumber(marValEl, marAnsweredCount, { duration: 0 }); // Asosiy sahifa: animatsiyasiz, darhol
  }
  if(marTotalEl) marTotalEl.textContent = String(marTotal);
  if(marTitleEl) marTitleEl.textContent = "Marafon";
  if(marSubEl){
    if(marAnsweredCount > 0){
      const nextQNum = Math.min(marTotal, (marState.currentIndex || 0) + 1);
      marSubEl.textContent = `${nextQNum}-savol · Qolgan joyidan davom etish`;
    } else {
      marSubEl.textContent = marTotal > 0 ? `${marTotal} ta savol · Ketma-ket yechish` : "Grammatika marafoni";
    }
  }
  if(marFillEl) marFillEl.style.width = `${marPct}%`;
}

function handleDashMockCardClick(){
  openSkillIntro('grammatika');
  switchSkillTab('mocks', true);
}

/* ============================================================
   GRAMMATIKA MARAFONI (Barcha grammatika savollarini qat'iy tartibda yechish)
   ============================================================ */

function getGrammarMarathonQuestions(){
  const list = [];
  const seenKeys = new Set();

  // 1. Grammatika mavzulari bo'yicha ketma-ketlik
  (GRAMMAR_TOPICS || []).forEach(t => {
    const topicBank = GRAMMAR_TOPIC_BANKS[t.id] || [];
    topicBank.forEach((q, qIndex) => {
      const key = q.id ? `id_${q.id}` : `t_${t.id}_${qIndex}_${q.q}`;
      if(!seenKeys.has(key)){
        seenKeys.add(key);
        list.push({
          ...q,
          _marathonTopicName: t.name || t.ar || 'Grammatika',
          _marathonTopicId: t.id
        });
      }
    });
  });

  // 2. Umumiy grammatika savollari (agar biror savol mavzuga biriktirilmagan bo'lsa)
  const general = (QUESTION_BANKS.grammatika && QUESTION_BANKS.grammatika.questions) || [];
  general.forEach((q, qIndex) => {
    const key = q.id ? `id_${q.id}` : `g_${qIndex}_${q.q}`;
    if(!seenKeys.has(key)){
      seenKeys.add(key);
      list.push({
        ...q,
        _marathonTopicName: 'Umumiy grammatika',
        _marathonTopicId: null
      });
    }
  });

  return list;
}

function getMarathonState(){
  try {
    const raw = localStorage.getItem('arabication_grammar_marathon_v1');
    if(raw){
      const parsed = JSON.parse(raw);
      if(parsed && typeof parsed === 'object') return parsed;
    }
  }catch(e){}
  return {
    currentIndex: 0,
    answers: {},
    completedCount: 0
  };
}

function saveMarathonState(state){
  try {
    localStorage.setItem('arabication_grammar_marathon_v1', JSON.stringify(state));
  }catch(e){}
  renderDashboardPracticeCards();
}

/* ============================================================
   GRAMMATIKA MARAFONI VA SAQLANGAN SAVOLLAR FUNKSIYALARI
   ============================================================ */

function getSavedMarathonQuestions(){
  try {
    const raw = localStorage.getItem('arabication_saved_marathon_questions_v1');
    if(raw){
      const parsed = JSON.parse(raw);
      if(Array.isArray(parsed)) return parsed;
    }
  }catch(e){}
  return [];
}

function saveSavedMarathonQuestions(list){
  try {
    localStorage.setItem('arabication_saved_marathon_questions_v1', JSON.stringify(list));
  }catch(e){}
}

function isCurrentMarathonQuestionSaved(){
  if(!currentQuiz || !currentQuiz.questions) return false;
  const q = currentQuiz.questions[currentQuiz.idx];
  if(!q) return false;
  const list = getSavedMarathonQuestions();
  return list.some(item => (q.id && item.id === q.id) || item.q === q.q);
}

function toggleSaveCurrentMarathonQuestion(){
  if(!currentQuiz || !currentQuiz.questions) return;
  const q = currentQuiz.questions[currentQuiz.idx];
  if(!q) return;
  let list = getSavedMarathonQuestions();
  const existingIdx = list.findIndex(item => (q.id && item.id === q.id) || item.q === q.q);
  if(existingIdx >= 0){
    list.splice(existingIdx, 1);
    saveSavedMarathonQuestions(list);
    toast("Savol saqlanganlardan olib tashlandi 🗑️", 2200);
  } else {
    list.unshift({
      id: q.id || null,
      q: q.q,
      opts: q.opts || [],
      a: q.a,
      userPicked: (q.picked !== null && q.picked !== undefined) ? q.picked : null,
      exp: q.exp || '',
      category: q.category || 'Grammatika',
      topicName: q._marathonTopicName || 'Grammatika',
      savedAt: Date.now()
    });
    saveSavedMarathonQuestions(list);
    toast("Savol muvaffaqiyatli saqlandi ⭐", 2200);
  }

  const btn = document.getElementById('marathonSaveBtn');
  const isSaved = isCurrentMarathonQuestionSaved();
  if(btn){
    btn.classList.toggle('active', isSaved);
    btn.title = isSaved ? 'Saqlanganlardan olib tashlash' : 'Savolni saqlash';
    btn.innerHTML = isSaved ? `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5">
        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
      </svg>
    ` : `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
      </svg>
    `;
  }
}

function handleDashMarathonCardClick(){
  openMarathonHubView();
}

function openMarathonHubView(){
  renderMarathonHub();
  showView('marathon');
}

function renderMarathonHub(){
  const allMarQuestions = getGrammarMarathonQuestions();
  const total = allMarQuestions.length;
  const state = getMarathonState();
  const answeredCount = Object.keys(state.answers || {}).length;
  const currentIdx = state.currentIndex || 0;

  const resumeSubEl = document.getElementById('marathonHubResumeSub');
  const resumeValEl = document.getElementById('marathonHubResumeVal');
  const resumeTotalEl = document.getElementById('marathonHubResumeTotal');

  if(resumeValEl) resumeValEl.textContent = String(answeredCount);
  if(resumeTotalEl) resumeTotalEl.textContent = String(total);

  if(resumeSubEl){
    if(answeredCount > 0){
      const nextQNum = Math.min(total, currentIdx + 1);
      resumeSubEl.textContent = `${nextQNum}-savol · Qolgan joyidan davom etish`;
    } else {
      resumeSubEl.textContent = total > 0 ? `1-savoldan boshlash (${total} ta savol)` : "1-savoldan boshlash";
    }
  }

  const savedList = getSavedMarathonQuestions();
  const savedCount = savedList.length;
  const savedSubEl = document.getElementById('marathonHubSavedSub');
  const savedCountEl = document.getElementById('marathonHubSavedCount');
  if(savedSubEl) savedSubEl.textContent = savedCount > 0 ? `${savedCount} ta savol saqlangan` : "0 ta savol saqlangan";
  if(savedCountEl) savedCountEl.textContent = String(savedCount);
}

function resumeMarathonFromHub(){
  const questions = getGrammarMarathonQuestions();
  if(!questions || !questions.length){
    toast("⚠️ Grammatika bo'limida hali savollar mavjud emas. Admin panelda savollar qo'shing.");
    return;
  }
  startGrammarMarathon(false);
}

async function confirmRestartMarathon(){
  const questions = getGrammarMarathonQuestions();
  if(!questions || !questions.length){
    toast("⚠️ Grammatika bo'limida hali savollar mavjud emas.");
    return;
  }
  const state = getMarathonState();
  const answered = Object.keys(state.answers || {}).length;
  if(answered > 0){
    const ok = await showLiquidConfirm({
      title: "Qayta boshlash",
      message: "Marafonni 0 dan qayta boshlashni xohlaysizmi?",
      subtext: "Oldingi javoblaringiz tozalanadi va 1-savoldan boshlanadi.",
      confirmLabel: "Ha, qayta boshlash",
      cancelLabel: "Bekor qilish",
      isDanger: false,
      icon: "🔄"
    });
    if(ok){
      startGrammarMarathon(true);
    }
  } else {
    startGrammarMarathon(true);
  }
}

function openSavedMarathonQuestions(){
  const list = getSavedMarathonQuestions();
  const modal = document.getElementById('savedMarathonModalOverlay');
  if(!modal) return;
  renderSavedMarathonQuestionsList();
  modal.style.display = 'flex';
}

function closeSavedMarathonModal(){
  const modal = document.getElementById('savedMarathonModalOverlay');
  if(modal) modal.style.display = 'none';
  renderMarathonHub();
}

function toggleSavedQExplanation(cardEl){
  const expBox = cardEl.querySelector('.saved-q-exp-box');
  const hintEl = cardEl.querySelector('.saved-q-exp-hint');
  if(!expBox) return;
  const isOpen = expBox.classList.toggle('open');
  if(hintEl){
    hintEl.innerHTML = isOpen ? `💡 Izohni yashirish ▲` : `💡 Izohni ko'rish uchun bosing ▼`;
  }
}

function renderSavedMarathonQuestionsList(){
  const body = document.getElementById('savedMarathonModalBody');
  if(!body) return;
  const list = getSavedMarathonQuestions();

  if(!list.length){
    body.innerHTML = `
      <div style="text-align:center;padding:36px 16px;">
        <div style="font-size:36px;margin-bottom:12px;">⭐</div>
        <div style="font-size:16px;font-weight:700;margin-bottom:6px;">Hozircha saqlangan savollar yo'q</div>
        <div style="font-size:13px;color:var(--text-dim);font-weight:600;max-width:320px;margin:0 auto;line-height:1.5;">
          Marafon jarayonida har bir savol ostidagi saqlash (bookmark) belgisini bosib, qiyin yoki muhim savollarni bu yerga saqlab boring.
        </div>
      </div>
    `;
    return;
  }

  let html = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px;">
      <div style="font-size:13px;font-weight:700;color:var(--text-dim);">Jami saqlangan: ${list.length} ta savol</div>
      <button class="btn btn-primary btn-sm" style="padding:7px 14px;border-radius:10px;font-size:12.5px;" onclick="startSavedQuestionsPractice()">
        ▶ Barchasini yechish
      </button>
    </div>
  `;

  list.forEach((item, idx) => {
    const hasUserPicked = (item.userPicked !== null && item.userPicked !== undefined);
    html += `
      <div class="saved-q-card" onclick="toggleSavedQExplanation(this)" role="button" tabindex="0">
        <div class="saved-q-head">
          <div class="saved-q-badge">${item.topicName || item.category || 'Grammatika'}</div>
          <button class="saved-q-del-btn" onclick="event.stopPropagation(); removeSavedMarathonQuestion(${idx})" title="Saqlanganlardan o'chirish" aria-label="O'chirish">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/>
            </svg>
          </button>
        </div>
        <div class="saved-q-text">${item.q}</div>
        <div class="saved-q-opts">
          ${(item.opts || []).map((opt, oi) => {
            const isCorrect = (oi === item.a);
            const isUserPicked = hasUserPicked && (oi === item.userPicked);
            const isUserWrong = isUserPicked && !isCorrect;

            let optClass = '';
            let optBadge = '';
            if(isCorrect){
              optClass = 'correct';
              optBadge = `<span style="font-size:11px;font-weight:700;margin-left:auto;">To'g'ri javob ✓</span>`;
            } else if(isUserWrong){
              optClass = 'incorrect';
              optBadge = `<span style="font-size:11px;font-weight:700;margin-left:auto;">Sizning javobingiz (xato) ✗</span>`;
            }

            return `
              <div class="saved-q-opt ${optClass}">
                <span style="font-family:var(--font-ar);font-size:13px;width:18px;text-align:center;">${ARABIC_OPT_LETTERS[oi] || ''}</span>
                <span style="flex:1;">${opt}</span>
                ${optBadge}
              </div>
            `;
          }).join('')}
        </div>
        ${item.exp ? `
          <div class="saved-q-exp-hint">💡 Izohni ko'rish uchun bosing ▼</div>
          <div class="saved-q-exp-box">
            <strong>💡 Izoh:</strong><br>${item.exp}
          </div>
        ` : ''}
      </div>
    `;
  });

  body.innerHTML = html;
}

function removeSavedMarathonQuestion(idx){
  let list = getSavedMarathonQuestions();
  if(idx >= 0 && idx < list.length){
    list.splice(idx, 1);
    saveSavedMarathonQuestions(list);
    renderSavedMarathonQuestionsList();
    renderMarathonHub();
    toast("Savol saqlanganlardan o'chirildi", 2000);
  }
}

function startSavedQuestionsPractice(){
  const list = getSavedMarathonQuestions();
  if(!list.length){
    toast("Saqlangan savollar mavjud emas");
    return;
  }
  closeSavedMarathonModal();

  currentQuiz = {
    skillId: 'grammatika',
    topicId: null,
    isMarathon: true,
    type: 'mcq',
    questions: list.map(q => ({
      ...q,
      picked: null,
      timeLeft: 60,
      expired: false
    })),
    color: '#D97706',
    bg: '#FEFCE8',
    label: 'Saqlangan savollar',
    idx: 0,
    startedAt: Date.now()
  };

  const sideEl = document.getElementById('quizSide');
  if(sideEl) sideEl.style.display = 'none';

  clearQuestionTimer();
  if(timerInterval) clearInterval(timerInterval);
  updateMarathonHeaderStats();

  buildQGrid();
  renderQuestion();
  showView('quiz');
  toast(`⭐ Saqlangan savollar: ${list.length} ta savol yechilmoqda`, 3500);
}

function startGrammarMarathon(reset = false){
  const questions = getGrammarMarathonQuestions();
  if(!questions || !questions.length){
    toast("⚠️ Grammatika bo'limida hali savollar mavjud emas.");
    return;
  }

  let state = getMarathonState();
  if(reset){
    state = { currentIndex: 0, answers: {}, completedCount: 0 };
    saveMarathonState(state);
  }

  const startIdx = Math.max(0, Math.min(state.currentIndex || 0, questions.length - 1));

  currentQuiz = {
    skillId: 'grammatika',
    topicId: null,
    isMarathon: true,
    type: 'mcq',
    questions: questions.map((q, idx) => ({
      ...q,
      picked: (state.answers && state.answers[idx] !== undefined) ? state.answers[idx] : null,
      timeLeft: 60,
      expired: false
    })),
    color: '#059669',
    bg: '#ECFDF5',
    label: 'Marafon',
    idx: startIdx,
    startedAt: Date.now()
  };

  const sideEl = document.getElementById('quizSide');
  if(sideEl){
    sideEl.style.display = 'none';
  }

  clearQuestionTimer();
  if(timerInterval) clearInterval(timerInterval);
  updateMarathonHeaderStats();

  buildQGrid();
  renderQuestion();
  showView('quiz');
  if(startIdx > 0 && !reset){
    toast(`🏃 Marafon: ${startIdx + 1}-savoldan davom etyapsiz (Jami: ${questions.length} ta savol)`, 3500);
  }
}

/* Asosiy sahifa (dashboard) raqamlari animatsiyasiz, darhol o'z qiymatida ko'rinadi */
runEntranceAnimations(document.getElementById('view-dashboard'), false, true);

/* Telegram autentifikatsiya + backend ma'lumotlarini yuklashni ishga tushirish */
bootApp();
