// YouTube exposes a reliable ad-state class on the player element, so this
// detector is precise and doesn't need the heuristic scoring used for the
// other platforms. It also clicks the "Skip" button as soon as it is usable.
(function () {
  const { reportAdState, debugLog, isSiteEnabled, isAutoSkipEnabled, onReady, onSettingsChange, contextAlive } =
    window.IntermissionCommon;
  const SITE_KEY = "youtube";

  // YouTube has renamed the skip button several times; keep every known form.
  const SKIP_SELECTORS = [
    ".ytp-skip-ad-button",
    ".ytp-ad-skip-button",
    ".ytp-ad-skip-button-modern",
    ".ytp-ad-skip-button-container button",
    ".ytp-skip-ad button",
    "button.ytp-ad-skip-button-modern",
  ];
  const SKIP_TEXT_RE = /^skip( ads?)?$/i;

  let lastState = null;
  let observer = null;
  let currentPlayer = null;
  let lastSkipClickAt = 0;
  const attempts = []; // recent skip attempts, included in the popup diagnostic

  function playerIsShowingAd(player) {
    return (
      player.classList.contains("ad-showing") ||
      player.classList.contains("ad-interrupting")
    );
  }

  function isUsable(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    // Before the countdown finishes YouTube keeps the button hidden or marked
    // disabled; clicking then does nothing and would waste the retry window.
    return !el.disabled && el.getAttribute("aria-disabled") !== "true";
  }

  function findSkipButton(player) {
    for (const sel of SKIP_SELECTORS) {
      for (const el of player.querySelectorAll(sel)) {
        if (isUsable(el)) return el;
      }
    }
    // Fallback for renamed classes (the "player-overlay-layout" ad UI uses
    // new names): any usable button whose class/label/text says "skip".
    for (const el of player.querySelectorAll('button, [role="button"]')) {
      const label = `${el.textContent || ""} ${el.getAttribute("aria-label") || ""}`.trim();
      const looksLikeSkip = SKIP_TEXT_RE.test(label) || /skip[-_ ]?ad/i.test(String(el.className));
      if (looksLikeSkip && isUsable(el)) return el;
    }
    return null;
  }

  // Dispatch the full pointer sequence: a bare .click() is ignored by some
  // YouTube builds that listen for pointerdown/mouseup rather than click.
  function pressButton(el) {
    const rect = el.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button: 0,
      pointerId: 1,
      isPrimary: true,
    };
    for (const type of ["pointerover", "pointerdown", "mousedown", "pointerup", "mouseup"]) {
      const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ctor(type, init));
    }
    el.click();
  }

  // YouTube ignores scripted (untrusted) clicks on the Skip button, so the
  // click rarely does anything. Verified on a live skippable ad: seeking the
  // ad's video to its end ends the ad and returns to the main video (on
  // unskippable ads YouTube resets the seek, which is the desired outcome).
  // Guard: only seek while the Skip button is still on screen, i.e. a
  // skippable ad is definitely still playing. Otherwise the click may have
  // worked and the <video> may already be the user's real video.
  function fastForwardAd(player, button) {
    if (!playerIsShowingAd(player)) return;
    if (!button.isConnected || !isUsable(button)) return;
    const video = player.querySelector("video");
    if (!video || !isFinite(video.duration) || video.duration <= 0 || video.duration > 180) return;
    debugLog("click ignored; seeking ad to end", video.duration);
    try {
      video.currentTime = video.duration;
    } catch (e) {}
  }

  function trySkip(player) {
    if (!isAutoSkipEnabled() || !isSiteEnabled(SITE_KEY)) return;
    if (!playerIsShowingAd(player)) return;
    const now = Date.now();
    if (now - lastSkipClickAt < 2500) return; // one attempt at a time
    const button = findSkipButton(player);
    if (!button) return;
    lastSkipClickAt = now;
    const attempt = {
      at: new Date().toISOString(),
      cls: String(button.className),
      method: "trusted-click",
      trustedOk: null,
      error: null,
      adStillShowingAfter1s: null,
    };
    attempts.push(attempt);
    if (attempts.length > 8) attempts.shift();
    debugLog("auto-skipping ad", button.className);

    // YouTube ignores scripted clicks (isTrusted is false), so ask the
    // background script to click through the debugger, which is trusted.
    try {
      chrome.runtime.sendMessage({ type: "TRUSTED_CLICK" }, (resp) => {
        void chrome.runtime.lastError;
        attempt.trustedOk = !!(resp && resp.ok);
        attempt.error = (resp && resp.error) || null;
        debugLog("trusted click:", attempt.trustedOk, attempt.error || "");
        if (!attempt.trustedOk) {
          // Debugger unavailable (e.g. DevTools open on this tab): fall back
          // to a scripted click, then to seeking the ad to its end.
          attempt.method = "fallback";
          pressButton(button);
          setTimeout(() => fastForwardAd(player, button), 250);
        }
      });
    } catch (e) {}
    setTimeout(() => {
      attempt.adStillShowingAfter1s = playerIsShowingAd(player);
      debugLog("skip result: ad still showing =", attempt.adStillShowingAfter1s);
    }, 1500);
  }

  // The background asks for fresh coordinates right before it clicks, since
  // attaching the debugger shows an infobar that can shift the layout.
  try {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || message.type !== "GET_SKIP_RECT") return;
      const player = document.getElementById("movie_player");
      const button = player && findSkipButton(player);
      if (!button) return sendResponse(null);
      const r = button.getBoundingClientRect();
      sendResponse({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    });
  } catch (e) {}

  function snapshot() {
    const player = document.getElementById("movie_player");
    if (!player) return { error: "no #movie_player", url: location.href };
    const skipish = [...player.querySelectorAll("button, [role=button], [class*=skip i]")]
      .filter((el) => /skip/i.test(`${el.className} ${el.textContent} ${el.getAttribute("aria-label") || ""}`))
      .slice(0, 10)
      .map((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          tag: el.tagName,
          cls: String(el.className),
          text: (el.textContent || "").trim().slice(0, 30),
          rect: [Math.round(r.width), Math.round(r.height)],
          display: cs.display,
          visibility: cs.visibility,
          opacity: cs.opacity,
          pointerEvents: cs.pointerEvents,
          disabled: el.disabled,
          ariaDisabled: el.getAttribute("aria-disabled"),
          usable: isUsable(el),
          parentCls: String(el.parentElement && el.parentElement.className),
        };
      });
    const video = player.querySelector("video");
    return {
      url: location.href,
      playerClass: player.className,
      adShowing: playerIsShowingAd(player),
      autoSkipEnabled: isAutoSkipEnabled(),
      siteEnabled: isSiteEnabled(SITE_KEY),
      foundButton: !!findSkipButton(player),
      skipish,
      attempts,
      video: video && { t: video.currentTime, dur: video.duration, paused: video.paused },
      adMarkup: (player.querySelector(".video-ads") || { innerHTML: "" }).innerHTML
        .replace(/<svg[\s\S]*?<\/svg>/g, "<svg/>")
        .replace(/ style="[^"]*"/g, "")
        .slice(0, 6000),
    };
  }

  try {
    chrome.runtime.onMessage.addListener((message) => {
      if (message && message.type === "DIAGNOSE") {
        chrome.runtime.sendMessage({ type: "DIAG_RESULT", snapshot: snapshot() });
      }
    });
  } catch (e) {}

  function update(player) {
    if (!contextAlive()) return;
    if (!isSiteEnabled(SITE_KEY)) {
      // Turned off in the popup mid-ad: release the mute.
      if (lastState) {
        lastState = false;
        reportAdState(false, { reason: "site disabled" }, SITE_KEY);
      }
      return;
    }
    const isAd = playerIsShowingAd(player);
    if (isAd !== lastState) {
      lastState = isAd;
      debugLog(isAd ? "ad started" : "ad ended");
      reportAdState(isAd, { reason: "movie_player class" }, SITE_KEY);
    }
    trySkip(player);
  }

  function attach(player) {
    if (observer) observer.disconnect();
    currentPlayer = player;
    // class changes drive ad state; childList/subtree catches the skip button
    // being inserted or un-hidden inside the ad overlay.
    observer = new MutationObserver(() => update(player));
    observer.observe(player, {
      attributes: true,
      attributeFilter: ["class", "style", "disabled", "aria-disabled"],
      childList: true,
      subtree: true,
    });
    update(player);
  }

  function findPlayerAndAttach() {
    const player = document.getElementById("movie_player");
    if (player) {
      if (player !== currentPlayer) attach(player);
      else update(player);
      return true;
    }
    return false;
  }

  // YouTube is a single-page app; re-attach whenever it finishes navigating
  // to a new video, and poll in case the player node was swapped.
  document.addEventListener("yt-navigate-finish", () => {
    lastState = null;
    findPlayerAndAttach();
  });

  onReady(() => {
    onSettingsChange(() => {
      if (currentPlayer) update(currentPlayer);
    });
    findPlayerAndAttach();
    // Safety net: catches a missed mutation, a swapped player node, and the
    // moment a skip countdown finishes without a DOM change we observe.
    setInterval(findPlayerAndAttach, 500);
  });
})();
