'use strict';

/**
 * XLS 同步主流程 (劉鏘鏘):
 * 載入 workbook → 揀 worksheet → 將每個 RCL record 對應返 XLS 行更新
 * Type X = mix-load: 同一 MAWB 可喺多個 ULD 出現 → 以 (MAWB, ULD#) 配對;
 * 冇 (MAWB+ULD) 行但同一 MAWB 有行 → 喺最尾嗰行下面插新行 (照用戶平時做法)
 */

const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const { digitsOf, normUld, cellText, numValue, FONT_COLOR_BLACK, FONT_COLOR_RED } = require('./helpers');
const { locateColumns, collectDataRows } = require('./columns');
const { applyRclToRow, writeCell, setCellFontColor } = require('./update');

/** 複製 anchor row 格式去 target row */
function copyRowStyle(ws, anchorNumber, targetRow) {
  const src = ws.getRow(anchorNumber);
  try {
    for (let c = 1; c <= Math.max(src.cellCount, 12); c++) {
      const s = src.getCell(c);
      if (s.style && Object.keys(s.style).length) {
        try {
          targetRow.getCell(c).style = { ...s.style };
        } catch {
          /* 部分 style 唔支援直接複製, 照樣嘗試 */
        }
      }
    }
  } catch {
    /* 格式複製失敗唔阻礙主流程 */
  }
}

/** 喺 anchor 下面插入 Type X 新行 */
function insertXRow(ws, cols, rec, key, anchor, log) {
  const insertAt = anchor + 1;
  const newRow = ws.insertRow(insertAt, {});
  copyRowStyle(ws, anchor, newRow);
  if (rec.dest) writeCell(newRow, cols.dest, String(rec.dest).trim(), log);
  if (rec.pcs !== null && rec.pcs !== undefined && rec.pcs !== '') {
    const n = numValue(rec.pcs);
    writeCell(newRow, cols.pcs, n !== null ? n : String(rec.pcs), log);
  }
  if (rec.wt !== null && rec.wt !== undefined && rec.wt !== '') {
    const n = numValue(rec.wt);
    writeCell(newRow, cols.wt, n !== null ? n : String(rec.wt), log);
  }
  if (rec.uld) writeCell(newRow, cols.uld, normUld(rec.uld), log);
  if (rec.contour) writeCell(newRow, cols.contour, String(rec.contour).trim(), log);
  if (cols.tare && rec.tare !== null && rec.tare !== undefined && rec.tare !== '') {
    const n = numValue(rec.tare);
    writeCell(newRow, cols.tare, n !== null ? n : String(rec.tare), log);
  }
  if (rec.lih && String(rec.lih).toUpperCase() === 'N') writeCell(newRow, cols.remark, 'no LIH', log);
  writeCell(newRow, cols.accept, 1, log);
  writeCell(newRow, cols.type, 'X', log);
  // 新行有 RCL → C/D/E 唔好跟 anchor 嘅紅色, 直接黑色 (成個 style 換新, 避免共用 style 連帶改其他行)
  for (const c of [cols.pcs, cols.wt, cols.cbm]) {
    if (!c) continue;
    try {
      const cell = newRow.getCell(c);
      const curStyle = cell.style || {};
      cell.style = { ...curStyle, font: { ...(curStyle.font || {}), color: { argb: 'FF000000' } } };
    } catch { /* ignore */ }
  }
  newRow.getCell(cols.mawb).value = Number(key);
  return insertAt;
}

/** C/D/E 字色同 accept? (J) 欄對齊:
 *  J=1 (有 RCL) → 黑 (FF000000);  J 空/0 (未有 RCL) → 紅 (FFFF0000)。
 *  只郁「有值」嘅 cell, 空 cell 唔上色。回傳改動咗幾多個 cell。 */
function reconcileColors(ws, cols, dataRows) {
  let changed = 0;
  for (const dr of dataRows) {
    const j = digitsOf(cellText(dr.row.getCell(cols.accept)));
    const target = j === '1' ? FONT_COLOR_BLACK : FONT_COLOR_RED;
    for (const col of [cols.pcs, cols.wt, cols.cbm]) {
      if (!col) continue;
      if (setCellFontColor(dr.row, col, target)) changed++;
    }
  }
  return changed;
}

