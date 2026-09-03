'use strict';

/**
 * HACTL RCL 自動下載核心 (COSAC-Plus / PAL)
 *
 * 流程:
 *   1. 開啟 cargo.hactl.com, 如有登入表單則填入帳密登入
 *   2. 點擊 "COSAC-Plus" 連結 (可能開新視窗)
 *   3. 在新視窗選擇 Profile = "Betata" 並確認
 *   4. 在頂部 command line box 輸入 "PAL"
 *   5. 填入 Accept Date 及 Airline, 按 Search
 *   6. 逐筆 RCL: 選行 → Enter 開詳細 → F2 → Save As → 下載成 "<MAWB> RCL.pdf"
 *
 * 由於內部網頁結構無法在此環境預先確認, 所有元素搜尋都用多組
 * 候選 selector, 並在每一步儲存截圖到 screenshots/<runId>/,
 * 方便第一次執行後按截圖微調。
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DATA_DIR = path.join(__dirname, '..', 'data');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等待下載事件, 限時 ms 毫秒; 超時返回 null */
function waitDownload(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/** Chrome 下載途中嘅暫存檔名 (例: 09124d9a-6235-...-a8c4aba2fad7.tmp / .crdownload) */
const TMP_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:tmp|crdownload)$/i;

/** 粗略檢查檔案係咪一份完整 PDF (以 %PDF 開頭、%%EOF 收尾) */
function looksCompletePdf(file) {
  try {
    const size = fs.statSync(file).size;
    if (size < 1000) return false;
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(8);
      const tail = Buffer.alloc(6);
      fs.readSync(fd, head, 0, 8, 0);
      fs.readSync(fd, tail, 0, 6, size - 6);
      return head.toString('latin1').startsWith('%PDF') && tail.toString('latin1').includes('%%EOF');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** 清走上一輪 crash 留低嘅下載暫存檔 (<uuid>.tmp/.crdownload, 已超過 60 秒冇更新 = 死檔) */
function cleanupOrphanTmp(dirs, log) {
  const now = Date.now();
  for (const dir of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => TMP_UUID_RE.test(n));
    } catch {
      continue;
    }
    for (const n of names) {
      const full = path.join(dir, n);
      try {
        const st = fs.statSync(full);
        if (now - st.mtimeMs < 60000) continue; // 太新, 可能仲下載緊
      } catch {
        continue;
      }
      try {
        fs.unlinkSync(full);
        log(`已清理上一輪留低嘅下載殘留: ${full}`, 'warn');
      } catch {}
    }
  }
}

/**
 * 保險網: Playwright 嘅 download.saveAs 有時會因為 page/context 提早關閉而失敗
 * ("Target page, context or browser has been closed"), 但其實 Chrome 已將成個檔案
 * 寫咗去下載資料夾 (名做 <uuid>.tmp)。呢度輪詢資料夾, 搵返嗰個暫存檔,
 * 等佢寫完 (大小穩定 + 完整 PDF) 之後直接改名做正式檔名, 唔使重新下載。
 */
