const siteCheckboxes = document.querySelectorAll("[data-site]");
const debugToggle = document.getElementById("debugToggle");
const manualToggle = document.getElementById("manualToggle");
const logEl = document.getElementById("log");

function loadSettings() {
  chrome.storage.local.get(["enabledSites", "debug", "adMuteLog"], (data) => {
    const enabledSites = data.enabledSites || {};
    siteCheckboxes.forEach((cb) => {
      const site = cb.dataset.site;
      cb.checked = enabledSites[site] !== false;
    });
    debugToggle.checked = !!data.debug;
    renderLog(data.adMuteLog || []);
  });
}

function renderLog(entries) {
  logEl.innerHTML = "";
  if (!entries.length) {
    logEl.textContent = "No activity yet.";
    return;
  }
  entries
    .slice()
    .reverse()
    .forEach((entry) => {
      const div = document.createElement("div");
      div.className = `log-entry ${entry.isAd ? "ad-on" : "ad-off"}`;
      const time = new Date(entry.ts).toLocaleTimeString();
      const detail = entry.detail ? ` (${JSON.stringify(entry.detail)})` : "";
      div.textContent = `${time} ${entry.site} — ${
        entry.isAd ? "MUTED (ad)" : "unmuted (show)"
      }${detail}`;
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

manualToggle.addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab) return;
    chrome.tabs.update(tab.id, { muted: !tab.mutedInfo?.muted });
  });
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.adMuteLog) renderLog(changes.adMuteLog.newValue || []);
});

loadSettings();
