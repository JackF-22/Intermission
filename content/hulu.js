// Hulu's player markup is obfuscated/minified and changes over time, so these
// selectors are best-effort guesses, not verified against a live ad break.
// The text-pattern and iframe-hint signals are more durable than the
// selectors below — if the selectors stop matching, those two will usually
// still catch the ad. Turn on "debug" in the popup and watch the console the
// next time an ad plays to see which signals actually fire, then adjust.
(function () {
  window.AdMuteHeuristics.start("hulu", {
    selectors: [
      '[data-automationid="ad-overlay"]',
      '[data-testid*="ad-countdown"]',
      '[data-testid*="ad-indicator"]',
      ".ad-overlay",
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
      "fwmrm.net",
    ],
  });
})();
