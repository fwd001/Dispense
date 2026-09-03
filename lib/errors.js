'use strict';

/**
 * 统一业务错误：HTTP 状态码 + 稳定错误码 + 面向用户的中文消息。
 */
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code || 'ERROR';
    this.details = details === undefined ? null : details;
    this.expose = true;
  }
}

const E = {
  badRequest: (message, code, details) => new AppError(400, code || 'BAD_REQUEST', message, details),
  notFound: (message, code, details) => new AppError(404, code || 'NOT_FOUND', message, details),
  conflict: (message, code, details) => new AppError(409, code || 'CONFLICT', message, details),
  tooLarge: (message, code, details) => new AppError(413, code || 'TOO_LARGE', message, details)
};

const MESSAGE = {
  APP_NOT_FOUND: '应用不存在',
  APP_NAME_EMPTY: '应用名称不能为空',
  APP_NAME_DUPLICATE: '应用名称已存在',
  APP_NAME_TOO_LONG: (n) => `应用名称过长（最多 ${n} 个字符）`,
  APP_LIMIT: (n) => `已达到应用数量上限（最多 ${n} 个应用）`,

  FILE_NOT_FOUND: '文件不存在',
  FILE_NAME_EMPTY: '文件名不能为空',
  FILE_NAME_TOO_LONG: (n) => `文件名过长（最多 ${n} 个字符）`,
  FILE_NAME_INVALID: '文件名包含非法字符',
  FILE_NAME_DUPLICATE: '文件名已存在',
  DOWNLOAD_NAME_DUPLICATE: '下发名称已存在',
  FILE_EXT_NOT_ALLOWED: (list) => `不支持的文件类型，仅支持：${list}`,
  FILE_TOO_LARGE: (mb) => `文件大小超过限制（最大 ${mb}MB）`,
  FILE_LIMIT_PER_APP: (n) => `已达到单个应用的文件数量上限（最多 ${n} 个文件）`,
  FILE_LIMIT_TOTAL: (n) => `已达到系统文件总数上限（最多 ${n} 个文件）`,
  FILE_BROKEN: '文件实体缺失，无法读取',
  JSON_INVALID: 'JSON 格式错误，请修正后再保存',
  NO_CURRENT_FILE: '当前没有可下发文件',
  TOKEN_NOT_FOUND: '下发链接不存在或已失效',
  DELETE_CURRENT_FILE: '当前文件正在作为下发文件使用',
  TRASH_ITEM_NOT_FOUND: '回收站中找不到该项',
  RESTORE_APP_MISSING: '原应用已被删除，请先恢复该应用'
};

module.exports = { AppError, E, MESSAGE };
