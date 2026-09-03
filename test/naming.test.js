'use strict';

/** 文件名规则单元测试：路径穿越、非法字符、最小可用序号 */
const test = require('node:test');
const assert = require('node:assert');

const naming = require('../lib/naming');

test('清洗文件名：挡住 Unix / Windows 路径穿越', () => {
  assert.strictEqual(naming.sanitizeFileName('../../etc/passwd'), 'etcpasswd');
  assert.strictEqual(naming.sanitizeFileName('..\\..\\windows\\system32'), 'windowssystem32');
  assert.strictEqual(naming.sanitizeFileName('a/../../b.json'), 'ab.json');
});

test('清洗文件名：挡住 null byte 与控制字符', () => {
  assert.strictEqual(
    naming.sanitizeFileName('con' + String.fromCharCode(0) + 'fig.json'),
    'config.json'
  );
  assert.strictEqual(naming.sanitizeFileName('a' + String.fromCharCode(7) + 'b.txt'), 'ab.txt');
});

test('清洗文件名：保留 .env 这类点开头的文件名', () => {
  assert.strictEqual(naming.sanitizeFileName('.env'), '.env');
  assert.strictEqual(naming.extensionOf('.env'), 'env');
  assert.deepStrictEqual(naming.splitName('.env'), { base: '.env', ext: '' });
});

test('最小可用序号：从 1 开始，不带空格，英文半角括号', () => {
  assert.strictEqual(naming.nextAvailableName('config.json', ['config.json']), 'config(1).json');
  assert.strictEqual(
    naming.nextAvailableName('config.json', ['config.json', 'config(1).json']),
    'config(2).json'
  );
});

test('最小可用序号：优先补中间空缺，而不是接着最大号往下排', () => {
  const existing = ['config.json', 'config(1).json', 'config(2).json', 'config(4).json'];
  assert.strictEqual(naming.nextAvailableName('config.json', existing), 'config(3).json');
});

test('最小可用序号：重名比较不区分大小写', () => {
  assert.strictEqual(naming.nextAvailableName('Config.JSON', ['config.json']), 'Config(1).JSON');
});

test('最小可用序号：无扩展名也能正确编号', () => {
  assert.strictEqual(naming.nextAvailableName('Dockerfile', ['Dockerfile']), 'Dockerfile(1)');
});

test('文件名校验：空名、超长、不支持的扩展名都要报错', () => {
  assert.throws(() => naming.validateFileName(''), /文件名不能为空/);
  assert.throws(() => naming.validateFileName('   '), /文件名不能为空/);
  assert.throws(() => naming.validateFileName('a'.repeat(200)), /文件名过长/);
  assert.throws(() => naming.validateFileName('evil.exe'), /不支持的文件类型/);
});

test('文件名校验：无扩展名时补默认扩展名，合法名字原样返回', () => {
  assert.strictEqual(naming.validateFileName('config', { defaultExtension: 'txt' }), 'config.txt');
  assert.strictEqual(naming.validateFileName('config.json'), 'config.json');
  assert.strictEqual(naming.validateFileName('.env'), '.env');
});
