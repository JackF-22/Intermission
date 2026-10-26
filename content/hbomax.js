// Max / HBO Max: site-specific signals only. The shared text patterns and class/test-id
// token detection live in adHeuristics.js. Selectors here are best-effort
// guesses (the player markup is minified and changes); turn on "debug" in the
// popup and watch the console during a real ad break to see which signals fire.
(function () {
  window.IntermissionHeuristics.start("hbomax", {
    selectors: ['[data-testid^="ad-"]', '[data-testid$="-ad"]'],
    iframeHints: ["doubleclick.net", "imasdk.googleapis.com", "freewheel", "fwmrm.net"],
  });
})();
