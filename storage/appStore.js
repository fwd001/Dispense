'use strict';

/**
 * Application 元数据存储。
 *
 * 读取策略（面向 2GB 小内存服务器）：
 *  - 应用列表 / token 反查：读 index/*.json（一次一个小文件），不做全目录扫描
 *  - 单个应用：读 apps/<id>/app.json
 *  - files 内嵌在 app.json 里（单应用上限 200 条 ≈ 40KB），
 *    换来「列表只读 1 个文件」，远优于读 200 个独立小文件
 */
const fsp = require('fs/promises');
const fsx = require('../lib/fsx');
const paths = require('./paths');
const config = require('../config');
const { E, MESSAGE } = require('../lib/errors');
const { globalQueue, appQueue } = require('../lib/lock');

const INDEX_CACHE_TTL = 3000;

function fileCountOf(app) {
  return Array.isArray(app.files) ? app.files.length : 0;
}

function findFile(app, fileId) {
  if (!app || !fileId || !Array.isArray(app.files)) return null;
  return app.files.find((f) => f.id === fileId) || null;
}

function summaryOf(app) {
  const current = findFile(app, app.currentFileId);
  return {
    id: app.id,
    name: app.name,
    token: app.token,
    currentFileId: app.currentFileId || null,
    currentFileName: current ? current.name : null,
    currentDownloadName: current ? current.downloadName : null,
    fileCount: fileCountOf(app),
    createdAt: app.createdAt,
    updatedAt: app.updatedAt
  };
}

async function readIndex() {
  const [appsDoc, tokens, stats, filesDoc] = await Promise.all([
    fsx.readJson(paths.indexApps, null),
    fsx.readJson(paths.indexTokens, null),
    fsx.readJson(paths.indexStats, null),
    fsx.readJson(paths.indexFiles, null)
  ]);
  return {
    apps: appsDoc && Array.isArray(appsDoc.apps) ? appsDoc.apps : [],
    tokens: tokens && typeof tokens === 'object' ? tokens : {},
    stats: stats && typeof stats === 'object' ? stats : { totalFiles: 0 },
    files: filesDoc && typeof filesDoc.files === 'object' ? filesDoc.files : {}
  };
}

function summarizeTotal(apps) {
  return apps.reduce((sum, a) => sum + (Number(a.fileCount) || 0), 0);
}

async function writeIndex(index) {
  // totalFiles 始终由应用摘要推导，杜绝计数漂移；重启后 rebuildIndex 也会重算
  // 索引是「可由 app.json 重建」的派生数据，落盘不 fsync（崩溃由 rebuildIndex 自愈），
  // 换来批量写入的数倍提速；app.json 本身仍 fsync，是文件列表的唯一真相来源。
  const stats = { totalFiles: summarizeTotal(index.apps), updatedAt: new Date().toISOString() };
  await Promise.all([
    fsx.writeJsonAtomic(paths.indexApps, { apps: index.apps }, { sync: false }),
    fsx.writeJsonAtomic(paths.indexTokens, index.tokens, { sync: false }),
    fsx.writeJsonAtomic(paths.indexStats, stats, { sync: false }),
    fsx.writeJsonAtomic(paths.indexFiles, { files: index.files }, { sync: false })
  ]);
  fsx.invalidateCache(paths.indexTokens);
  fsx.invalidateCache(paths.indexApps);
  fsx.invalidateCache(paths.indexFiles);
}

function upsertSummary(index, app) {
  const summary = summaryOf(app);
  const i = index.apps.findIndex((a) => a.id === app.id);
  if (i >= 0) index.apps[i] = summary;
  else index.apps.push(summary);
  syncFiles(index, app);
  return summary;
}

/** 同步 fileId → appId 反查表，让 /api/files/:fileId 能 O(1) 定位所属应用 */
function syncFiles(index, app) {
  for (const fileId of Object.keys(index.files)) {
    if (index.files[fileId] === app.id) delete index.files[fileId];
  }
  for (const file of app.files || []) index.files[file.id] = app.id;
}

/* ------------------------------ 对外 API ------------------------------ */

async function init() {
  await paths.ensureLayout();
  if (!(await fsx.exists(paths.indexApps))) await rebuildIndex();
}

