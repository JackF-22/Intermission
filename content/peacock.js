// Peacock: site-specific signals only. The shared text patterns and class/test-id
// token detection live in adHeuristics.js. Selectors here are best-effort
// guesses (the player markup is minified and changes); turn on "debug" in the
// popup and watch the console during a real ad break to see which signals fire.
(function () {
  window.IntermissionHeuristics.start("peacock", {
    selectors: [
      '[data-testid^="ad-"]',
      '[data-testid$="-ad"]',
      // Inferred from a diagnostic copied during an ad: the only visible text
      // was a bare number, and this test id exists. Unconfirmed; if it also
      // appears outside ad breaks (e.g. a next-episode countdown), narrow it.
      '[data-testid="countdown"]',
    ],
    iframeHints: ["doubleclick.net", "imasdk.googleapis.com", "freewheel", "fwmrm.net"],
  });
})();
