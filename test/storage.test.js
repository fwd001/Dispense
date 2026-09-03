'use strict';

/**
 * 业务集成测试：Application / File / 发布 / 编辑 / 回收站 / 历史 / 重启恢复
 * 全部跑在临时目录里，不污染真实 data/
 */
const test = require('node:test');
const assert = require('node:assert');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = path.join(os.tmpdir(), 'em-storage-test-' + Date.now() + '-' + process.pid);
process.env.MAX_APPLICATIONS = '3';
process.env.MAX_FILES_PER_APPLICATION = '50';
process.env.MAX_TOTAL_FILES = '200';
process.env.MAX_FILE_SIZE_MB = '1';

const paths = require('../storage/paths');
const fsx = require('../lib/fsx');
const appStore = require('../storage/appStore');
const historyStore = require('../storage/historyStore');
const trashStore = require('../storage/trashStore');
const integrity = require('../storage/integrity');
const appService = require('../services/appService');
const fileService = require('../services/fileService');
const trashService = require('../services/trashService');

/** 贯穿多个用例的主应用 */
let mainApp = null;

/* ------------------------- 准备 ------------------------- */

test('准备：初始化存储目录', async () => {
  await paths.ensureLayout();
  await appStore.init();
  assert.ok(await fsp.stat(paths.DATA).then(() => true).catch(() => false));
});

/* ------------------------- Application ------------------------- */

test('创建应用：生成不可猜测的 token，不暴露内部 id', async () => {
  mainApp = await appService.create('MyApp');
  assert.ok(mainApp.id.startsWith('app_'));
  assert.ok(mainApp.token.length >= 10);
  assert.ok(!mainApp.token.includes(mainApp.id));
  assert.strictEqual(mainApp.currentFileId, null);
  assert.deepStrictEqual(mainApp.files, []);
});

test('创建重复名称应用：拒绝并给出明确错误', async () => {
  await assert.rejects(() => appService.create('MyApp'), (err) => {
    assert.strictEqual(err.code, 'APP_NAME_DUPLICATE');
    assert.strictEqual(err.message, '应用名称已存在');
    return true;
  });
});

test('超过应用数量上限：禁止创建（上限来自环境变量 MAX_APPLICATIONS=3）', async () => {
  await appService.create('App2');
  await appService.create('App3');
  assert.strictEqual((await appService.list()).applications.length, 3);
  await assert.rejects(() => appService.create('App4'), (err) => {
    assert.strictEqual(err.code, 'APP_LIMIT');
    assert.match(err.message, /已达到应用数量上限（最多 3 个应用）/);
    return true;
  });
});

test('应用不存在：返回明确错误', async () => {
  await assert.rejects(() => appService.detail('app_not_exist'), /应用不存在/);
});

/* ------------------------------ File ------------------------------ */

test('上传：文件名冲突自动编号，连续上传依次为 (1) (2) (3)', async () => {
  const names = [];
  for (let i = 0; i < 4; i += 1) {
    const file = await fileService.upload({
      appId: mainApp.id,
      name: 'config.json',
      content: JSON.stringify({ v: i })
    });
    names.push(file.name);
  }
  assert.deepStrictEqual(names, [
    'config.json', 'config(1).json', 'config(2).json', 'config(3).json'
  ]);
});

test('上传：删除中间一个造成缺号，再上传应补最小空缺编号', async () => {
  const list = await fileService.listFiles(mainApp.id);
  const victim = list.files.find((f) => f.name === 'config(2).json');
  await fileService.remove({ fileId: victim.id });

  const file = await fileService.upload({
    appId: mainApp.id,
    name: 'config.json',
    content: '{"v":9}'
  });
  assert.strictEqual(file.name, 'config(2).json');
});

test('上传：默认不改变当前下发文件（上传 ≠ 发布）', async () => {
  const detail = await appService.detail(mainApp.id);
  assert.strictEqual(detail.currentFileId, null);
});

test('上传：非法 JSON 被拒绝，并带行列位置', async () => {
  await assert.rejects(
    () => fileService.upload({ appId: mainApp.id, name: 'broken.json', content: '{"a":1,}' }),
    (err) => {
      assert.strictEqual(err.code, 'JSON_INVALID');
      assert.match(err.message, /JSON 格式错误/);
      assert.ok(err.details && err.details.line >= 1 && err.details.column >= 1);
      return true;
    }
  );
});

