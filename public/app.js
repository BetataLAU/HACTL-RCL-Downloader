'use strict';

const $ = (id) => document.getElementById(id);

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function todayDDMMMYY() {
  const d = new Date();
  return String(d.getDate()).padStart(2, '0') + MONTHS[d.getMonth()] + String(d.getFullYear()).slice(-2);
}

function setStatus(text, runningFlag) {
  $('status-text').textContent = text;
  $('status-dot').className = 'dot ' + (runningFlag ? 'running' : 'idle');
}

function logLine(text, level = 'info') {
  const el = document.createElement('div');
  el.className = 'log-' + level;
  const ts = new Date().toLocaleTimeString('zh-HK', { hour12: false });
  el.textContent = `[${ts}] ${text}`;
  $('log').appendChild(el);
  while ($('log').childNodes.length > 800) $('log').removeChild($('log').firstChild);
  $('log').scrollTop = $('log').scrollHeight;
}

function clearChips() {
  $('sum-downloaded').textContent = '0';
  $('sum-skipped').textContent = '0';
  $('sum-failed').textContent = '0';
}

/* ---------------- 定時自動重查 (UI) ---------------- */

let autoStateUI = { enabled: false, minutes: 0, nextAt: 0, pausedAllTicked: false };

function pad2(n) {
  return String(n).padStart(2, '0');
}

function updateAutoChip() {
  const el = $('chip-auto');
  if (!el) return;
  if (!autoStateUI.enabled) {
    el.textContent = '⏱ 自動重查: 關';
    el.className = 'chip mute';
    el.title = '定時自動重查: 喺「設定」度改分鐘數, 0 = 關閉';
    return;
  }
  if (autoStateUI.pausedAllTicked) {
    el.textContent = '⏸ 自動重查: 已暫停 (全部已下載)';
    el.className = 'chip mute';
    el.title = 'MAWB 清單已全部 tick (已下載 RCL)。取消任何 tick / 加新 MAWB / 清空清單, 再按「開始下載」或「儲存設定」即會自動重啟。';
    return;
  }
  let rest = '';
  if (autoStateUI.nextAt) {
    const ms = Math.max(0, autoStateUI.nextAt - Date.now());
    rest = ' · 下次 ' + pad2(Math.floor(ms / 60000)) + ':' + pad2(Math.floor((ms % 60000) / 1000));
  }
  el.textContent = '⏱ 每 ' + autoStateUI.minutes + ' 分自動重查' + rest;
  el.className = 'chip ok';
  el.title = '定時自動重查: 喺「設定」度改分鐘數; MAWB 清單全部已下載時會自動暫停';
}

function applyAutoState(s) {
  if (!s) return;
  autoStateUI.enabled = !!s.enabled;
  autoStateUI.minutes = Number(s.minutes) || 0;
  autoStateUI.nextAt = Number(s.nextAt) || 0;
  autoStateUI.pausedAllTicked = !!s.pausedAllTicked;
  updateAutoChip();
}

/* ---------------- MAWB 格式處理 (同 server 端一致) ---------------- */

function padLeft(s, n) {
  return String(s).padStart(n, '0');
}

function normalizeMAWB(raw) {
  if (raw === null || raw === undefined) return null;
  const input = String(raw).trim();
  if (!input) return null;
  const digits = input.replace(/\D/g, '');
  if (!digits) return null;
  let prefix = '';
  let suffix = '';
  if (input.includes('-')) {
    const parts = input.split('-');
    prefix = padLeft((parts[0] || '').replace(/\D/g, ''), 3).slice(-3);
    suffix = padLeft((parts[1] || '').replace(/\D/g, ''), 8).slice(-8);
  } else if (digits.length === 11) {
    prefix = digits.slice(0, 3);
    suffix = digits.slice(3);
  } else if (digits.length <= 8) {
    prefix = '001';
    suffix = padLeft(digits, 8).slice(-8);
  } else {
    prefix = padLeft(digits.slice(0, digits.length - 8), 3).slice(-3);
    suffix = padLeft(digits.slice(-8), 8);
  }
  return {
    prefix,
    suffix,
    digits: prefix + suffix,
    display: `${prefix}-${suffix.slice(0, 4)} ${suffix.slice(4)}`,
  };
}

