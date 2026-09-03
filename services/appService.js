'use strict';

/**
 * Application 业务层：应用是核心对象，一个应用 = 一个永久稳定的下发链接。
 */
const appStore = require('../storage/appStore');
const trashStore = require('../storage/trashStore');
const historyStore = require('../storage/historyStore');
const paths = require('../storage/paths');
const fsx = require('../lib/fsx');
const config = require('../config');
const naming = require('../lib/naming');
const logger = require('../lib/logger');
const { E, MESSAGE } = require('../lib/errors');

/** 文件排序：createdAt DESC，同毫秒用 seq DESC 兜底 */
function sortFiles(app) {
  return (app.files || []).slice().sort((a, b) => {
    const byTime = String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    if (byTime !== 0) return byTime;
    return (Number(b.seq) || 0) - (Number(a.seq) || 0);
  });
}

function publicView(app) {
  return {
    id: app.id,
    name: app.name,
    token: app.token,
    currentFileId: app.currentFileId || null,
    fileCount: (app.files || []).length,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
    files: sortFiles(app)
  };
}

function limits() {
  return {
    maxApplications: config.MAX_APPLICATIONS,
    maxFilesPerApplication: config.MAX_FILES_PER_APPLICATION,
    maxTotalFiles: config.MAX_TOTAL_FILES,
    maxFileSize: config.MAX_FILE_SIZE,
    trashTtlDays: config.TRASH_TTL_DAYS,
    allowedExtensions: config.ALLOWED_EXTENSIONS.slice()
  };
}

async function list() {
  const [apps, stats] = await Promise.all([appStore.listSummaries(), appStore.getStats()]);
  return {
    applications: apps,
    stats: {
      totalApplications: stats.totalApplications,
      totalFiles: stats.totalFiles
    },
    limits: limits()
  };
}

async function create(rawName) {
  const name = naming.sanitizeApplicationName(rawName);
  if (!name) throw E.badRequest(MESSAGE.APP_NAME_EMPTY, 'APP_NAME_EMPTY');
  if (name.length > config.MAX_APPLICATION_NAME_LENGTH) {
    throw E.badRequest(MESSAGE.APP_NAME_TOO_LONG(config.MAX_APPLICATION_NAME_LENGTH), 'APP_NAME_TOO_LONG');
  }

  const app = await appStore.create(name);
  await historyStore.append(app.id, { type: 'app_created', fileName: null, detail: { name: app.name } });
  logger.log('app_created', { appId: app.id, name: app.name, token: app.token });
  return publicView(app);
}

async function detail(appId) {
  const app = await appStore.getOrThrow(appId);
  return publicView(app);
}

async function rename(appId, rawName) {
  const name = naming.sanitizeApplicationName(rawName);
  if (!name) throw E.badRequest(MESSAGE.APP_NAME_EMPTY, 'APP_NAME_EMPTY');
  if (name.length > config.MAX_APPLICATION_NAME_LENGTH) {
    throw E.badRequest(MESSAGE.APP_NAME_TOO_LONG(config.MAX_APPLICATION_NAME_LENGTH), 'APP_NAME_TOO_LONG');
  }

  const previous = await appStore.mutate(appId, async (app) => {
    const old = app.name;
    if (String(old).toLowerCase() === name.toLowerCase()) return { old, changed: false };
    app.name = name;
    return { old, changed: true };
  });

  if (previous.changed) {
    await historyStore.append(appId, {
      type: 'app_renamed',
      detail: { from: previous.old, to: name }
    });
    logger.log('app_renamed', { appId, from: previous.old, to: name });
  }
  return detail(appId);
}

/**
 * 发布 = 设置当前下发文件。URL 不变，只是指针改变。
 * fileId 传 null 表示暂停下发。
 */
async function setCurrentFile(appId, fileId) {
  const result = await appStore.mutate(appId, (app) => {
    if (fileId === null || fileId === undefined || fileId === '') {
      if (app.currentFileId === null) return { changed: false, file: null, previous: null };
      const previous = appStore.findFile(app, app.currentFileId);
      app.currentFileId = null;
      return { changed: true, file: null, previous };
    }
    const file = appStore.findFile(app, fileId);
    if (!file) throw E.notFound(MESSAGE.FILE_NOT_FOUND, 'FILE_NOT_FOUND');
    if (app.currentFileId === fileId) return { changed: false, file, previous: file };
    const previous = appStore.findFile(app, app.currentFileId);
    app.currentFileId = fileId;
    return { changed: true, file, previous };
  });

  if (result.changed) {
    const fileName = result.file ? result.file.name : null;
    await historyStore.append(appId, {
      type: result.file ? 'set_current' : 'unset_current',
      fileId: result.file ? result.file.id : null,
      fileName,
      detail: { previous: result.previous ? result.previous.name : null }
    });
    logger.log('current_file_changed', {
      appId,
      fileId: result.file ? result.file.id : 'null',
      fileName: fileName || '-'
    });
  }
  return detail(appId);
}

/**
 * 删除应用：所有文件先进入回收站，应用目录整体进入回收站，索引移除。
 * 绝不 rm -rf，永久删除只在回收站里发生。
 */
async function remove(appId) {
  const app = await appStore.getOrThrow(appId);
  const fileList = (app.files || []).slice();

  await historyStore.append(appId, {
    type: 'app_deleted',
    detail: { name: app.name, fileCount: fileList.length }
  });

  for (const file of fileList) {
    const entity = paths.entity(app.id, file.id);
    if (await fsx.exists(entity)) await trashStore.addFile(app, file, 'app-delete');
  }

  // 清空引用后再进回收站，避免恢复后出现「元数据在、实体不在」的悬空文件
  await appStore.mutate(appId, (a) => {
    a.files = [];
    a.currentFileId = null;
  });
  await appStore.removeFromIndex(appId);

  const record = await trashStore.addApp(app, 'user');
  logger.log('app_deleted', { appId: app.id, name: app.name, fileCount: fileList.length });
  return record;
}

module.exports = {
  sortFiles,
  publicView,
  limits,
  list,
  create,
  detail,
  rename,
  setCurrentFile,
  remove
};
