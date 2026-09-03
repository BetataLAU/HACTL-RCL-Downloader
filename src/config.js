'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const DEFAULTS = {
  baseUrl: 'https://cargo.hactl.com/',
  username: '',
  password: '',
  profileName: 'Betata',
  airline: 'QR',
  acceptDate: 'auto',
  acceptDateTo: 'auto',
  saveDir: path.join(os.homedir(), 'Downloads'),
  headless: false,
  slowMo: 0,
  browserChannel: 'chrome',
  timeoutMs: 60000,
  maxRclRows: 400,
  mawbList: [],
  selectors: {}
};

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

module.exports = { loadConfig, saveConfig, DEFAULTS, DATA_DIR, CONFIG_FILE };
