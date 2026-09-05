# Dispense · GitHub Actions 自动部署说明

> **结论先行：GitHub Actions 只能当「自动部署的扳机」，不能当「跑服务的宿主」。**
> 服务必须常驻在一台有公网、7×24 开机的机器上（Linux 服务器 / 云主机），
> Actions 在每次 push 后帮你自动「拉代码 → 测测试 → 重启」。仓库里
> [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) 已备好，
> 配好 secrets 即生效（未配置时仅跳过 SSH 部署步骤，`npm test` 仍会跑，push 保持绿灯）。

---

## 一、为什么不能「直接把服务跑在 GitHub Actions 上」

GitHub Actions 的托管 Runner 是**用完即焚的临时虚拟机**，与常驻服务有三个根本冲突：

| Dispense 的需求 | Actions 托管 Runner 的机制 |
|---|---|
| 7×24 在线接收请求 | job 最长 6 小时，跑完机器销毁 |
| `data/` 本地文件持久化（唯一数据源） | 每次 job 都是全新磁盘，push 一次数据蒸发一次 |
| 外部访问 `GET /d/:token` | Runner 无公网入站入口，外部连不进来 |

cron 定时任务（隔壁 TrendRadar 爬虫那种）能跑是因为它「跑完即退出、结果提交回仓库」；
Dispense 是需要长期在线 + 本地落盘的服务，两者是不同物种。**任何可行方案最终都需要
一个 7×24 的宿主（自己的服务器），Actions 只负责 push 后的自动更新重启。**

---

## 二、总体架构

```
你的电脑 push ──► GitHub (fwd001/Dispense)
                       │
                       │ .github/workflows/deploy.yml 触发
                       ▼
                  GitHub Actions（临时 Runner）
                       │ SSH（DEPLOY_SSH_KEY）
                       ▼
            你的 Linux 服务器（常驻宿主）
               ├─ git pull --ff-only   ← 拉新代码，data/ 被 ignore，数据不动
               ├─ npm test             ← 回归
               └─ pm2 reload dispense  ← 平滑重启，<1s 中断
```

下发链接永远指向服务器：`http://<服务器IP>:8112/d/<token>`。每次 push 后自动换上新版本。

---

## 三、一次性初始化（服务器端，只需做一次）

```bash
# 1. 装 Node 18+ 与 PM2（以 root 为例，其他用户同理）
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
npm i -g pm2

# 2. 拉代码（不含 data/，它由运行时创建）
git clone git@github.com:fwd001/Dispense.git /opt/dispense
cd /opt/dispense

# 3. 首次启动（之后都由 Actions 负责）
pm2 start ecosystem.config.js   # 监听 8112，见文件内 PORT
pm2 save
pm2 startup                    # 开机自启（按提示执行输出的命令）

# 4. 放行防火墙端口（示例）
#    ufw allow 8112/tcp        （若用了云安全组，也在控制台放行）
```

> 若服务器上没有配 SSH key 拉 GitHub，改用 HTTPS clone 也行，首次推送仍走 Actions 的
> DEPLOY_SSH_KEY（服务器自己的出网 key 与 Actions 的入站 key 相互独立，互不影响）。

---

## 四、启用自动部署（GitHub 侧）

仓库 **Settings → Secrets and variables → Actions → New repository secret**，添加：

| Secret | 值 |
|---|---|
| `DEPLOY_HOST` | 服务器公网 IP 或域名 |
| `DEPLOY_USER` | SSH 用户名（`root` / `ubuntu` …） |
| `DEPLOY_SSH_KEY` | **私钥全文**（其对应公钥已加入服务器 `~/.ssh/authorized_keys`） |
| `DEPLOY_PATH` | 服务器上的项目绝对路径，如 `/opt/dispense` |
| `DEPLOY_PORT` | （可选）SSH 端口，默认 22 |

配置完成后再 push 一次，Actions 的 **Deploy to Server** 即开始工作；
在仓库 Actions 页可看到 拉取 → 测试 → reload 的完整日志。

---

## 五、验证与回滚

- **验证**：push 后打开 Actions 页看 job 绿；`pm2 status dispense` 显示 online；
  浏览器访问 `http://<IP>:8112` 看到管理页即成功。
- **回滚**：`git revert <坏提交>` 后 push，Actions 会自动再部署一次，无需手动上服务器。

---

## 六、想便宜 / 免费跑的备选

- **国内轻量云服务器**（腾讯云 / 阿里云轻量 2C2G，几十元/月）：国内客户端访问下发链接
  延迟低，**推荐**。
