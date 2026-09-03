'use strict';

/** HTTP 响应工具：统一 CORS、JSON、错误与流式输出 */
const { AppError } = require('./errors');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj, null, 2), 'application/json; charset=utf-8');
}

/** 把任意异常翻译成面向用户的中文错误 */
function sendError(res, err) {
  if (err && err.name === 'AppError') {
    const body = { ok: false, code: err.code, error: err.message };
    if (err.details) body.details = err.details;
    return sendJson(res, err.status, body);
  }
  console.error('[error]', err);
  return sendJson(res, 500, { ok: false, code: 'INTERNAL_ERROR', error: '服务器内部错误' });
}

/** 流式响应：不把文件整体读进内存 */
function sendStream(res, status, headers, stream) {
  res.writeHead(status, Object.assign({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  }, headers));
  stream.on('error', () => {
    try { res.end(); } catch (e) { /* 连接可能已断开 */ }
  });
  stream.pipe(res);
}

function sendNoContent(res) {
  setCors(res);
  res.writeHead(204);
  res.end();
}

module.exports = { setCors, send, sendJson, sendError, sendStream, sendNoContent, AppError };
