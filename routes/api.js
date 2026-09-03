'use strict';

/**
 * 新版 API 路由。
 * 只做三件事：解析参数、调用 Service、把结果/错误翻译成 HTTP。
 * 所有 fs 操作都在 storage 层，所有业务规则都在 services 层。
 */
const config = require('../config');
const http = require('../lib/http');
const appService = require('../services/appService');
const fileService = require('../services/fileService');
const trashService = require('../services/trashService');
const historyStore = require('../storage/historyStore');
const paths = require('../storage/paths');
const fileStore = require('../storage/fileStore');
const delivery = require('../services/deliveryService');
const { E, MESSAGE } = require('../lib/errors');
const mime = require('../lib/mime');

const { sendJson, sendError } = http;

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > config.MAX_BODY_BYTES) {
        reject(E.tooLarge('请求体过大（最大 ' + Math.floor(config.MAX_BODY_BYTES / 1024 / 1024) + 'MB）', 'BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(buffer) {
  try {
    return JSON.parse(buffer.toString('utf8').replace(/^﻿/, ''));
  } catch (e) {
    throw E.badRequest('请求体不是合法的 JSON', 'BAD_JSON');
  }
}

function query(req) {
  return new URL(req.url, 'http://localhost').searchParams;
}

/* ------------------------------ 配置项 ------------------------------ */

async function getConfig(req, res) {
  sendJson(res, 200, {
    ok: true,
    config: appService.limits(),
    publicBaseUrl: config.PUBLIC_BASE_URL
  });
}

/* ---------------------------- Application ---------------------------- */

async function listApplications(req, res) {
  sendJson(res, 200, { ok: true, data: await appService.list() });
}

async function createApplication(req, res) {
  const body = parseJsonBody(await readBody(req));
  const app = await appService.create(body.name);
  sendJson(res, 201, { ok: true, application: app });
}

async function getApplication(req, res, params) {
  const app = await appService.detail(params[0]);
  sendJson(res, 200, { ok: true, application: app });
}

async function updateApplication(req, res, params) {
  const body = parseJsonBody(await readBody(req));
  const app = await appService.rename(params[0], body.name);
  sendJson(res, 200, { ok: true, application: app });
}

async function deleteApplication(req, res, params) {
  const record = await appService.remove(params[0]);
  sendJson(res, 200, { ok: true, deleted: record });
}

async function setCurrentFile(req, res, params) {
  const body = parseJsonBody(await readBody(req));
  const app = await appService.setCurrentFile(params[0], body.fileId === undefined ? null : body.fileId);
  sendJson(res, 200, { ok: true, application: app });
}

async function getHistory(req, res, params) {
  const limit = Number(query(req).get('limit')) || config.HISTORY_PAGE_SIZE;
  const items = await historyStore.list(params[0], Math.min(limit, 500));
  sendJson(res, 200, { ok: true, history: items });
}

/* -------------------------------- File -------------------------------- */

async function listFiles(req, res, params) {
  sendJson(res, 200, { ok: true, data: await fileService.listFiles(params[0]) });
}

async function uploadFile(req, res, params) {
  const appId = params[0];
  const buffer = await readBody(req);
  const params_ = query(req);
  const contentType = String(req.headers['content-type'] || '').toLowerCase();

  let name = params_.get('name') || '';
  let content = buffer;
  let encoding = null;

  if (contentType.indexOf('application/json') >= 0 && buffer.length > 0) {
    const body = parseJsonBody(buffer);
    if (body && typeof body === 'object') {
      if (body.name) name = String(body.name);
      if (body.encoding === 'base64') encoding = 'base64';
      if (body.content !== undefined) content = body.content;
    }
  }

  const file = await fileService.upload({ appId, name, content, encoding });
  sendJson(res, 201, { ok: true, file });
}

async function getFileMeta(req, res, params) {
  sendJson(res, 200, { ok: true, file: await fileService.getMeta(params[0]) });
}

async function updateFileMeta(req, res, params) {
  const body = parseJsonBody(await readBody(req));
  const file = await fileService.rename({
    fileId: params[0],
    name: body.name,
    downloadName: body.downloadName
  });
  sendJson(res, 200, { ok: true, file });
}

async function deleteFile(req, res, params) {
  const force = query(req).get('force') === '1' || query(req).get('force') === 'true';
  const result = await fileService.remove({ fileId: params[0], force });
  sendJson(res, 200, { ok: true, deleted: result });
}

async function deleteAllFiles(req, res, params) {
  const result = await fileService.removeAll(params[0]);
  sendJson(res, 200, { ok: true, deleted: result });
}

async function getFileContent(req, res, params) {
  const { meta, content } = await fileService.getContent(params[0]);
  sendJson(res, 200, { ok: true, file: meta, content });
}

async function putFileContent(req, res, params) {
  const body = parseJsonBody(await readBody(req));
  const file = await fileService.updateContent({
    fileId: params[0],
    content: body.content,
    preserveFormat: body.preserveFormat
  });
  sendJson(res, 200, { ok: true, file });
}

async function duplicateFile(req, res, params) {
  const buffer = await readBody(req);
  let body = {};
  if (buffer.length > 0) body = parseJsonBody(buffer);
  const file = await fileService.saveAs({
    fileId: params[0],
    name: body.name,
    content: body.content,
    preserveFormat: body.preserveFormat
  });
  sendJson(res, 201, { ok: true, file });
}

/** 原始下载（带 Content-Disposition，走 Stream） */
async function downloadFile(req, res, params) {
  const { app, file } = await fileService.resolveFile(params[0]);
  const entityPath = paths.entity(app.id, file.id);
  const stat = await fileStore.stat(entityPath);
  if (!stat) throw E.notFound(MESSAGE.FILE_BROKEN, 'FILE_BROKEN');

  const etag = delivery.etagOf(file, stat);
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Access-Control-Allow-Origin': '*' });
    return res.end();
  }

  http.sendStream(res, 200, {
    'Content-Type': mime.contentTypeFor(file.downloadName || file.name),
    'Content-Length': stat.size,
    'Content-Disposition': delivery.contentDisposition(file.downloadName || file.name, true),
    'Cache-Control': 'no-cache',
    ETag: etag,
    'Last-Modified': stat.mtime.toUTCString()
  }, fileStore.openStream(entityPath));
}

/* ------------------------------- Trash ------------------------------- */

async function getTrash(req, res) {
  sendJson(res, 200, { ok: true, data: await trashService.list() });
}

async function clearTrash(req, res) {
  sendJson(res, 200, { ok: true, cleared: await trashService.clear() });
}

async function restoreTrashFile(req, res, params) {
  const file = await trashService.restoreFile(params[0]);
  sendJson(res, 200, { ok: true, file });
}

async function purgeTrashFile(req, res, params) {
  sendJson(res, 200, { ok: true, purged: await trashService.removeFile(params[0]) });
}

async function restoreTrashApp(req, res, params) {
  const result = await trashService.restoreApp(params[0]);
  sendJson(res, 200, { ok: true, application: result });
}

async function purgeTrashApp(req, res, params) {
  sendJson(res, 200, { ok: true, purged: await trashService.removeApp(params[0]) });
}

/* ------------------------------- 路由表 ------------------------------- */

const ROUTES = [
  ['GET', /^\/api\/config$/, getConfig],

  ['GET', /^\/api\/applications$/, listApplications],
  ['POST', /^\/api\/applications$/, createApplication],
  ['POST', /^\/api\/applications\/([^/]+)\/current-file$/, setCurrentFile],
  ['DELETE', /^\/api\/applications\/([^/]+)\/files$/, deleteAllFiles],
  ['GET', /^\/api\/applications\/([^/]+)\/files$/, listFiles],
  ['POST', /^\/api\/applications\/([^/]+)\/files$/, uploadFile],
  ['GET', /^\/api\/applications\/([^/]+)\/history$/, getHistory],
  ['GET', /^\/api\/applications\/([^/]+)$/, getApplication],
  ['PATCH', /^\/api\/applications\/([^/]+)$/, updateApplication],
  ['DELETE', /^\/api\/applications\/([^/]+)$/, deleteApplication],

  ['GET', /^\/api\/files\/([^/]+)\/content$/, getFileContent],
  ['PUT', /^\/api\/files\/([^/]+)\/content$/, putFileContent],
  ['GET', /^\/api\/files\/([^/]+)\/download$/, downloadFile],
  ['POST', /^\/api\/files\/([^/]+)\/duplicate$/, duplicateFile],
  ['GET', /^\/api\/files\/([^/]+)$/, getFileMeta],
  ['PATCH', /^\/api\/files\/([^/]+)$/, updateFileMeta],
  ['DELETE', /^\/api\/files\/([^/]+)$/, deleteFile],

  ['GET', /^\/api\/trash$/, getTrash],
  ['DELETE', /^\/api\/trash$/, clearTrash],
  ['POST', /^\/api\/trash\/apps\/restore\/([^/]+)$/, restoreTrashApp],
  ['DELETE', /^\/api\/trash\/apps\/([^/]+)$/, purgeTrashApp],
  ['POST', /^\/api\/trash\/restore\/([^/]+)$/, restoreTrashFile],
  ['DELETE', /^\/api\/trash\/([^/]+)$/, purgeTrashFile]
];

/** @returns {Promise<boolean>} 是否命中并处理了请求 */
async function handle(req, res, pathname) {
  for (const [method, pattern, handler] of ROUTES) {
    if (req.method !== method) continue;
    const match = pattern.exec(pathname);
    if (!match) continue;
    try {
      await handler(req, res, match.slice(1).map(decodeURIComponent));
    } catch (e) {
      sendError(res, e);
    }
    return true;
  }
  return false;
}

/** 新版接口命名空间内的未知路径才返回 404（不能吞掉旧版 /api/list 这类路径） */
function isApiPath(pathname) {
  return /^\/api\/(config|applications|files|trash)(\/|$)/.test(pathname);
}

function notFound(res) {
  sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: '接口不存在' });
}

module.exports = { handle, isApiPath, notFound, readBody, parseJsonBody };
