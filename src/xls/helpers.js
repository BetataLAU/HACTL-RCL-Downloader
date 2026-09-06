'use strict';

/* XLS 工具: cell 值/MAWB/ULD 讀取與常數 (冇 exceljs dependency, 方便獨立單元測試) */

const WT_TOL = 0.05; // 5% 差異通知
const CBM_ABS_TOL = 0.2; // CBM 差超過 0.2 先當差異

/* C/D/E 字色: 有 RCL (accept?=1) = 黑; 未有 RCL = 紅 (用戶規則) */
const FONT_COLOR_BLACK = 'FF000000';
const FONT_COLOR_RED = 'FFFF0000';

/** 將 cell 值統一轉文字 (支援 richText / formula / hyperlink) */
function cellText(cell) {
  if (!cell) return '';
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v.formula !== undefined) {
      return v.result === undefined || v.result === null ? String(v.formula) : String(v.result);
    }
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text || '').join('');
    if (v.hyperlink !== undefined) return String(v.text || '');
    return '';
  }
  return String(v);
}

/** 淨返數字 (MAWB key 比對用) */
function digitsOf(value) {
  return String(value === null || value === undefined ? '' : value).replace(/[^\d]/g, '');
}

/** ULD# 標準化: 大階 + 去空格 */
function normUld(s) {
  return String(s || '').toUpperCase().replace(/\s+/g, '').trim();
}

/** 將可數值文字轉 number; 空/非數值回 null */
function numValue(s) {
  if (s === null || s === undefined || s === '') return null;
  const n = Number(String(s).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

/** Excel 欄名轉 index: 'A'→1, 'K'→11 */
function colLetterToIndex(letter) {
  const L = String(letter || '').toUpperCase();
  let n = 0;
  for (const ch of L) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

module.exports = { WT_TOL, CBM_ABS_TOL, FONT_COLOR_BLACK, FONT_COLOR_RED, cellText, digitsOf, normUld, numValue, colLetterToIndex };
