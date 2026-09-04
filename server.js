'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { loadConfig, saveConfig } = require('./src/config');
const { runAutomation } = require('./src/automation');
const systemOpen = require('./src/system-open');

const app = express();
const PORT = Number(process.env.PORT) || 3090;
const HOST = process.env.HOST || '127.0.0.1'; // 想畀 LAN 其他機開 UI 先至改做 0.0.0.0
const NO_OPEN = process.env.NO_OPEN === '1';   // =1 時唔自動開瀏覽器 (測試用)

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* pdf.js 靜態供應 (Quick Look 縮圖用; offline 都得) */
app.use('/vendor/pdfjs', express.static(path.join(__dirname, 'node_modules', 'pdfjs-dist', 'build')));

/* ---------------- helpers ---------------- */

function currentSaveDir() {
  const cfg = loadConfig();
  return cfg.saveDir && cfg.saveDir.trim() ? cfg.saveDir : path.join(os.homedir(), 'Downloads');
}

/** Viewer 係咪同 server 同一部機 (決定「喺 OS 開」動作可用性) */
function viewerIsLocal(req) {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/** 防目錄穿越: 淨係接受純檔名, 而且解析後必須仍然喺 saveDir 內 */
function safeFilePath(name) {
  const base = path.resolve(currentSaveDir());
  const clean = path.basename(String(name || '').trim());
  if (!clean || clean === '.' || clean === '..') return null;
  const full = path.resolve(base, clean);
  const rel = path.relative(base, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return full;
}

/** 非本機 viewer 一律禁止「喺 OS 開」動作 */
function isLocalViewer(req, res) {
  if (viewerIsLocal(req)) return true;
  res.status(403).json({ ok: false, error: '此動作只喺主機本機可用 (檔案喺 server 嗰部機)' });
  return false;
}

/* ---------------- 狀態 ---------------- */
let running = false;
let stopRequested = false;
let currentRun = null; // { id, startedAt, status, logs: [], result }
const sseClients = new Set();

/* ---------- 定時自動重查 ---------- */
let autoTimer = null;           // setTimeout handle
let autoNextAt = 0;             // 下次自動執行嘅 timestamp (ms)
let autoRunSeq = 0;             // 自動重查次數 (log 用)
let lastAutoAirline = null;     // 最後用嘅 airline, 自動重查沿用

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const res of sseClients) {
    try {
      res.write(`data: ${s}\n\n`);
    } catch {}
  }
}

/* ---------- 定時自動重查: 排程 / 廣播 ---------- */

function currentAutoState() {
  const cfg = loadConfig();
  const minutes = Math.max(0, Math.floor(Number(cfg.autoCheckMinutes) || 0));
  return { enabled: minutes > 0, minutes, nextAt: minutes > 0 && autoNextAt > 0 ? autoNextAt : 0 };
}

function broadcastAuto() {
  broadcast({ type: 'auto-status', ...currentAutoState() });
}

function clearAutoTimer() {
  if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
}

function scheduleAutoCheck() {
  clearAutoTimer();
  autoNextAt = 0;
  const cfg = loadConfig();
  const minutes = Math.max(0, Math.floor(Number(cfg.autoCheckMinutes) || 0));
  if (minutes > 0) {
    autoNextAt = Date.now() + minutes * 60 * 1000;
    autoTimer = setTimeout(() => { autoTimer = null; onAutoCheck(); }, minutes * 60 * 1000);
    if (autoTimer.unref) autoTimer.unref(); // 唔阻斷正常關 server
  }
  broadcastAuto();
}

function onAutoCheck() {
  autoTimer = null;
  const cfg = loadConfig();
  const minutes = Math.max(0, Math.floor(Number(cfg.autoCheckMinutes) || 0));
  if (minutes <= 0) { scheduleAutoCheck(); return; }
  if (running) {
    // 而家執行緊 → 5 秒後再睇, 唔重疊執行
    autoNextAt = Date.now() + 5000;
    autoTimer = setTimeout(onAutoCheck, 5000);
    if (autoTimer.unref) autoTimer.unref();
    broadcastAuto();
    return;
  }
  autoRunSeq++;
  broadcast({ type: 'log', ts: new Date().toISOString(), level: 'info', text: `⏱ 自動重查 #${autoRunSeq} (每 ${minutes} 分鐘): 開始, 查詢今日新出現嘅 RCL` });
  executeRun(null, null, lastAutoAirline || cfg.airline || null, 'auto');
}

