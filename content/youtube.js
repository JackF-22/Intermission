// YouTube exposes a reliable ad-state class on the player element, so this
// detector is precise and doesn't need the heuristic scoring used for the
// other platforms.
(function () {
  const { reportAdState, debugLog, isSiteEnabled } = window.IntermissionCommon;
  const SITE_KEY = "youtube";

  let lastState = null;
  let observer = null;

  function playerIsShowingAd(player) {
    return (
      player.classList.contains("ad-showing") ||
      player.classList.contains("ad-interrupting")
    );
  }

  function update(player) {
    isSiteEnabled(SITE_KEY, (enabled) => {
      if (!enabled) return;
      const isAd = playerIsShowingAd(player);
      if (isAd !== lastState) {
        lastState = isAd;
        debugLog(isAd ? "ad started" : "ad ended");
        reportAdState(isAd, { reason: "movie_player class" });
      }
    });
  }

  function attach(player) {
    if (observer) observer.disconnect();
    observer = new MutationObserver(() => update(player));
    observer.observe(player, { attributes: true, attributeFilter: ["class"] });
    update(player);
  }

  function findPlayerAndAttach() {
    const player = document.getElementById("movie_player");
    if (player) {
      attach(player);
      return true;
    }
    return false;
  }

  // YouTube is a single-page app; re-attach whenever it finishes navigating
  // to a new video, and poll briefly in case the player node was swapped.
  document.addEventListener("yt-navigate-finish", () => {
    lastState = null;
    findPlayerAndAttach();
  });

  if (!findPlayerAndAttach()) {
    const retry = setInterval(() => {
      if (findPlayerAndAttach()) clearInterval(retry);
    }, 1000);
  }

  // Safety net in case a mutation is missed (e.g. during fast skip-ahead).
  setInterval(() => {
    const player = document.getElementById("movie_player");
    if (player) update(player);
  }, 1000);
})();
