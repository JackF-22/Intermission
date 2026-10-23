// Same caveat as hulu.js: selectors are unverified best guesses for
// Max/HBO Max's player. Enable "debug" in the popup and watch the console
// during a real ad break to calibrate.
(function () {
  window.AdMuteHeuristics.start("hbomax", {
    selectors: [
      '[data-testid*="ad-marker"]',
      '[data-testid*="ad-indicator"]',
      ".ad-indicator",
    ],
    textPatterns: [
      /^ad$/i,
      /^advertisement$/i,
      /^ad \d+ of \d+$/i,
      /your (program|show) will resume/i,
    ],
    iframeHints: [
      "doubleclick.net",
      "imasdk.googleapis.com",
      "adsafeprotected.com",
      "moatads.com",
      "freewheel",
    ],
  });
})();