/* ---------------- API ---------------- */

app.get('/api/status', (req, res) => {
  res.json({
    running,
    stopRequested,
    auto: currentAutoState(),
    currentRun: currentRun
      ? {
          id: currentRun.id,
          startedAt: currentRun.startedAt,
          status: currentRun.status,
          logs: currentRun.logs.slice(-80),
          result: currentRun.result || null,
        }
      : null,
  });
});

app.get('/api/config', (req, res) => {
  const cfg = loadConfig();
  res.json({
    baseUrl: cfg.baseUrl,
    username: cfg.username,
    hasPassword: !!cfg.password,
    airline: cfg.airline,
    acceptDate: cfg.acceptDate,
    acceptDateTo: cfg.acceptDateTo,
    saveDir: cfg.saveDir,
    defaultDir: path.join(os.homedir(), 'Downloads'),
    autoCheckMinutes: Math.max(0, Math.floor(Number(cfg.autoCheckMinutes) || 0)),
    headless: !!cfg.headless,
    profileName: cfg.profileName,
    browserChannel: cfg.browserChannel,
    maxRclRows: cfg.maxRclRows,
    mawbList: cfg.mawbList,
  });
});

app.post('/api/config', (req, res) => {
  const body = req.body || {};
  const cur = loadConfig();
  const patch = {};
  for (const k of ['baseUrl', 'username', 'airline', 'acceptDate', 'acceptDateTo', 'saveDir', 'headless', 'browserChannel', 'maxRclRows', 'profileName', 'mawbList']) {
    if (body[k] !== undefined) patch[k] = body[k];
  }
  if (body.autoCheckMinutes !== undefined) {
    patch.autoCheckMinutes = Math.max(0, Math.floor(Number(body.autoCheckMinutes) || 0));
  }
  if (typeof body.password === 'string' && body.password !== '') patch.password = body.password;
  const next = saveConfig(patch);
  scheduleAutoCheck(); // 改咗間隔/開關 → 立即重新排程 (0 = 停用)
  res.json({ ok: true, hasPassword: !!next.password });
});

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify({ type: 'hello', running, hasCurrent: !!currentRun, auto: currentAutoState() })}\n\n`);
  res.write(`data: ${JSON.stringify({ type: 'auto-status', ...currentAutoState() })}\n\n`);
  if (currentRun) {
    for (const l of currentRun.logs.slice(-200)) {
      res.write(`data: ${JSON.stringify(l)}\n\n`);
    }
  }
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.post('/api/run', (req, res) => {
  if (running) {
    res.status(409).json({ ok: false, error: '已有執行中的任務, 請稍候' });
    return;
  }
  const body = req.body || {};
  executeRun(body.acceptDate || null, typeof body.airline === 'string' ? body.airline : null, body.acceptDateTo || null);
  res.json({ ok: true });
});

app.post('/api/stop', (req, res) => {
  if (running) stopRequested = true;
  res.json({ ok: true });
});

/* ---------------- 已下載檔案: 列表 / 預覽 / 下載 / 系統開啟 ---------------- */

app.get('/api/downloads', (req, res) => {
  const dir = currentSaveDir();
  let files = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => / RCL\.pdf$/i.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { name: f, size: st.size, mtime: st.mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    /* folder not readable yet */
  }
  res.json({
    dir,
    defaultDir: path.join(os.homedir(), 'Downloads'),
    platform: process.platform,
    hostname: os.hostname(),
    viewerIsLocal: viewerIsLocal(req),
    files,
  });
});

/** 頁內預覽 (inline) 或下載 (dl=1)。sendFile 支援 Range, PDF viewer 可以正常翻頁。 */
app.get('/api/file', (req, res) => {
  const full = safeFilePath(req.query.name);
  if (!full || !fs.existsSync(full)) {
    res.status(404).json({ ok: false, error: '搵唔到檔案' });
    return;
  }
  const dl = req.query.dl === '1';
  res.setHeader('Content-Disposition', (dl ? 'attachment' : 'inline') + '; filename="' + path.basename(full) + '"');
  res.sendFile(full, (err) => {
    if (err && !res.headersSent) res.status(500).json({ ok: false, error: '讀取檔案失敗' });
  });
});

/* 以下三個「系統開啟」動作: 檔案喺 server 嗰部機, 所以淨係畀本機 viewer 用 */
app.post('/api/open-folder', async (req, res) => {
  if (!isLocalViewer(req, res)) return;
  const r = await systemOpen.openFolder(currentSaveDir());
  res.json(r);
});

app.post('/api/reveal-file', async (req, res) => {
  if (!isLocalViewer(req, res)) return;
  const full = safeFilePath(req.body && req.body.name);
  if (!full || !fs.existsSync(full)) {
    res.status(404).json({ ok: false, error: '搵唔到檔案' });
    return;
  }
  const r = await systemOpen.revealFile(full);
  res.json(r);
});

app.post('/api/open-file', async (req, res) => {
  if (!isLocalViewer(req, res)) return;
  const full = safeFilePath(req.body && req.body.name);
  if (!full || !fs.existsSync(full)) {
    res.status(404).json({ ok: false, error: '搵唔到檔案' });
    return;
  }
  const r = await systemOpen.openFile(full);
  res.json(r);
});


/* ---------------- 執行任務 ---------------- */

async function executeRun(acceptDateOverride, airlineOverride, acceptDateToOverride, source) {
  const cfg = loadConfig();
  if (acceptDateOverride) cfg.acceptDate = acceptDateOverride;
  if (acceptDateToOverride) cfg.acceptDateTo = acceptDateToOverride;
  if (airlineOverride !== null && airlineOverride !== undefined) cfg.airline = airlineOverride;
  lastAutoAirline = cfg.airline || null; // 自動重查沿用呢個 airline

  const run = {
    id: String(Date.now()),
    startedAt: new Date().toISOString(),
    status: 'running',
    logs: [],
    source: source || 'manual',
    result: null,
  };
  running = true;
  currentRun = run;
  stopRequested = false;
  broadcast({ type: 'run-start', run: { id: run.id, startedAt: run.startedAt, source: run.source } });

  const result = await runAutomation(cfg, {
    log: (text, level = 'info') => {
      const entry = { type: 'log', ts: new Date().toISOString(), level, text: String(text) };
      run.logs.push(entry);
      broadcast(entry);
    },
    screenshot: async (page, name) => {
      try {
        const dir = path.join(__dirname, 'screenshots', String(run.id));
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${name}.png`);
        await page.screenshot({ path: file });
        const entry = { type: 'log', ts: new Date().toISOString(), level: 'info', text: `📷 截圖: ${file}` };
        run.logs.push(entry);
        broadcast(entry);
        return file;
      } catch {
        return null;
      }
    },
    shouldStop: () => stopRequested,
    onDownloaded: (mawb) => {
      // 即時通知 UI: 呢個 MAWB 已成功下載 → tick 返 checkbox
      broadcast({ type: 'mawb-tick', mawb });
    },
  });

  run.status = 'done';
  run.finishedAt = new Date().toISOString();
  run.result = result;

  // 自動 tick 成功下載嘅 MAWB (只限用戶清單內嘅; 'downloaded' = 今次成功下載)
  if (result.mawbStatus && Array.isArray(cfg.mawbList)) {
    const normKey = (s) => (s || '').replace(/\D/g, '');
    let changed = false;
    cfg.mawbList = cfg.mawbList.map((m) => {
      if (m && !m.skip && result.mawbStatus[normKey(m.value)] === 'downloaded') {
        changed = true;
        return { ...m, skip: true };
      }
      return m;
    });
    if (changed) saveConfig({ mawbList: cfg.mawbList });
  }

  running = false;
  broadcast({ type: 'run-end', run: { id: run.id, status: 'done', result }, mawbList: cfg.mawbList });
  scheduleAutoCheck(); // 完成後自動排下一次 (如有開啟自動重查)
}

/* ---------------- 啟動 ---------------- */

const server = app.listen(PORT, HOST, () => {
  console.log('==================================================');
  console.log('  HACTL RCL 自動下載工具');
  console.log(`  請用瀏覽器開啟: http://localhost:${PORT}`);
  if (HOST !== '127.0.0.1') console.log(`  LAN 存取: http://${HOST}:${PORT} (請自行考慮安全性)`);
  console.log('==================================================');
  scheduleAutoCheck(); // 起動時由設定檔恢復自動重查排程
  if (!NO_OPEN) {
    systemOpen.openUrl(`http://localhost:${PORT}`).catch(() => {});
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[ERROR] 端口 ${PORT} 已被其他程式佔用。`);
    console.error(`        可改用其他端口: 先設定環境變數 PORT=3091 再執行 node server.js`);
  } else {
    console.error('[ERROR]', e);
  }
  process.exit(1);
});
