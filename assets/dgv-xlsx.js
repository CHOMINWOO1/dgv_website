(function(root){
  "use strict";

  const encoder = new TextEncoder();
  const MAX_ROWS = 1048576;
  const MAX_COLUMNS = 16384;
  const STYLE_INDEX = Object.freeze({
    normal: 0,
    header: 1,
    integer: 2,
    dateTime: 3,
    title: 4,
    totalLabel: 5,
    totalNumber: 6,
    wrapped: 7
  });

  const crcTable = (()=>{
    const table = new Uint32Array(256);
    for (let n=0; n<256; n++){
      let value = n;
      for (let bit=0; bit<8; bit++){
        value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
      }
      table[n] = value >>> 0;
    }
    return table;
  })();

  function xmlEscape(value){
    return String(value ?? "")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
      .replace(/_x([0-9a-f]{4})_/gi, "_x005F_x$1_")
      .replace(/\r/g, "_x000D_")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function crc32(bytes){
    let value = 0xffffffff;
    for (let i=0; i<bytes.length; i++){
      value = crcTable[(value ^ bytes[i]) & 0xff] ^ (value >>> 8);
    }
    return (value ^ 0xffffffff) >>> 0;
  }

  function setU16(bytes, offset, value){
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(offset, value, true);
  }

  function setU32(bytes, offset, value){
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value >>> 0, true);
  }

  function zipDateTime(date){
    const year = Math.min(2107, Math.max(1980, date.getFullYear()));
    const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    return { dosDate, dosTime };
  }

  function concatBytes(chunks, totalLength){
    const result = new Uint8Array(totalLength);
    let offset = 0;
    chunks.forEach(chunk=>{
      result.set(chunk, offset);
      offset += chunk.length;
    });
    return result;
  }

  function makeStoredZip(files){
    const localChunks = [];
    const centralChunks = [];
    const now = zipDateTime(new Date());
    let localOffset = 0;
    let centralLength = 0;

    files.forEach(file=>{
      const nameBytes = encoder.encode(file.name);
      const dataBytes = typeof file.content === "string" ? encoder.encode(file.content) : file.content;
      const checksum = crc32(dataBytes);

      const localHeader = new Uint8Array(30 + nameBytes.length);
      setU32(localHeader, 0, 0x04034b50);
      setU16(localHeader, 4, 20);
      setU16(localHeader, 6, 0x0800);
      setU16(localHeader, 8, 0);
      setU16(localHeader, 10, now.dosTime);
      setU16(localHeader, 12, now.dosDate);
      setU32(localHeader, 14, checksum);
      setU32(localHeader, 18, dataBytes.length);
      setU32(localHeader, 22, dataBytes.length);
      setU16(localHeader, 26, nameBytes.length);
      setU16(localHeader, 28, 0);
      localHeader.set(nameBytes, 30);
      localChunks.push(localHeader, dataBytes);

      const centralHeader = new Uint8Array(46 + nameBytes.length);
      setU32(centralHeader, 0, 0x02014b50);
      setU16(centralHeader, 4, 20);
      setU16(centralHeader, 6, 20);
      setU16(centralHeader, 8, 0x0800);
      setU16(centralHeader, 10, 0);
      setU16(centralHeader, 12, now.dosTime);
      setU16(centralHeader, 14, now.dosDate);
      setU32(centralHeader, 16, checksum);
      setU32(centralHeader, 20, dataBytes.length);
      setU32(centralHeader, 24, dataBytes.length);
      setU16(centralHeader, 28, nameBytes.length);
      setU16(centralHeader, 30, 0);
      setU16(centralHeader, 32, 0);
      setU16(centralHeader, 34, 0);
      setU16(centralHeader, 36, 0);
      setU32(centralHeader, 38, 0);
      setU32(centralHeader, 42, localOffset);
      centralHeader.set(nameBytes, 46);
      centralChunks.push(centralHeader);

      localOffset += localHeader.length + dataBytes.length;
      centralLength += centralHeader.length;
    });

    const end = new Uint8Array(22);
    setU32(end, 0, 0x06054b50);
    setU16(end, 4, 0);
    setU16(end, 6, 0);
    setU16(end, 8, files.length);
    setU16(end, 10, files.length);
    setU32(end, 12, centralLength);
    setU32(end, 16, localOffset);
    setU16(end, 20, 0);

    return concatBytes(
      [...localChunks, ...centralChunks, end],
      localOffset + centralLength + end.length
    );
  }

  function columnName(index){
    let value = index + 1;
    let name = "";
    while (value > 0){
      const remainder = (value - 1) % 26;
      name = String.fromCharCode(65 + remainder) + name;
      value = Math.floor((value - 1) / 26);
    }
    return name;
  }

  function isDate(value){
    return Object.prototype.toString.call(value) === "[object Date]";
  }

  function excelLocalSerial(date){
    if (!Number.isFinite(date.getTime())) throw new Error("Invalid date value in workbook");
    const localAsUtc = Date.UTC(
      date.getFullYear(), date.getMonth(), date.getDate(),
      date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()
    );
    return localAsUtc / 86400000 + 25569;
  }

  function normalizeCell(input){
    if (
      input && typeof input === "object" && !Array.isArray(input) && !isDate(input) &&
      Object.prototype.hasOwnProperty.call(input, "value")
    ){
      return { value: input.value, style: input.style || "normal" };
    }
    return { value: input, style: "normal" };
  }

  function cellXml(input, rowIndex, columnIndex){
    const cell = normalizeCell(input);
    const reference = `${columnName(columnIndex)}${rowIndex + 1}`;
    let style = STYLE_INDEX[cell.style] ?? STYLE_INDEX.normal;
    const styleAttr = style ? ` s="${style}"` : "";

    if (cell.value === null || cell.value === undefined || cell.value === ""){
      return styleAttr ? `<c r="${reference}"${styleAttr}/>` : "";
    }
    if (isDate(cell.value)){
      if (cell.style === "normal") style = STYLE_INDEX.dateTime;
      return `<c r="${reference}" s="${style}"><v>${excelLocalSerial(cell.value)}</v></c>`;
    }
    if (typeof cell.value === "number"){
      if (!Number.isFinite(cell.value)) throw new Error(`Invalid numeric value at ${reference}`);
      return `<c r="${reference}"${styleAttr}><v>${cell.value}</v></c>`;
    }
    if (typeof cell.value === "boolean"){
      return `<c r="${reference}"${styleAttr} t="b"><v>${cell.value ? 1 : 0}</v></c>`;
    }

    const text = String(cell.value);
    if (text.length > 32767) throw new Error(`Text value exceeds Excel limit at ${reference}`);
    return `<c r="${reference}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
  }

  function cleanSheetName(value, usedNames){
    let base = String(value || "Sheet")
      .replace(/[\\/?*\[\]:]/g, " ")
      .trim()
      .replace(/^'+|'+$/g, "")
      .slice(0, 31) || "Sheet";
    if (/^history$/i.test(base)) base = "History 1";
    let candidate = base;
    let suffix = 2;
    while (usedNames.has(candidate.toLowerCase())){
      const tail = ` ${suffix++}`;
      candidate = `${base.slice(0, 31 - tail.length)}${tail}`;
    }
    usedNames.add(candidate.toLowerCase());
    return candidate;
  }

  function validateRangeReference(value){
    return typeof value === "string" && /^[A-Z]+[1-9]\d*:[A-Z]+[1-9]\d*$/.test(value);
  }

  function worksheetXml(sheet){
    const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
    if (rows.length > MAX_ROWS) throw new Error(`Sheet ${sheet.name} exceeds Excel row limit`);
    const maxColumns = Math.max(
      1,
      Array.isArray(sheet.columnWidths) ? sheet.columnWidths.length : 0,
      ...rows.map(row=>Array.isArray(row) ? row.length : 0)
    );
    if (maxColumns > MAX_COLUMNS) throw new Error(`Sheet ${sheet.name} exceeds Excel column limit`);

    const dimension = `A1:${columnName(maxColumns - 1)}${Math.max(1, rows.length)}`;
    const freezeRows = Math.floor(Math.max(0, Math.min(Number(sheet.freezeRows) || 0, rows.length)));
    const sheetView = freezeRows
      ? `<sheetView workbookViewId="0"><pane ySplit="${freezeRows}" topLeftCell="A${freezeRows + 1}" activePane="bottomLeft" state="frozen"/></sheetView>`
      : '<sheetView workbookViewId="0"/>';
    const columns = Array.isArray(sheet.columnWidths) && sheet.columnWidths.length
      ? `<cols>${sheet.columnWidths.map((width, index)=>{
          const safeWidth = Math.max(4, Math.min(80, Number(width) || 12));
          return `<col min="${index + 1}" max="${index + 1}" width="${safeWidth}" customWidth="1"/>`;
        }).join("")}</cols>`
      : "";
    const rowXml = rows.map((row, rowIndex)=>{
      if (!Array.isArray(row)) throw new Error(`Invalid row ${rowIndex + 1} in ${sheet.name}`);
      const cells = row.map((value, columnIndex)=>cellXml(value, rowIndex, columnIndex)).join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    }).join("");
    const autoFilter = validateRangeReference(sheet.autoFilterRange)
      ? `<autoFilter ref="${sheet.autoFilterRange}"/>`
      : "";
    const merges = (Array.isArray(sheet.merges) ? sheet.merges : [])
      .filter(validateRangeReference);
    const mergeXml = merges.length
      ? `<mergeCells count="${merges.length}">${merges.map(ref=>`<mergeCell ref="${ref}"/>`).join("")}</mergeCells>`
      : "";

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="${dimension}"/>
  <sheetViews>${sheetView}</sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  ${columns}
  <sheetData>${rowXml}</sheetData>
  ${autoFilter}
  ${mergeXml}
  <pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>
</worksheet>`;
  }

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/></numFmts>
  <fonts count="4">
    <font><sz val="10"/><name val="Aptos"/><family val="2"/></font>
    <font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Aptos"/><family val="2"/></font>
    <font><b/><sz val="14"/><name val="Aptos"/><family val="2"/></font>
    <font><b/><sz val="10"/><name val="Aptos"/><family val="2"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF5B4632"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left/><right/><top/><bottom style="thin"><color rgb="FFD8CDBF"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="8">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
    <xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>
    <xf numFmtId="3" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  function buildWorkbookBytes(options){
    const inputSheets = Array.isArray(options?.sheets) ? options.sheets : [];
    if (!inputSheets.length) throw new Error("Workbook needs at least one sheet");
    if (inputSheets.length > 255) throw new Error("Workbook has too many sheets");

    const usedNames = new Set();
    const sheets = inputSheets.map(sheet=>({
      ...sheet,
      name: cleanSheetName(sheet?.name, usedNames)
    }));

    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${sheets.map((_, index)=>`<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}
</Types>`;
    const rootRelationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
    const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <bookViews><workbookView activeTab="0"/></bookViews>
  <sheets>${sheets.map((sheet, index)=>`<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets>
  <calcPr calcId="191029"/>
</workbook>`;
    const workbookRelationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${sheets.map((_, index)=>`<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}
  <Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

    const files = [
      { name:"[Content_Types].xml", content:contentTypes },
      { name:"_rels/.rels", content:rootRelationships },
      { name:"xl/workbook.xml", content:workbook },
      { name:"xl/_rels/workbook.xml.rels", content:workbookRelationships },
      { name:"xl/styles.xml", content:stylesXml },
      ...sheets.map((sheet, index)=>({
        name:`xl/worksheets/sheet${index + 1}.xml`,
        content:worksheetXml(sheet)
      }))
    ];
    return makeStoredZip(files);
  }

  function downloadWorkbook(options){
    const bytes = buildWorkbookBytes(options);
    const rawName = String(options?.filename || "export.xlsx");
    const safeName = rawName.replace(/[\\/:*?"<>|]+/g, "_");
    const filename = safeName.toLowerCase().endsWith(".xlsx") ? safeName : `${safeName}.xlsx`;
    const blob = new Blob([bytes], {
      type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(()=>URL.revokeObjectURL(url), 10000);
    return { filename, byteLength:bytes.length };
  }

  root.DGV_XLSX = Object.freeze({
    buildWorkbookBytes,
    downloadWorkbook
  });
})(typeof window !== "undefined" ? window : globalThis);
