'use strict';

/** 逐筆下載: 開詳細 → 核對位置 → F2 Save As → (必要時) 接管 Chrome 下載 → 返回列表 */

const { extractMAWB, getAllText, safePress, findFirst, sel } = require('./dom');
const { openDetail, returnToList } = require('./navigate');
const { adoptOrphanDownload, sleep, saveDownloaded, waitDownload } = require('./util');
const { debugDomParse } = require('../rcl/extract-text');

/**
 * @param {object} ctx   { page, context, cfg, log, screenshot, downloadedMap,
 *                         scanDirs, results, mawbStatus, normKey, hooks }
 * @param {object} item  由 decideDownloadList 產生嘅下載項
 * @param {object} state { currentPos } — 修改後會回傳
 * @returns {Promise<{ currentPos:number, stop:boolean }>}
 */
async function downloadOneRcl(ctx, item, state) {
  const { page, context, cfg, log, screenshot, downloadedMap, scanDirs, results, mawbStatus, normKey, hooks } = ctx;
  let currentPos = state.currentPos;
  const shouldStop = ctx.shouldStop || (() => false);

  if (shouldStop()) {
    log('收到停止指令, 結束', 'warn');
    return { currentPos, stop: true };
  }
  if (page.isClosed()) {
    log('⚠ 列表頁已關閉, 中止後續下載 (已下載嘅檔案唔受影響)', 'warn');
    return { currentPos, stop: true };
  }

  // 移到目標行: 按 ArrowDown (item.idx - currentPos) 次
  if (item.idx > currentPos) {
    let navOk = true;
    for (let k = 0; k < item.idx - currentPos; k++) {
      const ok = await safePress(page, 'ArrowDown', log);
      if (!ok) { navOk = false; break; }
      await sleep(600);
    }
    if (!navOk) {
      log('⚠ 無法移到目標行 (頁面已關閉), 中止後續下載', 'warn');
      return { currentPos, stop: true };
    }
    currentPos = item.idx;
  }
  log(`下載第 ${item.idx + 1} 行: ${item.disp || item.awb || item.uld} | Type=${item.type} | LIH=${item.lih || '(空)'} → ${item.fname}`);

  // 開啟詳細 (核對位置, 有偏差會自動修正重試)
  let dp = null;
  let isPopup = false;
  let mawb = null;
  let closedStop = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const opened = await openDetail(page, context, log);
    dp = opened.page;
    isPopup = opened.isPopup;
    if (opened.closed) { closedStop = true; break; }
    mawb = await extractMAWB(dp);
    if (!mawb) break;
    // 詳細頁會顯示 "Master List X / N", 用嚟核對而家喺第幾行
    const mList = (await getAllText(dp).catch(() => '')).match(/Master List\s+(\d+)\s*\/\s*(\d+)/i);
    const curRow = mList ? parseInt(mList[1], 10) : null;
    if (curRow && curRow !== item.idx + 1) {
      log(`⚠ 位置偏差: 期望第 ${item.idx + 1} 行, 實際第 ${curRow} 行, 返回列表修正 ...`, 'warn');
      if (isPopup) await dp.close().catch(() => {});
      else await returnToList(page, cfg, log);
      const diff = item.idx + 1 - curRow;
      let fixed = true;
      for (let k = 0; k < diff; k++) {
        const ok = await safePress(page, 'ArrowDown', log);
        if (!ok) { fixed = false; break; }
        await sleep(600);
      }
      if (!fixed) { closedStop = true; break; }
      currentPos = item.idx;
      continue; // 再試一次
    }
    break;
  }
  if (closedStop) {
    log('⚠ 詳細頁/列表頁意外關閉, 中止後續下載 (已下載嘅檔案唔受影響)', 'warn');
    return { currentPos, stop: true };
  }

  // X (mix-load): 詳細頁可能淨係顯示 ULD / 首個 MAWB, 唔做 MAWB 同名核對
  if (item.isX) {
    if (!mawb) mawb = item.uld || item.disp;
    log(`(Type X) 詳細頁開咗, 以 ULD 作 key: ${item.uld || mawb}`);
  } else if (!mawb) {
    log(`⚠ 第 ${item.idx + 1} 行開詳細後未能讀取 AWB`, 'warn');
    await screenshot(dp, `10-no-awb-${item.idx + 1}`);
    if (isPopup) await dp.close().catch(() => {});
    else await returnToList(page, cfg, log);
    results.failed.push(item.awb);
    return { currentPos, stop: false };
  } else if (mawb !== item.awb) {
    // 位置追蹤出錯會喺呢度現形, 避免存錯檔名
    log(`⚠ 詳細頁 AWB (${mawb}) 與列表 (${item.awb}) 唔符, 標記為失敗`, 'warn');
    await screenshot(dp, `14-mismatch-${item.awb}`);
    if (isPopup) await dp.close().catch(() => {});
    else await returnToList(page, cfg, log);
    results.failed.push(item.awb);
    return { currentPos, stop: false };
  }
  log(`AWB: ${mawb}`);

  // DOM-first: 儲起詳細頁文字, 之後 XLS 同步用 (RCL PDF 做 fallback)
  // DOM debug: 即刻逐個 field 印「值 + label 前後 40 字」位置 (喺 data/config.json 寫
  // "debugDom": false 可以閂咗呢段輸出)
  try {
    const txt = await getAllText(dp).catch(() => '');
    if (txt) {
      item.domText = txt.slice(0, 30000);
      if (cfg.debugDom !== false) {
        const entries = debugDomParse(txt);
        const okField = (f) => {
          const e = entries.find((x) => x.field === f);
          return e && e.found && e.value !== null && e.value !== undefined && e.value !== '';
        };
        const got = entries.filter(
          (e) => e.found && e.value !== null && e.value !== undefined && e.value !== ''
        );
        log(
          `📋 DOM parse（${item.disp || mawb}）: 抽到 ${got.length}/${entries.length} 個 field` +
            (okField('dest') && okField('pcs') && okField('wt')
              ? ' · 質素 OK'
              : ' · ⚠ 質素唔齊 (要靠 PDF/DOM 補)')
        );
        for (const e of entries) {
          if (e.found && e.value !== null && e.value !== undefined && e.value !== '') {
            log(`    ${e.field.padEnd(8)} = ${e.value}   ← ${e.context}`);
          } else if (e.found) {
            log(`    ${e.field.padEnd(8)} = (label「${e.label}」搵到但抽唔到值)`);
          } else {
            log(`    ${e.field.padEnd(8)} = (搵唔到)`);
          }
        }
      }
    }
  } catch {
    /* 抽唔到唔緊要, PDF fallback 會接手 */
  }


  const target = item.target;
  {
    /* F2 → Save As (可能開新視窗) */
    const saveAsPopupPromise = context.waitForEvent('page', { timeout: 2500 }).catch(() => null);
    const f2ok = await safePress(dp, 'F2', log);
    const saveAsPopup = await saveAsPopupPromise;
    if (!f2ok) {
      log(`⚠ F2 開唔到 Save As (${mawb}, 頁面可能已關閉), 中止後續下載`, 'warn');
      results.failed.push(item.disp || mawb);
      return { currentPos, stop: true };
    }
    let saveAsTarget = dp;
    if (saveAsPopup) {
      try {
        await saveAsPopup.waitForLoadState('domcontentloaded', { timeout: 30000 });
      } catch {}
      await saveAsPopup.bringToFront();
      await sleep(800);
      log('Save As 視窗已開啟');
      await screenshot(saveAsPopup, '11-saveas-popup');
      saveAsTarget = saveAsPopup;
    }
    // 等 Save As 按鈕出現 (Kendo dialog 渲染)
    const saveAs = await findFirst(
      saveAsTarget,
      sel(cfg, 'saveAsButton', ['#btnSaveAs', 'button:has-text("Save As")', 'text=Save As']),
      { timeout: 10000 }
    );
    if (!saveAs) {
      log(`⚠ 找不到 Save As 按鈕 (${mawb})`, 'warn');
      await screenshot(saveAsTarget, `12-no-saveas-${mawb}`);
      results.failed.push(mawb);
    } else {
      const dlPromise = saveAsTarget.waitForEvent('download', { timeout: 45000 });
      // Kendo dialog: 遮罩會攔截滑鼠點擊, 但預設焦點在 Save As 按鈕上
      // → 按 SPACE 等同按 Save As (用戶實測確認)
      await sleep(800);
      const pressStart = Date.now(); // 記低按鍵時間, 用嚟分辨邊個 <uuid>.tmp 係今次下載
      const spaceOk = await safePress(saveAsTarget, 'Space', log);
      if (spaceOk) log('已按 SPACE 鍵 (等同按 Save As)');
      let dl = null;
      try {
        dl = await waitDownload(dlPromise, 15000);
      } catch {}
      if (!dl) {
        log('SPACE 無觸發下載, 嘗試 force 點擊 ...', 'warn');
        try {
          await saveAs.click({ force: true, timeout: 10000 });
          log('已 force 點擊 Save As');
        } catch {}
        try {
          dl = await waitDownload(dlPromise, 10000);
        } catch {}
      }
      if (!dl) {
        log('force 點擊無觸發下載, 嘗試 JS 點擊 ...', 'warn');
        try {
          await saveAs.evaluate((el) => el.click());
          log('已 JS 點擊 Save As');
        } catch {}
        try {
          dl = await waitDownload(dlPromise, 10000);
        } catch {}
      }
      if (!dl) {
        log(`⚠ 下載事件超時 (${mawb}), 檢查有冇 Chrome 已直接寫入嘅下載檔 ...`, 'warn');
      }
      let saved = false;
      if (dl) {
        try {
          await dl.saveAs(target);
          saved = true;
        } catch (e) {
          // 已知情況: "download.saveAs: Target page, context or browser has been closed"
          // 檔案其實已由 Chrome 完整寫入做 <uuid>.tmp, 下面直接接管改名
          log(`⚠ dl.saveAs 失敗: ${e.message}`, 'warn');
          log('嘗試直接接管 Chrome 已寫入嘅暫存下載檔 ...', 'warn');
        }
      }
      if (!saved) {
        saved = await adoptOrphanDownload(target, scanDirs, pressStart, log);
      }
      if (saved) {
        const recKey = item.isX ? `X:${item.uld || mawb}` : String(mawb);
        downloadedMap[recKey] = new Date().toISOString();
        saveDownloaded(downloadedMap);
        results.downloaded.push({
          mawb: recKey,
          file: target,
          type: item.type || '',
          lih: item.lih || '',
          uld: item.uld || '',
          domText: item.domText || '',
        });
        if (!item.isX) mawbStatus[normKey(mawb)] = 'downloaded';
        log(`✅ 已下載 ${item.disp || mawb} RCL → ${target}`);
        // 通知 UI 即時 tick 返個 checkbox
        if (typeof hooks.onDownloaded === 'function') hooks.onDownloaded(item.isX ? null : mawb);
      } else {
        log(`⚠ 無法儲存下載檔 (${mawb})`, 'warn');
        results.failed.push(mawb);
        await screenshot(saveAsTarget, `13-dl-fail-${mawb}`);
      }
    }
    if (saveAsPopup) {
      await saveAsPopup.close().catch(() => {});
      await page.bringToFront().catch(() => {});
    }
  }

  /* 返回列表 */
  if (isPopup) {
    await dp.close().catch(() => {});
    await page.bringToFront().catch(() => {});
  } else {
    await returnToList(page, cfg, log);
  }
  return { currentPos, stop: false };
}

module.exports = { downloadOneRcl };

