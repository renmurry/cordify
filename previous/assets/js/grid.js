/*
 * Cordify — "Also give Easting / Northing" (Convert tab)
 * One setting, kept on this device, used by the converter, the sheet and Batch
 * convert. The maths is in core.js; this file is only the picker.
 */
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const Core = () => window.CordifyCore;
  const KEY = "cordify_grid_v1";
  let state = { kind: "off", code: "", def: "" };

  function spec() {
    if (state.kind === "epsg") return "epsg:" + state.code.trim();
    if (state.kind === "custom") return "def:" + state.def.trim();
    return state.kind;
  }
  const info = () => Core().describeGrid(spec());
  const active = () => {
    const d = info();
    return !d.off && !d.error;
  };
  const project = (lat, lon) => active() ? Core().project(lat, lon, spec()) : null;

  // Spreadsheet cells for one point: [ [ "Easting", … ], [ "Northing", … ], [ "Grid", … ] ]
  function cells(lat, lon) {
    const p = lat == null || lon == null ? null : project(lat, lon);
    if (!p) return [ [ "Easting", "" ], [ "Northing", "" ], [ "Grid", "" ] ];
    if (p.error) return [ [ "Easting", "" ], [ "Northing", "" ], [ "Grid", p.error ] ];
    return [ [ "Easting", Core().formatGrid(p.e) ], [ "Northing", Core().formatGrid(p.n) ], [ "Grid", p.label + (p.epsg ? ` (EPSG:${p.epsg})` : "") ] ];
  }

  // Extra result lines for the converter, or "" when off.
  function lines(lat, lon) {
    const p = project(lat, lon);
    if (!p) return "";
    if (p.error) return `\nEasting / Northing: ${p.error}`;
    return `\nEasting (X): ${p.e.toFixed(3)}\nNorthing (Y): ${p.n.toFixed(3)}\n${p.label}${p.epsg ? ` (EPSG:${p.epsg})` : ""}`;
  }

  function render() {
    const sel = $("grid-system");
    if (!sel) return;
    sel.value = state.kind;
    $("grid-code-wrap").hidden = state.kind !== "epsg";
    $("grid-def-wrap").hidden = state.kind !== "custom";
    const d = info(), note = $("grid-note");
    const empty = state.kind === "epsg" && !state.code.trim() || state.kind === "custom" && !state.def.trim();
    note.className = "hint grid-note" + (d.error && !empty ? " bad" : "");
    note.textContent = d.off ? "" : d.error ? d.error : d.note ? `${d.label}. ${d.note}` : d.label + ".";
  }

  function changed() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {}
    render();
    window.dispatchEvent(new CustomEvent("cordify:grid-change"));
  }

  function init() {
    if (!$("grid-system")) return;
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || "null");
      if (s && typeof s.kind === "string") state = { kind: s.kind, code: String(s.code || ""), def: String(s.def || "") };
    } catch (e) {}
    if (![ ...$("grid-system").options ].some(o => o.value === state.kind)) state.kind = "off";
    $("grid-code").value = state.code;
    $("grid-def").value = state.def;
    $("grid-system").addEventListener("change", e => {
      state.kind = e.target.value;
      changed();
    });
    $("grid-code").addEventListener("input", e => {
      state.code = e.target.value;
      changed();
    });
    $("grid-def").addEventListener("input", e => {
      state.def = e.target.value;
      changed();
    });
    render();
  }

  window.CordifyGrid = { active, spec, project, cells, lines, label: () => active() ? info().label : "" };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
