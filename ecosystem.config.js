// PM2 部署配置（保活/自启）
// 用法： pm2 start ecosystem.config.js && pm2 save
// 端口配置：改这里的 PORT，或在启动前设置环境变量 PORT
//
// 注意：这里是单进程 fork 模式。
// 存储依赖本地文件与应用级内存队列，多实例（cluster）会破坏写串行化，务必保持 instances: 1。
module.exports = {
  apps: [
    {
      name: 'dispense',
      script: './server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,      // 崩溃自动重启（保活）
      watch: false,           // 稳定起见不监听文件变化
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: 8112,

        // 数量与容量限制（面向 2GB 内存服务器）
        MAX_APPLICATIONS: 100,
        MAX_FILES_PER_APPLICATION: 200,
        MAX_TOTAL_FILES: 5000,
        MAX_FILE_SIZE_MB: 3,

        // 回收站：7 天自动清理，每小时扫描一次
        TRASH_TTL_DAYS: 7,
        TRASH_CLEAN_INTERVAL_HOURS: 1

        // 若有域名，可设置下发链接展示用的外部基址：
        // PUBLIC_BASE_URL: 'https://example.com'
      }
    }
  ]
};