test('上传：路径穿越被拦截，文件名只能影响文件名', async () => {
  const file = await fileService.upload({
    appId: mainApp.id,
    name: '../../../etc/passwd',
    content: 'x'
  });
  assert.ok(!file.name.includes('/'));
  assert.ok(!file.name.includes('\\'));
  assert.ok(!file.name.includes('..'));
  const entity = paths.entity(mainApp.id, file.id);
  assert.ok(entity.startsWith(paths.appFilesDir(mainApp.id)), '实体必须落在应用目录内');
});

test('上传：超过单文件大小限制被拒绝', async () => {
  await assert.rejects(
    () => fileService.upload({ appId: mainApp.id, name: 'big.txt', content: 'x'.repeat(1024 * 1024 + 10) }),
    (err) => {
      assert.strictEqual(err.code, 'FILE_TOO_LARGE');
      assert.match(err.message, /文件大小超过限制（最大 1MB）/);
      return true;
    }
  );
});

test('文件列表：按创建时间倒序，同毫秒用 seq 兜底', async () => {
  const { files } = await fileService.listFiles(mainApp.id);
  assert.ok(files.length >= 4);
  for (let i = 1; i < files.length; i += 1) {
    assert.ok(files[i - 1].createdAt >= files[i].createdAt);
    if (files[i - 1].createdAt === files[i].createdAt) {
      assert.ok(files[i - 1].seq > files[i].seq);
    }
  }
});

/* ---------------------------- 发布 / 切换 ---------------------------- */

test('发布：切换当前下发文件，URL（token）始终不变', async () => {
  const { files } = await fileService.listFiles(mainApp.id);
  const a = files.find((f) => f.name === 'config.json');
  const b = files.find((f) => f.name === 'config(1).json');

  await appService.setCurrentFile(mainApp.id, a.id);
  let current = await appStore.get(mainApp.id);
  assert.strictEqual(current.currentFileId, a.id);
  assert.strictEqual(current.token, mainApp.token);

  await appService.setCurrentFile(mainApp.id, b.id);
  current = await appStore.get(mainApp.id);
  assert.strictEqual(current.currentFileId, b.id);
  assert.strictEqual(current.token, mainApp.token, '切换文件绝不能改变下发链接');
});

test('发布：可以暂停下发（currentFileId = null）', async () => {
  await appService.setCurrentFile(mainApp.id, null);
  assert.strictEqual((await appStore.get(mainApp.id)).currentFileId, null);
});

/* ------------------------------ 编辑 ------------------------------ */

test('编辑：保存并覆盖，内容真正落盘', async () => {
  const { files } = await fileService.listFiles(mainApp.id);
  const target = files.find((f) => f.name === 'config.json');
  await fileService.updateContent({ fileId: target.id, content: '{"v":100}' });
  const { content } = await fileService.getContent(target.id);
  assert.strictEqual(content, '{"v":100}');
});

test('编辑：JSON 非法时禁止保存，且不破坏原内容', async () => {
  const { files } = await fileService.listFiles(mainApp.id);
  const target = files.find((f) => f.name === 'config.json');
  await assert.rejects(
    () => fileService.updateContent({ fileId: target.id, content: '{"a":}' }),
    (err) => {
      assert.strictEqual(err.code, 'JSON_INVALID');
      return true;
    }
  );
  const { content } = await fileService.getContent(target.id);
  assert.strictEqual(content, '{"v":100}');
});

test('编辑：保持原始换行符，不让 LF 悄悄变成 CRLF', async () => {
  const created = await fileService.upload({
    appId: mainApp.id, name: 'crlf.txt', content: 'line1\r\nline2\r\n'
  });
  await fileService.updateContent({ fileId: created.id, content: 'line1\nline2\nnew\n' });
  const { content } = await fileService.getContent(created.id);
  assert.strictEqual(content, 'line1\r\nline2\r\nnew\r\n');
});

test('编辑：保留 BOM 与 LF，不增删结尾换行', async () => {
  const created = await fileService.upload({
    appId: mainApp.id, name: 'bom.txt', content: '﻿hello\nworld\n'
  });
  await fileService.updateContent({ fileId: created.id, content: '﻿hello\n中文\n' });
  const { content } = await fileService.getContent(created.id);
  assert.strictEqual(content.charCodeAt(0), 0xFEFF, 'BOM 应保留');
  assert.ok(!content.includes('\r'), 'LF 文件不该被改成 CRLF');
  assert.ok(content.endsWith('\n'), '结尾换行不该被删除');
});

