'use strict';

/**
 * 文件系统的安全封装：原子写、路径越界校验、尾部读取。
 * 业务层不直接使用原生 fs。
 */
const fsp = require('fs/promises');
const path = require('path');

/** 确保目录存在 */
async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

/** 路径是否存在 */
async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch (e) {
    return false;
  }
}

/** target 是否严格位于 root 内部（防路径穿越） */
function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 原子写：写同目录临时文件 → （可选）fsync → rename。
 * 保证任何时刻读到的都是旧版本或新版本，不会读到半截文件。
 *
 * sync=true（默认）：落盘后 fsync，适合「用户数据的唯一真相来源」（app.json、实体文件）。
 * sync=false：仅 rename，不 fsync。用于「可由真相来源重建」的派生索引，
 *   换来批量写入的数倍提速，且崩溃后由 rebuildIndex 自愈，不丢数据。
 */
async function writeFileAtomic(file, data, opts) {
  const sync = !(opts && opts.sync === false);
  await ensureDir(path.dirname(file));
  const tmp = path.join(
    path.dirname(file),
    '.' + path.basename(file) + '.' + process.pid + '.' + Date.now().toString(36) + '.tmp'
  );
  const handle = await fsp.open(tmp, 'w');
  try {
    await handle.writeFile(data);
    if (sync) await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

async function writeJsonAtomic(file, obj, opts) {
  await writeFileAtomic(file, JSON.stringify(obj, null, 2), opts);
}

/**
 * 读取 JSON；文件不存在返回 fallback；
 * 内容损坏则备份为 *.corrupt.* 后返回 fallback，避免整个服务起不来。
 */
async function readJson(file, fallback) {
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'EISDIR')) return fallback;
    throw e;
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (e) {
    await fsp.rename(file, file + '.corrupt.' + Date.now()).catch(() => {});
    return fallback;
  }
}

/** 追加一行（NDJSON / 日志），不做 fsync，IO 压力最小 */
async function appendLine(file, line) {
  await ensureDir(path.dirname(file));
  await fsp.appendFile(file, line.endsWith('\n') ? line : line + '\n', 'utf8');
}

async function removePath(p) {
  await fsp.rm(p, { recursive: true, force: true });
}

async function movePath(src, dest) {
  await ensureDir(path.dirname(dest));
  try {
    await fsp.rename(src, dest);
  } catch (e) {
    // 跨设备时退化为复制 + 删除
    if (e && (e.code === 'EXDEV' || e.code === 'EPERM' || e.code === 'EACCES')) {
      await fsp.copyFile(src, dest);
      await removePath(src);
      return;
    }
    throw e;
  }
}

async function copyPath(src, dest) {
  await ensureDir(path.dirname(dest));
  await fsp.copyFile(src, dest);
}

async function statSize(p) {
  const st = await fsp.stat(p);
  return { size: st.size, mtimeMs: st.mtimeMs, mtime: st.mtime };
}

/** 只读文件尾部 maxBytes 字节并按行切分（历史记录用，避免读整个大文件） */
async function tailLines(file, maxBytes) {
  const st = await fsp.stat(file);
  const start = Math.max(0, st.size - maxBytes);
  const length = st.size - start;
  if (length <= 0) return [];
  const handle = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    return text.split('\n').filter((l) => l.length > 0);
  } finally {
    await handle.close();
  }
}

/* --------- 带 mtime 校验的小索引读缓存（避免高频重复解析同一个小文件） --------- */
const cache = new Map();

async function readJsonCached(file, ttlMs, fallback) {
  const now = Date.now();
  const hit = cache.get(file);
  let mtime = -1;
  try {
    mtime = (await fsp.stat(file)).mtimeMs;
  } catch (e) {
    mtime = -1;
  }
  if (hit && hit.mtime === mtime && now - hit.at < (ttlMs || 5000)) {
    hit.at = now;
    return hit.value;
  }
  const value = await readJson(file, fallback);
  cache.set(file, { value, mtime, at: now });
  return value;
}

function invalidateCache(file) {
  cache.delete(file);
}

module.exports = {
  ensureDir,
  exists,
  isInside,
  writeFileAtomic,
  writeJsonAtomic,
  readJson,
  readJsonCached,
  invalidateCache,
  appendLine,
  removePath,
  movePath,
  copyPath,
  statSize,
  tailLines
};
