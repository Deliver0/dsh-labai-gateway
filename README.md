# dsh-labai-gateway

实验室 AI 网关的 **DeepSeek Harness 插件**：网关 DHCP 换了 IP，同学什么都不用改。

> 本插件只在校园网内、且持有实验室管理员签发的 `sk-lab-…` Key 时可用。它不是公共服务。

---

## 它解决什么问题

实验室用一台 Windows 主机跑 API 网关，统一持有 DeepSeek 经费；同学各拿一把 `sk-lab-…` Key，在自己的 DSH / Agent 工具里用。

麻烦在于校园网是 DHCP：主机 IP 一变，30 个人工具里填的 `http://10.16.35.100:8800` 全部失效，得挨个通知改配置。

这个插件在每台同学机器上起一个**本地反代**，把"会变的地址"藏在后面：

```
  DSH / Cursor / Cline / Claude Code
        │  固定填 http://127.0.0.1:8801   ← 永远不变
        ▼
  本机插件代理  127.0.0.1:8801
        │  ① 自动发现网关当前 IP
        │  ② 注入本人的 API Key
        │  ③ 原样透传请求与 SSE 流
        ▼
  实验室网关  http://<当前 IP>:8800
        │
        ▼
     DeepSeek API
```

发现顺序：**上次成功的 IP（缓存）→ 已知地址 → 当前 /24 → 校园网 /20**，每一跳都要求 `/healthz` 返回约定的 `lab` 标识，避免误连到别人恰好开在 8800 端口上的服务。命中即停，正常情况下几十毫秒。

连接中途网关换 IP 时，代理会作废缓存、重新发现、并用**同一份请求体**自动重试一次（POST 聊天请求不会丢内容）。

---

## 同学：安装（一次就够）

前置：Windows、DeepSeek Harness 0.2.1+、已连校园网、管理员给你的 `sk-lab-…` Key。

### 方式 A · 双击安装（最省事）

1. 下载本仓库，解压到任意目录。
2. 双击 `install.bat`。
3. 按提示粘贴你的 `sk-lab-…` Key，回车。
4. **完全退出 DeepSeek Harness，再重新打开。**

脚本会自动完成：复制插件到 `~/.dsh/plugins/`、登记 bundle、新增「实验室网关」通道并设为默认、写入凭证、生成本地配置。所有改动都带标记且先备份，**重复运行安全**。

### 方式 B · 在 DSH「发现」页里搜到并安装

仓库地址：<https://github.com/Deliver0/dsh-labai-gateway>

**先加一次索引源**（全组每人做一次）：打开「插件 → 发现 → 索引源」，添加

```text
https://cdn.jsdelivr.net/gh/Deliver0/dsh-labai-gateway@main/index.json
```

想锁死在某个版本、不随后续提交变化，用带 tag 的不可变地址：

```text
https://cdn.jsdelivr.net/gh/Deliver0/dsh-labai-gateway@v1.0.0/index.json
```

jsDelivr 打不开时才考虑等价地址（部分校园网会屏蔽 `raw.githubusercontent.com`）：

```text
https://raw.githubusercontent.com/Deliver0/dsh-labai-gateway/v1.0.0/index.json
```

> `@main` 在 CDN 上有数小时缓存，改完索引不会立刻全网生效；`@v1.0.0` 不会变。

这是 DSH 0.2.1+ 的 **format-1 插件市场索引**。加完后在「发现」页搜 `dsh-labai-gateway` 或「实验室网关」就能看到并点安装。宿主会把 Git 源拼成 `git+https://github.com/Deliver0/dsh-labai-gateway.git#<commit>`，装的是索引里**锁定的那个提交**，不会随 main 分支悄悄变化。

不想加索引源，也可以直接用命令行装：

```text
dsh plugin --profile desktop add github:Deliver0/dsh-labai-gateway
```

> **两种装法都还需再跑一次 `install.bat`**（或 `node bin/setup.mjs --key sk-lab-…`）来填自己的 Key、生成「实验室网关」通道配置。每个人的 Key 不同，这一步没法省。
>
> 若要进入**官方公共目录**被所有人搜到，需向 `awesome-dsh-plugin/awesome-dsh-plugin` 提 PR。但对实验室内部工具，自定义索引源更合适：外部用户装了也连不上你们的网关。

### 管理员：发版时怎么更新索引

format-1 对 Git 源的要求是 `source.type: "git"` + 规范 https 仓库 URL + **40 位小写 commit SHA**（不是 `"github"`、不能填分支名）。因此发版是两步提交，避免「索引引用自己」的循环：

```bash
# 1. 先提交并 push 插件代码（别带上 index.json 的改动）
git add . && git reset -- index.json && git commit -m "release: v1.0.1" && git push

# 2. 把索引锁到第 1 步的提交，然后只提交索引
node bin/update-index.mjs
git add index.json && git commit -m "chore: pin market index" && git push
```

