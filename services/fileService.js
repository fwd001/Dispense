'use strict';

/**
 * File 业务层：上传 / 列表 / 重命名 / 编辑 / 另存为 / 删除。
 *
 * 核心产品原则：**上传 ≠ 发布**。
 * 上传只把文件放进应用，绝不自动改变 currentFileId。
 */
const appStore = require('../storage/appStore');
const fileStore = require('../storage/fileStore');
const trashStore = require('../storage/trashStore');
const historyStore = require('../storage/historyStore');
const paths = require('../storage/paths');
const fsx = require('../lib/fsx');
const config = require('../config');
const naming = require('../lib/naming');
const mime = require('../lib/mime');
const json = require('../lib/json');
const logger = require('../lib/logger');
const { E, MESSAGE } = require('../lib/errors');

const MB = 1024 * 1024;

/** 按 fileId 定位所属应用（走索引，不扫描目录） */
async function resolveFile(fileId) {
  const appId = await appStore.getAppIdByFileId(fileId);
  if (!appId) throw E.notFound(MESSAGE.FILE_NOT_FOUND, 'FILE_NOT_FOUND');
  const app = await appStore.get(appId);
  if (!app) throw E.notFound(MESSAGE.FILE_NOT_FOUND, 'FILE_NOT_FOUND');
  const file = appStore.findFile(app, fileId);
  if (!file) throw E.notFound(MESSAGE.FILE_NOT_FOUND, 'FILE_NOT_FOUND');
  return { app, file };
}

async function listFiles(appId) {
  const app = await appStore.getOrThrow(appId);
  const files = (await require('./appService').sortFiles(app)).map((f) =>
    Object.assign({}, f, { appId, isCurrent: app.currentFileId === f.id })
  );
  return { appId, currentFileId: app.currentFileId || null, files };
}

/* ------------------------------- 上传 ------------------------------- */

function toBuffer(content, encoding) {
  if (Buffer.isBuffer(content)) return content;
  if (encoding === 'base64') return Buffer.from(String(content || ''), 'base64');
  return Buffer.from(String(content == null ? '' : content), 'utf8');
}

/**
 * 上传：临时文件 → 校验 → 原子提交 → 写元数据
 * 顺序保证「实体先落地，元数据后写」，失败不会产生脏元数据。
 */
async function upload(options) {
  const opts = options || {};
  const buffer = toBuffer(opts.content, opts.encoding);

  if (buffer.length > config.MAX_FILE_SIZE) {
    throw E.tooLarge(MESSAGE.FILE_TOO_LARGE(Math.floor(config.MAX_FILE_SIZE / MB)), 'FILE_TOO_LARGE');
  }
  const desiredName = naming.validateFileName(opts.name || 'untitled', { defaultExtension: 'txt' });
  if (mime.isJsonName(desiredName)) json.validateJson(buffer.toString('utf8'));

  return appStore.mutate(opts.appId, async (app) => {
    if ((app.files || []).length >= config.MAX_FILES_PER_APPLICATION) {
      throw E.conflict(MESSAGE.FILE_LIMIT_PER_APP(config.MAX_FILES_PER_APPLICATION), 'FILE_LIMIT_PER_APP');
    }
    const stats = await appStore.getStats();
    if (stats.totalFiles >= config.MAX_TOTAL_FILES) {
      throw E.conflict(MESSAGE.FILE_LIMIT_TOTAL(config.MAX_TOTAL_FILES), 'FILE_LIMIT_TOTAL');
    }

    const name = naming.nextAvailableName(desiredName, (app.files || []).map((f) => f.name));
    const downloadName = naming.nextAvailableName(name, (app.files || []).map((f) => f.downloadName));
    const fileId = paths.newFileId();
    const dest = paths.entity(app.id, fileId);

    const tmp = await fileStore.stage(buffer);
    try {
      await fileStore.commit(tmp, dest);
    } catch (e) {
      await fileStore.removeTmp(tmp);
      throw e;
    }

    const now = new Date().toISOString();
    const file = {
      id: fileId,
      name,
      downloadName,
      size: buffer.length,
      ext: naming.extensionOf(name),
      mime: mime.mimeFor(name),
      seq: appStore.nextSeq(app),
      createdAt: now,
      updatedAt: now,
      broken: false
    };
    app.files = app.files || [];
    app.files.unshift(file); // 最新上传在最前（列表仍会按 createdAt DESC 再排一次）
    app.seq = file.seq;

    return { file, app };
  }).then(async (result) => {
    await historyStore.append(result.app.id, {
      type: 'upload',
      fileId: result.file.id,
      fileName: result.file.name,
      detail: { size: result.file.size }
    });
    logger.log('file_uploaded', {
      appId: result.app.id,
      fileId: result.file.id,
      name: result.file.name,
      size: result.file.size
    });
    return Object.assign({}, result.file, { appId: result.app.id, isCurrent: false });
  });
}

