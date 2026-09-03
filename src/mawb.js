'use strict';

/**
 * MAWB 格式處理
 * - 統一格式: 000-0000 0000 (prefix 3位 + suffix 8位)
 * - 支援 3 種輸入: 157-53711840 / 157-5371 1840 / 15753711840
 * - 唔夠位左邊補 0 (例: 1-1 → 001-0000 0001)
 * - 驗證: prefix 001-999; suffix 頭 7 位 MOD 7 = 第 8 位 (檢查位)
 */

function padLeft(s, n) {
  return String(s).padStart(n, '0');
}

/** 將輸入轉為統一格式物件; 無法解析返回 null (空輸入亦返回 null) */
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
    // 只有 suffix (8位或更少), 當 prefix = 001
    prefix = '001';
    suffix = padLeft(digits, 8).slice(-8);
  } else {
    // 9-10 位: 前段當 prefix, 後 8 位當 suffix
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

/** 驗證 MAWB: { valid, reason } */
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

/** 方便用途: 直接對輸入做完整 normalize + validate */
function checkMAWB(raw) {
  const m = normalizeMAWB(raw);
  if (!m) return { valid: false, reason: '空白或格式無法解析', mawb: null };
  const v = validateMAWB(m);
  return { valid: v.valid, reason: v.reason, mawb: m };
}

module.exports = { normalizeMAWB, validateMAWB, checkMAWB };
