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
    wrapped: 7,
    receiptTitle: 8,
    receiptMeta: 9,
    receiptHeader: 10,
    receiptText: 11,
    receiptCenter: 12,
    receiptInteger: 13,
    receiptTextAlt: 14,
    receiptCenterAlt: 15,
    receiptIntegerAlt: 16,
    receiptTotal: 17,
    receiptTotalNumber: 18,
    receiptAccent: 19,
    receiptNote: 20,
    receiptSignature: 21,
    receiptSignatureAlt: 22,
    receiptDate: 23,
    receiptDateAlt: 24,
    receiptRate: 25,
    receiptRateAlt: 26
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

  function printRange(value){
    const match = typeof value === "string" && /^([A-Z]{1,3})([1-9]\d*):([A-Z]{1,3})([1-9]\d*)$/.exec(value);
    const column = name=>[...name].reduce((result, char)=>result * 26 + char.charCodeAt(0) - 64, 0);
    if (!match || column(match[1]) > column(match[3]) || column(match[3]) > MAX_COLUMNS ||
        Number(match[2]) > Number(match[4]) || Number(match[4]) > MAX_ROWS){
      throw new Error("Invalid workbook print area");
    }
    return `$${match[1]}$${match[2]}:$${match[3]}$${match[4]}`;
  }

  function normalizePrintSettings(input){
    if (!input) return null;
    if (typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid workbook print settings");
    const orientation = input.orientation || "landscape";
    if (!["portrait", "landscape"].includes(orientation) || (input.paperSize && input.paperSize !== "A4")){
      throw new Error("Invalid workbook paper size or orientation");
    }
    const pageCount = (value, fallback)=>{
      const count = value === undefined ? fallback : value;
      if (!Number.isInteger(count) || count < 0 || count > 32767) throw new Error("Invalid workbook print scale");
      return count;
    };
    const margins = { left:0.3, right:0.3, top:0.5, bottom:0.5, header:0.2, footer:0.2 };
    Object.keys(margins).forEach(key=>{
      if (input.margins?.[key] === undefined) return;
      const value = input.margins[key];
      if (!Number.isFinite(value) || value < 0 || value > 10) throw new Error("Invalid workbook print margin");
      margins[key] = value;
    });
    let repeatRows = "";
    if (input.repeatRows !== undefined){
      const match = /^([1-9]\d*):([1-9]\d*)$/.exec(input.repeatRows);
      if (!match || Number(match[1]) > Number(match[2]) || Number(match[2]) > MAX_ROWS){
        throw new Error("Invalid workbook repeating rows");
      }
      repeatRows = `$${match[1]}:$${match[2]}`;
    }
    return {
      orientation, margins, repeatRows,
      printArea:input.printArea === undefined ? "" : printRange(input.printArea),
      fitToWidth:pageCount(input.fitToWidth, 1),
      fitToHeight:pageCount(input.fitToHeight, 0)
    };
  }

  // Embedded images never create an external relationship or fetch a URL. Validate
  // PNG structure and chunk checksums before including its original bytes in ZIP.
  function pngBytes(dataUrl){
    const prefix = "data:image/png;base64,";
    if (typeof dataUrl !== "string" || !dataUrl.startsWith(prefix) || dataUrl.length > 7000000){
      throw new Error("Workbook image must be a PNG data URL");
    }
    const base64 = dataUrl.slice(prefix.length);
    if (!base64.length || base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)){
      throw new Error("Invalid workbook PNG encoding");
    }
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    const size = base64.length / 4 * 3 - padding;
    if (size < 57 || size > 5 * 1024 * 1024) throw new Error("Workbook PNG exceeds image size limits");
    if ((padding === 2 && (alphabet.indexOf(base64[base64.length - 3]) & 15)) ||
        (padding === 1 && (alphabet.indexOf(base64[base64.length - 2]) & 3))){
      throw new Error("Invalid workbook PNG encoding");
    }
    const bytes = new Uint8Array(size);
    let output = 0;
    for (let i=0; i<base64.length; i+=4){
      const value = (alphabet.indexOf(base64[i]) << 18) | (alphabet.indexOf(base64[i + 1]) << 12) |
        (Math.max(0, alphabet.indexOf(base64[i + 2])) << 6) | Math.max(0, alphabet.indexOf(base64[i + 3]));
      if (output < size) bytes[output++] = value >>> 16;
      if (output < size) bytes[output++] = value >>> 8;
      if (output < size) bytes[output++] = value;
    }
    const signature = [137,80,78,71,13,10,26,10];
    if (signature.some((value, i)=>bytes[i] !== value)) throw new Error("Invalid workbook PNG signature");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 8;
    let sawHeader = false;
    let sawData = false;
    let sawEnd = false;
    while (offset + 12 <= bytes.length){
      const length = view.getUint32(offset, false);
      if (length > bytes.length - offset - 12) throw new Error("Truncated workbook PNG");
      const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      if (!/^[A-Za-z]{4}$/.test(type) || crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== view.getUint32(offset + 8 + length, false)){
        throw new Error("Invalid workbook PNG chunk");
      }
      if (!sawHeader && type !== "IHDR") throw new Error("Workbook PNG is missing its header");
      if (type === "IHDR"){
        if (sawHeader || length !== 13) throw new Error("Invalid workbook PNG header");
        const width = view.getUint32(offset + 8, false);
        const height = view.getUint32(offset + 12, false);
        const depth = bytes[offset + 16];
        const color = bytes[offset + 17];
        const depths = { 0:[1,2,4,8,16], 2:[8,16], 3:[1,2,4,8], 4:[8,16], 6:[8,16] };
        if (width < 1 || height < 1 || width > 4096 || height > 4096 || !depths[color]?.includes(depth) ||
            bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] > 1){
          throw new Error("Invalid workbook PNG dimensions or format");
        }
        sawHeader = true;
      } else if (type === "IDAT"){
        if (length) sawData = true;
      } else if (type === "IEND"){
        if (length || !sawData || offset + 12 !== bytes.length) throw new Error("Invalid workbook PNG ending");
        sawEnd = true;
      } else if (type !== "PLTE" && type[0] === type[0].toUpperCase()){
        throw new Error("Unsupported workbook PNG chunk");
      }
      offset += length + 12;
      if (sawEnd) break;
    }
    if (!sawEnd || offset !== bytes.length) throw new Error("Incomplete workbook PNG");
    return bytes;
  }

  function normalizeImage(input, imageIndex){
    if (!input || typeof input !== "object") throw new Error("Invalid workbook image");
    const coordinate = (value, maximum)=>{
      if (!Number.isInteger(value) || value < 0 || value >= maximum) throw new Error("Invalid workbook image anchor");
      return value;
    };
    const pixels = (value, positive)=>{
      if (!Number.isFinite(value) || value < (positive ? 0.01 : 0) || value > 4096) throw new Error("Invalid workbook image size or offset");
      return Math.round(value * 9525);
    };
    return {
      bytes:pngBytes(input.dataUrl), imageIndex,
      row:coordinate(input.row, MAX_ROWS), column:coordinate(input.column, MAX_COLUMNS),
      offsetX:pixels(input.offsetX ?? 0, false), offsetY:pixels(input.offsetY ?? 0, false),
      width:pixels(input.width, true), height:pixels(input.height, true),
      description:String(input.description ?? "").slice(0, 1024)
    };
  }

  function drawingXml(images){
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${images.map((image, index)=>`
  <xdr:oneCellAnchor>
    <xdr:from><xdr:col>${image.column}</xdr:col><xdr:colOff>${image.offsetX}</xdr:colOff><xdr:row>${image.row}</xdr:row><xdr:rowOff>${image.offsetY}</xdr:rowOff></xdr:from>
    <xdr:ext cx="${image.width}" cy="${image.height}"/>
    <xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${image.imageIndex}" name="Image ${image.imageIndex}" descr="${xmlEscape(image.description)}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>
      <xdr:blipFill><a:blip r:embed="rId${index + 1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
      <xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${image.width}" cy="${image.height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>
    </xdr:pic><xdr:clientData/>
  </xdr:oneCellAnchor>`).join("")}
</xdr:wsDr>`;
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
    const gridLines = sheet.showGridLines === false ? ' showGridLines="0"' : "";
    const sheetView = freezeRows
      ? `<sheetView workbookViewId="0"${gridLines}><pane ySplit="${freezeRows}" topLeftCell="A${freezeRows + 1}" activePane="bottomLeft" state="frozen"/></sheetView>`
      : `<sheetView workbookViewId="0"${gridLines}/>`;
    const columns = Array.isArray(sheet.columnWidths) && sheet.columnWidths.length
      ? `<cols>${sheet.columnWidths.map((width, index)=>{
          const safeWidth = Math.max(4, Math.min(80, Number(width) || 12));
          return `<col min="${index + 1}" max="${index + 1}" width="${safeWidth}" customWidth="1"/>`;
        }).join("")}</cols>`
      : "";
    const rowXml = rows.map((row, rowIndex)=>{
      if (!Array.isArray(row)) throw new Error(`Invalid row ${rowIndex + 1} in ${sheet.name}`);
      const cells = row.map((value, columnIndex)=>cellXml(value, rowIndex, columnIndex)).join("");
      const height = sheet.rowHeights?.[rowIndex];
      if (height !== undefined && (!Number.isFinite(height) || height <= 0 || height > 409)){
        throw new Error(`Invalid row height at row ${rowIndex + 1}`);
      }
      return `<row r="${rowIndex + 1}"${height === undefined ? "" : ` ht="${height}" customHeight="1"`}>${cells}</row>`;
    }).join("");
    const autoFilter = validateRangeReference(sheet.autoFilterRange)
      ? `<autoFilter ref="${sheet.autoFilterRange}"/>`
      : "";
    const merges = (Array.isArray(sheet.merges) ? sheet.merges : [])
      .filter(validateRangeReference);
    const mergeXml = merges.length
      ? `<mergeCells count="${merges.length}">${merges.map(ref=>`<mergeCell ref="${ref}"/>`).join("")}</mergeCells>`
      : "";
    const print = sheet._print;
    const margins = print?.margins || { left:0.3, right:0.3, top:0.5, bottom:0.5, header:0.2, footer:0.2 };

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"${sheet._images.length ? ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' : ""}>
  ${print ? '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' : ""}
  <dimension ref="${dimension}"/>
  <sheetViews>${sheetView}</sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  ${columns}
  <sheetData>${rowXml}</sheetData>
  ${autoFilter}
  ${mergeXml}
  <pageMargins ${Object.entries(margins).map(([key, value])=>`${key}="${value}"`).join(" ")}/>
  ${print ? `<pageSetup paperSize="9" orientation="${print.orientation}" fitToWidth="${print.fitToWidth}" fitToHeight="${print.fitToHeight}"/>` : ""}
  ${sheet._images.length ? '<drawing r:id="rId1"/>' : ""}
</worksheet>`;
  }

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="3"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/><numFmt numFmtId="166" formatCode="#,##0.00"/></numFmts>
  <fonts count="10">
    <font><sz val="10"/><name val="Aptos"/><family val="2"/></font>
    <font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Aptos"/><family val="2"/></font>
    <font><b/><sz val="14"/><name val="Aptos"/><family val="2"/></font>
    <font><b/><sz val="10"/><name val="Aptos"/><family val="2"/></font>
    <font><b/><color rgb="FF19364F"/><sz val="16"/><name val="Aptos"/><family val="2"/></font>
    <font><color rgb="FF19364F"/><sz val="9"/><name val="Aptos"/><family val="2"/></font>
    <font><color rgb="FF19364F"/><sz val="10"/><name val="Aptos"/><family val="2"/></font>
    <font><b/><color rgb="FF19364F"/><sz val="10"/><name val="Aptos"/><family val="2"/></font>
    <font><b/><color rgb="FF008B82"/><sz val="10"/><name val="Aptos"/><family val="2"/></font>
    <font><color rgb="FF526779"/><sz val="8"/><name val="Aptos"/><family val="2"/></font>
  </fonts>
  <fills count="7">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF5B4632"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF19364F"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF2F7FB"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF6F9FC"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFEAF3F5"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="3">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left/><right/><top/><bottom style="thin"><color rgb="FFD8CDBF"/></bottom><diagonal/></border>
    <border><left style="thin"><color rgb="FFD4DFE7"/></left><right style="thin"><color rgb="FFD4DFE7"/></right><top style="thin"><color rgb="FFD4DFE7"/></top><bottom style="thin"><color rgb="FFD4DFE7"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="27">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
    <xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>
    <xf numFmtId="3" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="5" fillId="4" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="1" fillId="3" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="6" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="6" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="3" fontId="6" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="0" fontId="6" fillId="5" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="6" fillId="5" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="3" fontId="6" fillId="5" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="0" fontId="7" fillId="6" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="3" fontId="7" fillId="6" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="0" fontId="8" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="9" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="9" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="bottom" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="9" fillId="5" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="bottom" wrapText="1"/></xf>
    <xf numFmtId="165" fontId="6" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="165" fontId="6" fillId="5" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="166" fontId="6" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="166" fontId="6" fillId="5" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  function buildWorkbookBytes(options){
    const inputSheets = Array.isArray(options?.sheets) ? options.sheets : [];
    if (!inputSheets.length) throw new Error("Workbook needs at least one sheet");
    if (inputSheets.length > 255) throw new Error("Workbook has too many sheets");

    const usedNames = new Set();
    let imageCount = 0;
    let imageBytes = 0;
    const sheets = inputSheets.map(sheet=>{
      if (sheet?.images !== undefined && !Array.isArray(sheet.images)) throw new Error("Invalid workbook images");
      const images = (sheet?.images || []).map(input=>{
        if (++imageCount > 1000) throw new Error("Workbook has too many images");
        const image = normalizeImage(input, imageCount);
        imageBytes += image.bytes.length;
        if (imageBytes > 40 * 1024 * 1024) throw new Error("Workbook images exceed size limit");
        return image;
      });
      return {
        ...sheet,
        name:cleanSheetName(sheet?.name, usedNames),
        _print:normalizePrintSettings(sheet?.printSettings),
        _images:images
      };
    });

    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  ${imageCount ? '<Default Extension="png" ContentType="image/png"/>' : ""}
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${sheets.map((_, index)=>`<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}
  ${sheets.map((sheet, index)=>sheet._images.length ? `<Override PartName="/xl/drawings/drawing${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>` : "").join("")}
</Types>`;
    const rootRelationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
    const printNames = sheets.map((sheet, index)=>{
      const quotedName = `'${sheet.name.replace(/'/g, "''")}'!`;
      return [
        sheet._print?.printArea ? `<definedName name="_xlnm.Print_Area" localSheetId="${index}">${xmlEscape(quotedName + sheet._print.printArea)}</definedName>` : "",
        sheet._print?.repeatRows ? `<definedName name="_xlnm.Print_Titles" localSheetId="${index}">${xmlEscape(quotedName + sheet._print.repeatRows)}</definedName>` : ""
      ].join("");
    }).join("");
    const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <bookViews><workbookView activeTab="0"/></bookViews>
  <sheets>${sheets.map((sheet, index)=>`<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets>
  ${printNames ? `<definedNames>${printNames}</definedNames>` : ""}
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
    sheets.forEach((sheet, index)=>{
      if (!sheet._images.length) return;
      files.push(
        { name:`xl/worksheets/_rels/sheet${index + 1}.xml.rels`, content:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${index + 1}.xml"/></Relationships>` },
        { name:`xl/drawings/drawing${index + 1}.xml`, content:drawingXml(sheet._images) },
        { name:`xl/drawings/_rels/drawing${index + 1}.xml.rels`, content:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheet._images.map((image, imageIndex)=>`<Relationship Id="rId${imageIndex + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${image.imageIndex}.png"/>`).join("")}</Relationships>` },
        ...sheet._images.map(image=>({ name:`xl/media/image${image.imageIndex}.png`, content:image.bytes }))
      );
    });
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
