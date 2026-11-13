// Tapping the "Cordify" name changes the look: Solid (the default: no blur, strongest
// contrast, best outdoors and on slow phones) -> Frost (glass) -> Neon -> Solid.
// The choice is kept on this device. The styles are at the end of styles.css; a
// one-line script in index.html applies the saved look before the page is drawn.
(function () {
  "use strict";
  const KEY = "cordify_look";
  const LOOKS = [ [ "", "Solid" ], [ "frost", "Frost" ], [ "neon", "Neon" ] ];
  const root = document.documentElement;
  const btn = document.getElementById("brand-look");
  if (!btn) {
    return;
  }
  const index = () => Math.max(0, LOOKS.findIndex(l => l[0] === (root.dataset.look || "")));
  const describe = () => btn.setAttribute("aria-label", `Cordify. Look: ${LOOKS[index()][1]}. Press to change the look.`);

  btn.addEventListener("click", () => {
    const next = LOOKS[(index() + 1) % LOOKS.length][0];
    if (next) {
      root.dataset.look = next;
    } else {
      delete root.dataset.look;
    }
    try {
      localStorage.setItem(KEY, next);
    } catch (e) {}
    describe();
    // The map measures itself; tell it the layout may have moved.
    window.dispatchEvent(new Event("resize"));
  });
  describe();
})();
