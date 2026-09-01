'use strict';

/*
 * 最简单的 JSON 管理服务
 * - 无第三方依赖（仅使用 Node.js 内置模块）
 * - 功能：上传 / 预览（生成链接）/ 删除 / 提交研判
 * - 存储：JSON 保存在项目本地 data/ 目录
 * - 部署：可用 PM2 保活（见 ecosystem.config.js）
 * - 端口：通过环境变量 PORT 配置（默认 3000）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');           // 存放 JSON
const INDEX_HTML = path.join(ROOT, 'public', 'index.html');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = 10 * 1024 * 1024; // 10MB

// 确保存储目录存在（服务启动即自动创建，最稳定）
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- 工具函数 ---------- */
function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    // 允许其它站点（如刷题应用）跨域读取 JSON
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}
function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj, null, 2), 'application/json; charset=utf-8');
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > MAX_BODY) { req.destroy(); reject(new Error('请求体过大')); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
// 清洗文件名：去掉扩展名，去除路径分隔符与 ..（防穿越），保留空格/括号/数字/中文
function cleanName(raw) {
  let n = String(raw || '').trim().replace(/\.json$/i, '');
  n = n.replace(/[\\/]+/g, ''); // 去斜杠
  n = n.replace(/\.\.+/g, '');  // 去掉 ..
  return n.trim();
}
// 生成不重名的文件名（mac 风格：已存在则追加 (2)、(3)…）
function uniqueName(dir, base) {
  if (!base) base = 'data';
  let candidate = base, i = 2;
  while (fs.existsSync(path.join(dir, candidate + '.json'))) {
    candidate = base + ' (' + i + ')';
    i++;
  }
  return candidate + '.json';
}
function listJson(dir) {
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort((a, b) => a.localeCompare(b, 'zh'));
}
// JSON.parse 前去除可能存在的 UTF-8 BOM（更稳健）
function parseJson(text) {
  return JSON.parse(String(text).replace(/^\uFEFF/, ''));
}

/* ---------- 服务 ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = url.pathname;

  if (req.method === 'OPTIONS') { send(res, 204, ''); return; }

  try {
    // 列出已上传的 JSON
    if (p === '/api/list' && req.method === 'GET') {
      const files = listJson(DATA_DIR);
      return sendJson(res, 200, { ok: true, count: files.length, files });
    }

    // 上传 JSON：body 既可以是原始 JSON，也可以是 { name, content }
    if (p === '/api/upload' && req.method === 'POST') {
      const body = await readBody(req);
      let name = '', content = body;
      const obj = parseJson(body);
      if (obj && typeof obj === 'object' && (obj.content !== undefined || obj.name)) {
        name = obj.name || '';
        content = typeof obj.content === 'string' ? obj.content : JSON.stringify(obj.content);
      }
      parseJson(content); // 校验必须为合法 JSON
      if (!name) {
        let parsed = parseJson(content);
        name = (parsed.meta && parsed.meta.title) || parsed.view || 'data';
        if (typeof name !== 'string' || !name) name = 'data';
      }
      name = cleanName(name) || 'data';
      const fileName = uniqueName(DATA_DIR, name);
      const file = path.join(DATA_DIR, fileName);
      fs.writeFileSync(file, content, 'utf8');
      return sendJson(res, 200, { ok: true, name: fileName, url: '/data/' + encodeURIComponent(fileName) });
    }

    // 读取某个 JSON 内容
    let m;
    if ((m = p.match(/^\/api\/file\/(.+)$/)) && req.method === 'GET') {
      const name = cleanName(decodeURIComponent(m[1]));
      const file = path.join(DATA_DIR, name + '.json');
      if (!fs.existsSync(file)) return sendJson(res, 404, { ok: false, error: '文件不存在' });
      return send(res, 200, fs.readFileSync(file, 'utf8'), 'application/json; charset=utf-8');
    }

    // 删除 JSON
    if ((m = p.match(/^\/api\/delete\/(.+)$/)) && req.method === 'DELETE') {
      const name = cleanName(decodeURIComponent(m[1]));
      const file = path.join(DATA_DIR, name + '.json');
      if (!fs.existsSync(file)) return sendJson(res, 404, { ok: false, error: '文件不存在' });
      fs.unlinkSync(file);
      return sendJson(res, 200, { ok: true, deleted: name + '.json' });
    }

    // 【预览链接】直接以只读方式返回 data/ 下的 JSON（带 CORS，可被前端跨域导入）
    if ((m = p.match(/^\/data\/(.+)$/))) {
      const name = cleanName(decodeURIComponent(m[1]));
      const file = path.join(DATA_DIR, name + '.json');
      if (!fs.existsSync(file)) return send(res, 404, 'not found');
      return send(res, 200, fs.readFileSync(file, 'utf8'), 'application/json; charset=utf-8');
    }

    // 静态页面：仅提供 public/index.html
    const staticPath = (p === '/') ? '/index.html' : p;
    if (staticPath === '/index.html' && fs.existsSync(INDEX_HTML)) {
      return send(res, 200, fs.readFileSync(INDEX_HTML), 'text/html; charset=utf-8');
    }

    return send(res, 404, 'Not Found');
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: e.message });
  }
});

// 稳定性：捕获异常避免进程意外退出（PM2 亦会自动重启）
process.on('uncaughtException', e => console.error('[uncaughtException]', e));
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));

server.listen(PORT, HOST, () => {
  console.log('JSON 管理服务已启动: http://localhost:' + PORT);
  console.log('数据目录: ' + DATA_DIR);
});
