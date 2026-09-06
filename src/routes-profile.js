'use strict';

/** 個人 profile router: 清單 + 切換 (掛喺 server.js /api 下) */

const express = require('express');
const { getProfilesMeta, activeProfileId, saveConfig, loadConfig } = require('./config');

const router = express.Router();

router.get('/profiles', (req, res) => {
  res.json({ ok: true, list: getProfilesMeta(), active: activeProfileId() });
});

router.post('/profile/switch', (req, res) => {
  try {
    const id = String((req.body && req.body.id) || '').trim();
    if (!getProfilesMeta().some((p) => p.id === id)) {
      res.status(400).json({ ok: false, error: '未知 profile: ' + id });
      return;
    }
    saveConfig({ activeProfile: id });
    res.json({ ok: true, config: loadConfig() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
