'use strict';

/**
 * 文件名规则：
 *  - 清洗：去掉路径分隔符、..、null byte、控制字符与文件系统非法字符
 *  - 编号：英文半角括号、括号内外无空格、从 1 开始取「最小可用序号」
 */
const config = require('../config');
const { E, MESSAGE } = require('./errors');

// 用 RegExp 构造，源码里只保留 ASCII，避免写入不可见字符
const NUL = String.fromCharCode(0);
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');
const ILLEGAL_CHARS = /[<>:"|?*]/g;
const SEPARATORS = /[\\/]+/g;
const DOTS = /\.\.+/g;

/** 清洗用户传入的文件名，只保留「纯文件名」语义 */
function sanitizeFileName(input) {
  let n = String(input == null ? '' : input);
  n = n.split(NUL).join('');                 // null byte
  n = n.replace(SEPARATORS, '');             // / 与 \（含 Windows 的 ..\..）
  n = n.replace(DOTS, '');                   // .. 及更多连续点（路径穿越）
  n = n.replace(ILLEGAL_CHARS, '');          // 文件系统非法字符
  n = n.replace(CONTROL_CHARS, '');          // 控制字符与 DEL
  n = n.replace(/\s+/g, ' ').trim();
  n = n.replace(/\.+$/, '');                 // 尾部的点（Windows 会静默吞掉）
  if (/^\.+$/.test(n)) n = '';               // 只剩点，视为空
  return n;
}

/** 取扩展名（小写，不含点）。`.env` → `env`，`config.JSON` → `json` */
function extensionOf(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  if (i < 0) return '';
  if (i === 0) return s.slice(1).toLowerCase();
  return s.slice(i + 1).toLowerCase();
}

/** 拆分为主干与扩展名。`.env` → `{ base: '.env', ext: '' }` */
function splitName(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  if (i <= 0) return { base: s, ext: '' };
  return { base: s.slice(0, i), ext: s.slice(i + 1) };
}

/**
 * 生成不冲突的文件名：优先使用原名，然后从 (1) 开始取最小可用序号。
 *
 * 已有 config.json / config(1).json / config(2).json / config(4).json
 *   → 新文件得到 config(3).json（补最小空缺，而不是 5）
 */
function nextAvailableName(desired, existingNames) {
  const desiredName = String(desired || '');
  const taken = new Set((existingNames || []).map((n) => String(n).toLowerCase()));
  if (!taken.has(desiredName.toLowerCase())) return desiredName;

  const { base, ext } = splitName(desiredName);
  for (let i = 1; i <= 9999; i += 1) {
    const candidate = base + '(' + i + ')' + (ext ? '.' + ext : '');
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  throw E.conflict(MESSAGE.FILE_NAME_DUPLICATE, 'FILE_NAME_DUPLICATE');
}

/**
 * 完整校验并返回安全文件名：空名、超长、非法字符、不支持的扩展名都会报错。
 * 用户输入的文件名只能影响文件名，永远不会改变存储目录。
 */
function validateFileName(input, options) {
  const opts = options || {};
  const raw = String(input == null ? '' : input);
  if (!raw.trim()) throw E.badRequest(MESSAGE.FILE_NAME_EMPTY, 'FILE_NAME_EMPTY');

  let name = sanitizeFileName(raw);
  if (!name) throw E.badRequest(MESSAGE.FILE_NAME_INVALID, 'FILE_NAME_INVALID');
  if (name === '.' || name === '..') throw E.badRequest(MESSAGE.FILE_NAME_INVALID, 'FILE_NAME_INVALID');
  if (name.length > config.MAX_FILE_NAME_LENGTH) {
    throw E.badRequest(MESSAGE.FILE_NAME_TOO_LONG(config.MAX_FILE_NAME_LENGTH), 'FILE_NAME_TOO_LONG');
  }

  let ext = extensionOf(name);
  if (!ext && opts.defaultExtension) {
    name = name + '.' + opts.defaultExtension;
    ext = opts.defaultExtension;
  }
  if (ext && !opts.skipExtensionCheck && config.ALLOWED_EXTENSIONS.length &&
      config.ALLOWED_EXTENSIONS.indexOf(ext) < 0) {
    throw E.badRequest(
      MESSAGE.FILE_EXT_NOT_ALLOWED(config.ALLOWED_EXTENSIONS.join(' / ')),
      'FILE_EXT_NOT_ALLOWED'
    );
  }
  return name;
}

/** 清洗应用名称（允许中文与空格，去掉控制字符与路径分隔符） */
function sanitizeApplicationName(input) {
  let n = String(input == null ? '' : input);
  n = n.split(NUL).join('');
  n = n.replace(SEPARATORS, '');
  n = n.replace(CONTROL_CHARS, '');
  return n.replace(/\s+/g, ' ').trim();
}

module.exports = {
  sanitizeFileName,
  sanitizeApplicationName,
  extensionOf,
  splitName,
  nextAvailableName,
  validateFileName
};
