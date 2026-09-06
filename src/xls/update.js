'use strict';

/**
 * 逐行更新規則 (劉鏘鏘版)
 * B DEST 核對 / C PCS (P 跟 XLS, B/X 跟 RCL) / D WT 跟 RCL + >5% 通知
 * E CBM 只 B / F TYPE 核對 / G/H/K 空白先填、有值唔同通知
 * I remark LIH=N 填 no LIH / J accept? 下載成功填 1 / 差異標記入 remark
 */

const { cellText, numValue, normUld, WT_TOL, CBM_ABS_TOL, FONT_COLOR_BLACK } = require('./helpers');

/** 寫 cell (保留格式) */
function writeCell(row, col, value, log) {
  try {
    row.getCell(col).value = typeof value === 'number' ? value : String(value);
    return true;
  } catch (e) {
    if (log) log(`寫入 XLS 失敗 (R${row.number} 第 ${col} 欄): ${e.message}`, 'warn');
    return false;
  }
}

/** 有值嘅 cell 先至改字色 (冇值嘅空 cell 唔郁); 回傳有冇實際改動。
 *  目標係黑 (FF000000) 而 cell 本身冇色 = default 黑 → 唔使寫, 照計已係黑;
 *  目標係紅 (FFFF0000) 就一定要寫 (default 黑都唔啱, 未有 RCL 應該係紅)。
 *
 *  重要: 唔可以淨係 `cell.font = {...}` —— ExcelJS 讀檔後相同格式嘅 cell 會共用同一個
 *  style object, 就地改一個會連帶改晒其他同款 cell (就係以前「未有 RCL 成批變黑」嘅原因)。
 *  所以呢度將成個 `cell.style` 換做一個新 object, 只影響呢一格。 */
function setCellFontColor(row, col, argb) {
  try {
    const cell = row.getCell(col);
    if (!cellText(cell).trim()) return false;
    const curStyle = cell.style || {};
    const curColor =
      curStyle.font && curStyle.font.color && curStyle.font.color.argb
        ? String(curStyle.font.color.argb).toUpperCase()
        : null;
    if (curColor === argb) return false;
    if (argb === FONT_COLOR_BLACK && curColor === null) return false; // default 黑, 唔使特登寫黑
    cell.style = {
      ...curStyle,
      font: { ...(curStyle.font || {}), color: { argb } },
    };
    return true;
  } catch {
    return false;
  }
}

/** 差異標記寫入 remark (唔重複, 保留原本內容) */
function appendMarkers(row, cols, markers) {
  if (!markers || !markers.length) return;
  const cell = row.getCell(cols.remark);
  let cur = cellText(cell).trim();
  const todo = markers.filter((m) => !cur.toUpperCase().includes(m.toUpperCase()));
  if (!todo.length) return;
  cur = cur ? `${cur}; ${todo.join(', ')}` : todo.join(', ');
  writeCell(row, cols.remark, cur);
}

/** WT 差異百分比 (以 XLS 原值做基準) */
function wtDiffPct(xls, rcl) {
  const base = Math.abs(xls);
  if (!base || !rcl) return null;
  return Math.abs(rcl - xls) / base;
}

