// Shared helpers available to every content script (loaded first in manifest.json).
(function () {
  const SITE = location.hostname;

  function reportAdState(isAd, detail) {
    try {
      chrome.runtime.sendMessage({
        type: "AD_STATE",
        site: SITE,
        isAd,
        detail: detail || null,
        ts: Date.now(),
      });
    } catch (e) {
      // Extension context can be invalidated on page navigation; ignore.
    }
  }

  function debugLog(...args) {
    chrome.storage.local.get(["debug"], ({ debug }) => {
      if (debug) console.log(`[Intermission:${SITE}]`, ...args);
    });
  }

  function isSiteEnabled(siteKey, cb) {
    chrome.storage.local.get(["enabledSites"], ({ enabledSites }) => {
      const enabled = enabledSites ? enabledSites[siteKey] !== false : true;
      cb(enabled);
    });
  }

  window.IntermissionCommon = { reportAdState, debugLog, isSiteEnabled, SITE };
})();
