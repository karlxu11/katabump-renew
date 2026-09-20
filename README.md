## 🚀 katabump 自动续期（GitHub Actions）

这是一个基于 GitHub Actions 的自动化脚本，用于定时登录自动续期[katabump](https://dashboard.katabump.com) 应用。
工作流支持 GitHub 每日定时触发和手动触发。

⚠️ 有cf盾,太垃圾的机房节点可能过不了，建议用稍微干净点的节点,[B2proxy住宅代理](https://www.b2proxy.com/signup?code=0F5133)

━━━━━━━━━━━━━━━━━━━━━━

🔐 Secrets 配置说明

| Secret 名称         | 是否必填 | 说明                                              |
|---------------------|----------|---------------------------------------------------|
| KATABUMP_EMAIL     | ✅ 必填  | katabump 登录邮箱                                    |
| KATABUMP_PASSWORD  | ✅ 必填  | katabump 登录密码                                    | 
| TG_BOT_TOKEN       | ❌ 可选  | Telegram Bot Token（用于发送通知）                     |
| TG_CHAT_ID         | ❌ 可选  | Telegram Chat ID（接收通知的用户或群组 ID）              |

━━━━━━━━━━━━━━━━━━━━━━
### VPNGate SOCKS5 代理

本版本不再使用 `NODE_LINK` 和远程 sing-box 脚本。工作流会在 GitHub Actions 的
Ubuntu runner 中临时启动 [vpngate-to-socks](https://github.com/shenyanshu/vpngate-to-socks)：

1. 拉取 VPN Gate 节点列表；
2. 默认只保留日本节点，并排除节点名称中含 `public` 的节点；
3. 自动连接、监测并在节点失效后重新选择；
4. 将本机 SOCKS5 `socks5://127.0.0.1:10080` 提供给 `app.py`。

筛选条件可在 `.github/workflows/renew.yml` 的“启动 VPNGate SOCKS5 代理”步骤中修改：

- `VPNGATE_COUNTRY`：国家代码，默认 `JP`；
- `VPNGATE_EXCLUDE_KEYWORD`：节点名称排除关键词，默认 `public`。

该方案依赖 GitHub Actions runner 的 Docker、`privileged` 和 `NET_ADMIN` 网络能力。
SOCKS5 端口只绑定到 `127.0.0.1`，不要改成公网监听。

### 注意事项
- VPNGate 免费节点质量和存活时间不稳定，无法保证每次都能通过 Katabump 的 Cloudflare 验证；
- 工作流在启动浏览器前会通过 SOCKS5 实际访问 Katabump，控制接口显示 `connected` 但出口尚未可用时会继续等待；
- 如果筛选条件下暂时没有可用节点，工作流会等待 300 秒后失败，不会退回直连；
- 续期会处理 Renew 弹窗中的 ALTCHA，并通过提交前后的 `Expiry` 变化确认成功；页面只有固定 Warning 或没有明确证据时不会报告成功；每次工作流只执行 1 次续期尝试；