test('编辑：中文与 Unicode 正常往返', async () => {
  const created = await fileService.upload({
    appId: mainApp.id, name: 'unicode.json', content: '{"name":"付文东"}'
  });
  await fileService.updateContent({
    fileId: created.id,
    content: '{"name":"付文东","emoji":"🚀","mix":"a中1"}'
  });
  const { content } = await fileService.getContent(created.id);
  const parsed = JSON.parse(content);
  assert.strictEqual(parsed.name, '付文东');
  assert.strictEqual(parsed.emoji, '🚀');
});

test('重命名：文件名与下发名称分别校验唯一性', async () => {
  const { files } = await fileService.listFiles(mainApp.id);
  const target = files.find((f) => f.name === 'crlf.txt');
  const other = files.find((f) => f.name === 'bom.txt');

  await fileService.rename({ fileId: target.id, name: 'renamed.txt' });
  assert.strictEqual((await fileService.getMeta(target.id)).name, 'renamed.txt');

  await assert.rejects(() => fileService.rename({ fileId: target.id, name: other.name }), (err) => {
    assert.strictEqual(err.code, 'FILE_NAME_DUPLICATE');
    return true;
  });
  await assert.rejects(
    () => fileService.rename({ fileId: target.id, downloadName: other.downloadName }),
    (err) => {
      assert.strictEqual(err.code, 'DOWNLOAD_NAME_DUPLICATE');
      return true;
    }
  );
  // 路径穿越不是报错，而是被清洗成安全文件名
  const escaped = await fileService.rename({ fileId: target.id, name: '../../escape.txt' });
  assert.ok(!escaped.name.includes('..'), '穿越片段必须被清除');
  assert.ok(!escaped.name.includes('/') && !escaped.name.includes('\\'));
  assert.ok(escaped.name.endsWith('.txt'));
});

test('另存为：生成新文件且不覆盖原文件，遵循最小可用序号', async () => {
  const { files } = await fileService.listFiles(mainApp.id);
  const target = files.find((f) => f.name === 'config(1).json');
  const before = await fileService.getContent(target.id);

  const copy = await fileService.saveAs({ fileId: target.id });
  assert.strictEqual(copy.name, 'config(1)(1).json');
  assert.notStrictEqual(copy.id, target.id);
  assert.strictEqual((await fileService.getContent(target.id)).content, before.content);
});

test('另存为：可用编辑器中的内容创建新文件', async () => {
  const { files } = await fileService.listFiles(mainApp.id);
  const target = files.find((f) => f.name === 'config.json');
  const copy = await fileService.saveAs({ fileId: target.id, content: '{"edited":true}' });
  assert.strictEqual((await fileService.getContent(copy.id)).content, '{"edited":true}');
  assert.notStrictEqual((await fileService.getContent(target.id)).content, '{"edited":true}');
});

/* ------------------------------ 删除 ------------------------------ */

test('删除：普通文件进入回收站而不是被物理删除', async () => {
  const { files } = await fileService.listFiles(mainApp.id);
  const victim = files.find((f) => f.name === 'unicode.json');
  const entity = paths.entity(mainApp.id, victim.id);

  await fileService.remove({ fileId: victim.id });

  assert.strictEqual(await fsx.exists(entity), false, '原位置应清空');
  assert.strictEqual(await fsx.exists(paths.trashEntity(victim.id)), true, '实体应躺在回收站');
  const trash = await trashService.list();
  assert.ok(trash.files.some((f) => f.fileId === victim.id));
});

test('删除：正在下发的文件默认被拦截，并给出可切换的候选', async () => {
  const { files } = await fileService.listFiles(mainApp.id);
  const target = files[0];
  await appService.setCurrentFile(mainApp.id, target.id);

  await assert.rejects(() => fileService.remove({ fileId: target.id }), (err) => {
    assert.strictEqual(err.code, 'DELETE_CURRENT_FILE');
    assert.ok(Array.isArray(err.details.alternatives));
    assert.ok(err.details.alternatives.length > 0);
    assert.ok(err.details.alternatives.every((a) => a.id !== target.id));
    return true;
  });

  await fileService.remove({ fileId: target.id, force: true });
  assert.strictEqual((await appStore.get(mainApp.id)).currentFileId, null, '强删后应暂停下发');
});

test('恢复：回到原应用，重名时按最小可用序号重命名', async () => {
  const trash = await trashService.list();
  const item = trash.files.find((f) => f.appId === mainApp.id);
  const restored = await trashService.restoreFile(item.fileId);
  assert.strictEqual(restored.appId, mainApp.id);
  assert.ok((await fileService.listFiles(mainApp.id)).files.some((f) => f.id === item.fileId));
  assert.ok(!(await trashService.list()).files.some((f) => f.fileId === item.fileId));
});

