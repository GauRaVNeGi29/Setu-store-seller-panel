/*
 * Setu Store seller reviews: the signed-in buyer's form. setu-reviews.js loads
 * the reviews and says what this buyer can do ("setu:reviews"); this script
 * shows the "Write a review" button and form to a buyer whose order from the
 * seller has shipped, lists the products they can say it is about, fills in
 * their earlier review, and sends it. Loaded only
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
    var error = q("error"), thanks = q("thanks"), send = q("send"), picks = q("items");
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
      // One tick box for each product they have received from this seller, with its picture.
      var chosen = (mine && mine.items) || [];
      picks.replaceChildren();
      (me.items || []).forEach(function (i) {
        var label = document.createElement("label");
        label.className = "setu-reviews__pick";
        var box = document.createElement("input");
        box.type = "checkbox";
        box.name = "item";
        box.value = i.id;
        box.checked = chosen.indexOf(i.id) !== -1;
        label.appendChild(box);
        if (i.image) {
          var img = document.createElement("img");
          img.alt = "";
          img.width = img.height = 40;
          img.loading = "lazy";
          img.addEventListener("error", function () {
            img.remove();
          });
          img.src = i.image;
          label.appendChild(img);
        }
        var name = document.createElement("span");
        name.textContent = i.title;
        label.appendChild(name);
        picks.appendChild(label);
      });
      q("item-field").hidden = !(me.items || []).length;
      if (mine) {
        q("hidden-note").hidden = !mine.hidden;
        var radio = f.querySelector('input[name="rating"][value="' + mine.rating + '"]');
        if (radio) radio.checked = true;
        f.elements.comment.value = mine.comment || "";
        f.elements.name.value = mine.name || "";
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
