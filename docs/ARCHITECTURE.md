# 架构分析与改造设计

> 本文档记录「Phase 1 现有代码分析」与「Phase 2 本地存储结构设计」的结论。
> 目标：把现有 JSON 文件管理器升级为**本地文件型配置下发器**，且不破坏现有功能。

---

## 一、Phase 1：现有架构分析

### 1.1 技术栈

| 项目 | 现状 |
|---|---|
| 运行时 | Node.js（`engines: >=14`，实测 v22） |
| 语言 | CommonJS JavaScript，**无 TypeScript** |
| 依赖 | **零第三方依赖**，仅 `http` / `fs` / `path` |
| 前端 | 原生 HTML + 内联 CSS + 内联 `<script>`，无框架、无构建 |
| 部署 | PM2（`ecosystem.config.js`，PORT=8112） |
| 测试 | **无** |
| Lint | **无** |

### 1.2 目录结构

```
exam-memory/
├── server.js            # 全部逻辑：路由 + 业务 + fs，共 158 行
├── package.json
├── ecosystem.config.js
├── public/index.html    # 全部前端：结构 + 样式 + 脚本，共 193 行
└── data/                # 扁平存放 *.json（当前为空）
```

### 1.3 现有文件管理流程

| 环节 | 实现 | 位置 |
|---|---|---|
| 上传 | `POST /api/upload`，body 可为原始 JSON 或 `{name, content}`；`JSON.parse` 校验；`cleanName()` 清洗；`uniqueName()` 去重；`fs.writeFileSync` 直写 | server.js:92 |
| 重命名规则 | mac 风格 `base (2)`：已存在则 `i` 从 2 递增，**带空格**，且是「存在就 +1」而非「最小可用序号」 | server.js:60 |
| 删除 | `DELETE /api/delete/:name` → `fs.unlinkSync`，**物理删除，无回收站** | server.js:123 |
| 列表 | `fs.readdirSync(data)` 过滤 `.json`，按 `localeCompare(zh)` **文件名排序** | server.js:69 |
| 下载/预览 | `GET /data/:name.json` → `fs.readFileSync` 全量读入内存再返回，无 ETag / 无 Last-Modified / 无 Content-Disposition | server.js:132 |
| 元数据 | **没有元数据**，文件名即主键，文件即数据 | — |
| JSON 处理 | `parseJson()` 仅去 BOM 后 `JSON.parse`；无格式化 / 无校验定位 / 无编辑 | server.js:73 |
| 文本处理 | 不存在（只认 `.json`） | — |
| 日志 | **无**（仅 `console.log` 启动信息） | — |
| 分层 | **无** Controller / Service / Repository，`fs` 调用散落在路由里 | — |
| 路由 | `if` 链 + 正则，无路由器 | server.js:78 |
| 异常处理 | 顶层 `try/catch` → 一律 400；`uncaughtException` 打印后**继续运行** | server.js:146 |
| 路径安全 | `cleanName()` 去掉斜杠与 `..`（**未处理 null byte、Windows `\`、符号链接、大小写穿越**） | server.js:53 |
| 测试体系 | 无 | — |

### 1.4 现有 API 清单

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/list` | 列出 `data/*.json`（按文件名排序） |
| POST | `/api/upload` | 上传 JSON |
| GET | `/api/file/:name` | 读取 JSON 原文 |
| DELETE | `/api/delete/:name` | 物理删除 |
| GET | `/data/:name.json` | 预览链接（CORS `*`，供刷题 App 远程导入） |
| GET | `/` | 管理界面 |

### 1.5 现有数据结构

```
data/<用户文件名>.json   ← 文件名即 ID、即 URL、即排序键
```

### 1.6 冲突与风险点

| # | 风险 | 处置 |
|---|---|---|
| R1 | 现有 `/data/:name` 是**对外的生产链接**（刷题 App 远程导入已在使用） | **完整保留** legacy 路由与扁平 `data/*.json` 读写，不动行为 |
| R2 | 新结构若把实体文件也放 `data/` 根，会与 legacy 文件混在一起 | 新实体一律放 `data/apps/...`；legacy 只扫 `data/` 根目录的 `*.json`（新结构在根下只有目录，不会误伤） |
| R3 | 项目以「零依赖」为核心卖点 | **不引入任何 npm 依赖**（含 JSON 编辑器、express、mime 库）；用 `node:test` 做测试 |
| R4 | `uncaughtException` 后继续跑，可能带着损坏状态 | 保留兜底打印，但业务层改为显式错误码 |
| R5 | 单进程并发写 `app.json` | 引入**应用级 Promise 队列**，同应用串行、跨应用并行 |
| R6 | 元数据损坏导致服务起不来 | 元数据读取失败自动备份为 `*.corrupt.*` 并降级为默认值 |

### 1.7 可复用 / 需改造

- **可复用**：零依赖的原生 `http` 服务骨架、`sendJson` 响应风格、`cleanName` 的清洗思路、前端「复制链接弹窗 + execCommand 回退」的成熟交互、PM2 配置。
- **需改造**：命名算法（改最小可用序号 + 英文半角括号）、排序（改 `createdAt DESC`）、删除（改回收站）、下载（改 Stream + ETag）、存储（改元数据分离）、前端（改三视图 SPA）。

---

## 二、Phase 2：本地存储结构设计

### 2.1 目录布局

