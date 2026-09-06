'use strict';

/**
 * server 後處理: run 完成後, 將已下載 RCL 檔案 → PDF parse / DOM → XLS 同步
 * 唔直接掂 express; executeRun 喺 automation 完結後呼叫
 */

const { parseRclPdf } = require('./rcl/parse-pdf');
const { extractFromDetailText, domQualityOk } = require('./rcl/extract-text');
const { syncFromRecords } = require('./xls/sync');

/** PDF record 要有 11 位 mawb 先叫「可用」(header-only 補唔到 Acceptance MAWB 都當無效) */
function pdfRecUsable(r) {
  return !!(r && r.mawb && String(r.mawb).length === 11);
}

/**
 * 由「PDF parse 結果 + DOM 詳細頁 + 下載項」合成 XLS 同步 records。
 * PDF 有可用 record → 以 PDF 為主 (DOM 淨係補空白欄位);
 * PDF 冇可用 record (parse 失敗 / 條條都無 MAWB) → 先至用 DOM fallback。
 * 唔會因為 PDF parse「有嘢返」但條條都唔啱用而漏咗成個 item。
 */
function mergePdfDomRecords(recs, dom, it) {
  const itemType = String((it && it.type) || '').toUpperCase().trim() || 'P';
  const baseLih = it && it.lih ? String(it.lih).toUpperCase() : '';
  const usable = (Array.isArray(recs) ? recs : []).filter(pdfRecUsable);
  const out = [];
  if (usable.length) {
    for (const r of usable) {
      out.push({
        mawb: r.mawb,
        type: itemType,
        lih: baseLih || r.lih,
        dest: r.dest || (dom && dom.dest) || '',
        pcs: r.pcs !== null && r.pcs !== undefined ? r.pcs : (dom && dom.pcs) || null,
        wt: r.wt !== null && r.wt !== undefined ? r.wt : (dom && dom.wt) || null,
        cbm: dom && dom.cbm ? dom.cbm : null,
        uld: r.uld || (dom && dom.uld) || (it && it.uld) || '',
        contour: dom && dom.contour ? dom.contour : '',
        tare: r.tare !== null && r.tare !== undefined ? r.tare : (dom && dom.tare) || null,
        accepted: true,
        source: 'pdf' + (domQualityOk(dom) ? '+dom' : ''),
      });
    }
    return out;
  }
  if (domQualityOk(dom)) {
    out.push({
      mawb: dom.mawb || (it && it.mawb),
      type: itemType,
      lih: baseLih || dom.lih || '',
      dest: dom.dest || '',
      pcs: dom.pcs || null,
      wt: dom.wt || null,
      cbm: dom.cbm || null,
      uld: dom.uld || (it && it.uld) || '',
      contour: dom.contour || '',
      tare: dom.tare || null,
      accepted: true,
      source: 'dom',
    });
  }
  return out;
}

/** 將 results.downloaded 每項轉成 XLS 同步用 records */
async function recordsFromDownloads(downloaded, log) {
  const records = [];
  for (const it of Array.isArray(downloaded) ? downloaded : []) {
    if (!it || !it.file) continue;
    let dom = null;
    if (it.domText) dom = extractFromDetailText(it.domText);
    let recs = [];
    try {
      recs = await parseRclPdf(it.file, log);
    } catch (e) {
      if (log) log(`RCL PDF parse 失敗 (${it.file}): ${e.message}`, 'warn');
    }
    const merged = mergePdfDomRecords(recs, dom, it);
    if (merged.length) records.push(...merged);
    else if (log) log(`⚠ 抽唔到 RCL 數值: ${it.mawb || it.uld || it.file}`, 'warn');
  }
  return records;
}

/** run 完成後: 同步 XLS (有開先做) */
async function syncRunToXls(cfg, result, log) {
  const xs = cfg.xlsSync;
  if (!xs || !xs.enabled) return { skipped: true };
  if (!xs.file) {
    if (log) log('XLS 同步未設定檔案路徑 → 跳過', 'warn');
    return { skipped: true, reason: 'no-file' };
  }
  const records = await recordsFromDownloads(result && result.downloaded, log);
  if (log) log(`XLS 同步候選 records: ${records.length} 筆`);
  const out = await syncFromRecords({ file: xs.file, sheet: xs.sheet || undefined, records, log });
  return out;
}

module.exports = { syncRunToXls, recordsFromDownloads, mergePdfDomRecords, pdfRecUsable };
