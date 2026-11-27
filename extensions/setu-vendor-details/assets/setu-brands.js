/*
 * Setu Store Brands list: sort, search, pages, and the arrows on each seller's
 * row of products. Works on a list already in the page (the All brands block)
 * and on one that setu-vendor.js puts there (it then sends "setu:filled").
 */
(function () {
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
   * make it as wide as the widest space around it inside the page's section, so
   * it lines up with the page title. A box that lays its content out in tracks
   * (a grid with margin columns, as newer themes use for the page width) only
   * offers the track our branch sits in, not its whole width. The list never
   * touches the edges of the screen: if the space found does, the page margin
   * is kept on both sides.
   */
  function widen(root) {
    if (!root.classList.contains("setu-brands--wide")) return;
    root.style.width = "";
    root.style.marginLeft = "";
    var own = root.getBoundingClientRect();
    var best = null;
    var child = root;
    for (var el = root.parentElement; el && el !== document.body; child = el, el = el.parentElement) {
      if (el.tagName === "MAIN" || el.classList.contains("shopify-section")) break;
      var cs = getComputedStyle(el);
      var tracks = /grid/.test(cs.display) || (/flex/.test(cs.display) && !/column/.test(cs.flexDirection));
      var r = (tracks ? child : el).getBoundingClientRect();
      var px = function (v) {
        return tracks ? 0 : parseFloat(cs[v]) || 0;
      };
      var left = r.left + px("paddingLeft") + px("borderLeftWidth");
      var width = r.width - px("paddingLeft") - px("paddingRight") - px("borderLeftWidth") - px("borderRightWidth");
      if (!best || width > best.width + 1) best = { left: left, width: width };
    }
    if (!best) return;
    var screen = document.documentElement.clientWidth;
    if (best.left < 1 && best.left + best.width > screen - 1) {
      var margin = parseFloat(getComputedStyle(root).getPropertyValue("--page-margin")) || Math.max(16, Math.min(40, screen * 0.03));
      best = { left: margin, width: screen - margin * 2 };
    }
    if (best.width <= own.width + 1) return;
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

  function scan() {
    var found = document.querySelectorAll("[data-setu-brands]:not([data-setu-ready])");
    for (var i = 0; i < found.length; i++) brands(found[i]);
  }
  document.addEventListener("setu:filled", scan);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scan);
  else scan();
})();
