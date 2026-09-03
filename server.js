'use strict';

/**
 * 本地文件型配置下发器 —— 服务入口
 *
 * 启动顺序：准备目录 → 一致性检查（含回收站立即清理一次）→ 监听端口 → 挂定时扫描
 * 路由优先级：OPTIONS → 下发 /d/:token → 新版 /api/* → 旧版接口 → 静态页面
 */
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const config = require('./config');
const httpUtil = require('./lib/http');
const logger = require('./lib/logger');
const paths = require('./storage/paths');
const appStore = require('./storage/appStore');
const integrity = require('./storage/integrity');
const trashService = require('./services/trashService');
const apiRouter = require('./routes/api');
const legacyRouter = require('./routes/legacy');
const deliveryRouter = require('./routes/delivery');

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

/** 静态资源：只允许访问 public/ 内部 */
async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(config.PUBLIC_DIR, relative);
  if (!target.startsWith(path.resolve(config.PUBLIC_DIR) + path.sep)) {
    return httpUtil.send(res, 403, 'Forbidden'), true;
  }
  try {
    const stat = await fsp.stat(target);
    if (!stat.isFile()) return false;
    const type = STATIC_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(target).pipe(res);
    return true;
  } catch (e) {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') return httpUtil.sendNoContent(res);

  try {
    if (await deliveryRouter.handle(req, res, pathname)) return;
    if (await apiRouter.handle(req, res, pathname)) return;
    // 旧版接口必须在新版 404 兜底之前尝试，否则 /api/list 等路径会被吞掉
    if (await legacyRouter.handle(req, res, pathname)) return;
    if (apiRouter.isApiPath(pathname)) return apiRouter.notFound(res);
    if (await serveStatic(req, res, pathname)) return;
    return httpUtil.send(res, 404, 'Not Found');
  } catch (e) {
    return httpUtil.sendError(res, e);
  }
});

async function bootstrap() {
  await paths.ensureLayout();
  logger.setLogDir(paths.LOGS);
  await appStore.init();

  const report = await integrity.run({ verbose: true });
  logger.log('server_started', {
    port: config.PORT,
    applications: report.applications,
    files: report.files
  });

  // 定时扫描回收站：低频（默认 1 小时一次），不为任何文件创建 Timer
  const intervalMs = Math.max(1, config.TRASH_CLEAN_INTERVAL_HOURS) * 60 * 60 * 1000;
  const timer = setInterval(() => {
    trashService.purgeExpired().catch((e) => console.error('[trash] 自动清理失败:', e && e.message));
  }, intervalMs);
  if (timer.unref) timer.unref();

  server.listen(config.PORT, config.HOST, () => {
    const port = server.address() ? server.address().port : config.PORT;
    console.log('Dispense 配置下发器已启动: http://localhost:' + port);
    console.log('数据目录: ' + paths.DATA);
    console.log(
      '限制: 应用 ' + config.MAX_APPLICATIONS + ' 个 / 单应用文件 ' +
      config.MAX_FILES_PER_APPLICATION + ' 个 / 总文件 ' + config.MAX_TOTAL_FILES + ' 个 / 单文件 ' +
      Math.floor(config.MAX_FILE_SIZE / 1024 / 1024) + 'MB'
    );
  });
}

// 稳定性兜底：记录异常，避免进程静默退出（PM2 亦会保活）
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

function shutdown(signal) {
  console.log('收到 ' + signal + '，正在关闭服务…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (require.main === module) bootstrap().catch((e) => {
  console.error('启动失败:', e);
  process.exit(1);
});

module.exports = { server, bootstrap };
