/*
 * Cordify — coloured Excel exports
 * The spreadsheet library Cordify uses (SheetJS, free edition) cannot write cell
 * colours. An .xlsx file is a zip of XML files, so this adds them afterwards: it
 * appends fills to xl/styles.xml and points the cells of each row at them.
 * Number formats already on a cell (such as dates) are kept.
 *
 * No screen code: works on the page and in Node (tests), with JSZip passed in.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.CordifyXlsxColor = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Light fills from the same family as Excel's own Good / Neutral / Bad cell styles.
  const FILLS = {
    ok: "FFC6EFCE",          // green
    fixed: "FFFFEB9C",       // yellow
    check: "FFFCD5B4",       // orange
    bad: "FFFFC7CE",         // red
    confirmed: "FFDDEBF7",   // blue
    header: "FFE7E6E6"       // grey, with bold text
  };
  const KINDS = Object.keys(FILLS);
  // When one row holds several results (several coordinate columns), the most serious colour wins.
  const SEVERITY = { ok: 1, confirmed: 2, fixed: 3, check: 4, bad: 5 };
  const worse = (a, b) => !a ? b : !b ? a : SEVERITY[b] > SEVERITY[a] ? b : a;

  const escXml = s => String(s).replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

  /*
   * colour(bytes, plan, JSZip) -> Promise<Uint8Array>
   *   bytes  the workbook as written by XLSX.write(wb, { type: "array", bookType: "xlsx" })
   *   plan   [ { sheet: position of the sheet (1 = first), header: its header row number or 0,
   *              rows: Map(row number -> "ok" | "fixed" | "check" | "bad" | "confirmed") } ]
   */
  async function colour(bytes, plan, JSZip) {
    const zip = await JSZip.loadAsync(bytes);
    const stylesFile = zip.file("xl/styles.xml");
    if (!stylesFile) throw new Error("not a workbook");
    let styles = await stylesFile.async("string");

    const fills = styles.match(/<fills count="(\d+)">([\s\S]*?)<\/fills>/);
    const fonts = styles.match(/<fonts count="(\d+)"([^>]*)>([\s\S]*?)<\/fonts>/);
    const xfs = styles.match(/<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/);
    if (!fills || !fonts || !xfs) throw new Error("unexpected styles");
    const firstFill = +fills[1], boldFont = +fonts[1];
    // The number format of each existing cell style, so a coloured date stays a date.
    const formats = (xfs[2].match(/<xf\b[^>]*>/g) || []).map(x => (x.match(/numFmtId="(\d+)"/) || [ 0, "0" ])[1]);
    const added = [], cache = new Map();
    const xfFor = (base, kind) => {
      const key = `${base}|${kind}`;
      if (!cache.has(key)) {
        const fmt = formats[base] || "0";
        cache.set(key, formats.length + added.length);
        added.push(`<xf numFmtId="${fmt}" fontId="${kind === "header" ? boldFont : 0}" fillId="${firstFill + KINDS.indexOf(kind)}" borderId="0" xfId="0" applyFill="1"` +
          (fmt !== "0" ? ` applyNumberFormat="1"` : "") + (kind === "header" ? ` applyFont="1"` : "") + `/>`);
      }
      return cache.get(key);
    };

    for (const p of plan) {
      const path = `xl/worksheets/sheet${p.sheet}.xml`;
      const file = zip.file(path);
      if (!file) continue;
      const xml = (await file.async("string")).replace(/<row r="(\d+)"([^>]*?)(?<!\/)>([\s\S]*?)<\/row>/g, (whole, r, attrs, inner) => {
        const n = +r;
        const kind = n === p.header ? "header" : p.rows.get(n);
        if (!kind || !FILLS[kind]) return whole;
        return `<row r="${r}"${attrs}>` + inner.replace(/<c r="([A-Z]+\d+)"([^>]*?)(\/?)>/g, (cell, ref, a, close) => {
          const s = a.match(/ s="(\d+)"/);
          const xf = xfFor(s ? +s[1] : 0, kind);
          return `<c r="${ref}"${s ? a.replace(/ s="\d+"/, ` s="${xf}"`) : `${a} s="${xf}"`}${close}>`;
        }) + "</row>";
      });
      zip.file(path, xml);
    }

    const fontInner = (fonts[3].match(/<font>([\s\S]*?)<\/font>/) || [ "", "" ])[1];
    styles = styles
      .replace(fills[0], `<fills count="${firstFill + KINDS.length}">${fills[2]}` +
        KINDS.map(k => `<fill><patternFill patternType="solid"><fgColor rgb="${FILLS[k]}"/><bgColor indexed="64"/></patternFill></fill>`).join("") + `</fills>`)
      .replace(fonts[0], `<fonts count="${boldFont + 1}"${fonts[2]}>${fonts[3]}<font><b/>${fontInner}</font></fonts>`)
      .replace(xfs[0], `<cellXfs count="${formats.length + added.length}">${xfs[2]}${added.join("")}</cellXfs>`);
    zip.file("xl/styles.xml", styles);
    return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  }

  /*
   * Adds a sheet explaining the colours. entries: [ [ kind, name, meaning ] ].
   * Returns the plan entry that colours it.
   */
  function addLegend(XLSX, wb, entries, title) {
    let name = "Legend", k = 2;
    while (wb.SheetNames.includes(name)) name = `Legend ${k++}`;
    const aoa = [ [ "Colour", "Meaning" ] ].concat(entries.map(e => [ e[1], e[2] ]));
    if (title) aoa.push([], [ title ]);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [ { wch: 22 }, { wch: 90 } ];
    XLSX.utils.book_append_sheet(wb, ws, name);
    return { sheet: wb.SheetNames.length, header: 1, rows: new Map(entries.map((e, i) => [ i + 2, e[0] ])) };
  }

  return { colour, addLegend, worse, FILLS, escXml };
});
