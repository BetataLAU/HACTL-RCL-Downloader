'use strict';

/**
 * RCL PDF 解析 (pdfjs) — fallback 來源 (主要來源係 COSAC 詳細頁 DOM)
 *
 * 結構 (實測 2026-08 樣本):
 *   Acceptance Information 區: ULD / ULD Port / Pieces / Tare Weight(KG) / LIH 等 label→value
 *   AWB Information 表: 每行 = SEQ AWB Port Pieces ... Provisional WT RCL No. ...
 * 用「label 之後、下一個文字 label 之前」嘅數值配對, 抽 DEST/PCS/WT/ULD/TARE 等
 */

const fs = require('fs');
const path = require('path');

/* ---------- pdfjs 載入 (lazy) ---------- */
let pdfjsPromise = null;
function getPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then((m) => m.default || m);
  return pdfjsPromise;
}

/* pdf.js 喺 Node 會用 fs.readFile 讀 standardFontDataUrl/cMapUrl 個 base 路徑。
   呢啲 HACTL RCL PDF 用標準 14 字型 (冇 embedded), 唔供應就會出
   "UnknownErrorException: Ensure that the `standardFontDataUrl` API parameter is provided." */
const PDFJS_ROOT = path.join(__dirname, '..', '..', 'node_modules', 'pdfjs-dist');
const STANDARD_FONTS_DIR = path.join(PDFJS_ROOT, 'standard_fonts') + path.sep;
const CMAPS_DIR = path.join(PDFJS_ROOT, 'cmaps') + path.sep;

/* ---------- 版面文字 → 行 ---------- */

function pageLines(page) {
  return page.getTextContent().then((tc) => {
    const items = (tc.items || []).filter((i) => i.str && i.str.trim());
    const map = new Map();
    for (const it of items) {
      const s = (it.str || '').replace(/\u00a0/g, ' ');
      if (!s.trim()) continue;
      const y = Math.round(it.transform[5] / 4);
      const x = Math.round(it.transform[4]);
      if (!map.has(y)) map.set(y, []);
      map.get(y).push({ x, s });
    }
    const out = [];
    for (const y of Array.from(map.keys()).sort((a, b) => b - a)) {
      out.push({ y, tokens: map.get(y).sort((a, b) => a.x - b.x) });
    }
    return out;
  });
}

/* ---------- 數值讀取工具 ---------- */

