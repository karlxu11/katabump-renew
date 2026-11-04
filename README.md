## 🚀 katabump 自动续期（GitHub Actions）

这是一个基于 GitHub Actions 的自动化脚本，用于定时登录自动续期[katabump](https://dashboard.katabump.com) 应用。
工作流支持 Cloudflare Worker 按账号定时触发和 GitHub Actions 手动触发。

⚠️ 有cf盾,太垃圾的机房节点可能过不了，建议用稍微干净点的节点,[B2proxy住宅代理](https://www.b2proxy.com/signup?code=0F5133)

━━━━━━━━━━━━━━━━━━━━━━

🔐 Secrets 配置说明

| Secret 名称         | 是否必填 | 说明                                              |
|---------------------|----------|---------------------------------------------------|
| KATABUMP_ACCOUNTS  | 多账号时必填 | 多账号登录信息，使用 JSON 数组配置；设置后优先于单账号 Secrets |
| KATABUMP_EMAIL     | 单账号必填 | katabump 登录邮箱（兼容原有单账号配置）             |
| KATABUMP_PASSWORD  | 单账号必填 | katabump 登录密码（兼容原有单账号配置）             |
| TG_BOT_TOKEN       | ❌ 可选  | Telegram Bot Token（用于发送通知）                     |
| TG_CHAT_ID         | ❌ 可选  | Telegram Chat ID（接收通知的用户或群组 ID）              |
| CF_ACCOUNT_ID      | KV 调度必填 | Cloudflare Account ID，沿用原有配置 |
| CF_WORKER_NAME     | KV 调度必填 | 已部署 Worker 的名称，脚本会自动查找其 `RENEW_KV` 绑定 |
| CF_API_TOKEN       | KV 调度必填 | Cloudflare API Token，需具备该账号的 `Workers Scripts: Read`（原有 Edit 权限也可）及 `Workers KV Storage: Edit` 权限 |

多账号时，在 GitHub 仓库的 Actions Secrets 中添加 `KATABUMP_ACCOUNTS`，值为 JSON 数组：

```json
[
  {"email": "account1@example.com", "password": "第一个账号密码"},
  {"email": "account2@example.com", "password": "第二个账号密码"}
]
```

手动运行会按数组顺序逐个登录和续期；Worker 定时触发时只处理当次到期的账号。每个账号使用独立浏览器会话，一个账号登录或处理失败不会阻止后续账号。Telegram 通知会分别标出脱敏后的账号邮箱。若只配置 `KATABUMP_EMAIL` 和 `KATABUMP_PASSWORD`，仍按原有单账号方式运行。

### Cloudflare KV 多账号调度

1. 创建一个 Cloudflare KV namespace，在 Worker 的 Bindings 中绑定，变量名必须为 `RENEW_KV`。
2. 将仓库根目录的 `workers.js` 部署为 Worker，设置以下 Worker Secrets / 变量：

   | 名称 | 说明 |
   |------|------|
   | `GH_PAT` | GitHub PAT；fine-grained token 需要该仓库的 `Contents: Read and write`，classic token 需要 `repo` scope（[权限说明](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event)） |
   | `GH_USER` | 仓库所属用户或组织 |
   | `GH_REPO` | 仓库名称，不含 `.git` |
   | `AUTH_KEY` | 自行生成的认证密钥，仅用于 Worker 的手动操作和计划查询，不需要放入 GitHub Secrets |
   | `TG_BOT_TOKEN` / `TG_CHAT_ID` | 可选，Worker 触发通知；与 Actions 的同名 Secrets 分开配置 |

3. 为 Worker 设置一个固定 Cron：`12 0 * * *`，即每天**北京时间 08:12**检查 KV。删除原来按单个账号日期设置的 Cron。Cron 使用 UTC，脚本不再修改 Cron。[Cloudflare Cron 文档](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
4. 在 GitHub Actions Secrets 中保留原有的 `CF_ACCOUNT_ID`、`CF_WORKER_NAME`、`CF_API_TOKEN`，并配置账号，然后手动运行一次工作流，初始化所有账号的 KV 计划。修改后的工作流需位于仓库默认分支，才能接收 `repository_dispatch`。

脚本通过 Cloudflare API 读取指定 Worker 的 `RENEW_KV` 绑定，自动获取 namespace ID，再直接写入 KV；不需要配置 Worker 地址、GitHub 侧的 Worker 认证密钥或额外的 KV ID。原来只用于更新 Cron 的 API Token 如果仅有 `Workers Scripts: Edit`，请补充同一账号下的 `Workers KV Storage: Edit` 权限；原有脚本权限可以保留。[Worker 绑定查询接口](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/get/)、[KV 写入接口与权限](https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/subresources/values/methods/update/)

脚本优先读取 Dashboard、服务器详情页或续期提交后的页面提示，例如：

```text
You can't renew your server yet. You will be able to as of 07 November (in 3 day(s)).
```

若当前为 2026 年 11 月 4 日，将该账号的可续期日期保存为 `2026-11-07`，第一次触发安排在 **2026-11-06 08:12（北京时间）**。另一个账号若提示 11 月 12 日，则安排在 11 月 11 日。日期解析支持英文月份、ISO 日期和跨月、跨年，服务器详情页的 `Expiry` 不用于调度。

提前一天运行时，网站可能仍不允许续期。此时首选触发时间已过去，脚本会将 KV 计划更新为次日 08:12 再试。续期成功后会刷新页面尝试读取下一次日期；页面未给出日期、登录失败或流程异常时，保留尚未到期的计划，否则安排次日重试，以便重新获取日期。KV 同步失败会令该次 Actions 运行失败，其他账号仍继续执行；已有的到期 KV 记录会留待下一天重试。

KV 为每个邮箱保存独立的 `schedule:<邮箱去空格并转小写后的 SHA-256>` 记录，只包含账号哈希、可续期日期、下一次触发时间和更新时间，密码仍保存在 GitHub Secrets 中。Worker 每天只派发已到期的账号，通过 `client_payload.account_ids` 让 Actions 筛选对应账号。同一天的派发记录使用独立的 `dispatch:` 键，GitHub 拒绝派发时不会写入该记录；Actions 尚未更新日期时，下一天仍会重试。

KV 是最终一致的，同一天的派发记录用于尽量避免重复运行，不能作为严格的分布式锁；同时调用或跨节点读取仍可能重复派发。[Cloudflare KV 一致性说明](https://developers.cloudflare.com/kv/concepts/how-kv-works/)

可用以下地址手动操作（均需认证，也可用 `Authorization: Bearer AUTH_KEY` 请求头替代 `?key=`）：

- `https://你的Worker地址/?key=AUTH_KEY`：立即检查，只触发当前到期且今天未派发的账号；
- `https://你的Worker地址/?key=AUTH_KEY&all=1`：强制触发所有账号，可用于初始化；
- `https://你的Worker地址/schedules?key=AUTH_KEY`：查看 KV 中所有账号的计划（时间字段为 UTC）。

新增账号后需手动运行一次所有账号以初始化；删除或更换邮箱后，请在 KV 中删除旧账号的 `schedule:` 记录，避免继续派发已不存在的账号。未配置上述三个 Cloudflare Secrets 时，手动运行仍可正常使用，但不会初始化或更新 KV 计划。

━━━━━━━━━━━━━━━━━━━━━━
### VPNGate SOCKS5 代理

本版本不再使用 `NODE_LINK` 和远程 sing-box 脚本。工作流会在 GitHub Actions 的
Ubuntu runner 中临时启动 [vpngate-to-socks](https://github.com/shenyanshu/vpngate-to-socks)：

1. 拉取 VPN Gate 节点列表；
2. 默认只保留日本节点，并排除节点名称中含 `public` 的节点；
3. 自动连接、监测并在节点失效后重新选择；
4. 连接成功时，将本机 SOCKS5 `socks5://127.0.0.1:10080` 提供给 `app.py`；没有可用连接时，自动改为直连继续执行续期脚本。

筛选条件可在 `.github/workflows/renew.yml` 的“启动 VPNGate SOCKS5 代理”步骤中修改：

- `VPNGATE_COUNTRY`：国家代码，默认 `JP`；
- `VPNGATE_EXCLUDE_KEYWORD`：节点名称排除关键词，默认 `public`。

该方案依赖 GitHub Actions runner 的 Docker、`privileged` 和 `NET_ADMIN` 网络能力。
SOCKS5 端口只绑定到 `127.0.0.1`，不要改成公网监听。

### 注意事项
- VPNGate 免费节点质量和存活时间不稳定，无法保证每次都能通过 Katabump 的 Cloudflare 验证；
- 如果筛选条件下暂时没有可用节点，工作流最多等待 300 秒，然后禁用代理并通过直连继续执行续期脚本；VPNGate 准备或启动失败时也会自动回退直连；

### 本地验证

测试使用内存 KV 和模拟的浏览器、HTTP 请求，不会登录或触发真实续期：

```bash
node --test tests/workers.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
```
