'use strict';

/** 詳細頁 <-> 列表 導航 (含「頁面已關閉」防護) */

const { safePress, findFirst, logPageInfo, waitForUrlOrText } = require('./dom');
const { sleep } = require('./util');
const { enterCommand } = require('./command');
const { fillPalSearch, pressSearch } = require('./pal-search');

async function openDetail(page, context, log) {
  try {
    if (page.isClosed()) return { page, isPopup: false, closed: true };
    const popupPromise = context.waitForEvent('page', { timeout: 2500 }).catch(() => null);
    const pressed = await safePress(page, 'Enter', log);
    const popup = await popupPromise;
    if (popup && !popup.isClosed()) {
      try {
        await popup.waitForLoadState('domcontentloaded', { timeout: 30000 });
      } catch {}
      await popup.bringToFront().catch(() => {});
      await sleep(1500);
      log('詳細資料在新視窗開啟');
      return { page: popup, isPopup: true, closed: false };
    }
    if (!pressed) return { page, isPopup: false, closed: true };
    // 同一頁轉跳: 等詳細頁出現 (URL 含 listingAOutlet 或出現 (F2)Save As)
    const r = await waitForUrlOrText(page, /listingAOutlet/, /\(F2\)Save As/, 6000).catch(() => null);
    if (r) log('詳細資料在同一頁開啟');
    await logPageInfo(page, '開詳細後', log).catch(() => {});
    return { page, isPopup: false, closed: false };
  } catch (e) {
    return { page, isPopup: false, closed: true };
  }
}

async function returnToList(page, cfg, log) {
  if (page.isClosed()) {
    log('⚠ 列表頁已關閉, 無法返回列表 (已下載嘅檔案唔受影響)', 'warn');
    return false;
  }
  const ok1 = await safePress(page, 'Escape', log);
  await sleep(900);
  const ok2 = ok1 ? await safePress(page, 'Escape', log) : false;
  await sleep(1500);
  if (!ok2) {
    log('⚠ 返回列表按鍵失敗 (頁面已關閉), 中止後續下載', 'warn');
    return false;
  }
  const inDetail = await page
    .evaluate(() => /AWB\s*[:：]?\s*\d{3}-\d{8}/i.test(document.body.innerText || ''))
    .catch(() => false);
  if (!inDetail) return true;

  log('按 Esc 未能返回列表, 嘗試按鈕 ...', 'warn');
  const back = await findFirst(page, [
    'button:has-text("Back")',
    'button:has-text("Close")',
    'button:has-text("返回")',
    'button:has-text("關閉")',
  ], { timeout: 3000 });
  if (back) {
    try {
      await back.click();
      await sleep(2500);
      return true;
    } catch (e) {
      log(`返回按鈕點擊失敗: ${e.message}`, 'warn');
      return false;
    }
  }
  log('嘗試重新搜尋以返回列表 ...', 'warn');
  try {
    await enterCommand(page, cfg, 'PAL', log, null);
    await fillPalSearch(page, cfg, null, log);
    await pressSearch(page, log, null);
    return true;
  } catch (e) {
    log(`重新搜尋失敗: ${e.message}`, 'warn');
    return false;
  }
}

module.exports = { openDetail, returnToList };
