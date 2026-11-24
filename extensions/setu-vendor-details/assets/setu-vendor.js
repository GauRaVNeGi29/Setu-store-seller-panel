/*
 * Setu Store vendor details: fills .setu-vendor-header and
 * .setu-vendor-description placeholders with the parts the app embed rendered
 * into <template> elements. Re-fills a placeholder if the theme re-renders it
 * (for example when the buyer picks another variant).
 */
(function () {
  var PARTS = ["header", "description"];

  function fill() {
    PARTS.forEach(function (part) {
      var tpl = document.getElementById("setu-vendor-" + part + "-tpl");
      if (!tpl || !tpl.content || !tpl.content.firstElementChild) return;
      var spots = document.querySelectorAll(".setu-vendor-" + part);
      for (var i = 0; i < spots.length; i++) {
        var spot = spots[i];
        if (spot.querySelector("[data-setu-vendor]")) continue;
        spot.replaceChildren(tpl.content.cloneNode(true));
      }
    });
  }

  function start() {
    fill();
    var queued = false;
    new MutationObserver(function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () {
        queued = false;
        fill();
      });
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
