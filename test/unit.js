'use strict';

/** 核心工具單元測試 (node test/unit.js; 唔需要外部服務) */

const assert = require('assert');
const { digitsOf, normUld, numValue } = require('../src/xls/helpers');
const { parseAwbRow, collectAwbRecords, makeHeaderOnlyRecord } = require('../src/rcl/parse-pdf');

let pass = 0;
function t(name, fn) {
  fn();
  pass++;
  console.log('✔ ' + name);
}

// helpers
t('digitsOf 淨返數字', () => {
  assert.strictEqual(digitsOf('157-5393 3655'), '15753933655');
  assert.strictEqual(digitsOf(15753933655), '15753933655');
  assert.strictEqual(digitsOf(''), '');
  assert.strictEqual(digitsOf(null), '');
});
t('normUld 大階去空格', () => {
  assert.strictEqual(normUld(' pmc10989qr '), 'PMC10989QR');
  assert.strictEqual(normUld(null), '');
});
t('numValue 可數值文字', () => {
  assert.strictEqual(numValue('1,211.0'), 1211);
  assert.strictEqual(numValue(''), null);
  assert.strictEqual(numValue('abc'), null);
  assert.strictEqual(numValue(0), 0);
});

// parseAwbRow: 模擬 AWB 資料行 (RCL x/y 還原後)
t('parseAwbRow 抽 mawb/dest/pcs/wt', () => {
  const toks = [
    { x: 60, s: '1' },
    { x: 71, s: '157-53711980' },
    { x: 144, s: 'STN' },
    { x: 228, s: '56' },
    { x: 275, s: '1.0' },
    { x: 359, s: '56' },
    { x: 421, s: '1211.0' },
    { x: 468, s: 'Y' },
    { x: 632, s: 'RGL2-58358' },
  ];
  const rec = parseAwbRow(toks);
  assert.strictEqual(rec.mawb, '15753711980');
  assert.strictEqual(rec.dest, 'STN');
  assert.strictEqual(rec.pcs, 56);
  assert.strictEqual(rec.wt, 1211);
  assert.strictEqual(rec.lih, 'Y');
});
t('parseAwbRow 冇 AWB 行 → null', () => {
  assert.strictEqual(parseAwbRow([{ x: 10, s: 'Hello' }]), null);
});
t('parseAwbRow 支援 MAWB 拆做兩個 token (157- / 53933891)', () => {
  const toks = [
    { x: 60, s: '2' },
    { x: 71, s: '157-' },
    { x: 80, s: '53933891' },
    { x: 144, s: 'DXB' },
    { x: 228, s: '12' },
    { x: 275, s: '345.5' },
    { x: 468, s: 'Y' },
  ];
  const rec = parseAwbRow(toks);
  assert.strictEqual(rec.mawb, '15753933891');
  assert.strictEqual(rec.dest, 'DXB');
  assert.strictEqual(rec.pcs, 12);
  assert.strictEqual(rec.wt, 345.5);
});
t('collectAwbRecords 支援 header 分拆 (AWB / Information)', () => {
  const lines = [
    { y: 900, tokens: [{ x: 20, s: 'ULD' }, { x: 60, s: 'Tare' }] },
    { y: 870, tokens: [{ x: 20, s: 'AWB' }, { x: 60, s: 'Information' }] },
    { y: 850, tokens: [{ x: 60, s: '1' }, { x: 71, s: '157-53711980' }, { x: 144, s: 'STN' }, { x: 228, s: '56' }, { x: 275, s: '1211.0' }] },
  ];
  const recs = collectAwbRecords(lines);
  assert.strictEqual(recs.length, 1);
  assert.strictEqual(recs[0].mawb, '15753711980');
});

