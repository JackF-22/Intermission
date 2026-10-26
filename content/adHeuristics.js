// Generic ad-break detector for platforms with no stable public hook
// (Hulu, Disney+, Peacock, HBO Max/Max). These players obfuscate and change
// their markup regularly, so instead of hard-coding one selector, we score
// several weak signals and combine them. Every signal that fires is logged
// via debugLog (enable "debug" in the popup) so selectors/weights can be
// tuned against what you actually see during a real ad break.
//
// Call window.IntermissionHeuristics.start(siteKey, config) from a per-site file.
(function () {
  const { reportAdState, debugLog, isSiteEnabled, onReady, onSettingsChange, contextAlive, IS_TOP } =
    window.IntermissionCommon;

  // Text shown by ad badges/countdowns. Deliberately not anchored to the end
  // of the string: players append countdowns ("Ad 1 of 2 · 0:15"), so an
  // exact-match pattern misses the most common form.
  const DEFAULT_TEXT_PATTERNS = [
    /^(ad|ads|advertisement)$/i,
    /^ads?\s*\d+\s*(of|\/)\s*\d+/i, // "Ad 1 of 3", "Ad 1/3 · 0:15"
    /^ads?\s*[·•|:\-–—]\s*\d+(:\d{2})?\s*(s|sec|secs|seconds)?$/i, // "Ad • 0:15", "Ad: 15s"
    /^ad break\b/i,
    /\bads? (will )?(end|ends|resume|resumes) in\b/i,
    /\b(show|program|video|content|episode|movie) (will )?(resume|resumes|continue|continues|return|returns)\b/i,
    /\bresum(e|es|ing) (after|in)\b.*\bads?\b/i,
    /\bads? (remaining|left)\b/i,
  ];

  // Class/test-id tokens that denote an ad UI element. Plain substring
  // selectors like [data-testid*="ad-indicator"] also match "load-indicator"
  // (a spinner!), so tokens are tested with word boundaries instead.
  const AD_TOKEN_SUFFIX =
    "(?:break|timer|countdown|indicator|badge|overlay|marker|banner|unit|progress|counter|label|playing|slate|message|bug)";
  const AD_KEBAB_RE = new RegExp(`(?:^|[^a-z0-9])ads?[-_]${AD_TOKEN_SUFFIX}`, "i");
  // camelCase / PascalCase: "AdBreak", "playerAdTimer" (case-sensitive so
  // "download"/"headBanner" can't match).
  const AD_CAMEL_RE =
    /(?:^|[^A-Za-z])Ads?(?:Break|Timer|Countdown|Indicator|Badge|Overlay|Marker|Banner|Unit|Progress|Counter|Label|Playing|Slate|Message|Bug)|[a-z]Ads?(?:Break|Timer|Countdown|Indicator|Badge|Overlay|Marker|Banner|Unit|Progress|Counter|Label|Playing|Slate|Message|Bug)/;
  const CLASS_PREFILTER = '[class*="Ad"], [class*="ad-"], [class*="ad_"], [class*="ads-"], [class*="ads_"]';
  const ATTR_PREFILTER =
    '[data-testid*="ad" i], [data-automationid*="ad" i], [data-uia*="ad" i], [aria-label*="Ad" i]';

  // Test ids are kebab-case identifiers, so a standalone "ad" segment
  // ("pff-ad-countdown", "ad-label", "player-ad") is a strong signal. Plural
  // "ads" is deliberately excluded: it labels footer links ("footer-about-ads").
  const AD_SEGMENT_RE = /(?:^|[-_.:])ad(?:[-_.:]|$)/i;

  function tokenSignalsAd(value) {
    return AD_KEBAB_RE.test(value) || AD_CAMEL_RE.test(value);
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
  }

  // All roots to search: the document plus every open shadow root (Disney+,
  // Peacock and others render parts of their players inside web components).
  function collectRoots() {
    const roots = [document];
    for (let i = 0; i < roots.length; i++) {
      const walker = document.createTreeWalker(
        roots[i] === document ? document.documentElement : roots[i],
        NodeFilter.SHOW_ELEMENT
      );
      let node = walker.currentNode;
      while (node) {
        if (node.shadowRoot) roots.push(node.shadowRoot);
        node = walker.nextNode();
      }
    }
    return roots;
  }

  function start(siteKey, config) {
    const {
      selectors = [], // site-specific CSS selectors whose visible presence means an ad (weight 2)
      textPatterns = [], // extra RegExps, added to the shared defaults
      iframeHints = [], // substrings matched against iframe src (ad-tech iframes)
      excludeSelectors = [], // text/class hits inside these are ignored (page chrome, promo tiles, ad-break markers)
      onThreshold = 2, // score needed to flag "ad playing"
      offDelayMs = 2000, // score must stay below threshold this long before unmuting
      pollMs = 1000,
      maxAdMs = 8 * 60 * 1000, // failsafe: no real ad break lasts this long, so a signal stuck on must not mute the tab forever
      minScanGapMs = 400, // mutation bursts are coalesced to at most one scan per gap
    } = config;
    const patterns = DEFAULT_TEXT_PATTERNS.concat(textPatterns);
    const excludeSelector = excludeSelectors.join(", ");
    // Some players keep the whole site (home rows, promo banners labelled
    // "ADVERTISEMENT", footers) in the DOM underneath the video; those must
    // never count as an ad break.
    // Footers, nav bars and links never contain the player's ad badge.
    const CHROME_SELECTOR = "footer, nav, [role='contentinfo'], [role='navigation']";
    function isExcluded(el, allowLinks) {
      if (!el) return false;
      try {
        if (el.closest(CHROME_SELECTOR)) return true;
        if (!allowLinks && el.closest("a[href]")) return true;
        if (!excludeSelector) return false;
        return !!el.closest(excludeSelector);
      } catch (e) {
        return false;
      }
    }

    let adActive = false;
    let lastHits = []; // signals behind the most recent score, shown in the diagnostic
    let belowSince = null; // timestamp when the score first dropped below threshold
    let adStartedAt = 0;
    let suppressed = false; // set after the failsafe fires, until the signal clears once
    let lastScanAt = 0;
    let scanTimer = null;

    function scoreOnce() {
      let score = 0;
      const hits = [];
      const roots = collectRoots();

      // 1. Site-specific selectors (curated, so strongest weight).
      for (const sel of selectors) {
        for (const root of roots) {
          let matched = null;
          try {
            matched = root.querySelector(sel);
          } catch (e) {
            break;
          }
          if (matched && isVisible(matched) && !isExcluded(matched, true)) {
            score += 2;
            hits.push(`selector:${sel}`);
            break;
          }
        }
      }

      // 2. Visible short text such as "Ad 1 of 3" or "Ad · 0:15". Walk text
      // nodes rather than every element's textContent (which is O(n^2) on
      // deeply nested player markup), and count the signal once.
      let textHit = null;
      for (const root of roots) {
        const walker = document.createTreeWalker(
          root === document ? document.body || document.documentElement : root,
          NodeFilter.SHOW_TEXT
        );
        let node;
        while ((node = walker.nextNode())) {
          const raw = node.nodeValue;
          if (!raw || raw.length > 60) continue;
          const text = raw.trim();
          if (!text || text.length > 40) continue;
          const parent = node.parentElement;
          if (!parent || parent.closest("script, style, noscript")) continue;
          // Text split across sibling spans ("Ad" + "1 of 3") reads as one
          // label on its parent.
          const parentText = (parent.textContent || "").trim();
          const candidates = parentText.length <= 40 && parentText !== text ? [text, parentText] : [text];
          if (!candidates.some((c) => patterns.some((p) => p.test(c)))) continue;
          if (!isVisible(parent) || isExcluded(parent, true)) continue;
          textHit = candidates[candidates.length - 1];
          break;
        }
        if (textHit) break;
      }
      if (textHit) {
        score += 2;
        hits.push(`text:"${textHit}"`);
      }

      // 3. Class / test-id tokens that look like an ad UI element (weight 1,
      // so one stray match alone never mutes the tab).
      let tokenHit = null;
      let idHit = false;
      for (const root of roots) {
        for (const el of root.querySelectorAll(CLASS_PREFILTER + ", " + ATTR_PREFILTER)) {
          const haystack = [
            typeof el.className === "string" ? el.className : "",
            el.getAttribute("data-testid") || "",
            el.getAttribute("data-automationid") || "",
            el.getAttribute("data-uia") || "",
            el.getAttribute("aria-label") || "",
          ].join(" ");
          const ids = [el.getAttribute("data-testid"), el.getAttribute("data-automationid"), el.getAttribute("data-uia")];
          const idMatch = ids.some((v) => v && AD_SEGMENT_RE.test(v));
          if (!tokenSignalsAd(haystack) && !idMatch) continue;
          if (!isVisible(el) || isExcluded(el)) continue;
          idHit = idMatch;
          tokenHit = haystack.trim().slice(0, 60);
          break;
        }
        if (tokenHit) break;
      }
      if (tokenHit) {
        // An explicit "ad" test-id segment is as strong as a curated selector.
        score += idHit ? 2 : 1;
        hits.push(`token:${tokenHit}`);
      }

      // 4. Large visible ad-tech iframes (1x1 trackers are everywhere and
      // don't mean an ad is on screen).
      if (iframeHints.length) {
        for (const frame of document.querySelectorAll("iframe[src]")) {
          const src = frame.getAttribute("src") || "";
          if (!iframeHints.some((hint) => src.includes(hint))) continue;
          const rect = frame.getBoundingClientRect();
          if (rect.width < 200 || rect.height < 100 || !isVisible(frame)) continue;
          score += 1;
          hits.push(`iframe:${src.slice(0, 60)}`);
          break;
        }
      }

      lastHits = hits;
      if (hits.length) debugLog("signals", { score, hits });
      return score;
    }

    function setAd(isAd, detail) {
      adActive = isAd;
      adStartedAt = isAd ? Date.now() : 0;
      belowSince = null;
      debugLog(isAd ? "AD START" : "AD END", detail);
      reportAdState(isAd, detail, siteKey);
    }

    let reportedInitial = false;

    function evaluate() {
      scanTimer = null;
      lastScanAt = Date.now();
      if (!contextAlive()) return;

      if (!isSiteEnabled(siteKey)) {
        // Turned off in the popup mid-ad: release the mute.
        if (adActive) setAd(false, { reason: "site disabled" });
        return;
      }

      const score = scoreOnce();

      if (!reportedInitial) {
        // Always send one report right away so the popup/background know
        // this tab is on a supported site, even if no ad is playing yet.
        // Sub-frames (the player may live in an iframe) stay silent until
        // they see an ad, so an empty frame can't overwrite the top frame.
        reportedInitial = true;
        adActive = score >= onThreshold;
        if (adActive) adStartedAt = Date.now();
        debugLog("initial state", { score, isAd: adActive });
        if (IS_TOP || adActive) reportAdState(adActive, { score, initial: true }, siteKey);
        return;
      }

      if (!adActive) {
        if (score < onThreshold) suppressed = false;
        else if (!suppressed) setAd(true, { score });
        return;
      }

      if (Date.now() - adStartedAt > maxAdMs) {
        debugLog("ad signal stuck on; releasing mute", lastHits);
        suppressed = true;
        setAd(false, { reason: "failsafe timeout", hits: lastHits });
        return;
      }

      // Ad active. Unmute only after the signal has been absent for a
      // sustained period (time-based: DOM mutation bursts must not count as
      // several "clean reads"), which also bridges the gap between
      // consecutive ads in one break.
      if (score >= onThreshold) {
        belowSince = null;
      } else {
        const now = Date.now();
        if (belowSince === null) belowSince = now;
        if (now - belowSince >= offDelayMs) setAd(false, { score });
      }
    }

    function scheduleScan() {
      if (scanTimer !== null) return;
      const wait = Math.max(0, minScanGapMs - (Date.now() - lastScanAt));
      scanTimer = setTimeout(evaluate, wait);
    }

    // "Copy diagnostic" in the popup asks every frame for a snapshot of what
    // it can see, so the detector can be tuned against a real ad break.
    function snapshot() {
      const texts = new Set();
      const tokens = [];
      for (const root of collectRoots()) {
        const walker = document.createTreeWalker(
          root === document ? document.body || document.documentElement : root,
          NodeFilter.SHOW_TEXT
        );
        let node;
        while ((node = walker.nextNode()) && texts.size < 120) {
          const t = (node.nodeValue || "").trim();
          if (t && t.length <= 40 && node.parentElement && isVisible(node.parentElement)) texts.add(t);
        }
        for (const el of root.querySelectorAll(CLASS_PREFILTER + ", " + ATTR_PREFILTER)) {
          if (tokens.length >= 40) break;
          if (!isVisible(el)) continue;
          tokens.push({
            tag: el.tagName,
            cls: String(el.className).slice(0, 120),
            testid: el.getAttribute("data-testid"),
            auto: el.getAttribute("data-automationid"),
            label: el.getAttribute("aria-label"),
            text: (el.textContent || "").trim().slice(0, 40),
          });
        }
      }
      const testIds = new Set();
      const hiddenTexts = new Set();
      for (const root of collectRoots()) {
        for (const el of root.querySelectorAll("[data-testid], [data-automationid], [data-uia]")) {
          if (testIds.size >= 200) break;
          testIds.add(el.getAttribute("data-testid") || el.getAttribute("data-automationid") || el.getAttribute("data-uia"));
        }
        // Short text that exists in the DOM but is faded/hidden (player
        // controls usually auto-hide, which would hide the ad label too).
        const walker = document.createTreeWalker(
          root === document ? document.body || document.documentElement : root,
          NodeFilter.SHOW_TEXT
        );
        let node;
        while ((node = walker.nextNode()) && hiddenTexts.size < 80) {
          const t = (node.nodeValue || "").trim();
          if (t && t.length <= 40 && node.parentElement && !texts.has(t)) hiddenTexts.add(t);
        }
      }
      const testIdTexts = {};
      for (const root of collectRoots()) {
        for (const el of root.querySelectorAll("[data-testid]")) {
          const t = (el.textContent || "").trim();
          if (t && t.length <= 40 && Object.keys(testIdTexts).length < 60) {
            testIdTexts[el.getAttribute("data-testid")] = { text: t, visible: isVisible(el) };
          }
        }
      }
      return {
        testIdTexts,
        title: document.title,
        testIds: [...testIds],
        hiddenShortTexts: [...hiddenTexts],
        url: location.href,
        isTop: IS_TOP,
        frameSize: [innerWidth, innerHeight],
        adActive,
        score: scoreOnce(),
        signalsFired: lastHits,
        videos: [...document.querySelectorAll("video")].map((v) => ({
          paused: v.paused,
          rate: v.playbackRate,
          readyState: v.readyState,
          src: (v.currentSrc || v.src || "").slice(0, 80),
          cls: String(v.className).slice(0, 60),
          parentCls: String(v.parentElement && v.parentElement.className).slice(0, 80),
          t: Math.round(v.currentTime),
          dur: v.duration,
          muted: v.muted,
          rect: [Math.round(v.getBoundingClientRect().width), Math.round(v.getBoundingClientRect().height)],
        })),
        iframes: [...document.querySelectorAll("iframe")].map((f) => (f.getAttribute("src") || "").slice(0, 100)),
        visibleShortTexts: [...texts],
        adLikeElements: tokens,
      };
    }
    try {
      chrome.runtime.onMessage.addListener((message) => {
        if (message && message.type === "DIAGNOSE") {
          chrome.runtime.sendMessage({ type: "DIAG_RESULT", snapshot: snapshot() });
        }
      });
    } catch (e) {}

    onReady(() => {
      const observer = new MutationObserver(scheduleScan);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      setInterval(evaluate, pollMs);
      onSettingsChange(scheduleScan);
      evaluate();
    });
  }

  window.IntermissionHeuristics = { start, tokenSignalsAd, DEFAULT_TEXT_PATTERNS };
})();
