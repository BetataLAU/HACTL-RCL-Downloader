'use strict';

/**
 * 由 COSAC 詳細頁嘅 innerText 抽 RCL 欄位 (DOM-first 來源)
 * 主要用 label→value 規則; 抽唔到就留空, 之後會由 RCL PDF fallback 補
 */

function clean(s) {
  return String(s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 文字片段: match 位置前後各 40 字 (debug 用, 顯示「抽喺邊度」) */
function ctxAround(text, start, len) {
  const a = Math.max(0, start - 40);
  const b = Math.min(text.length, start + len + 40);
  return clean(text.slice(a, b));
}

/** 淨 11 位數字 (MAWB key) */
function mawbOf(text) {
  const m = text.match(/(?:^|\D)(\d{3})-?(\d{8})(?:\D|$)/);
  if (m) return m[1] + m[2];
  const m2 = text.match(/(?:^|\D)(\d{11})(?:\D|$)/);
  return m2 ? m2[1] : null;
}

/**
 * ULD Information 表嘅欄位順序 (由真實 DOM snapshot 確認:
 * innerText = label 一行、值一行, 表頭順序固定)
 */
const ULD_INFO_HEADERS = [
  'SEQ', 'ULD', 'ULD Type', 'CON', 'SUBCON', 'Pieces',
  'Gross Weight(KG)', 'Tare Weight(KG)', 'Net Weight(KG)',
  'RCL No.', 'RCL Date Time', 'H', 'O/H',
];

/** 喺 raw innerText 搵「label : <值喺同一行或下一行>」 */
function valAfterLabel(raw, label, valueRe) {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('(?:^|\\r?\\n)\\s*' + esc + '\\s*:\\s*(?:\\r?\\n|\\t)*\\s*(' + valueRe + ')', 'i');
  const m = String(raw || '').match(re);
  return m ? m[1] : null;
}

/** DOM 顯示 PREPACK/BULK 全寫 → 代碼 P/B/X (若已經係單字照保留) */
function normalizeType(v) {
  const s = String(v || '').trim().toUpperCase();
  if (!s) return null;
  if (s === 'P' || s === 'PREPACK' || /^PRE/.test(s)) return 'P';
  if (s === 'B' || s === 'BULK') return 'B';
  if (s === 'X' || s === 'MIX' || /MIX/.test(s)) return 'X';
  return s;
}

/**
 * 解析 ULD Information 表: 喺 raw innerText 度, 每個 header/值都佔一行
 * (中間夾住 tab 行)。返回每行 ULD 資料 row[]。
 */
function parseUldBlock(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== 'ULD Information') continue;
    const toks = [];
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (!t || t === '\t') continue;
      if (/^FCC\b/.test(t) || t === 'PAL' || t === 'CPlus' || t === 'General Information' || t === 'Screening Information') break;
      toks.push(t);
    }
    const start = toks.indexOf('SEQ');
    if (start < 0) continue;
    let n = 0;
    while (n < ULD_INFO_HEADERS.length && toks[start + n] === ULD_INFO_HEADERS[n]) n++;
    if (n === 0) continue;
    const vals = toks.slice(start + n, start + n + n);
    if (!vals.length) continue;
    const row = {};
    for (let k = 0; k < n; k++) row[ULD_INFO_HEADERS[k]] = vals[k] !== undefined ? vals[k] : '';
    out.push(row);
  }
  return out;
}

/** 由詳細頁文字抽出欄位 (全部 optional; 抽唔到 = null) */
function extractFromDetailText(raw) {
  const text = String(raw || '').replace(/\u00a0/g, ' ');
  const row = parseUldBlock(text)[0] || {};
  const net = row['Net Weight(KG)'] || '';
  const pcsGen = valAfterLabel(text, 'Pieces', '[0-9][0-9,]*');
  return {
    mawb: valAfterLabel(text, 'AWB', '\\d{3}-?\\d{8}') || mawbOf(text),
    type: normalizeType(valAfterLabel(text, 'Pre-declaration Type', '[A-Za-z ]+')) || null,
    dest: valAfterLabel(text, 'Port', '[A-Z]{3}') || null,
    pcs: pcsGen || row['Pieces'] || null,
    wt: net ? clean(net) : null,
    cbm: null,
    uld: row['ULD'] ? clean(row['ULD']) : null,
    contour: row['CON'] ? clean(row['CON']) : null,
    tare: row['Tare Weight(KG)'] ? clean(row['Tare Weight(KG)']) : null,
    lih: valAfterLabel(text, 'LIH', '[YN]') || null,
  };
}

/* ---------------- debug: 逐個 field 連「喺邊度抽到」 ---------------- */

/** debug entry: 以 value 喺 raw text 出現嘅位置做 context (顯示 label/value 前後) */
function entryFor(raw, field, value, label) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return { field, found: false, value: null, label: label || null, context: '' };
  }
  const v = clean(String(value));
  const src = String(raw || '');
  const idx = src.indexOf(v);
  return {
    field,
    found: true,
    value: v,
    label: label || null,
    context: idx >= 0 ? ctxAround(src, idx, v.length) : (label || ''),
  };
}

/** DOM debug: 逐個 field → { field, found, value, label, context }（按固定欄位順序） */
function debugDomParse(raw) {
  const text = String(raw || '').replace(/\u00a0/g, ' ');
  const f = extractFromDetailText(text);
  const row = parseUldBlock(text)[0] || {};
  const labels = {
    mawb: 'AWB :', type: 'Pre-declaration Type :', dest: 'Port :', pcs: 'Pieces :',
    lih: 'LIH :', wt: 'Net Weight(KG)', uld: 'ULD', contour: 'CON', tare: 'Tare Weight(KG)',
  };
  const order = ['mawb', 'type', 'dest', 'pcs', 'wt', 'cbm', 'uld', 'contour', 'tare', 'lih'];
  return order.map((field) => {
    if (field === 'wt') return entryFor(text, 'wt', row['Net Weight(KG)'] || row['Gross Weight(KG)'], labels.wt);
    if (field === 'uld') return entryFor(text, 'uld', row['ULD'], labels.uld);
    if (field === 'contour') return entryFor(text, 'contour', row['CON'], labels.contour);
    if (field === 'tare') return entryFor(text, 'tare', row['Tare Weight(KG)'], labels.tare);
    if (field === 'cbm') return { field: 'cbm', found: false, value: null, label: null, context: '' };
    return entryFor(text, field, f[field], labels[field] || field);
  });
}

/** DOM 欄位「夠唔夠齊」先值得用 (唔齊寧願用 PDF) */
function domQualityOk(f) {
  return !!f && !!f.dest && f.pcs !== null && f.pcs !== undefined && f.wt !== null && f.wt !== undefined;
}

module.exports = { extractFromDetailText, debugDomParse, parseUldBlock, valAfterLabel, normalizeType, domQualityOk, mawbOf };