// makeHeaderOnlyRecord: 冇 AWB Information table, 只有 Acceptance AWB + ULD Information 嘅版面
t('makeHeaderOnlyRecord 由 Acceptance 區補 MAWB (fix uld is not defined 版面)', () => {
  const lines = [
    { y: 236, tokens: [{ x: 20, s: 'Acceptance' }, { x: 60, s: 'Information' }] },
    { y: 204, tokens: [{ x: 20, s: 'AWB' }, { x: 60, s: '157-53933950' }, { x: 130, s: 'Port' }, { x: 160, s: 'STN' }] },
    { y: 112, tokens: [{ x: 20, s: 'ULD' }, { x: 60, s: 'Information' }] },
    { y: 105, tokens: [{ x: 20, s: '1' }, { x: 60, s: 'PMC75274QR' }, { x: 200, s: '1' }, { x: 250, s: '2054.0' }] },
  ];
  const rec = makeHeaderOnlyRecord(lines, 'PMC75274QR', 102, null);
  assert.strictEqual(rec.mawb, '15753933950');
  assert.strictEqual(rec.uld, 'PMC75274QR');
  assert.strictEqual(rec.tare, 102);
  assert.strictEqual(rec.source, 'pdf-header-only');
});
t('makeHeaderOnlyRecord 冇 Acceptance MAWB → mawb 留空', () => {
  const lines = [
    { y: 105, tokens: [{ x: 20, s: '1' }, { x: 60, s: 'PMC75274QR' }] },
  ];
  const rec = makeHeaderOnlyRecord(lines, 'PMC75274QR', null, null);
  assert.strictEqual(rec.mawb, '');
  assert.strictEqual(rec.uld, 'PMC75274QR');
});
t('extractFromDetailText / debugDomParse 用真實 DOM 行佈局抽 10 個 field', () => {
  const { extractFromDetailText, debugDomParse, normalizeType, parseUldBlock } = require('../src/rcl/extract-text');
  // 佈局 = 真實 snapshot: label 一行('label :')、值喺下一行; ULD 表 header/值各佔一行
  const raw = [
    'Master List 2 / 13',
    'General Information',
    'Pre-declaration No. :', '260905-00919',
    'Pre-declaration Type :', 'PREPACK',
    'Status :', 'ACCEPTED',
    'AWB :', '157-53933950',
    'Port :', 'STN',
    'Pieces :', '1',
    'LIH :', 'Y',
    'ULD Information',
    '\t', 'SEQ', '\t', 'ULD', '\t', 'ULD Type', '\t', 'CON', '\t', 'SUBCON', '\t', 'Pieces',
    '\t', 'Gross Weight(KG)', '\t', 'Tare Weight(KG)', '\t', 'Net Weight(KG)',
    '\t', 'RCL No.', '\t', 'RCL Date Time', '\t', 'H', '\t', 'O/H', '\t', '\t',
    '1', '\t', 'PMC75274QR', '\t', 'N6', '\t', 'H3', '\t', '00', '\t', '1',
    '\t', '2,054.0', '\t', '102.0', '\t', '1,952.0', '\t', 'RGJ2-47555',
    '\t', '05SEP 15:16', '\t', '63.0', '\t', '14.0/12.0',
  ].join('\n');
  const f = extractFromDetailText(raw);
  assert.strictEqual(f.mawb, '157-53933950');
  assert.strictEqual(f.type, 'P'); // PREPACK → P
  assert.strictEqual(f.dest, 'STN');
  assert.strictEqual(f.pcs, '1');
  assert.strictEqual(f.wt, '1,952.0'); // Net Weight(KG), 保留千位逗號
  assert.strictEqual(f.cbm, null);     // DOM 冇 CBM
  assert.strictEqual(f.uld, 'PMC75274QR');
  assert.strictEqual(f.contour, 'H3'); // CON 欄
  assert.strictEqual(f.tare, '102.0');
  assert.strictEqual(f.lih, 'Y');
  assert.strictEqual(parseUldBlock(raw).length, 1);
  assert.strictEqual(normalizeType('PREPACK'), 'P');
  assert.strictEqual(normalizeType('BULK'), 'B');
  assert.strictEqual(normalizeType('MIXLOAD'), 'X');
  const es = debugDomParse(raw);
  assert.strictEqual(es.length, 10);
  assert.strictEqual(es.filter((e) => e.found).length, 9); // cbm 喺 DOM 冇
  assert.ok(es.find((e) => e.field === 'dest').context.includes('STN'));
  assert.ok(es.find((e) => e.field === 'contour').context.includes('H3'));
  assert.ok(es.find((e) => e.field === 'tare').context.includes('102.0'));
});

