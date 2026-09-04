'use strict';

/**
 * 📂 已下載檔案管理員 UI
 *   P0: 位址列 + 每行操作 (預覽/下載/系統開啟/顯示位置/複製路徑)
 *   P1: 頁內預覽 Drawer + Quick Look 懸停縮圖 (pdf.js)
 *   P2: 即時搜尋 + Command Palette + 批次多選 + 新檔 Toast + 分組
 *
 * 檔案喺 server (主機) 嗰部機。UI 自動偵測「viewer 係咪本機」,
 * 唔係本機就唔顯示「喺 OS 開」動作, 只留 預覽 / 下載 / 複製路徑。
 * app.js 嘅舊 refreshDownloads() 已改為 dispatch 'dl-refresh-requested',
 * 呢個檔案收事件並以完整 UI 重新整理。
 */
(() => {
  const $ = (id) => document.getElementById(id);

  const meta = { platform: 'win32', hostname: '', dir: '', defaultDir: '', viewerIsLocal: true };
  let files = [];
  let newNames = new Set();     // 今次新增, 顯示「新」badge
  let prevNames = null;         // 首次載入全部當已存在, 避免 toast 洗版
  let selected = new Set();     // 批次多選 (儲檔名)
  let currentPreview = null;    // Drawer 而家預覽緊嘅檔名
  let thumbsOk = true;          // pdf.js 載入失敗後唔再試 hover 縮圖
  const thumbCache = new Map(); // name -> Promise<dataURL>
  let hoverTimer = null;
  let hoverRow = null;
  let paletteActive = 0;

  function fileUrl(name, dl) {
    return '/api/file?name=' + encodeURIComponent(name) + (dl ? '&dl=1' : '');
  }

  function apiPost(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      return j;
    });
  }

  function fmtSize(b) {
    if (b >= 1048576) return (b / 1048576).toFixed(2) + ' MB';
    if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
    return b + ' B';
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    const now = new Date();
    const hm = d.toLocaleTimeString('zh-HK', { hour12: false, hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return '今日 ' + hm;
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return '昨日 ' + hm;
    return d.toLocaleString('zh-HK', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' }) + ' ' + hm;
  }

  function groupKey(mtime) {
    const d = new Date(mtime);
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (d >= startToday) return '今日';
    if (d >= new Date(startToday.getTime() - 6 * 86400000)) return '今週';
    return '較早';
  }

  function platformEmoji() {
    if (meta.platform === 'darwin') return '🍎 macOS';
    if (meta.platform === 'win32') return '🪟 Windows';
    if (meta.platform === 'linux') return '🐧 Linux';
    return '🖥️ ' + meta.platform;
  }

  function renderMeta() {
    $('dl-platform').textContent = platformEmoji() + ' · ' + meta.hostname;
    const mode = $('dl-mode');
    if (meta.viewerIsLocal) {
      mode.textContent = '🔒 本機';
      mode.className = 'chip ok';
    } else {
      mode.textContent = '📡 遠端檢視 (檔案喺主機)';
      mode.className = 'chip bad';
    }
    document.querySelectorAll('.local-only').forEach((el) => el.classList.toggle('hidden', !meta.viewerIsLocal));
    const dir = $('dl-dir');
    dir.textContent = meta.dir || '(未設定儲存資料夾)';
    dir.title = '按一下複製路徑 · 檔案主機: ' + meta.hostname;
    const sd = $('s-saveDir');
    if (!sd.value && meta.defaultDir) sd.placeholder = '預設: ' + meta.defaultDir;
  }

  async function refreshDownloads(announceNew) {
    let added = [];
    try {
      const r = await fetch('/api/downloads');
      const d = await r.json();
      meta.platform = d.platform || meta.platform;
      meta.hostname = d.hostname || meta.hostname;
      meta.dir = d.dir || meta.dir;
      meta.defaultDir = d.defaultDir || meta.defaultDir;
      meta.viewerIsLocal = d.viewerIsLocal !== false;
      files = Array.isArray(d.files) ? d.files : [];

      if (!prevNames) prevNames = new Set();
      if (announceNew) added = files.filter((f) => !prevNames.has(f.name));
      for (const f of files) prevNames.add(f.name);

      if (announceNew && added.length) added.forEach((f) => newNames.add(f.name));

      const alive = new Set(files.map((f) => f.name));
      for (const n of Array.from(selected)) if (!alive.has(n)) selected.delete(n);

      renderMeta();
      renderRows();

      if (announceNew && added.length) {
        added.forEach((f) => showNewFileToast(f.name));
        setTimeout(() => {
          newNames.clear();
          hideNewBadges();
        }, 15000);
      }
    } catch (e) {
      /* ignore */
    }
    return added;
  }

  function hideNewBadges() {
    document.querySelectorAll('#dl-body .dl-new').forEach((el) => el.classList.add('hidden'));
  }

  /* ---------- 表格 render ---------- */

  function updateCount(shown, hint) {
    $('dl-count').textContent = '顯示 ' + shown + ' / ' + files.length + (hint ? ' · ' + hint : '');
  }

  function updateBatchBar() {
    const n = selected.size;
    $('dl-batch').classList.toggle('hidden', n === 0);
    $('dl-batch-n').textContent = String(n);
  }

  function updateCheckAll() {
    const boxes = Array.from(document.querySelectorAll('#dl-body .dl-chk'));
    const all = $('dl-check-all');
    if (!boxes.length) { all.checked = false; all.indeterminate = false; return; }
    const on = boxes.filter((b) => b.checked).length;
    all.checked = on === boxes.length;
    all.indeterminate = on > 0 && on < boxes.length;
  }

  function groupRow(label) {
    const tr = document.createElement('tr');
    tr.className = 'dl-group';
    const td = document.createElement('td');
    td.colSpan = 5;
    td.textContent = label;
    tr.appendChild(td);
    return tr;
  }

  /* ---------- elastic 式本地智慧搜尋 ---------- */

  // 統一格式: 去除所有分隔符同大小寫影響, 淨保留字母數字同中文字
  function norm(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
  }

  // 將檔名變成「淨 alnum 骨架」+ 每個字元喺原檔名嘅位置 (highlight 跨空格/橫線都用得)
  function buildSkeleton(name) {
    const chars = [];
    const pos = [];
    const lower = String(name || '').toLowerCase();
    for (let i = 0; i < lower.length; i++) {
      const c = lower[i];
      if (/[a-z0-9\u4e00-\u9fff]/.test(c)) {
        chars.push(c);
        pos.push(i);
      }
    }
    return { sk: chars.join(''), pos };
  }

  // 喺骨架度搵 query 每個字嘅命中範圍, 再映射返去原檔名位置 (highlight 用)
  function locateRanges(rawTokens, sk) {
    const ranges = [];
    for (const raw of rawTokens) {
      const tok = norm(raw);
      if (!tok) continue;
      let from = 0;
      while (true) {
        const i = sk.sk.indexOf(tok, from);
        if (i < 0) break;
        ranges.push([sk.pos[i], sk.pos[i + tok.length - 1] + 1]);
        from = i + tok.length;
      }
    }
    if (!ranges.length) return [];
    ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) {
        if (r[1] > last[1]) last[1] = r[1];
      } else merged.push([r[0], r[1]]);
    }
    return merged;
  }

  /**
   * elastic 比對: 唔符合 → null; 符合 → { score, ranges }
   * - 自動忽略空格/橫線/大小寫; 任何連續片段都算命中
   * - 多個字 (如「5371 1873」) 全部命中先算; 維持原次序 + 命中位越前 → 分越高
   */
  function elasticMatch(name, qRaw) {
    const rawTokens = String(qRaw || '').trim().toLowerCase().split(/\s+/);
    const tokens = rawTokens.map(norm).filter(Boolean);
    if (!tokens.length) return { all: true, score: 0, ranges: [] };
    const sk = buildSkeleton(name);
    const nname = sk.sk;
    let pos = -1;
    let ordered = true;
    for (const tok of tokens) {
      const i = nname.indexOf(tok);
      if (i < 0) return null;
      if (pos >= 0 && i < pos) ordered = false;
      pos = i;
    }
    const qnorm = tokens.join('');
    let score;
    const wholeIdx = nname.indexOf(qnorm);
    if (wholeIdx >= 0) score = 2000 - wholeIdx;
    else score = 1500 + (ordered ? 200 : 0) - tokens.length * 40;
    return { all: false, score, ranges: locateRanges(rawTokens, sk) };
  }
  function renderRows() {
    const tb = $('dl-body');
    tb.innerHTML = '';
    const qRaw = ($('dl-filter').value || '').trim();
    const sortMode = $('dl-sort').value;

    // 每個檔案計分; null = 唔符合 query
    const scored = [];
    for (const f of files) {
      const m = elasticMatch(f.name, qRaw);
      if (m === null) continue;
      scored.push({ f, m });
    }

    if (sortMode === 'name') {
      scored.sort((a, b) => a.f.name.localeCompare(b.f.name, 'zh-Hant-u-co-phonebk'));
    } else if (sortMode === 'groups') {
      scored.sort((a, b) => new Date(b.f.mtime) - new Date(a.f.mtime));
    } else if (qRaw) {
      // 有搜尋字時: 相關度優先, 再按時間
      scored.sort((a, b) => (b.m.score - a.m.score) || (new Date(b.f.mtime) - new Date(a.f.mtime)));
    } else {
      scored.sort((a, b) => new Date(b.f.mtime) - new Date(a.f.mtime));
    }

    if (!scored.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.className = 'dl-empty';
      td.textContent = !files.length ? '(尚未有 RCL 檔案 — 執行一次下載就會出現喺度)' : '(冇符合搜尋嘅檔案 — 試吓淨打 MAWB 數字, 唔使理空格/橫線)';
      tr.appendChild(td);
      tb.appendChild(tr);
    } else if (sortMode === 'groups') {
      for (const key of ['今日', '今週', '較早']) {
        const sub = scored.filter((s) => groupKey(s.f.mtime) === key);
        if (sub.length) {
          tb.appendChild(groupRow(key + ' · ' + sub.length + ' 份'));
          sub.forEach((s) => tb.appendChild(fileRow(s.f, s.m.ranges)));
        }
      }
    } else {
      scored.forEach((s) => tb.appendChild(fileRow(s.f, s.m.ranges)));
    }
    updateCount(scored.length, (qRaw && sortMode === 'time') ? '相關度排序' : null);
    updateBatchBar();
    updateCheckAll();
  }

  function actionBtn(text, title, fn, extra) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dl-act' + (extra ? ' ' + extra : '');
    b.textContent = text;
    b.title = title;
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    return b;
  }

  function fileRow(f, ranges) {
    const tr = document.createElement('tr');
    tr.className = 'dl-row' + (newNames.has(f.name) ? ' row-new' : '');
    tr.dataset.name = f.name;
    tr.title = '雙擊 = 頁內預覽';

    const tdCheck = document.createElement('td');
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.className = 'dl-chk';
    chk.checked = selected.has(f.name);
    chk.title = '多選 (批次動作)';
    chk.addEventListener('change', () => {
      if (chk.checked) selected.add(f.name); else selected.delete(f.name);
      updateBatchBar();
      updateCheckAll();
    });
    tdCheck.appendChild(chk);

    const tdName = document.createElement('td');
    const nm = document.createElement('span');
    nm.className = 'dl-name';
    if (ranges && ranges.length) {
      let last = 0;
      for (const r of ranges) {
        const s = r[0];
        const e = r[1];
        if (s > last) nm.appendChild(document.createTextNode(f.name.slice(last, s)));
        const mark = document.createElement('mark');
        mark.className = 'dl-hl';
        mark.textContent = f.name.slice(s, e);
        nm.appendChild(mark);
        last = e;
      }
      if (last < f.name.length) nm.appendChild(document.createTextNode(f.name.slice(last)));
    } else {
      nm.textContent = f.name;
    }
    tdName.appendChild(nm);
    if (newNames.has(f.name)) {
      const b = document.createElement('span');
      b.className = 'chip ok dl-new';
      b.textContent = '新';
      tdName.appendChild(b);
    }

    const tdSize = document.createElement('td');
    tdSize.textContent = fmtSize(f.size);

    const tdTime = document.createElement('td');
    tdTime.textContent = fmtTime(f.mtime);

    const tdAct = document.createElement('td');
    tdAct.appendChild(actionBtn('🔍', '頁內預覽', () => openPreview(f.name)));
    tdAct.appendChild(actionBtn('⬇', '下載到本機', () => downloadFile(f.name)));
    if (meta.viewerIsLocal) {
      tdAct.appendChild(actionBtn('🖥️', '用系統預設程式開啟 (主機)', () => osOpenFile(f.name)));
      tdAct.appendChild(actionBtn('📂', '喺檔案管理員顯示', () => osRevealFile(f.name)));
    }
    tdAct.appendChild(actionBtn('⧉', '複製完整路徑', () => copyPath(f.name)));

    tr.appendChild(tdCheck);
    tr.appendChild(tdName);
    tr.appendChild(tdSize);
    tr.appendChild(tdTime);
    tr.appendChild(tdAct);

    tr.addEventListener('dblclick', () => openPreview(f.name));
    tr.addEventListener('mouseenter', () => scheduleQuickLook(tr, f));
    tr.addEventListener('mouseleave', () => cancelQuickLook());
    return tr;
  }

  /* ---------- 檔案動作 ---------- */

  function restartHint(msg) {
    return String(msg || '').includes('404') ? ' — 好似 server 仲行緊舊版本, 請關閉黑色視窗再重開 start.bat / npm start' : '';
  }

  function osOpenFolder() {
    apiPost('/api/open-folder')
      .then((r) => {
        if (r && r.ok) {
          const base = (meta.dir || '').split(/[\\/]/).filter(Boolean).pop() || '資料夾';
          toast('已喺系統檔案管理員開啟 (見唔到? 睇下工作列有冇「' + base + '」)', 'info', null, 8000);
        }
        else toast('❌ 開啟失敗: ' + ((r && r.error) || '未知錯誤'), 'error');
      })
      .catch((e) => toast('❌ ' + e.message + restartHint(e.message), 'error'));
  }

  function osOpenFile(name) {
    apiPost('/api/open-file', { name })
      .then((r) => {
        if (r && r.ok) toast('已交畀系統開啟: ' + name, 'info');
        else toast('❌ 開啟失敗: ' + ((r && r.error) || '未知錯誤'), 'error');
      })
      .catch((e) => toast('❌ ' + e.message + restartHint(e.message), 'error'));
  }

  function osRevealFile(name) {
    apiPost('/api/reveal-file', { name })
      .then((r) => {
        if (r && r.ok) toast('已喺檔案管理員選取: ' + name, 'info');
        else toast('❌ 顯示失敗: ' + ((r && r.error) || '未知錯誤'), 'error');
      })
      .catch((e) => toast('❌ ' + e.message + restartHint(e.message), 'error'));
  }
  function joinDir(name) {
    const sep = meta.platform === 'win32' ? '\\' : '/';
    return meta.dir + sep + name;
  }

  function flashCopy() {
    const c = $('dl-dircopy');
    c.classList.remove('hidden');
    clearTimeout(flashCopy._t);
    flashCopy._t = setTimeout(() => c.classList.add('hidden'), 1600);
  }

  function copyTextFallback(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
  }

  function copyDir() {
    const text = meta.dir || '';
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(flashCopy, () => { copyTextFallback(text); flashCopy(); });
    } else { copyTextFallback(text); flashCopy(); }
  }

  function copyPath(name) {
    const text = joinDir(name);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(flashCopy, () => { copyTextFallback(text); flashCopy(); });
    } else { copyTextFallback(text); flashCopy(); }
  }

  /* ---------- 頁內預覽 Drawer (唔離開頁面) ---------- */

  function openPreview(name) {
    currentPreview = name;
    $('dl-drawer-name').textContent = name;
    $('dl-drawer-name').title = name;
    $('dl-drawer-frame').src = fileUrl(name, false);
    $('dl-drawer').classList.add('open');
    document.body.classList.add('noscroll');
  }

  function closePreview() {
    currentPreview = null;
    $('dl-drawer').classList.remove('open');
    document.body.classList.remove('noscroll');
    setTimeout(() => { $('dl-drawer-frame').src = 'about:blank'; }, 350);
  }

  /* ---------- Quick Look: hover 顯示 PDF 第一頁縮圖 (pdf.js) ---------- */

  let pdfjsPromise = null;
  function loadPdfJs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import('/vendor/pdfjs/pdf.min.mjs')
        .then((m) => {
          m.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
          return m;
        })
        .catch(() => null);
    }
    return pdfjsPromise;
  }

  async function makeThumb(name) {
    const pdfjs = await loadPdfJs();
    if (!pdfjs) return null;
    const resp = await fetch(fileUrl(name, false));
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.arrayBuffer();
    const doc = await pdfjs.getDocument({ data }).promise;
    try {
      const page = await doc.getPage(1);
      const vp1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: 330 / vp1.width });
      const canvas = document.createElement('canvas');
      canvas.width = vp.width;
      canvas.height = vp.height;
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      return canvas.toDataURL('image/jpeg', 0.72);
    } finally {
      try { await doc.destroy(); } catch (e) {}
    }
  }

  function getThumb(name) {
    if (!thumbCache.has(name)) {
      thumbCache.set(
        name,
        makeThumb(name)
          .then((url) => {
            if (!url) thumbsOk = false;
            return url;
          })
          .catch(() => {
            thumbsOk = false;
            return null;
          })
      );
    }
    return thumbCache.get(name);
  }



  /* ---------- Quick Look 縮圖位置 ---------- */

  function showQuickLook(tr, f) {
    const ql = $('dl-quicklook');
    const img = $('dl-quicklook-img');
    const tip = $('dl-quicklook-tip');
    ql.classList.remove('hidden');
    img.style.display = 'none';
    tip.style.display = '';
    tip.textContent = '載入縮圖…';
    getThumb(f.name).then((url) => {
      if (!hoverRow || hoverRow !== tr) return;
      if (!url) { ql.classList.add('hidden'); return; }
      img.src = url;
      img.style.display = '';
      tip.style.display = 'none';
    });
    const rect = tr.getBoundingClientRect();
    const qw = 350;
    const qh = 280;
    let top = rect.top - qh - 6;
    if (top < 8) top = rect.bottom + 6;
    let left = rect.left;
    if (left + qw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - qw - 8);
    ql.style.left = left + 'px';
    ql.style.top = Math.max(8, top) + 'px';
  }

  function cancelQuickLook() {
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
    hoverRow = null;
    $('dl-quicklook').classList.add('hidden');
  }

  function scheduleQuickLook(tr, f) {
    cancelQuickLook();
    if (!thumbsOk) return;
    hoverRow = tr;
    hoverTimer = setTimeout(() => {
      if (!hoverRow || hoverRow !== tr || document.hidden) return;
      showQuickLook(tr, f);
    }, 450);
  }

  /* ---------- Toast 通知 ---------- */

  function toast(text, type, buttons, ms) {
    const box = $('toasts');
    const el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    const close = () => el.remove();
    const span = document.createElement('span');
    span.textContent = text;
    el.appendChild(span);
    (buttons || []).forEach((b) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = b.label;
      btn.addEventListener('click', () => { close(); b.fn(); });
      el.appendChild(btn);
    });
    box.appendChild(el);
    setTimeout(close, ms || 6000);
    return el;
  }

  function showNewFileToast(name) {
    toast('✅ 新下載: ' + name, 'success', [
      { label: '🔍 預覽', fn: () => openPreview(name) },
      { label: '⬇ 下載', fn: () => downloadFile(name) },
    ], 9000);
  }

  /* ---------- 批次動作 ---------- */

  function selectedNames() {
    return files.map((f) => f.name).filter((n) => selected.has(n));
  }

  function batchDownload() {
    const names = selectedNames();
    if (!names.length) return;
    names.forEach((n, i) => setTimeout(() => downloadFile(n), i * 250));
    toast('已送出 ' + names.length + ' 個下載', 'info', null, 4000);
  }

  function batchPreview() {
    const names = selectedNames();
    if (names.length) openPreview(names[0]);
  }

  function toggleAll(checked) {
    const rows = Array.from(document.querySelectorAll('#dl-body tr.dl-row'));
    rows.forEach((tr) => {
      const name = tr.dataset.name;
      const chk = tr.querySelector('.dl-chk');
      if (chk) chk.checked = checked;
      if (checked) selected.add(name); else selected.delete(name);
    });
    updateBatchBar();
    updateCheckAll();
  }

  /* ---------- Command Palette ---------- */

  function openPalette() {
    $('palette').classList.remove('hidden');
    $('palette-input').value = '';
    renderPalette('');
    $('palette-input').focus();
  }

  function closePalette() {
    $('palette').classList.add('hidden');
  }

  function renderPalette(rawKw) {
    const k = String(rawKw || '').trim().toLowerCase();
    const list = $('palette-list');
    list.innerHTML = '';
    const matches = files
      .map((x) => ({ f: x, m: elasticMatch(x.name, k) }))
      .filter((x) => x.m !== null);
    if (k) matches.sort((a, b) => (b.m.score - a.m.score) || a.f.name.localeCompare(b.f.name, 'zh-Hant-u-co-phonebk'));
    const res = matches.slice(0, 12).map((x) => x.f);
    paletteActive = 0;
    if (!res.length) {
      const empty = document.createElement('div');
      empty.className = 'palette-empty';
      empty.textContent = '(冇結果)';
      list.appendChild(empty);
      return;
    }
    res.forEach((f, i) => {
      const item = document.createElement('div');
      item.className = 'palette-item' + (i === 0 ? ' active' : '');
      item.dataset.name = f.name;
      item.textContent = f.name;
      list.appendChild(item);
    });
  }

  function movePalette(delta) {
    const items = Array.from(document.querySelectorAll('#palette-list .palette-item'));
    if (!items.length) return;
    paletteActive = (paletteActive + delta + items.length) % items.length;
    items.forEach((it, i) => it.classList.toggle('active', i === paletteActive));
  }

  function activatePalette() {
    const item = document.querySelector('#palette-list .palette-item.active');
    if (item) {
      const name = item.dataset.name;
      closePalette();
      openPreview(name);
    }
  }

  /* ---------- 鍵盤 ---------- */

  function typingTarget(e) {
    const t = e.target;
    if (!t) return false;
    const tag = t.tagName || '';
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
  }

  function globalKeys(e) {
    const palOpen = !$('palette').classList.contains('hidden');
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (palOpen) closePalette(); else openPalette();
      return;
    }
    if (palOpen) {
      if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); movePalette(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); movePalette(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); activatePalette(); }
      return;
    }
    if (e.key === 'Escape') {
      if ($('dl-drawer').classList.contains('open')) { closePreview(); return; }
      cancelQuickLook();
      return;
    }
    if (!typingTarget(e) && e.key === '/') {
      e.preventDefault();
      openPalette();
    }
  }

  /* ---------- 初始化 ---------- */

  function bind() {
    $('btn-dl-folder').addEventListener('click', osOpenFolder);
    $('btn-dl-refresh').addEventListener('click', () => refreshDownloads(true));
    $('dl-dir').addEventListener('click', copyDir);
    $('dl-filter').addEventListener('input', renderRows);
    $('dl-sort').addEventListener('change', renderRows);
    $('dl-check-all').addEventListener('change', (e) => toggleAll(e.target.checked));

    $('btn-batch-download').addEventListener('click', batchDownload);
    $('btn-batch-preview').addEventListener('click', batchPreview);
    $('btn-batch-clear').addEventListener('click', () => { selected.clear(); renderRows(); });

    $('btn-drawer-newtab').addEventListener('click', () => { if (currentPreview) window.open(fileUrl(currentPreview, false), '_blank'); });
    $('btn-drawer-download').addEventListener('click', () => { if (currentPreview) downloadFile(currentPreview); });
    $('btn-drawer-os').addEventListener('click', () => { if (currentPreview) osOpenFile(currentPreview); });
    $('btn-drawer-close').addEventListener('click', closePreview);

    $('palette-input').addEventListener('input', (e) => renderPalette(e.target.value));
    $('palette-list').addEventListener('click', (e) => {
      const it = e.target.closest('.palette-item');
      if (it) { openPreview(it.dataset.name); closePalette(); }
    });
    $('palette').addEventListener('mousedown', (e) => { if (e.target === $('palette')) closePalette(); });

    window.addEventListener('dl-refresh-requested', () => refreshDownloads(true));
    document.addEventListener('keydown', globalKeys);
  }

  bind();
  refreshDownloads(false); // 首次載入: 全部當已存在, 唔會 toast「新」
})();