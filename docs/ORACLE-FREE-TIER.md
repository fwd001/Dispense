# Oracle Cloud Always Free 申请与部署全流程（2026-09 核实）

> 面向 Dispense 的托管需求：一台 7×24 在线、有真实本地磁盘、可对外 HTTP 的 Linux 机器。
> 本文所有关键规则均引自 Oracle 官方文档（最后核实：2026-09-05），官方原文见文末链接。
>
> 配套：[`docs/DEPLOY.md`](./DEPLOY.md)（服务器初始化 + GitHub Actions 自动部署）。

---

## 0. 先说「怎么保证一分钱不花」

Oracle 官方的原话是：**"Your credit card will not be charged unless you upgrade your account."**
（除非你主动升级账户，否则信用卡不会被扣费。）

对你而言，**唯一会产生真实扣费的动作只有「升级账户」这一个开关**。守住下面三条红线，付费概率为零：

| 红线 | 说明 | 官方依据 |
|---|---|---|
| 🚫 **永远不要点 "Upgrade" 升级付费（PAYG）** | 控制台顶部横幅或首页侧边栏有 Upgrade 链接，不要点。这是唯一的付费入口 | 升级才会扣费；不升级时信用卡仅做 $1 预授权 |
| 🚫 **只创建带 "Always Free-eligible" 标签的资源** | 创建实例时形状（shape）名旁必须显示该标签 | 非免费资源在试用结束后会被 Oracle **回收**（不是扣费） |
| 🚫 **总额度不越线**：A1 ≤ 2 OCPU / 12 GB，块存储 ≤ 200 GB | 超出部分在试用期后会被停用并删除 | 官方原文见 §7 备注 |

**最坏情况不是扣钱，而是资源被停用/回收。** 官方明确：试用期内用赠金创建的付费资源，
若你未升级付费账户，"Paid resources ... are reclaimed by Oracle"——钱不扣，东西收走。
所以只要不点 Upgrade，你就处在一个"最多是被回收、绝不会被扣款"的安全区。

**关于 $1 预授权**（你说"这个不算"的部分，事实也确实不算）：
注册时信用卡会被授权 **1 美元（或等值当地货币）** 用于身份验证，**Oracle 侧立即撤销该授权**，
剩余解冻时间由发卡行决定（通常数天）。这不是扣款。相比之下，**升级账户会授权 $100**——
这也是不升级的另一个理由。

---

## 1. 准备清单（注册前）

| 项目 | 要求 |
|---|---|
| 邮箱 | 长期可用的邮箱（Gmail / Outlook 均可） |
| 手机 | 可接收短信验证的手机号 |
| 信用卡 | **本人名下 Visa 或 Mastercard 信用卡**；不支持预付卡、虚拟卡；国内**银联单标卡不行** |
| 网络环境 | **直连注册，不要挂 VPN**；地址填真实国内地址（用 VPN + 境外地址被拒概率极高） |
| Home Region | 见 §2 第 4 步，**选定后不可更改**，先想清楚 |

---

## 2. 注册（约 10 分钟）

1. 打开 **<https://www.oracle.com/cloud/free/>** → 点击 **Start for free**（跳转 `signup.cloud.oracle.com`）。
2. 填写国家/地区（China）、姓名、邮箱 → 查收邮件完成**邮箱验证**。
3. 填写账单地址（真实地址，拼音或英文均可）+ **手机短信验证**。
4. **选择 Home Region（不可更改！）** Always Free 资源只能建在这里：
   - 国内访问延迟较好：**Japan Central (Osaka)** / **Japan East (Tokyo)** / **South Korea Central (Seoul)**；
   - 容量更容易抢到：**US West (Phoenix)** 等美区（但国内延迟明显更高）。
   - 建议：先试日韩；若反复缺货（§10），再权衡要不要换成美区。
5. 填写信用卡信息 → 触发 **$1 预授权**（详见 §0）。
6. 提交后等待账号开通（数分钟到数小时），收到邮件即可登录 **<https://cloud.oracle.com>**。
   注册后账号处于 **Free Trial** 状态：30 天 + $300 赠金。到期不升级即自动转为纯 Always Free 账号，
   **已开通的 Always Free 资源不中断**。

