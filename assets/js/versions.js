/*
 * Cordify — version menu
 * The live site can hold three channels (built by tools/publish-pages.js): Latest at the root,
 * Previous in previous/ and Preview in preview/, listed in channels.json at the root. This shows
 * which one you are on and links to the others. Without channels.json (a copy run locally, or
 * offline), nothing is shown.
 */
(function () {
  "use strict";
  const box = document.getElementById("version-menu");
  if (!box || !window.fetch) return;
  const m = location.pathname.match(/\/(previous|preview)\/(?:index\.html)?$/);
  const here = m ? m[1] : "latest";
  const root = new URL(m ? "../" : "./", location.href);
  const HELP = {
    latest: "The current release.",
    previous: "The release before. Use it if the latest gives you trouble.",
    preview: "Not released yet: try new features here first."
  };
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const when = d => {
    const t = new Date(`${d}T00:00:00`);
    return isNaN(t) ? "" : t.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  };

  function render(channels) {
    const cur = channels.find(c => c.id === here) || channels[0];
    const name = cur.id === "preview" ? "Preview" : cur.version;
    box.innerHTML = `<summary aria-label="Version: ${esc(cur.label)}, ${esc(cur.version)}. Choose another version.">${esc(name)}` +
      (cur.id === "previous" ? ` <span class="version-tag">previous</span>` : "") + `</summary>` +
      `<div class="version-list">` + channels.map(c => `<a href="${esc(new URL(c.path, root).href)}"${c.id === cur.id ? ' aria-current="page"' : ""}>` +
        `<b>${esc(c.label)}</b><span>${esc(c.version)}${c.date ? ` · ${esc(when(c.date))}` : ""}</span><small>${esc(HELP[c.id] || "")}</small></a>`).join("") +
      (channels.length > 1 ? `<p class="hint">Previous and Preview work online only. All versions share what this browser has saved.</p>` : "") + `</div>`;
    box.hidden = false;
  }

  fetch(new URL("channels.json", root), { cache: "no-store" })
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (data && Array.isArray(data.channels) && data.channels.length) render(data.channels);
    })
    .catch(() => {});

  // Close the menu when clicking elsewhere or pressing Escape.
  document.addEventListener("click", e => {
    if (box.open && !box.contains(e.target)) box.open = false;
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && box.open) box.open = false;
  });
})();
