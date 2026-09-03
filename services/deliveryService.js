'use strict';

/**
 * 下发服务：token → Application → currentFileId → File → 实体文件 → Stream
 *
 * 全程走索引定位，不扫描目录；返回体用 Node Stream，不把文件读进内存。
 */
const appStore = require('../storage/appStore');
const fileStore = require('../storage/fileStore');
const paths = require('../storage/paths');
const fsx = require('../lib/fsx');
const mime = require('../lib/mime');
const { MESSAGE } = require('../lib/errors');

/**
 * @returns {Promise<{ok:boolean, reason?:string, app?:object, file?:object, entityPath?:string, stat?:object}>}
 */
async function resolve(token) {
  const app = await appStore.getByToken(token);
  if (!app) return { ok: false, reason: 'TOKEN_NOT_FOUND', message: MESSAGE.TOKEN_NOT_FOUND };

  if (!app.currentFileId) {
    return { ok: false, reason: 'NO_CURRENT_FILE', message: MESSAGE.NO_CURRENT_FILE, app };
  }

  const file = appStore.findFile(app, app.currentFileId);
  if (!file) return { ok: false, reason: 'NO_CURRENT_FILE', message: MESSAGE.NO_CURRENT_FILE, app };

  const entityPath = paths.entity(app.id, file.id);
  if (!(await fsx.exists(entityPath))) {
    return { ok: false, reason: 'FILE_BROKEN', message: MESSAGE.FILE_BROKEN, app, file };
  }

  const stat = await fileStore.stat(entityPath);
  return { ok: true, app, file, entityPath, stat };
}

/** 生成 ETag：文件一旦被覆盖（size/mtime 变化）即失效 */
function etagOf(file, stat) {
  const stamp = stat ? stat.mtimeMs : Date.now();
  return '"' + file.id + '-' + (stat ? stat.size : 0) + '-' + Math.round(Number(stamp) || 0) + '"';
}

/** RFC 5987 / RFC 6266：兼顾老浏览器与中文名的 Content-Disposition */
function contentDisposition(downloadName, attachment) {
  const ascii = String(downloadName || '').replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(String(downloadName || ''));
  return (attachment ? 'attachment' : 'inline') +
    '; filename="' + ascii + '"; filename*=UTF-8\'\'' + encoded;
}

module.exports = { resolve, etagOf, contentDisposition, mime };
