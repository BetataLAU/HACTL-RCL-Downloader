'use strict';

/**
 * HACTL RCL 自動下載核心 — 入口 (薄 wrapper)
 * 實際邏輯已拆去 src/automation/ 細模組 (login / cosac / command / pal-search /
 * grid / navigate / decide / download-one / process-date / run), 每個 <300 行。
 */

module.exports = require('./automation/run');
