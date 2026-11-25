/*
 * Setu Store vendor details: fills the theme's placeholders with the parts the
 * app embed rendered on the server into <template> elements:
 *   .setu-vendor-header, .setu-vendor-description   (product page)
 *   .setu-seller-header                             (a seller's collection page)
 *   .setu-all-brands                                (the Brands page)
 * A placeholder is filled again if the theme re-renders it (for example when
 * the buyer picks another variant). The seller header and the Brands list add
 * their own placeholder when the theme has none. setu-brands.js and
 * setu-feedback.js then run the Brands list and the Feedback block.
 */
(function () {
  var PARTS = [
    { spot: "setu-vendor-header", tpl: "setu-vendor-header-tpl" },
    { spot: "setu-vendor-description", tpl: "setu-vendor-description-tpl" },
    { spot: "setu-seller-header", tpl: "setu-seller-header-tpl" },
    { spot: "setu-all-brands", tpl: "setu-all-brands-tpl" },
  ];

  function mainContent() {
    return document.getElementById("MainContent") || document.querySelector("main") || document.body;
  }

  /* The theme's own collection title repeats the seller's name: hide it when asked. */
  function hideThemeTitle(tpl) {
    var title = (tpl.getAttribute("data-hide-title") || "").trim().toLowerCase();
    if (!title) return;
    var headings = mainContent().querySelectorAll("h1");
    for (var i = 0; i < headings.length; i++) {
      var h = headings[i];
      if (h.closest("[data-setu-vendor]")) continue;
      if ((h.textContent || "").trim().toLowerCase() === title) h.hidden = true;
    }
  }

  function fill() {
    var filled = false;
    PARTS.forEach(function (part) {
      var tpl = document.getElementById(part.tpl);
      if (!tpl || !tpl.content || !tpl.content.firstElementChild) return;
      var spots = document.querySelectorAll("." + part.spot);
      var auto = tpl.getAttribute("data-auto");
      if (!spots.length && auto && !tpl.hasAttribute("data-placed")) {
        tpl.setAttribute("data-placed", "");
        var spot = document.createElement("div");
        spot.className = part.spot + " " + part.spot + "--auto";
        var main = mainContent();
        if (auto === "top") main.insertBefore(spot, main.firstChild);
        else main.appendChild(spot);
        spots = [spot];
      }
      for (var i = 0; i < spots.length; i++) {
        if (spots[i].querySelector("[data-setu-vendor]")) continue;
        spots[i].replaceChildren(tpl.content.cloneNode(true));
        hideThemeTitle(tpl);
        filled = true;
      }
    });
    // setu-brands.js and setu-feedback.js start what was just put on the page.
    if (filled) document.dispatchEvent(new CustomEvent("setu:filled"));
  }

  /* ---------------------------------------------------------------- start */

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
