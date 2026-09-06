'use strict';

/** 步驟 5: 填 PAL 查詢條件 + Search */

const { findFirst, sel, findInputNearLabel, dumpInputs, waitForText } = require('./dom');
const { sleep, formatAcceptDate } = require('./util');

async function fillPalSearch(page, cfg, dateStr, log) {
  await waitForText(page, /Accept Date|Airline|PAL/i, 30000);
  const acceptDate =
    dateStr || (cfg.acceptDate && cfg.acceptDate !== 'auto' ? cfg.acceptDate : formatAcceptDate(new Date()));
  log(`Accept Date 使用: ${acceptDate}`);

  // 記錄頁面上所有輸入框, 方便確認 selector 是否揀啱
  await dumpInputs(page, log);

  const dInput =
    (await findInputNearLabel(page, 'Accept Date')) ||
    (await findInputNearLabel(page, 'AcceptDate')) ||
    (await findFirst(page, sel(cfg, 'acceptDateInput', [
      'input[maxlength="7"]',
      'input[name*="accept" i]',
      'input[name*="date" i]',
    ]), { timeout: 4000 }));
  if (dInput) {
    await dInput.fill(acceptDate);
    await sleep(600);
    let v = ((await dInput.inputValue().catch(() => '')) || '').trim().toUpperCase();
    log(`Accept Date 填寫後值: "${v}"`);
    if (v !== acceptDate.toUpperCase() && !v.includes(acceptDate.toUpperCase().slice(2))) {
      log('Accept Date 值似未生效, 嘗試逐字輸入 ...', 'warn');
      await dInput.fill('');
      await dInput.pressSequentially(acceptDate, { delay: 150 });
      await sleep(600);
      v = ((await dInput.inputValue().catch(() => '')) || '').trim().toUpperCase();
      log(`Accept Date 重填後值: "${v}"`);
    }
  } else {
    log('警告: 找不到 Accept Date 輸入框', 'warn');
  }

  const aInput =
    (await findInputNearLabel(page, 'Airline')) ||
    (await findFirst(page, sel(cfg, 'airlineInput', [
      'input[role="combobox"][maxlength="3"]',
      'input[maxlength="3"]',
      'input[name*="airline" i]',
      'input[name*="air" i]',
    ]), { timeout: 4000 }));
  const air = (cfg.airline || '').trim();
  if (aInput) {
    if (air) {
      await fillAirlineCombobox(page, aInput, air, log);
    } else {
      log('Airline 留空 → 顯示所有航空公司');
    }
  } else if (air) {
    log('警告: 找不到 Airline 輸入框', 'warn');
  }
}


/** Kendo combobox 填值: 多種方法嘗試, 每次讀回值核對 */
async function fillAirlineCombobox(page, input, want, log) {
  want = (want || 'QR').toUpperCase();

  // 方法 1: 逐字輸入 (慢速)
  await input.click();
  await input.fill('');
  await input.pressSequentially(want, { delay: 250 });
  await sleep(1200);
  let v = ((await input.inputValue().catch(() => '')) || '').trim().toUpperCase();
  log(`Airline 輸入後值: "${v}" (想要 "${want}")`);
  if (v === want) return;

  // 方法 2: fill + Enter
  log('值不正確, 嘗試 fill + Enter ...', 'warn');
  await input.fill(want);
  await sleep(500);
  await input.press('Enter');
  await sleep(800);
  v = ((await input.inputValue().catch(() => '')) || '').trim().toUpperCase();
  log(`Airline fill 後值: "${v}"`);
  if (v === want) return;

  // 方法 3: 再輸入並用 ArrowDown + Enter 從下拉選單選擇
  log('仍不正確, 嘗試下拉選單選取 ...', 'warn');
  await input.fill('');
  await input.pressSequentially(want, { delay: 300 });
  await sleep(2000);
  for (let k = 0; k < 3; k++) {
    await input.press('ArrowDown');
    await sleep(400);
  }
  await input.press('Enter');
  await sleep(800);
  v = ((await input.inputValue().catch(() => '')) || '').trim().toUpperCase();
  log(`Airline 下拉選取後值: "${v}"`);
}

async function pressSearch(page, log, screenshot) {
  const btn = await findFirst(page, [
    'button:has-text("Search")',
    'input[type="button"][value="Search"]',
    'button:has-text("搜尋")',
    'button:has-text("查詢")',
    'text=Search',
    'text=搜尋',
  ], { timeout: 6000 });
  if (btn) {
    await btn.click();
    log('已按 Search 按鈕');
  } else {
    await page.keyboard.press('Enter');
    log('找不到 Search 按鈕, 已改按 Enter');
  }
  // 等結果表格出現 (最多 12 秒), 出現即提早返回
  await sleep(1000);
  const t0 = Date.now();
  while (Date.now() - t0 < 12000) {
    const cnt = await page.locator('table tbody tr, table tr').count().catch(() => 0);
    if (cnt > 0) break;
    await sleep(400);
  }
  if (typeof screenshot === 'function') await screenshot(page, '07-search-results');
}

module.exports = { fillPalSearch, fillAirlineCombobox, pressSearch };
