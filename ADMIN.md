# 管理员备忘

同学只看 `README.md`，这里记维护用的东西。

## 管理面板（平时用这个）

双击 `winhost/admin.bat`：会先确保网关在跑，然后自动带管理员令牌打开浏览器里的可视化界面。
界面是 `winhost/admin.html`，挂在网关的 `/admin` 上，纯本地、不依赖外网。

三个页签：

| 页签 | 能做什么 |
| --- | --- |
| ① 发 Key & 审批 | 填姓名/邮箱/IP 一步生成 Key；待审批列表显示谁装好了、报到时间和来源 IP，点「通过」/「拒绝」 |
| ② 用量监控 | 全员今日/本月/累计调用与 tokens、全组月度进度条，点「明细」看按模型拆分、最近 20 次调用、他的 Key |
| ③ 成员管理 | 停用 / 恢复 / 通过 / 拒绝 / 重发 Key / 吊销 Key |

默认每 15 秒自动刷新。令牌来自 `config.json` 的 `admin_token`，bat 会自动带上；手动打开 `/admin` 时页面会让你粘一次。

## 一名同学从零到能用的完整流程

顺序不能反：**先拿到他报的 IP，才能签出绑在他机器上的 Key**。反过来先发 Key 再问 IP，
他安装报到时会被 `ip_denied` 挡掉，得重签一次。

1. **同学先把姓名、邮箱、IP 报过来**。`README.md` 第 1 步给了查 IP 的现成命令
   （`ipconfig | findstr /i "IPv4"`，取 `10.16` 开头那个），第 2 步列了要发的三样。
   邮箱只是组内唯一标识，对方随便给个 `zhangsan@lab.local` 这种也行，不用真能收信。
2. **你在管理页 ① 生成 Key**：姓名、邮箱、「允许使用的 IP」按他报的地址填。
   - 填他发来的单个 IP（如 `10.16.35.100`）：**原样粘进去就行，不用换算成网段**，绑死一台机器最安全
   - 填 `*`：不绑定，谁拿到都能用，最省事
   - 填网段（如 `10.16.32.0/20`）：整个校园网段都放行，适合人多的组
   生成后把 `sk-lab-…` 单独发给本人（只显示这一次）。此时成员是 `待审批`，Key 还不能用。
3. **把安装链接发给他**（下面「发给同学的链接」那一条），他自己下载、双击、粘贴 Key。
   `README.md` 第 3～4 步就是这一段：先完全退出 DSH，再下载运行。安装脚本会向网关 `/gw/api/claim`
   报到，记下报到时间、来源 IP、机器名，并提示他等审批。
4. **管理页 ① 的待审批列表出现这个人**，核对姓名和 IP 后点「通过」。成员变 `正常`，Key 立刻生效。
5. 他重新打开 DSH 即可使用；也能在 `127.0.0.1:8801/__labai/status` 看到 `approval.status` 从 `pending` 变 `active`。

状态：`pending` 待审批 → `active` 正常 → `disabled` 停用/拒绝 → `active` 恢复。
待审批期间所有 API 请求返回 403，但**可以先签 Key**（发 Key 本来就在审批之前，管理页 ① 就是一步做完）。停用期间 API、网页登录、签新 Key 都会被拒。

> 兜底：就算同学那步没报到成功，DSH 启动时的 `/v1/models` 也会在网关侧自动登记，人一样会出现在待审批列表里。

## 发给同学的链接（只发这一个）

```
https://github.com/Deliver0/dsh-labai-gateway/releases/latest/download/LabAI-Setup.bat
```

这是 **Release 资产 `LabAI-Setup.bat`**（内容就是 `install-online.bat` 的副本），双击会自动从 GitHub 拉完整插件再进入粘贴 Key 流程。
链接固定不变，插件代码更新只要 push 到 `main` 即可；**只有改了 `install-online.bat` 本身**，才需要把新副本重新传到 Release 覆盖同名资产。

浏览器/Windows 可能提示「此文件不安全」，让同学点「保留 → 仍要运行」即可（未签名的实验室脚本，正常现象）。
备用链接（下载 ZIP 自己解压）：<https://github.com/Deliver0/dsh-labai-gateway/archive/refs/heads/main.zip>，
或打开仓库点 `Code → Download ZIP`。`raw.githubusercontent.com` 在本校网络不通，
jsDelivr 会拦 `.bat`，所以分发只走 `github.com` / Release，别改成 raw 或 CDN 链接。

## 命令行（不想开界面时）

```powershell
cd <项目目录>\lab-ai-gateway\winhost
$py = ".\.venv\Scripts\python.exe"

& $py ..\gateway\admin_cli.py add 张三 zhangsan@mail.com              # 加人（默认待审批）
& $py ..\gateway\admin_cli.py apikey zhangsan@mail.com 10.16.35.101 张三的工位机  # 发 Key（只显示一次）
& $py ..\gateway\admin_cli.py list                                    # 看所有人
& $py ..\gateway\admin_cli.py usage                                   # 看每人用量
& $py ..\gateway\admin_cli.py usage zhangsan@mail.com                 # 看某个人明细
& $py ..\gateway\admin_cli.py enable zhangsan@mail.com                 # 通过审批 / 恢复
& $py ..\gateway\admin_cli.py disable zhangsan@mail.com 毕业离组        # 停用 / 拒绝
& $py ..\gateway\admin_cli.py keys                                     # 看所有 Key
& $py ..\gateway\admin_cli.py revokekey zhangsan@mail.com              # 吊销 Key（不可恢复，要重发）
```

