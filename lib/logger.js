'use strict';

/**
 * 极简本地日志：按天一个文件，追加写，不做 fsync。
 * 只在关键业务事件发生时写入，避免产生大量磁盘 IO。
 */
const fsx = require('./fsx');

let chain = Promise.resolve();
let dayKey = null;
let logDir = null;

function setLogDir(dir) {
  logDir = dir;
  dayKey = null;
}

function currentDay() {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return now.getFullYear() + '-' + mm + '-' + dd;
}

function formatFields(fields) {
  if (!fields) return '';
  return Object.keys(fields)
    .map((k) => {
      const v = fields[k];
      if (v === null || v === undefined) return k + '=-';
      const s = String(v);
      return /[\s"=]/.test(s) ? k + '="' + s.replace(/"/g, '\\"') + '"' : k + '=' + s;
    })
    .join(' ');
}

/**
 * @param {string} event 事件名，如 app_created / file_uploaded
 * @param {object} [fields] 附带字段
 */
function log(event, fields) {
  if (!logDir) return;
  const line = new Date().toISOString() + ' ' + event + (fields ? ' ' + formatFields(fields) : '') + '\n';
  const day = currentDay();
  const file = require('path').join(logDir, day + '.log');
  chain = chain
    .then(() => fsx.appendLine(file, line))
    .catch((e) => console.error('[log] 写入失败:', e && e.message));
  return chain;
}

module.exports = { log, setLogDir };
