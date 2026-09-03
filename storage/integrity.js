'use strict';

/**
 * 启动时的轻量级一致性检查。
 * 只在启动时跑一次，绝不在请求路径上扫描整个文件系统。
 */
const fsp = require('fs/promises');
const path = require('path');
const fsx = require('../lib/fsx');
const paths = require('./paths');
const appStore = require('./appStore');
const trashStore = require('./trashStore');

const ONE_DAY = 24 * 60 * 60 * 1000;

/**
 * @returns {Promise<{applications:number, files:number, brokenFiles:number, orphanEntities:number, purgedFiles:number, purgedApps:number, tmpRemoved:number}>}
 */
async function run(options) {
  const opts = options || {};
  const report = {
    applications: 0,
    files: 0,
    brokenFiles: 0,
    orphanEntities: 0,
    purgedFiles: 0,
    purgedApps: 0,
    tmpRemoved: 0
  };

  await paths.ensureLayout();
  report.tmpRemoved = await paths.cleanStaleTmp(ONE_DAY);

  // 1) 重建索引：不信任上次运行留下的索引，以 apps/ 目录为事实来源
  const apps = await appStore.rebuildIndex();
  report.applications = apps.length;

  // 2) 校验每个文件的实体是否存在（metadata → 实体）
  for (const summary of apps) {
    const app = await appStore.get(summary.id);
    if (!app) continue;
    report.files += appStore.fileCountOf(app);

    let dirty = false;
    for (const file of app.files || []) {
      const exists = await fsx.exists(paths.entity(app.id, file.id));
      if (!exists && !file.broken) {
        file.broken = true;
        dirty = true;
        report.brokenFiles += 1;
      } else if (exists && file.broken) {
        file.broken = false;
        dirty = true;
      }
    }
    if (dirty) await fsx.writeJsonAtomic(paths.appMeta(app.id), app);
  }

  // 3) 反向校验：实体存在但元数据里没有（孤儿文件），只记录不删除
  for (const summary of apps) {
    const app = await appStore.get(summary.id);
    if (!app) continue;
    const known = new Set((app.files || []).map((f) => f.id));
    const entities = await fsp.readdir(paths.appFilesDir(app.id), { withFileTypes: true }).catch(() => []);
    for (const entry of entities) {
      if (entry.isFile() && !known.has(entry.name)) report.orphanEntities += 1;
    }
  }

  // 4) 回收站过期清理：服务启动时立即执行一次
  const now = Date.now();
  const purgedFiles = await trashStore.purgeExpiredFiles(now);
  const purgedApps = await trashStore.purgeExpiredApps(now);
  report.purgedFiles = purgedFiles.length;
  report.purgedApps = purgedApps.length;

  if (opts.verbose !== false) {
    console.log(
      '[integrity] 应用 %d 个 / 文件 %d 个 / 实体缺失 %d / 孤儿实体 %d / 清理回收站 %d 项 / 清临时文件 %d 个',
      report.applications, report.files, report.brokenFiles,
      report.orphanEntities, report.purgedFiles + report.purgedApps, report.tmpRemoved
    );
  }
  return report;
}

module.exports = { run, ONE_DAY };
