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

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type !== "AD_STATE" || !sender.tab) return;
  const tabId = sender.tab.id;

  chrome.tabs.update(tabId, { muted: message.isAd }, () => {
    if (chrome.runtime.lastError) {
      // Tab may have closed/navigated away mid-flight; nothing to do.
    }
  });

  appendLog({
    site: message.site,
    isAd: message.isAd,
    detail: message.detail,
    ts: message.ts,
  });
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "toggle-mute") return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab) return;
    chrome.tabs.update(tab.id, { muted: !tab.mutedInfo?.muted });
  });
});
