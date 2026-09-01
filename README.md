# JSON 管理服务

一个**最简单、最稳定**的 Node.js JSON 管理服务。无任何第三方依赖，仅用 Node.js 内置模块即可运行。

## 功能

| 功能 | 说明 |
|---|---|
| ① 上传 JSON | 粘贴 JSON，或选择 `.json` 文件；也可留空文件名自动取 `meta.title`；**若与已有文件重名，会自动在末尾加 `(2)`、`(3)`…（mac 风格），不会覆盖** |
| ② 预览 JSON | 每个 JSON 都有一个 `/data/文件名.json` 链接（支持跨域），可直接作为刷题应用的「远程导入」地址（可打开 / 复制链接） |
| ③ 删除 JSON | 点「删除」即可从 `data/` 移除 |

## 目录结构

```
json-manager/
├── server.js            # 服务入口（内置 http）
├── package.json
├── ecosystem.config.js  # PM2 配置（保活/自启）
├── public/index.html    # 管理界面
└── data/                # 上传的 JSON 存这里
```

## 运行

无需 `npm install`（没有依赖）。

### 直接运行
```bash
node server.js
# 默认 http://localhost:3000
```

### 配置端口
```bash
# 方式一：环境变量
PORT=8080 node server.js

# 方式二：改 ecosystem.config.js 里的 env.PORT
```

## PM2 部署（保活）

```bash
cd json-manager
npm i -g pm2          # 若已安装可跳过

pm2 start ecosystem.config.js   # 启动并接管（崩溃自动重启=保活）
pm2 save                        # 保存进程列表
pm2 startup                     # 生成开机自启命令（按提示执行）
```

常用命令：
```bash
pm2 logs json-manager     # 看日志
pm2 restart json-manager  # 重启
pm2 stop json-manager     # 停止
```

> 端口如需改动：`ecosystem.config.js` 里 `env.PORT` 改掉，然后 `pm2 restart json-manager --update-env`。

## 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/list` | 列出已上传 JSON |
| POST | `/api/upload` | 上传 JSON（body 可为原始 JSON，或 `{name, content}`） |
| GET | `/api/file/<name>` | 读取某个 JSON 内容 |
| DELETE | `/api/delete/<name>` | 删除某个 JSON |
| GET | `/data/<name>.json` | 预览链接（只读，带 CORS，可被前端跨域导入） |
| GET | `/` | 管理界面 |

## 与刷题应用配合

把 `预览链接`（即 `http://你的地址:端口/data/xxx.json`）粘贴到刷题应用的「远程导入」地址栏即可加载，因为本服务已返回 `Access-Control-Allow-Origin: *`，跨域导入可正常使用。
