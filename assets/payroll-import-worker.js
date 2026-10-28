/* N308 files are parsed locally. The source workbook never leaves this worker. */
importScripts("vendor/xlsx-0.20.3.min.js", "payroll-core.js");
self.onmessage = ({data}) => {
  try {
    const book = XLSX.read(data, {type:"array", cellDates:false, cellFormula:true, sheetRows:10002});
    if (book.SheetNames.length !== 1) throw new Error("시트가 하나인 N308 파일을 선택하세요. / Chọn tệp N308 có một trang tính.");
    const sheet = book.Sheets[book.SheetNames[0]];
    const range = XLSX.utils.decode_range(sheet["!fullref"] || sheet["!ref"] || "A1");
    if (range.e.r > 10000 || range.e.c > 30) throw new Error("최대 10,000개 기록만 가져올 수 있습니다. / Tối đa 10.000 bản ghi.");
    for (const [key, cell] of Object.entries(sheet)) {
      if (!key.startsWith("!") && cell.f) throw new Error("수식이 포함된 파일은 가져올 수 없습니다. / Không nhận tệp có công thức.");
    }
    const rows = XLSX.utils.sheet_to_json(sheet, {header:1, raw:true, defval:null, blankrows:true});
    self.postMessage({result:DGV_PAYROLL_CORE.parseRows(rows, {date1904:!!book.Workbook?.WBProps?.date1904})});
  } catch(error) { self.postMessage({error:error.message}); }
};