/** 主流程: records → 同步 XLS */
async function syncFromRecords(opts) {
  const { file, records, log } = opts;
  const out = {
    ok: false,
    file,
    sheet: null,
    changed: false,
    issues: [],
    rowsUpdated: 0,
    rowsInserted: 0,
    colorAdjusted: 0,
    error: null,
    logLines: [],
  };

  if (!file || !fs.existsSync(file)) {
    out.error = 'XLS 檔唔存在: ' + file;
    return out;
  }
  if (!records || !records.length) {
    out.ok = true;
    out.skippedNoRecords = true;
    return out;
  }

  let wb;
  try {
    wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
  } catch (e) {
    out.error = 'XLS 檔讀唔到 (可能開咗喺 Excel 或已損壞): ' + e.message;
    return out;
  }
  const ws = opts.sheet ? wb.getWorksheet(opts.sheet) : wb.worksheets[0];
  if (!ws) {
    out.error = `搵唔到 worksheet "${opts.sheet || ''}"`;
    return out;
  }
  out.sheet = ws.name;
  const cols = locateColumns(ws, opts.headerRow || 1);
  const dataRows = collectDataRows(ws, cols);
  if (log) log(`XLS 同步: worksheet "${ws.name}" (${dataRows.length} 個 MAWB 行)`);

  const byMawb = new Map();
  for (const dr of dataRows) {
    if (!byMawb.has(dr.mawb)) byMawb.set(dr.mawb, []);
    byMawb.get(dr.mawb).push(dr);
  }

  const inserts = [];
  for (const rec of records) {
    const key = digitsOf(rec && rec.mawb);
    if (key.length !== 11) continue;
    const recType = String(rec.type || '').toUpperCase().trim() || 'P';
    const recUld = normUld(rec.uld);
    let matched;

    if (recType === 'X') {
      const sameMawb = byMawb.get(key) || [];
      matched = sameMawb.filter((dr) => dr.uld === recUld);
      if (!matched.length && sameMawb.length) {
        inserts.push({ rec, key, anchor: sameMawb[sameMawb.length - 1].rowNumber });
        continue;
      }
      if (!matched.length) {
        out.issues.push({
          mawb: key, uld: recUld, col: 'MAWB', type: 'x-not-found',
          message: `Type X (MAWB ${key}/${recUld || '無ULD'}) 唔喺 XLS, 亦冇同 MAWB 可定位 → 未插入`,
        });
        continue;
      }
    } else {
      matched = byMawb.get(key) || [];
      if (!matched.length) {
        out.issues.push({
          mawb: key, col: 'MAWB', type: 'mawb-not-found',
          message: `MAWB ${key} 唔喺 XLS worksheet 度 → 無同步 (需先起好行)`,
        });
        continue;
      }
    }

    for (const dr of matched) {
      out.rowsUpdated++;
      applyRclToRow(rec, dr, cols, out, log);
    }
  }

  /* C/D/E 字色同 accept? (J) 欄對齊 (喺插入新行前做, 避免行號被插行影響):
     J=1 (有 RCL) → 黑; J 空/0 (未有 RCL) → 紅。 */
  const colorCells = reconcileColors(ws, cols, dataRows);
  if (colorCells) {
    out.changed = true;
    out.colorAdjusted = colorCells;
    if (log)
      log(`🖌 C/D/E 字色已對齊 accept? 欄 (J=1 → 黑; J 空/0 → 紅): 改咗 ${colorCells} 個 cell`);
  }

  /* Type X 新 ULD 段 → 插入新行 */
  for (const it of inserts) {
    const at = insertXRow(ws, cols, it.rec, it.key, it.anchor, log);
    out.rowsInserted++;
    out.changed = true;
    out.issues.push({
      row: at, mawb: it.key, col: 'MAWB', type: 'x-inserted',
      message: `Type X 新段: MAWB ${it.key} 喺 ULD ${normUld(it.rec.uld) || '?'} 出現, 已喺 R${it.anchor} 下面插新行 R${at}`,
    });
    if (log) log(`✚ 已喺 R${it.anchor} 下插 Type X 行 (R${at}): ${it.key} / ${normUld(it.rec.uld) || ''}`);
  }

  if (!out.changed) {
    out.ok = true;
    out.unchanged = true;
    if (log) log('XLS 同步: 全部一致, 冇改動');
    return out;
  }

  backupFile(file, log);
  try {
    await wb.xlsx.writeFile(file);
    out.ok = true;
    if (log)
      log(
        `✅ XLS 已寫入: ${file} (更新 ${out.rowsUpdated} 行 / 新增 ${out.rowsInserted} 行` +
          `${out.colorAdjusted ? ` / 顏色 ${out.colorAdjusted} cell` : ''})`
      );
  } catch (e) {
    out.error = `寫入 XLS 失敗: ${e.message} (可能檔案開咗喺 Excel → 關閉後再補寫)`;
    if (log) log(`❌ ${out.error}`, 'error');
  }
  return out;
}

/** 寫入前自動 backup 去同資料夾 .hactl-backup/ */
function backupFile(file, log) {
  try {
    const dir = path.dirname(file);
    const backupDir = path.join(dir, '.hactl-backup');
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const target = path.join(backupDir, `${path.basename(file, path.extname(file))}.${stamp}${path.extname(file)}`);
    fs.copyFileSync(file, target);
    if (log) log(`已備份原檔 → ${target}`);
  } catch (e) {
    if (log) log(`備份原檔失敗 (繼續): ${e.message}`, 'warn');
  }
}

module.exports = { syncFromRecords, insertXRow, copyRowStyle, reconcileColors };

