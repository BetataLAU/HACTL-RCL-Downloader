'use strict';

/** 步驟 4: 喺 command line box 輸入指令 (PAL) */

const { findFirst, sel, logPageInfo, waitForTextSilent } = require('./dom');
const { sleep } = require('./util');

async function enterCommand(page, cfg, cmd, log, screenshot) {
  const box = await findFirst(
    page,
    sel(cfg, 'commandBox', [
      'input[placeholder="Search Function Here"]',
      'input[placeholder*="Search Function" i]',
      'input[role="combobox"]',
      '.k-input-inner',
      'input[name*="cmd" i]',
      'input[placeholder*="command" i]',
      'input[placeholder*="指令" i]',
      'input[type="text"]',
      '#cmd',
    ]),
    { timeout: 15000 }
  );
  if (!box) {
    await logPageInfo(page, '找指令框失敗', log);
    throw new Error('找不到指令輸入框 (command line box)');
  }
  // Kendo combobox 需要真實鍵盤事件, 用逐字輸入
  await box.pressSequentially(cmd, { delay: 120 });
  await box.press('Enter');
  log(`已輸入指令: ${cmd} (Search Function Here)`);
  await sleep(1500);
  if (typeof screenshot === 'function') await screenshot(page, `06-command-${cmd}`);

  // 驗證是否已到達該功能畫面 (PAL 畫面具備 Accept Date / Airline)
  let ok = await waitForTextSilent(page, /Accept Date|Airline/i, 8000);
  if (!ok) {
    log('輸入後未見功能畫面, 試 ArrowDown + Enter ...');
    await box.press('ArrowDown');
    await sleep(500);
    await box.press('Enter');
    await sleep(1500);
    ok = await waitForTextSilent(page, /Accept Date|Airline/i, 8000);
  }
  if (!ok) {
    log('仍未見功能畫面, 嘗試按頂部選單 (PAL) ...');
    const tab = await findFirst(page, ['text=PAL', 'a:has-text("PAL")', 'span:has-text("PAL")', '.k-item:has-text("PAL")'], { timeout: 4000 });
    if (tab) {
      await tab.click();
      await sleep(2000);
    }
    ok = await waitForTextSilent(page, /Accept Date|Airline/i, 10000);
  }
  if (!ok) {
    await logPageInfo(page, `${cmd} 畫面確認失敗`, log);
    throw new Error(`未能到達 ${cmd} 畫面, 請查看日誌/截圖`);
  }
  log(`${cmd} 畫面已開啟`);
  if (typeof screenshot === 'function') await screenshot(page, `07-${cmd}-screen`);
}

module.exports = { enterCommand };
