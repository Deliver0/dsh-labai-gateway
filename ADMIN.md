# 管理员备忘

同学只看 `README.md`，这里记维护用的东西。

## 平时最常用（在网关主机上）

```powershell
cd <项目目录>\lab-ai-gateway\winhost
$py = ".\.venv\Scripts\python.exe"

& $py ..\gateway\admin_cli.py add 张三 zhangsan@mail.com              # 加人
& $py ..\gateway\admin_cli.py apikey zhangsan@mail.com 10.16.35.101 张三的工位机  # 发 Key（只显示一次）
& $py ..\gateway\admin_cli.py list                                    # 看所有人
& $py ..\gateway\admin_cli.py usage                                   # 看每人用量
& $py ..\gateway\admin_cli.py usage zhangsan@mail.com                 # 看某个人明细
& $py ..\gateway\admin_cli.py disable zhangsan@mail.com 毕业离组        # 停用
& $py ..\gateway\admin_cli.py enable zhangsan@mail.com                 # 恢复
& $py ..\gateway\admin_cli.py keys                                     # 看所有 Key
& $py ..\gateway\admin_cli.py revokekey zhangsan@mail.com              # 吊销 Key（不可恢复，要重发）
```

**停用 vs 吊销**：`disable` 只是把人关掉，原来的 Key 留着，`enable` 后立刻能继续用，适合临时限制。`revokekey` 是把 Key 作废，得重新签发并发给本人，适合 Key 泄露或人真的走了。

停用期间这人的所有 API 请求会返回 403 `账号已停用`，网页登录也会被拦；同时不能给他签新 Key。

改完 `config.json` 或 Key 之后记得 `stop.bat → start.bat` 重启服务（配置是启动时读进内存的）。

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

如果网关换到了扫描范围**之外**的网段，把新 IP 发群里让同学跑一次（幂等，不会重装）：

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

## 发版（改了插件代码才需要）

索引源：`https://cdn.jsdelivr.net/gh/Deliver0/dsh-labai-gateway@v1.0.0/index.json`（`@main` 是滚动版，CDN 有数小时缓存）。jsDelivr 打不开时用 `https://raw.githubusercontent.com/Deliver0/dsh-labai-gateway/v1.0.0/index.json`。

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
