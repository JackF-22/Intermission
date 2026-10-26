// Hulu: site-specific signals only. The shared text patterns and class/test-id
// token detection live in adHeuristics.js.
//
// Calibrated against a diagnostic copied during a real ad break:
//  - the timeline playhead gets the "--ad" modifier only while an ad plays;
//  - the ad label ("Ad") and countdown ("1:57") are visible text;
//  - the home page stays in the DOM under the player, including a promo tile
//    labelled "ADVERTISEMENT", and the timeline always renders markers for
//    upcoming ad breaks. Both must be excluded or the tab never unmutes.
(function () {
  window.IntermissionHeuristics.start("hulu", {
    selectors: [
      ".Timeline__playhead--ad",
      // From a diagnostic during a real ad: "Ad", the countdown and the
      // "visit advertiser's site" link live in this bar.
      ".AdUnitView__adBar",
      ".AdPlayer:not(.AdPlayer--hidden)",
      '[data-automationid="ad-overlay"]',
    ],
    excludeSelectors: [
      '[data-testid="level-one-content"]',
      '[data-testid="hub-collections-home"]',
      '[data-testid="global-navigation"]',
      '[data-testid^="footer"]',
      '[data-testid^="collection-"]',
      '[data-testid*="tile"]',
      ".TimelineAdBreaks",
      '[data-testid="adBreak"]',
    ],
    iframeHints: ["doubleclick.net", "imasdk.googleapis.com", "fwmrm.net"],
  });
})();
