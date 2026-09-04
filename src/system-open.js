'use strict';

/**
 * 平台感知嘅「OS 開啟」動作層 (Windows / macOS / Linux)
 *
 * - Windows: explorer.exe / cmd start
 * - macOS:   open
 * - Linux:   xdg-open
 *
 * 所有動作都喺主機 (server 所在嗰部機) 執行。前端必須確認 viewer 係本機先用得。
 */
const { spawn, exec } = require('child_process');
const path = require('path');

function done(resolve) {
  let fired = false;
  return {
    ok: () => { if (!fired) { fired = true; resolve({ ok: true }); } },
    fail: (error) => { if (!fired) { fired = true; resolve({ ok: false, error: String(error) }); } },
  };
}

/** spawn 唔經 shell, 唔會彈黑色視窗; detached + unref 等 server 唔使等佢 */
function runSpawn(cmd, args) {
  return new Promise((resolve) => {
    const d = done(resolve);
    try {
      const child = spawn(cmd, args, { shell: false, detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', d.fail);
      child.on('spawn', () => { try { child.unref(); } catch (e) {} d.ok(); });
    } catch (e) { d.fail(e); }
    const t = setTimeout(() => d.ok(), 1500);
    if (typeof t.unref === 'function') t.unref();
  });
}

/** exec 只喺 Windows 某啲要「引號包住路徑一部分」嘅情況先用 (explorer /select) */
function runExec(cmdLine) {
  return new Promise((resolve) => {
    const d = done(resolve);
    try {
      exec(cmdLine, { windowsHide: true }, (err) => (err ? d.fail(err.message) : d.ok()));
    } catch (e) { d.fail(e); }
    const t = setTimeout(() => d.ok(), 1500);
    if (typeof t.unref === 'function') t.unref();
  });
}

function platformName(p) {
  p = p || process.platform;
  if (p === 'darwin') return 'macOS';
  if (p === 'win32') return 'Windows';
  if (p === 'linux') return 'Linux';
  return p;
}

/** 用系統預設應用程式開啟一個檔案 (例如 PDF) */
function openFile(filePath) {
  if (process.platform === 'darwin') return runSpawn('open', [filePath]);
  if (process.platform === 'win32') return runSpawn('cmd.exe', ['/c', 'start', '', filePath]);
  if (process.platform === 'linux') return runSpawn('xdg-open', [filePath]);
  return Promise.resolve({ ok: false, error: '唔支援嘅平台: ' + process.platform });
}

/** 將已開嘅視窗帶到最前 (Windows 有時唔會自動搶焦點, 會開咗喺後面) */
function bringToFront(title) {
  if (process.platform !== 'win32' || !title) return Promise.resolve({ ok: true });
  const safe = String(title).replace(/'/g, "''");
  const script = "(New-Object -ComObject WScript.Shell).AppActivate('" + safe + "')";
  return runSpawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script]);
}

/** 喺系統檔案管理員開一個資料夾 */
async function openFolder(dirPath) {
  if (process.platform === 'darwin') return runSpawn('open', [dirPath]);
  if (process.platform === 'win32') {
    const r = await runExec('start "" "' + dirPath + '"');
    await new Promise((resolve) => setTimeout(resolve, 900)); // 等視窗開
    await bringToFront(path.basename(dirPath));
    return r;
  }
  if (process.platform === 'linux') return runSpawn('xdg-open', [dirPath]);
  return { ok: false, error: '唔支援嘅平台: ' + process.platform };
}

/** 開資料夾並選取指定檔案 (Windows 要用特別引號格式, 所以行 exec) */
function revealFile(filePath) {
  if (process.platform === 'darwin') return runSpawn('open', ['-R', filePath]);
  if (process.platform === 'win32') return runExec('explorer /select,"' + filePath + '"');
  if (process.platform === 'linux') return runSpawn('xdg-open', [path.dirname(filePath)]);
  return Promise.resolve({ ok: false, error: '唔支援嘅平台: ' + process.platform });
}

/** 用系統預設瀏覽器開網址 (server 啟動時自動開 UI 用) */
function openUrl(url) {
  if (process.platform === 'darwin') return runSpawn('open', [url]);
  if (process.platform === 'win32') return runSpawn('cmd.exe', ['/c', 'start', '', url]);
  if (process.platform === 'linux') return runSpawn('xdg-open', [url]);
  return Promise.resolve({ ok: false, error: '唔支援嘅平台: ' + process.platform });
}

module.exports = { openFile, openFolder, revealFile, openUrl, platformName };