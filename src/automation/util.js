'use strict';

/** 純工具: sleep / 下載暫存檢查 / 日期 / downloaded.json (冇 playwright dependency) */

const path = require('path');
const fs = require('fs');
const { MONTHS, DATA_DIR } = require('./const');

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

module.exports = {
  sleep,
  waitDownload,
  TMP_UUID_RE,
  looksCompletePdf,
  cleanupOrphanTmp,
  adoptOrphanDownload,
  formatAcceptDate,
  parseDDMMMYY,
  buildDateRange,
  loadDownloaded,
  saveDownloaded,
};

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

