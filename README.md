# Dispense · 配置下发器

> **Dispense** —— 一个**零第三方依赖**的 Node.js 本地文件型配置 / 文本 / 文件下发平台。

核心模型：**一个应用 = 一个永久不变的下发链接**，应用内部可以管理多个文件版本，
通过切换「当前下发文件」来控制这个唯一地址实际返回哪个文件。

> **上传 ≠ 发布。** 上传文件不会自动影响线上链接，必须显式「设为当前下发」才真正生效。

---

## 快速开始

```bash
node server.js              # 默认 http://localhost:3000
PORT=8112 node server.js    # 指定端口
npm test                    # 运行测试套件
```

无需 `npm install`（项目没有任何依赖）。

### PM2 部署

```bash
pm2 start ecosystem.config.js
pm2 save
```

---

## 核心概念

| 概念 | 含义 |
|---|---|
| **应用 Application** | 核心对象。每个应用拥有一个唯一的 `/d/<token>` 下发链接 |
| **当前下发文件 currentFile** | 应用上的一个指针，决定下发链接返回哪个文件 |
| **文件 File** | 应用内部的内容版本，按上传时间倒序排列 |
| **下发名 downloadName** | 对外暴露的文件名，可独立于真实文件名，应用内唯一 |
| **回收站 Trash** | 所有删除先进回收站，7 天后自动永久清理 |

```
应用 MyApp
 ├── 下发链接  /d/AbC93xKpQz12      ← 永久不变
 ├── 当前下发  config-v3.json        ← 指针，可随时切换
 └── 文件      config.json / config(1).json / config(2).json / …
```

---

## 目录结构

```
├── server.js              # 服务入口
├── config.js              # 集中配置（全部环境变量可覆盖）
├── lib/                   # 通用能力：错误 / 文件原子写 / 命名 / 锁 / 日志 / MIME
├── storage/               # 存储层：paths / appStore / fileStore / trashStore / historyStore / integrity
├── services/              # 业务层：appService / fileService / trashService / deliveryService
├── routes/                # 路由层：api / delivery / legacy（旧版兼容）
├── public/                # 前端：index.html / app.css / app.js（原生，无框架）
├── data/                  # 本地数据（唯一的数据存放处）
└── test/                  # node:test 用例
```

### 数据目录布局

```
data/
├── apps/<appId>/
│   ├── app.json           # 应用元数据 + 文件索引
│   ├── history.ndjson     # 追加写，只读尾部
│   └── files/<fileId>     # 实体文件（磁盘名与用户可见名分离）
├── trash/
│   ├── <fileId>.json      # 文件回收记录（含 deletedAt / purgeAt）
│   ├── files/<fileId>
│   └── apps/<appId>/      # 被删应用的目录（含历史）
├── index/                 # 轻量索引：apps / tokens / files / stats
├── logs/YYYY-MM-DD.log
├── tmp/                   # 上传暂存，写完原子 rename
└── *.json                 # 【旧版】扁平 JSON，继续由 /data/:name 提供
```

元数据与实体文件分离，索引让「列表」和「下发」都是 O(1) 定位，不做全目录扫描。

---

## 接口

### 应用

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/applications` | 应用列表 + 统计 + 限制 |
| POST | `/api/applications` | 创建应用 `{ name }` |
| GET | `/api/applications/:id` | 应用详情（含文件列表） |
| PATCH | `/api/applications/:id` | 重命名 `{ name }` |
| DELETE | `/api/applications/:id` | 删除应用（进回收站） |
| POST | `/api/applications/:id/current-file` | 发布 / 暂停 `{ fileId \| null }` |
| DELETE | `/api/applications/:id/files` | 删除全部文件（应用保留） |
| GET | `/api/applications/:id/history` | 历史记录 |

### 文件

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/applications/:id/files` | 文件列表（createdAt DESC） |
| POST | `/api/applications/:id/files` | 上传 `{ name, content [, encoding] }` |
| GET | `/api/files/:fileId` | 文件元数据 |
| PATCH | `/api/files/:fileId` | 改文件名 / 下发名 |
| DELETE | `/api/files/:fileId` | 删除（进回收站），当前下发文件需 `?force=1` |
| GET | `/api/files/:fileId/content` | 读取内容（编辑器用） |
| PUT | `/api/files/:fileId/content` | 保存并覆盖 `{ content }` |
| POST | `/api/files/:fileId/duplicate` | 另存为新文件 |
| GET | `/api/files/:fileId/download` | 原始下载（Stream） |

