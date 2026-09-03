'use strict';

/**
 * 集中配置：所有限制与阈值都可通过环境变量覆盖，业务代码里不出现硬编码数字。
 */
const path = require('path');

const MB = 1024 * 1024;

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');

module.exports = {
  ROOT: __dirname,
  DATA_DIR,
  PUBLIC_DIR: path.join(__dirname, 'public'),

  PORT: int(process.env.PORT, 3000),
  HOST: process.env.HOST || '0.0.0.0',

  // 请求体上限（比单文件上限略大，留出 base64 / JSON 包装开销）
  MAX_BODY_BYTES: int(process.env.MAX_BODY_MB, 8) * MB,
  // 单文件大小上限（主要针对配置 / 文本类文件）
  MAX_FILE_SIZE: int(process.env.MAX_FILE_SIZE_MB, 3) * MB,

  MAX_APPLICATIONS: int(process.env.MAX_APPLICATIONS, 100),
  MAX_FILES_PER_APPLICATION: int(process.env.MAX_FILES_PER_APPLICATION, 200),
  MAX_TOTAL_FILES: int(process.env.MAX_TOTAL_FILES, 5000),

  TRASH_TTL_DAYS: int(process.env.TRASH_TTL_DAYS, 7),
  TRASH_CLEAN_INTERVAL_HOURS: int(process.env.TRASH_CLEAN_INTERVAL_HOURS, 1),

  MAX_FILE_NAME_LENGTH: int(process.env.MAX_FILE_NAME_LENGTH, 120),
  MAX_APPLICATION_NAME_LENGTH: int(process.env.MAX_APPLICATION_NAME_LENGTH, 60),
  HISTORY_TAIL_BYTES: int(process.env.HISTORY_TAIL_BYTES, 64 * 1024),
  HISTORY_PAGE_SIZE: int(process.env.HISTORY_PAGE_SIZE, 100),

  // 下发链接的外部基址（可选，仅影响前端展示的链接文本）
  PUBLIC_BASE_URL: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),

  // 允许上传的扩展名（配置文件 / 文本类）
  ALLOWED_EXTENSIONS: (process.env.ALLOWED_EXTENSIONS ||
    'json,js,mjs,cjs,ts,txt,md,yaml,yml,xml,conf,config,env,ini,properties,csv,log,html,css')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
};
