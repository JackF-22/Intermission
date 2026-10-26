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

// chrome.storage read-modify-write is not atomic. Two messages arriving close
// together (e.g. initial report + ad start) would both read the old value and
// the later write would clobber the earlier one, so every update to a given
// key goes through one promise chain.
let storageQueue = Promise.resolve();
function updateStorage(area, key, mutate) {
  storageQueue = storageQueue
    .then(
      () =>
        new Promise((resolve) => {
          chrome.storage[area].get([key], (data) => {
            const next = mutate(data[key]);
            if (next === undefined) return resolve();
            chrome.storage[area].set({ [key]: next }, resolve);
          });
        })
    )
    .catch(() => {});
  return storageQueue;
}

function appendLog(entry) {
  updateStorage("local", "adMuteLog", (log) => {
    const next = (log || []).concat(entry);
    while (next.length > MAX_LOG_ENTRIES) next.shift();
    return next;
  });
}

// Per-tab "what's happening right now" state, so the popup can show a live
// status instead of only a historical log. Lives in session storage (not
// local) since it's only meaningful for the current browsing session.
function setTabState(tabId, state) {
  updateStorage("session", "tabState", (tabState) => ({ ...(tabState || {}), [tabId]: state }));
}

function clearTabState(tabId) {
  updateStorage("session", "tabState", (tabState) => {
    if (!tabState || !(tabId in tabState)) return undefined;
    const updated = { ...tabState };
    delete updated[tabId];
    return updated;
  });
}

// Tabs that *we* muted for an ad. We only unmute those, so a tab the user had
// muted themselves stays muted after the ad ends. Also lets us release the
// mute if the tab navigates away from a supported site mid-ad (the content
// script that would have reported "ad over" is gone by then).
function markMutedByUs(tabId, value) {
  return updateStorage("session", "mutedByUs", (map) => {
    const next = { ...(map || {}) };
    if (value) next[tabId] = true;
    else delete next[tabId];
    return next;
  });
}

function getMutedByUs(tabId) {
  return new Promise((resolve) => {
    chrome.storage.session.get(["mutedByUs"], ({ mutedByUs }) => resolve(!!(mutedByUs && mutedByUs[tabId])));
  });
}

function setMuted(tabId, muted) {
  return new Promise((resolve) => {
    chrome.tabs.update(tabId, { muted }, () => {
      void chrome.runtime.lastError; // tab may have closed mid-flight
      resolve();
    });
  });
}

// Serialized so a fast "ad started" / "ad ended" pair can't interleave and
// leave the tab muted.
let muteQueue = Promise.resolve();
function applyAdState(tabId, isAd) {
  muteQueue = muteQueue.then(() => applyAdStateNow(tabId, isAd)).catch(() => {});
  return muteQueue;
}

// Did this extension apply the tab's current mute? Chrome records who muted a
// tab, which survives extension reloads (our own flag does not). That matters
// when an earlier build left a tab muted: the flag is gone, but the tab is
// still muted by us and would otherwise look like a deliberate user mute and
// stay silent forever.
function mutedByThisExtension(tab) {
  const info = tab && tab.mutedInfo;
  return !!(info && info.muted && info.reason === "extension" && info.extensionId === chrome.runtime.id);
}

function getFlag(key, tabId) {
  return new Promise((resolve) =>
    chrome.storage.session.get([key], (data) => resolve(!!(data[key] && data[key][tabId])))
  );
}

function setFlag(key, tabId, value) {
  return updateStorage("session", key, (map) => {
    const next = { ...(map || {}) };
    if (value) next[tabId] = true;
    else delete next[tabId];
    return next;
  });
}

async function applyAdStateNow(tabId, isAd) {
  const tab = await new Promise((resolve) =>
    chrome.tabs.get(tabId, (t) => {
      void chrome.runtime.lastError;
      resolve(t);
    })
  );
  if (!tab) return;
  const manual = await getFlag("manualMuted", tabId); // muted via our popup/shortcut on purpose
  const ours = (await getMutedByUs(tabId)) || (mutedByThisExtension(tab) && !manual);

  if (isAd) {
    if (tab.mutedInfo && tab.mutedInfo.muted) {
      if (ours) await markMutedByUs(tabId, true);
      return; // already muted: by the user, or by us for this same ad
    }
    await markMutedByUs(tabId, true);
    await setMuted(tabId, true);
  } else if (ours && tab.mutedInfo && tab.mutedInfo.muted) {
    await setMuted(tabId, false);
    await markMutedByUs(tabId, false);
  } else if (ours) {
    await markMutedByUs(tabId, false);
  }
}

function trackFrameAdState(tabId, frameId, isAd) {
  let result = isAd;
  return updateStorage("session", "adFrames", (all) => {
    const next = { ...(all || {}) };
    const frames = { ...(next[tabId] || {}) };
    if (isAd) frames[frameId] = true;
    else delete frames[frameId];
    result = Object.keys(frames).length > 0;
    if (result) next[tabId] = frames;
    else delete next[tabId];
    return next;
  }).then(() => result);
}

