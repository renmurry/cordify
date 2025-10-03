// scripts for cordify
console.log('app.js loaded');

// Register Service Worker (handles GitHub Pages subpath)
(() => {
  if ('serviceWorker' in navigator) {
    const swUrl = 'service-worker.js';
    const scope = './';
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(swUrl, { scope }).catch(() => {/* no-op */});
    });
  }
})();

// --- Cordify App: true render-swap tabs (Convert | History) ---
(function() {
  const DEFAULT_META = { crs: 'EPSG:4326', precision: 6 };
  let activeTab = 'convert';
  let panel;
  let convertMode = sessionStorage.getItem('convert_mode') || 'DMS→DD';
  let historyFilter = sessionStorage.getItem('history_filter') || 'all';

  document.addEventListener('DOMContentLoaded', () => {
    panel = document.getElementById('panel');
    document.getElementById('tab-convert')?.addEventListener('click', () => { activeTab='convert'; render(); });
    document.getElementById('tab-history')?.addEventListener('click', () => { activeTab='history'; render(); });
    render();
  });

  function render(){
    if (!panel) return;
    panel.replaceChildren(); // unmount everything
    if (activeTab==='convert') renderConvert();
    else renderHistory(window.historyStore?.getAll() || []);
  }

  // Helpers
  function el(tag, attrs={}, children=[]) {
    const node = document.createElement(tag);
    for (const k in attrs) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'style' && typeof attrs[k] === 'object') Object.assign(node.style, attrs[k]);
      else if (k.startsWith('on') && typeof attrs[k] === 'function') node.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== undefined && attrs[k] !== null) node.setAttribute(k, attrs[k]);
    }
    (Array.isArray(children)? children: [children]).forEach(c => {
      if (c === null || c === undefined) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }
  function opt(v,l){ return el('option', { value: v }, l ?? v); }
  function td(n){ return el('td', {}, n); }
  function trHead(cols){ return el('tr', {}, cols.map(c=>el('th',{},c))); }
  function code(text){ return el('code', { title: text }, text); }
  function setResult(id, text){
    const elmt = document.getElementById(id);
    if (!elmt) return;
    if ('value' in elmt) elmt.value = text; else elmt.textContent = text;
  }
  function getResultText(id){
    const elmt = document.getElementById(id);
    if (!elmt) return '';
    return 'value' in elmt ? (elmt.value || '') : (elmt.textContent || '');
  }

  // Temporary test hook
  window.__assertNoInputsOnHistory = () => (activeTab==='history') && document.querySelectorAll('#panel input,#panel select,#panel textarea').length===0;

  // --- Render Convert ---
  function renderConvert(){
    // read prefill from sessionStorage if any
    let prefill = null;
    try { prefill = JSON.parse(sessionStorage.getItem('convert_prefill')); } catch {}
    sessionStorage.removeItem('convert_prefill');

    // Direction select
    const dirRow = el('div',{class:'row'},[
      el('label',{},['Direction: ', el('select',{id:'conv_dir',onchange:(e)=>{ convertMode=e.target.value; sessionStorage.setItem('convert_mode', convertMode); render(); }},[opt('DMS→DD'),opt('DD→DMS')])])
    ]);
    // set value after mount
    setTimeout(()=>{ const s=document.getElementById('conv_dir'); if (s) s.value=convertMode; },0);

    const row1 = el('div',{class:'row'},[
      el('label',{},['Latitude DMS: ', el('input',{id:'dms_lat_string',type:'text',placeholder:'e.g. 12°34\'56.7\" N or -12 34 56.7'})])
    ]);
    const row2 = el('div',{class:'row'},[
      el('label',{},['Longitude DMS: ', el('input',{id:'dms_lon_string',type:'text',placeholder:'e.g. 77°35\'12\" E or -77 35 12'})])
    ]);
    const hr = el('hr',{style:{marginTop:'15px',marginBottom:'15px'}});
    const dmsLat = el('div',{class:'row'},[
      el('b',{},'Latitude (Y):'),
      el('label',{},['° ', el('input',{id:'dms_lat_deg',type:'number',step:'1',placeholder:'deg',min:'0',max:'90'})]),
      el('label',{},['\' ', el('input',{id:'dms_lat_min',type:'number',step:'1',placeholder:'min',min:'0',max:'59'})]),
      el('label',{},['" ', el('input',{id:'dms_lat_sec',type:'number',step:'any',placeholder:'sec',min:'0',max:'59.9999'})]),
      el('select',{id:'dms_lat_dir'},[opt('N'),opt('S')])
    ]);
    const dmsLon = el('div',{class:'row'},[
      el('b',{},'Longitude (X):'),
      el('label',{},['° ', el('input',{id:'dms_lon_deg',type:'number',step:'1',placeholder:'deg',min:'0',max:'180'})]),
      el('label',{},['\' ', el('input',{id:'dms_lon_min',type:'number',step:'1',placeholder:'min',min:'0',max:'59'})]),
      el('label',{},['" ', el('input',{id:'dms_lon_sec',type:'number',step:'any',placeholder:'sec',min:'0',max:'59.9999'})]),
      el('select',{id:'dms_lon_dir'},[opt('E'),opt('W')])
    ]);
    const btnConv = el('button',{type:'button',onclick:()=>convertDmsToDd()},'Convert to DD');
    const resultRow = el('div',{class:'row',style:{alignItems:'flex-start'}},[
      el('pre',{class:'result',id:'dd_result'}),
      el('button',{id:'copy-dd-btn',type:'button',title:'Copy results',onclick:async()=>{
        const txt = getResultText('dd_result'); if (!txt) return;
        try { await navigator.clipboard.writeText(txt); } catch {}
      }},'Copy')
    ]);

    const hr2 = el('hr');
    const h4b = el('h4',{},'DD to DMS');
    const ddLat = el('div',{class:'row'},[
      el('b',{},'Latitude (Y):'),
      el('label',{},['DD ', el('input',{id:'dd_lat',type:'number',step:'any',placeholder:'e.g. 12.58242',min:'-90',max:'90'})])
    ]);
    const ddLon = el('div',{class:'row'},[
      el('b',{},'Longitude (X):'),
      el('label',{},['DD ', el('input',{id:'dd_lon',type:'number',step:'any',placeholder:'e.g. 77.58667',min:'-180',max:'180'})])
    ]);
    const btnConv2 = el('button',{type:'button',onclick:()=>convertDdToDms()},'Convert to DMS');
    const resultRow2 = el('div',{class:'row',style:{alignItems:'flex-start'}},[
      el('pre',{class:'result',id:'dms_result'}),
      el('button',{id:'copy-dms-btn',type:'button',title:'Copy results',onclick:async()=>{
        const txt = getResultText('dms_result'); if (!txt) return;
        try { await navigator.clipboard.writeText(txt); } catch {}
      }},'Copy')
    ]);

    // Prefill after rerun request
    if (prefill && prefill.type) {
      if (prefill.type==='DD→DMS') {
        const mLat = /Lat:\s*([-+]?\d+(?:\.\d+)?)/.exec(prefill.input || '');
        const mLon = /Lon:\s*([-+]?\d+(?:\.\d+)?)/.exec(prefill.input || '');
        if (mLat) ddLat.querySelector('input#dd_lat').value = mLat[1];
        if (mLon) ddLon.querySelector('input#dd_lon').value = mLon[1];
      } else if (prefill.type==='DMS→DD') {
        const lines = (prefill.input || '').split(/\n/);
        const latLine = lines.find(l=>/^Lat:/i.test(l)) || '';
        const lonLine = lines.find(l=>/^Lon:/i.test(l)) || '';
        const latStr = latLine.replace(/^Lat:\s*/, '');
        const lonStr = lonLine.replace(/^Lon:\s*/, '');
        row1.querySelector('#dms_lat_string').value = latStr;
        row2.querySelector('#dms_lon_string').value = lonStr;
      }
    }

    // Render depending on convertMode
    panel.appendChild(dirRow);
    if (convertMode==='DMS→DD') {
      panel.appendChild(el('h4',{},'DMS to DD'));
      panel.appendChild(row1);
      panel.appendChild(row2);
      panel.appendChild(hr);
      panel.appendChild(dmsLat);
      panel.appendChild(dmsLon);
      panel.appendChild(btnConv);
      panel.appendChild(resultRow);
    } else {
      panel.appendChild(h4b);
      panel.appendChild(ddLat);
      panel.appendChild(ddLon);
      panel.appendChild(btnConv2);
      panel.appendChild(resultRow2);
    }
  }

  // --- Render History ---
  function renderHistory(items){
    const wrap = el('div',{});
    const controls = el('div',{class:'row',style:{justifyContent:'space-between'}},[
      el('div',{},[
        el('span',{},'Filter: '),
        el('button',{type:'button',onclick:()=>{ historyFilter='all'; sessionStorage.setItem('history_filter','all'); render(); }, 'aria-pressed': String(historyFilter==='all')},'All'),
        el('button',{type:'button',onclick:()=>{ historyFilter='DMS→DD'; sessionStorage.setItem('history_filter','DMS→DD'); render(); }, 'aria-pressed': String(historyFilter==='DMS→DD')},'DMS→DD'),
        el('button',{type:'button',onclick:()=>{ historyFilter='DD→DMS'; sessionStorage.setItem('history_filter','DD→DMS'); render(); }, 'aria-pressed': String(historyFilter==='DD→DMS')},'DD→DMS')
      ]),
      el('div',{},[
        el('button',{id:'clear-history-btn',type:'button',onclick:()=>{ if (confirm('Clear all?')) { window.historyStore.clear(); render(); } }},'Clear All')
      ])
    ]);
    const data = (historyFilter==='all'? items : (window.historyStore.filterByType(historyFilter)) );

    if (!data.length) {
      wrap.appendChild(controls);
      wrap.appendChild(el('div',{id:'history-empty',style:{marginTop:'1em',color:'#888'}},'No history yet.'));
      panel.appendChild(wrap);
      return;
    }

    const table = el('table',{id:'history-table',border:'1',style:{width:'100%','borderCollapse':'collapse'}},[
      el('thead',{},[trHead(['Time','Type','Input','Output','Actions'])]),
      el('tbody',{})
    ]);
    const tbody = table.querySelector('tbody');

    data.forEach(rec => {
      const tr = el('tr',{},[
        td(new Date(rec.ts || Date.now()).toLocaleString()),
        td(rec.type || ''),
        td(code(rec.input || '')),
        td(code(rec.output || '')),
        td(el('div',{},[
          el('button',{type:'button',onclick:async()=>{ try{ await navigator.clipboard.writeText(rec.input||''); }catch{} }},'Copy In'),
          el('button',{type:'button',onclick:async()=>{ try{ await navigator.clipboard.writeText(rec.output||''); }catch{} }},'Copy Out'),
          el('button',{type:'button',onclick:()=>{ hydrateConverterFromHistory(rec); activeTab='convert'; render(); }},'Re-run'),
          el('button',{type:'button',onclick:()=>{ window.historyStore.remove(rec.id); render(); }},'Delete')
        ]))
      ]);
      tbody.appendChild(tr);
    });
    wrap.appendChild(controls);
    wrap.appendChild(table);
    panel.appendChild(wrap);
  }
})();

