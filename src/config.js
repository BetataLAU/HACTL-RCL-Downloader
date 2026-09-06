'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const PROFILE_DIR = path.join(DATA_DIR, 'profiles');

/**
 * 個人化設定 (v0.3+)
 * - config.json 存放「共用」(login/瀏覽器/機器設定) + activeProfile
 * - data/profiles/<id>.json 存放每人專屬設定 (airline/saveDir/MAWB 清單/XLS 同步等)
 * - 向後兼容: hin 未有 profile 檔前, 直接讀 config.json 頂層舊欄位
 */

/* config.json 共用 keys (唔會寫入個人 profile) */
const SHARED_KEYS = [
  'baseUrl',
  'username',
  'password',
  'profileName',
  'headless',
  'slowMo',
  'browserChannel',
  'timeoutMs',
  'maxRclRows',
  'selectors',
  'activeProfile',
  'profilesMeta',
];

/* 個人 profile keys (儲存喺 data/profiles/<id>.json) */
const PROFILE_KEYS = [
  'airline',
  'acceptDate',
  'acceptDateTo',
  'autoCheckMinutes',
  'saveDir',
  'mawbList',
  'xlsSync',
  'name',
  'hint',
];

const DEFAULTS = {
  baseUrl: 'https://cargo.hactl.com/',
  username: '',
  password: '',
  profileName: 'Betata',
  airline: 'QR',
  acceptDate: 'auto',
  acceptDateTo: 'auto',
  autoCheckMinutes: 0,
  saveDir: path.join(os.homedir(), 'Downloads'),
  headless: true,
  slowMo: 0,
  browserChannel: 'chrome',
  timeoutMs: 60000,
  maxRclRows: 400,
  mawbList: [],
  selectors: {},
  xlsSync: null, // { enabled, file, sheet }
};

const DEFAULT_PROFILES = [
  { id: 'hin', name: '軒仔' },
  { id: 'liu', name: '劉鏘鏘' },
];

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

function loadBase() {
  return readJson(CONFIG_FILE, {});
}

function saveBase(base) {
  writeJson(CONFIG_FILE, base);
}

function activeProfileId() {
  const b = loadBase();
  const id = String((b && b.activeProfile) || '').trim();
  return id || 'hin';
}

/** 個人 profile meta list ([{ id, name }]), 未設定就用預設兩個 */
function getProfilesMeta() {
  const b = loadBase();
  if (Array.isArray(b.profilesMeta) && b.profilesMeta.length) {
    return b.profilesMeta.map((p) => ({
      id: String(p.id || '').trim(),
      name: p.name || p.id,
    }));
  }
  return DEFAULT_PROFILES.map((p) => ({ ...p }));
}

function profileFilePath(id) {
  return path.join(PROFILE_DIR, `${String(id).trim()}.json`);
}

/** 讀取個人 profile 覆蓋值 */
function loadProfileOverrides(id) {
  const f = profileFilePath(id);
  if (fs.existsSync(f)) return readJson(f, {});
  // 未有 profile 檔: 舊版行為 = hin 由 config.json 頂層供電
  if (String(id).trim() === 'hin' || !String(id).trim()) {
    const b = loadBase();
    const legacy = {};
    for (const k of PROFILE_KEYS) if (Object.prototype.hasOwnProperty.call(b, k)) legacy[k] = b[k];
    return legacy;
  }
  return {};
}

/** 合併後嘅完整 config (即而家 active profile 實際用緊嗰套) */
function loadConfig() {
  const base = loadBase();
  const shared = {};
  for (const k of SHARED_KEYS) if (Object.prototype.hasOwnProperty.call(base, k)) shared[k] = base[k];
  const id = activeProfileId();
  const over = loadProfileOverrides(id);
  const merged = { ...DEFAULTS, ...shared, ...over, activeProfile: id };
  if (!Array.isArray(merged.mawbList)) merged.mawbList = [];
  return merged;
}

/**
 * 儲存設定。會自動分流:
 * - 共用 key → config.json
 * - 個人 key → data/profiles/<activeProfile>.json
 */
function saveConfig(patch) {
  patch = patch || {};
  let base = loadBase();

  const targetId = String(patch.activeProfile || '').trim() || activeProfileId();
  if (patch.activeProfile) {
    base.activeProfile = targetId;
  }

  const sharedPatch = {};
  const profilePatch = {};

  for (const [k, v] of Object.entries(patch)) {
    if (k === 'activeProfile') continue;
    if (k === 'profilesMeta') {
      base.profilesMeta = v;
    } else if (k === 'password' && v === '') {
      // 留空 = 唔改密碼 (沿用 /api/config 嘅語義, 喺度做保險)
      continue;
    } else if (SHARED_KEYS.includes(k)) {
      sharedPatch[k] = v;
    } else {
      // 個人 key + 未來新 key 全部入個人 profile
      profilePatch[k] = v;
    }
  }

  if (Object.keys(sharedPatch).length) Object.assign(base, sharedPatch);
  base.activeProfile = targetId;
  saveBase(base);

  if (Object.keys(profilePatch).length) {
    const prev = loadProfileOverrides(targetId) || {};
    writeJson(profileFilePath(targetId), { ...prev, ...profilePatch });
  }

  return loadConfig();
}

module.exports = {
  loadConfig,
  saveConfig,
  DEFAULTS,
  DATA_DIR,
  CONFIG_FILE,
  PROFILE_DIR,
  SHARED_KEYS,
  PROFILE_KEYS,
  DEFAULT_PROFILES,
  getProfilesMeta,
  activeProfileId,
  loadProfileOverrides,
  profileFilePath,
  loadBase,
  saveBase,
};
