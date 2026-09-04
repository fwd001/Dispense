# 项目长期记忆：Dispense（本地文件型配置下发器）

## 项目定位
`exam-memory` 工作区内的产品已命名为 **Dispense** —— 一个**零第三方依赖**的 Node.js 本地文件型
配置 / 文本 / 文件下发平台。核心原则：**上传 ≠ 发布**。

## 核心数据模型（关键关系）
```
Application (id, name, token, currentFileId)
   │  token ──► /d/<token>  （永久不变的下发链接）
   └─ currentFileId ──► File (fileId, name, downloadName, storagePath)
                              └─ 本地实体文件
```
- 一个 Application = 一个永久稳定的下发 URL；切换「当前下发文件」只改指针，URL 不变。
- 文件名（用户可见）与磁盘实体名（内部 fileId）分离。

## 存储架构（面向 2GB 小内存服务器）
- `data/` 下：`apps/<appId>/{app.json, history.ndjson, files/<fileId>}`、`index/`、`trash/`、`logs/`、`tmp/`。
- 索引（index/apps|tokens|files|stats）是**由 app.json 派生的**，每次启动 `integrity.run` 重建，
  因此索引写入**不 fsync**（崩溃自愈）；只有 `app.json`（唯一真相来源）与实体文件写**带 fsync**。
- 请求路径：token→app（读 indexTokens）→currentFileId→file（读 app.json）→stream 实体，
  **不扫描目录、不读全量 metadata、不把文件读进内存**。
- 写入顺序：临时文件→校验→原子 rename→写元数据（实体先落盘，元数据后写，失败无脏数据）。
- 并发：应用级 Promise 队列，同应用写串行、不同应用并行。
- 回收站：删除=移动；启动立即清理一次，之后每小时扫描（`setInterval` + `unref`，不为文件建 Timer）。
- 所有限制（应用数/单应用文件数/总文件数/单文件大小/回收站 TTL）均走 `config.js` 环境变量，不硬编码。

## 下发端点边界行为（用户明确要求）
`GET /d/:token` 是公开端点，**绝不崩溃**，按状态区分：
- 未知链接（token 查不到应用）→ **200 + 空 body + text/plain**（不报错）。
- 应用已暂停（未设当前文件）→ **404**，错误码 `NO_CURRENT_FILE`（「当前没有可下发文件」）。
- 当前文件实体缺失 → **404**，错误码 `FILE_BROKEN`。
- 任何意外异常 → catch 降级为 200 空响应（不报 500、不崩溃）。
`Content-Type` 按下发名（downloadName）后缀决定，无后缀兜底 `text/plain`；`.json`→`application/json` 等。

## 测试
`node --test test/*.test.js`（75 用例）：命名/路径穿越、应用 CRUD/超限、上传/重名/缺号、排序、
发布切换（URL 不变）、JSON 校验、CRLF/LF/BOM、重命名唯一性、另存为、删除/恢复/清空、7天清理边界、
重启索引重建、下发响应头与 304、旧版接口兼容、下发健壮性（空响应/并发）、性能（100 应用×40 文件
=4000 规模：重建索引 <1s、下发 median <20ms、索引 <2MB）。
注意：本沙箱 fsync 极慢（≈3 文件/秒），批量导入走真实上传路径在此环境无法灌入数千文件；
性能测试用「非 fsync 快速铺数据」做夹具来测运行时 SLA（下发延迟/重建耗时），属环境限制非产品问题。

## 部署形态（2026-09-04 决策）
- **GitHub Actions 不能跑服务本体**（临时 VM：≤6h、磁盘即焚、无公网入站），只作 push 部署扳机；
  宿主需 7×24 公网服务器。用户当前**暂无服务器**（有服务器后走腾讯/阿里轻量云推荐路线）。
- 预案已备：`.github/workflows/deploy.yml`（SSH→git pull→npm test→pm2 reload，secrets 未配自动跳过）、
  `docs/DEPLOY.md`（初始化/secrets/回滚）。PM2 进程名 = `dispense`（别名 json-manager 已废弃）。
- data/ 在 .gitignore，git pull 永不覆盖线上数据，可放心用 Actions 自动部署。
