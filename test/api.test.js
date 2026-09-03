'use strict';

/**
 * HTTP 端到端测试：下发链接 / 下载 / 回收站 / 旧版接口兼容性
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = path.join(os.tmpdir(), 'em-api-test-' + Date.now() + '-' + process.pid);
process.env.PORT = '0';

const { server, bootstrap } = require('../server');

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

test('启动服务', async (t) => {
  await bootstrap();
  await new Promise((resolve) => {
    if (server.listening) resolve();
    else server.once('listening', resolve);
  });
  base = 'http://127.0.0.1:' + server.address().port;
  assert.ok(base.includes('127.0.0.1'));
});

test('配置项接口：把限制暴露给前端', async () => {
  const { status, json } = await req('GET', '/api/config');
  assert.strictEqual(status, 200);
  assert.ok(json.config.maxApplications >= 1);
  assert.ok(json.config.maxFileSize > 0);
  assert.ok(Array.isArray(json.config.allowedExtensions));
});

test('静态页面可访问', async () => {
  const index = await req('GET', '/');
  assert.strictEqual(index.status, 200);
  assert.ok(index.text.includes('配置下发器'));

  const css = await req('GET', '/app.css');
  assert.strictEqual(css.status, 200);
  const js = await req('GET', '/app.js');
  assert.strictEqual(js.status, 200);
});

test('静态目录穿越被拒绝', async () => {
  const res = await req('GET', '/../package.json');
  assert.ok([403, 404].includes(res.status));
});

/* --------------------------- 下发接口 /d/:token --------------------------- */

test('下发：应用已暂停（未设当前文件）时返回 404 与明确提示', async () => {
  const app = (await req('POST', '/api/applications', { name: 'DeliveryApp' })).json.application;
  const res = await req('GET', '/d/' + app.token);
  assert.strictEqual(res.status, 404, '暂停下发应返回 404');
  assert.strictEqual(res.json.code, 'NO_CURRENT_FILE');
  assert.strictEqual(res.json.error, '当前没有可下发文件');
});

test('下发：URL 永久不变，切换文件即切换内容', async () => {
  const app = (await req('POST', '/api/applications', { name: 'SwitchApp' })).json.application;

  const a = (await req('POST', '/api/applications/' + app.id + '/files', {
    name: 'config.json', content: '{"env":"A"}'
  })).json.file;
  const b = (await req('POST', '/api/applications/' + app.id + '/files', {
    name: 'config.json', content: '{"env":"B"}'
  })).json.file;

  await req('POST', '/api/applications/' + app.id + '/current-file', { fileId: a.id });
  let res = await req('GET', '/d/' + app.token);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.text, '{"env":"A"}');

  await req('POST', '/api/applications/' + app.id + '/current-file', { fileId: b.id });
  res = await req('GET', '/d/' + app.token);
  assert.strictEqual(res.text, '{"env":"B"}', '同一 URL 应返回新内容');
});

test('下发：响应头正确（Content-Type / Disposition / ETag / Cache-Control / CORS）', async () => {
  const app = (await req('POST', '/api/applications', { name: 'HeaderApp' })).json.application;
  const file = (await req('POST', '/api/applications/' + app.id + '/files', {
    name: 'config-prod-2026.json', content: '{"ok":true}'
  })).json.file;

  // 自定义下发名
  await req('PATCH', '/api/files/' + file.id, { downloadName: 'config.json' });
  await req('POST', '/api/applications/' + app.id + '/current-file', { fileId: file.id });

  const res = await req('GET', '/d/' + app.token);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.match(res.headers.get('content-disposition'), /filename="config\.json"/, '应使用下发名');
  assert.ok(res.headers.get('etag'));
  assert.ok(res.headers.get('last-modified'));
  assert.match(res.headers.get('cache-control'), /no-cache/);
  assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');

  // ETag 命中 → 304
  const etag = res.headers.get('etag');
  const cached = await req('GET', '/d/' + app.token, undefined, { 'If-None-Match': etag });
  assert.strictEqual(cached.status, 304);
});

test('下发：未知链接返回空 200（健壮，不报错）', async () => {
  const res = await req('GET', '/d/not-a-real-token');
  assert.strictEqual(res.status, 200, '未知链接应正常返回空响应，而不是报错');
  assert.strictEqual(res.text, '', '空响应');
  assert.match(res.headers.get('content-type'), /text\/plain/);
});