function validateMAWB(m) {
  if (!m) return { valid: false, reason: '格式無法解析' };
  const p = parseInt(m.prefix, 10);
  if (m.prefix.length !== 3 || isNaN(p) || p < 1 || p > 999) {
    return { valid: false, reason: '錯 MAWB# (Prefix 必須 001-999)' };
  }
  if (m.suffix.length !== 8 || !/^\d{8}$/.test(m.suffix)) {
    return { valid: false, reason: '錯 MAWB# (Suffix 必須 8 位數字)' };
  }
  const first7 = parseInt(m.suffix.slice(0, 7), 10);
  const check = parseInt(m.suffix[7], 10);
  if (first7 % 7 !== check) {
    return { valid: false, reason: '錯 MAWB# (檢查位不符)' };
  }
  return { valid: true, reason: '' };
}

function checkMAWB(raw) {
  const m = normalizeMAWB(raw);
  if (!m) return { valid: false, reason: '格式無法解析', mawb: null };
  const v = validateMAWB(m);
  return { valid: v.valid, reason: v.reason, mawb: m };
}

/* ---------------- MAWB 清單表格 ---------------- */

let mawbList = []; // [{ value, skip, orig }]
let nextOrig = 1;

function collectMawbList() {
  const rows = Array.from(document.querySelectorAll('#mawb-body tr'));
  return rows
    .map((tr, idx) => {
      const skip = tr.querySelector('.mawb-skip').checked;
      const value = tr.querySelector('.mawb-value').value.trim();
      const orig = parseInt(tr.dataset.orig, 10) || idx + 1;
      return { value, skip, orig };
    })
    .filter((r) => r.value);
}

function renumberRows() {
  const rows = Array.from(document.querySelectorAll('#mawb-body tr'));
  rows.forEach((tr, i) => {
    const cell = tr.querySelector('.row-num');
    if (cell) cell.textContent = '#' + (i + 1);
  });
}

function renderMawbTable() {
  const tb = $('mawb-body');
  tb.innerHTML = '';
  const list = mawbList.length ? mawbList : [{ value: '', skip: false }];
  list.forEach((item) => addMawbRow(item));
  renumberRows();
  updateMawbValidation();
}

function addMawbRow(item) {
  const tb = $('mawb-body');
  const tr = document.createElement('tr');
  const orig = item.orig != null ? item.orig : nextOrig++;
  tr.dataset.orig = String(orig);

  const tdNum = document.createElement('td');
  tdNum.className = 'row-num';
  tdNum.textContent = '';

  const tdCheck = document.createElement('td');
  const chk = document.createElement('input');
  chk.type = 'checkbox';
  chk.className = 'mawb-skip';
  chk.checked = !!item.skip;
  chk.title = '已下載RCL: 勾選 = 跳過, 唔檢查';
  tdCheck.appendChild(chk);

  const tdValue = document.createElement('td');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'mawb-value';
  input.placeholder = '157-5371 1840';
  input.value = item.value || '';
  tdValue.appendChild(input);
  const errSpan = document.createElement('span');
  errSpan.className = 'mawb-err';
  tdValue.appendChild(errSpan);

  const tdDel = document.createElement('td');
  const delBtn = document.createElement('button');
  delBtn.className = 'btn danger small';
  delBtn.textContent = '✕';
  delBtn.title = '刪除這行';
  tdDel.appendChild(delBtn);

  tr.appendChild(tdNum);
  tr.appendChild(tdCheck);
  tr.appendChild(tdValue);
  tr.appendChild(tdDel);
  tb.appendChild(tr);

  chk.addEventListener('change', () => {
    mawbList = collectMawbList();
    ensureEmptyRow();
  });

  input.addEventListener('input', () => {
    updateMawbValidation();
  });

  input.addEventListener('blur', () => {
    // 有效就統一格式顯示
    const c = checkMAWB(input.value);
    if (c.valid && c.mawb) input.value = c.mawb.display;
    updateMawbValidation();
  });

  input.addEventListener('paste', (e) => {
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (!text) return;
    const values = text.split(/[\r\n\t,;]+/).map((s) => s.trim()).filter(Boolean);
    if (values.length === 0) return;
    e.preventDefault();
    // 第一個值放入呢一行, 其餘新增行
    input.value = values[0];
    for (let i = 1; i < values.length; i++) {
      const m = checkMAWB(values[i]);
      addMawbRow({ value: m.valid && m.mawb ? m.mawb.display : values[i], skip: false });
    }
    input.blur();
    input.focus();
    renumberRows();
    updateMawbValidation();
  });

  delBtn.addEventListener('click', () => {
    tr.remove();
    mawbList = collectMawbList();
    ensureEmptyRow();
  });
}

