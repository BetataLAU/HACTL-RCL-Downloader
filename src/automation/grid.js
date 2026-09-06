'use strict';

/** 結果列表偵測 + Kendo Grid 完整數據讀取 */

const path = require('path');
const fs = require('fs');
const { DATA_DIR } = require('./const');
const { getAllText } = require('./dom');
const { sleep } = require('./util');

async function detectList(page, log) {
  const candidates = ['table tbody tr', 'table tr', '[role="row"]'];
  for (const c of candidates) {
    const loc = page.locator(c);
    const cnt = await loc.count().catch(() => 0);
    if (cnt > 1) {
      const firstText = ((await loc.first().innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
      const hasHeader = /SEQ|AWB|Pre-declaration|RCL No/i.test(firstText);
      log(`偵測到結果列表 (${c}): ${cnt} 行${hasHeader ? ' (首行是表頭)' : ''}`);
      return { rows: loc, count: cnt, hasHeader };
    }
  }
  for (const c of candidates) {
    const loc = page.locator(c);
    const cnt = await loc.count().catch(() => 0);
    if (cnt === 1) {
      const firstText = ((await loc.first().innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
      const hasHeader = /SEQ|AWB|Pre-declaration|RCL No/i.test(firstText);
      log(`偵測到結果列表 (${c}): 1 行`);
      return { rows: loc, count: 1, hasHeader };
    }
  }
  const txt = await getAllText(page).catch(() => '');
  const m = txt.match(/(\d+)\s*(?:records?|rows?|結果|筆)\s*(?:found|:)?/i);
  if (m) log(`頁面文字顯示記錄數: ${m[1]}`);
  else log('未能偵測結果表格結構, 將用鍵盤逐行嘗試', 'warn');
  return { rows: null, count: 0, hasHeader: false };
}


/**
 * 讀取結果表格完整數據 (Kendo Grid) — 為寫 Excel / XLS 同步做準備
 * 回傳 { headers: [], rows: [[]] } 或 null; 亦存 grid-dump-<tag>.json
 */
async function dumpGridData(page, log, tag) {
  try {
    const grids = page.locator('kendo-grid');
    const gn = await grids.count().catch(() => 0);
    if (gn === 0) {
      log('未找到 kendo-grid (可能無結果)');
      return null;
    }
    for (let gi = 0; gi < gn; gi++) {
      const g = grids.nth(gi);
      const hdrText = await g.locator('.k-grid-header, thead').first().innerText().catch(() => '');
      if (!/AWB|Pre-declaration|Acceptance List/i.test(hdrText)) continue;

      // 捲動到底再捲返頂, 確保虛擬化嘅行全部渲染 (結果多時用)
      for (let s = 0; s < 12; s++) {
        const moved = await g
          .evaluate((gridEl) => {
            const c = gridEl.querySelector('.k-grid-content');
            if (!c) return false;
            const before = c.scrollTop;
            c.scrollTop = c.scrollHeight;
            return c.scrollTop !== before;
          })
          .catch(() => false);
        if (!moved) break;
        await sleep(250);
      }
      await g
        .evaluate((gridEl) => {
          const c = gridEl.querySelector('.k-grid-content');
          if (c) c.scrollTop = 0;
        })
        .catch(() => {});

      const data = await g
        .evaluate((gridEl) => {
          const labelOf = (cell) => {
            const lab = cell.querySelector('.lc-header-label');
            const raw = lab ? lab.getAttribute('title') || lab.textContent : cell.textContent;
            return (raw || '').replace(/\s+/g, ' ').trim();
          };
          const headers = [];
          const headerRow = gridEl.querySelector('.k-grid-header tr, thead tr');
          if (headerRow) {
            headers.push(...Array.from(headerRow.querySelectorAll('th, td')).map(labelOf));
          }
          const rows = [];
          gridEl.querySelectorAll('.k-grid-content tbody tr, tbody tr').forEach((tr) => {
            if (tr.querySelectorAll('th').length > 0) return; // 跳過表頭列
            rows.push(
              Array.from(tr.querySelectorAll('th, td')).map((c) =>
                (c.textContent || '').replace(/\s+/g, ' ').trim()
              )
            );
          });
          return { headers, rows };
        })
        .catch(() => null);
      if (!data) continue;

      const header = data.headers;
      log(`表格表頭 (${header.length} 欄): ${header.join(' | ')}`);
      log(`資料記錄數: ${data.rows.length}`);
      const awbIdx = header.findIndex((h) => h.toUpperCase() === 'AWB' || h.includes('AWB'));
      const typeIdx = header.findIndex(
        (h) => h.toUpperCase() === 'TYPE' || h.includes('Pre-declaration Type') || h.includes('Type')
      );
      data.rows.forEach((row, i) => {
        const awb = awbIdx >= 0 && row[awbIdx] ? row[awbIdx] : '(?)';
        const type = typeIdx >= 0 && row[typeIdx] ? row[typeIdx] : '(?)';
        log(`記錄 ${i + 1}: AWB=${awb} | Type=${type} | 全行: ${row.join(' | ')}`);
      });
      try {
        const f = path.join(DATA_DIR, `grid-dump${tag ? `-${tag}` : ''}.json`);
        fs.writeFileSync(f, JSON.stringify({ headers: header, rows: data.rows }, null, 2));
        log(`完整表格數據已存到: ${f}`);
      } catch {}
      return data;
    }
    log('未能定位 AWB 表格, 請查看截圖', 'warn');
    return null;
  } catch (e) {
    log(`讀取表格數據出錯: ${e.message}`, 'warn');
    return null;
  }
}

module.exports = { detectList, dumpGridData };
