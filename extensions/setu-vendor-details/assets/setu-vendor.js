/*
 * Setu Store vendor details.
 *
 * 1. Fills the theme's placeholders with the parts the app embed rendered on
 *    the server into <template> elements:
 *      .setu-vendor-header, .setu-vendor-description   (product page)
 *      .setu-seller-header                             (a seller's collection page)
 *      .setu-all-brands                                (the Brands page)
 *    A placeholder is filled again if the theme re-renders it (for example
 *    when the buyer picks another variant). The seller header and the Brands
 *    list add their own placeholder when the theme has none.
 * 2. Runs the Brands list: sort, search, pages, and the arrows on each
 *    seller's row of products.
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
      }
    });
    var lists = document.querySelectorAll("[data-setu-brands]:not([data-setu-ready])");
    for (var j = 0; j < lists.length; j++) brands(lists[j]);
  }

  /* ---------------------------------------------------------------- Brands list */

  function brands(root) {
    root.setAttribute("data-setu-ready", "");
    var list = root.querySelector("[data-setu-list]");
    var rows = Array.prototype.slice.call(root.querySelectorAll("[data-setu-brand]"));
    var bar = root.querySelector("[data-setu-bar]");
    var sort = root.querySelector("[data-setu-sort]");
    var search = root.querySelector("[data-setu-search]");
    var none = root.querySelector("[data-setu-none]");
    var pager = root.querySelector("[data-setu-pager]");
    var perPage = Math.max(1, parseInt(root.getAttribute("data-per-page"), 10) || 10);
    var state = { order: "az", query: "", page: 1 };
    if (!list || !rows.length) return;
    if (bar) bar.hidden = false;

    function name(row) {
      return row.getAttribute("data-name") || "";
    }

    function apply(focusList) {
      var q = state.query.trim().toLowerCase();
      var shown = rows.filter(function (r) {
        return !q || name(r).indexOf(q) !== -1;
      });
      shown.sort(function (a, b) {
        var c = name(a).localeCompare(name(b), undefined, { numeric: true, sensitivity: "base" });
        return state.order === "za" ? -c : c;
      });
      var pages = Math.max(1, Math.ceil(shown.length / perPage));
      state.page = Math.min(Math.max(1, state.page), pages);
      var from = (state.page - 1) * perPage;
      var visible = shown.slice(from, from + perPage);

      rows.forEach(function (r) {
        r.hidden = visible.indexOf(r) === -1;
      });
      visible.forEach(function (r) {
        list.appendChild(r);
        arrows(r);
      });
      if (none) none.hidden = shown.length > 0;
      drawPager(pages);
      if (focusList) {
        var top = root.getBoundingClientRect().top;
        if (top < 0 && root.scrollIntoView) root.scrollIntoView({ block: "start" });
      }
    }

    function pageButton(label, text, page, current, disabled) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "setu-brands__page" + (current ? " is-current" : "");
      b.textContent = text;
      b.setAttribute("aria-label", label);
      if (current) b.setAttribute("aria-current", "page");
      b.disabled = !!disabled;
      b.addEventListener("click", function () {
        state.page = page;
        apply(true);
      });
      return b;
    }

    function drawPager(pages) {
      if (!pager) return;
      pager.hidden = pages <= 1;
      pager.replaceChildren();
      if (pages <= 1) return;
      var pageLabel = pager.getAttribute("data-label-page") || "Page %n";
      pager.appendChild(pageButton(pager.getAttribute("data-label-previous") || "Previous page", "←", state.page - 1, false, state.page === 1));
      for (var p = 1; p <= pages; p++) pager.appendChild(pageButton(pageLabel.replace("%n", p), String(p), p, p === state.page, false));
      pager.appendChild(pageButton(pager.getAttribute("data-label-next") || "Next page", "→", state.page + 1, false, state.page === pages));
    }

    if (sort) {
      sort.addEventListener("change", function () {
        state.order = sort.value === "za" ? "za" : "az";
        state.page = 1;
        apply(false);
      });
    }
    if (search) {
      search.addEventListener("input", function () {
        state.query = search.value;
        state.page = 1;
        apply(false);
      });
    }
    rows.forEach(scroller);
    widen(root);
    window.addEventListener("resize", function () {
      widen(root);
    });
    apply(false);
  }

  /*
   * A theme's page text often sits in a narrow column. When the list is in one,
   * make it as wide as the widest box around it inside the page's section, so
   * it lines up with the page title.
   */
  function widen(root) {
    if (!root.classList.contains("setu-brands--wide")) return;
    root.style.width = "";
    root.style.marginLeft = "";
    var own = root.getBoundingClientRect();
    var best = null;
    for (var el = root.parentElement; el && el !== document.body; el = el.parentElement) {
      if (el.tagName === "MAIN" || el.classList.contains("shopify-section")) break;
      var cs = getComputedStyle(el);
      var r = el.getBoundingClientRect();
      var left = r.left + (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.borderLeftWidth) || 0);
      var width = r.width - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0) - (parseFloat(cs.borderLeftWidth) || 0) - (parseFloat(cs.borderRightWidth) || 0);
      if (!best || width > best.width + 1) best = { left: left, width: width };
    }
    if (!best || best.width <= own.width + 1) return;
    root.style.width = best.width + "px";
    root.style.marginLeft = best.left - own.left + "px";
  }

  /* Arrows on a seller's row of products. Swiping and the keyboard work without them. */
  function scroller(row) {
    var track = row.querySelector("[data-setu-track]");
    var prev = row.querySelector("[data-setu-prev]");
    var next = row.querySelector("[data-setu-next]");
    if (!track || !prev || !next) return;
    function move(dir) {
      var by = Math.max(160, track.clientWidth * 0.8) * dir;
      if (track.scrollBy) track.scrollBy({ left: by, behavior: "smooth" });
      else track.scrollLeft += by;
    }
    prev.addEventListener("click", function () {
      move(-1);
    });
    next.addEventListener("click", function () {
      move(1);
    });
    var waiting = false;
    track.addEventListener(
      "scroll",
      function () {
        if (waiting) return;
        waiting = true;
        requestAnimationFrame(function () {
          waiting = false;
          arrows(row);
        });
      },
      { passive: true }
    );
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(function () {
        arrows(row);
      }).observe(track);
    }
  }

  function arrows(row) {
    var track = row.querySelector("[data-setu-track]");
    var prev = row.querySelector("[data-setu-prev]");
    var next = row.querySelector("[data-setu-next]");
    if (!track || !prev || !next) return;
    var max = track.scrollWidth - track.clientWidth;
    var overflow = max > 4;
    // Each arrow shows only while there is more to see in its direction.
    prev.hidden = !overflow || track.scrollLeft <= 2;
    next.hidden = !overflow || track.scrollLeft >= max - 2;
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