`bin/update-index.mjs` 会自动从 `origin` 推仓库 URL、取 HEAD 的 SHA 与提交时间，并回填到所有 `versions[]`。改版本号时记得同步 `package.json` 与 `index.json` 里的 `version`。

---

## 验证

```bash
node bin/selftest.mjs   # 9 项：模拟网关换 IP，验证自动发现/重试/POST 重放/误连防护
node bin/smoke.mjs      # 5 项：对真实网关跑模型列表、非流式对话、SSE 流式、免填 Key
```

浏览器打开 <http://127.0.0.1:8801/__labai/status>：

| 返回 | 含义 |
| --- | --- |
| `"ip": "10.16.x.x"` | 已连上网关，正常用 |
| `"ip": null` | 网关没开机 / 防火墙没放行 8800 / 新 IP 不在扫描网段里 |

`http://127.0.0.1:8801/__labai/refresh` 可以强制重新发现一次。

---

## 管理员

### 网关侧要求

网关的 `/healthz` 必须返回实验室标识，供插件确认"这是自己人"：

```json
{"ok": true, "ts": "2026-11-05T08:04:20+00:00", "lab": "lab-ai-gateway-v1"}
```

该值必须与 `lib/proxy.mjs` 里 `DEFAULTS.labId` 一致。**建议改成你们自己实验室的随机字符串**，避免和同网段其他部署撞车。

### 给同学发 Key

```powershell
cd winhost
.venv\Scripts\python.exe ..\gateway\admin_cli.py add 张三 zhangsan@mail.com
.venv\Scripts\python.exe ..\gateway\admin_cli.py apikey zhangsan@mail.com 10.16.35.101 张三的工位机
```

完整 Key 只显示一次，私聊发给本人。网关库里只存哈希。

### 网络与网段

默认扫描范围写在 `lib/proxy.mjs`：

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `gatewayPort` | `8800` | 网关监听端口 |
| `listenPort` | `8801` | 同学本机反代端口 |
| `seedIps` | `["10.16.35.100"]` | 上次已知地址，命中就不扫 |
| `scanNets` | `["10.16.35.0/24", "10.16.32.0/20"]` | 分层网段，按你们校园网 DHCP 池调整 |
| `probeTimeoutMs` / `concurrency` | `500` / `96` | 探测超时与并发 |

如果网关换到了扫描范围**之外**的网段，管理员把新 IP 发群里，同学跑一次即可（幂等，不会重装）：

```bash
node bin/setup.mjs --seed-ip 10.20.7.31
```

> 扫描会向校园网内若干地址的 8800 端口发起 TCP 连接。正常使用时因为有缓存几乎不触发；如需完全避免扫描，请到网络中心做 DHCP 保留 / 固定 IP，并把它写进 `seedIps`。

### 上线前必做

1. 网关主机防火墙放行 TCP `8800`（`Domain, Private`）。
2. 网关服务常驻（开机自启），且 `/healthz` 带 `lab` 字段。
3. 确认 `8801` 在同学机器上没被别的程序占用。

---

## 配置文件

`~/.labai/dsh.json`（由 `install.bat` 生成）：

```json
{
  "listenPort": 8801,
  "gatewayPort": 8800,
  "labId": "lab-ai-gateway-v1",
  "seedIps": ["10.16.35.100"],
  "scanNets": ["10.16.35.0/24", "10.16.32.0/20"],
  "apiKey": "sk-lab-…",
  "overrideAuth": true
}
```

`apiKey` 只存在同学本机，不进 GitHub、不进聊天群。`overrideAuth: true` 时，代理会用本机 Key 覆盖请求的 `Authorization`，所以 Cursor / Cline 之类工具**连 Key 都不用填**，填 `http://127.0.0.1:8801/v1` 就能用。

---

## 安全边界与局限

- **防的是"顺手转发"**：每人一把 Key、Key 哈希存储、可绑定来源 IP、按人限额与审计，都在网关侧。插件不削弱这些。
- **不防**能物理接触同学电脑的人；本机 `~/.labai/dsh.json` 是明文，这是本地代理方案的固有代价。
- `labId` 只是防误连，不是认证。同网段内刻意伪造 `/healthz` 可以冒充网关，威胁模型里不考虑这种情形。
- 请求体会先缓冲到内存（上限 16MB），才能在下一次重试时原样重放；这是聊天请求的安全取舍，不适合拿它传大文件。
- 只在本机 `127.0.0.1` 监听，不对局域网暴露。

## 卸载

双击 `uninstall.bat`，或 `node bin/setup.mjs --uninstall`，然后重启 DSH。卸载会精确撤销安装时的改动（`cordis.patch.yml`、`package.json`、凭证、插件目录），备份保留在 `~/.labai/backups/`。

## 许可

MIT