/* ------------------------------- 读取 ------------------------------- */

async function getMeta(fileId) {
  const { app, file } = await resolveFile(fileId);
  return Object.assign({}, file, { appId: app.id, isCurrent: app.currentFileId === file.id });
}

async function getContent(fileId) {
  const { app, file } = await resolveFile(fileId);
  const entity = paths.entity(app.id, file.id);
  if (!(await fsx.exists(entity))) throw E.notFound(MESSAGE.FILE_BROKEN, 'FILE_BROKEN');
  const content = await fileStore.readText(entity);
  return {
    meta: Object.assign({}, file, { appId: app.id, isCurrent: app.currentFileId === file.id }),
    content
  };
}

/* ------------------------------- 编辑 ------------------------------- */

/**
 * 保持用户文件的原始格式：
 *  - 换行符沿用原文的主导风格（LF / CRLF / CR），不因为编辑一次就全量转换
 *  - BOM 状态保持不变
 *  - 不增删结尾换行
 */
function applyOriginalFormatting(original, next) {
  let out = String(next == null ? '' : next);
  const crlf = (original.match(/\r\n/g) || []).length;
  const lf = (original.match(/(?<!\r)\n/g) || []).length;
  const cr = (original.match(/\r(?!\n)/g) || []).length;
  const dominant = crlf >= lf && crlf >= cr && crlf > 0 ? '\r\n' : cr > lf && cr > 0 ? '\r' : '\n';
  out = out.replace(/\r\n|\r|\n/g, dominant);

  const hadBom = original.charCodeAt(0) === 0xFEFF;
  const hasBom = out.charCodeAt(0) === 0xFEFF;
  if (hadBom && !hasBom) out = '﻿' + out;
  if (!hadBom && hasBom) out = out.slice(1);
  return out;
}

/** 保存并覆盖：先校验后落盘，实体先写成功再更新元数据 */
async function updateContent(options) {
  const opts = options || {};
  const { app, file } = await resolveFile(opts.fileId);
  const entity = paths.entity(app.id, file.id);
  if (!(await fsx.exists(entity))) throw E.notFound(MESSAGE.FILE_BROKEN, 'FILE_BROKEN');

  const original = await fileStore.readText(entity);
  const nextText = opts.preserveFormat === false
    ? String(opts.content == null ? '' : opts.content)
    : applyOriginalFormatting(original, opts.content);

  if (mime.isJsonName(file.name) || mime.isJsonName(file.downloadName)) json.validateJson(nextText);

  const buffer = Buffer.from(nextText, 'utf8');
  if (buffer.length > config.MAX_FILE_SIZE) {
    throw E.tooLarge(MESSAGE.FILE_TOO_LARGE(Math.floor(config.MAX_FILE_SIZE / MB)), 'FILE_TOO_LARGE');
  }

  const tmp = await fileStore.stage(buffer);
  try {
    await fileStore.commit(tmp, entity);
  } catch (e) {
    await fileStore.removeTmp(tmp);
    throw e;
  }

  const updated = await appStore.mutate(app.id, (a) => {
    const target = appStore.findFile(a, file.id);
    if (!target) throw E.notFound(MESSAGE.FILE_NOT_FOUND, 'FILE_NOT_FOUND');
    target.size = buffer.length;
    target.updatedAt = new Date().toISOString();
    target.broken = false;
    return Object.assign({}, target);
  });

  await historyStore.append(app.id, {
    type: 'edit',
    fileId: file.id,
    fileName: file.name,
    detail: { size: buffer.length, from: original.length, to: nextText.length }
  });
  logger.log('file_edited', { appId: app.id, fileId: file.id, name: file.name, size: buffer.length });

  return Object.assign({}, updated, { appId: app.id, isCurrent: app.currentFileId === file.id });
}

