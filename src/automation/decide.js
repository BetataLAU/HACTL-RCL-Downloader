'use strict';

/** 由 PAL 列表決定「需要下載」嘅行 (P/B/X + 用戶 MAWB 清單規則) */

const path = require('path');
const fs = require('fs');

/**
 * @returns {{ downloadList: [], skipTypeCount, skipDoneCount, notListedCount }}
 * ctx: { log, results, mawbStatus, seenMawbKeys, hasUserList, userTrackSet,
 *        userSkipSet, includeX, saveDir, normKey }
 */
function decideDownloadList(ctx, listRows) {
  const { log, results, mawbStatus, seenMawbKeys, hasUserList, userTrackSet, userSkipSet, includeX, saveDir, normKey } = ctx;
  const downloadList = [];
  let skipTypeCount = 0;
  let skipDoneCount = 0;
  let notListedCount = 0;

  listRows.forEach((row) => {
    const isX = row.type === 'X' && !row.awb;
    const disp = row.awb || row.uld || '';
    const key = isX ? `X:${row.uld}` : normKey(row.awb);
    if (!isX) seenMawbKeys.add(key);
    if (!isX && hasUserList && !userTrackSet.has(key)) {
      notListedCount++;
      mawbStatus[key] = 'not-listed';
      return; // 唔喺用戶清單, 唔處理 (X 除外)
    }
    if (!isX && userSkipSet.has(key)) {
      log(`⏭ 跳過 ${disp} (用戶已標記已下載)`);
      results.skipped.push(disp);
      mawbStatus[key] = 'user-skipped';
      return;
    }
    if (!isX && row.type !== 'P' && row.type !== 'B') {
      skipTypeCount++;
      log(`⏭ 跳過 ${disp} (Type=${row.type || '(空)'}, 只下載 P/B/X)`);
      results.skipped.push(disp);
      mawbStatus[key] = 'type-skipped';
      return;
    }
    const parts = [];
    if (row.type === 'B') parts.push('BULK');
    if (row.type === 'X') parts.push('X');
    if (row.lih === 'N') parts.push('no LIH');
    const fname = `${disp} RCL${parts.length ? ` (${parts.join(', ')})` : ''}.pdf`;
    const target = path.join(saveDir, fname);
    // X / 冇用戶清單: 檔案存在就跳過; 有用戶清單嘅 P/B: 無 tick 就照下載
    if ((isX || !hasUserList) && fs.existsSync(target)) {
      skipDoneCount++;
      log(`⏭ 跳過 ${disp} (檔案已存在)`);
      results.skipped.push(disp);
      mawbStatus[key] = 'already-have';
      return;
    }
    downloadList.push({ ...row, disp, fname, target, idx: row.gridIdx, isX });
    mawbStatus[key] = 'pending';
  });

  return { downloadList, skipTypeCount, skipDoneCount, notListedCount };
}

module.exports = { decideDownloadList };
