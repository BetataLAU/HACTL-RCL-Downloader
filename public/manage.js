'use strict';

/* ================= 資料管理 (下載記錄 + 截圖) =================
   獨立 script, 唔同 app.js 共用變數 (避免 const 撞名)。
   ============================================================ */

(() => {
  const el = (id) => document.getElementById(id);

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then((r) => r.json().catch(() => ({})));
  }

  function flashStatus(text, cls = 'mute', ms = 4000) {
    const s = el('mgmt-status');
    if (!s) return;
    s.textContent = text;
    s.className = 'chip ' + cls;
    clearTimeout(s._t);
    s._t = setTimeout(() => {
      s.textContent = '';
      s.className = 'chip mute';
    }, ms);
  }

  function fmtBytes(n) {
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
    return String(n) + ' B';
  }

  function fmtDT(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso || '-';
    return d.toLocaleString('zh-HK', { hour12: false });
  }

  /* ---------------- 下載記錄 ---------------- */

  async function loadRecords() {
    const bodyEl = el('mgmt-rec-body');
    let data = null;
    try {
      const r = await fetch('/api/records');
      data = await r.json();
    } catch {
      bodyEl.innerHTML = '<tr><td colspan="4">讀取失敗</td></tr>';
      return;
    }
    if (!data.ok) return;
    const items = data.items || [];
    if (!items.length) {
      bodyEl.innerHTML = '<tr><td colspan="4" class="hint">暫無下載記錄</td></tr>';
      return;
    }
    bodyEl.innerHTML = '';
    items.forEach((it, i) => {
      const tr = document.createElement('tr');

      const tdNum = document.createElement('td');
      tdNum.textContent = String(i + 1);
      tdNum.style.color = '#9ca3af';

      const tdMawb = document.createElement('td');
      tdMawb.textContent = it.mawb;
      tdMawb.style.fontFamily = 'Consolas, monospace';

      const tdAt = document.createElement('td');
      tdAt.textContent = fmtDT(it.at);

      const tdAct = document.createElement('td');
      const del = document.createElement('button');
      del.className = 'btn danger small';
      del.textContent = '🗑';
      del.title = '刪除呢筆記錄 (' + it.mawb + ')';
      del.addEventListener('click', async () => {
        if (!confirm(`確定刪除下載記錄 ${it.mawb}?\n(唔會刪除已下載嘅 PDF, 只係冇咗歷史記錄)`)) return;
        const j = await post('/api/records/delete', { mawb: it.mawb });
        flashStatus(j.ok ? `已刪除 ${(j.removed || []).length} 筆` : '刪除失敗', j.ok ? 'ok' : 'bad');
        loadRecords();
      });
      tdAct.appendChild(del);

      tr.appendChild(tdNum);
      tr.appendChild(tdMawb);
      tr.appendChild(tdAt);
      tr.appendChild(tdAct);
      bodyEl.appendChild(tr);
    });
  }

  /* ---------------- 截圖 ---------------- */

  async function loadShots() {
    const bodyEl = el('mgmt-shot-body');
    const sumEl = el('mgmt-shot-summary');
    let data = null;
    try {
      const r = await fetch('/api/screenshots');
      data = await r.json();
    } catch {
      if (bodyEl) bodyEl.innerHTML = '<tr><td colspan="5">讀取失敗</td></tr>';
      return;
    }
    if (!data.ok) return;
    if (sumEl) {
      sumEl.textContent = `共 ${data.count} 個執行資料夾 / ${data.totalFiles} 張截圖 / ${fmtBytes(data.totalSize)}`;
    }
    const runs = data.runs || [];
    if (!runs.length) {
      bodyEl.innerHTML = '<tr><td colspan="5" class="hint">暫無截圖</td></tr>';
      return;
    }
    bodyEl.innerHTML = '';
    runs.forEach((run) => {
      const tr = document.createElement('tr');

      const tdDate = document.createElement('td');
      tdDate.textContent = fmtDT(run.date);

      const tdId = document.createElement('td');
      tdId.textContent = run.id;
      tdId.style.fontFamily = 'Consolas, monospace';

      const tdFiles = document.createElement('td');
      tdFiles.textContent = String(run.files);

      const tdSize = document.createElement('td');
      tdSize.textContent = fmtBytes(run.size);

      const tdAct = document.createElement('td');

      const open = document.createElement('button');
      open.className = 'btn secondary small local-only';
      open.textContent = '📂';
      open.title = '喺檔案總管開啟 (只限本機)';
      open.addEventListener('click', async () => {
        const j = await post('/api/screenshots/open', { id: run.id });
        if (!j.ok) flashStatus(j.error || '開啟失敗', 'bad');
      });

      const del = document.createElement('button');
      del.className = 'btn danger small';
      del.textContent = '🗑';
      del.title = '刪除呢個截圖資料夾';
      del.addEventListener('click', async () => {
        if (!confirm(`確定刪除 ${run.id} 呢個截圖資料夾?(${run.files} 張, ${fmtBytes(run.size)})`)) return;
        const j = await post('/api/screenshots/delete', { ids: [run.id] });
        flashStatus(j.ok ? `已刪除 ${(j.removed || []).length} 個資料夾` : '刪除失敗', j.ok ? 'ok' : 'bad');
        loadShots();
      });

      tdAct.appendChild(open);
      tdAct.appendChild(del);
      tr.appendChild(tdDate);
      tr.appendChild(tdId);
      tr.appendChild(tdFiles);
      tr.appendChild(tdSize);
      tr.appendChild(tdAct);
      bodyEl.appendChild(tr);
    });

    // 非本機 viewer: 隱藏「開啟」按鈕
    if (!/127\.0\.0\.1|::1/.test(location.hostname)) {
      bodyEl.querySelectorAll('.local-only').forEach((b) => b.remove());
    }
  }

  async function refreshAll(silent) {
    await Promise.all([loadRecords(), loadShots()]);
    if (!silent) flashStatus('已更新');
  }

  /* ---------------- 事件 ---------------- */

  el('btn-mgmt-refresh').addEventListener('click', () => refreshAll(false));

  el('btn-rec-clear-30d').addEventListener('click', async () => {
    if (!confirm('確定刪除「30 日前」嘅所有下載記錄?\n(唔影響已下載 PDF, 純粹清歷史)')) return;
    const j = await post('/api/records/clear', { olderThanDays: 30 });
    flashStatus(j.ok ? `已刪除 ${(j.removed || []).length} 筆` : '失敗', j.ok ? 'ok' : 'bad');
    loadRecords();
  });

  el('btn-rec-clear-all').addEventListener('click', async () => {
    if (!confirm('⚠️ 確定清空所有下載記錄?\n(唔影響已下載 PDF / 跳過邏輯)')) return;
    const j = await post('/api/records/clear', {});
    flashStatus(j.ok ? `已清空 ${(j.removed || []).length} 筆` : '失敗', j.ok ? 'ok' : 'bad');
    loadRecords();
  });

  el('btn-shot-clear-7d').addEventListener('click', async () => {
    if (!confirm('確定刪除「7 日前」嘅所有截圖資料夾?')) return;
    const j = await post('/api/screenshots/delete', { olderThanDays: 7 });
    flashStatus(j.ok ? `已刪除 ${(j.removed || []).length} 個資料夾` : '失敗', j.ok ? 'ok' : 'bad');
    loadShots();
  });

  el('btn-shot-clear-all').addEventListener('click', async () => {
    if (!confirm('⚠️ 確定清空所有截圖資料夾?')) return;
    const j = await post('/api/screenshots/delete', { all: true });
    flashStatus(j.ok ? `已刪除 ${(j.removed || []).length} 個資料夾` : '失敗', j.ok ? 'ok' : 'bad');
    loadShots();
  });

  /* run 完成 (狀態由 running 變返閒置) 後順手更新一次 */
  let wasRunning = null;
  setInterval(async () => {
    try {
      const st = el('status-text');
      const running = st ? !/閒置/.test(st.textContent) : false;
      if (wasRunning === true && !running) refreshAll(true);
      wasRunning = running;
    } catch {}
  }, 5000);

  // 啟動
  refreshAll(true);
  setInterval(() => refreshAll(true), 30000);
})();