function asNum(s) {
  const n = Number(String(s).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

/** 喺 tokens 度揾 label, 返 label 之後第一個數字 (下一個文字 label 前) */
function numAfterLabel(tokens, labelRe) {
  const idx = tokens.findIndex((t) => labelRe.test(t.s));
  if (idx < 0) return null;
  for (let i = idx + 1; i < tokens.length; i++) {
    if (/^[A-Za-z][A-Za-z ./().]{2,}$/.test(tokens[i].s)) break; // 見下一個 label 就停
    const n = asNum(tokens[i].s);
    if (n !== null) return n;
  }
  return null;
}

/** 揾 ULD# (PMC/AKE/PAG...)。有時 PDF 會將 SEQ + ULD 合併做一個 token (例: '1 PMC75274QR'),
 *  唔可以淨係成段 match, 要喺 token 內搵 substring。 */
function findUld(tokens) {
  const ULD_CODE_RE = /\b(PMC|PAG|PAP|PGA|PAX|AKE|AKN|PAB|DQF|PRA|RKN|AMF|AAU)\d{3,6}[A-Z]{0,2}\b/i;
  for (const t of tokens) {
    const m = String(t.s || '').match(ULD_CODE_RE);
    if (m) return m[0].toUpperCase();
  }
  return null;
}


/* ---------- AWB 資料行 parsing ---------- */

const MAWB_RE = /^(\d{3})-?(\d{8})$/;
const DEST_RE = /^[A-Z]{3}$/;
const RCLNO_RE = /^R[A-Z]{2}\d{1,3}-\d+$/i;

/** 在一行 tokens 揾 MAWB。支援拆成兩個 token (例: "157-" + "53933891")。
 *  @returns {{ i:number, skip:number, mawb:string } | null}
 */
function findMawbToken(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (MAWB_RE.test(t.s)) return { i, skip: 1, mawb: t.s.replace(/\D/g, '') };
    if (i + 1 < tokens.length) {
      const joined = (String(t.s) + String(tokens[i + 1].s)).replace(/\s/g, '');
      if (MAWB_RE.test(joined)) return { i, skip: 2, mawb: joined.replace(/\D/g, '') };
    }
  }
  return null;
}

/** 從一行 tokens 抽出一個 AWB record (冇就 null) */
function parseAwbRow(tokens) {
  const hit = findMawbToken(tokens);
  if (!hit) return null;
  const rec = { mawb: hit.mawb, dest: '', pcs: null, wt: null, lih: '' };
  const rest = tokens.slice(hit.i + hit.skip);
  const destT = rest.find((t) => DEST_RE.test(t.s));
  if (destT) rec.dest = destT.s;
  const destIdx = destT ? rest.indexOf(destT) : -1;
  const body = destIdx >= 0 ? rest.slice(destIdx + 1) : rest;
  const ints = [];
  const decimals = [];
  for (const t of body) {
    if (RCLNO_RE.test(t.s)) break;
    if (t.s === 'Y' || t.s === 'N') { if (!rec.lih) rec.lih = t.s; continue; }
    if (/^\d+\.\d+$/.test(t.s)) { const n = asNum(t.s); if (n !== null && n > 0) decimals.push(n); continue; }
    if (/^\d+$/.test(t.s)) { const n = asNum(t.s); if (n !== null) ints.push(n); }
  }
  if (ints.length) rec.pcs = ints[0];
  if (decimals.length) rec.wt = Math.max.apply(null, decimals);
  else if (ints.length > 1) rec.wt = ints[ints.length - 1];
  return rec;
}

/** 全頁 AWB records (header 'AWB Information' 之後嘅行; header 分拆做幾個 token 都得) */
function collectAwbRecords(lines) {
  const start = lines.findIndex((ln) => {
    if (ln.tokens.some((t) => /AWB Information/i.test(t.s))) return true;
    return /AWB\s+Information/i.test(ln.tokens.map((t) => t.s).join(' '));
  });
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const rec = parseAwbRow(lines[i].tokens);
    if (rec) out.push(rec);
  }
  return out;
}

/* ---------- 冇 AWB table 版面 (淨係 ULD Information) 嘅輔助 ---------- */

/** 喺版面文字搵 Acceptance 區嘅 MAWB (例: token '157-53933950', 或 '157-' + '53933950' 拆開) */
function acceptanceMawbOf(lines) {
  for (const ln of lines) {
    const toks = ln.tokens || [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (MAWB_RE.test(t.s)) return t.s.replace(/\D/g, '');
      if (i + 1 < toks.length) {
        const joined = (String(t.s) + String(toks[i + 1].s)).replace(/\s/g, '');
        if (MAWB_RE.test(joined)) return joined.replace(/\D/g, '');
      }
    }
  }
  return '';
}

/** 冇 AWB Information table 嘅版頁 → header-only record (mawb 由 Acceptance 區補返) */
function makeHeaderOnlyRecord(lines, pageUld, tare, cbm) {
  return {
    mawb: acceptanceMawbOf(lines),
    dest: '',
    pcs: null,
    wt: null,
    lih: '',
    uld: pageUld || '',
    tare,
    cbm,
    source: 'pdf-header-only',
  };
}

/* ---------- 主入口 ---------- */