---

## 3. 登录后第一件事：设置预算告警（防扣费的兜底）

路径：**左上角导航菜单 → Billing & Cost Management → Budgets → Create Budget**

| 字段 | 值 |
|---|---|
| Name | `free-tier-guard` |
| Scope | 根 compartment（root） |
| Amount | **1**（美元/月） |
| Alert Rule 1 | Actual Spend ≥ **50%** → 邮件 |
| Alert Rule 2 | Actual Spend ≥ **100%** → 邮件 |

创建 Alert Rule 时需选择/新建 **Notification Topic** 并订阅你的邮箱（订阅后要点邮件里的确认链接才算生效）。

> ⚠️ 注意：预算告警**只发通知，不会自动停资源**。它的价值是"第一分钱出现时立刻知道"，
> 而不是"自动拦截"。真正的拦截是 §0 的三条红线。

---

## 4. 创建 SSH 密钥（本地执行）

```bash
ssh-keygen -t ed25519 -C "dispense-oracle" -f ~/.ssh/dispense-oracle
cat ~/.ssh/dispense-oracle.pub    # 复制内容，创建实例时粘贴
```

---

## 5. 创建 ARM 实例（关键步骤）

路径：**Compute → Instances → Create instance**

| 字段 | 设置 |
|---|---|
| Name | `dispense` |
| Placement | 默认可用域；报缺货就换 AD（§10） |
| Image | **Canonical Ubuntu**（选 aarch64 / ARM 版本，如 Ubuntu 24.04 Minimal aarch64） |
| Shape | 点 **Change shape → Ampere → `VM.Standard.A1.Flex`**，设 **2 OCPU + 12 GB**（或 1C/6G ×2 台） |
| ✅ 检查 | 形状名旁边必须显示 **Always Free-eligible** 标签 |
| Networking | 默认 VCN + public subnet，**勾选 Assign a public IPv4 address** |
| Add SSH keys | 粘贴上一步的 `.pub` 公钥内容（或上传文件） |
| Boot volume | **保持默认**（最小 47 GB）。想大一点可调到 100 GB，但**全账号总块存储 ≤ 200 GB** |

点击 **Create**。约 1 分钟内状态变为 Running。

> ARM 容量紧张是常态。报 `Out of host capacity` 见 §10。

---

## 6. 放行端口（两层缺一不可）

**① 控制台安全列表（Oracle 云防火墙）**
**Networking → Virtual Cloud Networks → 进入你的 VCN → Security Lists → Default Security List → Add Ingress Rules**

| Source CIDR | Protocol | Destination Port | 用途 |
|---|---|---|---|
| `0.0.0.0/0` | TCP | `22` | SSH（建议限为自己的 IP） |
| `0.0.0.0/0` | TCP | `8112` | Dispense 服务端口 |

**② 实例内部防火墙（Oracle 镜像自带严格 iptables，必须处理）**

```bash
sudo iptables -F                     # 测试环境：清空规则
# 生产建议：只开需要的端口
sudo ufw allow 22/tcp
sudo ufw allow 8112/tcp
sudo ufw --force enable
```

（若 Ubuntu 镜像用了 `netfilter-persistent`，改完执行 `sudo netfilter-persistent save` 固化。）

---

## 7. 登录并部署 Dispense

```bash
ssh -i ~/.ssh/dispense-oracle ubuntu@<公网IP>     # 默认用户是 ubuntu，不是 root
```

然后按 [`docs/DEPLOY.md` 第三节](./DEPLOY.md) 执行：装 Node 20 → `git clone` → `pm2 start ecosystem.config.js`
→ `pm2 save` → `pm2 startup`（开机自启）。

**收尾配置**：若页面里复制出来的下发链接 host 不对，在 `ecosystem.config.js` 的 env 里设置
`PUBLIC_BASE_URL: 'http://<公网IP>:8112'`，然后 `pm2 reload dispense --update-env`。

验证：浏览器打开 `http://<公网IP>:8112` 应看到管理页 —— **不需要域名、不需要备案**。

