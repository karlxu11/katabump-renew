## 🚀 katabump 自动续期（GitHub Actions）

这是一个基于 GitHub Actions 的自动化脚本，用于定时登录自动续期[katabump](https://dashboard.katabump.com) 应用。

⚠️ 有cf盾,太垃圾的机房节点可能过不了，建议用稍微干净点的节点,[B2proxy住宅代理](https://www.b2proxy.com/signup?code=0F5133)

━━━━━━━━━━━━━━━━━━━━━━

🔐 Secrets 配置说明

| Secret 名称         | 是否必填 | 说明                                              |
|---------------------|----------|---------------------------------------------------|
| KATABUMP_EMAIL     | ✅ 必填  | katabump 登录邮箱                                    |
| KATABUMP_PASSWORD  | ✅ 必填  | katabump 登录密码                                    | 
| NODE_LINK          | ❌ 可选  | 代理链接，如 vless:// vmess:// tuic:// hysteria2:// anttls:// socks5://|
| TG_BOT_TOKEN       | ❌ 可选  | Telegram Bot Token（用于发送通知）                     |
| TG_CHAT_ID         | ❌ 可选  | Telegram Chat ID（接收通知的用户或群组 ID）              |
| CF_ACCOUNT_ID      | ❌ 可选  | Cloudflare Account ID（用于自动更新 Worker Cron）       |
| CF_WORKER_NAME     | ❌ 可选  | Cloudflare Worker 名称                                  |
| CF_API_TOKEN       | ❌ 可选  | 具备 `Workers Scripts: Write` 权限的 Cloudflare API Token |

━━━━━━━━━━━━━━━━━━━━━━
### 代理格式（确认在v2rayN里使用正常的节点）

`NODE_LINK` 支持以下任意一种代理协议的完整分享链接（不配置则直连）：

- **VLESS**：`vless://uuid@server:port?security=reality&sni=...&type=ws&...`
- **VMess**：`vmess://base64encoded...`
- **Trojan**：`trojan://password@server:port?sni=...&type=ws&...`
- **tuic**：`tuic://uuid:password@server:port...`
- **anytls**：`anytls://uuid@server:port...`
- **hysteria2**：`hysteria2://base64@server:port...`
- **SOCKS5**：`socks5://user:pass@server:port` 或 `socks://user:pass@server:port`

### 注意事项
- 尽量添加一个干净的节点，以免过不了cf盾
- Cloudflare Worker 请部署仓库根目录的 `workers.js`，并设置 Worker Secrets：`GH_PAT`、`GH_USER`、`GH_REPO`、`AUTH_KEY`。
- Worker 通过 `repository_dispatch` 触发本工作流。首次部署后请手动运行一次工作流：它会从页面的 “as of 日期” 中读出下次可续期日期，并把 Worker Cron 改为前一天 08:12（北京时间）。
