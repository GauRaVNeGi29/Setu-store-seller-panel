/*
 * Setu Store seller reviews: the signed-in buyer's form. setu-reviews.js loads
 * the reviews and says what this buyer can do ("setu:reviews"); this script
 * shows the "Write a review" button and form to a buyer whose order from the
 * seller has shipped, fills in their earlier review, and sends it. Loaded only
 * for signed-in buyers.
 */
(function () {
  function form(panel) {
    panel.setAttribute("data-setu-form-ready", "");
    var q = function (name) {
      return panel.querySelector("[data-setu-rv-" + name + "]");
    };
    var f = q("form"), open = q("open");
    if (!f || !open) return;
    var error = q("error"), thanks = q("thanks"), send = q("send"), select = q("item");
    var T = {};
    try {
      T = JSON.parse(q("text").textContent);
    } catch (e) {
      T = {};
    }

    function toggle(show) {
      f.hidden = !show;
      open.setAttribute("aria-expanded", show ? "true" : "false");
    }
    open.addEventListener("click", function () {
      toggle(f.hidden);
      if (!f.hidden) {
        thanks.hidden = true;
        var first = f.querySelector('input[name="rating"]:checked') || f.querySelector('input[name="rating"]');
        if (first) first.focus();
      }
    });

    function state(data) {
      var me = (data && data.me) || {};
      var mine = me.review;
      open.hidden = !me.canReview;
      if (!me.canReview) toggle(false);
      q("cannot").hidden = !!me.canReview || !!me.unknown;
      q("unknown").hidden = !me.unknown;
      if (!me.canReview) return;
      open.textContent = mine ? T.change || "" : T.write || "";
      q("form-title").textContent = mine ? T.change || "" : q("form-title").textContent;
      while (select.options.length > 1) select.remove(1);
      (me.items || []).forEach(function (i) {
        select.appendChild(new Option(i.title, i.id));
      });
      q("item-field").hidden = !(me.items || []).length;
      if (mine) {
        q("hidden-note").hidden = !mine.hidden;
        var radio = f.querySelector('input[name="rating"][value="' + mine.rating + '"]');
        if (radio) radio.checked = true;
        f.elements.comment.value = mine.comment || "";
        f.elements.name.value = mine.name || "";
        select.value = mine.item || "";
      }
    }
    panel.addEventListener("setu:reviews", function (event) {
      state(event.detail);
    });
    if (panel.setuData) state(panel.setuData);

    f.addEventListener("change", function () {
      error.hidden = true;
    });

    f.addEventListener("submit", function (event) {
      event.preventDefault();
      error.hidden = true;
      thanks.hidden = true;
      var fields = new URLSearchParams(new FormData(f));
      if (!fields.get("rating")) {
        error.textContent = T.choose || "";
        error.hidden = false;
        var first = f.querySelector('input[name="rating"]');
        if (first) first.focus();
        return;
      }
      fields.set("seller", panel.getAttribute("data-seller"));
      var label = send.textContent;
      send.disabled = true;
      send.textContent = T.sending || label;
      fetch(panel.getAttribute("data-url"), { method: "POST", body: fields, headers: { Accept: "application/json" }, credentials: "same-origin" })
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
          toggle(false);
          thanks.hidden = false;
          open.focus();
          panel.dispatchEvent(new CustomEvent("setu:reviews-reload"));
        })
        .catch(function () {
          send.disabled = false;
          send.textContent = label;
          error.textContent = T.failed || "";
          error.hidden = false;
        });
    });
  }

  function scan() {
    var found = document.querySelectorAll("[data-setu-reviews]:not([data-setu-form-ready])");
    for (var i = 0; i < found.length; i++) form(found[i]);
  }
  document.addEventListener("setu:filled", scan);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scan);
  else scan();
})();