> **A1 配额红线（官方原文要点）**：如果 tenancy 内 A1 实例总配置超过 Always Free 额度
> （现为 2 OCPU / 12 GB），所有现有 A1 实例会被停用，30 天后删除，除非升级付费账户。
> 所以创建时就别超——按 §5 的 2C/12G 单台是最稳的。

---

## 8. 接线 GitHub Actions（一次配好，之后 push 即部署）

在 GitHub 仓库 **Settings → Secrets and variables → Actions** 配 4 个值：

`DEPLOY_HOST` = 实例公网 IP ／ `DEPLOY_USER` = `ubuntu` ／ `DEPLOY_SSH_KEY` = `~/.ssh/dispense-oracle` **私钥全文**
／ `DEPLOY_PATH` = `/opt/dispense`（服务器上 clone 的绝对路径）。

之后每次 push 到 main，Actions 自动完成：拉码 → `npm test` → `pm2 reload dispense`。

---

## 9. 防止「闲置回收」

官方判定规则：**7 天内 CPU、网络（A1 还含内存）三项的 95 分位均 <20%** 即视为闲置，可能被回收。

- Dispense 只要有客户端在拉配置，天然安全；
- 低频使用：用 **UptimeRobot**（免费 50 个监控）每 5 分钟请求一次 `http://<IP>:8112/d/<token>` 保活；
- 数据备份：免费资源无 SLA，定期 `tar -czf data-backup.tgz /opt/dispense/data` 下载到本地。

---

## 10. 常见报错与处理

| 报错 / 现象 | 原因 | 处理 |
|---|---|---|
| `Out of host capacity` | ARM 容量紧张（区域级供给问题，不是账号问题） | 换 Availability Domain（AD-1/2/3）；在该区域当地时间的**凌晨**重试；改小为 **1 OCPU / 6 GB** 更容易成功；实在不行先用 AMD 微型实例 `VM.Standard.E2.1.Micro`（1 GB 内存，Dispense 也跑得动） |
| SSH 连不上 | 端口未放行 / 用了 root 用户 | 检查 §6 两层防火墙；用户名是 `ubuntu` |
| 页面打不开但实例 Running | 实例内 iptables 未清 | 执行 §6 ② 的命令 |
| 未分配公网 IP | 创建时未勾选 | 实例详情 → Networking → VNIC → IP administration → 分配 Ephemeral public IP |
| 删了实例但存储仍被占 | 残留 boot volume 占 200 GB 配额 | Storage → Boot Volumes 删除残留卷 |

### 关于「升级 PAYG 更容易抢到 ARM」的取舍（重要）

社区经验是：升级到 Pay As You Go 后抢 ARM 容量成功率显著提高。
**但这与你的"零付费风险"目标直接冲突**——升级会引入 $100 预授权，且一旦升级就存在真实扣费路径
（社区中也有"设了告警仍被扣费"的个例报告）。

**我的建议：先不要升级**，按上面办法多试几次（换 AD、凌晨重试、先开 1C/6G 再尝试扩容）。
只有当你连续多天完全抢不到、且能接受付费风险时，才考虑升级，并务必先完成 §3 的预算告警。

---

## 11. 月度自检清单（5 分钟）

1. **Billing & Cost Management → Cost Analysis**：本月花费应为 **$0**；
2. **Governance & Administration → Limits, Quotas and Usage**：核对 Compute / Block Storage 的 Used ≤ Limit；
3. **Storage → Block Volumes + Boot Volumes**：总量 < 200 GB；
4. **Compute → Instances**：仅存在标注 Always Free-eligible 的实例；
5. 页面顶部 **Plan Type 应显示 Free Tier**（不是 Pay As You Go）。

---

## 12. 官方链接

- 免费层总览与试用转 Always Free 规则：<https://docs.oracle.com/iaas/Content/FreeTier/freetier.htm>
- Always Free 资源清单与额度：<https://docs.oracle.com/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm>
- 账户升级与信用卡授权说明：<https://docs.oracle.com/iaas/Content/Billing/Tasks/changingpaymentmethod.htm>
- 注册入口：<https://www.oracle.com/cloud/free/>
