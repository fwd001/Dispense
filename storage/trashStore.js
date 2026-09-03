'use strict';

/**
 * 回收站：删除 = 移动，不是 rm。
 *  - 文件：实体移到 trash/files/<fileId>，记录写 trash/<fileId>.json
 *  - 应用：目录移到 trash/apps/<appId>，记录写 trash/apps/<appId>.json
 * 自动清理靠「定时扫描」实现，不为任何单个文件创建 Timer。
 */
const fsp = require('fs/promises');
const path = require('path');
const fsx = require('../lib/fsx');
const paths = require('./paths');
const fileStore = require('./fileStore');
const config = require('../config');

const DAY_MS = 24 * 60 * 60 * 1000;

function purgeAtOf(deletedAt) {
  return new Date(Date.parse(deletedAt) + config.TRASH_TTL_DAYS * DAY_MS).toISOString();
}

/** 是否已到自动清理时间 */
function isExpired(record, now) {
  const at = Date.parse(record.purgeAt || '');
  if (!Number.isFinite(at)) return false;
  return at <= now;
}

/* ------------------------------- 文件 ------------------------------- */

async function addFile(app, file, deletedBy) {
  const deletedAt = new Date().toISOString();
  const src = paths.entity(app.id, file.id);
  const dest = paths.trashEntity(file.id);
  await fileStore.move(src, dest);

  const record = {
    fileId: file.id,
    appId: app.id,
    appName: app.name,
    name: file.name,
    downloadName: file.downloadName,
    size: file.size,
    ext: file.ext,
    mime: file.mime,
    seq: file.seq,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    deletedAt,
    purgeAt: purgeAtOf(deletedAt),
    deletedBy: deletedBy || 'user'
  };
  await fsx.writeJsonAtomic(paths.trashRecord(file.id), record);
  return record;
}

async function listFiles() {
  const entries = await fsp.readdir(paths.TRASH, { withFileTypes: true }).catch(() => []);
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const rec = await fsx.readJson(path.join(paths.TRASH, entry.name), null);
    if (rec && rec.fileId) records.push(rec);
  }
  records.sort((a, b) => String(b.deletedAt || '').localeCompare(String(a.deletedAt || '')));
  return records;
}

async function getFile(fileId) {
  return fsx.readJson(paths.trashRecord(fileId), null);
}

/** 永久删除单个回收项 */
async function removeFile(fileId) {
  await Promise.all([
    fileStore.remove(paths.trashEntity(fileId)),
    fsp.rm(paths.trashRecord(fileId), { force: true })
  ]);
}

async function clearFiles() {
  const records = await listFiles();
  for (const rec of records) await removeFile(rec.fileId);
  return records.length;
}

/** 扫描并清理过期文件，返回被清理的记录 */
async function purgeExpiredFiles(now) {
  const records = await listFiles();
  const purged = [];
  for (const rec of records) {
    if (!isExpired(rec, now)) continue;
    await removeFile(rec.fileId);
    purged.push(rec);
  }
  return purged;
}

/* ------------------------------- 应用 ------------------------------- */

async function addApp(app, deletedBy) {
  const deletedAt = new Date().toISOString();
  await fileStore.move(paths.appDir(app.id), paths.trashAppDir(app.id));
  const record = {
    id: app.id,
    name: app.name,
    token: app.token,
    fileCount: Array.isArray(app.files) ? app.files.length : 0,
    deletedAt,
    purgeAt: purgeAtOf(deletedAt),
    deletedBy: deletedBy || 'user'
  };
  await fsx.writeJsonAtomic(paths.trashAppRecord(app.id), record);
  return record;
}

async function listApps() {
  const entries = await fsp.readdir(paths.TRASH_APPS, { withFileTypes: true }).catch(() => []);
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const rec = await fsx.readJson(path.join(paths.TRASH_APPS, entry.name), null);
    if (rec && rec.id) records.push(rec);
  }
  records.sort((a, b) => String(b.deletedAt || '').localeCompare(String(a.deletedAt || '')));
  return records;
}

async function getApp(appId) {
  return fsx.readJson(paths.trashAppRecord(appId), null);
}

/** 永久删除应用（连同目录与历史） */
async function removeApp(appId) {
  await Promise.all([
    fsp.rm(paths.trashAppDir(appId), { recursive: true, force: true }),
    fsp.rm(paths.trashAppRecord(appId), { force: true })
  ]);
}

/** 只删除回收记录（恢复应用时目录已被移走，只需清记录） */
async function removeAppRecord(appId) {
  await fsp.rm(paths.trashAppRecord(appId), { force: true });
}

async function purgeExpiredApps(now) {
  const records = await listApps();
  const purged = [];
  for (const rec of records) {
    if (!isExpired(rec, now)) continue;
    await removeApp(rec.id);
    purged.push(rec);
  }
  return purged;
}

module.exports = {
  DAY_MS,
  purgeAtOf,
  isExpired,
  addFile,
  listFiles,
  getFile,
  removeFile,
  clearFiles,
  purgeExpiredFiles,
  addApp,
  listApps,
  getApp,
  removeApp,
  removeAppRecord,
  purgeExpiredApps
};
