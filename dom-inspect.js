'use strict';

/**
 * 唯讀「DOM 快照」工具 (唔會下載 / 唔會改 XLS / 唔會寫 downloaded.json)
 * 目的: 入去 PAL → 開指定 MAWB 詳細頁 → 將真實 DOM (HTML/class/id + innerText
 *       + 可見元素清單) 存去 data/dom-inspect/ 分析 parse 用。
 *
 * 用法: node dom-inspect.js [日期DDMMMYY] [MAWB1 MAWB2 ...]
 * 例:   node dom-inspect.js 05SEP26 157-53933950 157-53933891
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { loadConfig } = require('./src/config');
const { bootToPal } = require('./src/automation/run');
const { fillPalSearch, pressSearch } = require('./src/automation/pal-search');
const { detectList } = require('./src/automation/grid');
const { openDetail } = require('./src/automation/navigate');
const { extractMAWB } = require('./src/automation/dom');
const { extractFromDetailText, debugDomParse } = require('./src/rcl/extract-text');

const OUT_DIR = path.join(__dirname, 'data', 'dom-inspect');
const log = (m) => console.log(`[${new Date().toLocaleTimeString()}] ${m}`);

/* 收集頁面可見文字元素 (tag#id.class | text) — 分析 label 用嘅 class/id */
function collectVisibleElements(page) {
  return page
    .evaluate(() => {
      const out = [];
      const seen = new Set();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      for (const n of nodes) {
        const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t) continue;
        const el = n.parentElement;
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const key = `${t}\u0000${el.tagName}\u0000${el.id}\u0000${el.className || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const cls = typeof el.className === 'string' ? el.className : '';
        out.push({
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          cls: cls.slice(0, 120),
          text: t.slice(0, 100),
          x: Math.round(r.x),
          y: Math.round(r.y),
        });
      }
      return out.slice(0, 1200);
    })
    .catch(() => []);
}

async function snapshotFrames(page, tag) {
  const frames = [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())];
  const files = [];
  for (let i = 0; i < frames.length; i++) {
    const fr = frames[i];
    try {
      const info = await fr
        .evaluate(() => ({
          url: location.href,
          title: document.title || '',
          text: document.body ? document.body.innerText : '',
          html: document.body ? document.body.outerHTML : '',
        }))
        .catch(() => null);
      if (!info || (!info.text && !info.html)) continue;
      const safe = `${tag}.f${i}`;
      fs.writeFileSync(path.join(OUT_DIR, `${safe}.html`), info.html, 'utf8');
      fs.writeFileSync(path.join(OUT_DIR, `${safe}.txt`), info.text, 'utf8');
      const els = await collectVisibleElements(fr);
      fs.writeFileSync(path.join(OUT_DIR, `${safe}.els.json`), JSON.stringify(els, null, 1), 'utf8');
      files.push({
        frame: i,
        url: info.url,
        title: info.title,
        textLen: info.text.length,
        htmlLen: info.html.length,
        els: els.length,
      });
    } catch (e) {
      files.push({ frame: i, error: e.message });
    }
  }
  return files;
}

async function findRowIndex(page, wantDigits) {
  const list = await detectList(page, log);
  if (!list.rows) return -1;
  const cnt = await list.rows.count().catch(() => 0);
  for (let i = 0; i < cnt; i++) {
    const txt = ((await list.rows.nth(i).innerText().catch(() => '')) || '').replace(/\D/g, '');
    if (txt.includes(wantDigits)) return i;
  }
  return -1;
}

async function main() {
  const args = process.argv.slice(2);
  const dateStr = args[0] || '05SEP26';
  let mawbs = args.slice(1).map((m) => m.replace(/\D/g, '')).filter((m) => m.length === 11);
  if (!mawbs.length) mawbs = ['15753933950', '15753933891'];

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const cfg = loadConfig();

  // 複製一份臨時 profile 嚟用, 避免同 server 嘅自動重查 (autoCheckMinutes) 撞 Chrome lock
  const PROFILE_SRC = path.join(__dirname, '.browser-data');
  const PROFILE_TMP = path.join(__dirname, '.browser-data-dom-inspect');
  try {
    fs.rmSync(PROFILE_TMP, { recursive: true, force: true });
    fs.cpSync(PROFILE_SRC, PROFILE_TMP, { recursive: true });
  } catch (e) {
    log(`複製 profile 失敗 (用原本 .browser-data): ${e.message}`);
  }
  const profileDir = fs.existsSync(PROFILE_TMP) ? PROFILE_TMP : PROFILE_SRC;

  let context = null;
  try {
    log('啟動 Chrome ...');
    context = await chromium.launchPersistentContext(profileDir, {
      channel: cfg.browserChannel || 'chrome',
      headless: !!cfg.headless,
      slowMo: Number(cfg.slowMo) || 0,
      acceptDownloads: true,
      viewport: { width: 1440, height: 900 },
      args: ['--disable-blink-features=AutomationControlled', '--disable-popup-blocking', '--start-maximized'],
    });
    let page = await bootToPal(context, cfg, log, async () => null, null);
    log(`搜尋 Accept Date: ${dateStr}`);
    await fillPalSearch(page, cfg, dateStr, log);
    await pressSearch(page, log, async () => null);

    const meta = [];
    for (const mawb of mawbs) {
      const rowIdx = await findRowIndex(page, mawb);
      log(`${mawb}: 列表行位置 rowIdx=${rowIdx} (Sequence=${rowIdx + 1})`);
      if (rowIdx < 0) {
        meta.push({ mawb, rowIdx: -1, error: '列表搵唔到' });
        continue;
      }
      const list = await detectList(page, log);
      await list.rows.nth(rowIdx).click().catch(() => {});
      await new Promise((r) => setTimeout(r, 500));

      const opened = await openDetail(page, context, log);
      const dp = opened.page;
      if (opened.closed || dp.isClosed()) {
        log(`${mawb}: 開詳細失敗`);
        meta.push({ mawb, rowIdx, error: 'openDetail closed' });
        continue;
      }
      await new Promise((r) => setTimeout(r, 1200));
      const gotMawb = await extractMAWB(dp).catch(() => null);
      log(`${mawb}: 詳細頁讀到 AWB=${gotMawb} url=${dp.url()}`);

      // DOM 正式 parse 對照
      const txt = await dp.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
      if (txt) {
        log(`── DOM parse 對照 (${mawb}) ──`);
        const entries = debugDomParse(txt);
        for (const e of entries) {
          if (e.found && e.value !== null && e.value !== '')
            log(`    ${e.field.padEnd(8)} = ${e.value}`);
          else if (e.found) log(`    ${e.field.padEnd(8)} = (label「${e.label}」喺度但抽唔到值)`);
          else log(`    ${e.field.padEnd(8)} = (搵唔到)`);
        }
        const f = extractFromDetailText(txt);
        fs.writeFileSync(path.join(OUT_DIR, `${mawb}.parsed.json`), JSON.stringify(f, null, 2), 'utf8');
      }

      const files = await snapshotFrames(dp, mawb);
      log(`${mawb}: 已存 ${files.length} 個 frame 快照 → ${OUT_DIR}`);
      meta.push({ mawb, rowIdx, gotMawb, files });

      // 返回列表
      if (opened.isPopup) {
        await dp.close().catch(() => {});
        await page.bringToFront().catch(() => {});
      } else {
        await dp.keyboard.press('Escape').catch(() => {});
        await dp.keyboard.press('Escape').catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
    fs.writeFileSync(path.join(OUT_DIR, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  } catch (e) {
    log(`❌ ${e.message}`);
  } finally {
    if (context) {
      try { await context.close(); } catch {}
    }
    try { fs.rmSync(PROFILE_TMP, { recursive: true, force: true }); } catch {}
    log('瀏覽器已關閉');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

