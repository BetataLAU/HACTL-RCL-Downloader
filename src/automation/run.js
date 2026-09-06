'use strict';

/** 主流程 runAutomation (啟動 Chrome → 登入 → COSAC → PAL → 逐日下載) */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');
const {
  buildDateRange,
  loadDownloaded,
  cleanupOrphanTmp,
  formatAcceptDate,
  sleep,
} = require('./util');
const { doLogin, loginIfPresent } = require('./login');
const { openCosacPlus, selectProfile, confirmProfile } = require('./cosac');
const { enterCommand } = require('./command');
const { processDateDay } = require('./process-date');
const { logPageInfo } = require('./dom');

/**
 * 由零開始進入 PAL 功能畫面 (login → COSAC-Plus → Profile → 指令 PAL)。
 * 下載時 COSAC 頁面有時會自動關閉, 續下載/續日期時都係靠呢個重新進入
 * (登入 session cookies 已寫入 persistent profile, 一般唔使再入密碼)。
 */
/**
 * 開一個 keep-alive「獨立 popup 視窗」(about:blank)。
 * 原因: COSAC Save As 之後會 window.close() 成個 window —— 同一 window 入面嘅分頁
 * (包括普通 about:blank tab) 都會被閂埋, Chrome 零 window 就成個退出。獨立 popup 視窗
 * 先可以喺網站閂晒自己啲窗之後仍然頂住個 browser, 等 bootToPal 可以再 newPage。
 */
async function openKeepAlive(context, log) {
  try {
    const src = context.pages().find((p) => !p.isClosed());
    if (!src) return null;
    const popupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
    await src
      .evaluate(() => {
        const w = window.open('about:blank', '_blank', 'popup=yes,width=220,height=120');
        if (w) {
          try { w.document.title = 'keep-alive'; } catch { /* ignore */ }
        }
      })
      .catch(() => null);
    const popup = await popupPromise;
    if (popup && !popup.isClosed()) {
      try { await popup.goto('about:blank'); } catch { /* ignore */ }
      log('keep-alive 獨立視窗已開啟');
      return popup;
    }
  } catch { /* fallback below */ }
  try {
    const tab = await context.newPage();
    await tab.goto('about:blank').catch(() => {});
    return tab;
  } catch {
    return null;
  }
}

async function bootToPal(context, cfg, log, screenshot, keeper) {
  const pages = context.pages();
  for (const p of pages) {
    // keeper = keep-alive 視窗, 唔閂: 冇任何 window 時 Chrome 會退出,
    // 有佢頂住先至可以喺網站閂晒自己啲窗之後重新 newPage 進入 PAL
    if (keeper && p === keeper) continue;
    if (!p.isClosed()) {
      try {
        await p.close();
      } catch {}
    }
  }
  let page = await context.newPage();
  page = await doLogin(context, page, cfg, log, screenshot);
  page = await openCosacPlus(context, page, cfg, log, screenshot);
  // COSAC-Plus 頁面可能本身需要登入 (視乎網站流程)
  page = await loginIfPresent(context, page, cfg, log, screenshot);
  await selectProfile(page, cfg, log);
  await screenshot(page, '08-after-profile');
  await confirmProfile(page, log);
  await logPageInfo(page, 'Profile 後', log);
  await enterCommand(page, cfg, 'PAL', log, screenshot);
  return page;
}

/** context 仲生唔生 (Playwright 對已關閉 context 嘅 pages() 會 throw) */
function contextAlive(context) {
  if (!context) return false;
  try {
    context.pages();
    return true;
  } catch {
    return false;
  }
}

/** page 仲生唔生 (已關閉 / 所屬 context 已死都當死) */
function pageAlive(page) {
  if (!page) return false;
  try {
    return !page.isClosed();
  } catch {
    return false;
  }
}

/** 錯誤訊息似唔似「頁面/瀏覽器已經關閉 / profile 鎖未釋放」→ 可以安全重試 */
function isClosedError(msg) {
  return /closed|Target page|Execution context|ProcessSingleton|already in use|user data directory/i.test(
    String(msg || '')
  );
}

/** 單次 run 內最多自動重啟 Chrome 嘅次數 (防 Chrome 一直 crash 嗰陣無限 loop) */
const MAX_RELAUNCH = 8;
/** 重啟 Chrome 失敗後再試嘅等待 (ms) */
const RELAUNCH_BACKOFF_MS = 2500;

