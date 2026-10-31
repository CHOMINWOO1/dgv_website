import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import vm from "node:vm";

const context = { TextEncoder, Uint8Array, Uint32Array, DataView, Date };
vm.runInNewContext(await readFile(new URL("../assets/dgv-xlsx.js", import.meta.url), "utf8"), context);
const { buildWorkbookBytes } = context.DGV_XLSX;

function crc(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length);
  bytes.write(type, 4);
  data.copy(bytes, 8);
  bytes.writeUInt32BE(crc(bytes.subarray(4, bytes.length - 4)), bytes.length - 4);
  return bytes;
}
function png(width = 2, height = 1) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0, 255, 255, 255, 255, 255]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
function dataUrl(bytes) { return `data:image/png;base64,${bytes.toString("base64")}`; }
function unpack(bytes) {
  const zip = Buffer.from(bytes);
  const entries = new Map();
  let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(zip.readUInt16LE(offset + 8), 0, "Native XLSX remains STORE method");
    const size = zip.readUInt32LE(offset + 18);
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 30, offset + 30 + zip.readUInt16LE(offset + 26)).toString();
    const data = zip.subarray(start, start + size);
    assert.equal(crc(data), zip.readUInt32LE(offset + 14), `ZIP CRC ${name}`);
    assert.equal(entries.has(name), false, `Duplicate ZIP member ${name}`);
    entries.set(name, data);
    offset = start + size;
  }
  return entries;
}
const imageBytes = png();
const image = { dataUrl:dataUrl(imageBytes), row:1, column:2, offsetX:3, offsetY:4, width:100, height:25, description:'Signature <&"' };
const report = {
  name:"Staff's 지급",
  rows:[[{ value:"급여 지급", style:"receiptTitle" }, "", ""], ["=HYPERLINK(\"https://example.com\")", { value:220000, style:"receiptInteger" }, { value:"직원\n2026-10-31", style:"receiptSignature" }]],
  rowHeights:[28, 48], columnWidths:[26, 18, 25], merges:["A1:C1"], freezeRows:1,
  showGridLines:false,
  printSettings:{ paperSize:"A4", orientation:"landscape", fitToWidth:1, fitToHeight:0, printArea:"A1:C2", repeatRows:"1:1", margins:{ top:0.4 } },
  images:[image, { ...image, row:0, description:"second" }],
};
const entries = unpack(buildWorkbookBytes({ sheets:[{ name:"Legacy", rows:[["unchanged", 5]] }, report, { name:"Another", rows:[["test"]], images:[{ ...image, row:0, column:0 }] }] }));
const xml = name=>entries.get(name)?.toString();
assert.deepEqual(entries.get("xl/media/image1.png"), imageBytes, "Original PNG bytes embedded");
assert.deepEqual(entries.get("xl/media/image2.png"), imageBytes);
assert.deepEqual(entries.get("xl/media/image3.png"), imageBytes);
assert.equal(entries.has("xl/drawings/drawing1.xml"), false, "Legacy sheet has no drawing");
assert.match(xml("[Content_Types].xml"), /Extension="png" ContentType="image\/png"/);
assert.match(xml("[Content_Types].xml"), /PartName="\/xl\/drawings\/drawing2.xml"/);
assert.match(xml("xl/worksheets/_rels/sheet2.xml.rels"), /Target="\.\.\/drawings\/drawing2.xml"/);
assert.match(xml("xl/drawings/_rels/drawing2.xml.rels"), /Id="rId2"[^>]+Target="\.\.\/media\/image2.png"/);
assert.match(xml("xl/drawings/_rels/drawing3.xml.rels"), /Id="rId1"[^>]+Target="\.\.\/media\/image3.png"/);
const drawing = xml("xl/drawings/drawing2.xml");
assert.equal((drawing.match(/<xdr:oneCellAnchor>/g) || []).length, 2);
assert.match(drawing, /<xdr:col>2<\/xdr:col><xdr:colOff>28575<\/xdr:colOff><xdr:row>1<\/xdr:row><xdr:rowOff>38100<\/xdr:rowOff>/);
assert.match(drawing, /<xdr:ext cx="952500" cy="238125"\/>/);
assert.match(drawing, /descr="Signature &lt;&amp;&quot;"/);
assert.match(drawing, /<a:blip r:embed="rId2"/);
assert.ok(drawing.indexOf("<xdr:from>") < drawing.indexOf("<xdr:ext ") && drawing.indexOf("<xdr:ext ") < drawing.indexOf("<xdr:pic>") && drawing.indexOf("<xdr:pic>") < drawing.indexOf("<xdr:clientData/>") );
const sheet = xml("xl/worksheets/sheet2.xml");
assert.match(sheet, /<c r="B2" s="13"><v>220000<\/v><\/c>/, "Amount remains numeric");
assert.match(sheet, /t="inlineStr"[^>]*><is><t[^>]*>=HYPERLINK/);
assert.doesNotMatch(sheet, /<f(?:\s|>)/, "Employee text cannot become a formula");
assert.match(sheet, /showGridLines="0"/);
assert.match(sheet, /<row r="2" ht="48" customHeight="1">/);
assert.match(sheet, /<pageSetUpPr fitToPage="1"/);
assert.match(sheet, /<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/);
assert.ok(sheet.indexOf("<sheetPr>") < sheet.indexOf("<dimension "));
assert.ok(sheet.indexOf("<pageMargins ") < sheet.indexOf("<pageSetup ") && sheet.indexOf("<pageSetup ") < sheet.indexOf("<drawing "));
assert.match(xml("xl/workbook.xml"), /name="_xlnm.Print_Area" localSheetId="1">&apos;Staff&apos;&apos;s 지급&apos;!\$A\$1:\$C\$2/);
assert.match(xml("xl/workbook.xml"), /name="_xlnm.Print_Titles" localSheetId="1">&apos;Staff&apos;&apos;s 지급&apos;!\$1:\$1/);
assert.doesNotMatch([...entries].filter(([name])=>name.endsWith(".rels")).map(([, data])=>data.toString()).join(""), /TargetMode|Target="(?:https?:|file:|data:)/);
const styles = xml("xl/styles.xml");
const styleXfs = /<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/.exec(styles);
assert.equal(Number(styleXfs[1]), (styleXfs[2].match(/<xf /g) || []).length);
assert.equal(Number(styleXfs[1]), 27);
const xfs = styleXfs[2].match(/<xf\b[^>]*\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g);
assert.match(xfs[21], /vertical="bottom" wrapText="1"/);
assert.match(xfs[23], /numFmtId="165"/);
assert.match(xfs[25], /numFmtId="166"/);
assert.match(xfs[26], /numFmtId="166"[^>]*fillId="5"/);
assert.match(styles, /numFmtId="166" formatCode="#,##0\.00"/);
assert.doesNotMatch(xml("xl/worksheets/sheet1.xml"), /<drawing|<pageSetup|showGridLines|customHeight/, "New options do not affect legacy sheets");

function expectBadImage(patch, pattern) {
  assert.throws(()=>buildWorkbookBytes({ sheets:[{ rows:[["test"]], images:[{ ...image, ...patch }] }] }), pattern);
}
expectBadImage({ dataUrl:"https://example.com/signature.png" }, /PNG data URL/);
expectBadImage({ dataUrl:"data:image/svg+xml;base64,PHN2Zy8+" }, /PNG data URL/);
expectBadImage({ dataUrl:dataUrl(Buffer.from("not a png")) }, /PNG/);
const broken = Buffer.from(imageBytes); broken[40] ^= 1;
expectBadImage({ dataUrl:dataUrl(broken) }, /PNG chunk/);
expectBadImage({ dataUrl:dataUrl(imageBytes.subarray(0, -4)) }, /PNG/);
expectBadImage({ dataUrl:dataUrl(Buffer.concat([imageBytes, Buffer.from("tail")])) }, /PNG ending/);
expectBadImage({ dataUrl:dataUrl(png(4097, 1)) }, /PNG dimensions/);
expectBadImage({ row:-1 }, /anchor/);
expectBadImage({ row:1048576 }, /anchor/);
expectBadImage({ column:16384 }, /anchor/);
expectBadImage({ width:Infinity }, /size/);
expectBadImage({ height:0 }, /size/);
expectBadImage({ offsetX:-1 }, /offset/);
for (const printSettings of [
  { printArea:"A1:XFE2" }, { printArea:"B2:A1" }, { printArea:'A1:B2"/><evil/>' },
  { repeatRows:"2:1" }, { repeatRows:"1:1048577" }, { orientation:'landscape" x="1' },
  { margins:{ left:NaN } }, { fitToHeight:-1 },
]) assert.throws(()=>buildWorkbookBytes({ sheets:[{ rows:[["test"]], printSettings }] }), /print|orientation|repeating/);
assert.throws(()=>buildWorkbookBytes({ sheets:[{ rows:[["test"]], rowHeights:[410] }] }), /row height/);
const noImages = unpack(buildWorkbookBytes({ sheets:[{ name:"Legacy", rows:[["plain", 0]] }] }));
assert.doesNotMatch(noImages.get("[Content_Types].xml").toString(), /image\/png|drawing/);
assert.equal([...noImages.keys()].some(name=>name.includes("drawings/") || name.includes("media/")), false);
console.log("XLSX image, print layout, safe text, and legacy option regression checks passed.");
