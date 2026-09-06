'use strict';

/**
 * 表頭 → 欄位定位。HC HIN LISTING 實際表頭:
 * A=MAWB# B=DEST C=PCS D=WT E=CBM F=TYPE G=ULD# H=Contour I=remark J=accept? K=(Tare)
 * 全部「跟表頭名」配對, 配唔到先用預設字母。
 */

const { cellText, digitsOf } = require('./helpers');

const COLUMN_HEADER_ALIASES = {
  mawb: ['MAWB#', 'MAWB', 'AWB#', 'AWB'],
  dest: ['DEST', 'DESTINATION', 'PORT'],
  pcs: ['PCS', 'PIECES', 'PC', 'PKGS'],
  wt: ['WT', 'WEIGHT', 'GROSS WT', 'GROSS WEIGHT'],
  cbm: ['CBM', 'VOL', 'VOLUME'],
  type: ['TYPE', 'P/X/B', 'PRE-DEC TYPE'],
  uld: ['ULD#', 'ULD NO', 'ULD'],
  contour: ['CONTOUR', 'ULD CONTOUR', 'SUB CONTOUR'],
  remark: ['REMARK', 'REMARKS', '备注', '備註'],
  accept: ['ACCEPT?', 'ACCEPT', 'ACCEPTED'],
  tare: ['TARE', 'TARE WT', 'TARE WEIGHT', 'TARE WEIGHT(KG)'],
};

const FALLBACK_COLS = {
  mawb: 'A',
  dest: 'B',
  pcs: 'C',
  wt: 'D',
  cbm: 'E',
  type: 'F',
  uld: 'G',
  contour: 'H',
  remark: 'I',
  accept: 'J',
  tare: 'K',
};

const { colLetterToIndex } = require('./helpers');

/** 搵每欄 column index (by header name, fallback 字母) */
function locateColumns(ws, headerRow) {
  const found = {};
  const row = ws.getRow(headerRow || 1);
  for (const field of Object.keys(COLUMN_HEADER_ALIASES)) {
    for (const alias of COLUMN_HEADER_ALIASES[field]) {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const t = String(cellText(cell)).trim().toUpperCase();
        if (t === alias && found[field] === undefined) found[field] = cell.col;
      });
      if (found[field] !== undefined) break;
    }
  }
  const cols = {};
  for (const field of Object.keys(FALLBACK_COLS)) {
    const letter = FALLBACK_COLS[field]; // tare fallback = 'K' (用戶確認 K 欄就係 tare weight)
    cols[field] = found[field] !== undefined ? found[field] : colLetterToIndex(letter);
  }
  cols.headerRow = headerRow || 1;
  return cols;
}

/** 掃資料行 (A 欄 = 11 位 MAWB 嗰啲行) */
function collectDataRows(ws, cols) {
  const rows = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber <= cols.headerRow) return;
    const mawbDigits = digitsOf(cellText(row.getCell(cols.mawb)));
    if (mawbDigits.length !== 11) return;
    rows.push({
      rowNumber,
      row,
      mawb: mawbDigits,
      type: cellText(row.getCell(cols.type)).toUpperCase().trim(),
      uld: require('./helpers').normUld(cellText(row.getCell(cols.uld))),
    });
  });
  return rows;
}

module.exports = { locateColumns, collectDataRows, COLUMN_HEADER_ALIASES, FALLBACK_COLS };
