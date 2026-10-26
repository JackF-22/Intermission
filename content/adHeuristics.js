// Generic ad-break detector for platforms with no stable public hook
// (Hulu, Disney+, Peacock, HBO Max/Max). These players obfuscate and change
// their markup regularly, so instead of hard-coding one selector, we score
// several weak signals and combine them. Every signal that fires is logged
// via debugLog (enable "debug" in the popup) so selectors/weights can be
// tuned against what you actually see during a real ad break.
//
// Call window.IntermissionHeuristics.start(siteKey, config) from a per-site file.
(function () {
  const { reportAdState, debugLog, isSiteEnabled } = window.IntermissionCommon;

  function elementIsVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function start(siteKey, config) {
    const {
      selectors = [], // CSS selectors whose visible presence suggests an ad overlay/badge
      textPatterns = [], // RegExp list matched against short text nodes (ad badges, "Ad 1 of 3", countdowns)
      iframeHints = [], // substrings to match against iframe src (ad-tech iframes)
      onThreshold = 2, // score needed to flag "ad playing"
      offThreshold = 0, // score at/below which we flag "show resumed"
      pollMs = 700,
    } = config;

    let lastState = false;
    let consecutiveOff = 0;
    let hasReportedInitialState = false;

    function scoreOnce() {
      let score = 0;
      const hits = [];

      for (const sel of selectors) {
        let matched = null;
        try {
          matched = document.querySelector(sel);
        } catch (e) {
          continue;
        }
        if (matched && elementIsVisible(matched)) {
          score += 2;
          hits.push(`selector:${sel}`);
        }
      }

      if (textPatterns.length) {
        const candidates = document.querySelectorAll(
          "div, span, p, button"
        );
        for (const el of candidates) {
          const text = (el.textContent || "").trim();
          if (!text || text.length > 40) continue;
          if (!elementIsVisible(el)) continue;
          for (const pattern of textPatterns) {
            if (pattern.test(text)) {
              score += 2;
              hits.push(`text:"${text}"`);
              break;
            }
          }
        }
      }

      if (iframeHints.length) {
        const iframes = document.querySelectorAll("iframe[src]");
        for (const frame of iframes) {
          const src = frame.getAttribute("src") || "";
          if (iframeHints.some((hint) => src.includes(hint))) {
            score += 1;
            hits.push(`iframe:${src.slice(0, 60)}`);
          }
        }
      }

      if (hits.length) debugLog("signals", { score, hits });
      return score;
    }

    function evaluate() {
      isSiteEnabled(siteKey, (enabled) => {
        if (!enabled) return;
        const score = scoreOnce();

        if (!hasReportedInitialState) {
          // Always send one report right away so the popup/background know
          // this tab is on a supported site, even if no ad is playing yet.
          hasReportedInitialState = true;
          lastState = score >= onThreshold;
          debugLog("initial state", { score, isAd: lastState });
          reportAdState(lastState, { score, initial: true });
          return;
        }

        if (!lastState && score >= onThreshold) {
          lastState = true;
          consecutiveOff = 0;
          debugLog("AD START (score", score, ")");
          reportAdState(true, { score });
        } else if (lastState && score <= offThreshold) {
          consecutiveOff += 1;
          // Require two consecutive clean reads before unmuting, since a
          // single DOM mutation frame can transiently read as "no signal"
          // mid-transition.
          if (consecutiveOff >= 2) {
            lastState = false;
            debugLog("AD END (score", score, ")");
            reportAdState(false, { score });
          }
        } else if (lastState && score > offThreshold) {
          consecutiveOff = 0;
        }
      });
    }

    const observer = new MutationObserver(() => evaluate());
    observer.observe(document.body, { childList: true, subtree: true });
    setInterval(evaluate, pollMs);
    evaluate();
  }

  window.IntermissionHeuristics = { start };
})();