async function adoptOrphanDownload(target, dirs, sinceTs, log, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  const noCandidateLimit = Date.now() + 8000; // 8 秒內完全冇新暫存檔 → 唔等, 直接放棄
  let seen = null;

  const findNewest = () => {
    let best = null;
    for (const dir of dirs) {
      let names = [];
      try {
        names = fs.readdirSync(dir).filter((n) => TMP_UUID_RE.test(n));
      } catch {
        continue;
      }
      for (const n of names) {
        const full = path.join(dir, n);
        if (path.resolve(full) === path.resolve(target)) continue;
        let st;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        if (st.mtimeMs < sinceTs - 3000) continue; // 早過按 Save As → 上一輪殘留, 唔理
        if (!best || st.mtimeMs > best.mtimeMs) best = { full, size: st.size };
      }
    }
    return best;
  };

  while (Date.now() < deadline) {
    const cur = findNewest();
    if (!cur) {
      if (Date.now() > noCandidateLimit) return false;
      await sleep(800);
      continue;
    }
    if (!seen || seen.full !== cur.full) {
      seen = cur;
      log(`發現 Chrome 下載暫存: ${cur.full} (${cur.size} bytes), 等佢寫完 ...`, 'warn');
      await sleep(1500);
      continue;
    }
    // 同一檔案連續見到 → 檢查大小是否已穩定 (唔再增長)
    const s1 = fs.statSync(seen.full).size;
    await sleep(1200);
    let s2 = -1;
    try {
      s2 = fs.statSync(seen.full).size;
    } catch {
      seen = null;
      continue;
    }
    if (s2 !== s1) continue; // 仲寫緊
    if (s2 < 1000) {
      log(`下載暫存太細 (${s2} bytes), 唔似有效檔案: ${seen.full}`, 'warn');
      return false;
    }
    if (!looksCompletePdf(seen.full)) {
      log(`下載暫存未完整 (可能被中斷), 唔敢當成功: ${seen.full}`, 'warn');
      return false;
    }
    log(`✅ 接管 Chrome 已下載好嘅檔案, 改名做 ${target}`);
    // Windows 上如果 Chrome 仲 hold 住個 handle, rename 會失敗 → 重試幾次
    for (let i = 0; i < 5; i++) {
      try {
        if (fs.existsSync(target)) fs.rmSync(target, { force: true });
        fs.renameSync(seen.full, target);
        return true;
      } catch {
        await sleep(1000);
      }
    }
    // 最後手段: copy + 刪除原檔
    try {
      fs.copyFileSync(seen.full, target);
      try { fs.unlinkSync(seen.full); } catch {}
      return true;
    } catch {
      return false;
    }
  }
  return false;
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

function formatAcceptDate(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  return `${dd}${MONTHS[d.getMonth()]}${String(d.getFullYear()).slice(-2)}`;
}

/** 解析 "15AUG26" → Date; 格式錯返回 null */
function parseDDMMMYY(s) {
  const m = String(s || '').trim().match(/^(\d{2})([A-Za-z]{3})(\d{2})$/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const mon = MONTHS.indexOf(m[2].toUpperCase());
  const year = 2000 + parseInt(m[3], 10);
  if (mon < 0 || day < 1 || day > 31) return null;
  return new Date(year, mon, day);
}

/** 由 from 到 to 嘅每日日期列表 (DDMMMYY); "auto"/空白 = 今日 */
function buildDateRange(fromRaw, toRaw) {
  const today = new Date();
  const f = parseDDMMMYY(fromRaw) || today;
  let t = parseDDMMMYY(toRaw) || f;
  if (t < f) t = f;
  const out = [];
  const d = new Date(f);
  while (d <= t) {
    out.push(formatAcceptDate(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

function loadDownloaded() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'downloaded.json'), 'utf8'));
  } catch {
    return {};
  }
}

function saveDownloaded(map) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'downloaded.json'), JSON.stringify(map, null, 2));
}

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

/* ------------------------------------------------------------------ */
/* 步驟 1: 登入 (可在 cargo.hactl.com 首頁 或 COSAC-Plus 頁面發生)        */
/* ------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------ */
/* 步驟 2: 開啟 COSAC-Plus (可能開新視窗)                                */
/* ------------------------------------------------------------------ */
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
    await logPageInfo(popup, 'COSAC-Plus 視窗', log);
    return popup;
  }
  log('COSAC-Plus 在同一頁開啟');
  await screenshot(page, '05-cosac-samepage');
  await logPageInfo(page, 'COSAC-Plus 後', log);
  return page;
}

