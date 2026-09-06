'use strict';

/** DOM / 鍵盤 helpers: selector、文字、按鍵 (全部防「頁面已關閉」炸 run) */

const { sleep } = require('./util');

/** 把 config.selectors.<step> 的覆寫與預設候選合併 (覆寫優先) */
function sel(cfg, step, defaults) {
  const ov = (cfg.selectors && Array.isArray(cfg.selectors[step])) ? cfg.selectors[step] : [];
  return [...ov, ...defaults];
}

/** 依序嘗試候選 selector, 於任何 frame 中找第一個可見元素 (先快查存在, 再等可見) */
async function findFirst(page, candidates, { timeout = 3000 } = {}) {
  const frames = [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())];
  for (const c of candidates) {
    for (const fr of frames) {
      try {
        const loc = fr.locator(c).first();
        const cnt = await loc.count(); // count() 不會等待, 快
        if (cnt > 0) {
          await loc.waitFor({ state: 'visible', timeout });
          return loc;
        }
      } catch {
        /* next */
      }
    }
  }
  return null;
}

/** 收集所有 frame 的 body 文字 */
async function getAllText(page) {
  const parts = [];
  const frames = [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())];
  for (const fr of frames) {
    try {
      const t = await fr.evaluate(() => (document.body ? document.body.innerText : ''));
      if (t) parts.push(t);
    } catch {
      /* ignore */
    }
  }
  return parts.join('\n');
}

/** 等待文字出現, 不回傳錯誤 (找不到返回 false) */
async function waitForTextSilent(page, regex, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const txt = await getAllText(page).catch(() => '');
    if (regex.test(txt)) return true;
    await sleep(800);
  }
  return false;
}

async function waitForText(page, regex, timeout = 30000) {
  if (await waitForTextSilent(page, regex, timeout)) return true;
  throw new Error(`等待文字超時: ${regex}`);
}

/** 等待網址或頁面文字符合條件 (每 300ms 檢查一次, 提早返回) */
async function waitForUrlOrText(page, urlRegex, textRegex, timeout) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      if (urlRegex.test(page.url())) return 'url';
      if (textRegex) {
        const txt = await getAllText(page).catch(() => '');
        if (textRegex.test(txt)) return 'text';
      }
    } catch {}
    await sleep(300);
  }
  return null;
}

/** 輪詢多組 selector, 出現任何一組即返回元素 (最多 timeout 毫秒) */
async function waitForAny(page, selectorGroups, timeout) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    for (const group of selectorGroups) {
      const el = await findFirst(page, group, { timeout: 800 });
      if (el) return el;
    }
    await sleep(300);
  }
  return null;
}

/** 按鍵但防止「頁面已關閉」炸死成個 run (Save As 後 popup 有時會自動閂) */
async function safePress(page, key, log) {
  try {
    if (!page || page.isClosed()) throw new Error('page closed');
    await page.bringToFront().catch(() => {});
    await page.keyboard.press(key);
    return true;
  } catch (e) {
    if (log) log(`⚠ 按鍵 ${key} 失敗: ${e.message} (頁面可能已關閉)`, 'warn');
    return false;
  }
}

/** 從詳細頁文字中抽出 MAWB (例: 157-53711873) */
async function extractMAWB(page) {
  const txt = await getAllText(page).catch(() => '');
  const m1 = txt.match(/AWB\s*[:：]?\s*(\d{3}-\d{8})/i);
  if (m1) return m1[1];
  const m2 = txt.match(/\b(\d{3}-\d{8})\b/);
  if (m2) return m2[1];
  return null;
}

/** 找 label 文字附近的 input */
async function findInputNearLabel(page, labelText) {
  const label = page.locator(`label:has-text("${labelText}")`).first();
  if (await label.count().catch(() => 0)) {
    const forId = await label.getAttribute('for').catch(() => null);
    if (forId) {
      const byId = page.locator(`#${forId}`);
      if (await byId.count().catch(() => 0)) return byId;
    }
    const inside = label.locator('input').first();
    if (await inside.count().catch(() => 0)) return inside;
  }
  const xp = page
    .locator(`xpath=//input[ancestor::*[1][contains(normalize-space(.), '${labelText}')]]`)
    .first();
  if (await xp.count().catch(() => 0)) return xp;
  return null;
}

/* ------------------------------------------------------------------ */
/* 診斷工具                                                             */
/* ------------------------------------------------------------------ */

/** 記錄目前頁面的網址 / 標題 / 可見文字 (方便從日誌判斷卡在哪一步) */
async function logPageInfo(page, label, log) {
  try {
    log(`[${label}] 網址: ${page.url()}`);
    const title = await page.title().catch(() => '');
    if (title) log(`[${label}] 標題: ${title}`);
    const txt = await getAllText(page).catch(() => '');
    const snippet = txt.replace(/\s+/g, ' ').slice(0, 300);
    if (snippet) log(`[${label}] 頁面文字: ${snippet}`);
  } catch {}
}

/** 列出頁面上所有可見 <input> 的屬性 */
async function dumpInputs(page, log) {
  try {
    const info = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('input').forEach((el, i) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          out.push(`#${i} type=${el.type} name=${el.name || ''} id=${el.id || ''} placeholder=${el.placeholder || ''}`);
        }
      });
      return out;
    });
    if (info.length) log(`可見輸入框: ${info.join(' | ')}`);
    else log('頁面上沒有可見 <input> 元素');
  } catch {}
}

module.exports = {
  sel,
  findFirst,
  getAllText,
  waitForTextSilent,
  waitForText,
  waitForUrlOrText,
  waitForAny,
  safePress,
  extractMAWB,
  findInputNearLabel,
  logPageInfo,
  dumpInputs,
};

