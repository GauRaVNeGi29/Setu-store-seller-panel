/*
 * Setu Store "Ratings and reviews" on a seller's page: loads the seller's
 * reviews from the app (through the store's app proxy) when the section comes
 * near the screen, draws the rating, the bar for each number of stars and the
 * list, and re-sorts on request. Review text is always put on the page as
 * text, never as HTML. setu-review-form.js runs the buyer's form.
 */
(function () {
  function reviews(panel) {
    panel.setAttribute("data-setu-ready", "");
    var q = function (name) {
      return panel.querySelector("[data-setu-rv-" + name + "]");
    };
    var base = panel.getAttribute("data-url") + "?seller=" + encodeURIComponent(panel.getAttribute("data-seller"));
    var T = {};
    try {
      T = JSON.parse(q("text").textContent);
    } catch (e) {
      T = {};
    }
    var status = q("status"), list = q("list"), more = q("more"), bars = q("bars"), sort = q("sort");
    var started = false, page = 1;

    function el(tag, cls, text) {
      var e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    }

    function stars(value) {
      var s = el("span", "setu-stars setu-stars--review");
      s.setAttribute("role", "img");
      s.setAttribute("aria-label", (T.stars || "%r out of 5 stars").replace("%r", value));
      var row = el("span", "setu-stars__row", "★★★★★");
      row.setAttribute("aria-hidden", "true");
      var on = el("span", "setu-stars__on", "★★★★★");
      on.style.width = Math.max(0, Math.min(100, Number(value) * 20)) + "%";
      row.appendChild(on);
      s.appendChild(row);
      return s;
    }

    function addReviews(items) {
      items.forEach(function (r) {
        var li = el("li", "setu-reviews__item");
        li.appendChild(stars(r.rating));
        if (r.comment) li.appendChild(el("p", "setu-reviews__text", r.comment));
        var when = new Date(r.date);
        var day = isNaN(when) ? "" : when.toLocaleDateString(document.documentElement.lang || "en", { day: "numeric", month: "short", year: "numeric" });
        var meta = el("p", "setu-reviews__meta");
        meta.appendChild(el("span", "", day + (r.edited ? " (" + (T.edited || "edited") + ")" : "")));
        meta.appendChild(el("span", "", r.author));
        if (r.item) meta.appendChild(el("span", "", (T.about || "About: %i").replace("%i", r.item)));
        li.appendChild(meta);
        list.appendChild(li);
      });
    }

    /* The rating, the number of reviews, and one bar for each number of stars (5 down to 1). */
    function summary(s) {
      q("score").hidden = !s.count;
      q("average").textContent = s.average || "";
      q("count").textContent = !s.count ? T.none || "" : s.count === 1 ? T.countOne || "" : (T.count || "").replace("%c", s.count);
      bars.hidden = !s.count;
      bars.replaceChildren();
      for (var n = 5; n >= 1 && s.count; n--) {
        var c = (s.breakdown || {})[n] || 0;
        var li = el("li", "setu-reviews__bar");
        li.setAttribute("aria-label", (T.bar || "").replace("%s", n).replace("%c", c));
        li.appendChild(el("span", "setu-reviews__bar-n", n));
        var track = el("span", "setu-reviews__bar-track");
        var fill = el("span", "setu-reviews__bar-fill");
        fill.style.width = Math.round((c / s.count) * 100) + "%";
        track.appendChild(fill);
        li.appendChild(track);
        li.appendChild(el("span", "setu-reviews__bar-c", c));
        for (var k = 0; k < li.children.length; k++) li.children[k].setAttribute("aria-hidden", "true");
        bars.appendChild(li);
      }
    }

    function show(data) {
      var s = data.summary || { count: 0 };
      summary(s);
      status.hidden = s.count > 0;
      if (!s.count) status.textContent = T.empty || "";
      q("sort-box").hidden = s.count < 2;
      list.replaceChildren();
      addReviews(data.reviews || []);
      more.hidden = !data.more;
      page = 1;
    }

    function get(extra) {
      return fetch(base + "&sort=" + encodeURIComponent(sort.value) + extra, { headers: { Accept: "application/json" }, credentials: "same-origin" })
        .then(function (r) {
          return r.json();
        })
        .then(function (data) {
          if (!data || !data.ok) throw new Error("not ok");
          return data;
        });
    }

    function failed() {
      status.hidden = false;
      status.textContent = T.failed || "";
    }

    /* First load, and again after the buyer sends a review: also says what this buyer can do. */
    function load() {
      started = true;
      get("")
        .then(function (data) {
          show(data);
          panel.setuData = data;
          panel.dispatchEvent(new CustomEvent("setu:reviews", { detail: data }));
        })
        .catch(function () {
          started = false;
          failed();
        });
    }
    panel.addEventListener("setu:reviews-reload", load);

    sort.addEventListener("change", function () {
      list.setAttribute("aria-busy", "true");
      get("&only=list")
        .then(show)
        .catch(failed)
        .then(function () {
          list.removeAttribute("aria-busy");
        });
    });

    more.addEventListener("click", function () {
      more.disabled = true;
      get("&page=" + (page + 1))
        .then(function (data) {
          page += 1;
          addReviews(data.reviews || []);
          more.hidden = !data.more;
        })
        .catch(function () {})
        .then(function () {
          more.disabled = false;
        });
    });

    /* Reviews sit under the products: fetch them once the buyer scrolls near, or follows the rating link. */
    function near() {
      if (!started) load();
    }
    if (location.hash === "#SetuReviews" || !("IntersectionObserver" in window)) near();
    else {
      var seen = new IntersectionObserver(
        function (entries) {
          if (entries[0].isIntersecting) {
            seen.disconnect();
            near();
          }
        },
        { rootMargin: "600px 0px" }
      );
      seen.observe(panel);
      window.addEventListener("hashchange", function () {
        if (location.hash === "#SetuReviews") near();
      });
    }
  }

  function scan() {
    var found = document.querySelectorAll("[data-setu-reviews]:not([data-setu-ready])");
    for (var i = 0; i < found.length; i++) reviews(found[i]);
  }
  document.addEventListener("setu:filled", scan);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scan);
  else scan();
})();