/** 重命名（文件名 / 下发名称分别校验唯一性） */
async function rename(options) {
  const opts = options || {};
  const { app, file } = await resolveFile(opts.fileId);

  const result = await appStore.mutate(app.id, (a) => {
    const target = appStore.findFile(a, file.id);
    if (!target) throw E.notFound(MESSAGE.FILE_NOT_FOUND, 'FILE_NOT_FOUND');
    const before = { name: target.name, downloadName: target.downloadName };

    if (opts.name !== undefined && opts.name !== null && String(opts.name) !== String(target.name)) {
      const clean = naming.validateFileName(opts.name, {});
      const others = (a.files || []).filter((f) => f.id !== target.id).map((f) => f.name);
      if (others.some((n) => String(n).toLowerCase() === clean.toLowerCase())) {
        throw E.conflict(MESSAGE.FILE_NAME_DUPLICATE, 'FILE_NAME_DUPLICATE');
      }
      target.name = clean;
      target.ext = naming.extensionOf(clean);
      target.mime = mime.mimeFor(clean);
    }

    if (opts.downloadName !== undefined && opts.downloadName !== null &&
        String(opts.downloadName) !== String(target.downloadName)) {
      const cleanDl = naming.validateFileName(opts.downloadName, { skipExtensionCheck: true });
      const others = (a.files || []).filter((f) => f.id !== target.id).map((f) => f.downloadName);
      if (others.some((n) => String(n).toLowerCase() === cleanDl.toLowerCase())) {
        throw E.conflict(MESSAGE.DOWNLOAD_NAME_DUPLICATE, 'DOWNLOAD_NAME_DUPLICATE');
      }
      target.downloadName = cleanDl;
    }

    target.updatedAt = new Date().toISOString();
    return { before, after: { name: target.name, downloadName: target.downloadName } };
  });

  await historyStore.append(app.id, {
    type: 'rename',
    fileId: file.id,
    fileName: result.after.name,
    detail: {
      from: result.before.name,
      to: result.after.name,
      downloadNameFrom: result.before.downloadName,
      downloadNameTo: result.after.downloadName
    }
  });
  logger.log('file_renamed', { appId: app.id, fileId: file.id, from: result.before.name, to: result.after.name });

  return getMeta(opts.fileId);
}

/**
 * 另存为新文件：
 *  - 给了 content，则用编辑中的内容创建新文件（保存为新版本）
 *  - 没给 content，则复制当前实体
 * 文件名沿用「最小可用序号」规则。
 */
