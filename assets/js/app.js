function initializeApp() {
  // Initialize immediately. The converter, history, and batch tools do NOT
  // depend on Leaflet; the map is created lazily when the Map tab is first
  // opened (see initMap, which guards for a missing L). Gating startup on the
  // map CDN previously left every button dead whenever Leaflet was slow,
  // blocked, or offline.
  initCordifyApp();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeApp);
} else {
  initializeApp();
}

function initCordifyApp() {
  (function() {
    const MAX_HISTORY = 1e3;
    // Reading and writing coordinates lives in core.js, shared with Batch, the sheet and Repair.
    const Core = window.CordifyCore;
    const { parseDmsString, parseCoord, parseDecimal, splitPair, inLatRange, inLonRange } = Core;
    const ddToDms = (dd, latlon, secDigits = 3) => Core.formatDMS(dd, latlon, secDigits, true) || null;
    // The exact (unrounded) point behind each result box, for the map.
    const lastPoint = { dd: null, dms: null };
    const gridLines = (lat, lon) => window.CordifyGrid ? window.CordifyGrid.lines(lat, lon) : "";
    const gridOf = (lat, lon) => {
      const p = window.CordifyGrid ? window.CordifyGrid.project(lat, lon) : null;
      return p && !p.error ? p : undefined;
    };
    const OLD_KEY = "cordify_history_v1";
    function _fallback_getHistory() {
      try {
        const raw = localStorage.getItem(OLD_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
      } catch {
        return [];
      }
    }
    function _fallback_setHistory(arr) {
      try {
        localStorage.setItem(OLD_KEY, JSON.stringify(arr.slice(0, MAX_HISTORY)));
      } catch {}
    }
    function _fallback_addHistory(rec) {
      const arr = _fallback_getHistory();
      arr.unshift({
        type: rec.type || "",
        input: String(rec.input ?? ""),
        result: String(rec.result ?? ""),
        date: rec.date || Date.now(),
        lat: rec.lat,
        lon: rec.lon
      });
      _fallback_setHistory(arr);
    }
    function _fallback_removeByIndex(idx) {
      try {
        const arr = _fallback_getHistory();
        if (typeof idx !== "number" || idx < 0 || idx >= arr.length) {
          return false;
        }
        arr.splice(idx, 1);
        _fallback_setHistory(arr);
        return true;
      } catch {
        return false;
      }
    }
    function _fallback_clearHistory() {
      try {
        localStorage.removeItem(OLD_KEY);
      } catch {}
    }
    function getHistory() {
      if (window.historyStore && typeof window.historyStore.getAll === "function") {
        return window.historyStore.getAll().map(r => ({
          id: r.id,
          ts: r.ts || r.date,
          type: r.type || "",
          input: r.input || "",
          result: r.output || r.result || "",
          date: r.date || r.ts || r.ts,
          lat: r.lat,
          lon: r.lon,
          grid: r.grid
        }));
      }
      return _fallback_getHistory();
    }
    function addHistory(rec) {
      if (window.historyStore && typeof window.historyStore.add === "function") {
        try {
          window.historyStore.add({
            type: rec.type,
            input: String(rec.input ?? ""),
            output: String(rec.result ?? ""),
            date: rec.date,
            // Full-precision numbers, so the map and exports never depend on the rounded text.
            lat: rec.lat,
            lon: rec.lon,
            grid: rec.grid,
            meta: rec.meta || {}
          });
          return;
        } catch (e) {}
      }
      _fallback_addHistory(rec);
    }
    function clearHistory() {
      if (window.historyStore && typeof window.historyStore.clear === "function") {
        try {
          window.historyStore.clear();
          return;
        } catch (e) {}
      }
      _fallback_clearHistory();
    }
    function removeHistoryAt(indexOrId) {
      if (window.historyStore && typeof window.historyStore.remove === "function" && typeof indexOrId === "string") {
        try {
          return window.historyStore.remove(indexOrId);
        } catch (e) {}
      }
      if (window.historyStore && typeof window.historyStore.getAll === "function" && typeof indexOrId === "number") {
        try {
          const arr = window.historyStore.getAll();
          const rec = arr[indexOrId];
          if (rec && rec.id) {
            return window.historyStore.remove(rec.id);
          }
        } catch (e) {}
      }
      if (typeof indexOrId === "number") {
        return _fallback_removeByIndex(indexOrId);
      }
      return false;
    }
    async function migrateHistoryToStore() {
      if (!window.historyStore || typeof window.historyStore.add !== "function") {
        return;
      }
      try {
        const raw = localStorage.getItem(OLD_KEY);
        if (!raw) {
          return;
        }
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr) || !arr.length) {
          return;
        }
        const existing = new Set(window.historyStore.getAll().map(r => `${r.input}||${r.output}||${r.ts || r.date || ""}`));
        for (const it of arr) {
          const input = it.input || "";
          const output = it.result || it.output || "";
          const ts = it.date || it.ts || Date.now();
          const key = `${input}||${output}||${ts}`;
          if (existing.has(key)) {
            continue;
          }
          window.historyStore.add({
            type: it.type || "unknown",
            input: input,
            output: output,
            date: ts,
            meta: it.meta || {}
          });
        }
        try {
          localStorage.removeItem(OLD_KEY);
        } catch (e) {}
      } catch (e) {
      }
    }
    try {
      migrateHistoryToStore();
    } catch (e) {}
    window._cordify_addHistory = addHistory;
    (() => {
      try {
        migrateHistoryToStore();
      } catch (e) {}
      window.addEventListener("historyStore:change", () => {
        if (document.getElementById("history-tab")?.style.display !== "none") {
          renderHistoryTable();
        }
      });
      window.addEventListener("storage", e => {
        if (!e) {
          return;
        }
        if (e.key === "cordify_history_v2" || e.key === OLD_KEY) {
          if (document.getElementById("history-tab")?.style.display !== "none") {
            renderHistoryTable();
          }
        }
      });
      const convertTab = document.getElementById("convert-tab");
      const historyTab = document.getElementById("history-tab");
      const btnConvert = document.getElementById("tab-convert");
      const btnHistory = document.getElementById("tab-history");
      function setActive(btnOn, ...btnOffList) {
        btnOn?.classList.add("is-active");
        btnOffList.forEach(b => b?.classList.remove("is-active"));
      }
      const btnMap = document.getElementById("tab-map");
      function switchTab(tab) {
        if (convertTab) {
          convertTab.style.display = "none";
        }
        if (historyTab) {
          historyTab.style.display = "none";
        }
        const mapTabEl = document.getElementById("map-tab");
        if (mapTabEl) {
          mapTabEl.style.display = "none";
        }
        if (tab === "convert") {
          if (convertTab) {
            convertTab.style.display = "";
          }
          setActive(btnConvert, btnHistory, btnMap);
        } else if (tab === "history") {
          if (historyTab) {
            historyTab.style.display = "";
          }
          setActive(btnHistory, btnConvert, btnMap);
          renderHistoryTable();
        } else if (tab === "map") {
          if (mapTabEl) {
            mapTabEl.style.display = "";
          }
          setActive(btnMap, btnConvert, btnHistory);
          setTimeout(() => {
            if (!_map) {
              if (!initMap()) {
                const mapEl = document.getElementById("map");
                if (mapEl) {
                  mapEl.innerHTML = '<div style="padding: 20px; text-align: center; color: red;">Failed to load map. Please check your internet connection and try again.</div>';
                }
                return;
              }
            }
            if (_map && _map.invalidateSize) {
              _map.invalidateSize(true);
            }
          }, 100);
        }
      }
      btnConvert && (btnConvert.onclick = () => switchTab("convert"));
      btnHistory && (btnHistory.onclick = () => switchTab("history"));
      btnMap && (btnMap.onclick = () => switchTab("map"));
      switchTab("convert");
      document.getElementById("btn-dms2dd")?.addEventListener("click", () => updateDmsResult(true));
      document.getElementById("btn-dd2dms")?.addEventListener("click", () => updateDdResult(true));
      document.getElementById("btn-clear-dms")?.addEventListener("click", clearDmsInputs);
      document.getElementById("btn-clear-dd")?.addEventListener("click", clearDdInputs);
      document.getElementById("btn-swap")?.addEventListener("click", swapDd);
      // Live conversion: results update as you type; Enter or "Save to history" saves.
      document.getElementById("dms_pair")?.addEventListener("input", () => applyPair("dms"));
      document.getElementById("dd_pair")?.addEventListener("input", () => applyPair("dd"));
      [ "dms_lat_string", "dms_lon_string" ].forEach(id => document.getElementById(id)?.addEventListener("input", () => {
        document.getElementById("dms_pair").value = "";
        updateDmsResult(false);
      }));
      [ "dd_lat", "dd_lon" ].forEach(id => document.getElementById(id)?.addEventListener("input", () => {
        document.getElementById("dd_pair").value = "";
        updateDdResult(false);
      }));
      // Boxes mode: typing in deg/min/sec/N-S writes the Latitude/Longitude text, then converts.
      [ "lat", "lon" ].forEach(kind => boxIds()[kind].forEach(id => {
        const el = document.getElementById(id);
        const onEdit = () => {
          document.getElementById(kind === "lat" ? "dms_lat_string" : "dms_lon_string").value = boxesToText(kind);
          document.getElementById("dms_pair").value = "";
          updateDmsResult(false);
        };
        el?.addEventListener("input", onEdit);
        if (el?.tagName === "SELECT") {
          el.addEventListener("change", onEdit);
        }
      }));
      document.querySelectorAll('input[name="dms-mode"]').forEach(r => r.addEventListener("change", e => setDmsMode(e.target.value)));
      [ "dms_pair", "dms_lat_string", "dms_lon_string", ...boxIds().lat, ...boxIds().lon ].forEach(id => document.getElementById(id)?.addEventListener("keydown", e => {
        if (e.key === "Enter") {
          updateDmsResult(true);
        }
      }));
      [ "dd_pair", "dd_lat", "dd_lon" ].forEach(id => document.getElementById(id)?.addEventListener("keydown", e => {
        if (e.key === "Enter") {
          updateDdResult(true);
        }
      }));
      const exportMenu = document.getElementById("map-export-menu");
      exportMenu?.querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
        exportMenu.open = false;
      }));
      document.getElementById("copy-dd")?.addEventListener("click", () => copyText(document.getElementById("dd_result")?.value || ""));
      document.getElementById("copy-dms")?.addEventListener("click", () => copyText(document.getElementById("dms_result")?.value || ""));
      document.getElementById("show-dd-map")?.addEventListener("click", () => showCurrentInMap("dd"));
      document.getElementById("show-dms-map")?.addEventListener("click", () => showCurrentInMap("dms"));
      document.getElementById("map-plot-all")?.addEventListener("click", () => {
        const n = plotAllHistory();
        if (n > 0) {
          showFeedback(`Plotted ${n} points on the map`, "success");
        } else {
          showFeedback("No valid points to plot", "info");
        }
      });
      document.getElementById("map-clear")?.addEventListener("click", () => {
        clearMap();
        showFeedback("Map cleared", "info");
      });
      document.getElementById("export-geojson")?.addEventListener("click", () => exportHistoryAsGeoJSON("cordify_history.geojson"));
      document.getElementById("export-kml")?.addEventListener("click", () => exportHistoryAsKml("cordify_history.kml"));
      document.getElementById("export-kmz")?.addEventListener("click", () => exportHistoryAsKmz("cordify_history.kmz"));
      try {
        const pdd = localStorage.getItem("cordify_precision_dd");
        if (pdd) {
          document.getElementById("precision-dd").value = pdd;
        }
        const pdms = localStorage.getItem("cordify_precision_dms");
        if (pdms) {
          document.getElementById("precision-dms").value = pdms;
        }
      } catch {}
      document.getElementById("precision-dd")?.addEventListener("change", e => {
        try {
          localStorage.setItem("cordify_precision_dd", e.target.value);
        } catch {}
        updateDmsResult(false);
      });
      document.getElementById("precision-dms")?.addEventListener("change", e => {
        try {
          localStorage.setItem("cordify_precision_dms", e.target.value);
        } catch {}
        updateDdResult(false);
      });
      try {
        const last = sessionStorage.getItem("cordify_last_inputs");
        if (last) {
          const v = JSON.parse(last);
          [ "dms_pair", "dms_lat_string", "dms_lon_string", "dd_pair", "dd_lat", "dd_lon" ].forEach(k => {
            if (v[k] !== void 0 && document.getElementById(k)) {
              document.getElementById(k).value = v[k];
            }
          });
        }
      } catch {}
      updateDmsResult(false);
      updateDdResult(false);
      try {
        setDmsMode(localStorage.getItem("cordify_dms_mode") === "boxes" ? "boxes" : "text", false);
      } catch {
        setDmsMode("text", false);
      }
      window.addEventListener("cordify:grid-change", () => {
        updateDmsResult(false);
        updateDdResult(false);
      });
      document.getElementById("convert-tab")?.addEventListener("input", persistInputs);
      document.getElementById("history-export-json")?.addEventListener("click", () => {
        try {
          const json = window.historyStore && typeof window.historyStore.exportAll === "function" ? window.historyStore.exportAll() : JSON.stringify(getHistory());
          const blob = new Blob([ json ], {
            type: "application/json"
          });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = "cordify_history.json";
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          }, 150);
        } catch (e) {
          alert("Export failed");
        }
      });
      document.getElementById("history-clear")?.addEventListener("click", () => {
        if (!confirm("Clear all history?")) {
          return;
        }
        clearHistory();
        renderHistoryTable();
      });
      document.getElementById("history-migrate")?.addEventListener("click", () => {
        migrateHistoryToStore();
        alert("Migration started (check console for errors).");
      });
      function persistInputs() {
        const keys = [ "dms_pair", "dms_lat_string", "dms_lon_string", "dd_pair", "dd_lat", "dd_lon" ];
        const obj = {};
        keys.forEach(k => {
          const el = document.getElementById(k);
          if (el) {
            obj[k] = el.value;
          }
        });
        try {
          sessionStorage.setItem("cordify_last_inputs", JSON.stringify(obj));
        } catch {}
      }
      function renderHistoryTable() {
        const table = document.getElementById("history-table");
        const tbody = table ? table.querySelector("tbody") : null;
        const emptyMsg = document.getElementById("history-empty");
        if (!table || !tbody) {
          return;
        }
        tbody.innerHTML = "";
        const arr = getHistory();
        if (!arr.length) {
          table.style.display = "none";
          if (emptyMsg) {
            emptyMsg.style.display = "";
          }
          return;
        }
        if (emptyMsg) {
          emptyMsg.style.display = "none";
        }
        table.style.display = "";
        const SHOWN = 500;
        arr.slice(0, SHOWN).forEach((item, i) => {
          const tr = document.createElement("tr");
          tr.innerHTML = `\n        <td>${i + 1}</td>\n        <td><pre style="white-space:pre-wrap;margin:0" title="${escapeHtml(item.input)}">${escapeHtml(item.input)}</pre></td>\n        <td><pre style="white-space:pre-wrap;margin:0" title="${escapeHtml(item.result)}">${escapeHtml(item.result)}</pre></td>\n        <td>${item.date ? new Date(item.date).toLocaleString() : ""}</td>\n        <td></td>\n      `;
          const actionsTd = tr.querySelector("td:last-child");
          const showBtn = document.createElement("button");
          showBtn.type = "button";
          showBtn.textContent = "Show";
          showBtn.className = "small";
          showBtn.addEventListener("click", () => {
            try {
              showHistoryItemOnMap(item.id ?? i);
            } catch (e) {
            }
          });
          const exportBtn = document.createElement("button");
          exportBtn.type = "button";
          exportBtn.textContent = "Export";
          exportBtn.className = "small";
          exportBtn.addEventListener("click", () => {
            try {
              window._cordify_exportHistory && window._cordify_exportHistory("csv", i);
            } catch (e) {
            }
          });
          const delBtn = document.createElement("button");
          delBtn.type = "button";
          delBtn.textContent = "Delete";
          delBtn.className = "small";
          delBtn.addEventListener("click", () => {
            const ok = confirm("Delete this history item?");
            if (!ok) {
              return;
            }
            const success = removeHistoryAt(item.id ?? i);
            if (success) {
              renderHistoryTable();
            } else {
              alert("Failed to remove history item.");
            }
          });
          actionsTd.appendChild(showBtn);
          actionsTd.appendChild(document.createTextNode(" "));
          actionsTd.appendChild(exportBtn);
          actionsTd.appendChild(document.createTextNode(" "));
          actionsTd.appendChild(delBtn);
          tbody.appendChild(tr);
        });
        if (arr.length > SHOWN) {
          const tr = document.createElement("tr");
          const td = document.createElement("td");
          td.colSpan = 5;
          td.className = "hint";
          td.textContent = `Showing the newest ${SHOWN} of ${arr.length} saved conversions. Exports and “Plot all” include all of them.`;
          tr.appendChild(td);
          tbody.appendChild(tr);
        }
      }
      window._cordify_renderHistory = renderHistoryTable;
      window._cordify_persistInputs = persistInputs;
      function escapeHtml(str) {
        return String(str).replace(/[&<>"']/g, c => ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;"
        }[c]));
      }
      function copyText(text) {
        const t = String(text ?? "");
        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard.writeText(t).catch(() => fallback());
        } else {
          fallback();
        }
        function fallback() {
          const ta = document.createElement("textarea");
          ta.value = t;
          document.body.appendChild(ta);
          ta.select();
          try {
            document.execCommand("copy");
          } catch {}
          document.body.removeChild(ta);
        }
      }
      window._cordify_exportHistory = function exportHistory(type, rowIdx) {
        const arr = function() {
          try {
            return getHistory();
          } catch {
            return [];
          }
        }();
        let data = arr;
        if (typeof rowIdx === "number" && arr[rowIdx]) {
          data = [ arr[rowIdx] ];
        }
        if (!data.length) {
          return;
        }
        const exportArr = data.map((item, i) => ({
          "#": rowIdx !== void 0 ? rowIdx + 1 : i + 1,
          Type: item.type || "",
          Input: item.input,
          Result: item.result,
          Lat: Number.isFinite(item.lat) ? item.lat : "",
          Lon: Number.isFinite(item.lon) ? item.lon : "",
          Date: item.date ? new Date(item.date).toLocaleString() : ""
        }));
        if (type === "xlsx") {
          if (typeof XLSX === "undefined") {
            alert("Excel export requires the XLSX library (sheetjs). Please include it in index.html.");
          } else {
            try {
              const ws = XLSX.utils.json_to_sheet(exportArr);
              const wb = XLSX.utils.book_new();
              XLSX.utils.book_append_sheet(wb, ws, "History");
              XLSX.writeFile(wb, rowIdx !== void 0 ? `cordify_conversion_${rowIdx + 1}.xlsx` : "cordify_history.xlsx");
            } catch {
              alert("Excel export failed.");
            }
          }
        } else if (type === "csv") {
          try {
            const csv = toCsv(exportArr);
            const blob = new Blob([ csv ], {
              type: "text/csv"
            });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = rowIdx !== void 0 ? `cordify_conversion_${rowIdx + 1}.csv` : "cordify_history.csv";
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
              document.body.removeChild(a);
              URL.revokeObjectURL(url);
            }, 100);
          } catch {
            alert("CSV export failed.");
          }
        }
        function toCsv(arr) {
          if (!arr.length) {
            return "";
          }
          const keys = Object.keys(arr[0]);
          const esc = v => '"' + String(v).replace(/"/g, '""') + '"';
          return keys.join(",") + "\n" + arr.map(row => keys.map(k => esc(row[k])).join(",")).join("\n");
        }
      };
      window.clearCordifyHistory = clearHistory;
    })();
    function showErr(id, msg) {
      const el = document.getElementById(id);
      if (el) {
        el.textContent = msg || "";
        el.style.display = msg ? "block" : "none";
      }
    }
    function setInvalid(id, on) {
      document.getElementById(id)?.classList.toggle("invalid", !!on);
    }
    function fieldValue(id) {
      return (document.getElementById(id)?.value || "").trim();
    }
    // A function (not a const) so the startup code above can use it before this line runs.
    function boxIds() {
      return {
        lat: [ "dms_lat_deg", "dms_lat_min", "dms_lat_sec", "dms_lat_dir" ],
        lon: [ "dms_lon_deg", "dms_lon_min", "dms_lon_sec", "dms_lon_dir" ]
      };
    }
    // Boxes -> text such as 12° 34' 56.7" N. A minus on degrees, or S/W, makes it negative.
    function boxesToText(kind) {
      const [ d, m, sec, dir ] = boxIds()[kind].map(id => document.getElementById(id));
      const dv = d.value.trim(), mv = m.value.trim(), sv = sec.value.trim();
      if (!dv && !mv && !sv) {
        return "";
      }
      return `${dv || 0}° ${mv || 0}' ${sv || 0}" ${dir.value}`;
    }
    // Text -> boxes (used when switching to Boxes, pasting a pair, clearing, reloading).
    function textToBoxes(kind) {
      const [ d, m, sec, dir ] = boxIds()[kind].map(id => document.getElementById(id));
      if (!d) {
        return;
      }
      const str = fieldValue(kind === "lat" ? "dms_lat_string" : "dms_lon_string");
      if (!str) {
        d.value = m.value = sec.value = "";
        dir.value = kind === "lat" ? "N" : "E";
        return;
      }
      const v = parseCoord(str, kind);
      if (v === null) {
        return;
      }
      const f = 1e6;
      const units = Math.round(Math.abs(v) * 3600 * f);
      const deg = Math.floor(units / (3600 * f));
      const min = Math.floor((units - deg * 3600 * f) / (60 * f));
      const s = (units - deg * 3600 * f - min * 60 * f) / f;
      const neg = units > 0 && v < 0;
      d.value = String(deg);
      m.value = String(min);
      sec.value = String(+s.toFixed(6));
      dir.value = kind === "lat" ? neg ? "S" : "N" : neg ? "W" : "E";
    }
    function setDmsMode(mode, remember = true) {
      const boxes = mode === "boxes";
      const textEl = document.getElementById("dms-text-fields");
      const boxEl = document.getElementById("dms-box-fields");
      if (!textEl || !boxEl) {
        return;
      }
      textEl.hidden = boxes;
      boxEl.hidden = !boxes;
      const radio = document.querySelector(`input[name="dms-mode"][value="${boxes ? "boxes" : "text"}"]`);
      if (radio) {
        radio.checked = true;
      }
      if (boxes) {
        textToBoxes("lat");
        textToBoxes("lon");
      }
      if (remember) {
        try {
          localStorage.setItem("cordify_dms_mode", boxes ? "boxes" : "text");
        } catch {}
      }
    }
    // Pair field -> fills the separate Latitude / Longitude fields, then converts.
    function applyPair(card) {
      const isDms = card === "dms";
      const pairId = isDms ? "dms_pair" : "dd_pair";
      const latId = isDms ? "dms_lat_string" : "dd_lat";
      const lonId = isDms ? "dms_lon_string" : "dd_lon";
      const update = isDms ? updateDmsResult : updateDdResult;
      const raw = fieldValue(pairId);
      setInvalid(pairId, false);
      if (!raw) {
        return update(false);
      }
      let parts = splitPair(raw);
      let lat = parts ? parseCoord(parts[0], "lat") : null;
      let lon = parts ? parseCoord(parts[1], "lon") : null;
      // UTM with its zone (46R 684557 2856045) or MGRS (46RFP8455656044): read as latitude/longitude.
      const grid = (lat === null || lon === null) && window.CordifySystems ? window.CordifySystems.readCell(raw) : null;
      if (grid) {
        lat = grid.lat;
        lon = grid.lon;
        parts = [ String(+lat.toFixed(8)), String(+lon.toFixed(8)) ];
      }
      if (lat === null || lon === null) {
        setInvalid(pairId, true);
        document.getElementById(isDms ? "dd_result" : "dms_result").value = "";
        showErr(isDms ? "err-dms" : "err-dd", isDms ? `Couldn't read this pair. Example: 12°34'56" N, 77°35'12" E` : "Couldn't read this pair. Example: 12.582417, 77.586667");
        return false;
      }
      let [ a, b ] = parts;
      if (!isDms) {
        // DD fields hold plain numbers; a DMS pair pasted here is converted.
        a = parseDecimal(a) !== null ? a : String(+lat.toFixed(8));
        b = parseDecimal(b) !== null ? b : String(+lon.toFixed(8));
      }
      document.getElementById(latId).value = a;
      document.getElementById(lonId).value = b;
      if (isDms) {
        textToBoxes("lat");
        textToBoxes("lon");
      }
      return update(false);
    }
    function saveResult(rec) {
      window._cordify_addHistory && window._cordify_addHistory(rec);
      if (document.getElementById("history-tab")?.style.display !== "none") {
        window._cordify_renderHistory && window._cordify_renderHistory();
      }
      // "Keep an Excel sheet" (sheet.js) adds the point too when it is switched on.
      const sheetMsg = window.CordifySheet ? window.CordifySheet.onSave(rec) : null;
      showFeedback(sheetMsg ? `Saved to history · ${sheetMsg}` : "Saved to history", "success");
    }
    // DMS -> DD. save=false: live preview only; save=true: also add to history.
    function updateDmsResult(save) {
      const latStr = fieldValue("dms_lat_string");
      const lonStr = fieldValue("dms_lon_string");
      const lat = latStr ? parseCoord(latStr, "lat") : null;
      const lon = lonStr ? parseCoord(lonStr, "lon") : null;
      setInvalid("dms_lat_string", latStr && lat === null);
      setInvalid("dms_lon_string", lonStr && lon === null);
      setInvalid("dms_lat_boxes", latStr && lat === null);
      setInvalid("dms_lon_boxes", lonStr && lon === null);
      let err = "";
      if (latStr && lat === null) {
        err = "Latitude not recognised. Use N or S, up to 90°, minutes and seconds under 60.";
      } else if (lonStr && lon === null) {
        err = "Longitude not recognised. Use E or W, up to 180°, minutes and seconds under 60.";
      } else if (save && (lat === null || lon === null)) {
        err = "Enter both a latitude and a longitude to save.";
      }
      const prec = parseInt(document.getElementById("precision-dd")?.value || "6", 10);
      const ok = lat !== null && lon !== null;
      const out = document.getElementById("dd_result");
      if (out) {
        out.value = ok ? `Latitude (Y): ${Core.formatDDText(lat, prec)}\nLongitude (X): ${Core.formatDDText(lon, prec)}${gridLines(lat, lon)}` : "";
        out.rows = Math.max(2, out.value.split("\n").length);
      }
      lastPoint.dd = ok ? { lat, lon } : null;
      if (!fieldValue("dms_pair") || err) {
        setInvalid("dms_pair", false);
      }
      showErr("err-dms", err);
      if (!save || !ok || err) {
        return false;
      }
      saveResult({
        type: "DMS→DD",
        input: `Lat: ${latStr}\nLon: ${lonStr}`,
        result: `Lat: ${Core.formatDDText(lat, prec)}\nLon: ${Core.formatDDText(lon, prec)}`,
        date: Date.now(),
        lat, lon, grid: gridOf(lat, lon)
      });
      return true;
    }
    // DD -> DMS. save=false: live preview only; save=true: also add to history.
    function updateDdResult(save) {
      const latStr = fieldValue("dd_lat");
      const lonStr = fieldValue("dd_lon");
      const latV = latStr ? parseDecimal(latStr) : null;
      const lonV = lonStr ? parseDecimal(lonStr) : null;
      const lat = latV !== null && inLatRange(latV) ? latV : null;
      const lon = lonV !== null && inLonRange(lonV) ? lonV : null;
      setInvalid("dd_lat", latStr && lat === null);
      setInvalid("dd_lon", lonStr && lon === null);
      let err = "";
      if (latStr && lat === null) {
        err = "Latitude must be a decimal number from −90 to 90.";
      } else if (lonStr && lon === null) {
        err = "Longitude must be a decimal number from −180 to 180.";
      } else if (save && (lat === null || lon === null)) {
        err = "Enter both a latitude and a longitude to save.";
      }
      const secDigits = parseInt(document.getElementById("precision-dms")?.value || "3", 10);
      const ok = lat !== null && lon !== null;
      const dms_lat = ok ? ddToDms(lat, "lat", secDigits) : "";
      const dms_lon = ok ? ddToDms(lon, "lon", secDigits) : "";
      const out = document.getElementById("dms_result");
      if (out) {
        out.value = ok ? `Latitude (Y): ${dms_lat}\nLongitude (X): ${dms_lon}${gridLines(lat, lon)}` : "";
        out.rows = Math.max(2, out.value.split("\n").length);
      }
      lastPoint.dms = ok ? { lat, lon } : null;
      if (!fieldValue("dd_pair") || err) {
        setInvalid("dd_pair", false);
      }
      showErr("err-dd", err);
      if (!save || !ok || err) {
        return false;
      }
      saveResult({
        type: "DD→DMS",
        input: `Lat: ${lat}\nLon: ${lon}`,
        result: `Lat: ${dms_lat}\nLon: ${dms_lon}`,
        date: Date.now(),
        lat, lon, grid: gridOf(lat, lon)
      });
      return true;
    }
    function clearDmsInputs() {
      [ "dms_pair", "dms_lat_string", "dms_lon_string" ].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
          el.value = "";
          el.classList.remove("invalid");
        }
      });
      textToBoxes("lat");
      textToBoxes("lon");
      updateDmsResult(false);
      window._cordify_persistInputs && window._cordify_persistInputs();
    }
    function clearDdInputs() {
      [ "dd_pair", "dd_lat", "dd_lon" ].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
          el.value = "";
          el.classList.remove("invalid");
        }
      });
      updateDdResult(false);
      window._cordify_persistInputs && window._cordify_persistInputs();
    }
    function swapDd() {
      const latEl = document.getElementById("dd_lat");
      const lonEl = document.getElementById("dd_lon");
      if (!latEl || !lonEl) {
        return;
      }
      const tmp = latEl.value;
      latEl.value = lonEl.value;
      lonEl.value = tmp;
      document.getElementById("dd_pair").value = "";
      updateDdResult(false);
      window._cordify_persistInputs && window._cordify_persistInputs();
    }
    // Shared with batch.js (Batch convert), which reads values the same way as the converter.
    window.CordifyConvert = { parseCoord, parseDmsString };
    function showFeedback(message, type = "info") {
      const existing = document.querySelector(".feedback");
      if (existing) {
        existing.remove();
      }
      const feedback = document.createElement("div");
      feedback.className = `feedback feedback-${type}`;
      feedback.textContent = message;
      document.body.appendChild(feedback);
      requestAnimationFrame(() => feedback.classList.add("show"));
      setTimeout(() => {
        feedback.classList.remove("show");
        setTimeout(() => feedback.remove(), 300);
      }, 3e3);
    }
    let _map = null;
    let _mapMarkers = {};
    let _mapLayerGroup = null;
    function initMap() {
      if (_map) {
        return true;
      }
      if (typeof L === "undefined") {
        return false;
      }
      if (!L.map || !L.tileLayer || !L.layerGroup) {
        return false;
      }
      const el = document.getElementById("map");
      if (!el) {
        return false;
      }
      const mapTab = document.getElementById("map-tab");
      if (!mapTab) {
        return false;
      }
      if (mapTab.style.display === "none") {
        mapTab.style.display = "";
      }
      try {
        _map = L.map(el, {
          attributionControl: true,
          preferCanvas: true   // dots are drawn on one canvas, so tens of thousands stay smooth
        }).setView([ 0, 0 ], 2);
        _mapLayerGroup = L.layerGroup().addTo(_map);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution: "© OpenStreetMap contributors"
        }).addTo(_map);
        setTimeout(() => {
          if (_map && _map.invalidateSize) {
            _map.invalidateSize(true);
          }
        }, 100);
        return true;
      } catch (e) {
        _map = null;
        _mapLayerGroup = null;
        return false;
      }
    }
    function clearMap() {
      if (!_map) {
        return;
      }
      try {
        _mapLayerGroup.clearLayers();
        _mapMarkers = {};
      } catch (e) {}
    }
    function showOnMap(lat, lon, label) {
      if (!isFinite(lat) || !isFinite(lon)) {
        return null;
      }
      if (!initMap()) {
        return null;
      }
      try {
        const key = `${lat}:${lon}`;
        if (_mapMarkers[key]) {
          _mapMarkers[key].openPopup();
          _map.setView([ lat, lon ], Math.max(13, _map.getZoom()));
          return _mapMarkers[key];
        }
        const m = L.marker([ lat, lon ]);
        m.bindPopup(label || `${lat}, ${lon}`);
        m.addTo(_mapLayerGroup);
        _mapMarkers[key] = m;
        _map.setView([ lat, lon ], 13);
        m.openPopup();
        return m;
      } catch (e) {
        showFeedback("Failed to show point on map", "error");
        return null;
      }
    }
    function parseLatLngFromOutput(s) {
      if (!s || typeof s !== "string") {
        return null;
      }
      // Results look like "Lat: 12.5" or "Latitude (Y): 12° 34' 56.7\" S".
      // Parse each labelled line as DMS/DD so seconds and N/S/E/W are kept.
      const latLine = s.match(/Lat(?:itude)?(?:\s*\(Y\))?\s*[:=]\s*([^\n]+)/i);
      const lonLine = s.match(/Lon(?:gitude)?(?:\s*\(X\))?\s*[:=]\s*([^\n]+)/i);
      if (latLine && lonLine) {
        const lat = parseDmsString(latLine[1]);
        const lon = parseDmsString(lonLine[1]);
        if (lat !== null && lon !== null && inLatRange(lat) && inLonRange(lon)) {
          return [ lat, lon ];
        }
      }
      const latMatch = s.match(/(?:Lat(?:itude)?(?:\s*\(Y\))?\s*[:=]?\s*)(-?\d+(?:\.\d+)?)/i);
      const lonMatch = s.match(/(?:Lon(?:gitude)?(?:\s*\(X\))?\s*[:=]?\s*)(-?\d+(?:\.\d+)?)/i);
      if (latMatch && lonMatch) {
        const lat = parseFloat(latMatch[1]);
        const lon = parseFloat(lonMatch[1]);
        if (isFinite(lat) && isFinite(lon)) {
          return [ lat, lon ];
        }
      }
      const all = s.match(/-?\d+(?:\.\d+)?/g);
      if (all && all.length >= 2) {
        const a = parseFloat(all[0]);
        const b = parseFloat(all[1]);
        if (Math.abs(a) <= 90 && Math.abs(b) <= 180) {
          return [ a, b ];
        }
        if (Math.abs(b) <= 90 && Math.abs(a) <= 180) {
          return [ b, a ];
        }
      }
      return null;
    }
    // Saved numbers when the record has them; older records only have text to read back.
    function coordsOf(item) {
      if (item && Number.isFinite(item.lat) && Number.isFinite(item.lon) && inLatRange(item.lat) && inLonRange(item.lon)) {
        return [ item.lat, item.lon ];
      }
      return parseLatLngFromOutput(item ? item.result || item.output || "" : "");
    }
    function showCurrentInMap(type) {
      const resultEl = document.getElementById(type === "dd" ? "dd_result" : "dms_result");
      if (!resultEl) {
        showFeedback("Result element not found", "error");
        return;
      }
      const resultValue = resultEl.value.trim();
      if (!resultValue) {
        showFeedback("No coordinates to display. Please convert some coordinates first.", "error");
        return;
      }
      const exact = lastPoint[type];
      const coords = exact ? [ exact.lat, exact.lon ] : parseLatLngFromOutput(resultValue);
      if (!coords) {
        showFeedback("Could not parse coordinates from result", "error");
        return;
      }
      const mapTabBtn = document.getElementById("tab-map");
      if (!mapTabBtn) {
        showFeedback("Map tab not available", "error");
        return;
      }
      mapTabBtn.click();
      const [lat, lon] = coords;
      setTimeout(() => {
        if (!initMap()) {
          showFeedback("Failed to initialize map", "error");
          return;
        }
        if (_map && _map.invalidateSize) {
          _map.invalidateSize(true);
        }
        const marker = showOnMap(lat, lon, `Current Result: ${resultValue}`);
        if (marker) {
          showFeedback("Point plotted on map", "success");
        } else {
          showFeedback("Failed to plot point on map", "error");
        }
      }, 300);
    }
    window.showCurrentInMap = showCurrentInMap;
    function showHistoryItemOnMap(idOrIndex) {
      let rec = null;
      if (window.historyStore && typeof window.historyStore.getById === "function" && typeof idOrIndex === "string") {
        rec = window.historyStore.getById(idOrIndex);
      }
      if (!rec) {
        const h = getHistory();
        if (typeof idOrIndex === "number") {
          rec = h[idOrIndex];
        } else {
          rec = h.find(r => r.id === idOrIndex) || null;
        }
      }
      if (!rec) {
        showFeedback("History item not found", "error");
        return;
      }
      const mapTabBtn = document.getElementById("tab-map");
      if (!mapTabBtn) {
        return;
      }
      mapTabBtn.click();
      const coords = coordsOf(rec);
      if (!coords) {
        showFeedback("Could not parse coordinates from history item", "error");
        return;
      }
      const [lat, lon] = coords;
      setTimeout(() => {
        if (!initMap()) {
          showFeedback("Failed to initialize map", "error");
          return;
        }
        if (_map && _map.invalidateSize) {
          _map.invalidateSize();
        }
        showOnMap(lat, lon, `${rec.type || ""} — ${rec.input}`);
        showFeedback("Point plotted on map", "success");
      }, 200);
    }
    window.showHistoryItemOnMap = showHistoryItemOnMap;
    // Many points at once, as dots on the map's canvas. Labels open on click.
    function drawPoints(lats, lons, labels) {
      clearMap();
      if (!lats.length) {
        return;
      }
      const group = L.featureGroup();
      const bounds = L.latLngBounds();
      const style = { radius: 5, weight: 1.5, color: "#0e5f5c", fillColor: "#5fb8ae", fillOpacity: .85 };
      for (let i = 0; i < lats.length; i++) {
        const dot = L.circleMarker([ lats[i], lons[i] ], style);
        dot.cordifyLabel = labels ? labels[i] : "";
        group.addLayer(dot);
        bounds.extend([ lats[i], lons[i] ]);
      }
      group.on("click", e => {
        const box = document.createElement("div");
        box.style.whiteSpace = "pre-wrap";
        const ll = e.layer.getLatLng();
        box.textContent = (e.layer.cordifyLabel ? e.layer.cordifyLabel + "\n" : "") + Core.formatDDText(ll.lat, 8) + ", " + Core.formatDDText(ll.lng, 8);
        L.popup().setLatLng(ll).setContent(box).openOn(_map);
      });
      group.addTo(_mapLayerGroup);
      try {
        _map.fitBounds(bounds, { padding: [ 20, 20 ], maxZoom: 17 });
      } catch (e) {}
    }
    function plotAllHistory() {
      if (!initMap()) {
        alert("Map initialization failed");
        return 0;
      }
      const lats = [], lons = [], labels = [];
      for (const it of getHistory()) {
        const coords = coordsOf(it);
        if (!coords) {
          continue;
        }
        lats.push(coords[0]);
        lons.push(coords[1]);
        labels.push(`${it.type || ""} — ${it.input}`);
      }
      drawPoints(lats, lons, labels);
      return lats.length;
    }
    // Used by Batch convert: opens the Map tab and shows the points.
    window.CordifyMap = {
      plotPoints(lats, lons, labels, message) {
        document.getElementById("tab-map")?.click();
        setTimeout(() => {
          if (!initMap()) {
            showFeedback("Failed to load the map. Check your internet connection.", "error");
            return;
          }
          _map.invalidateSize(true);
          drawPoints(lats, lons, labels);
          showFeedback(message || `Plotted ${lats.length} points`, "success");
        }, 300);
      }
    };
    function downloadBlob(filename, blob) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 300);
    }
    function historyToGeoJSON(items, targetEpsg = "EPSG:4326") {
      const features = [];
      for (const it of items) {
        const coords = coordsOf(it);
        if (!coords) {
          continue;
        }
        let [lat, lon] = coords;
        if (targetEpsg !== "EPSG:4326" && typeof proj4 !== "undefined") {
          try {
            const p = proj4("EPSG:4326", targetEpsg, [ lon, lat ]);
            features.push({
              type: "Feature",
              geometry: {
                type: "Point",
                coordinates: [ p[0], p[1] ]
              },
              properties: {
                id: it.id || null,
                ts: it.ts || it.date || null,
                input: it.input || "",
                output: it.output || it.result || "",
                type: it.type || ""
              }
            });
            continue;
          } catch (e) {}
        }
        features.push({
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [ lon, lat ]
          },
          properties: {
            id: it.id || null,
            ts: it.ts || it.date || null,
            input: it.input || "",
            output: it.output || it.result || "",
            type: it.type || ""
          }
        });
      }
      return {
        type: "FeatureCollection",
        features: features
      };
    }
    function historyToKml(items) {
      function escapeXml(str) {
        return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
      }
      function sanitizeCDATA(str) {
        return String(str).replace(/]]>/g, "]] >");
      }
      const pls = [];
      for (const it of items) {
        const coords = coordsOf(it);
        if (!coords) {
          continue;
        }
        const [lat, lon] = coords;
        const name = escapeXml(it.input || "");
        const desc = sanitizeCDATA(it.output || it.result || "");
        const ts = it.ts || it.date || "";
        pls.push(`<Placemark><name>${name}</name><description><![CDATA[${desc}<br/>${ts}]]></description><Point><coordinates>${lon},${lat},0</coordinates></Point></Placemark>`);
      }
      return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Cordify Export</name>${pls.join("\n")}</Document></kml>`;
    }
    async function exportHistoryAsGeoJSON(filename = "history.geojson", targetEpsg = "EPSG:4326") {
      const items = getHistory();
      const geo = historyToGeoJSON(items, targetEpsg);
      const blob = new Blob([ JSON.stringify(geo, null, 2) ], {
        type: "application/geo+json"
      });
      downloadBlob(filename, blob);
    }
    function exportHistoryAsKml(filename = "history.kml") {
      const items = getHistory();
      const kml = historyToKml(items);
      const blob = new Blob([ kml ], {
        type: "application/vnd.google-earth.kml+xml"
      });
      downloadBlob(filename, blob);
    }
    async function exportHistoryAsKmz(filename = "history.kmz") {
      const items = getHistory();
      const kml = historyToKml(items);
      if (typeof JSZip === "undefined") {
        alert("JSZip not loaded");
        return;
      }
      const zip = new JSZip;
      zip.file("doc.kml", kml);
      const content = await zip.generateAsync({
        type: "blob",
        compression: "DEFLATE"
      });
      downloadBlob(filename, content);
    }
  })();
}
