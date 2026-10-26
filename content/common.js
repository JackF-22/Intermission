// Shared helpers available to every content script (loaded first in manifest.json).
//
// Settings are cached in memory and kept fresh via storage.onChanged, so the
// hot paths (mutation observers, polling) never do an async storage read.
(function () {
  const HOST = location.hostname;
  const IS_TOP = window.top === window;
  const SETTINGS_DEFAULTS = { enabledSites: {}, debug: false, autoSkipYoutube: true };
  const settings = { ...SETTINGS_DEFAULTS };
  const readyCallbacks = [];
  let ready = false;

  // After the extension is reloaded/updated, orphaned content scripts keep
  // running but every chrome.* call throws. Detect that so they go quiet.
  function contextAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function applyStored(stored) {
    if (stored.enabledSites) settings.enabledSites = stored.enabledSites;
    if (stored.debug !== undefined) settings.debug = !!stored.debug;
    if (stored.autoSkipYoutube !== undefined) settings.autoSkipYoutube = !!stored.autoSkipYoutube;
  }

  try {
    chrome.storage.local.get(["enabledSites", "debug", "autoSkipYoutube"], (stored) => {
      applyStored(stored || {});
      ready = true;
      readyCallbacks.splice(0).forEach((cb) => cb());
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      const next = {};
      for (const key of ["enabledSites", "debug", "autoSkipYoutube"]) {
        if (changes[key]) next[key] = changes[key].newValue;
      }
      applyStored(next);
      // A key removed from storage reverts to its default.
      if (changes.enabledSites && !changes.enabledSites.newValue) settings.enabledSites = {};
      settings.changeListeners.forEach((cb) => cb());
    });
  } catch (e) {
    // Context already invalidated.
  }
  settings.changeListeners = [];

  function onReady(cb) {
    if (ready) cb();
    else readyCallbacks.push(cb);
  }

  function onSettingsChange(cb) {
    settings.changeListeners.push(cb);
  }

  function reportAdState(isAd, detail, siteKey) {
    if (!contextAlive()) return;
    try {
      chrome.runtime.sendMessage({
        type: "AD_STATE",
        site: siteKey,
        host: HOST,
        isTop: IS_TOP,
        isAd,
        detail: detail || null,
        ts: Date.now(),
      });
    } catch (e) {
      // Extension context can be invalidated on page navigation; ignore.
    }
  }

  function debugLog(...args) {
    if (settings.debug) console.log(`[Intermission:${HOST}]`, ...args);
  }

  // Synchronous: reads the in-memory cache. Treat a site as enabled until the
  // user explicitly turns it off.
  function isSiteEnabled(siteKey) {
    return settings.enabledSites[siteKey] !== false;
  }

  function isAutoSkipEnabled() {
    return settings.autoSkipYoutube !== false;
  }

  window.IntermissionCommon = {
    reportAdState,
    debugLog,
    isSiteEnabled,
    isAutoSkipEnabled,
    onReady,
    onSettingsChange,
    contextAlive,
    HOST,
    IS_TOP,
  };
})();
