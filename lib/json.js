'use strict';

/** JSON 校验与格式化：非法 JSON 禁止保存，并给出行列位置 */
const { E, MESSAGE } = require('./errors');

const BOM = '﻿';

function stripBom(text) {
  const s = String(text == null ? '' : text);
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

/** 由字符偏移换算行列，便于定位错误 */
function positionToLineColumn(text, position) {
  if (!Number.isFinite(position) || position < 0) return null;
  const upto = String(text).slice(0, position);
  const lines = upto.split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1, position };
}

/**
 * 从 V8 的错误信息里提取位置。
 * 常见两种格式：
 *   Expected ',' or '}' after property value in JSON at position 7 (line 1 column 8)
 *   Unexpected token '}', "{ "a": }" is not valid JSON   ← 无位置，只能给出原文提示
 */
function locate(text, err) {
  const message = (err && err.message) || '';
  let match = /at position (\d+) \(line (\d+) column (\d+)\)/.exec(message);
  if (match) {
    return { position: Number(match[1]), line: Number(match[2]), column: Number(match[3]) };
  }
  match = /at position (\d+)/.exec(message);
  if (match) return positionToLineColumn(text, Number(match[1]));
  return null;
}

/** 校验失败直接抛 AppError（错误详情带行列），成功返回解析后的值 */
function validateJson(text) {
  const raw = String(text == null ? '' : text);
  try {
    return JSON.parse(stripBom(raw));
  } catch (e) {
    throw E.badRequest(MESSAGE.JSON_INVALID + '：' + e.message, 'JSON_INVALID', locate(raw, e));
  }
}

/** 格式化：2 空格缩进，保留 BOM 状态 */
function formatJson(text, indent) {
  const raw = String(text == null ? '' : text);
  const value = validateJson(raw);
  const hadBom = raw.charCodeAt(0) === 0xFEFF;
  const body = JSON.stringify(value, null, indent || 2);
  return hadBom ? BOM + body : body;
}

module.exports = { validateJson, formatJson, stripBom, locate };