### 回收站

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/trash` | 回收站列表（文件 + 应用） |
| POST | `/api/trash/restore/:fileId` | 恢复文件 |
| DELETE | `/api/trash/:fileId` | 永久删除文件 |
| POST | `/api/trash/apps/restore/:appId` | 恢复应用（含其文件） |
| DELETE | `/api/trash/apps/:appId` | 永久删除应用 |
| DELETE | `/api/trash` | 清空回收站 |

### 下发

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/d/:token` | 下发当前文件（Stream + ETag + 304） |

响应头：`Content-Type` / `Content-Length` / `Content-Disposition`（用下发名）/
`Cache-Control: no-cache, must-revalidate` / `ETag` / `Last-Modified` / CORS `*`。
加 `?dl=1` 可强制附件下载。

**边界行为（公开端点，绝不崩溃）**：

- **链接不存在**（token 查不到应用）→ `200 + 空 body + text/plain`（不报错）
- **应用已暂停**（未设当前下发文件）→ `404`，错误码 `NO_CURRENT_FILE`（「当前没有可下发文件」）
- **当前文件实体缺失**（损坏 / 被移走）→ `404`，错误码 `FILE_BROKEN`

`Content-Type` 按**下发名（downloadName）的后缀**决定，`text/plain` 为兜底；
`.json` → `application/json`、`.yaml/.yml` → `application/yaml`、`.xml` → `application/xml`、
`.js` → `text/javascript`、无后缀 → `text/plain`。

### 旧版接口（保持兼容，行为不变）

`GET /api/list`、`POST /api/upload`、`GET /api/file/:name`、
`DELETE /api/delete/:name`、`GET /data/:name.json`

---

## 配置

全部通过环境变量，业务代码里没有硬编码阈值：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `./data` | 数据目录 |
| `MAX_APPLICATIONS` | `100` | 应用数量上限 |
| `MAX_FILES_PER_APPLICATION` | `200` | 单应用文件数上限 |
| `MAX_TOTAL_FILES` | `5000` | 系统文件总数上限 |
| `MAX_FILE_SIZE_MB` | `3` | 单文件大小上限 |
| `MAX_BODY_MB` | `8` | 请求体上限 |
| `TRASH_TTL_DAYS` | `7` | 回收站保留天数 |
| `TRASH_CLEAN_INTERVAL_HOURS` | `1` | 回收站扫描间隔 |
| `ALLOWED_EXTENSIONS` | `json,js,txt,yaml,yml,xml,conf,env,…` | 允许的扩展名 |
| `PUBLIC_BASE_URL` | 空 | 下发链接展示用的外部基址 |

---

## 设计要点

**重名编号**：`config.json → config(1).json → config(2).json`。
英文半角括号、括号内外无空格、**取最小可用序号**
（已有 `(1)(2)(4)` 时新文件得到 `(3)`，而不是 `(5)`）。

**排序**：严格 `createdAt DESC`，同毫秒用应用内自增 `seq` 兜底。

**写入顺序**：临时文件 → 校验 → 原子 `rename` → 写元数据。
实体先落地、元数据后写，失败不会产生脏数据。

**并发**：应用级 Promise 队列，同一应用的关键写操作串行，不同应用并行。

**回收站**：删除 = 移动，不是 `rm`。启动时立即清理一次，之后每小时扫描一次；
**不为任何文件创建 Timer**，进程重启后任务不丢失。

**一致性**：启动时做一次完整性检查——从 `apps/` 重建索引、校验实体是否缺失、
清理过期回收项与残留临时文件。请求路径上不做任何全目录扫描。

**性能**：下发与下载都用 `fs.createReadStream` 流式返回，不把文件读进内存；
索引文件带 mtime 缓存；面向 2GB 内存服务器设计。

**安全**：所有路径经 `paths` 层生成并强制限制在 `data/` 内；
文件名清洗掉路径分隔符、`..`、null byte 与控制字符；
磁盘实体名使用内部 `fileId`，与用户可见名完全分离。

---

## 测试

```bash
npm test
```

覆盖：命名算法与路径穿越、应用创建 / 重名 / 超限、文件上传 / 连续重名 / 缺号补位、
排序、发布切换（URL 不变）、JSON 校验、CRLF / LF / BOM / 中文往返、重命名唯一性、
另存为、删除 / 恢复 / 清空、7 天自动清理边界（满 7 天删、差 1 小时不删）、
重启后索引重建与 token 反查、下发响应头与 304、旧版接口兼容性，
以及**下发端点健壮性**（未知链接 / 无当前文件 / 文件缺失均返回空 200、Content-Type 按后缀、
无后缀兜底 text/plain）与性能（大规模应用 / 文件下的下发延迟与索引重建耗时）。

---

## 更多

架构分析与存储结构设计见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。