function ensureEmptyRow() {
  const rows = Array.from(document.querySelectorAll('#mawb-body tr'));
  const hasEmpty = rows.some((tr) => !tr.querySelector('.mawb-value').value.trim());
  if (!hasEmpty) addMawbRow({ value: '', skip: false });
  updateMawbValidation();
}

/** 檢查所有行, 有錯就閃爍 + 提示 + 阻擋執行 */
function updateMawbValidation() {
  const rows = Array.from(document.querySelectorAll('#mawb-body tr'));
  let hasInvalid = false;
  let invalidCount = 0;
  rows.forEach((tr) => {
    const input = tr.querySelector('.mawb-value');
    const err = tr.querySelector('.mawb-err');
    const raw = input.value.trim();
    if (!raw) {
      input.classList.remove('invalid');
      if (err) err.textContent = '';
      return;
    }
    const c = checkMAWB(raw);
    if (c.valid) {
      input.classList.remove('invalid');
      if (err) err.textContent = '';
    } else {
      hasInvalid = true;
      invalidCount++;
      input.classList.add('invalid');
      if (err) err.textContent = c.reason || '錯 MAWB#';
    }
  });

  const msg = $('mawb-msg');
  if (hasInvalid) {
    $('btn-run').disabled = true;
    msg.textContent = `⛔ 有 ${invalidCount} 個錯 MAWB#, 請修正後先可以執行`;
    msg.className = 'err-text';
  } else {
    $('btn-run').disabled = false;
    msg.textContent = '';
    msg.className = '';
  }
}

/* ---------------- 設定 ---------------- */

async function loadConfig() {
  try {
    const r = await fetch('/api/config');
    const c = await r.json();
    $('s-username').value = c.username || '';
    $('s-password').value = '';
    $('s-password').placeholder = c.hasPassword ? '已設定 (留空 = 不更改)' : '尚未設定';
    $('s-saveDir').value = c.saveDir || '';
    $('s-autoCheck').value = c.autoCheckMinutes !== undefined ? String(c.autoCheckMinutes) : '0';
    $('s-airline').value = c.airline || '';
    $('s-showBrowser').checked = !c.headless;
    if (!$('r-acceptDate').value) $('r-acceptDate').value = todayDDMMMYY();
    if (!$('r-acceptDateTo').value) $('r-acceptDateTo').value = c.acceptDateTo && c.acceptDateTo !== 'auto' ? c.acceptDateTo : todayDDMMMYY();
    $('r-airline').value = c.airline || '';
    mawbList = Array.isArray(c.mawbList)
      ? c.mawbList.map((m, i) => ({ value: m.value || '', skip: !!m.skip, orig: i + 1 }))
      : [];
    nextOrig = mawbList.length + 1;
    renderMawbTable();
  } catch (e) {
    logLine('讀取設定失敗: ' + e.message, 'error');
  }
}

