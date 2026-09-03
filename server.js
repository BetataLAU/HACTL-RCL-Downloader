'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { loadConfig, saveConfig } = require('./src/config');
const { runAutomation } = require('./src/automation');

const app = express();
const PORT = Number(process.env.PORT) || 3090;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------- 狀態 ---------------- */
let running = false;
let stopRequested = false;
let currentRun = null; // { id, startedAt, status, logs: [], result }
const sseClients = new Set();

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const res of sseClients) {
    try {
      res.write(`data: ${s}\n\n`);
    } catch {}
  }
}

/* ---------------- API ---------------- */

app.get('/api/status', (req, res) => {
  res.json({
    running,
    stopRequested,
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
  if (typeof body.password === 'string' && body.password !== '') patch.password = body.password;
  const next = saveConfig(patch);
  res.json({ ok: true, hasPassword: !!next.password });
});

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify({ type: 'hello', running, hasCurrent: !!currentRun })}\n\n`);
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

app.get('/api/downloads', (req, res) => {
  const cfg = loadConfig();
  const dir = cfg.saveDir && cfg.saveDir.trim() ? cfg.saveDir : path.join(os.homedir(), 'Downloads');
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
  res.json({ dir, files });
});

/* ---------------- 執行任務 ---------------- */

async function executeRun(acceptDateOverride, airlineOverride, acceptDateToOverride) {
  const cfg = loadConfig();
  if (acceptDateOverride) cfg.acceptDate = acceptDateOverride;
  if (acceptDateToOverride) cfg.acceptDateTo = acceptDateToOverride;
  if (airlineOverride !== null && airlineOverride !== undefined) cfg.airline = airlineOverride;

  const run = {
    id: String(Date.now()),
    startedAt: new Date().toISOString(),
    status: 'running',
    logs: [],
    result: null,
  };
  running = true;
  currentRun = run;
  stopRequested = false;
  broadcast({ type: 'run-start', run: { id: run.id, startedAt: run.startedAt } });

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
}

/* ---------------- 啟動 ---------------- */

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log('==================================================');
  console.log('  HACTL RCL 自動下載工具');
  console.log(`  請用瀏覽器開啟: http://localhost:${PORT}`);
  console.log('==================================================');
  if (process.platform === 'win32') {
    try {
      require('child_process').exec(`start http://localhost:${PORT}`);
    } catch {}
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
