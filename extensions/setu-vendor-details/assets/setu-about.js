/*
 * Setu Store seller page: the seller's description opens short (two lines)
 * with "See more", and "See less" folds it again. A description that already
 * fits in two lines gets no button. Without this script the whole description
 * shows.
 */
(function () {
  function about(box) {
    box.setAttribute("data-setu-ready", "");
    var text = box.querySelector("[data-setu-about-text]");
    var button = box.querySelector("[data-setu-about-toggle]");
    if (!text || !button) return;
    var open = false;

    /* Fold it, then see whether anything is cut off; if not, no button is needed. */
    function measure() {
      if (open) return;
      box.classList.add("is-short");
      var cut = text.scrollHeight > text.clientHeight + 1;
      button.hidden = !cut;
      if (!cut) box.classList.remove("is-short");
    }

    button.addEventListener("click", function () {
      open = !open;
      box.classList.toggle("is-short", !open);
      button.setAttribute("aria-expanded", open ? "true" : "false");
      button.textContent = button.getAttribute(open ? "data-less" : "data-more");
    });

    measure();
    window.addEventListener("resize", measure);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
  }

  function scan() {
    var found = document.querySelectorAll("[data-setu-about]:not([data-setu-ready])");
    for (var i = 0; i < found.length; i++) about(found[i]);
  }
  document.addEventListener("setu:filled", scan);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scan);
  else scan();
})();
