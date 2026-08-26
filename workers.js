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
  const { GH_PAT, GH_USER, GH_REPO } = env;
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
    if (response.ok) return `GitHub Actions 已触发（${source}）`;
    return `GitHub 触发失败 (${response.status}): ${(await response.text()).slice(0, 300)}`;
  } catch (error) {
    return `Worker 内部错误: ${error.message}`;
  }
}