async function refreshDownloads() {
  // 📂 已下載檔案 UI 已由 files.js 接管: 呢度淨係轉發事件, 由 files.js 重新整理
  window.dispatchEvent(new CustomEvent('dl-refresh-requested'));
}

/** 即時 tick 返指定 MAWB 嘅 checkbox (成功下載後由 server 通知) */
function tickMawb(rawMawb) {
  const digits = String(rawMawb || '').replace(/\D/g, '');
  if (!digits) return;
  const rows = Array.from(document.querySelectorAll('#mawb-body tr'));
  for (const tr of rows) {
    const input = tr.querySelector('.mawb-value');
    const m = normalizeMAWB(input.value);
    if (m && m.digits === digits) {
      tr.querySelector('.mawb-skip').checked = true;
      break;
    }
  }
  mawbList = collectMawbList();
}

function connectSSE() {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === 'hello') {
      applyAutoState(msg.auto);
    } else if (msg.type === 'auto-status') {
      applyAutoState(msg);
    } else if (msg.type === 'log') {
      logLine(msg.text, msg.level || 'info');
    } else if (msg.type === 'mawb-tick') {
      tickMawb(msg.mawb);
    } else if (msg.type === 'run-start') {
      setStatus(msg.run && msg.run.source === 'auto' ? '⏱ 自動執行中 (定時重查)...' : '執行中...', true);
      $('btn-run').disabled = true;
      $('btn-stop').disabled = false;
      clearChips();
    } else if (msg.type === 'run-end') {
      setStatus('閒置', false);
      $('btn-stop').disabled = true;
      const r = msg.run.result;
      if (r) {
        $('sum-downloaded').textContent = r.downloaded.length;
        $('sum-skipped').textContent = r.skipped.length;
        $('sum-failed').textContent = r.failed.length;
        if (r.error) logLine('執行有錯誤: ' + r.error, 'error');
      }
      // 伺服器已自動 tick 已下載嘅 MAWB
      if (Array.isArray(msg.mawbList)) {
        mawbList = msg.mawbList.map((m) => ({ value: m.value || '', skip: !!m.skip }));
        renderMawbTable();
      }
      updateMawbValidation();
      refreshDownloads();
    }
  };
  es.onerror = () => {
    /* EventSource 會自動重連 */
  };
}

/* ---------------- 按鈕事件 ---------------- */

$('btn-save-settings').addEventListener('click', async () => {
  const body = {
    username: $('s-username').value.trim(),
    password: $('s-password').value,
    saveDir: $('s-saveDir').value.trim(),
    autoCheckMinutes: Math.max(0, Math.floor(Number($('s-autoCheck').value) || 0)),
    airline: $('s-airline').value.trim(),
    headless: !$('s-showBrowser').checked,
    mawbList: collectMawbList(),
  };
  try {
    const r = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    $('settings-msg').textContent = j.ok ? '✅ 已儲存' : '❌ 儲存失敗';
    setTimeout(() => { $('settings-msg').textContent = ''; }, 3000);
    if (j.ok) {
      $('s-password').value = '';
      loadConfig();
    }
  } catch (e) {
    $('settings-msg').textContent = '❌ ' + e.message;
  }
});

$('btn-add-mawb').addEventListener('click', () => {
  addMawbRow({ value: '', skip: false });
  renumberRows();
  updateMawbValidation();
});

$('btn-clear-mawb').addEventListener('click', () => {
  mawbList = [];
  nextOrig = 1;
  renderMawbTable();
});

/* 排序: asc / desc / orig */
function sortMawbList(mode) {
  mawbList = collectMawbList();
  const num = (v) => {
    const m = normalizeMAWB(v);
    return m ? parseInt(m.digits, 10) : null;
  };
  if (mode === 'orig') {
    mawbList.sort((a, b) => (a.orig || 0) - (b.orig || 0));
  } else {
    mawbList.sort((a, b) => {
      const na = num(a.value);
      const nb = num(b.value);
      if (na === null && nb === null) return (a.orig || 0) - (b.orig || 0);
      if (na === null) return 1;
      if (nb === null) return -1;
      return mode === 'desc' ? nb - na : na - nb;
    });
  }
  renderMawbTable();
}

