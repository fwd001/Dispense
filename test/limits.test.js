'use strict';

/**
 * 数量上限测试：单独一个进程，用极小的阈值验证限制确实生效且可配置。
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = path.join(os.tmpdir(), 'em-limits-test-' + Date.now() + '-' + process.pid);
process.env.MAX_APPLICATIONS = '2';
process.env.MAX_FILES_PER_APPLICATION = '2';
process.env.MAX_TOTAL_FILES = '3';

const appStore = require('../storage/appStore');
const appService = require('../services/appService');
const fileService = require('../services/fileService');

test('初始化', async () => {
  await appStore.init();
  const limits = appService.limits();
  assert.strictEqual(limits.maxApplications, 2);
  assert.strictEqual(limits.maxFilesPerApplication, 2);
  assert.strictEqual(limits.maxTotalFiles, 3);
});

test('单个应用文件数量上限：第 3 个文件被拒绝', async () => {
  const app = await appService.create('LimitApp');
  await fileService.upload({ appId: app.id, name: 'a.txt', content: 'a' });
  await fileService.upload({ appId: app.id, name: 'b.txt', content: 'b' });

  await assert.rejects(
    () => fileService.upload({ appId: app.id, name: 'c.txt', content: 'c' }),
    (err) => {
      assert.strictEqual(err.code, 'FILE_LIMIT_PER_APP');
      assert.match(err.message, /已达到单个应用的文件数量上限（最多 2 个文件）/);
      return true;
    }
  );
});

test('系统文件总数上限：跨应用累计也会拦截', async () => {
  const app2 = await appService.create('LimitApp2');
  await fileService.upload({ appId: app2.id, name: 'c.txt', content: 'c' });
  // 此时总数 = 3，已达 MAX_TOTAL_FILES

  await assert.rejects(
    () => fileService.upload({ appId: app2.id, name: 'd.txt', content: 'd' }),
    (err) => {
      assert.strictEqual(err.code, 'FILE_LIMIT_TOTAL');
      assert.match(err.message, /已达到系统文件总数上限（最多 3 个文件）/);
      return true;
    }
  );
});

test('应用数量上限：达到后禁止继续创建', async () => {
  await assert.rejects(() => appService.create('Third'), (err) => {
    assert.strictEqual(err.code, 'APP_LIMIT');
    return true;
  });
});
