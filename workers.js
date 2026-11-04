export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDueSchedules(env, "Cloudflare Cron", new Date(event.scheduledTime)));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    const authorized = env.AUTH_KEY && (
      request.headers.get("Authorization") === `Bearer ${env.AUTH_KEY}` ||
      url.searchParams.get("key") === env.AUTH_KEY
    );
    if (!authorized) {
      return new Response("Unauthorized", { status: 401 });
    }

    try {
      requireKV(env);
      if (url.pathname === "/schedules" && request.method === "GET") {
        return jsonResponse({ schedules: await listSchedules(env) });
      }
      if (url.pathname === "/" && request.method === "GET") {
        // all=1 用于首次初始化或手动强制处理所有账号。
        const result = url.searchParams.get("all") === "1"
          ? await triggerGithubAction(env, "Manual URL (all accounts)")
          : await runDueSchedules(env, "Manual URL");
        return jsonResponse(result);
      }
      return jsonResponse({ error: "Not found" }, 404);
    } catch (error) {
      console.log(`Worker error: ${error.message}`);
      return jsonResponse({ error: error.message }, 500);
    }
  },
};

const SCHEDULE_PREFIX = "schedule:";
const BJ_OFFSET_MS = 8 * 60 * 60 * 1000;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function requireKV(env) {
  if (!env.RENEW_KV) throw new Error("请绑定 Cloudflare KV，变量名为 RENEW_KV");
}

function beijingDate(now) {
  return new Date(now.getTime() + BJ_OFFSET_MS).toISOString().slice(0, 10);
}

async function listSchedules(env) {
  const schedules = [];
  let cursor;
  do {
    const page = await env.RENEW_KV.list({ prefix: SCHEDULE_PREFIX, ...(cursor ? { cursor } : {}) });
    for (const key of page.keys) {
      const schedule = await env.RENEW_KV.get(key.name, "json");
      if (schedule) schedules.push(schedule);
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  } while (cursor);
  return schedules;
}

async function runDueSchedules(env, source, now = new Date()) {
  requireKV(env);
  const today = beijingDate(now);
  const due = [];
  for (const schedule of await listSchedules(env)) {
    if (!/^[a-f0-9]{64}$/.test(schedule.account_id) ||
        !(Date.parse(schedule.next_trigger_at) <= now.getTime())) continue;
    // 派发记录单独存储，避免覆盖 GitHub Actions 回传的新调度日期。
    const receiptKey = `dispatch:${today}:${schedule.account_id}`;
    if (!await env.RENEW_KV.get(receiptKey)) due.push({ ...schedule, receiptKey });
  }
  if (!due.length) return { dispatched: 0, message: "没有到期账号" };

  let dispatched = 0;
  // 分批控制 GitHub client_payload 大小；一批只创建一次工作流运行。
  for (let offset = 0; offset < due.length; offset += 100) {
    const batch = due.slice(offset, offset + 100);
    await triggerGithubAction(env, source, batch.map(schedule => schedule.account_id));
    for (const schedule of batch) {
      await env.RENEW_KV.put(schedule.receiptKey, now.toISOString(), { expirationTtl: 172800 });
    }
    dispatched += batch.length;
  }
  return { dispatched, message: "已触发到期账号的 GitHub Actions" };
}

async function triggerGithubAction(env, source, accountIds) {
  const { GH_PAT, GH_USER, GH_REPO, TG_BOT_TOKEN, TG_CHAT_ID } = env;
  if (!GH_PAT || !GH_USER || !GH_REPO) {
    throw new Error("Worker 配置缺失: 请设置 GH_PAT / GH_USER / GH_REPO");
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
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        event_type: env.GH_EVENT_TYPE || "cf_timer",
        ...(accountIds ? { client_payload: { account_ids: accountIds } } : {}),
      }),
    });
    if (!response.ok) {
      throw new Error(`GitHub 触发失败 (${response.status}): ${(await response.text()).slice(0, 300)}`);
    }
    const message = `✅ GitHub Actions 已触发\n仓库: ${GH_USER}/${GH_REPO}\n来源: ${source}\n账号: ${accountIds ? accountIds.length : "全部"}`;
    await sendTelegramMessage(TG_BOT_TOKEN, TG_CHAT_ID, message);
    return { dispatched: accountIds ? accountIds.length : "all", message };
  } catch (error) {
    const message = `❌ Worker 内部错误: ${error.message}`;
    await sendTelegramMessage(TG_BOT_TOKEN, TG_CHAT_ID, message);
    throw error;
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
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) console.log(`Telegram notification failed (${response.status}): ${await response.text()}`);
  } catch (error) {
    console.log(`Telegram notification error: ${error.message}`);
  }
}
