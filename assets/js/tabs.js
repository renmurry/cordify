/*
 * Cordify — the tabs (Convert, Map, History, Repair, Scan)
 * The one place that shows a tab and hides the others. Each tab has a button
 * (#tab-<name>) and a panel (#<name>-tab). Other files never touch the panels:
 * they call CordifyTabs.show(name), or click the button, and can be told when
 * their tab is shown with CordifyTabs.onShow(name, fn).
 */
(function () {
  "use strict";
  const NAMES = [ "convert", "map", "history", "repair", "scan" ];
  const $ = id => document.getElementById(id);
  const button = name => $(`tab-${name}`), panel = name => $(`${name}-tab`);
  const listeners = {};
  let current = "convert";

  function show(name) {
    if (!NAMES.includes(name) || !panel(name)) return;
    for (const n of NAMES) {
      const p = panel(n), b = button(n);
      if (p) p.style.display = n === name ? "" : "none";
      if (b) b.classList.toggle("is-active", n === name);
    }
    current = name;
    (listeners[name] || []).forEach(fn => {
      try {
        fn();
      } catch (e) {}
    });
  }

  function onShow(name, fn) {
    (listeners[name] = listeners[name] || []).push(fn);
  }

  function init() {
    for (const n of NAMES) button(n)?.addEventListener("click", () => show(n));
  }

  window.CordifyTabs = { show, onShow, current: () => current, NAMES };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
