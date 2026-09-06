'use strict';

/** XLS 設定 / 檢查 router (掛喺 server.js /api 下) */

const express = require('express');
const fs = require('fs');
const { loadConfig, saveConfig } = require('./config');
const { listSheets, inspectSheet } = require('./xls/inspect');

const router = express.Router();
const path = require('path');

/** 冇設定檔案時嘅預設建議: project root 嗰份 HC HIN LISTING.xlsx */
function defaultSuggestion() {
  const p = path.join(__dirname, '..', 'HC HIN LISTING.xlsx');
  return fs.existsSync(p) ? p : null;
}

/** 讀返當前 profile 嘅 xlsSync + 檢查檔案 */
router.get('/xls/info', async (req, res) => {
  const cfg = loadConfig();
  const xs = cfg.xlsSync || {};
  const file = xs.file && fs.existsSync(xs.file) ? xs.file : defaultSuggestion();
  if (!file) {
    res.json({ ok: false, error: '未設定 XLS 檔案 (亦搵唔到建議檔)', xlsSync: xs });
    return;
  }
  const info = await inspectSheet(file, xs.sheet || undefined);
  res.json({ ok: info.ok, info, xlsSync: { ...xs, file: info.ok ? file : xs.file, sheet: info.sheet || xs.sheet } });
});

/** 網頁拖曳/揀檔上傳 → 存入 data/xls/, 返回路徑 + sheet 清單 */
router.post('/xls/upload', express.raw({ type: () => true, limit: '100mb' }), async (req, res) => {
  try {
    const name = String((req.query && req.query.name) || 'upload.xlsx');
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ ok: false, error: '冇檔案內容' });
    }
    const cfg = loadConfig();
    const dir = path.join(__dirname, '..', 'data', 'xls', String(cfg.activeProfile || 'default'));
    fs.mkdirSync(dir, { recursive: true });
    const safe = path.basename(name).replace(/[^\w.\- ()]/g, '_') || 'upload.xlsx';
    const target = path.join(dir, `${Date.now()}-${safe}`);
    fs.writeFileSync(target, req.body);
    const sheets = await listSheets(target);
    saveConfig({ xlsSync: { ...(loadConfig().xlsSync || {}), file: target, enabled: true } });
    res.json({ ok: true, file: target, sheets, xlsSync: loadConfig().xlsSync });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** 讀返當前 profile 嘅 xlsSync + 檢查檔案 */
router.get('/xls/info', async (req, res) => {
  const cfg = loadConfig();
  const xs = cfg.xlsSync || {};
  if (!xs.file || !fs.existsSync(xs.file)) {
    res.json({ ok: false, error: xs.file ? '檔案唔存在: ' + xs.file : '未設定 XLS 檔案', xlsSync: xs });
    return;
  }
  const info = await inspectSheet(xs.file, xs.sheet || undefined);
  res.json({ ok: info.ok, info, xlsSync: { ...xs, sheet: info.sheet || xs.sheet } });
});

/** 揀/匯入 XLS 檔案路徑 (會即刻試讀, 回傳 sheet 清單) */
router.post('/xls/pick', async (req, res) => {
  try {
    const file = String((req.body && req.body.file) || '').trim();
    if (!file) return res.status(400).json({ ok: false, error: '冇檔案路徑' });
    if (!fs.existsSync(file)) return res.status(400).json({ ok: false, error: '檔案唔存在: ' + file });
    const sheets = await listSheets(file);
    saveConfig({ xlsSync: { ...(loadConfig().xlsSync || {}), file, enabled: true } });
    res.json({ ok: true, sheets, xlsSync: loadConfig().xlsSync });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** 揀 worksheet (預設最左) */
router.post('/xls/sheet', async (req, res) => {
  try {
    const cfg = loadConfig();
    const xs = cfg.xlsSync || {};
    if (!xs.file) return res.status(400).json({ ok: false, error: '未設定 XLS 檔案' });
    const sheet = String((req.body && req.body.sheet) || '').trim();
    saveConfig({ xlsSync: { ...xs, sheet: sheet || undefined } });
    const info = await inspectSheet(xs.file, sheet || undefined);
    res.json({ ok: info.ok, info });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** 開/關同步 */
router.post('/xls/toggle', (req, res) => {
  const cfg = loadConfig();
  const enabled = !!(req.body && req.body.enabled);
  saveConfig({ xlsSync: { ...(cfg.xlsSync || {}), enabled } });
  res.json({ ok: true, xlsSync: loadConfig().xlsSync });
});

module.exports = router;
