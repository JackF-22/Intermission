// Same caveat as hulu.js: selectors are unverified best guesses. Enable
// "debug" in the popup and watch the console during a real ad break to
// calibrate against what Peacock actually renders.
(function () {
  window.AdMuteHeuristics.start("peacock", {
    selectors: [
      '[data-testid*="ad-indicator"]',
      '[data-testid*="ad-countdown"]',
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