/* ------------------------------------------------------------------ */
/* 步驟 3: 選擇 Profile = Betata                                        */
/* ------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------ */
/* 步驟 4: 在 command line box 輸入指令                                  */
/* ------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------ */
/* 步驟 5: 填 PAL 查詢條件 + Search                                      */
/* ------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------ */
/* 步驟 6: 偵測結果列表                                                 */
/* ------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------ */
/* 讀取結果表格完整數據 (Kendo Grid) — 為寫 Excel 做準備                   */
/* ------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------ */
/* 開詳細頁: Enter 可能在同一頁或開新視窗                                  */
/* ------------------------------------------------------------------ */
async function openDetail(page, context, log) {
  const popupPromise = context.waitForEvent('page', { timeout: 2500 }).catch(() => null);
  await page.keyboard.press('Enter');
  const popup = await popupPromise;
  if (popup) {
    try {
      await popup.waitForLoadState('domcontentloaded', { timeout: 30000 });
    } catch {}
    await popup.bringToFront();
    await sleep(1500);
    log('詳細資料在新視窗開啟');
    return { page: popup, isPopup: true };
  }
  // 同一頁轉跳: 等詳細頁出現 (URL 含 listingAOutlet 或出現 (F2)Save As)
  const r = await waitForUrlOrText(page, /listingAOutlet/, /\(F2\)Save As/, 6000);
  if (r) log('詳細資料在同一頁開啟');
  await logPageInfo(page, '開詳細後', log);
  return { page, isPopup: false };
}

