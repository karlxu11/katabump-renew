export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(triggerGithubAction(env, "Cloudflare Cron"));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    if (!env.AUTH_KEY || url.searchParams.get("key") !== env.AUTH_KEY) {
      return new Response("Unauthorized: use ?key=YOUR_AUTH_KEY", { status: 401 });
    }
    return new Response(await triggerGithubAction(env, "Manual URL"), {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};

async function triggerGithubAction(env, source) {
  const { GH_PAT, GH_USER, GH_REPO, TG_BOT_TOKEN, TG_CHAT_ID } = env;
  if (!GH_PAT || !GH_USER || !GH_REPO) {
    return "Worker 配置缺失: 请设置 GH_PAT / GH_USER / GH_REPO";
  }

  try {
    const response = await fetch(`https://api.github.com/repos/${GH_USER}/${GH_REPO}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GH_PAT}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "Cloudflare-Worker-Action-Trigger",
      },
      body: JSON.stringify({ event_type: env.GH_EVENT_TYPE || "cf_timer" }),
    });
    const message = response.ok
      ? `✅ GitHub Actions 已触发\n仓库: ${GH_USER}/${GH_REPO}\n来源: ${source}`
      : `❌ GitHub 触发失败 (${response.status}): ${(await response.text()).slice(0, 300)}`;
    await sendTelegramMessage(TG_BOT_TOKEN, TG_CHAT_ID, message);
    return message;
  } catch (error) {
    const message = `❌ Worker 内部错误: ${error.message}`;
    await sendTelegramMessage(TG_BOT_TOKEN, TG_CHAT_ID, message);
    return message;
  }
}

function normalizeTelegramToken(rawToken) {
  let token = String(rawToken || "").trim();
  if (token.startsWith("https://api.telegram.org/bot") || token.startsWith("http://api.telegram.org/bot")) {
    token = token.replace(/^https?:\/\/api\.telegram\.org\/bot/, "").split("/", 1)[0];
  } else if (token.startsWith("bot")) {
    token = token.slice(3);
  }
  return token.trim();
}

async function sendTelegramMessage(rawToken, chatId, text) {
  const token = normalizeTelegramToken(rawToken);
  const targetChatId = String(chatId || "").trim();
  if (!token || !targetChatId) return;

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: targetChatId, text }),
    });
    if (!response.ok) console.log(`Telegram notification failed (${response.status}): ${await response.text()}`);
  } catch (error) {
    console.log(`Telegram notification error: ${error.message}`);
  }
}