async function runAutomation(cfg, hooks) {
  const { log, screenshot, shouldStop } = hooks;
  const results = { downloaded: [], skipped: [], failed: [], error: null };
  let mawbStatus = {}; // 每筆 MAWB 嘅狀態 (供 UI 自動 tick 用)
  const downloadedMap = loadDownloaded();
  const saveDir = cfg.saveDir && cfg.saveDir.trim() ? cfg.saveDir : path.join(os.homedir(), 'Downloads');
  try {
    fs.mkdirSync(saveDir, { recursive: true });
  } catch (e) {
    log(`無法建立儲存資料夾 ${saveDir}: ${e.message}`, 'error');
  }
  log(`RCL 將儲存到: ${saveDir}`);

  // Chrome 實際寫暫存下載檔嘅位置 = saveDir 或系統「下載」資料夾 (profile 未自訂時兩者相同)
  const scanDirs = [];
  for (const d of [saveDir, path.join(os.homedir(), 'Downloads')]) {
    const r = path.resolve(d);
    if (!scanDirs.includes(r)) scanDirs.push(r);
  }
  cleanupOrphanTmp(scanDirs, log);

  let context = null;
  let page = null;
  let keeper = null;      // keep-alive 獨立視窗 (Chrome 重啟時會一齊重建)
  let relaunchCount = 0;  // 今次 run 內「成個 Chrome 重啟」嘅次數

  try {
    // Keep-alive 獨立視窗: COSAC Save As 後會 window.close() 成個 window (連 tab 一齊閂),
    // Chrome 零 window 就會成個退出。keeper 用獨立 popup 視窗頂住, bootToPal 先可以再開新頁。
    // 但若 Chrome 成個崩潰/關閉 (Crashpad 有時會見到 dump), keeper 都救唔到 →
    // 下面 relaunchBrowser 會成個重新啟動 Chrome (session cookies 喺 .browser-data, 一般唔使再入密碼)。
    const launchOnce = async () => {
      log('正在啟動 Chrome ...');
      return chromium.launchPersistentContext(path.join(__dirname, '..', '..', '.browser-data'), {
        channel: cfg.browserChannel || 'chrome',
        headless: !!cfg.headless,
        slowMo: Number(cfg.slowMo) || 0,
        acceptDownloads: true,
        viewport: { width: 1440, height: 900 },
        args: [
          '--disable-blink-features=AutomationControlled',
          '--disable-popup-blocking',
          '--start-maximized',
        ],
      });
    };

    /** 由零開始 (重新) 啟動 Chrome + keeper + 進入 PAL。成功 → true; 最終失敗 → false */
    const relaunchBrowser = async (why) => {
      log(`⚠ ${why} — 自動重新啟動瀏覽器並回到 PAL ...`, 'warn');
      if (context) {
        try { await context.close(); } catch {}
      }
      context = null;
      page = null;
      keeper = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          context = await launchOnce();
          keeper = await openKeepAlive(context, log);
          page = await bootToPal(context, cfg, log, screenshot, keeper);
          ctx.page = page;
          ctx.context = context;
          return true;
        } catch (e) {
          const msg = (e && e.message) || String(e);
          try { if (context) await context.close(); } catch {}
          context = null;
          page = null;
          keeper = null;
          log(`重啟 Chrome 失敗 (第 ${attempt} 次): ${msg}`, 'error');
          if (!isClosedError(msg) || attempt === 3) return false;
          await sleep(RELAUNCH_BACKOFF_MS);
        }
      }
      return false;
    };

    // 首次啟動。萬一上一輪 Chrome 未完全釋放 profile 鎖, 退避 3 秒再試一次
    try {
      context = await launchOnce();
    } catch (e) {
      const msg = (e && e.message) || String(e);
      log(`啟動 Chrome 失敗: ${msg}, 3 秒後重試 ...`, 'warn');
      await sleep(3000);
      context = await launchOnce();
    }
    // 首次進入 PAL。登入/PAL 途中 Chrome 都可能閃退 → 試埋成個重啟一次先至放棄
    let booted = false;
    for (let attempt = 1; attempt <= 2 && !booted; attempt++) {
      try {
        keeper = await openKeepAlive(context, log);
        page = await bootToPal(context, cfg, log, screenshot, keeper);
        booted = true;
      } catch (e) {
        const msg = (e && e.message) || String(e);
        try { if (context) await context.close(); } catch {}
        context = null;
        keeper = null;
        page = null;
        if (!isClosedError(msg) || attempt === 2) throw e;
        log(`⚠ 首次進入 PAL 途中瀏覽器關閉 (${msg}), 自動重啟 Chrome 再試 ...`, 'warn');
        await sleep(2000);
        context = await launchOnce();
      }
    }

    // 日期範圍: 由 XX 到 XX (逐日搜尋)
    const dates = buildDateRange(cfg.acceptDate, cfg.acceptDateTo);
    log(`Accept Date 範圍: ${dates.join(' 至 ')} (共 ${dates.length} 日)`);

    // 用戶 MAWB 清單: 無 tick = 檢查並下載; tick = 跳過; 清單以外嘅 PAL 記錄唔處理
    const mawbList = Array.isArray(cfg.mawbList) ? cfg.mawbList : [];
    const normKey = (s) => (s || '').replace(/\D/g, '');
    const userTrackSet = new Set(mawbList.map((m) => normKey(m && m.value)).filter((k) => k.length === 11));
    const userSkipSet = new Set(
      mawbList.filter((m) => m && m.skip).map((m) => normKey(m.value)).filter((k) => k.length === 11)
    );
    const hasUserList = userTrackSet.size > 0;
    const includeX = !!(cfg.xlsSync && cfg.xlsSync.enabled); // X (mix-load ULD) 淨係 XLS 同步開先下載
    const seenMawbKeys = new Set(); // 跨日期記錄搜尋結果出現過嘅 MAWB
    if (hasUserList) {
      log(`用戶 MAWB 清單: ${userTrackSet.size} 筆 (無 tick = 檢查並下載; tick = 跳過)`);
      if (userSkipSet.size) log(`用戶標記跳過: ${Array.from(userSkipSet).join(', ')}`);
    } else {
      log(`冇用戶 MAWB 清單 → 下載全部 Type P/B${includeX ? '/X' : ''} (檔案已存在嘅跳過)`);
    }
    if (includeX) log('XLS 同步已開 → Type X (mix-load ULD RCL) 都會下載並同步');

    // 逐日處理 (共用 ctx, 跨日累積結果/狀態)
    const ctx = {
      page,
      context,
      cfg,
      log,
      screenshot,
      shouldStop,
      hooks,
      results,
      mawbStatus,
      seenMawbKeys,
      hasUserList,
      userTrackSet,
      userSkipSet,
      includeX,
      normKey,
      saveDir,
      downloadedMap,
      scanDirs,
    };
    // 逐日處理 (共用 ctx, 跨日累積結果/狀態)。下載後 COSAC 頁面有時會自動關閉 →
    // 頁面關閉而當日仲有未下載項目時, 自動重新進入 PAL 續下載, 唔使次次人手再按開始。
    for (const dateStr of dates) {
      if (shouldStop()) break;
      let tries = 0;
      let giveUp = false;
      while (!shouldStop() && !giveUp && tries < 30) {
        tries++;
        // 確保有可用頁面/瀏覽器 (上一個下載 / 上一個日期可能令頁面甚至成個 Chrome 關閉)
        if (!contextAlive(context) || !pageAlive(page)) {
          let recovered = false;
          if (contextAlive(context)) {
            log('⚠ 頁面已關閉, 自動重新進入 PAL ...', 'warn');
            try {
              page = await bootToPal(context, cfg, log, screenshot, keeper);
              ctx.page = page;
              recovered = true;
            } catch (e) {
              const msg = (e && e.message) || String(e);
              log(`重新進入 PAL 失敗: ${msg}`, 'error');
              if (!isClosedError(msg)) {
                // 唔似係頁面/瀏覽器關閉引起 (例如帳號密碼錯) → 唔好亂重啟, 直接停
                results.error = (results.error ? results.error + '; ' : '') + msg;
                giveUp = true;
                break;
              }
              // 頁面死咗之餘 context 都可能死 → 落去試成個 Chrome 重啟
            }
          }
          if (!recovered) {
            if (relaunchCount >= MAX_RELAUNCH) {
              log(`⚠ Chrome 已關閉/重啟超過 ${MAX_RELAUNCH} 次, 中止後續下載 (已下載嘅檔案唔受影響)`, 'error');
              results.error =
                (results.error ? results.error + '; ' : '') + `Chrome 關閉超過 ${MAX_RELAUNCH} 次, 已中止`;
              giveUp = true;
              break;
            }
            relaunchCount++;
            recovered = await relaunchBrowser('Chrome 已整個關閉/崩潰');
            if (!recovered) {
              log('⚠ 重新啟動 Chrome 失敗, 中止後續下載 (已下載嘅檔案唔受影響)', 'error');
              results.error =
                (results.error ? results.error + '; ' : '') + '重新啟動 Chrome 失敗';
              giveUp = true;
              break;
            }
          }
        }

        const before = results.downloaded.length;
        let dayInfo = null;
        try {
          dayInfo = await processDateDay(ctx, dateStr);
        } catch (e) {
          const msg = (e && e.message) || String(e);
          if (!/closed|Target page|Execution context/i.test(msg)) throw e;
          log(`⚠ ${dateStr} 處理期間頁面關閉 (${msg}), 自動重試 ...`, 'warn');
          dayInfo = { interrupted: true };
        }
        if (!dayInfo || !dayInfo.interrupted) break; // 呢日已處理完

        // 中斷而頁面/瀏覽器仲生 (唔似係頁面關閉引起) → 唔好無限重試
        if (contextAlive(context) && pageAlive(page)) {
          log('⚠ 流程中斷但頁面未關閉, 停止呢日重試', 'warn');
          break;
        }
        const got = results.downloaded.length - before;
        if (got === 0 && tries >= 3) {
          log('⚠ 連續重試冇新下載進展, 停止呢日重試', 'warn');
          giveUp = true;
          break;
        }
        log(`⚠ ${dateStr} 下載中斷 (該次新下載 ${got} 筆), 自動恢復後繼續剩餘項目 ...`, 'warn');
        // 唔喺呢度硬試: 下一圈 while 會喺頂部按 context/page 狀態自動
        // 「重入 PAL」或「成個 Chrome 重啟」再續, 已下載嗰啲會自動跳過。
      }
      if (giveUp) {
        log('⚠ 多次未能恢復頁面, 跳過之後日期', 'warn');
        break;
      }
    }

    // 用戶清單中未出現過嘅 MAWB (可能尚未交收 / 未有 RCL)
    if (hasUserList) {
      const missing = Array.from(userTrackSet).filter((k) => !seenMawbKeys.has(k));
      if (missing.length) {
        log(`ℹ ${missing.length} 筆 MAWB 未喺搜尋結果出現 (可能尚未交收 / 未有 RCL): ${missing.join(', ')}`);
      }
    }
  } catch (e) {
    const msg = e.message || String(e);
    if (/closed|Target page|Execution context/i.test(msg)) {
      // Save As 後 popup/頁面有時會自動閂; 唔當致命錯誤, 已下載檔案照保留
      log(`⚠ 瀏覽器頁面中途關閉: ${msg} (已下載嘅檔案不受影響; 重新執行會自動跳過已下載)`, 'warn');
    } else {
      results.error = msg;
      log(`❌ 執行錯誤: ${msg}`, 'error');
    }
    if (page) {
      try {
        await screenshot(page, '99-error');
      } catch {}
    }
  } finally {
    if (context) {
      try {
        await context.close();
      } catch {}
    }
    log('瀏覽器已關閉');
  }

  if (relaunchCount > 0) {
    log(
      `ℹ 今次執行 Chrome 自動重啟咗 ${relaunchCount} 次 (Chrome 崩潰 / 網站閂晒自己啲視窗)。` +
        `已下載嘅檔案唔受影響; 若太頻繁, 可試吓更新 Chrome 或喺設定度改用「顯示瀏覽器視窗」模式對比。`,
      'warn'
    );
  }
  log(
    `完成: 已下載 ${results.downloaded.length} 筆, 已跳過 ${results.skipped.length} 筆, 失敗 ${results.failed.length} 筆`
  );
  results.mawbStatus = mawbStatus;
  return results;
}

module.exports = { runAutomation, bootToPal, formatAcceptDate };

