// Same caveat as hulu.js: selectors are unverified best guesses since
// Disney+'s player is minified and I have no way to inspect a live ad
// break from here. Enable "debug" in the popup to calibrate.
(function () {
  window.IntermissionHeuristics.start("disneyplus", {
    selectors: [
      '[data-testid*="ad-timer"]',
      '[data-testid*="ad-banner"]',
      '[data-testid*="ad-indicator"]',
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
    ],
  });
})();
