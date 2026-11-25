/*
 * Setu Store Feedback block on a seller's page: loads the seller's reviews
 * from the app (through the store's app proxy) when Feedback is opened, and
 * sends a signed-in buyer's review. Review text is always put on the page as
 * text, never as HTML.
 */
(function () {
  function feedback(panel) {
    panel.setAttribute("data-setu-ready", "");
    var q = function (name) {
      return panel.querySelector("[data-setu-fb-" + name + "]");
    };
    var url = panel.getAttribute("data-url");
    var seller = panel.getAttribute("data-seller");
    var T = {};
    try {
      T = JSON.parse(q("text").textContent);
    } catch (e) {
      T = {};
    }
    var status = q("status"), summary = q("summary"), list = q("list"), more = q("more"), write = q("write");
    var form = q("form"), error = q("error"), thanks = q("thanks"), send = q("send");
    var scope = panel.closest("[data-setu-vendor]") || document;
    var buttons = scope.querySelectorAll("[data-setu-feedback-open]");
    var loaded = false, page = 1;

    function stars(value) {
      var s = document.createElement("span");
      s.className = "setu-stars";
      s.setAttribute("role", "img");
      s.setAttribute("aria-label", (T.stars || "%r out of 5 stars").replace("%r", value));
      var row = document.createElement("span");
      row.className = "setu-stars__row";
      row.setAttribute("aria-hidden", "true");
      row.textContent = "\u2605\u2605\u2605\u2605\u2605";
      var on = document.createElement("span");
      on.className = "setu-stars__on";
      on.style.width = Math.max(0, Math.min(100, Number(value) * 20)) + "%";
      on.textContent = "\u2605\u2605\u2605\u2605\u2605";
      row.appendChild(on);
      s.appendChild(row);
      return s;
    }

    function el(tag, cls, text) {
      var e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    }

    function addReviews(reviews) {
      reviews.forEach(function (r) {
        var li = el("li", "setu-feedback__item");
        li.appendChild(stars(r.rating));
        if (r.comment) li.appendChild(el("p", "setu-feedback__text", r.comment));
        var meta = el("p", "setu-feedback__meta");
        meta.appendChild(el("span", "", r.author));
        var when = new Date(r.date);
        // Day first ("20 Nov 2026") for English; other languages use their own order.
        var lang = document.documentElement.lang || "en";
        var day = isNaN(when) ? "" : when.toLocaleDateString(/^en\b/i.test(lang) ? "en-GB" : lang, { day: "numeric", month: "short", year: "numeric" });
        meta.appendChild(el("span", "", day + (r.edited ? " (" + (T.edited || "edited") + ")" : "")));
        if (r.item) meta.appendChild(el("span", "", (T.about || "About: %i").replace("%i", r.item)));
        li.appendChild(meta);
        list.appendChild(li);
      });
    }

    function show(data) {
      var s = data.summary || { count: 0 };
      status.hidden = s.count > 0;
      if (!s.count) status.textContent = T.none || "No reviews yet.";
      summary.hidden = !s.count;
      summary.replaceChildren();
      if (s.count) {
        summary.appendChild(stars(s.average));
        summary.appendChild(el("span", "", (s.count === 1 ? T.summaryOne : T.summary || "").replace("%r", s.average).replace("%c", s.count)));
      }
      list.replaceChildren();
      addReviews(data.reviews || []);
      more.hidden = !data.more;
      page = 1;

      var me = data.me || {};
      write.hidden = false;
      if (!form) return; // signed out: the sign-in line is already there
      var mine = me.review;
      form.hidden = !me.canReview;
      q("cannot").hidden = !!me.canReview || !!me.unknown;
      q("unknown").hidden = !me.unknown;
      if (!me.canReview) return;
      var select = q("item");
      while (select.options.length > 1) select.remove(1);
      (me.items || []).forEach(function (i) {
        select.appendChild(new Option(i.title, i.id));
      });
      q("item-field").hidden = !(me.items || []).length;
      if (mine) {
        q("form-title").textContent = T.change || "Change your review";
        q("hidden-note").hidden = !mine.hidden;
        var radio = form.querySelector('input[name="rating"][value="' + mine.rating + '"]');
        if (radio) radio.checked = true;
        form.elements.comment.value = mine.comment || "";
        form.elements.name.value = mine.name || "";
        select.value = mine.item || "";
      }
    }

    function load() {
      loaded = true;
      fetch(url + "?seller=" + encodeURIComponent(seller), { headers: { Accept: "application/json" }, credentials: "same-origin" })
        .then(function (r) {
          return r.json();
        })
        .then(function (data) {
          if (!data || !data.ok) throw new Error("not ok");
          show(data);
        })
        .catch(function () {
          loaded = false;
          status.hidden = false;
          status.textContent = T.failed || "Reviews couldn't be loaded.";
        });
    }

    function toggle(open) {
      panel.hidden = !open;
      for (var i = 0; i < buttons.length; i++) buttons[i].setAttribute("aria-expanded", open ? "true" : "false");
      if (open) {
        if (!loaded) load();
        panel.focus({ preventScroll: true });
        if (panel.scrollIntoView) panel.scrollIntoView({ block: "nearest" });
      }
    }
    for (var b = 0; b < buttons.length; b++) {
      buttons[b].addEventListener("click", function () {
        toggle(panel.hidden);
      });
    }
    if (location.hash === "#SetuFeedback") toggle(true);

    more.addEventListener("click", function () {
      more.disabled = true;
      fetch(url + "?seller=" + encodeURIComponent(seller) + "&page=" + (page + 1), { headers: { Accept: "application/json" }, credentials: "same-origin" })
        .then(function (r) {
          return r.json();
        })
        .then(function (data) {
          more.disabled = false;
          if (!data || !data.ok) return;
          page += 1;
          addReviews(data.reviews || []);
          more.hidden = !data.more;
        })
        .catch(function () {
          more.disabled = false;
        });
    });

    if (form) {
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        error.hidden = true;
        thanks.hidden = true;
        var fields = new URLSearchParams(new FormData(form));
        if (!fields.get("rating")) {
          error.textContent = T.choose || "Choose a rating.";
          error.hidden = false;
          var first = form.querySelector('input[name="rating"]');
          if (first) first.focus();
          return;
        }
        fields.set("seller", seller);
        var label = send.textContent;
        send.disabled = true;
        send.textContent = T.sending || label;
        fetch(url, { method: "POST", body: fields, headers: { Accept: "application/json" }, credentials: "same-origin" })
          .then(function (r) {
            return r.json();
          })
          .then(function (data) {
            send.disabled = false;
            send.textContent = label;
            if (!data || !data.ok) {
              error.textContent = (data && data.error) || T.failed || "";
              error.hidden = false;
              return;
            }
            thanks.hidden = false;
            load();
          })
          .catch(function () {
            send.disabled = false;
            send.textContent = label;
            error.textContent = T.failed || "";
            error.hidden = false;
          });
      });
    }
  }

  function scan() {
    var found = document.querySelectorAll("[data-setu-feedback]:not([data-setu-ready])");
    for (var i = 0; i < found.length; i++) feedback(found[i]);
  }
  document.addEventListener("setu:filled", scan);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scan);
  else scan();
})();
