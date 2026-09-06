'use strict';

/** 讀取 xlsx 結構 (sheet 清單 + 指定 sheet 概覽), UI 預覽/設定用 */

const ExcelJS = require('exceljs');
const { cellText, digitsOf, normUld } = require('./helpers');
const { locateColumns } = require('./columns');

/** 列出所有 worksheet 名稱 */
async function listSheets(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  return wb.worksheets.map((w, i) => ({ name: w.name, index: i }));
}

/** 睇指定 sheet 嘅表頭/資料行概覽 (唔改檔案) */
async function inspectSheet(file, sheetName, log) {
  const out = { ok: false, file };
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const ws = sheetName ? wb.getWorksheet(sheetName) : wb.worksheets[0];
    if (!ws) throw new Error(`搵唔到 worksheet "${sheetName || ''}"`);
    out.sheet = ws.name;
    out.sheets = wb.worksheets.map((w, i) => ({ name: w.name, index: i }));
    out.totalSheets = wb.worksheets.length;

    const cols = locateColumns(ws, 1);
    out.cols = cols;
    out.headers = [];
    const headerRow = ws.getRow(cols.headerRow);
    for (let c = 1; c <= headerRow.cellCount; c++) {
      const txt = cellText(headerRow.getCell(c));
      if (txt) out.headers.push({ col: c, title: txt });
    }

    let dataRows = 0;
    let sample = [];
    ws.eachRow((row, rowNumber) => {
      if (rowNumber <= cols.headerRow) return;
      const m = digitsOf(cellText(row.getCell(cols.mawb)));
      if (m.length !== 11) return;
      dataRows++;
      if (sample.length < 5) {
        sample.push({
          row: rowNumber,
          mawb: m,
          dest: cellText(row.getCell(cols.dest)),
          pcs: cellText(row.getCell(cols.pcs)),
          wt: cellText(row.getCell(cols.wt)),
          cbm: cellText(row.getCell(cols.cbm)),
          type: cellText(row.getCell(cols.type)).toUpperCase(),
          uld: normUld(cellText(row.getCell(cols.uld))),
          contour: cellText(row.getCell(cols.contour)),
          accept: cellText(row.getCell(cols.accept)),
          tare: cols.tare ? cellText(row.getCell(cols.tare)) : '',
        });
      }
    });
    out.ok = true;
    out.dataRows = dataRows;
    out.sample = sample;
    if (log && typeof log === 'function') {
      log(`Worksheet: "${ws.name}" (共 ${out.totalSheets} 張), 資料行 ${dataRows} 行`);
    }
    return out;
  } catch (e) {
    out.ok = false;
    out.error = e.message;
    return out;
  }
}

module.exports = { listSheets, inspectSheet };
