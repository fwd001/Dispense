// PM2 部署配置（保活/自启）
// 用法： pm2 start ecosystem.config.js && pm2 save
// 端口配置：改这里的 PORT，或在启动前设置环境变量 PORT
module.exports = {
  apps: [
    {
      name: 'json-manager',
      script: './server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,      // 崩溃自动重启（保活）
      watch: false,           // 稳定起见不监听文件变化
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: 8112
      }
    }
  ]
};
