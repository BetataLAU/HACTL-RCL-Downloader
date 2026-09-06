'use strict';

/** 步驟 2-3: 開啟 COSAC-Plus + 揀 Profile */

const { findFirst, sel, getAllText, waitForUrlOrText } = require('./dom');
const { sleep } = require('./util');

async function openCosacPlus(context, page, cfg, log, screenshot) {
  const cosac = await findFirst(
    page,
    sel(cfg, 'cosacLink', [
      'a:has-text("COSAC-Plus")',
      'a:has-text("COSAC Plus")',
      'a:has-text("COSAC-Portal")',
      'text=COSAC-Plus',
      'text=COSAC-Portal',
    ]),
    { timeout: 40000 }
  );
  if (!cosac) throw new Error('找不到 COSAC-Plus 連結');

  const popupPromise = context.waitForEvent('page', { timeout: 45000 }).catch(() => null);
  await cosac.click();
  const popup = await popupPromise;

  if (popup) {
    try {
      await popup.waitForLoadState('domcontentloaded', { timeout: 30000 });
    } catch {}
    await popup.bringToFront();
    await sleep(1500);
    log('已開啟 COSAC-Plus 新視窗');
    await screenshot(popup, '05-cosac-popup');
    await logPageInfoSafe(popup, 'COSAC-Plus 視窗', log);
    return popup;
  }
  log('COSAC-Plus 在同一頁開啟');
  await screenshot(page, '05-cosac-samepage');
  await logPageInfoSafe(page, 'COSAC-Plus 後', log);
  return page;
}

/** logPageInfo 包一層 catch, 唔會因為頁面狀態而炸 (向後兼容舊行為) */
async function logPageInfoSafe(page, label, log) {
  try {
    const { logPageInfo } = require('./dom');
    await logPageInfo(page, label, log);
  } catch {}
}

async function selectProfile(page, cfg, log) {
  const combos = page.locator('select');
  const n = await combos.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const opts = combos.nth(i).locator('option');
    const cnt = await opts.count().catch(() => 0);
    for (let j = 0; j < cnt; j++) {
      const txt = ((await opts.nth(j).textContent().catch(() => '')) || '').trim();
      if (txt.toLowerCase().includes('betata')) {
        await combos.nth(i).selectOption({ index: j });
        log(`已選擇 Profile: ${txt}`);
        return true;
      }
    }
  }
  const betata = page.getByText(/betata/i).first();
  if (await betata.count().catch(() => 0)) {
    await betata.click().catch(() => {});
    log('已點擊 Profile: Betata');
    return true;
  }
  log('警告: 找不到 Betata 選項', 'warn');
  await dumpProfileOptions(page, log);
  return false;
}

/** 記錄頁面上的 profile 選擇結構 (下拉選單/radio/文字) 以便除錯 */
async function dumpProfileOptions(page, log) {
  try {
    const combos = page.locator('select');
    const n = await combos.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const opts = await combos.nth(i).locator('option').allTextContents().catch(() => []);
      log(`下拉選單 #${i} 選項: ${opts.map((o) => o.trim()).join(' / ')}`);
    }
    const radios = await page.locator('input[type="radio"]').count().catch(() => 0);
    if (radios > 0) log(`頁面有 ${radios} 個 radio 選項`);
    const txt = await getAllText(page).catch(() => '');
    log(`Profile 頁文字: ${txt.replace(/\s+/g, ' ').slice(0, 400)}`);
  } catch {}
}

async function confirmProfile(page, log) {
  const ok = await findFirst(page, [
    'button:has-text("OK")',
    'button:has-text("Enter")',
    'button:has-text("確定")',
    'button:has-text("Confirm")',
  ], { timeout: 3000 });
  if (ok) {
    await ok.click();
    log('已按確認鍵');
  } else {
    await page.keyboard.press('Enter');
    log('已按 Enter 確認');
  }
  // 等主畫面出現 (URL 有 landing 或出現 System Overview), 最多 10 秒
  const r = await waitForUrlOrText(page, /mainOutlet:landing/, /System Overview|Quick Start Guide/, 10000);
  if (!r) log('警告: 未確認已進入主畫面', 'warn');
}

module.exports = { openCosacPlus, selectProfile, dumpProfileOptions, confirmProfile };
