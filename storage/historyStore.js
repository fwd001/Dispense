'use strict';

/**
 * 应用历史记录：NDJSON 追加写，只读取文件尾部，不做全量加载。
 * 不引入数据库，不做索引，代价极低。
 */
const fsp = require('fs/promises');
const fsx = require('../lib/fsx');
const paths = require('./paths');
const config = require('../config');

/** 追加一条历史（type: upload / edit / rename / save_as / set_current / delete / restore …） */
async function append(appId, entry) {
  const record = Object.assign({ ts: new Date().toISOString() }, entry);
  await fsx.appendLine(paths.appHistory(appId), JSON.stringify(record));
  return record;
}

/** 读取最近 limit 条（新的在前） */
async function list(appId, limit) {
  const file = paths.appHistory(appId);
  const max = Math.max(1, limit || config.HISTORY_PAGE_SIZE);
  let lines;
  try {
    lines = await fsx.tailLines(file, config.HISTORY_TAIL_BYTES);
  } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }

  const records = [];
  for (let i = lines.length - 1; i >= 0 && records.length < max; i -= 1) {
    try {
      records.push(JSON.parse(lines[i]));
    } catch (e) { /* 跳过损坏行 */ }
  }
  return records;
}

/** 清空历史（应用被永久删除时使用） */
async function remove(appId) {
  await fsp.rm(paths.appHistory(appId), { force: true });
}

module.exports = { append, list, remove };
