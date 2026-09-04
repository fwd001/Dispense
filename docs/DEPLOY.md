# Dispense · GitHub Actions 自动部署说明

> **结论先行：GitHub Actions 只能当「自动部署的扳机」，不能当「跑服务的宿主」。**
> 服务必须常驻在一台有公网、7×24 开机的机器上（Linux 服务器 / 云主机），
> Actions 在每次 push 后帮你自动「拉代码 → 测测试 → 重启」。仓库里
> [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) 已备好，
> 配好 secrets 即生效（未配置时 job 自动跳过，不影响 push 绿灯）。

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