async function listSummaries() {
  const doc = await fsx.readJsonCached(paths.indexApps, INDEX_CACHE_TTL, { apps: [] });
  const apps = (doc && doc.apps) || [];
  // 默认按创建时间倒序：最新创建的应用在最前
  return apps.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

async function getStats() {
  const stats = await fsx.readJsonCached(paths.indexStats, INDEX_CACHE_TTL, { totalFiles: 0 });
  return {
    totalFiles: Number(stats.totalFiles) || 0,
    totalApplications: (await listSummaries()).length
  };
}

async function get(appId) {
  return fsx.readJson(paths.appMeta(appId), null);
}

async function getOrThrow(appId) {
  const app = await get(appId);
  if (!app) throw E.notFound(MESSAGE.APP_NOT_FOUND, 'APP_NOT_FOUND');
  return app;
}

async function getAppIdByToken(token) {
  if (!token) return null;
  const tokens = await fsx.readJsonCached(paths.indexTokens, INDEX_CACHE_TTL, {});
  return tokens[token] || null;
}

async function getByToken(token) {
  const appId = await getAppIdByToken(token);
  if (!appId) return null;
  return get(appId);
}

/** 创建应用：校验数量上限与重名，生成不可猜测的 token */
async function create(name) {
  return globalQueue.run('index', async () => {
    const index = await readIndex();

    if (index.apps.length >= config.MAX_APPLICATIONS) {
      throw E.conflict(MESSAGE.APP_LIMIT(config.MAX_APPLICATIONS), 'APP_LIMIT');
    }
    const lower = String(name).toLowerCase();
    if (index.apps.some((a) => String(a.name).toLowerCase() === lower)) {
      throw E.conflict(MESSAGE.APP_NAME_DUPLICATE, 'APP_NAME_DUPLICATE');
    }

    let token = null;
    for (let i = 0; i < 8 && !token; i += 1) {
      const candidate = paths.newToken();
      if (!index.tokens[candidate]) token = candidate;
    }
    if (!token) throw E.conflict('生成下发链接失败，请重试', 'TOKEN_GEN_FAILED');

    const now = new Date().toISOString();
    const app = {
      id: paths.newAppId(),
      name: String(name),
      token,
      currentFileId: null,
      seq: 0,
      files: [],
      createdAt: now,
      updatedAt: now
    };

    await fsx.ensureDir(paths.appFilesDir(app.id));
    await fsx.writeJsonAtomic(paths.appMeta(app.id), app);

    index.apps.push(summaryOf(app));
    index.tokens[token] = app.id;
    syncFiles(index, app);
    await writeIndex(index);
    return app;
  });
}

/**
 * 修改应用：fn 直接对 app 对象做变更，写回后同步索引。
 * 同一应用的写操作串行，不同应用并行。
 */
async function mutate(appId, fn) {
  return appQueue.run(appId, async () => {
    const app = await fsx.readJson(paths.appMeta(appId), null);
    if (!app) throw E.notFound(MESSAGE.APP_NOT_FOUND, 'APP_NOT_FOUND');

    const result = await fn(app);
    app.updatedAt = new Date().toISOString();
    await fsx.writeJsonAtomic(paths.appMeta(appId), app);

    await globalQueue.run('index', async () => {
      const index = await readIndex();
      upsertSummary(index, app);
      await writeIndex(index);
    });

    return result === undefined ? app : result;
  });
}

/** 只读访问：不写回，不做索引同步 */
async function read(appId, fn) {
  const app = await getOrThrow(appId);
  return fn ? fn(app) : app;
}

async function removeFromIndex(appId) {
  await globalQueue.run('index', async () => {
    const index = await readIndex();
    const target = index.apps.find((a) => a.id === appId);
    index.apps = index.apps.filter((a) => a.id !== appId);
    if (target && target.token) delete index.tokens[target.token];
    for (const fileId of Object.keys(index.files)) {
      if (index.files[fileId] === appId) delete index.files[fileId];
    }
    await writeIndex(index);
  });
}

/** fileId → appId 反查（读索引，不扫描目录） */
async function getAppIdByFileId(fileId) {
  if (!fileId) return null;
  const doc = await fsx.readJsonCached(paths.indexFiles, INDEX_CACHE_TTL, { files: {} });
  return (doc && doc.files && doc.files[fileId]) || null;
}

/** 从 apps/ 目录全量重建索引（启动时 + 完整性检查时执行） */
async function rebuildIndex() {
  return globalQueue.run('index', async () => {
    await fsx.ensureDir(paths.APPS);
    const entries = await fsp.readdir(paths.APPS, { withFileTypes: true }).catch(() => []);
    const apps = [];
    const tokens = {};
    const files = {};

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const app = await fsx.readJson(paths.appMeta(entry.name), null);
      if (!app || !app.id) continue;
      if (entry.name !== app.id) continue; // 目录名与 id 不符，跳过，避免脏数据进索引
      apps.push(summaryOf(app));
      if (app.token) tokens[app.token] = app.id;
      for (const file of app.files || []) files[file.id] = app.id;
    }

    apps.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    await writeIndex({ apps, tokens, stats: {}, files });
    return apps;
  });
}

/** 序列号自增：同一毫秒上传多个文件时的稳定排序依据 */
function nextSeq(app) {
  app.seq = (Number(app.seq) || 0) + 1;
  return app.seq;
}

module.exports = {
  init,
  listSummaries,
  getStats,
  get,
  getOrThrow,
  getByToken,
  getAppIdByToken,
  getAppIdByFileId,
  create,
  mutate,
  read,
  removeFromIndex,
  rebuildIndex,
  nextSeq,
  findFile,
  summaryOf,
  fileCountOf
};