t('require automation 入口 (runAutomation + formatAcceptDate)', () => {
  const m = require('../src/automation');
  assert.strictEqual(typeof m.runAutomation, 'function');
  assert.strictEqual(typeof m.formatAcceptDate, 'function');
});

t('decideDownloadList 決定 P/B/X 下載清單', () => {
  const { decideDownloadList } = require('../src/automation/decide');
  const ctx = {
    log: () => {},
    results: { skipped: [] },
    mawbStatus: {},
    seenMawbKeys: new Set(),
    hasUserList: false,
    userTrackSet: new Set(),
    userSkipSet: new Set(),
    includeX: true,
    saveDir: 'C:\\__no_such_dir__',
    normKey: (s) => String(s || '').replace(/\D/g, ''),
  };
  const listRows = [
    { awb: '15753933655', type: 'P', lih: 'Y', uld: '', gridIdx: 0 },
    { awb: '', type: 'X', lih: 'Y', uld: 'PMC99999QR', gridIdx: 1 },
    { awb: '15753933994', type: 'B', lih: 'N', uld: '', gridIdx: 2 },
  ];
  const out = decideDownloadList(ctx, listRows);
  assert.strictEqual(out.downloadList.length, 3);
  assert.strictEqual(out.downloadList[0].isX, false);
  assert.strictEqual(out.downloadList[1].isX, true);
  assert.strictEqual(out.downloadList[1].fname, 'PMC99999QR RCL (X).pdf');
  assert.strictEqual(out.downloadList[2].fname, '15753933994 RCL (BULK, no LIH).pdf');
  assert.ok(out.downloadList[0].fname.includes('RCL.pdf'));
});

t('mergePdfDomRecords: PDF 冇可用 MAWB → fallback DOM', () => {
  const { mergePdfDomRecords } = require('../src/xls-run');
  const dom = { mawb: '15753933950', dest: 'STN', pcs: '1', wt: '1952' };
  // 全部 PDF record 都冇 11 位 MAWB (例如 header-only 補唔到) → 一定要用 DOM, 唔可以漏 item
  const a = mergePdfDomRecords(
    [{ mawb: '', uld: 'PMC75274QR', tare: 102, source: 'pdf-header-only' }],
    dom,
    { type: 'P', uld: '' }
  );
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].source, 'dom');
  assert.strictEqual(a[0].mawb, '15753933950');
});
t('mergePdfDomRecords: PDF 有 MAWB+ULD → PDF 優先, DOM 補空白欄位', () => {
  const { mergePdfDomRecords } = require('../src/xls-run');
  const dom = { mawb: '15753933950', dest: 'STN', pcs: '1', wt: '1952', uld: 'PMC75274QR' };
  const a = mergePdfDomRecords(
    [{ mawb: '15753933950', dest: '', pcs: null, wt: null, uld: 'PMC75274QR', tare: 102 }],
    dom,
    { type: 'X', uld: '' }
  );
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].uld, 'PMC75274QR');
  assert.strictEqual(a[0].dest, 'STN'); // DOM fallback
  assert.strictEqual(a[0].pcs, '1');
  assert.strictEqual(a[0].tare, 102);   // PDF 有 tare
});
t('mergePdfDomRecords: PDF 有幾條可用 AWB 行 → 全數保留', () => {
  const { mergePdfDomRecords } = require('../src/xls-run');
  const a = mergePdfDomRecords(
    [
      { mawb: '15753933950', uld: 'PMC75274QR', dest: 'STN', pcs: 1, wt: 1952 },
      { mawb: '15753933924', uld: 'PMC75274QR', dest: 'DXB', pcs: 2, wt: 800 },
    ],
    null,
    { type: 'P', uld: '' }
  );
  assert.strictEqual(a.length, 2);
  assert.strictEqual(a[0].source, 'pdf');
});

console.log(`\n✅ ${pass} 個測試全部通過`);