/** 由 RCL PDF 抽出 records[]; 每項 { mawb, dest, pcs, wt, lih, uld?, tare?, cbm? } */
async function parseRclPdf(file, log) {
  if (!fs.existsSync(file)) throw new Error('RCL PDF 唔存在: ' + file);
  const pdfjs = await getPdfjs();
  const doc = await pdfjs
    .getDocument({
      data: new Uint8Array(fs.readFileSync(file)),
      standardFontDataUrl: STANDARD_FONTS_DIR,
      cMapUrl: CMAPS_DIR,
      cMapPacked: true,
    })
    .promise;
  const records = [];
  let textTokenCount = 0;
  let hasAwdHeader = false;
  let hasUld = false;
  const lineSamples = [];
  try {
    /* 第一輪: 讀晒每頁 lines (pagesInfo), 順便搵成份文件第一個 ULD#, 咁就算 AWB 行
       喺 ULD 出現之前嘅版頁, records 都可以填返 ULD */
    const pagesInfo = [];
    let docUld = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const lines = await pageLines(page);
      const allTokens = lines.flatMap((ln) => ln.tokens);
      pagesInfo.push({ lines });
      textTokenCount += allTokens.length;
      const pageUld = findUld(allTokens);
      hasUld = hasUld || !!pageUld;
      if (pageUld && !docUld) docUld = pageUld;
      hasAwdHeader = hasAwdHeader || lines.some((ln) => {
        if (ln.tokens.some((t) => /AWB Information/i.test(t.s))) return true;
        return /AWB\s+Information/i.test(ln.tokens.map((t) => t.s).join(' '));
      });
      if (lineSamples.length < 3 && allTokens.length) {
        const txt = lines
          .slice(0, 4)
          .map((ln) => ln.tokens.map((t) => t.s).join(' '))
          .join(' │ ');
        if (txt) lineSamples.push(`第 ${i} 頁: ${txt.slice(0, 180)}`);
      }
    }
    /* 第二輪: 逐頁抽 record (每頁用返自己嗰頁嘅 ULD; 冇就 fallback 成份文件第一個) */
    for (const { lines } of pagesInfo) {
      const allTokens = lines.flatMap((ln) => ln.tokens);
      const pageUld = findUld(allTokens) || docUld || '';
      const tareLine = lines.find((ln) => ln.tokens.some((t) => /^Tare Weight\(KG\)$/i.test(t.s)));
      const tare = tareLine ? numAfterLabel(tareLine.tokens, /^Tare Weight\(KG\)$/i) : null;
      const cbmLine = lines.find((ln) => ln.tokens.some((t) => /^CBM$/i.test(t.s)));
      const cbm = cbmLine ? numAfterLabel(cbmLine.tokens, /^CBM$/i) : null;

      const rows = collectAwbRecords(lines);
      for (const r of rows) {
        if (!r.mawb || r.mawb.length !== 11) continue;
        records.push({ ...r, uld: pageUld, tare, cbm, source: 'pdf' });
      }
      // 冇 AWB table (例如得 ULD Information 一段) → 以 Acceptance 區嘅 MAWB + ULD 記一筆,
      // 等 XLS 同步唔會因為 PDF 條 record 冇 MAWB 而漏咗成個 item
      if (!rows.length && pageUld) {
        records.push(makeHeaderOnlyRecord(lines, pageUld, tare, cbm));
      }
    }
  } finally {
    try { await doc.destroy(); } catch { /* ignore */ }
  }
  if (log && typeof log === 'function') {
    log(`RCL PDF parse: ${file} → ${records.length} 個 AWB record`);
    if (records.length === 0 && textTokenCount === 0) {
      log('⚠ RCL PDF 冇文字層 (可能係掃描圖/影像 PDF), 已改用 DOM 詳細頁資料 fallback', 'warn');
    } else if (records.length === 0) {
      log(`⚠ RCL PDF parse 0 筆但 PDF 有文字 (${textTokenCount} tokens, AWB header=${hasAwdHeader}, ULD=${hasUld})`, 'warn');
      for (const s of lineSamples) log(`  ${s}`);
    }
  }
  return records;
}

module.exports = { parseRclPdf, parseAwbRow, collectAwbRecords, pageLines, numAfterLabel, findUld, acceptanceMawbOf, makeHeaderOnlyRecord, MAWB_RE, DEST_RE, RCLNO_RE };
