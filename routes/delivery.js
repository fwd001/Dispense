'use strict';

/**
 * 下发接口：GET /d/:token
 *
 * token → Application → currentFileId → File → 实体文件 → Stream
 * 全程索引定位，不扫描目录；响应使用 Node Stream，不把文件读进内存。
 *
 * 响应策略（公开端点，绝不崩溃）：
 *  - 链接不存在（token 查不到应用）→ 空响应（200 + 空 body + text/plain）
 *  - 应用存在但「暂停下发」（未设当前文件）/ 文件实体缺失 → 404 + 明确错误码
 *  - 任何意外异常 → 空响应（200 + 空 body），保证不报 500、不崩溃
 */
const http = require('../lib/http');
const delivery = require('../services/deliveryService');
const fileStore = require('../storage/fileStore');
const mime = require('../lib/mime');

const PATTERN = /^\/d\/([^/]+)$/;

/** 空响应：链接不存在时返回，保证公开端点不报错、不崩溃 */
function sendEmpty(res) {
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': 0,
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*'
  });
  res.end();
  return true;
}

/** @returns {Promise<boolean>} 是否命中 */
async function handle(req, res, pathname) {
  const match = PATTERN.exec(pathname);
  if (!match) return false;

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    http.sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: '仅支持 GET' });
    return true;
  }

  const token = decodeURIComponent(match[1]);
  try {
    const result = await delivery.resolve(token);
    if (!result.ok) {
      // 链接不存在 → 空响应（不报错）；暂停下发 / 文件缺失 → 404 + 明确错误码
      if (result.reason === 'TOKEN_NOT_FOUND') return sendEmpty(res);
      http.sendJson(res, 404, { ok: false, code: result.reason, error: result.message });
      return true;
    }

    const { file, entityPath, stat } = result;
    const name = file.downloadName || file.name;
    const etag = delivery.etagOf(file, stat);

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, {
        ETag: etag,
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*'
      });
      return res.end(), true;
    }

    const headers = {
      'Content-Type': mime.contentTypeFor(name),
      'Content-Length': stat.size,
      'Content-Disposition': delivery.contentDisposition(name, req.url.indexOf('dl=1') >= 0),
      // 配置下发要求「改了就立即生效」，因此允许缓存但每次必须回源校验
      'Cache-Control': 'no-cache, must-revalidate',
      ETag: etag,
      'Last-Modified': stat.mtime.toUTCString(),
      'X-Application-Name': encodeURIComponent(result.app.name || ''),
      'X-File-Name': encodeURIComponent(file.name || '')
    };

    if (req.method === 'HEAD') {
      http.setCors(res);
      res.writeHead(200, Object.assign({}, headers, { 'Content-Length': stat.size }));
      return res.end(), true;
    }

    http.sendStream(res, 200, headers, fileStore.openStream(entityPath));
    return true;
  } catch (e) {
    // 任何意外都降级为空响应，保证下发端点健壮
    console.error('[delivery] 下发异常，降级为空响应:', e && e.message);
    return sendEmpty(res);
  }
}

module.exports = { handle };
