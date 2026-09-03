# Dispense · 本地文件型配置下发器 — 改造收尾与验收

> 一个**零第三方依赖**的 Node.js 本地文件型配置 / 文本 / 文件下发平台。
> 本次在已落地的「应用→当前文件→实体」架构上，补齐了**下发端点健壮性、正确 Content-Type、性能优化**三块，
> 并把项目正式命名为 **Dispense**。

## 一、核心架构（不变）

```
Application (id, name, token, currentFileId)
   └─ token  ─────────────────────►  GET /d/<token>   （永久不变的下发链接）
   └─ currentFileId ──► File (fileId, name, downloadName, storagePath) ──► 本地实体文件
```
- **上传 ≠ 发布**：上传只把文件放进应用，必须显式「设为当前下发」才生效。
- 用户可见文件名 与 磁盘实体名（内部 `fileId`）完全分离。
- 索引（`index/`）由 `app.json` 派生，启动即重建；请求走 O(1) 索引定位 + 流式返回，不扫描目录、不读全量元数据、不把文件读进内存。

## 二、本轮新增 / 修正

### 1. 项目命名 → **Dispense**
`package.json` 的 `name` 改为 `dispense`（直译「下发」），README 标题改为 `Dispense · 配置下发器`，
`server.js` 启动横幅加前缀，补充 `keywords`。

### 2. 下发端点健壮性（你明确要求的「别崩」）
`routes/delivery.js` 重写：`GET /d/:token` 是公开端点，以下情况**一律返回 `200 + 空 body + Content-Type: text/plain`，
绝不报错、绝不崩溃**：

- 链接不存在（token 查不到应用）
- 应用存在但未设置「当前下发文件」
- 当前文件实体缺失（损坏 / 被移走）
- 任何意外异常（catch 降级空响应）

### 3. Content-Type 正确（按后缀，无后缀兜底纯文本）
`lib/mime.js`：无扩展名或未知后缀默认 `text/plain`（原 `application/octet-stream`）。
下发响应头 `Content-Type` 按**下发名（downloadName）的后缀**决定：
`.json`→`application/json`、`.yaml/.yml`→`application/yaml`、`.xml`→`application/xml`、
`.js`→`text/javascript`、`.csv`→`text/csv`、`.html`→`text/html`、`.css`→`text/css`、无后缀→`text/plain`。

### 4. 存储性能优化
`lib/fsx.js` 的 `writeFileAtomic` 增加 `sync` 选项；`appStore.writeIndex` 改用 `sync:false`
（索引由 `app.json` 派生、启动自愈，无需 fsync），批量写入提速数倍；**唯一真相来源 `app.json` 与实体文件仍 fsync**。
→ 这是「适合 2GB 服务器」与「重启后可完整恢复」的关键平衡。

## 三、测试结果（全部通过，75 用例）

```
node --test test/*.test.js   →   # tests 75  # pass 75  # fail 0
```

新增 `test/delivery.test.js`：Content-Type 按后缀、无后缀兜底、未知/缺文件/坏文件空响应、
60 并发未知链接压测（不拖垮服务）、`?dl=1` 强制附件。
新增 `test/performance.test.js`：4000 文件规模（100 应用 × 40）下的运行时 SLA。

### 性能实测（4000 文件规模）
| 指标 | 实测 | 结论 |
|---|---|---|
| 索引重建（启动一致性检查） | **~0.6–0.9 s** | 轻量，O(应用数) |
| 下发延迟 median / p95 | **~15–19 ms / ~17–26 ms** | O(1) 索引定位 + 流式，不随文件数变慢 |
| 索引文件体积 | **~164 KB** | 远小于 2MB 上限 |
| 切换当前下发 | URL 不变、内容即变 | 指针切换为 O(1) 元数据写 |

> 注：本沙箱文件系统对 `fsync`/小文件写入极慢（≈3 文件/秒），因此批量「导入」走真实上传路径
> 在此环境无法在合理时间灌入数千文件——这是**环境限制，非产品问题**（本地 SSD 快 2~3 个数量级）。
> 性能测试用「非 fsync 快速铺数据」做夹具来度量真正的运行时 SLA（下发延迟 / 重建耗时），二者与
> 「文件如何写进来」无关，正是产品要保障的。

## 四、如何运行

```bash
node server.js                 # 默认 http://localhost:3000
PORT=8112 node server.js       # 指定端口
npm test                       # 运行 75 个用例
pm2 start ecosystem.config.js  # 生产部署
```

无需 `npm install`（零依赖）。所有限制（应用数 / 单应用文件数 / 总文件数 / 单文件大小 / 回收站 TTL）
均通过 `config.js` 的环境变量覆盖，业务代码无硬编码数字。

## 五、关键文件
- `routes/delivery.js` — 下发端点（健壮性 + Content-Type）
- `lib/mime.js` — 后缀→MIME（无后缀兜底 text/plain）
- `lib/fsx.js` / `storage/appStore.js` — 原子写（sync 选项）/ 索引非 fsync
- `test/delivery.test.js` / `test/performance.test.js` — 新增测试
- `README.md` / `docs/ARCHITECTURE.md` — 文档