async function saveAs(options) {
  const opts = options || {};
  const { app, file } = await resolveFile(opts.fileId);
  const src = paths.entity(app.id, file.id);
  if (!(await fsx.exists(src))) throw E.notFound(MESSAGE.FILE_BROKEN, 'FILE_BROKEN');

  let payload = null;
  if (opts.content !== undefined && opts.content !== null) {
    const original = await fileStore.readText(src);
    const text = opts.preserveFormat === false
      ? String(opts.content)
      : applyOriginalFormatting(original, opts.content);
    if (mime.isJsonName(file.name) || mime.isJsonName(file.downloadName)) json.validateJson(text);
    payload = Buffer.from(text, 'utf8');
    if (payload.length > config.MAX_FILE_SIZE) {
      throw E.tooLarge(MESSAGE.FILE_TOO_LARGE(Math.floor(config.MAX_FILE_SIZE / MB)), 'FILE_TOO_LARGE');
    }
  }

  const created = await appStore.mutate(app.id, async (a) => {
    if ((a.files || []).length >= config.MAX_FILES_PER_APPLICATION) {
      throw E.conflict(MESSAGE.FILE_LIMIT_PER_APP(config.MAX_FILES_PER_APPLICATION), 'FILE_LIMIT_PER_APP');
    }
    const stats = await appStore.getStats();
    if (stats.totalFiles >= config.MAX_TOTAL_FILES) {
      throw E.conflict(MESSAGE.FILE_LIMIT_TOTAL(config.MAX_TOTAL_FILES), 'FILE_LIMIT_TOTAL');
    }

    const name = naming.nextAvailableName(opts.name || file.name, (a.files || []).map((f) => f.name));
    const downloadName = naming.nextAvailableName(name, (a.files || []).map((f) => f.downloadName));
    const newFileId = paths.newFileId();
    const dest = paths.entity(a.id, newFileId);

    if (payload) {
      const tmp = await fileStore.stage(payload);
      try {
        await fileStore.commit(tmp, dest);
      } catch (e) {
        await fileStore.removeTmp(tmp);
        throw e;
      }
    } else {
      await fileStore.copy(src, dest);
    }

    const stat = await fileStore.stat(dest);
    const now = new Date().toISOString();
    const copy = {
      id: newFileId,
      name,
      downloadName,
      size: stat ? stat.size : payload ? payload.length : file.size,
      ext: naming.extensionOf(name),
      mime: mime.mimeFor(name),
      seq: appStore.nextSeq(a),
      createdAt: now,
      updatedAt: now,
      broken: false
    };
    a.files = a.files || [];
    a.files.unshift(copy);
    a.seq = copy.seq;
    return copy;
  });

  await historyStore.append(app.id, {
    type: 'save_as',
    fileId: created.id,
    fileName: created.name,
    detail: { from: file.name, fromFileId: file.id }
  });
  logger.log('file_saved_as', { appId: app.id, from: file.id, to: created.id, name: created.name });

  return Object.assign({}, created, { appId: app.id, isCurrent: app.currentFileId === created.id });
}

/* ------------------------------- 删除 ------------------------------- */

/**
 * 删除文件 → 进入回收站（不是 rm）。
 * 如果要删的正是当前下发文件，默认拒绝并返回可切换的候选，由前端让用户决策。
 */
async function remove(options) {
  const opts = options || {};
  const { app, file } = await resolveFile(opts.fileId);

  const isCurrent = app.currentFileId === file.id;
  if (isCurrent && !opts.force) {
    const alternatives = (app.files || [])
      .filter((f) => f.id !== file.id)
      .map((f) => ({ id: f.id, name: f.name }));
    throw E.conflict(MESSAGE.DELETE_CURRENT_FILE, 'DELETE_CURRENT_FILE', {
      fileId: file.id,
      name: file.name,
      alternatives
    });
  }

  await appStore.mutate(app.id, async (a) => {
    const target = appStore.findFile(a, file.id);
    if (!target) throw E.notFound(MESSAGE.FILE_NOT_FOUND, 'FILE_NOT_FOUND');
    await trashStore.addFile(a, target, 'user');         // 实体先移走
    a.files = (a.files || []).filter((f) => f.id !== file.id);
    if (a.currentFileId === file.id) a.currentFileId = null;
  });

  await historyStore.append(app.id, {
    type: 'delete',
    fileId: file.id,
    fileName: file.name,
    detail: { wasCurrent: isCurrent }
  });
  logger.log('file_deleted', { appId: app.id, fileId: file.id, name: file.name, wasCurrent: isCurrent });

  return { fileId: file.id, name: file.name, wasCurrent: isCurrent };
}

/** 删除全部文件：应用保留，文件全部进回收站，当前下发置空 */
async function removeAll(appId) {
  const count = await appStore.mutate(appId, async (a) => {
    const list = (a.files || []).slice();
    for (const file of list) {
      const entity = paths.entity(a.id, file.id);
      if (await fsx.exists(entity)) await trashStore.addFile(a, file, 'delete-all');
    }
    const total = list.length;
    a.files = [];
    a.currentFileId = null;
    return total;
  });

  await historyStore.append(appId, { type: 'delete_all', detail: { count } });
  logger.log('files_deleted_all', { appId, count });
  return { count };
}

module.exports = {
  resolveFile,
  listFiles,
  upload,
  getMeta,
  getContent,
  updateContent,
  rename,
  saveAs,
  remove,
  removeAll,
  applyOriginalFormatting
};