/** 對一行套用 RCL record 規則; 改動/問題收落 out */
function applyRclToRow(rec, dr, cols, out, log) {
  const row = dr.row;
  const recType = String(rec.type || '').toUpperCase().trim() || 'P';
  const rowType = dr.type;
  const key = dr.mawb;
  const markers = [];
  const addIssue = (col, type, xls, rcl, message) => {
    out.issues.push({ row: dr.rowNumber, mawb: key, col, type, xls, rcl, message });
  };
  const mark = (m) => { if (!markers.includes(m)) markers.push(m); };

  if (recType && rowType && rowType !== recType) {
    addIssue('TYPE', 'type-mismatch', rowType, recType, `R${dr.rowNumber} TYPE: XLS=${rowType}, RCL=${recType}`);
    mark('TYPE');
  } else if (recType && !rowType) {
    if (writeCell(row, cols.type, recType, log)) out.changed = true;
  }

  if (rec.dest) {
    const cur = String(cellText(row.getCell(cols.dest)) || '').trim().toUpperCase();
    const next = String(rec.dest).trim().toUpperCase();
    if (cur && cur !== next) {
      addIssue('DEST', 'dest-mismatch', cur, next, `R${dr.rowNumber} DEST: XLS=${cur}, RCL=${next}`);
      mark('DEST');
    } else if (!cur) {
      if (writeCell(row, cols.dest, next, log)) out.changed = true;
    }
  }

  // PCS: Type P 嘅 RCL pcs 係「1」(一件 prepack), 唔係 XLS 嘅真實件數 (例 102)
  // → Type P 唔寫、唔比較、唔加標記, 保留 XLS 原本數字
  if (recType !== 'P' && rec.pcs !== null && rec.pcs !== undefined && rec.pcs !== '') {
    const curTxt = cellText(row.getCell(cols.pcs)).trim();
    const nCur = numValue(curTxt);
    const nRcl = numValue(rec.pcs);
    if (curTxt === '' || nCur === null) {
      if (writeCell(row, cols.pcs, nRcl !== null ? nRcl : String(rec.pcs), log)) out.changed = true;
    } else if (nRcl !== null && nCur !== nRcl) {
      if (writeCell(row, cols.pcs, nRcl, log)) out.changed = true;
      addIssue('PCS', 'pcs-mismatch', curTxt, rec.pcs, `R${dr.rowNumber} PCS: XLS=${curTxt}, RCL=${rec.pcs} (Type ${recType}, 已改跟 RCL)`);
      mark('PCS');
    }
  }

  if (rec.wt !== null && rec.wt !== undefined && rec.wt !== '') {
    const nCur = numValue(cellText(row.getCell(cols.wt)));
    const nRcl = numValue(rec.wt);
    if (nRcl !== null) {
      if (nCur === null) {
        if (writeCell(row, cols.wt, nRcl, log)) out.changed = true;
      } else if (Math.abs(nCur - nRcl) > 0.005) {
        if (writeCell(row, cols.wt, nRcl, log)) out.changed = true;
        const diff = wtDiffPct(nCur, nRcl);
        if (diff !== null && diff > WT_TOL) {
          addIssue('WT', 'wt-diff', nCur, nRcl, `R${dr.rowNumber} WT: XLS=${nCur}, RCL=${nRcl} (差 ${Math.round(diff * 100)}% > 5%, 已改)`);
          mark('WT>5%');
        }
      }
    }
  }

  if (recType === 'B' && rec.cbm !== null && rec.cbm !== undefined && rec.cbm !== '') {
    const nCur = numValue(cellText(row.getCell(cols.cbm)));
    const nRcl = numValue(rec.cbm);
    if (nRcl !== null) {
      if (nCur === null) {
        if (writeCell(row, cols.cbm, nRcl, log)) out.changed = true;
      } else if (Math.abs(nCur - nRcl) > CBM_ABS_TOL) {
        if (writeCell(row, cols.cbm, nRcl, log)) out.changed = true;
        addIssue('CBM', 'cbm-diff', nCur, nRcl, `R${dr.rowNumber} CBM: XLS=${nCur}, RCL=${nRcl} (已改)`);
        mark('CBM');
      }
    }
  }

  // Type B (bulk) 冇 ULD: G 欄填 "BULK" (原本有 ULD# 或留空都改返), H (Contour) 留空
  if (recType === 'B') {
    const curG = dr.uld; // collectDataRows 已 normUld (大階去空格)
    if (curG !== 'BULK') {
      if (writeCell(row, cols.uld, 'BULK', log)) out.changed = true;
      if (curG) {
        addIssue('ULD#', 'bulk-uld', curG, 'BULK', `R${dr.rowNumber} ULD#: Type B → XLS=${curG}, 應為 BULK (已改)`);
        mark('ULD→BULK');
      }
    }
    const curH = cellText(row.getCell(cols.contour)).trim();
    if (curH) {
      if (writeCell(row, cols.contour, '', log)) out.changed = true;
      addIssue('Contour', 'bulk-contour-cleared', curH, '(空白)', `R${dr.rowNumber} Contour: Type B 冇 contour, 已清空 (XLS=${curH})`);
    }
  }

  const recUld = normUld(rec.uld);
  if (recUld) {
    const curUld = dr.uld;
    if (!curUld) {
      if (writeCell(row, cols.uld, recUld, log)) out.changed = true;
    } else if (curUld !== recUld) {
      addIssue('ULD#', 'uld-mismatch', curUld, recUld, `R${dr.rowNumber} ULD#: XLS=${curUld}, RCL=${recUld}`);
      mark('ULD');
    }
  }

  if (rec.contour) {
    const cur = String(cellText(row.getCell(cols.contour)) || '').trim();
    const next = String(rec.contour).trim();
    // XLS 留低嘅 'KG' 係重量單位字誤入 (舊版 parse bug), 當空白處理、用 RCL CON 覆寫
    const stale = !cur || /^KG$/i.test(cur);
    if (stale) {
      if (writeCell(row, cols.contour, next, log)) out.changed = true;
    } else if (cur.toUpperCase() !== next.toUpperCase()) {
      addIssue('Contour', 'contour-mismatch', cur, next, `R${dr.rowNumber} Contour: XLS=${cur}, RCL=${next}`);
      mark('Contour');
    }
  }


  // Tare 欄: 工作表有 Tare column 先寫 (冇嘅話唔好 fallback 寫落第 11 欄)
  if (cols.tare) {
    // Type B (bulk) 冇 ULD → tare weight 必然係 0
    if (recType === 'B') {
      const curTxt = cellText(row.getCell(cols.tare)).trim();
      const nCur = numValue(curTxt);
      if (curTxt === '' || nCur !== 0) {
        if (writeCell(row, cols.tare, 0, log)) out.changed = true;
        if (curTxt !== '' && nCur !== 0) {
          addIssue('Tare', 'tare-mismatch', curTxt, 0, `R${dr.rowNumber} Tare: Type B → XLS=${curTxt}, 應為 0 (已改)`);
          mark('Tare');
        }
      }
    } else if (rec.tare !== null && rec.tare !== undefined && rec.tare !== '') {
      const curTxt = cellText(row.getCell(cols.tare)).trim();
      const nCur = numValue(curTxt);
      const nRcl = numValue(rec.tare);
      if (nRcl !== null) {
        if (!curTxt || nCur === null || nCur <= 0) {
          if (writeCell(row, cols.tare, nRcl, log)) out.changed = true;
        } else if (Math.abs(nCur - nRcl) > 0.5) {
          addIssue('Tare', 'tare-mismatch', curTxt, nRcl, `R${dr.rowNumber} Tare: XLS=${curTxt}, RCL=${nRcl}`);
          mark('Tare');
        }
      }
    }
  }

  // 有 RCL → C/D/E (PCS/WT/CBM) 字色轉返黑色 (之前可能有顏色標記; 空 cell 唔郁)
  if (rec.accepted) {
    for (const col of [cols.pcs, cols.wt, cols.cbm]) {
      if (!col) continue;
      if (setCellFontColor(row, col, FONT_COLOR_BLACK)) out.changed = true;
    }
  }

  if (rec.lih && String(rec.lih).toUpperCase() === 'N') {
    // LIH=N → remark 一定要有 "no LIH" (有 remark 內容都照加, 唔重複)
    const curRemark = cellText(row.getCell(cols.remark)).trim();
    if (!curRemark.toUpperCase().includes('NO LIH')) {
      if (writeCell(row, cols.remark, curRemark ? `${curRemark}; no LIH` : 'no LIH', log)) {
        out.changed = true;
      }
    }
  }

  // 有 RCL → accept? (J) 一定 = 1 (原本空或 0 都改返做 1; 用戶規則「交了貨有 RCL → J=1」)
  if (rec.accepted) {
    const curJ = cellText(row.getCell(cols.accept)).trim();
    if (curJ !== '1') {
      if (writeCell(row, cols.accept, 1, log)) out.changed = true;
    }
  }

  if (markers.length) {
    appendMarkers(row, cols, markers);
    out.changed = true;
    addIssue('remark', 'marked', null, markers.join(', '), `R${dr.rowNumber} remark 已加標記: ${markers.join(', ')}`);
  }
}

module.exports = { writeCell, appendMarkers, setCellFontColor, applyRclToRow, wtDiffPct };

