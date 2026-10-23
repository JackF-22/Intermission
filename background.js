const MAX_LOG_ENTRIES = 50;

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["enabledSites", "debug"], (stored) => {
    const defaults = {};
    if (!stored.enabledSites) {
      defaults.enabledSites = {
        youtube: true,
        hulu: true,
        disneyplus: true,
        peacock: true,
        hbomax: true,
      };
    }
    if (stored.debug === undefined) defaults.debug = false;
    if (Object.keys(defaults).length) chrome.storage.local.set(defaults);
  });
});

function appendLog(entry) {
  chrome.storage.local.get(["adMuteLog"], ({ adMuteLog }) => {
    const log = adMuteLog || [];
    log.push(entry);
    while (log.length > MAX_LOG_ENTRIES) log.shift();
    chrome.storage.local.set({ adMuteLog: log });
  });
}

// Per-tab "what's happening right now" state, so the popup can show a live
// status instead of only a historical log. Lives in session storage (not
// local) since it's only meaningful for the current browsing session.
function setTabState(tabId, state) {
  chrome.storage.session.get(["tabState"], ({ tabState }) => {
    const updated = { ...(tabState || {}), [tabId]: state };
    chrome.storage.session.set({ tabState: updated });
  });
}

function clearTabState(tabId) {
  chrome.storage.session.get(["tabState"], ({ tabState }) => {
    if (!tabState || !(tabId in tabState)) return;
    const updated = { ...tabState };
    delete updated[tabId];
    chrome.storage.session.set({ tabState: updated });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "AD_STATE" && sender.tab) {
    const tabId = sender.tab.id;

    chrome.tabs.update(tabId, { muted: message.isAd }, () => {
      if (chrome.runtime.lastError) {
        // Tab may have closed/navigated away mid-flight; nothing to do.
      }
    });

    setTabState(tabId, {
      site: message.site,
      isAd: message.isAd,
      detail: message.detail,
      ts: message.ts,
    });

    appendLog({
      site: message.site,
      isAd: message.isAd,
      detail: message.detail,
      ts: message.ts,
    });
    return;
  }

  if (message.type === "GET_TAB_STATE") {
    const tabId = message.tabId;
    chrome.storage.session.get(["tabState"], ({ tabState }) => {
      sendResponse({ state: (tabState && tabState[tabId]) || null });
    });
    return true; // keep the message channel open for the async sendResponse
  }
});

chrome.tabs.onRemoved.addListener((tabId) => clearTabState(tabId));

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // A fresh navigation invalidates whatever ad state we knew about this tab.
  if (changeInfo.status === "loading" && changeInfo.url) {
    clearTabState(tabId);
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "toggle-mute") return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab) return;
    chrome.tabs.update(tab.id, { muted: !tab.mutedInfo?.muted });
  });
});
