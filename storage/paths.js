'use strict';

/**
 * 本地存储目录布局 + 路径安全。
 * 所有实体与元数据路径都必须经由这里生成，并强制限制在 data/ 内部。
 */
const path = require('path');
const crypto = require('crypto');
const fsp = require('fs/promises');
const config = require('../config');
const fsx = require('../lib/fsx');
const { E } = require('../lib/errors');

const DATA = config.DATA_DIR;
const APPS = path.join(DATA, 'apps');
const TRASH = path.join(DATA, 'trash');
const TRASH_FILES = path.join(TRASH, 'files');
const TRASH_APPS = path.join(TRASH, 'apps');
const INDEX = path.join(DATA, 'index');
const LOGS = path.join(DATA, 'logs');
const TMP = path.join(DATA, 'tmp');

/** 只允许此类字符出现在 id / token / 文件名片段中 */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

function assertSafeSegment(value, label) {
  if (!SAFE_SEGMENT.test(String(value || ''))) {
    throw E.badRequest('非法标识：' + (label || value), 'INVALID_ID');
  }
  return String(value);
}

/** 任何实体路径落盘前的最后一道防线 */
function assertInsideData(target) {
  if (!fsx.isInside(DATA, target)) {
    throw E.badRequest('非法路径：越出数据目录', 'PATH_TRAVERSAL');
  }
  return target;
}

function newAppId() {
  return 'app_' + crypto.randomBytes(8).toString('hex');
}

function newFileId() {
  return 'file_' + crypto.randomBytes(8).toString('hex');
}

/** 下发链接 token：9 字节随机数 → base64url 约 12 位，不可猜测 */
function newToken() {
  return crypto.randomBytes(9).toString('base64url');
}

const paths = {
  DATA,
  APPS,
  TRASH,
  TRASH_FILES,
  TRASH_APPS,
  INDEX,
  LOGS,
  TMP,

  indexApps: path.join(INDEX, 'apps.json'),
  indexTokens: path.join(INDEX, 'tokens.json'),
  indexStats: path.join(INDEX, 'stats.json'),
  indexFiles: path.join(INDEX, 'files.json'),

  appDir: (appId) => path.join(APPS, assertSafeSegment(appId, 'appId')),
  appMeta: (appId) => path.join(APPS, assertSafeSegment(appId, 'appId'), 'app.json'),
  appFilesDir: (appId) => path.join(APPS, assertSafeSegment(appId, 'appId'), 'files'),
  appHistory: (appId) => path.join(APPS, assertSafeSegment(appId, 'appId'), 'history.ndjson'),

  entity: (appId, fileId) =>
    assertInsideData(path.join(APPS, assertSafeSegment(appId, 'appId'), 'files', assertSafeSegment(fileId, 'fileId'))),

  trashRecord: (fileId) => path.join(TRASH, assertSafeSegment(fileId, 'fileId') + '.json'),
  trashEntity: (fileId) => assertInsideData(path.join(TRASH_FILES, assertSafeSegment(fileId, 'fileId'))),
  trashAppDir: (appId) => assertInsideData(path.join(TRASH_APPS, assertSafeSegment(appId, 'appId'))),
  trashAppRecord: (appId) => path.join(TRASH_APPS, assertSafeSegment(appId, 'appId') + '.json'),

  logFile: (day) => path.join(LOGS, day + '.log'),
  tmpFile: (name) => assertInsideData(path.join(TMP, name)),

  assertSafeSegment,
  assertInsideData,
  newAppId,
  newFileId,
  newToken
};

/** 启动即创建目录，保证后续读写不需要到处判空 */
async function ensureLayout() {
  for (const dir of [DATA, APPS, TRASH, TRASH_FILES, TRASH_APPS, INDEX, LOGS, TMP]) {
    await fsx.ensureDir(dir);
  }
}

/** 清理遗留的临时文件（进程被强杀时可能残留） */
async function cleanStaleTmp(maxAgeMs) {
  const entries = await fsp.readdir(TMP, { withFileTypes: true }).catch(() => []);
  const now = Date.now();
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(TMP, entry.name);
    try {
      const st = await fsp.stat(file);
      if (now - st.mtimeMs > maxAgeMs) {
        await fsp.rm(file, { force: true });
        removed += 1;
      }
    } catch (e) { /* 忽略单个失败 */ }
  }
  return removed;
}

paths.ensureLayout = ensureLayout;
paths.cleanStaleTmp = cleanStaleTmp;

module.exports = paths;