**停用 vs 吊销**：`disable` 只是把人关掉，原来的 Key 留着，`enable` 后立刻能继续用，适合临时限制。`revokekey` 是把 Key 作废，得重新签发并发给本人，适合 Key 泄露或人真的走了。

`app.py` 和 `config.json` 都是启动时加载的，改完**必须重启网关**才生效；`admin.html` 是每次请求现读的，改完刷新浏览器就行。

## 网关侧要求

`/healthz` 要返回实验室标识，插件靠它认网关，避免连到别人开在 8800 上的服务：

```json
{"ok": true, "ts": "2026-11-05T08:04:20+00:00", "lab": "lab-ai-gateway-v1"}
```

该值要和 `lib/proxy.mjs` 的 `DEFAULTS.labId` 一致。建议换成自己实验室的随机串。

上线前：防火墙放行 TCP 8800（Domain, Private）、网关服务开机自启、确认同学机器上 8801 没被占用。

## 网段与换 IP

默认写在 `lib/proxy.mjs`：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `gatewayPort` | `8800` | 网关端口 |
| `listenPort` | `8801` | 同学本机代理端口 |
| `seedIps` | `["10.16.35.100"]` | 已知地址，命中就不扫 |
| `scanNets` | `["10.16.35.0/24", "10.16.32.0/20"]` | 分层扫描网段，按校园网 DHCP 池调整 |
| `probeTimeoutMs` / `concurrency` | `500` / `96` | 探测超时与并发 |

发现顺序：缓存 → seed → 当前 /24 → /20，每跳都校验 `/healthz` 的 `lab`。命中即停，通常几十毫秒。连接中途换 IP 会作废缓存、重新发现、用同一份请求体重试一次。

如果网关换到了扫描范围**之外**的网段，把新 IP 通知大家，让他们各自跑一次（幂等，不会重装）：

```bash
node bin/setup.mjs --seed-ip 10.20.7.31
```

想彻底不扫描，去网络中心做 DHCP 保留 / 固定 IP，写进 `seedIps`。

## 本地配置

`~/.labai/dsh.json` 由 `install.bat` 生成，`apiKey` 只存同学本机，不进 GitHub：

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

`overrideAuth: true` 时代理会用本机 Key 覆盖请求的 `Authorization`，所以工具连 Key 都不用填。

## 自检

```bash
node bin/selftest.mjs   # 9 项：模拟网关换 IP，验证发现/重试/POST 重放/误连防护
node bin/smoke.mjs      # 5 项：对真实网关跑模型列表、非流式、SSE、免填 Key
```

```powershell
# 12 项：完整审批链路（发 Key -> 报到 -> 待审批拦截 -> 通过 -> 真实对话 -> 停用/恢复）
# 在 winhost 目录跑，会自动建一个临时测试成员并在结束后清理；会真实消耗一次极小的调用额度
.\.venv\Scripts\python.exe e2e_approval.py
```

## 发版（改了插件代码才需要）

索引源：`https://cdn.jsdelivr.net/gh/Deliver0/dsh-labai-gateway@v1.0.1/index.json`（`@main` 是滚动版，CDN 有数小时缓存）。jsDelivr 打不开时用 `https://raw.githubusercontent.com/Deliver0/dsh-labai-gateway/v1.0.1/index.json`。

DSH format-1 索引的 Git 源必须是 `source.type: "git"` + 规范 https URL + **40 位小写 commit SHA**，不能用 `"github"`、不能填分支名。所以发版是两步提交，避免「索引引用自己」：

```bash
# 1. 先提交并 push 插件代码（别带 index.json）
git add . && git reset -- index.json && git commit -m "release: v1.0.1" && git push

# 2. 把索引锁到第 1 步的提交，只提交索引
node bin/update-index.mjs
git add index.json && git commit -m "chore: pin market index" && git push
```

改版本号时同步 `package.json` 与 `index.json` 的 `version`。要进官方公共目录需向 `awesome-dsh-plugin/awesome-dsh-plugin` 提 PR，实验室内部用自定义索引源更合适。

`.bat` 必须是纯 ASCII + CRLF，`.gitattributes` 里 `*.bat -text` 保证 Git 不改行尾。`.gitignore` 排除了 `config.json`、`.credentials.yaml`、`dsh.json` 等，**只发 `dsh-plugin/`，别把整个 `lab-ai-gateway/` 传上去**。

## 边界

- 每人一把 Key、网关只存哈希、可绑来源 IP、按人限额与审计，都在网关侧，插件不削弱这些。
- 不防能物理接触同学电脑的人：`~/.labai/dsh.json` 是明文，这是本地代理方案的固有代价。
- `labId` 只防误连，不是认证；同网段刻意伪造 `/healthz` 可以冒充，威胁模型里不考虑。
- 请求体会缓冲到内存（上限 16MB）以便重试时重放，不适合传大文件。
- 代理只监听 `127.0.0.1`，不对局域网暴露。