```
data/
├── apps/
│   └── app_6f3a9c1d2e4b7a80/
│       ├── app.json          # 应用元数据（含 files 索引，单文件 ≤ 200 条 ≈ 40KB）
│       ├── history.ndjson    # 追加写，尾部读取最近 N 条
│       └── files/
│           ├── file_1a2b3c4d5e6f7788   # 实体文件（无扩展名，名字与用户无关）
│           └── file_9c8d7e6f5a4b3c2d
├── trash/
│   ├── <fileId>.json         # 文件回收记录（含 deletedAt / purgeAt）
│   ├── files/<fileId>        # 回收的实体文件
│   └── apps/
│       ├── <appId>.json      # 应用回收记录
│       └── <appId>/          # 被删应用的目录（app.json + history，实体已入 trash/files）
├── index/                    # 轻量索引，让「列表 / 下发」O(1) 定位，不做全目录扫描
│   ├── apps.json             # 应用摘要数组（列表页一次读完）
│   ├── tokens.json           # { "<token>": "<appId>" } —— 下发链接 O(1) 反查
│   └── stats.json            # { totalFiles } —— 全局文件数，用于 MAX_TOTAL_FILES
├── logs/YYYY-MM-DD.log       # 按天追加，单行纯文本
├── tmp/                      # 上传临时区，写完原子 rename 进 files/
└── *.json                    # 【legacy】旧版扁平 JSON，继续由 /data/:name 提供服务
```

**为什么 `app.json` 里放 files 列表？**
每应用上限 200 个文件，元数据 ≈ 200B/条 → 单文件 ≤ 40KB，原子重写成本可忽略；换来的是「文件列表只读 1 个文件」，而不是读 200 个小文件。这比「一文件一 meta」在列表场景快 1~2 个数量级，且远好于「一个大 JSON 装全站数据」。

### 2.2 数据结构

**Application（`apps/<id>/app.json`）**

```jsonc
{
  "id": "app_6f3a9c1d2e4b7a80",
  "name": "MyApp",
  "token": "AbC93xKpQz12",        // 下发链接唯一标识，crypto.randomBytes base64url
  "currentFileId": null,          // 当前下发指针，null = 暂停下发
  "seq": 3,                       // 应用内单调递增序号，用于同毫秒稳定排序
  "createdAt": "2026-09-03T12:00:00.000Z",
  "updatedAt": "2026-09-03T12:00:00.000Z",
  "files": [ { /* File，见下，最新在前 */ } ]
}
```

**File（内嵌于 app.json 的 files 数组）**

```jsonc
{
  "id": "file_1a2b3c4d5e6f7788",  // 内部 ID，同时是磁盘实体名
  "name": "config.json",          // 用户可见文件名（可被自动编号）
  "downloadName": "config.json",  // 下发名，应用内唯一，默认 = name
  "size": 2048,
  "ext": "json",
  "mime": "application/json",
  "seq": 3,                       // 稳定排序用的序号
  "createdAt": "2026-09-03T12:00:00.000Z",
  "updatedAt": "2026-09-03T12:00:00.000Z",
  "broken": false                 // 完整性检查发现实体缺失时置 true
}
```

**Trash 文件记录（`trash/<fileId>.json`）**

```jsonc
{ "fileId": "...", "appId": "...", "appName": "MyApp", "name": "config.json",
  "downloadName": "config.json", "size": 2048, "ext": "json", "mime": "...",
  "seq": 2, "createdAt": "...", "deletedAt": "...", "purgeAt": "...",
  "deletedBy": "user | delete-all | app-delete" }
```

**Trash 应用记录（`trash/apps/<appId>.json`）**：`{ id, name, token, fileCount, deletedAt, purgeAt }`。

**History（`apps/<id>/history.ndjson`，追加写）**

```
{"ts":"...","type":"set_current","fileId":"...","fileName":"config.json","detail":{...}}
```

`type` 取值：`app_created` / `upload` / `edit` / `rename` / `save_as` / `set_current` / `unset_current` / `delete` / `delete_all` / `restore` / `app_deleted`。

### 2.3 迁移方案

`data/` 当前为空，**无需迁移**。但仍做两件事保证零破坏：

1. legacy 路由（`/api/list`、`/api/upload`、`/api/file/:name`、`/api/delete/:name`、`/data/:name.json`）**原样保留**，继续读写 `data/` 根目录的扁平 JSON。
2. 启动时的完整性检查只扫描 `data/apps/`、`data/trash/`，不触碰根目录的 legacy 文件。

### 2.4 关键算法与策略

| 主题 | 方案 |
|---|---|
| 重名编号 | 最小可用序号：`config.json → config(1).json → config(2).json`；缺号优先补（`…(2)、(4)` 存在时新文件取 `(3)`）；英文半角括号、无空格 |
| 排序 | `createdAt DESC`，同值用 `seq DESC` 兜底 |
| 并发 | 应用级 Promise 队列；索引与计数走全局队列 |
| 写文件 | `tmp → fsync → rename` 原子落盘；先落实体再写元数据，元数据失败则补偿删除实体 |
| 下载 | `fs.createReadStream` 流式返回，支持 `If-None-Match` → 304 |
| 回收站清理 | 启动立即执行一次 + 每 1 小时定时扫描（**不为单个文件建 Timer**） |
| 上限保护 | `MAX_APPLICATIONS=100` / `MAX_FILES_PER_APPLICATION=200` / `MAX_TOTAL_FILES=5000` / `MAX_FILE_SIZE=3MB`，全部走 env，不硬编码 |

---

## 三、Phase 3+：落地结构

```
config.js                 # 集中配置（全部 env 可覆盖，无硬编码）
lib/      errors.js fsx.js lock.js naming.js logger.js mime.js
storage/  paths.js appStore.js fileStore.js trashStore.js historyStore.js integrity.js
services/ appService.js fileService.js trashService.js deliveryService.js
routes/   api.js legacy.js
server.js                 # 入口（保留文件名与 node server.js 启动方式）
public/   index.html app.css app.js
test/     *.test.js
```

上层 Service 不直接调 `fs`，全部经 `storage/`；路由只做参数解析与错误映射。