/* ------------------------------------------------------------------ */
/* 返回列表                                                            */
/* ------------------------------------------------------------------ */
async function returnToList(page, cfg, log) {
  await page.keyboard.press('Escape');
  await sleep(900);
  await page.keyboard.press('Escape');
  await sleep(1500);
  const inDetail = await page
    .evaluate(() => /AWB\s*[:：]?\s*\d{3}-\d{8}/i.test(document.body.innerText || ''))
    .catch(() => false);
  if (!inDetail) return;

  log('按 Esc 未能返回列表, 嘗試按鈕 ...', 'warn');
  const back = await findFirst(page, [
    'button:has-text("Back")',
    'button:has-text("Close")',
    'button:has-text("返回")',
    'button:has-text("關閉")',
  ], { timeout: 3000 });
  if (back) {
    await back.click();
    await sleep(2500);
    return;
  }
  log('嘗試重新搜尋以返回列表 ...', 'warn');
  try {
    await enterCommand(page, cfg, 'PAL', log, null);
    await fillPalSearch(page, cfg, null, log);
    await pressSearch(page, log, null);
  } catch (e) {
    log(`重新搜尋失敗: ${e.message}`, 'warn');
  }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                             */
/* ------------------------------------------------------------------ */
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
  // 失敗接管 + 開場清理都要喺呢啲資料夾度搵 <uuid>.tmp
  const scanDirs = [];
  for (const d of [saveDir, path.join(os.homedir(), 'Downloads')]) {
    const r = path.resolve(d);
    if (!scanDirs.includes(r)) scanDirs.push(r);
  }
  cleanupOrphanTmp(scanDirs, log);

  let context = null;
  let page = null;

  try {
    log('正在啟動 Chrome ...');
    context = await chromium.launchPersistentContext(path.join(__dirname, '..', '.browser-data'), {
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
    page = context.pages()[0] || (await context.newPage());

    page = await doLogin(context, page, cfg, log, screenshot);

    page = await openCosacPlus(context, page, cfg, log, screenshot);

    // COSAC-Plus 頁面可能本身需要登入 (視乎網站流程)
    page = await loginIfPresent(context, page, cfg, log, screenshot);

    await selectProfile(page, cfg, log);
    await screenshot(page, '08-after-profile');
    await confirmProfile(page, log);
    await logPageInfo(page, 'Profile 後', log);

    await enterCommand(page, cfg, 'PAL', log, screenshot);

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
    const seenMawbKeys = new Set(); // 跨日期記錄搜尋結果出現過嘅 MAWB
    if (hasUserList) {
      log(`用戶 MAWB 清單: ${userTrackSet.size} 筆 (無 tick = 檢查並下載; tick = 跳過)`);
      if (userSkipSet.size) log(`用戶標記跳過: ${Array.from(userSkipSet).join(', ')}`);
    } else {
      log('冇用戶 MAWB 清單 → 下載全部 Type P/B (檔案已存在嘅跳過)');
    }

    // 處理一日: 搜尋 → 讀列表 → 決定 → 下載
    async function processDate(dateStr) {
      log(`===== 搜尋 Accept Date: ${dateStr} =====`);
      await fillPalSearch(page, cfg, dateStr, log);
      await screenshot(page, `09-pal-filled-${dateStr}`);
      await pressSearch(page, log, screenshot);

      const listInfo = await detectList(page, log);
      if (!listInfo.rows) {
        const txt = await getAllText(page).catch(() => '');
        if (/no record|沒有記錄|無資料|0 record/i.test(txt)) log(`${dateStr}: 沒有 RCL 記錄`);
        return;
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
      const listRows = gridData
        ? gridData.rows
            .map((r) => ({
              awb: awbIdx >= 0 ? (r[awbIdx] || '').trim() : '',
              type: typeIdx >= 0 ? (r[typeIdx] || '').trim().toUpperCase() : '',
              lih: lihIdx >= 0 ? (r[lihIdx] || '').trim().toUpperCase() : '',
            }))
            .filter((x) => x.awb)
        : [];
      if (listRows.length)
        log(`[${dateStr}] 列表 AWB (共 ${listRows.length} 筆): ${listRows.map((r) => r.awb).join(', ')}`);

    // 決定每筆: 有用戶清單 → 只處理清單內 + 無 tick 嘅 MAWB (強制下載);
    //           冇用戶清單 → 下載全部 Type P/B, 檔案已存在嘅跳過
    const downloadList = [];
    let skipTypeCount = 0;
    let skipDoneCount = 0;
    let notListedCount = 0;
    listRows.forEach((row, i) => {
      const key = normKey(row.awb);
      seenMawbKeys.add(key);
      if (hasUserList && !userTrackSet.has(key)) {
        notListedCount++;
        mawbStatus[key] = 'not-listed';
        return; // 唔喺用戶清單, 唔處理
      }
      if (userSkipSet.has(key)) {
        log(`⏭ 跳過 ${row.awb} (用戶已標記已下載)`);
        results.skipped.push(row.awb);
        mawbStatus[key] = 'user-skipped';
        return;
      }
      if (row.type !== 'P' && row.type !== 'B') {
        skipTypeCount++;
        log(`⏭ 跳過 ${row.awb} (Type=${row.type || '(空)'}, 只下載 P/B)`);
        results.skipped.push(row.awb);
        mawbStatus[key] = 'type-skipped';
        return;
      }
      const parts = [];
      if (row.type === 'B') parts.push('BULK');
      if (row.lih === 'N') parts.push('no LIH');
      const fname = `${row.awb} RCL${parts.length ? ` (${parts.join(', ')})` : ''}.pdf`;
      const target = path.join(saveDir, fname);
      // 冇用戶清單 (舊模式): 檔案存在就跳過; 有用戶清單: 無 tick 就照下載 (即使已有檔案都重新下載)
      if (!hasUserList && fs.existsSync(target)) {
        skipDoneCount++;
        log(`⏭ 跳過 ${row.awb} (檔案已存在)`);
        results.skipped.push(row.awb);
        mawbStatus[key] = 'already-have';
        return;
      }
      downloadList.push({ ...row, fname, target, idx: i });
      mawbStatus[key] = 'pending';
    });

    if (downloadList.length === 0) {
      if (listRows.length) {
        log(`✅ 列表 ${listRows.length} 筆: Type 唔啱 ${skipTypeCount} 筆, 檔案已有 ${skipDoneCount} 筆, 唔喺清單 ${notListedCount} 筆, 無需下載`);
      } else {
        log('無需下載新 RCL');
      }
    } else {
      log(`需要下載 ${downloadList.length} 筆新 RCL: ${downloadList.map((r) => r.awb).join(', ')}`);
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
    for (const item of downloadList) {
      if (shouldStop()) {
        log('收到停止指令, 結束', 'warn');
        break;
      }

      // 移到目標行: 按 ArrowDown (item.idx - currentPos) 次
      if (item.idx > currentPos) {
        for (let k = 0; k < item.idx - currentPos; k++) {
          await page.keyboard.press('ArrowDown');
          await sleep(600);
        }
        currentPos = item.idx;
      }
      log(`下載第 ${item.idx + 1} 行: AWB=${item.awb} | Type=${item.type} | LIH=${item.lih || '(空)'} → ${item.fname}`);

      /* 開啟詳細 (核對位置, 有偏差會自動修正重試) */
      let dp = null;
      let isPopup = false;
      let mawb = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const opened = await openDetail(page, context, log);
        dp = opened.page;
        isPopup = opened.isPopup;
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
          for (let k = 0; k < diff; k++) {
            await page.keyboard.press('ArrowDown');
            await sleep(600);
          }
          currentPos = item.idx;
          continue; // 再試一次
        }
        break;
      }

      if (!mawb) {
        log(`⚠ 第 ${item.idx + 1} 行開詳細後未能讀取 AWB`, 'warn');
        await screenshot(dp, `10-no-awb-${item.idx + 1}`);
        if (isPopup) await dp.close().catch(() => {});
        else await returnToList(page, cfg, log);
        results.failed.push(item.awb);
        continue;
      }
      if (mawb !== item.awb) {
        // 位置追蹤出錯會喺呢度現形, 避免存錯檔名
        log(`⚠ 詳細頁 AWB (${mawb}) 與列表 (${item.awb}) 唔符, 標記為失敗`, 'warn');
        await screenshot(dp, `14-mismatch-${item.awb}`);
        if (isPopup) await dp.close().catch(() => {});
        else await returnToList(page, cfg, log);
        results.failed.push(item.awb);
        continue;
      }
      log(`AWB: ${mawb}`);

      const target = item.target;
      {
        /* F2 → Save As (可能開新視窗) */
        const saveAsPopupPromise = context.waitForEvent('page', { timeout: 2500 }).catch(() => null);
        await dp.keyboard.press('F2');
        const saveAsPopup = await saveAsPopupPromise;
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
          await saveAsTarget.keyboard.press('Space');
          log('已按 SPACE 鍵 (等同按 Save As)');
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
            downloadedMap[mawb] = new Date().toISOString();
            saveDownloaded(downloadedMap);
            results.downloaded.push({ mawb, file: target });
            mawbStatus[normKey(mawb)] = 'downloaded';
            log(`✅ 已下載 ${mawb} RCL → ${target}`);
            // 通知 UI 即時 tick 返個 checkbox
            if (typeof hooks.onDownloaded === 'function') hooks.onDownloaded(mawb);
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
    }
    }

    // 逐日處理
    for (const dateStr of dates) {
      if (shouldStop()) break;
      await processDate(dateStr);
    }

    // 用戶清單中未出現過嘅 MAWB (可能尚未交收 / 未有 RCL)
    if (hasUserList) {
      const missing = Array.from(userTrackSet).filter((k) => !seenMawbKeys.has(k));
      if (missing.length) {
        log(`ℹ ${missing.length} 筆 MAWB 未喺搜尋結果出現 (可能尚未交收 / 未有 RCL): ${missing.join(', ')}`);
      }
    }
  } catch (e) {
    results.error = e.message || String(e);
    log(`❌ 執行錯誤: ${e.message}`, 'error');
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

  log(
    `完成: 已下載 ${results.downloaded.length} 筆, 已跳過 ${results.skipped.length} 筆, 失敗 ${results.failed.length} 筆`
  );
  results.mawbStatus = mawbStatus;
  return results;
}

module.exports = { runAutomation, formatAcceptDate };
