(function(){
  try{
    var t = localStorage.getItem('arabication-theme');
    if(t !== 'dark') document.documentElement.setAttribute('data-theme','light');
  }catch(e){}

  // Telegram Mini App Safe Area & Fullscreen Inset boshqaruvi
  function applyTelegramSafeAreas(){
    try {
      var tg = window.Telegram && window.Telegram.WebApp;
      if (!tg) return;
      var topInset = (tg.contentSafeAreaInset && tg.contentSafeAreaInset.top) || (tg.safeAreaInset && tg.safeAreaInset.top) || 0;
      var bottomInset = (tg.contentSafeAreaInset && tg.contentSafeAreaInset.bottom) || (tg.safeAreaInset && tg.safeAreaInset.bottom) || 0;
      var leftInset = (tg.contentSafeAreaInset && tg.contentSafeAreaInset.left) || (tg.safeAreaInset && tg.safeAreaInset.left) || 0;
      var rightInset = (tg.contentSafeAreaInset && tg.contentSafeAreaInset.right) || (tg.safeAreaInset && tg.safeAreaInset.right) || 0;

      var root = document.documentElement;
      if (topInset > 0) root.style.setProperty('--tg-safe-top', topInset + 'px');
      if (bottomInset > 0) root.style.setProperty('--tg-safe-bottom', bottomInset + 'px');
      if (leftInset > 0) root.style.setProperty('--tg-safe-left', leftInset + 'px');
      if (rightInset > 0) root.style.setProperty('--tg-safe-right', rightInset + 'px');
    } catch(e){}
  }
  window.applyTelegramSafeAreas = applyTelegramSafeAreas;

  // Telegram Mini App Fullscreen & Expand darhol ishga tushishi
  function initTelegramFullscreen(){
    try {
      var tg = window.Telegram && window.Telegram.WebApp;
      if (!tg) return;
      tg.ready();
      if (typeof tg.expand === 'function') tg.expand();
      if (tg.isVersionAtLeast && tg.isVersionAtLeast('8.0') && typeof tg.requestFullscreen === 'function') {
        try { tg.requestFullscreen(); } catch(e){}
      }
      if (tg.isVersionAtLeast && tg.isVersionAtLeast('7.7') && typeof tg.disableVerticalSwipes === 'function') {
        try { tg.disableVerticalSwipes(); } catch(e){}
      }
      applyTelegramSafeAreas();
      if (tg.onEvent) {
        tg.onEvent('safeAreaChanged', applyTelegramSafeAreas);
        tg.onEvent('contentSafeAreaChanged', applyTelegramSafeAreas);
        tg.onEvent('viewportChanged', applyTelegramSafeAreas);
      }
    } catch(err){}
  }
  initTelegramFullscreen();
  document.addEventListener('DOMContentLoaded', initTelegramFullscreen);
  window.addEventListener('load', initTelegramFullscreen);
  document.addEventListener('click', function _tgFs(){
    initTelegramFullscreen();
    document.removeEventListener('click', _tgFs);
  }, { once: true, passive: true });
  document.addEventListener('touchstart', function _tgFsTouch(){
    initTelegramFullscreen();
    document.removeEventListener('touchstart', _tgFsTouch);
  }, { once: true, passive: true });
})();
