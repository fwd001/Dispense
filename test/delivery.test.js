'use strict';

/**
 * 下发端点健壮性 + Content-Type 正确性（HTTP 端到端）
 *
 * 重点验证用户新增要求：
 *  - 未知链接 / 无当前文件 / 文件缺失 → 空 200，不报错、不崩溃
 *  - Content-Type 按下发名后缀决定，无后缀兜底 text/plain
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = path.join(os.tmpdir(), 'em-delivery-test-' + Date.now() + '-' + process.pid);
process.env.PORT = '0';

const { server, bootstrap } = require('../server');
const paths = require('../storage/paths');

let base = '';

async function req(method, url, body, headers) {
  const res = await fetch(base + url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

async function makeApp(name) {
  return (await req('POST', '/api/applications', { name })).json.application;
}
async function upload(app, name, content) {
  return (await req('POST', '/api/applications/' + app.id + '/files', { name, content })).json.file;
}
async function publish(app, fileId) {
  await req('POST', '/api/applications/' + app.id + '/current-file', { fileId });
}

test('启动服务', async () => {
  await bootstrap();
  await new Promise((resolve) => {
    if (server.listening) resolve();
    else server.once('listening', resolve);
  });
  base = 'http://127.0.0.1:' + server.address().port;
});

/* --------------------------- 内容类型按后缀 --------------------------- */

test('Content-Type：json / yaml / xml / js / csv / html / css / txt', async () => {
  const app = await makeApp('CtypeApp');
  const cases = [
    ['a.json', 'application/json'],
    ['a.yaml', 'application/yaml'],
    ['a.yml', 'application/yaml'],
    ['a.xml', 'application/xml'],
    ['a.js', 'text/javascript'],
    ['a.csv', 'text/csv'],
    ['a.html', 'text/html'],
    ['a.css', 'text/css'],
    ['a.txt', 'text/plain'],
    ['a.md', 'text/markdown']
  ];
  for (const [name, expected] of cases) {
    const file = await upload(app, name, JSON.stringify({ x: 1 }));
    await publish(app, file.id);
    const res = await req('GET', '/d/' + app.token);
    assert.match(res.headers.get('content-type'), new RegExp('^' + expected), name + ' 的 Content-Type 应为 ' + expected);
    await req('DELETE', '/api/files/' + file.id + '?force=1');
  }
});

test('Content-Type：无后缀（下发名无扩展名）兜底为 text/plain', async () => {
  const app = await makeApp('NoExtApp');
  const file = await upload(app, 'config.json', '{"v":1}');
  // 把下发名改成没有扩展名的样子
  await req('PATCH', '/api/files/' + file.id, { downloadName: 'config' });
  await publish(app, file.id);

  const res = await req('GET', '/d/' + app.token);
  assert.match(res.headers.get('content-type'), /text\/plain/, '无后缀应兜底 text/plain');
  assert.match(res.headers.get('content-disposition'), /filename="config"/, '应使用无后缀下发名');
});

test('Content-Type：真实文件是 json 但下发名无后缀 → 仍按下发名兜底 text/plain', async () => {
  const app = await makeApp('NoExt2App');
  const file = await upload(app, 'real-prod-2026.json', '{"x":true}');
  await req('PATCH', '/api/files/' + file.id, { downloadName: 'current' });
  await publish(app, file.id);
  const res = await req('GET', '/d/' + app.token);
  assert.match(res.headers.get('content-type'), /text\/plain/);
  assert.strictEqual(res.text, '{"x":true}', '内容不应被改变');
});

/* --------------------------- 健壮性：未知链接空响应 / 暂停与缺失 404 --------------------------- */

test('健壮性：未知链接返回空 200，不报错', async () => {
  const res = await req('GET', '/d/this-token-does-not-exist');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.text, '');
  assert.match(res.headers.get('content-type'), /text\/plain/);
});

test('健壮性：应用已暂停（未设当前文件）→ 404，不报 500', async () => {
  const app = await makeApp('NoCurrentApp');
  const res = await req('GET', '/d/' + app.token);
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.json.code, 'NO_CURRENT_FILE');
});

test('健壮性：当前文件实体缺失 → 404（不崩溃、不报 500）', async () => {
  const app = await makeApp('BrokenApp');
  const file = await upload(app, 'config.json', '{"a":1}');
  await publish(app, file.id);
  // 直接破坏磁盘实体，模拟「元数据在、文件不在」
  fs.unlinkSync(paths.entity(app.id, file.id));
  const res = await req('GET', '/d/' + app.token);
  assert.strictEqual(res.status, 404, '实体缺失应返回 404，而不是 500');
  assert.strictEqual(res.json.code, 'FILE_BROKEN');
});

test('健壮性：HEAD 请求未知链接也返回空 200', async () => {
  const res = await fetch(base + '/d/nope-nope', { method: 'HEAD' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('content-length'), '0');
});

test('健壮性：对未知链接的并发请求不会拖垮服务', async () => {
  const tokens = Array.from({ length: 60 }, (_, i) => 'missing-' + i + '-' + Date.now());
  const results = await Promise.all(tokens.map((t) => fetch(base + '/d/' + t)));
  for (const r of results) {
    assert.strictEqual(r.status, 200);
    assert.strictEqual(await r.text(), '');
  }
  // 服务仍然可用
  const ok = await req('GET', '/api/applications');
  assert.strictEqual(ok.status, 200);
});

test('健壮性：?dl=1 强制附件下载，响应头正确', async () => {
  const app = await makeApp('DlApp');
  const file = await upload(app, 'config-prod.json', '{"dl":true}');
  await req('PATCH', '/api/files/' + file.id, { downloadName: 'config.json' });
  await publish(app, file.id);
  const res = await req('GET', '/d/' + app.token + '?dl=1');
  assert.match(res.headers.get('content-disposition'), /attachment/);
  assert.match(res.headers.get('content-disposition'), /config\.json/);
});

test('关闭服务', async () => {
  await new Promise((resolve) => server.close(resolve));
  assert.ok(true);
});
