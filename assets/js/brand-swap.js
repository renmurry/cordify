// Header subtitle: "DMS ⇄ decimal degrees" — the two words swap places now and then.
// One hops over, the other ducks under, and the arrow spins. Click to swap.
// Respects "reduce motion": no automatic swapping, and clicks swap without animation.
(function () {
  "use strict";
  const wrap = document.querySelector(".brand-sub");
  if (!wrap || !wrap.animate) {
    return;
  }
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const DURATION = 750;
  wrap.innerHTML =
    '<span class="sr-only">DMS to decimal degrees</span>' +
    '<span class="swap" aria-hidden="true" title="Click me">' +
    '<span class="swap-word">DMS</span><span class="swap-arrow">⇄</span><span class="swap-word">decimal degrees</span>' +
    "</span>";
  const box = wrap.querySelector(".swap");
  const arrow = wrap.querySelector(".swap-arrow");
  let busy = false;

  function swap(animate) {
    if (busy || !box.offsetParent) {
      return;
    }
    const words = [ ...box.querySelectorAll(".swap-word") ];
    const before = words.map(w => w.getBoundingClientRect().left);
    box.insertBefore(words[1], box.firstChild);
    box.appendChild(words[0]);
    if (!animate) {
      return;
    }
    busy = true;
    const after = words.map(w => w.getBoundingClientRect().left);
    words.forEach((w, i) => {
      const dx = before[i] - after[i];
      const hop = i === 0 ? -10 : 8;          // first word hops over, second ducks under
      w.animate([
        { transform: `translate(${dx}px, 0)` },
        { transform: `translate(${dx / 2}px, ${hop}px) scale(${i === 0 ? 1.08 : 0.94})`, offset: 0.5 },
        { transform: "translate(0, 0)" }
      ], { duration: DURATION, easing: "cubic-bezier(.55, 0, .3, 1)" });
    });
    arrow.animate([ { transform: "rotate(0deg)" }, { transform: "rotate(180deg)" } ], { duration: DURATION, easing: "ease-in-out" });
    setTimeout(() => {
      busy = false;
    }, DURATION);
  }

  box.addEventListener("click", () => swap(!reduce));
  if (!reduce) {
    setInterval(() => {
      if (!document.hidden) {
        swap(true);
      }
    }, 4000);
  }
})();
