'use strict';

/** 登入 (cargo.hactl.com 首頁 / ADFS SSO / COSAC-Plus 再登入) */

const { findFirst, sel, waitForAny, logPageInfo } = require('./dom');
const { sleep } = require('./util');

async function loginIfPresent(context, page, cfg, log, screenshot) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await logPageInfo(page, `檢查登入 (第 ${attempt + 1} 次)`, log);

    /* A. 標準表單: 有密碼輸入框 */
    const pwd = await findFirst(
      page,
      sel(cfg, 'loginPassword', ['#passwordInput', 'input[type="password"]', 'input[name*="pass" i]']),
      { timeout: 6000 }
    );
    if (pwd) {
      log('偵測到登入表單, 填寫帳號密碼 ...');
      const user = await findFirst(
        page,
        sel(cfg, 'loginUsername', [
          '#userNameInput',
          'input[type="text"]',
          'input[name*="user" i]',
          'input[name*="login" i]',
          'input[name*="id" i]',
          '#username',
        ]),
        { timeout: 5000 }
      );
      if (!user) throw new Error('找不到帳號輸入框');

      if (!cfg.username || !cfg.password) {
        throw new Error('尚未設定帳號密碼, 請先在網頁介面的「設定」填入並儲存');
      }

      await user.fill(cfg.username);
      await pwd.fill(cfg.password);
      await screenshot(page, '03-login-filled');

      const submit = await findFirst(
        page,
        sel(cfg, 'loginSubmit', [
          '#submitButton',
          'span.submit[role="button"]',
          '.ch-loginBtnLine',
          '.ch-loginBtnText',
          'button[type="submit"]',
          'input[type="submit"]',
          'button:has-text("Login")',
          'button:has-text("登入")',
          'button:has-text("登錄")',
          'button:has-text("Sign in")',
          'text=Login',
          'text=登錄',
          'text=登入',
        ]),
        { timeout: 5000 }
      );
      if (submit) {
        await submit.click();
        log('已點擊登入按鈕');
      } else {
        await pwd.press('Enter');
        log('找不到登入按鈕, 已改按 Enter');
      }
      log('等待登入結果 ...');

      await page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
      await sleep(2000);

      // 等待登入表單消失 (最多 25 秒), 確認登入成功
      const t0 = Date.now();
      let stillPwd = await findFirst(page, ['input[type="password"]'], { timeout: 3000 });
      while (stillPwd && Date.now() - t0 < 25000) {
        await sleep(1500);
        stillPwd = await findFirst(page, ['input[type="password"]'], { timeout: 3000 });
      }
      if (stillPwd) {
        await screenshot(page, '04-login-failed');
        throw new Error('登入失敗: 頁面仍在登入表單, 請檢查帳號/密碼');
      }
      log('登入完成');
      await screenshot(page, '04-after-login');
      await logPageInfo(page, '登入完成後', log);
      return page;
    }

    /* B. 自訂表單 / 登入入口: 有可見登入按鈕 */
    const loginBtn = await findFirst(
      page,
      sel(cfg, 'loginSubmit', [
        '.ch-loginBtnText',
        '.ch-loginBtnLine',
        'button:has-text("Login")',
        'button:has-text("登入")',
        'button:has-text("登錄")',
        'text=LOGIN',
        'text=Login',
        'text=MEMBER LOGIN',
        'text=登錄',
        'text=登入',
      ]),
      { timeout: 3000 }
    );
    if (loginBtn) {
      const inputs = page.locator(
        'input[type="text"]:visible, input[type="password"]:visible, input:not([type]):visible'
      );
      const n = await inputs.count().catch(() => 0);
      if (n >= 2) {
        /* 自訂表單: 有按鈕且有輸入框 → 直接填寫提交 */
        log('偵測到登入表單 (自訂輸入框), 依順序填寫 ...');
        if (!cfg.username || !cfg.password) {
          throw new Error('尚未設定帳號密碼, 請先在網頁介面的「設定」填入並儲存');
        }
        await inputs.nth(0).fill(cfg.username);
        await inputs.nth(1).fill(cfg.password);
        await screenshot(page, '03-login-filled-custom');
        await loginBtn.click();
        log('已點擊登入按鈕 (自訂表單)');
        await page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
        await sleep(2500);
        const stillBtn = await findFirst(page, ['.ch-loginBtnText', '.ch-loginBtnLine'], { timeout: 3000 });
        if (stillBtn) {
          await screenshot(page, '04-login-failed');
          throw new Error('登入失敗: 頁面仍在登入表單, 請檢查帳號/密碼');
        }
        log('登入完成 (自訂表單)');
        await screenshot(page, '04-after-login');
        return page;
      }
      /* 有登入按鈕但無輸入框 → 這是「登入入口」, 按它以開啟登入表單 */
      log('見到登入按鈕但未有輸入框, 嘗試按它以開啟登入表單 ...');
      const popupPromise = context.waitForEvent('page', { timeout: 4000 }).catch(() => null);
      await loginBtn.click();
      const popup = await popupPromise;
      if (popup) {
        try {
          await popup.waitForLoadState('domcontentloaded', { timeout: 30000 });
        } catch {}
        await popup.bringToFront();
        await sleep(1500);
        log('登入表單在新視窗開啟');
        page = popup;
      } else {
        // 同一頁轉跳 (例: 跳去 ADFS), 等登入表單出現
        await waitForAny(page, [
          ['#passwordInput', 'input[type="password"]'],
          ['#submitButton', 'span.submit[role="button"]'],
        ], 10000);
      }
      await screenshot(page, '03-after-open-login');
      continue;
    }

    /* C. 只有隱藏登入按鈕 (LoginGSS3Btn) → 登入入口 */
    const clickedHidden = await page
      .evaluate(() => {
        const b = document.querySelector('input[name="LoginGSS3Btn"], input[value="Login"]');
        if (b) {
          b.click();
          return true;
        }
        return false;
      })
      .catch(() => false);
    if (clickedHidden) {
      log('偵測到隱藏登入按鈕, 已觸發, 等待登入表單 ...');
      const popupPromise = context.waitForEvent('page', { timeout: 4000 }).catch(() => null);
      const popup = await popupPromise;
      if (popup) {
        try {
          await popup.waitForLoadState('domcontentloaded', { timeout: 30000 });
        } catch {}
        await popup.bringToFront();
        await sleep(1500);
        log('登入表單在新視窗開啟');
        page = popup;
      } else {
        await waitForAny(page, [
          ['#passwordInput', 'input[type="password"]'],
          ['#submitButton', 'span.submit[role="button"]'],
        ], 10000);
      }
      await screenshot(page, '04-after-open-login-hidden');
      continue;
    }

    /* D. 什麼都沒有 → 視為已登入 */
    log('未偵測到登入表單 (無密碼框、無登入按鈕), 可能已有登入 session, 直接繼續');
    await screenshot(page, '02-no-login-form');
    return page;
  }

  await logPageInfo(page, '按了登入後仍未見表單', log);
  throw new Error('按了登入按鈕後仍未出現登入表單, 請把登入頁面的 HTML 給我');
}

async function doLogin(context, page, cfg, log, screenshot) {
  log(`開啟 ${cfg.baseUrl} ...`);
  await page.goto(cfg.baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(1500);
  return loginIfPresent(context, page, cfg, log, screenshot);
}

module.exports = { loginIfPresent, doLogin };