const HOST_KEYS = [
  [/(^|\.)youtube\.com$/, "youtube"],
  [/(^|\.)hulu\.com$/, "hulu"],
  [/(^|\.)disneyplus\.com$/, "disneyplus"],
  [/(^|\.)peacocktv\.com$/, "peacock"],
  [/(^|\.)(max|hbomax)\.com$/, "hbomax"],
];
function siteKeyForUrl(url) {
  try {
    const host = new URL(url).hostname;
    const hit = HOST_KEYS.find(([re]) => re.test(host));
    return hit ? hit[1] : null;
  } catch (e) {
    return null;
  }
}

// --- Trusted click on YouTube's Skip button ---------------------------------
// YouTube ignores synthetic clicks (event.isTrusted === false). The debugger
// protocol's Input.dispatchMouseEvent produces real input events. We attach
// only for the moment of the click, so Chrome's "started debugging" infobar
// is on screen for well under a second.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function debuggerCall(fn, ...args) {
  return new Promise((resolve, reject) => {
    fn(...args, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result);
    });
  });
}

let trustedClickBusy = false;
async function trustedClick(tabId) {
  if (trustedClickBusy) return { ok: false, error: "busy" };
  trustedClickBusy = true;
  const target = { tabId };
  let attached = false;
  try {
    await debuggerCall(chrome.debugger.attach.bind(chrome.debugger), target, "1.3");
    attached = true;
    await sleep(200); // let the infobar settle before measuring
    const point = await new Promise((resolve) =>
      chrome.tabs.sendMessage(tabId, { type: "GET_SKIP_RECT" }, { frameId: 0 }, (r) => {
        void chrome.runtime.lastError;
        resolve(r);
      })
    );
    if (!point) return { ok: false, error: "skip button gone" };
    const send = (type, extra) =>
      debuggerCall(chrome.debugger.sendCommand.bind(chrome.debugger), target, "Input.dispatchMouseEvent", {
        type,
        x: point.x,
        y: point.y,
        ...extra,
      });
    await send("mouseMoved", {});
    await send("mousePressed", { button: "left", buttons: 1, clickCount: 1 });
    await send("mouseReleased", { button: "left", buttons: 0, clickCount: 1 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally {
    if (attached) {
      await sleep(100);
      chrome.debugger.detach(target, () => void chrome.runtime.lastError);
    }
    trustedClickBusy = false;
  }
}

// A mute the user asked for (popup button / shortcut) must survive ad-end
// unmuting, so flag it; unmuting it again clears the flag.
function setManualMute(tabId, muted) {
  return setFlag("manualMuted", tabId, muted).then(() => setMuted(tabId, muted));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "MANUAL_MUTE") {
    setManualMute(message.tabId, message.muted).then(() => sendResponse({ ok: true }));
    return true;
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "TRUSTED_CLICK" && sender.tab) {
    trustedClick(sender.tab.id).then(sendResponse);
    return true; // async response
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "AD_STATE" && sender.tab) {
    const tabId = sender.tab.id;

    // The player may live in a sub-frame: the tab counts as "in an ad" while
    // any frame says so.
    trackFrameAdState(tabId, sender.frameId, message.isAd).then((anyAd) => {
      applyAdState(tabId, anyAd);
      setTabState(tabId, {
        site: message.site,
        isAd: anyAd,
        detail: message.detail,
        ts: message.ts,
      });
    });

    // The initial "no ad yet" report on every page load would flood the log.
    if (!(message.detail && message.detail.initial && !message.isAd)) {
      appendLog({
        site: message.site,
        isAd: message.isAd,
        detail: message.detail,
        ts: message.ts,
      });
    }
    return;
  }

  if (message.type === "DIAG_RESULT" && sender.tab) {
    updateStorage("local", "diagnostic", (d) => ({
      ...(d || {}),
      [`${sender.tab.id}:${sender.frameId}`]: message.snapshot,
    }));
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

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabState(tabId);
  trackFrameAdState(tabId, -1, false);
  markMutedByUs(tabId, false);
  setFlag("manualMuted", tabId, false);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Streaming SPAs (Peacock, Disney+, etc.) rewrite the URL via the History
  // API on almost every click/overlay without actually reloading the page,
  // which still fires this listener. The content script is still alive in
  // that case, so only react when the tab moved to a different site, which
  // is the real signal that the page (and its content script) went away.
  if (!changeInfo.url) return;
  const newKey = siteKeyForUrl(changeInfo.url);
  chrome.storage.session.get(["tabState"], ({ tabState }) => {
    const current = tabState && tabState[tabId];
    if (!current || current.site === newKey) return;
    clearTabState(tabId);
    updateStorage("session", "adFrames", (all) => {
      if (!all || !all[tabId]) return undefined;
      const next = { ...all };
      delete next[tabId];
      return next;
    });
    applyAdState(tabId, false);
  });
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "toggle-mute") return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab) return;
    setManualMute(tab.id, !tab.mutedInfo?.muted);
  });
});
