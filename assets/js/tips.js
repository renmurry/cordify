/*
 * Cordify tooltips
 * Any element with data-tip="…" shows a small tooltip on hover or keyboard focus.
 * Small "?" buttons (.help) also open their tip on tap, for phones.
 * The first time Advanced mode is switched on, a one-time hint points at the Repair tab.
 */
(function () {
  "use strict";
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.id = "cordify-tip";
  tip.setAttribute("role", "tooltip");
  document.body.appendChild(tip);
  let current = null, timer = null;

  function place(el) {
    const r = el.getBoundingClientRect();
    tip.style.maxWidth = Math.min(320, window.innerWidth - 24) + "px";
    tip.style.left = "0px";
    tip.style.top = "0px";
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = r.left + r.width / 2 - tw / 2;
    x = Math.max(12, Math.min(window.innerWidth - tw - 12, x));
    let y = r.bottom + 8;
    if (y + th > window.innerHeight - 8) y = Math.max(8, r.top - th - 8);
    tip.style.left = x + "px";
    tip.style.top = y + "px";
  }

  function show(el) {
    const text = el.getAttribute("data-tip");
    if (!text) return;
    if (current && current !== el) current.removeAttribute("aria-describedby");
    current = el;
    tip.textContent = text;
    tip.classList.add("show");
    place(el);
    el.setAttribute("aria-describedby", "cordify-tip");
  }

  function hide() {
    clearTimeout(timer);
    if (current) current.removeAttribute("aria-describedby");
    current = null;
    tip.classList.remove("show");
  }

  const hasHover = window.matchMedia && window.matchMedia("(hover: hover)").matches;
  if (hasHover) {
    document.addEventListener("mouseover", e => {
      const el = e.target.closest && e.target.closest("[data-tip]");
      if (el === current) return;
      clearTimeout(timer);
      if (!el) {
        hide();
        return;
      }
      timer = setTimeout(() => show(el), 400);
    });
  }
  document.addEventListener("focusin", e => {
    const el = e.target.closest && e.target.closest("[data-tip]");
    if (el && e.target.matches(":focus-visible")) show(el);
  });
  document.addEventListener("focusout", hide);
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") hide();
  });
  window.addEventListener("scroll", hide, true);
  window.addEventListener("resize", hide);
  // "?" help buttons toggle their tip on click/tap.
  document.addEventListener("click", e => {
    const h = e.target.closest && e.target.closest(".help[data-tip]");
    if (h) {
      e.preventDefault();
      e.stopPropagation();
      if (current === h) hide();
      else show(h);
    } else if (current && current.classList.contains("help")) {
      hide();
    }
  }, true);

  /* One-time hint after switching Advanced on */
  const box = document.getElementById("advanced-mode");
  const tab = document.getElementById("tab-repair");
  if (!box || !tab) return;
  let seen = false;
  try {
    seen = localStorage.getItem("cordify_hint_repair") === "1";
  } catch (e) {}
  box.addEventListener("change", () => {
    if (!box.checked || seen) return;
    seen = true;
    try {
      localStorage.setItem("cordify_hint_repair", "1");
    } catch (e) {}
    setTimeout(() => {
      if (tab.hidden || tab.classList.contains("is-active")) return;   // already on Repair: no hint needed
      const hint = document.createElement("div");
      hint.className = "coach";
      hint.setAttribute("role", "status");
      hint.innerHTML = '<b>New: Repair tab</b><span>Fix badly typed coordinates using a boundary you trust. Every change is marked for you to check.</span><button type="button" class="btn-quiet">Got it</button>';
      document.body.appendChild(hint);
      const r = tab.getBoundingClientRect();
      const w = Math.min(300, window.innerWidth - 24);
      hint.style.width = w + "px";
      hint.style.left = Math.max(12, Math.min(window.innerWidth - w - 12, r.left + r.width / 2 - w / 2)) + "px";
      hint.style.top = (r.bottom + 10) + "px";
      hint.style.setProperty("--arrow-x", Math.max(16, Math.min(w - 16, r.left + r.width / 2 - parseFloat(hint.style.left))) + "px");
      const close = () => {
        hint.remove();
        document.removeEventListener("click", outside, true);
      };
      const outside = e => {
        if (!hint.contains(e.target)) close();
      };
      hint.querySelector("button").addEventListener("click", close);
      tab.addEventListener("click", close, { once: true });
      setTimeout(() => document.addEventListener("click", outside, true), 0);
      setTimeout(close, 12000);
    }, 150);
  });
})();