$('btn-sort-asc').addEventListener('click', () => sortMawbList('asc'));
$('btn-sort-desc').addEventListener('click', () => sortMawbList('desc'));
$('btn-sort-orig').addEventListener('click', () => sortMawbList('orig'));

$('btn-del-invalid').addEventListener('click', () => {
  const rows = Array.from(document.querySelectorAll('#mawb-body tr'));
  let removed = 0;
  rows.forEach((tr) => {
    const input = tr.querySelector('.mawb-value');
    if (input.value.trim() && !checkMAWB(input.value).valid) {
      tr.remove();
      removed++;
    }
  });
  mawbList = collectMawbList();
  ensureEmptyRow();
  const msg = $('mawb-msg');
  msg.textContent = removed ? `✅ 已刪除 ${removed} 個無效 MAWB` : '冇無效 MAWB 需要刪除';
  setTimeout(() => { if (msg.textContent.startsWith('✅') || msg.textContent.startsWith('冇')) msg.textContent = ''; }, 4000);
});

$('btn-run').addEventListener('click', async () => {
  // 再檢查一次有冇錯 MAWB
  updateMawbValidation();
  const rows = Array.from(document.querySelectorAll('#mawb-body tr'));
  const invalid = rows.some((tr) => {
    const input = tr.querySelector('.mawb-value');
    return input.value.trim() && !checkMAWB(input.value).valid;
  });
  if (invalid) {
    logLine('⛔ 有錯 MAWB#, 請修正後先可以執行', 'error');
    return;
  }
  let acceptDate = $('r-acceptDate').value.trim();
  let acceptDateTo = $('r-acceptDateTo').value.trim();
  const airline = $('r-airline').value.trim(); // 留空 = 顯示所有航空公司

  // 日期檢查: 格式 + 「到」唔可以早過「由」
  const parseDate = (s) => {
    const m = String(s).match(/^(\d{2})([A-Za-z]{3})(\d{2})$/);
    if (!m) return null;
    const mon = MONTHS.indexOf(m[2].toUpperCase());
    if (mon < 0) return null;
    return new Date(2000 + parseInt(m[3], 10), mon, parseInt(m[1], 10));
  };
  const dFrom = acceptDate ? parseDate(acceptDate) : null;
  const dTo = acceptDateTo ? parseDate(acceptDateTo) : null;
  if (acceptDate && !dFrom) {
    logLine(`⛔ Accept Date「由」格式唔啱: ${acceptDate} (應如 15AUG26)`, 'error');
    return;
  }
  if (acceptDateTo && !dTo) {
    logLine(`⛔ Accept Date「到」格式唔啱: ${acceptDateTo} (應如 16AUG26)`, 'error');
    return;
  }
  if (dFrom && dTo && dTo < dFrom) {
    logLine('「到」早過「由」, 已自動對調', 'warn');
    [acceptDate, acceptDateTo] = [acceptDateTo, acceptDate];
  }

  clearChips();
  $('log').innerHTML = '';
  try {
    // 先儲存 MAWB 清單, 再開始執行
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mawbList: collectMawbList() }),
    });
    const r = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acceptDate, acceptDateTo, airline }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      logLine('無法開始: ' + (j.error || r.status), 'error');
    }
  } catch (e) {
    logLine('無法開始: ' + e.message, 'error');
  }
});

$('btn-stop').addEventListener('click', async () => {
  try {
    await fetch('/api/stop', { method: 'POST' });
    logLine('已送出停止指令, 將在完成目前步驟後停止...', 'warn');
  } catch {
    /* ignore */
  }
});

/* ---------------- 啟動 ---------------- */

loadConfig();
connectSSE();
refreshDownloads();
updateAutoChip();
setInterval(refreshDownloads, 15000);
setInterval(updateAutoChip, 1000);
