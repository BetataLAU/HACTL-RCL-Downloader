'use strict';

const path = require('path');

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/* src/automation/ 上一級再上一級 = project root/data */
const DATA_DIR = path.join(__dirname, '..', '..', 'data');

module.exports = { MONTHS, DATA_DIR };
