// Run with:  node tests/xlsx-color.test.js   (or: npm test)
// Colours added to an .xlsx written by SheetJS, checked by reading the file back.
const XLSX = require("../assets/vendor/xlsx.full.min.js");
const JSZip = require("../assets/vendor/jszip.min.js");
const X = require("../assets/js/xlsx-color.js");

let pass = 0, fail = 0;
function expect(name, cond, extra) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log("FAIL:", name, extra === undefined ? "" : JSON.stringify(extra));
  }
}

(async () => {
  const wb = XLSX.utils.book_new();
  const date = new Date(Date.UTC(2026, 0, 2));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    [ "Name", "Coordinate", "Added", "Convert_Status" ],
    [ "A", "26.9, 95.0", date, "OK" ],
    [ "B", "bad", "", "Not converted" ],
    [ "C", "", "", "Empty" ],
    [ "D", "29.8, 94.8", "", "OK - check" ]
  ], { cellDates: true }), "Points & more");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([ [ "untouched" ], [ 1 ] ]), "Other");
  const legend = X.addLegend(XLSX, wb, [ [ "ok", "Green", "Converted" ], [ "check", "Orange", "Check" ], [ "bad", "Red", "Not converted" ] ], "Made by a test");
  expect("legend is added last with its rows planned", wb.SheetNames[2] === "Legend" && legend.sheet === 3 && legend.rows.get(2) === "ok" && legend.rows.get(4) === "bad");

  const plain = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  const plan = [ { sheet: 1, header: 1, rows: new Map([ [ 2, "ok" ], [ 3, "bad" ], [ 5, "check" ] ]) }, legend ];
  const out = await X.colour(new Uint8Array(plain), plan, JSZip);

  // Read it back as Excel would see it.
  const zip = await JSZip.loadAsync(out);
  const styles = await zip.file("xl/styles.xml").async("string");
  const sheet1 = await zip.file("xl/worksheets/sheet1.xml").async("string");
  const sheet2 = await zip.file("xl/worksheets/sheet2.xml").async("string");
  const xfs = styles.match(/<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/);
  const xfList = xfs[2].match(/<xf\b[^>]*>/g);
  const fills = styles.match(/<fills count="(\d+)">([\s\S]*?)<\/fills>/);
  const fillList = fills[2].match(/<fill>[\s\S]*?<\/fill>/g);
  expect("counts in styles.xml match what is listed", +xfs[1] === xfList.length && +fills[1] === fillList.length, [ xfs[1], xfList.length, fills[1], fillList.length ]);
  const styleOf = ref => {
    const m = sheet1.match(new RegExp(`<c r="${ref}"[^>]*?s="(\\d+)"`));
    return m ? +m[1] : null;
  };
  const fillOf = ref => {
    const s = styleOf(ref);
    if (s == null) return null;
    const fillId = +xfList[s].match(/fillId="(\d+)"/)[1];
    return (fillList[fillId].match(/rgb="(\w+)"/) || [])[1] || null;
  };
  expect("converted row is green", fillOf("A2") === X.FILLS.ok && fillOf("B2") === X.FILLS.ok, [ fillOf("A2"), fillOf("B2") ]);
  expect("failed row is red", fillOf("A3") === X.FILLS.bad && fillOf("D3") === X.FILLS.bad);
  expect("row to check is orange", fillOf("A5") === X.FILLS.check);
  expect("empty row is left alone", styleOf("A4") === null);
  expect("header is grey and bold", fillOf("A1") === X.FILLS.header && /fontId="1"/.test(xfList[styleOf("A1")]) && /<font><b\/>/.test(styles));
  expect("a date keeps its date format when coloured", /numFmtId="14"/.test(xfList[styleOf("C2")]) && fillOf("C2") === X.FILLS.ok, xfList[styleOf("C2")]);
  expect("sheets not in the plan are untouched", !/ s="/.test(sheet2));

  const back = XLSX.read(out, { type: "array", cellDates: true });
  expect("values survive", back.SheetNames.join("|") === "Points & more|Other|Legend" && back.Sheets["Points & more"].B3.v === "bad" && back.Sheets["Points & more"].C2.v instanceof Date && back.Sheets.Legend.B4.v === "Not converted", back.SheetNames);

  // Rows with no cells, written as <row r="n"/>, must not swallow the next row.
  const tricky = '<sheetData><row r="1"><c r="A1" t="str"><v>h</v></c></row><row r="2"/><row r="3"><c r="A3"><v>1</v></c></row></sheetData>';
  const z2 = await JSZip.loadAsync(new Uint8Array(plain));
  const s1 = await z2.file("xl/worksheets/sheet1.xml").async("string");
  z2.file("xl/worksheets/sheet1.xml", s1.replace(/<sheetData>[\s\S]*<\/sheetData>/, tricky));
  const out2 = await X.colour(await z2.generateAsync({ type: "uint8array" }), [ { sheet: 1, header: 0, rows: new Map([ [ 2, "bad" ], [ 3, "ok" ] ]) } ], JSZip);
  const xml2 = await (await JSZip.loadAsync(out2)).file("xl/worksheets/sheet1.xml").async("string");
  expect("an empty self-closing row is skipped cleanly", /<row r="2"\/><row r="3"><c r="A3" s="\d+">/.test(xml2) && /<c r="A1" t="str">/.test(xml2), xml2.match(/<sheetData>[\s\S]*<\/sheetData>/)[0]);

  expect("the worst colour wins", X.worse("ok", "bad") === "bad" && X.worse("check", "fixed") === "check" && X.worse(null, "ok") === "ok" && X.worse("confirmed", "ok") === "confirmed");

  console.log(`\nxlsx-color: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log("ERROR", e);
  process.exit(1);
});
