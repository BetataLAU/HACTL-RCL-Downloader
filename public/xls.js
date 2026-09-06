'use strict';

/**
 * 個人切換 (軒仔 / 劉鏘鏘) + XLS 同步卡 (劉鏘鏘)
 * 獨立檔案, 唔會令 app.js 過長
 */

(function () {
  const el = (id) => document.getElementById(id);

  async function jsonFetch(url, opts) {
    const r = await fetch(url, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.status + ' ' + url);
    return j;
  }

  function msg(text, isErr) {
    const m = el('xls-msg');
    if (!m) return;
    m.textContent = text;
    m.className = 'xls-msg' + (isErr ? ' err' : '');
  }

  /* ---------------- 個人切換 ---------------- */

  function renderProfileSwitch(list, active) {
    const wrap = el('profile-switch');
    if (!wrap || !Array.isArray(list)) return;
    wrap.innerHTML = '';
    for (const p of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'profile-pill' + (p.id === active ? ' active' : '');
      b.textContent = p.name;
      b.title = '切換做 ' + p.name;
      b.addEventListener('click', async () => {
        if (p.id === active) return;
        b.disabled = true;
        try {
          await jsonFetch('/api/profile/switch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: p.id }),
          });
          location.reload();
        } catch (e) {
          b.disabled = false;
          alert('切換失敗: ' + e.message);
        }
      });
      wrap.appendChild(b);
    }
  }

  /* ---------------- XLS 卡 UI ---------------- */

  function applyConfig(cfg) {
    const card = el('card-xls');
    const cardHin = el('card-hin');
    if (card) card.hidden = cfg.activeProfile !== 'liu';
    if (cardHin) cardHin.hidden = cfg.activeProfile !== 'hin';
    if (!card || cfg.activeProfile !== 'liu') return;

    const xs = cfg.xlsSync || {};
    if (xs.file && el('xls-file')) el('xls-file').value = xs.file;
    if (el('xls-enabled')) el('xls-enabled').checked = !!xs.enabled;
    if (xs.sheet) {
      const sel = el('xls-sheet');
      const exists = sel && [...sel.options].some((o) => o.value === xs.sheet);
      if (sel && !exists) {
        const o = document.createElement('option');
        o.value = xs.sheet;
        o.textContent = xs.sheet;
        sel.appendChild(o);
      }
      if (sel) sel.value = xs.sheet;
    }
  }

  function fillSheetOptions(sheets, current) {
    const sel = el('xls-sheet');
    if (!sel) return;
    sel.innerHTML = '';
    for (const s of sheets || []) {
      const o = document.createElement('option');
      o.value = s.name;
      o.textContent = s.name + (s.index === 0 ? ' (最左 = 預設)' : '');
      sel.appendChild(o);
    }
    if (current && [...sel.options].some((o) => o.value === current)) sel.value = current;
  }

  function renderInfo(info) {
    const box = el('xls-info');
    if (!box) return;
    if (!info || !info.ok) {
      box.className = 'xls-info err';
      box.textContent = '⚠ ' + (info && info.error ? info.error : '無法檢查');
      return;
    }
    box.className = 'xls-info ok';
    const hdrs = (info.headers || []).map((h) => h.title).join(' | ');
    const sample = (info.sample || [])
      .slice(0, 3)
      .map((r) => `R${r.row} ${r.mawb} ${r.type || ''} ${r.dest || ''} PCS=${r.pcs || ''} WT=${r.wt || ''}`)
      .join('\n');
    box.textContent =
      `檔案: ${info.file}\nWorksheet: ${info.sheet} | 共 ${info.totalSheets} 張\n資料行 (A欄11位MAWB): ${info.dataRows}\n表頭: ${hdrs}` +
      (sample ? `\n樣本:\n${sample}` : '');
  }

  async function checkInfo() {
    try {
      const r = await jsonFetch('/api/xls/info');
      const info = r.info || {};
      info.file = r.xlsSync && r.xlsSync.file;
      renderInfo(info);
      if (info.sheets) fillSheetOptions(info.sheets, r.xlsSync && r.xlsSync.sheet);
      if (el('xls-file') && r.xlsSync && r.xlsSync.file) el('xls-file').value = r.xlsSync.file;
      if (info.ok) msg('✅ 檢查完成');
      else msg('⚠ ' + (info.error || '檢查失敗'), true);
    } catch (e) {
      msg('檢查失敗: ' + e.message, true);
    }
  }

  async function saveSettings() {
    const file = el('xls-file') ? el('xls-file').value.trim() : '';
    const sheet = el('xls-sheet') ? el('xls-sheet').value : '';
    const enabled = el('xls-enabled') ? el('xls-enabled').checked : false;
    if (!file) {
      msg('請先揀 XLS 檔案', true);
      return;
    }
    try {
      await jsonFetch('/api/xls/pick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file }),
      });
      if (sheet) {
        await jsonFetch('/api/xls/sheet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sheet }),
        });
      }
      await jsonFetch('/api/xls/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      msg('✅ XLS 設定已儲存');
      await checkInfo();
    } catch (e) {
      msg('儲存失敗: ' + e.message, true);
    }
  }

  async function uploadFile(fileObj) {
    if (!fileObj) return;
    try {
      msg('⏳ 上傳緊 ' + fileObj.name + ' …');
      const r = await fetch('/api/xls/upload?name=' + encodeURIComponent(fileObj.name), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: fileObj,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || r.status);
      if (el('xls-file')) el('xls-file').value = j.file;
      fillSheetOptions(j.sheets, '');
      if (j.xlsSync && j.xlsSync.enabled && el('xls-enabled')) el('xls-enabled').checked = true;
      msg('✅ 已上傳: ' + j.file);
      await checkInfo();
    } catch (e) {
      msg('上傳失敗: ' + e.message, true);
    }
  }

  /* ---------------- 差異通知 (SSE) ---------------- */

  function renderIssues(out) {
    const wrap = el('xls-issues-wrap');
    const box = el('xls-issues');
    if (!wrap || !box) return;
    if (!out || (!out.issues && !out.error)) {
      wrap.hidden = true;
      return;
    }
    box.innerHTML = '';
    if (out.error) {
      const d = document.createElement('div');
      d.className = 'issue';
      d.textContent = '❌ ' + out.error;
      box.appendChild(d);
    }
    for (const it of (out.issues || []).slice(0, 300)) {
      const d = document.createElement('div');
      d.className = 'issue issue-' + (it.type || '');
      d.textContent = (it.mawb ? it.mawb + ' ' : '') + it.message;
      box.appendChild(d);
    }
    if (!out.issues.length && !out.error && !out.unchanged) {
      const d = document.createElement('div');
      d.className = 'issue';
      d.textContent = '✅ 冇差異';
      box.appendChild(d);
    }
    wrap.hidden = false;
  }

  function connectIssues() {
    try {
      const es = new EventSource('/api/events');
      es.addEventListener('xls-summary', (ev) => {
        try {
          renderIssues(JSON.parse(ev.data).out);
        } catch { /* ignore */ }
      });
    } catch { /* ignore */ }
  }

  /* ---------------- 初始化 ---------------- */

  async function init() {
    try {
      const p = await jsonFetch('/api/profiles');
      renderProfileSwitch(p.list, p.active);
    } catch { /* ignore */ }

    try {
      const cfg = await jsonFetch('/api/config');
      applyConfig(cfg);
    } catch { /* ignore */ }

    const btnUpload = el('btn-xls-upload');
    const fileInput = el('xls-file-input');
    if (btnUpload && fileInput) {
      btnUpload.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', () => {
        if (fileInput.files && fileInput.files[0]) uploadFile(fileInput.files[0]);
        fileInput.value = '';
      });
    }
    const card = el('card-xls');
    if (card) {
      card.addEventListener('dragover', (e) => e.preventDefault());
      card.addEventListener('drop', (e) => {
        e.preventDefault();
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
          uploadFile(e.dataTransfer.files[0]);
        }
      });
    }
    const btnCheck = el('btn-xls-check');
    if (btnCheck) btnCheck.addEventListener('click', checkInfo);
    const btnSave = el('btn-xls-save');
    if (btnSave) btnSave.addEventListener('click', saveSettings);

    connectIssues();
    if (el('card-xls') && !el('card-xls').hidden) checkInfo();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

