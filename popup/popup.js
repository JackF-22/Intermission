const siteCheckboxes = document.querySelectorAll("[data-site]");
const debugToggle = document.getElementById("debugToggle");
const autoSkipToggle = document.getElementById("autoSkipToggle");
const manualToggle = document.getElementById("manualToggle");
const logEl = document.getElementById("log");
const statusChip = document.getElementById("statusChip");
const statusHeadline = document.getElementById("statusHeadline");
const statusSub = document.getElementById("statusSub");

const SITE_LABELS = {
  youtube: "YouTube",
  hulu: "Hulu",
  disneyplus: "Disney+",
  peacock: "Peacock",
  hbomax: "Max / HBO Max",
};

let activeTabId = null;

function renderStatus(tab, tabState) {
  statusChip.classList.remove("status--ad", "status--show", "status--unknown");

  if (!tabState) {
    statusChip.classList.add("status--unknown");
    statusHeadline.textContent = "Not on a supported site";
    statusSub.textContent = "Open YouTube, Hulu, Disney+, Peacock, or Max";
    return;
  }

  const label = SITE_LABELS[tabState.site] || tabState.site;
  if (tabState.isAd) {
    statusChip.classList.add("status--ad");
    statusHeadline.textContent = "Ad break — muted";
  } else {
    statusChip.classList.add("status--show");
    statusHeadline.textContent = "Playing — sound on";
  }
  statusSub.textContent = label;
}

function renderManualButton(tab) {
  const muted = !!tab?.mutedInfo?.muted;
  manualToggle.textContent = muted ? "Unmute this tab" : "Mute this tab";
}

function loadActiveTabAndStatus() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab) return;
    activeTabId = tab.id;
    renderManualButton(tab);

    chrome.runtime.sendMessage({ type: "GET_TAB_STATE", tabId: tab.id }, (response) => {
      renderStatus(tab, response?.state || null);
    });
  });
}

function loadSettings() {
  chrome.storage.local.get(["enabledSites", "debug", "autoSkipYoutube", "adMuteLog"], (data) => {
    const enabledSites = data.enabledSites || {};
    siteCheckboxes.forEach((cb) => {
      const site = cb.dataset.site;
      cb.checked = enabledSites[site] !== false;
    });
    debugToggle.checked = !!data.debug;
    autoSkipToggle.checked = data.autoSkipYoutube !== false;
    renderLog(data.adMuteLog || []);
  });
}

function renderLog(entries) {
  logEl.innerHTML = "";
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "log-empty";
    empty.textContent = "No activity yet.";
    logEl.appendChild(empty);
    return;
  }
  entries
    .slice()
    .reverse()
    .forEach((entry) => {
      const div = document.createElement("div");
      div.className = `log-entry ${entry.isAd ? "ad-on" : "ad-off"}`;
      const time = new Date(entry.ts).toLocaleTimeString();
      const label = SITE_LABELS[entry.site] || entry.site;
      div.textContent = `${time}  ${label} — ${entry.isAd ? "muted" : "unmuted"}`;
      logEl.appendChild(div);
    });
}

siteCheckboxes.forEach((cb) => {
  cb.addEventListener("change", () => {
    chrome.storage.local.get(["enabledSites"], ({ enabledSites }) => {
      const updated = { ...(enabledSites || {}), [cb.dataset.site]: cb.checked };
      chrome.storage.local.set({ enabledSites: updated });
    });
  });
});

debugToggle.addEventListener("change", () => {
  chrome.storage.local.set({ debug: debugToggle.checked });
});

autoSkipToggle.addEventListener("change", () => {
  chrome.storage.local.set({ autoSkipYoutube: autoSkipToggle.checked });
});

document.getElementById("diagButton").addEventListener("click", (event) => {
  const button = event.currentTarget;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab) return;
    chrome.storage.local.remove("diagnostic", () => {
      // Delivered to every frame in the tab; each replies via the background.
      chrome.tabs.sendMessage(tab.id, { type: "DIAGNOSE" }, () => void chrome.runtime.lastError);
      setTimeout(() => {
        chrome.storage.local.get(["diagnostic"], async ({ diagnostic }) => {
          const text = JSON.stringify(diagnostic || "no content script responded", null, 1);
          try {
            await navigator.clipboard.writeText(text);
            button.textContent = "Copied to clipboard";
          } catch (e) {
            button.textContent = "Copy failed";
          }
        });
      }, 900);
    });
  });
});

manualToggle.addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab) return;
    const nextMuted = !tab.mutedInfo?.muted;
    chrome.runtime.sendMessage({ type: "MANUAL_MUTE", tabId: tab.id, muted: nextMuted }, () => {
      void chrome.runtime.lastError;
      renderManualButton({ mutedInfo: { muted: nextMuted } });
    });
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.adMuteLog) {
    renderLog(changes.adMuteLog.newValue || []);
  }
  if (areaName === "session" && changes.tabState && activeTabId != null) {
    const newState = changes.tabState.newValue?.[activeTabId] || null;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      renderStatus(tabs[0], newState);
    });
  }
});

loadActiveTabAndStatus();
loadSettings();
