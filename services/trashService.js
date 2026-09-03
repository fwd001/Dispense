'use strict';

/**
 * 回收站业务层：恢复 / 永久删除 / 清空 / 过期清理。
 * 自动清理用「定时扫描」，不为任何文件创建 Timer。
 */
const appStore = require('../storage/appStore');
const trashStore = require('../storage/trashStore');
const historyStore = require('../storage/historyStore');
const fileStore = require('../storage/fileStore');
const paths = require('../storage/paths');
const fsx = require('../lib/fsx');
const config = require('../config');
const naming = require('../lib/naming');
const mime = require('../lib/mime');
const logger = require('../lib/logger');
const { E, MESSAGE } = require('../lib/errors');

function decorate(record) {
  return {
    fileId: record.fileId,
    appId: record.appId,
    appName: record.appName,
    name: record.name,
    downloadName: record.downloadName,
    size: record.size,
    ext: record.ext,
    deletedAt: record.deletedAt,
    purgeAt: record.purgeAt,
    deletedBy: record.deletedBy
  };
}

async function list() {
  const [files, apps] = await Promise.all([trashStore.listFiles(), trashStore.listApps()]);
  return {
    files: files.map(decorate),
    applications: apps,
    ttlDays: config.TRASH_TTL_DAYS,
    now: new Date().toISOString()
  };
}

/** 恢复文件到原应用；原应用已删除则拒绝（先恢复应用） */
async function restoreFile(fileId) {
  const record = await trashStore.getFile(fileId);
  if (!record) throw E.notFound(MESSAGE.TRASH_ITEM_NOT_FOUND, 'TRASH_ITEM_NOT_FOUND');

  const app = await appStore.get(record.appId);
  if (!app) throw E.conflict(MESSAGE.RESTORE_APP_MISSING, 'RESTORE_APP_MISSING');

  const restored = await appStore.mutate(app.id, async (a) => {
    if ((a.files || []).length >= config.MAX_FILES_PER_APPLICATION) {
      throw E.conflict(MESSAGE.FILE_LIMIT_PER_APP(config.MAX_FILES_PER_APPLICATION), 'FILE_LIMIT_PER_APP');
    }
    const name = naming.nextAvailableName(record.name, (a.files || []).map((f) => f.name));
    const downloadName = naming.nextAvailableName(
      record.downloadName || name,
      (a.files || []).map((f) => f.downloadName)
    );

    const dest = paths.entity(a.id, record.fileId);
    await fileStore.move(paths.trashEntity(record.fileId), dest);
    const stat = await fileStore.stat(dest).catch(() => null);

    const now = new Date().toISOString();
    const file = {
      id: record.fileId,
      name,
      downloadName,
      size: stat ? stat.size : record.size,
      ext: naming.extensionOf(name),
      mime: mime.mimeFor(name),
      seq: appStore.nextSeq(a),
      createdAt: record.createdAt || now,
      updatedAt: now,
      broken: false
    };
    a.files = a.files || [];
    a.files.unshift(file);
    a.seq = file.seq;
    return { file, renamed: name !== record.name };
  });

  await trashStore.removeFile(record.fileId);
  await historyStore.append(app.id, {
    type: 'restore',
    fileId: restored.file.id,
    fileName: restored.file.name,
    detail: { from: record.name, renamed: restored.renamed }
  });
  logger.log('file_restored', { appId: app.id, fileId: restored.file.id, name: restored.file.name });

  return Object.assign({}, restored.file, { appId: app.id });
}

/** 永久删除单个文件 */
async function removeFile(fileId) {
  const record = await trashStore.getFile(fileId);
  if (!record) throw E.notFound(MESSAGE.TRASH_ITEM_NOT_FOUND, 'TRASH_ITEM_NOT_FOUND');
  await trashStore.removeFile(fileId);
  logger.log('file_purged', { fileId, name: record.name, appId: record.appId });
  return { fileId, name: record.name };
}

/** 清空回收站（文件 + 应用，永久删除） */
async function clear() {
  const fileCount = await trashStore.clearFiles();
  const apps = await trashStore.listApps();
  for (const app of apps) await trashStore.removeApp(app.id);
  logger.log('trash_cleared', { files: fileCount, apps: apps.length });
  return { files: fileCount, applications: apps.length };
}

/**
 * 恢复应用：目录回到 apps/，重新进入索引，
 * 并把当初随应用一起进回收站的文件一并恢复。
 */
async function restoreApp(appId) {
  const record = await trashStore.getApp(appId);
  if (!record) throw E.notFound(MESSAGE.TRASH_ITEM_NOT_FOUND, 'TRASH_ITEM_NOT_FOUND');

  const destDir = paths.appDir(appId);
  if (await fsx.exists(destDir)) throw E.conflict('应用目录已存在，无法恢复', 'APP_DIR_EXISTS');

  await fileStore.move(paths.trashAppDir(appId), destDir);
  await trashStore.removeAppRecord(appId);

  const app = await appStore.get(appId);
  if (!app) throw E.notFound(MESSAGE.APP_NOT_FOUND, 'APP_NOT_FOUND');

  // 重新登记索引（token 也随 app.json 一起回来）
  await appStore.mutate(appId, () => {});

  // 恢复当初随应用一起删除的文件
  let restoredFiles = 0;
  const pending = await trashStore.listFiles();
  for (const item of pending) {
    if (item.appId !== appId || item.deletedBy !== 'app-delete') continue;
    await restoreFile(item.fileId);
    restoredFiles += 1;
  }

  await historyStore.append(appId, {
    type: 'app_restored',
    detail: { name: app.name, restoredFiles }
  });
  logger.log('app_restored', { appId, name: app.name, restoredFiles });

  return { appId, name: app.name, restoredFiles };
}

/** 永久删除应用（连同目录与历史） */
async function removeApp(appId) {
  const record = await trashStore.getApp(appId);
  if (!record) throw E.notFound(MESSAGE.TRASH_ITEM_NOT_FOUND, 'TRASH_ITEM_NOT_FOUND');
  await trashStore.removeApp(appId);
  logger.log('app_purged', { appId, name: record.name });
  return { appId, name: record.name };
}

/** 定时扫描：删除时间 + TTL 天 < 现在 → 永久删除 */
async function purgeExpired(now) {
  const timestamp = Number.isFinite(now) ? now : Date.now();
  const files = await trashStore.purgeExpiredFiles(timestamp);
  const apps = await trashStore.purgeExpiredApps(timestamp);

  for (const rec of files) {
    logger.log('file_auto_purged', { fileId: rec.fileId, name: rec.name, appId: rec.appId });
  }
  for (const rec of apps) {
    logger.log('app_auto_purged', { appId: rec.id, name: rec.name });
  }
  return { files: files.length, applications: apps.length };
}

module.exports = {
  list,
  restoreFile,
  removeFile,
  clear,
  restoreApp,
  removeApp,
  purgeExpired
};
