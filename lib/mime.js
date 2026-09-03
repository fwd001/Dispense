'use strict';

/** 极简 MIME 映射：只覆盖配置文件 / 文本类，够用即可，不引入 mime 依赖 */
const TEXT_MIME = {
  json: 'application/json',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  ts: 'text/plain',
  txt: 'text/plain',
  md: 'text/markdown',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  xml: 'application/xml',
  conf: 'text/plain',
  config: 'text/plain',
  env: 'text/plain',
  ini: 'text/plain',
  properties: 'text/plain',
  csv: 'text/csv',
  log: 'text/plain',
  html: 'text/html',
  css: 'text/css'
};

const CHARSET_SUFFIX =
  '; charset=utf-8';

function mimeFor(name) {
  const ext = require('./naming').extensionOf(name);
  // 没有扩展名（或不在已知映射里）一律视为纯文本，符合「无后缀 = 纯文本」约定
  return TEXT_MIME[ext] || 'text/plain';
}

/** 带字符集，直接可做 Content-Type */
function contentTypeFor(name) {
  const mime = mimeFor(name);
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml' ||
      mime === 'application/yaml' || mime === 'application/javascript' || mime === 'text/javascript') {
    return mime + CHARSET_SUFFIX;
  }
  return mime;
}

function isTextLike(name) {
  const mime = mimeFor(name);
  return mime !== 'application/octet-stream';
}

function isJsonName(name) {
  return require('./naming').extensionOf(name) === 'json';
}

module.exports = { mimeFor, contentTypeFor, isTextLike, isJsonName, TEXT_MIME };