// ...existing code...

// ---- Robust DMS string parser ----
// Supports: symbols/spaces, , as decimal, signed degrees, leading/trailing NSEW,
// and partial forms: D°, D M, D M S (with or without ° ' ").
function parseDmsString(dmsStr) {
  if (!dmsStr) return null;

  // Normalize
  dmsStr = dmsStr.trim()
    .replace(/[′’‘`´]/g, "'")        // variants -> '
    .replace(/[″“”]/g, '"')          // variants -> "
    .replace(/\u00B0/g, '°')         // ensure standard degree symbol
    .replace(/,/g, '.')              // allow comma decimals
    .toUpperCase()
    .replace(/\s+/g, ' ');

  // Grab leading/trailing direction
  let leadDir = (dmsStr.match(/^[NSWE]/) || [null])[0];
  let tailDir = (dmsStr.match(/[NSWE]$/) || [null])[0];

  if (leadDir && tailDir && leadDir !== tailDir) return null; // conflicting
  let dir = tailDir || leadDir || null;

  // Strip direction chars for numeric parsing
  if (leadDir) dmsStr = dmsStr.slice(1).trim();
  if (tailDir) dmsStr = dmsStr.slice(0, -1).trim();

  // Match deg [min] [sec] using either symbols or spaces
  // Examples: 25 34 47.035 | 25°34'47.035" | -23° 30' | +10 12.5 | 10° | 10 12
  const regex = /^([+-]?\d+(?:\.\d+)?)(?:[°\s]+(\d+(?:\.\d+)?))?(?:['\s]+(\d+(?:\.\d+)?))?(?:"?)$/;
  const m = dmsStr.match(regex);
  if (!m) return null;

  let deg = parseFloat(m[1]);
  let min = m[2] !== undefined ? parseFloat(m[2]) : 0;
  let sec = m[3] !== undefined ? parseFloat(m[3]) : 0;

  if ([deg, min, sec].some(Number.isNaN)) return null;
  if (min < 0 || min >= 60 || sec < 0 || sec >= 60) return null;

  let dd = Math.abs(deg) + (min / 60) + (sec / 3600);
  if (deg < 0) dd = -dd; // signed degree overrides
  if (dir === 'S' || dir === 'W') dd = -Math.abs(dd); // NSEW applies sign

  return dd;
}

function dmsToDd(deg, min, sec, dir) {
  if ([deg, min, sec].some(v => Number.isNaN(v))) return null;
  if (min < 0 || min >= 60 || sec < 0 || sec >= 60) return null;
  let dd = Math.abs(deg) + min / 60 + sec / 3600;
  if (dir === "S" || dir === "W") dd *= -1;
  if (deg < 0) dd *= -1; // if user typed negative deg, respect it
  return dd;
}

function ddToDms(dd, latlon) {
  if (Number.isNaN(dd)) return null;
  const dir = latlon === "lat" ? (dd < 0 ? "S" : "N") : (dd < 0 ? "W" : "E");
  dd = Math.abs(dd);
  const deg = Math.floor(dd);
  const minFloat = (dd - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = ((minFloat - min) * 60);
  const secStr = sec.toFixed(3).replace(/\.?0+$/,''); // trim trailing zeros
  return `${deg}° ${min}' ${secStr}" ${dir}`;
}

function inLatRange(v) { return v >= -90 && v <= 90; }
function inLonRange(v) { return v >= -180 && v <= 180; }

// Store prefill in sessionStorage; renderConvert reads it
function hydrateConverterFromHistory(rec) {
  try { sessionStorage.setItem('convert_prefill', JSON.stringify(rec)); } catch {}
}

function convertDmsToDd() {
  const latStr = (document.getElementById('dms_lat_string')?.value || '').trim();
  const lonStr = (document.getElementById('dms_lon_string')?.value || '').trim();

  const latDeg = parseFloat(document.getElementById('dms_lat_deg')?.value);
  const latMin = parseFloat(document.getElementById('dms_lat_min')?.value);
  const latSec = parseFloat(document.getElementById('dms_lat_sec')?.value);
  const latDir = document.getElementById('dms_lat_dir')?.value;

  const lonDeg = parseFloat(document.getElementById('dms_lon_deg')?.value);
  const lonMin = parseFloat(document.getElementById('dms_lon_min')?.value);
  const lonSec = parseFloat(document.getElementById('dms_lon_sec')?.value);
  const lonDir = document.getElementById('dms_lon_dir')?.value;

  // remove invalid styles first
  ['dms_lat_deg','dms_lat_min','dms_lat_sec','dms_lon_deg','dms_lon_min','dms_lon_sec'].forEach(id=>{
    const el = document.getElementById(id); el && el.classList.remove('invalid');
  });
  let dd_lat = latStr ? parseDmsString(latStr) : dmsToDd(latDeg || 0, latMin || 0, latSec || 0, latDir || 'N');
  if (dd_lat === null || !inLatRange(dd_lat)) {
    if (!latStr) ['dms_lat_deg','dms_lat_min','dms_lat_sec'].forEach(id=>document.getElementById(id)?.classList.add('invalid'));
    alert('Invalid Latitude.'); return;
  }
  let dd_lon = lonStr ? parseDmsString(lonStr) : dmsToDd(lonDeg || 0, lonMin || 0, lonSec || 0, lonDir || 'E');
  if (dd_lon === null || !inLonRange(dd_lon)) {
    if (!lonStr) ['dms_lon_deg','dms_lon_min','dms_lon_sec'].forEach(id=>document.getElementById(id)?.classList.add('invalid'));
    alert('Invalid Longitude.'); return;
  }

  const precision = DEFAULT_META.precision;
  const ddText = `Latitude (Y): ${dd_lat.toFixed(precision)}\nLongitude (X): ${dd_lon.toFixed(precision)}`;
  setResult('dd_result', ddText);

  const inputSummary = latStr
    ? `Lat: ${latStr}\n`
    : `Lat: ${document.getElementById('dms_lat_deg')?.value}° ${document.getElementById('dms_lat_min')?.value}' ${document.getElementById('dms_lat_sec')?.value}" ${latDir}` + '\n';
  const inputSummary2 = lonStr
    ? `Lon: ${lonStr}`
    : `Lon: ${document.getElementById('dms_lon_deg')?.value}° ${document.getElementById('dms_lon_min')?.value}' ${document.getElementById('dms_lon_sec')?.value}" ${lonDir}`;

  const resultSummary = `Lat: ${dd_lat.toFixed(precision)}\nLon: ${dd_lon.toFixed(precision)}`;
  window.historyStore?.add({ type: 'DMS→DD', input: inputSummary + inputSummary2, output: resultSummary, meta: { ...DEFAULT_META } });
}

function convertDdToDms() {
  let dd_lat = parseFloat(document.getElementById('dd_lat').value);
  let dd_lon = parseFloat(document.getElementById('dd_lon').value);
  let inputSummary = '', resultSummary = '';

  if (Number.isNaN(dd_lat) || !inLatRange(dd_lat)) { alert('Enter a valid latitude in DD (−90..90).'); return; }
  if (Number.isNaN(dd_lon) || !inLonRange(dd_lon)) { alert('Enter a valid longitude in DD (−180..180).'); return; }

  let dms_lat = ddToDms(dd_lat, "lat");
  let dms_lon = ddToDms(dd_lon, "lon");

  inputSummary = `Lat: ${dd_lat}\nLon: ${dd_lon}`;
  resultSummary = `Lat: ${dms_lat}\nLon: ${dms_lon}`;
  setResult('dms_result', `Latitude (Y): ${dms_lat}\nLongitude (X): ${dms_lon}`);

  // Store in history
  window.historyStore?.add({ type: 'DD→DMS', input: inputSummary, output: resultSummary, meta: { ...DEFAULT_META } });
}