test('下发：HEAD 请求可用', async () => {
  const app = (await req('POST', '/api/applications', { name: 'HeadApp' })).json.application;
  const file = (await req('POST', '/api/applications/' + app.id + '/files', {
    name: 'a.txt', content: 'hello'
  })).json.file;
  await req('POST', '/api/applications/' + app.id + '/current-file', { fileId: file.id });

  const res = await fetch(base + '/d/' + app.token, { method: 'HEAD' });
  assert.strictEqual(res.status, 200);
  assert.ok(res.headers.get('content-length'));
});

/* --------------------------- 文件下载 --------------------------- */

test('下载接口：以附件形式返回并使用下发名', async () => {
  const app = (await req('POST', '/api/applications', { name: 'DownloadApp' })).json.application;
  const file = (await req('POST', '/api/applications/' + app.id + '/files', {
    name: 'real-name.json', content: '{"v":1}'
  })).json.file;
  await req('PATCH', '/api/files/' + file.id, { downloadName: 'client-config.json' });

  const res = await req('GET', '/api/files/' + file.id + '/download');
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment/);
  assert.match(res.headers.get('content-disposition'), /client-config\.json/);
  assert.strictEqual(res.text, '{"v":1}');
});

/* --------------------------- 回收站（HTTP） --------------------------- */

test('回收站：删除 → 列表 → 恢复 → 清空', async () => {
  const app = (await req('POST', '/api/applications', { name: 'TrashApp' })).json.application;
  const file = (await req('POST', '/api/applications/' + app.id + '/files', {
    name: 't.json', content: '{"t":1}'
  })).json.file;

  await req('DELETE', '/api/files/' + file.id);
  let trash = (await req('GET', '/api/trash')).json.data;
  assert.ok(trash.files.some((f) => f.fileId === file.id));
  assert.ok(trash.files[0].purgeAt > trash.files[0].deletedAt, '应有自动清理时间');

  const restored = await req('POST', '/api/trash/restore/' + file.id);
  assert.strictEqual(restored.status, 200);
  assert.strictEqual(restored.json.file.appId, app.id);

  // 再删一次然后永久删除
  await req('DELETE', '/api/files/' + file.id);
  const purged = await req('DELETE', '/api/trash/' + file.id);
  assert.strictEqual(purged.status, 200);
  trash = (await req('GET', '/api/trash')).json.data;
  assert.ok(!trash.files.some((f) => f.fileId === file.id));
});

test('回收站：清空是永久删除', async () => {
  const app = (await req('POST', '/api/applications', { name: 'ClearApp' })).json.application;
  await req('POST', '/api/applications/' + app.id + '/files', { name: 'x.json', content: '{}' });
  await req('DELETE', '/api/applications/' + app.id);

  const before = (await req('GET', '/api/trash')).json.data;
  assert.ok(before.applications.length > 0 || before.files.length > 0);

  const cleared = await req('DELETE', '/api/trash');
  assert.strictEqual(cleared.status, 200);
  const after = (await req('GET', '/api/trash')).json.data;
  assert.strictEqual(after.files.length, 0);
  assert.strictEqual(after.applications.length, 0);
});

/* --------------------------- 旧版接口兼容性 --------------------------- */

test('旧版接口：/api/upload + /api/list + /data/:name 行为保持不变', async () => {
  const upload = await req('POST', '/api/upload', { name: 'legacy-bank', content: '{"view":"exam-bank","n":1}' });
  assert.strictEqual(upload.status, 200);
  assert.strictEqual(upload.json.ok, true);
  assert.ok(upload.json.url.startsWith('/data/'));

  const list = await req('GET', '/api/list');
  assert.strictEqual(list.status, 200);
  assert.ok(list.json.files.includes('legacy-bank.json'));

  const preview = await req('GET', '/data/legacy-bank.json');
  assert.strictEqual(preview.status, 200);
  assert.strictEqual(JSON.parse(preview.text).view, 'exam-bank');

  const legacyFile = await req('GET', '/api/file/legacy-bank');
  assert.strictEqual(legacyFile.status, 200);
});

test('旧版接口：/api/delete 仍然可用', async () => {
  const res = await req('DELETE', '/api/delete/legacy-bank');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.ok, true);
});

test('关闭服务', async () => {
  await new Promise((resolve) => server.close(resolve));
  assert.ok(true);
});