- **家里闲置电脑 / 树莓派**：装 Linux + frp / 内网穿透亦可，缺点是断电与家庭宽带上行不稳。
- **海外免费 PaaS（Fly.io / Render / Railway）**：不推荐——免费层普遍**无持久卷或会休眠**，
  而 Dispense 的 `data/` 必须落盘；且下发对象若在国内，海外链路不稳定。

> 只要没有「有公网 + 7×24」的宿主，任何平台都替代不了服务器这一环——这是 Dispense
> 本地文件型存储模型决定的，不是部署技巧能绕开的。

---

## 七、免费服务器实测选型（2026-09 核实）

**一句话结论：国内大厂（腾讯/阿里/华为）没有「长期免费」服务器，只有新用户 1–3 个月试用；
真正「永久免费」的常驻计算只有海外 Oracle Cloud Always Free（首选）与 Google Cloud e2-micro。**

| 方案 | 免费额度 | 期限 | 能否托 Dispense | 主要限制 |
|---|---|---|---|---|
| **Oracle Cloud Always Free（推荐）** | ARM Ampere A1：**2 OCPU + 12 GB**（2026-06 起由 4C/24G 减半）+ 2 台 AMD 微型实例（各 1 GB）；200 GB 块存储；10 TB/月出站；2 个公网 IP | **永久** | ✅ 富余 | 需外币信用卡验证（预扣 ~$1 退回）；注册地=home region 不可改；ARM 缺货需多试；**闲置 7 天可能被回收** |
| Google Cloud e2-micro | 1 台 e2-micro（约 1 GB），30 GB HDD | 永久（限美区 us-west1 等） | ✅ 够用 | 国内直连延迟 ~200ms；1 GB 出站流量/月很少；需绑卡 |
| AWS / Azure 免费层 | t3.micro / B1s 各 1 台 | **12 个月**（到期转付费） | 短期可以 | 不是长期；到期前务必释放防扣费 |
| 腾讯云 / 阿里云 | 新用户试用 1–3 个月；首年特惠 ¥38–118/年 | 试用 | 试用期可以 | 到期续费才是真实价格 |
| 国内免费 IDC（阿贝云/三丰云等） | 1 核 1 G | 号称永久 | 理论上 | **真实性/稳定性风险高，多为引流营销，不建议承载数据服务** |

### Oracle 申请与部署要点（与本文 workflow 无缝衔接）

1. **注册**：`oracle.com/cloud/free`。国内用户请**直连注册、用真实国内地址 + 国内 Visa/Mastercard**
   （不支持银联；用 VPN + 假地址必被拒）。预授权扣 $1 后数日退回，不产生费用。
2. **选区**：home region 选定后不可改。国内访问延迟排序上优先考虑**韩国春川 / 日本东京 / 大阪**，
   但这些区域 A1 常缺货（报 `out of host capacity` 就换可用域或改天再试，也可先开 AMD 微型实例应急）。
3. **开实例**：Compute → Create instance → Shape 选 **Ampere → VM.Standard.A1.Flex**，
   建议 **2 OCPU / 12 GB**（别超免费上限，超了会被计费/终止）；Boot volume 默认 ≥47 GB；上传 SSH 公钥。
   Ubuntu 镜像默认用户 `ubuntu`。ARM64 对 Node ≥18 原生支持，本项目零依赖，无兼容问题。
4. **放行端口（两步，缺一不可）**：
   - 控制台：VCN → Security List → Add Ingress Rules，放行 `8112/tcp`（以及 SSH `22/tcp`）；
   - 实例内：`sudo iptables -F`（或 `ufw allow 8112`）——Oracle 自带 iptables 规则默认全挡。
5. **接线**：实例上按本文第三节初始化（clone + `pm2 start` + `pm2 save` + `pm2 startup`），
   然后在 GitHub 配好第四节 secrets —— 你现有的 `.github/workflows/deploy.yml` 即可接管后续每次 push 自动部署。
   访问地址就是 `http://<实例公网IP>:8112`，**不需要域名、不需要备案**。
6. **防闲置回收**（官方规则：7 天内 CPU / 网络 / 内存的 95 分位均 <20% 即视为闲置）：
   Dispense 只要有客户端在拉配置就天然安全；低频使用时用 **UptimeRobot（免费，5 分钟一次）**
   定时 ping `http://<IP>:8112/d/<token>` 保持活跃即可。
7. **数据备份**：免费资源不承诺 SLA，Oracle 也可能调整 Always Free 策略（2026-06 减半即是先例）。
   建议定期把 `data/` 打包下载：`tar -czf data-backup.tgz /opt/dispense/data`，或 `rsync` 到本地/GitHub。

> Oracle 的**完整申请流程（含如何把付费可能性全部关掉）**见
> [`docs/ORACLE-FREE-TIER.md`](./ORACLE-FREE-TIER.md)。
