'use strict';

/**
 * 旧版接口：行为与改造前完全一致，保证已有「远程导入」链接继续可用。
 * 操作的是 data/ 根目录下的扁平 *.json，与新结构互不干扰。
 *
 * 保留：
 *   GET    /api/list
 *   POST   /api/upload
 *   GET    /api/file/:name
 *   DELETE /api/delete/:name
 *   GET    /data/:name.json
 */
const fs = require('fs');
const path = require('path');
const http = require('../lib/http');
const config = require('../config');

const DATA_DIR = config.DATA_DIR;
const { send, sendJson } = http;

function cleanName(raw) {
  let n = String(raw || '').trim().replace(/\.json$/i, '');
  n = n.replace(/[\\/]+/g, '');
  n = n.replace(/\.\.+/g, '');
  return n.trim();
}

function uniqueName(dir, base) {
  if (!base) base = 'data';
  let candidate = base;
  let i = 2;
  while (fs.existsSync(path.join(dir, candidate + '.json'))) {
    candidate = base + ' (' + i + ')';
    i += 1;
  }
  return candidate + '.json';
}

function listJson(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort((a, b) => a.localeCompare(b, 'zh'));
}

function parseJson(text) {
  return JSON.parse(String(text).replace(/^﻿/, ''));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > config.MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('请求体过大'));
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/** @returns {Promise<boolean>} 是否命中 */
async function handle(req, res, pathname) {
  let match;

  if (pathname === '/api/list' && req.method === 'GET') {
    const files = listJson(DATA_DIR);
    return sendJson(res, 200, { ok: true, count: files.length, files }), true;
  }

  if (pathname === '/api/upload' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      let name = '';
      let content = body;
      const obj = parseJson(body);
      if (obj && typeof obj === 'object' && (obj.content !== undefined || obj.name)) {
        name = obj.name || '';
        content = typeof obj.content === 'string' ? obj.content : JSON.stringify(obj.content);
      }
      parseJson(content);
      if (!name) {
        const parsed = parseJson(content);
        name = (parsed.meta && parsed.meta.title) || parsed.view || 'data';
        if (typeof name !== 'string' || !name) name = 'data';
      }
      name = cleanName(name) || 'data';
      const fileName = uniqueName(DATA_DIR, name);
      fs.writeFileSync(path.join(DATA_DIR, fileName), content, 'utf8');
      return sendJson(res, 200, { ok: true, name: fileName, url: '/data/' + encodeURIComponent(fileName) }), true;
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message }), true;
    }
  }

  if ((match = /^\/api\/file\/(.+)$/.exec(pathname)) && req.method === 'GET') {
    const name = cleanName(decodeURIComponent(match[1]));
    const file = path.join(DATA_DIR, name + '.json');
    if (!fs.existsSync(file)) return sendJson(res, 404, { ok: false, error: '文件不存在' }), true;
    return send(res, 200, fs.readFileSync(file, 'utf8'), 'application/json; charset=utf-8'), true;
  }

  if ((match = /^\/api\/delete\/(.+)$/.exec(pathname)) && req.method === 'DELETE') {
    const name = cleanName(decodeURIComponent(match[1]));
    const file = path.join(DATA_DIR, name + '.json');
    if (!fs.existsSync(file)) return sendJson(res, 404, { ok: false, error: '文件不存在' }), true;
    fs.unlinkSync(file);
    return sendJson(res, 200, { ok: true, deleted: name + '.json' }), true;
  }

  if ((match = /^\/data\/(.+)$/.exec(pathname))) {
    const name = cleanName(decodeURIComponent(match[1]));
    const file = path.join(DATA_DIR, name + '.json');
    if (!fs.existsSync(file)) return send(res, 404, 'not found'), true;
    return send(res, 200, fs.readFileSync(file, 'utf8'), 'application/json; charset=utf-8'), true;
  }

  return false;
}

module.exports = { handle };