test('删除全部文件：应用保留，文件全部进回收站，下发暂停', async () => {
  const before = await fileService.listFiles(mainApp.id);
  await fileService.removeAll(mainApp.id);

  const after = await fileService.listFiles(mainApp.id);
  assert.strictEqual(after.files.length, 0);
  assert.strictEqual(after.currentFileId, null);
  assert.strictEqual((await appService.detail(mainApp.id)).id, mainApp.id, '应用本身必须保留');
  assert.ok((await trashService.list()).files.length >= before.files.length);
});

/* ---------------------------- 历史记录 ---------------------------- */

test('历史：记录关键事件并按时间倒序返回', async () => {
  const history = await historyStore.list(mainApp.id, 50);
  const types = history.map((h) => h.type);
  ['app_created', 'upload', 'set_current', 'unset_current', 'edit', 'delete'].forEach((type) => {
    assert.ok(types.includes(type), '历史应包含 ' + type);
  });
  for (let i = 1; i < history.length; i += 1) {
    assert.ok(history[i - 1].ts >= history[i].ts);
  }
});

/* ---------------------------- 应用删除 ---------------------------- */

test('删除应用：应用与文件都进回收站，索引移除', async () => {
  const before = await trashService.list();
  await appService.remove(mainApp.id);

  assert.ok(!(await appService.list()).applications.some((a) => a.id === mainApp.id));
  const after = await trashService.list();
  assert.ok(after.applications.some((a) => a.id === mainApp.id));
  assert.ok(after.files.length >= before.files.length);
});

test('恢复应用：应用重新可访问，token 未变', async () => {
  const record = (await trashService.list()).applications.find((a) => a.id === mainApp.id);
  await trashService.restoreApp(record.id);

  const apps = await appService.list();
  const restored = apps.applications.find((a) => a.id === mainApp.id);
  assert.ok(restored, '应用应重新出现在列表里');
  assert.strictEqual(restored.token, mainApp.token, 'token 必须保持不变');
});

/* -------------------------- 自动清理边界 -------------------------- */

test('回收站自动清理：满 7 天清理，差 1 小时不清理', async () => {
  await fsp.mkdir(paths.TRASH_FILES, { recursive: true });
  const now = Date.now();

  const old = {
    fileId: 'file_old0000000000', appId: 'app_zzz', appName: 'z',
    name: 'old.txt', downloadName: 'old.txt', size: 3, ext: 'txt',
    mime: 'text/plain', seq: 1,
    createdAt: new Date(now).toISOString(),
    deletedAt: new Date(now - 7 * 24 * 3600 * 1000).toISOString(),
    purgeAt: new Date(now - 1000).toISOString(),
    deletedBy: 'user'
  };
  const young = Object.assign({}, old, {
    fileId: 'file_young00000000',
    name: 'young.txt',
    deletedAt: new Date(now - (7 * 24 - 1) * 3600 * 1000).toISOString(),
    purgeAt: new Date(now + 3600 * 1000).toISOString()
  });

  await fsp.writeFile(paths.trashRecord(old.fileId), JSON.stringify(old));
  await fsp.writeFile(paths.trashRecord(young.fileId), JSON.stringify(young));
  await fsp.writeFile(paths.trashEntity(old.fileId), 'old');
  await fsp.writeFile(paths.trashEntity(young.fileId), 'young');

  const purged = await trashStore.purgeExpiredFiles(now);
  assert.strictEqual(purged.length, 1, '只清理过期的那一个');
  assert.strictEqual(purged[0].fileId, old.fileId);
  assert.strictEqual(await fsx.exists(paths.trashRecord(young.fileId)), true, '未过期必须保留');

  await trashStore.removeFile(young.fileId);
});

/* ---------------------------- 重启恢复 ---------------------------- */

test('重启恢复：索引可从 apps/ 目录完整重建', async () => {
  const before = await appService.list();
  // 模拟异常退出导致索引丢失
  await fsp.rm(paths.indexApps, { force: true });
  await fsp.rm(paths.indexTokens, { force: true });
  await fsp.rm(paths.indexFiles, { force: true });

  const report = await integrity.run({ verbose: false });
  assert.strictEqual(report.applications, before.applications.length);

  const after = await appService.list();
  assert.strictEqual(after.applications.length, before.applications.length);
});

test('重启恢复：token 反查仍然可用（下发链接不失效）', async () => {
  const { applications } = await appService.list();
  assert.ok(applications.length >= 1);
  for (const summary of applications) {
    const app = await appStore.getByToken(summary.token);
    assert.ok(app, 'token 应能反查到应用');
    assert.strictEqual(app.id, summary.id);
  }
});
