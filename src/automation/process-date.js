'use strict';

/** 每日期流程: 搜尋 → 讀列表 → 決定 downloadList → 逐筆下載 */

const { sleep } = require('./util');
const { getAllText } = require('./dom');
const { fillPalSearch, pressSearch } = require('./pal-search');
const { detectList, dumpGridData } = require('./grid');
const { decideDownloadList } = require('./decide');
const { downloadOneRcl } = require('./download-one');

/**
 * @param {object} ctx  { page, cfg, log, screenshot, results, mawbStatus,
 *                        seenMawbKeys, hasUserList, userTrackSet, userSkipSet,
 *                        includeX, normKey, saveDir, downloadedMap, scanDirs, shouldStop }
 * @param {string} dateStr  例如 05SEP26
 */
async function processDateDay(ctx, dateStr) {
  const { page, cfg, log, screenshot } = ctx;
  log(`===== 搜尋 Accept Date: ${dateStr} =====`);
  await fillPalSearch(page, cfg, dateStr, log);
  await screenshot(page, `09-pal-filled-${dateStr}`);
  await pressSearch(page, log, screenshot);

  const listInfo = await detectList(page, log);
  if (!listInfo.rows) {
    const txt = await getAllText(page).catch(() => '');
    if (/no record|沒有記錄|無資料|0 record/i.test(txt)) log(`${dateStr}: 沒有 RCL 記錄`);
    return { interrupted: false };
  }

  // 讀取並記錄結果表格完整數據 (AWB / Type / LIH 等; 亦存 grid-dump-<date>.json)
  const gridData = await dumpGridData(page, log, dateStr);

  // 由列表資料建立每筆記錄 (唔使逐筆開詳細頁)
  const awbIdx = gridData
    ? gridData.headers.findIndex((h) => h.toUpperCase() === 'AWB' || h.includes('AWB'))
    : -1;
  const typeIdx = gridData
    ? gridData.headers.findIndex(
        (h) => h.toUpperCase() === 'TYPE' || h.includes('Pre-declaration Type') || h.includes('Type')
      )
    : -1;
  const lihIdx = gridData ? gridData.headers.findIndex((h) => h.trim().toUpperCase() === 'LIH') : -1;
  const uldIdx = gridData ? gridData.headers.findIndex((h) => h.trim().toUpperCase() === 'ULD') : -1;
  const listRows = gridData
    ? gridData.rows
        .map((r, gridIdx) => ({
          awb: awbIdx >= 0 ? (r[awbIdx] || '').trim() : '',
          type: typeIdx >= 0 ? (r[typeIdx] || '').trim().toUpperCase() : '',
          lih: lihIdx >= 0 ? (r[lihIdx] || '').trim().toUpperCase() : '',
          uld: uldIdx >= 0 ? (r[uldIdx] || '').trim() : '',
          gridIdx,
        }))
        .filter((x) => x.awb || (ctx.includeX && x.type === 'X' && x.uld))
    : [];
  if (listRows.length)
    log(
      `[${dateStr}] 列表 (共 ${listRows.length} 筆): ${listRows
        .map((r) => r.awb || r.uld)
        .join(', ')}`
    );

  const decided = decideDownloadList(ctx, listRows);
  const { downloadList, skipTypeCount, skipDoneCount, notListedCount } = decided;

  if (downloadList.length === 0) {
    if (listRows.length) {
      log(`✅ 列表 ${listRows.length} 筆: Type 唔啱 ${skipTypeCount} 筆, 檔案已有 ${skipDoneCount} 筆, 唔喺清單 ${notListedCount} 筆, 無需下載`);
    } else {
      log('無需下載新 RCL');
    }
  } else {
    log(`需要下載 ${downloadList.length} 筆新 RCL: ${downloadList.map((r) => r.disp).join(', ')}`);
  }

  // 安全網: 有結果但讀唔到表格數據 → 出錯停止, 避免靜靜雞漏下載
  if (listInfo.rows && (!gridData || listRows.length === 0)) {
    throw new Error('結果表格讀取失敗 (有記錄但讀唔到 AWB 數據), 請查看日誌/截圖');
  }

  /* -------- 逐筆下載 (只開需要下載嗰啲詳細頁) -------- */
  // 確保 Grid 有鍵盤焦點: click 第一行 (已選中, 再 click 只係確保焦點, 唔會開詳細)
  try {
    await listInfo.rows.nth(0).click();
    await sleep(500);
    if (/listingAOutlet/.test(page.url())) {
      await page.keyboard.press('Escape');
      await sleep(1200);
    }
  } catch {}
  let currentPos = 0; // 目前 highlight 所在嘅行 (0-based, 第一行 = 0)
  let interrupted = false;
  for (const item of downloadList) {
    const r = await downloadOneRcl(ctx, item, { currentPos });
    currentPos = r.currentPos;
    if (r.stop) {
      interrupted = !ctx.shouldStop(); // 用戶主動停止唔當「中斷」
      break;
    }
  }
  return { interrupted };
}

module.exports = { processDateDay };

