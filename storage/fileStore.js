'use strict';

/**
 * 实体文件存储：只负责「临时落盘 → 原子提交 → 读取 / 流式输出」。
 * 业务层拿到的都是绝对路径，且已在 paths 层做过越界校验。
 */
const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fsx = require('../lib/fsx');
const paths = require('./paths');

/** 先把内容写到临时区，校验通过后再原子提交，避免半成品实体 */
async function stage(buffer, suffix) {
  await fsx.ensureDir(paths.TMP);
  const name = 'up_' + crypto.randomBytes(8).toString('hex') + (suffix || '');
  const tmpPath = paths.tmpFile(name);
  await fsx.writeFileAtomic(tmpPath, buffer);
  return tmpPath;
}

/** 原子提交：rename 到最终位置（同分区，rename 是原子的） */
async function commit(tmpPath, destPath) {
  await fsx.movePath(tmpPath, destPath);
}

async function removeTmp(tmpPath) {
  if (tmpPath) await fsp.rm(tmpPath, { force: true }).catch(() => {});
}

/** 读取文本（仅供编辑器使用，文件本身有 3MB 上限） */
async function readText(destPath) {
  return fsp.readFile(destPath, 'utf8');
}

/** 流式读取：下发与下载都不把文件整体读进内存 */
function openStream(destPath) {
  return fs.createReadStream(destPath);
}

async function stat(destPath) {
  try {
    return await fsx.statSize(destPath);
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
}

async function exists(destPath) {
  return fsx.exists(destPath);
}

async function remove(destPath) {
  await fsp.rm(destPath, { force: true });
}

/** 复制实体（另存为） */
async function copy(srcPath, destPath) {
  await fsx.copyPath(srcPath, destPath);
}

/** 移动实体（进回收站 / 从回收站恢复） */
async function move(srcPath, destPath) {
  await fsx.movePath(srcPath, destPath);
}

module.exports = {
  stage,
  commit,
  removeTmp,
  readText,
  openStream,
  stat,
  exists,
  remove,
  copy,
  move,
  dirname: path.dirname
};
