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
        const schedules = await listSchedules(env);
        // 浏览器显示控制台；原有脚本请求与显式 JSON 请求继续返回相同的数据格式。
        const format = url.searchParams.get("format");
        if (format === "html" || (format !== "json" && request.headers.get("Accept")?.includes("text/html"))) {
          return schedulesResponse(schedules);
        }
        return jsonResponse({ schedules });
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

// 页面与 Worker 放在同一文件中，保持直接上传 workers.js 的部署方式。
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function timestamp(value) {
  return typeof value === "string" && value.trim() ? Date.parse(value) : NaN;
}

function beijingParts(value) {
  const milliseconds = typeof value === "number" ? value : timestamp(value);
  if (!Number.isFinite(milliseconds)) return null;
  const iso = new Date(milliseconds + BJ_OFFSET_MS).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
}

function scheduleState(schedule, now) {
  const next = timestamp(schedule.next_trigger_at);
  if (!Number.isFinite(next)) return "unknown";
  return next <= now ? "due" : "waiting";
}

function relativeTime(value, now) {
  const milliseconds = timestamp(value);
  if (!Number.isFinite(milliseconds)) return "等待初始化";
  const minutes = Math.ceil(Math.abs(milliseconds - now) / 60000);
  if (milliseconds <= now) return "等待定时检查";
  if (minutes < 60) return `${minutes} 分钟后`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} 小时 ${minutes % 60} 分钟后` : `${Math.floor(hours / 24)} 天 ${hours % 24} 小时后`;
}

function icon(name, className = "") {
  const paths = {
    layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/>',
    arrow: '<path d="M7 17 17 7M7 7h10v10"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 17.9 17"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.9"/><circle cx="9" cy="7" r="4"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M16 3v4M8 3v4M3 11h18m-12 5 2 2 4-4"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    code: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    inbox: '<path d="M4 4h16l2 12v4H2v-4L4 4Z"/><path d="M2 15h6l2 3h4l2-3h6"/>',
  };
  return `<svg class="icon ${className}" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.clock}</svg>`;
}

function scheduleRow(schedule, index, now) {
  const accountId = String(schedule.account_id || "未记录账号");
  const shortId = accountId.length > 20 ? `${accountId.slice(0, 8)}…${accountId.slice(-6)}` : accountId;
  const state = scheduleState(schedule, now);
  const states = { waiting: "计划中", due: "待触发", unknown: "待初始化" };
  const next = beijingParts(schedule.next_trigger_at);
  const updated = beijingParts(schedule.updated_at);
  const renewal = /^\d{4}-\d{2}-\d{2}$/.test(schedule.renewal_date || "") && Number.isFinite(timestamp(schedule.renewal_date)) &&
    new Date(timestamp(schedule.renewal_date)).toISOString().slice(0, 10) === schedule.renewal_date
    ? schedule.renewal_date : null;
  return `<tr data-state="${state}" data-account="${escapeHtml(accountId.toLowerCase())}">
    <td data-label="账号标识"><div class="account-cell"><span class="avatar avatar-${index % 3}">${String(index + 1).padStart(2, "0")}</span><div><span class="account-id" title="${escapeHtml(accountId)}">${escapeHtml(shortId)}</span><span class="cell-note">账号 ${String(index + 1).padStart(2, "0")}</span></div><button type="button" class="copy-button" data-copy="${escapeHtml(accountId)}" aria-label="复制账号 ${String(index + 1).padStart(2, "0")} 的完整标识">${icon("copy")}</button></div></td>
    <td data-label="调度状态"><span class="badge ${state}"><span class="status-dot"></span>${states[state]}</span></td>
    <td data-label="可续期日期">${renewal ? `<time datetime="${renewal}">${renewal}</time><span class="cell-note">网站允许续期的日期</span>` : '<span class="muted">尚未获取</span>'}</td>
    <td data-label="下次触发">${next ? `<time datetime="${escapeHtml(schedule.next_trigger_at)}">${next.date}<span class="time-part">${next.time}</span></time><span class="cell-note ${state === "due" ? "text-amber" : "text-green"}">${relativeTime(schedule.next_trigger_at, now)}</span>` : '<span class="muted">等待初始化</span>'}</td>
    <td data-label="最近更新">${updated ? `<time datetime="${escapeHtml(schedule.updated_at)}">${updated.date}<span class="time-part">${updated.time}</span></time>` : '<span class="muted">暂无记录</span>'}</td>
  </tr>`;
}

function schedulesResponse(schedules, now = Date.now()) {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const counts = { waiting: 0, due: 0, unknown: 0 };
  const sorted = [...schedules].sort((left, right) =>
    (Number.isFinite(timestamp(left.next_trigger_at)) ? timestamp(left.next_trigger_at) : Infinity) -
    (Number.isFinite(timestamp(right.next_trigger_at)) ? timestamp(right.next_trigger_at) : Infinity));
  for (const schedule of schedules) counts[scheduleState(schedule, now)]++;
  const nextSchedule = sorted.find(schedule => timestamp(schedule.next_trigger_at) > now);
  const next = nextSchedule && beijingParts(nextSchedule.next_trigger_at);
  const current = beijingParts(now);
  const filters = [["all", "全部账号", schedules.length], ["waiting", "计划中", counts.waiting], ["due", "待触发", counts.due], ["unknown", "待初始化", counts.unknown]];
  const body = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="referrer" content="no-referrer">
  <title>续期计划 · Katabump</title>
  <style nonce="${nonce}">
    :root { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; color: #243b35; background: #f5f7f5; font-synthesis: none; -webkit-font-smoothing: antialiased; --green: #24644d; --muted: #687b70; --border: #e4eae5; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    button, input { font: inherit; }
    button, a, input { -webkit-tap-highlight-color: transparent; }
    button, a { touch-action: manipulation; }
    button { cursor: pointer; }
    a { color: inherit; text-decoration: none; }
    button:focus-visible, a:focus-visible, input:focus-visible { outline: 3px solid #78a38c; outline-offset: 4px; }
    .icon { display: inline-block; flex-shrink: 0; vertical-align: middle; }
    .shell { width: min(1200px, calc(100% - 80px)); margin-inline: auto; }
    .topbar { height: 88px; border-bottom: 1px solid var(--border); background: #fbfcfa; }
    .topbar-inner, .brand, .brand-lockup, .topbar-status, .button, .eyebrow, .stat-label, .table-title, .table-tools, .filters, .account-cell, .footer-inner { display: flex; align-items: center; }
    .topbar-inner { height: 100%; justify-content: space-between; gap: 24px; }
    .brand-lockup { gap: 12px; }
    .brand-mark { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 12px; color: #fff; background: var(--green); box-shadow: 0 3px 8px #245f4c14; }
    .brand-mark .icon { width: 23px; height: 23px; }
    .brand-name { font-size: 21px; font-weight: 740; letter-spacing: -.7px; }
    .brand { gap: 22px; }
    .brand-divider { width: 1px; height: 21px; background: #dbe3dc; }
    .brand-context { font-size: 13px; color: #687b70; }
    .topbar-status { gap: 8px; font-size: 12px; color: #61796d; }
    .status-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
    .topbar-status .status-dot { color: #4e8e68; box-shadow: 0 0 0 4px #4e8e680c; }
    main { padding-top: 42px; padding-bottom: 40px; }
    .breadcrumb { display: flex; align-items: center; gap: 8px; color: #738276; font-size: 12px; }
    .breadcrumb .icon { width: 12px; height: 12px; }
    .breadcrumb span:last-child { color: #4f685b; }
    .hero { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 30px 0 34px; }
    .eyebrow { gap: 8px; font-size: 10px; letter-spacing: .15em; font-weight: 650; color: #6c8977; margin: 0 0 12px; }
    .eyebrow::before { content: ""; width: 18px; height: 2px; background: #739680; }
    h1 { font-size: clamp(28px, 3vw, 36px); margin: 0 0 12px; font-weight: 660; letter-spacing: -.045em; line-height: 1.3; }
    .description { color: #687b70; font-size: 14px; line-height: 1.8; margin: 0; }
    .button { justify-content: center; gap: 8px; border: 1px solid var(--border); border-radius: 9px; padding: 11px 16px; background: #fff; font-size: 12px; font-weight: 550; white-space: nowrap; transition: background .18s, border-color .18s; }
    .button:hover { background: #edf3ed; border-color: #b6cbbd; }
    .button .icon { width: 15px; height: 15px; }
    .button-primary { color: #fff; background: var(--green); border-color: var(--green); box-shadow: 0 3px 5px #24644d12; }
    .button-primary:hover { background: #1a523d; border-color: #1a523d; }
    .hero-actions { display: flex; gap: 10px; }
    .stats { display: grid; grid-template-columns: 1fr 1fr 1.18fr; gap: 20px; margin: 0 0 28px; }
    .stat { position: relative; padding: 25px 26px 22px; border: 1px solid var(--border); border-radius: 14px; background: #fff; box-shadow: 0 2px 3px #243b3502; }
    .stat-label { justify-content: space-between; gap: 12px; color: #687b70; font-size: 13px; }
    .stat-icon { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px; color: #6a8975; background: #f1f5f0; }
    .stat:nth-child(2) .stat-icon { color: #b28b44; background: #faf5ea; }
    .stat dd { margin: 5px 0 12px; font-size: 38px; font-weight: 620; letter-spacing: -1.5px; font-variant-numeric: tabular-nums; line-height: 1.25; }
    .unit { margin-left: 8px; color: #6d7f70; font-size: 12px; font-weight: 400; letter-spacing: 0; }
    .stat-note { margin: 0; font-size: 12px; color: #6d7f70; line-height: 1.6; }
    .stat-next { background: #edf3ec; border-color: #dbe6d9; overflow: hidden; }
    .stat-next::after { content: ""; position: absolute; pointer-events: none; width: 130px; height: 130px; border: 1px solid #d5e1d280; border-radius: 50%; top: 58px; right: -48px; box-shadow: 0 0 0 20px #d5e1d220, 0 0 0 42px #d5e1d218; }
    .stat-next .stat-label { color: #55745e; }
    .stat-next .stat-icon { color: #567d60; background: #e0eadc; }
    .stat-next dd { font-size: 27px; margin-top: 10px; margin-bottom: 15px; letter-spacing: -1px; color: #315f40; }
    .next-time { margin-left: 10px; font-size: 18px; color: #6f8b71; letter-spacing: -.3px; }
    .stat-next .stat-note { color: #708b71; }
    .panel { border: 1px solid var(--border); border-radius: 15px; background: #fff; overflow: hidden; box-shadow: 0 4px 18px #243b3503; }
    .panel-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 25px 26px 22px; }
    .table-title { gap: 9px; }
    h2 { margin: 0; font-size: 16px; font-weight: 650; letter-spacing: -.4px; }
    .count-pill { background: #eff3ed; color: #67806b; font-size: 10px; font-weight: 600; min-width: 22px; padding: 3px 6px; border-radius: 5px; text-align: center; }
    .panel-description { font-size: 12px; color: #6d7f70; margin: 8px 0 0; }
    .zone { display: flex; gap: 6px; align-items: center; font-size: 11px; color: #6d7f70; white-space: nowrap; }
    .zone .icon { width: 14px; height: 14px; }
    .table-tools { justify-content: space-between; gap: 16px; padding: 0 26px 20px; }
    .filters { gap: 4px; background: #f4f6f2; padding: 4px; border-radius: 8px; }
    .filter { display: flex; align-items: center; gap: 7px; border: 0; background: transparent; border-radius: 5px; color: #687b70; padding: 8px 11px; font-size: 12px; white-space: nowrap; }
    .filter[aria-pressed="true"] { background: #fff; color: #3c6146; box-shadow: 0 1px 4px #233b3510; font-weight: 600; }
    .filter:hover { color: #3c6146; }
    .filter-count { font-size: 10px; opacity: .7; font-variant-numeric: tabular-nums; }
    .search { display: flex; align-items: center; gap: 8px; border: 1px solid var(--border); border-radius: 8px; padding: 0 11px; width: 216px; color: #a1aaa2; background: #fff; }
    .search:focus-within { border-color: #78a38c; }
    .search .icon { width: 15px; height: 15px; }
    .search input { width: 100%; min-width: 0; border: 0; padding: 10px 0; background: transparent; font-size: 12px; color: #3b5947; }
    .search input::placeholder { color: #6d7f70; }
    .search input:focus-visible { outline-offset: 2px; }
    table { width: 100%; border-collapse: collapse; text-align: left; table-layout: auto; font-size: 13px; }
    th { padding: 14px 20px; border-top: 1px solid #edf0eb; border-bottom: 1px solid #edf0eb; background: #f8faf7; color: #6b7e6d; font-size: 12px; font-weight: 500; white-space: nowrap; }
    td { padding: 25px 20px; border-bottom: 1px solid #edf0eb; }
    th:first-child, td:first-child { padding-left: 26px; }
    th:last-child, td:last-child { padding-right: 26px; }
    tbody tr:last-child td { border-bottom: 0; }
    tbody tr:hover { background: #fcfdfb; }
    .account-cell { gap: 12px; }
    .avatar { display: grid; place-items: center; flex-shrink: 0; width: 36px; height: 39px; border: 1px solid #e1e9de; border-radius: 10px; background: #f0f5ed; color: #73906c; font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .avatar-1 { background: #f0f2f8; color: #7988a0; border-color: #e3e7ee; }
    .avatar-2 { background: #faf3eb; color: #ac916f; border-color: #eee5d8; }
    .account-id { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #42594b; font-size: 12px; white-space: nowrap; }
    .cell-note { display: block; margin-top: 7px; color: #6b7e6d; font-size: 11px; line-height: 1.4; }
    .copy-button { display: grid; place-items: center; color: #6d7f70; border: 0; background: transparent; padding: 7px; border-radius: 5px; }
    .copy-button:hover { color: var(--green); background: #eef4eb; }
    .copy-button .icon { width: 13px; height: 13px; }
    .badge { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; padding: 6px 9px; border-radius: 5px; white-space: nowrap; }
    .badge .status-dot { width: 4px; height: 4px; }
    .waiting { color: #5c8062; background: #edf5eb; }
    .due { color: #a57827; background: #fcf4df; }
    .unknown { color: #7b8795; background: #f0f2f6; }
    time { font-variant-numeric: tabular-nums; white-space: nowrap; font-size: 12px; letter-spacing: .1px; }
    .time-part { display: inline-block; margin-left: 7px; color: #6b7e6d; font-size: 11px; }
    .text-green { color: #52775b; }
    .text-amber { color: #a57827; }
    .muted { color: #6b7e6d; font-size: 11px; }
    .panel-footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; border-top: 1px solid #edf0eb; padding: 16px 26px; font-size: 10px; color: #6d7f70; background: #fdfefb; }
    .panel-footer strong { color: #718573; font-weight: 500; }
    .legend { display: flex; align-items: center; gap: 6px; }
    .legend .status-dot { width: 5px; height: 5px; color: #83a283; }
    .empty-state { padding: 50px 20px; text-align: center; }
    .empty-state > .icon { color: #8da18f; width: 30px; height: 30px; }
    .empty-state h3 { font-size: 14px; font-weight: 550; margin: 16px 0 9px; }
    .empty-state p { font-size: 12px; line-height: 1.8; color: #91a092; margin: 0; }
    [hidden] { display: none !important; }
    .notice { display: flex; align-items: flex-start; gap: 11px; padding: 19px 2px 0; color: #6d7f70; }
    .notice > .icon { width: 15px; height: 15px; margin-top: 1px; }
    .notice p { margin: 0; font-size: 11px; line-height: 1.9; }
    .notice strong { font-weight: 500; color: #6d836d; }
    footer { border-top: 1px solid var(--border); }
    .footer-inner { justify-content: space-between; gap: 15px; padding-block: 23px; color: #738276; font-size: 10px; }
    .footer-brand { display: flex; align-items: center; gap: 7px; color: #6b7e6d; font-weight: 550; }
    .footer-brand .icon { width: 14px; height: 14px; }
    .footer-caption { display: flex; gap: 12px; align-items: center; }
    .toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); z-index: 2; padding: 12px 18px; border-radius: 10px; color: #fff; background: #284c38; box-shadow: 0 4px 24px #284c3826; font-size: 12px; max-width: calc(100% - 32px); width: max-content; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
    @media (min-width: 1500px) { main { padding-top: 52px; } .hero { padding-bottom: 40px; } }
    @media (max-width: 1000px) { .shell { width: calc(100% - 48px); } .stats { gap: 14px; } .stat { padding-inline: 21px; } th, td { padding-inline: 14px; } .time-part { display: block; margin: 5px 0 0; } .account-cell { gap: 8px; } .copy-button { padding: 5px; } .stat-next dd { font-size: 23px; } .next-time { font-size: 15px; } }
    @media (max-width: 760px) {
      .shell { width: calc(100% - 36px); } .topbar { height: 72px; } .brand { gap: 14px; } .brand-mark { width: 34px; height: 34px; border-radius: 10px; } .brand-name { font-size: 19px; } .brand-context, .brand-divider { display: none; } .topbar-status { font-size: 10px; } main { padding-top: 26px; padding-bottom: 30px; } .hero { align-items: flex-start; padding: 24px 0 26px; } h1 { font-size: 30px; } .description { font-size: 12px; max-width: 250px; } .hero-actions { padding-top: 27px; } .hero-actions .button-secondary { display: none; } .button { padding: 10px 12px; font-size: 11px; }
      .stats { grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 22px; } .stat { padding: 17px 18px; border-radius: 12px; } .stat dd { font-size: 33px; margin: 7px 0 10px; } .stat-label { font-size: 11px; } .stat-icon { width: 28px; height: 28px; border-radius: 8px; } .stat-icon .icon { width: 16px; height: 16px; } .stat-note { font-size: 10px; }
      .stat-next { grid-column: 1 / -1; display: grid; grid-template-columns: 1fr auto; gap: 7px 12px; align-items: center; padding-block: 18px; } .stat-next .stat-label { display: block; } .stat-next .stat-icon { display: none; } .stat-next dd { grid-column: 2; grid-row: 1 / 3; margin: 0; font-size: 24px; } .next-time { font-size: 16px; margin-left: 7px; } .stat-next .stat-note { grid-column: 1; } .stat-next::after { top: 10px; }
      .panel-header { padding: 21px 18px; } .zone { font-size: 9px; gap: 4px; } .table-tools { padding: 0 18px 18px; flex-direction: column-reverse; align-items: stretch; gap: 13px; } .search { width: 100%; } .search input { font-size: 16px; padding-block: 9px; } .search input::placeholder { font-size: 12px; } .filters { justify-content: space-between; } .filter { justify-content: center; flex: 1; padding: 9px 5px; font-size: 10px; gap: 4px; }
      table, tbody { display: block; } thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); }
      tbody tr { display: grid; grid-template-columns: 1fr 1fr; padding: 18px; gap: 22px 12px; border-top: 1px solid #edf0eb; } td { padding: 0 !important; border: 0; min-width: 0; } td::before { content: attr(data-label); display: block; color: #6b7e6d; font-size: 10px; margin-bottom: 9px; } td:first-child { grid-column: 1 / -1; grid-row: 1; padding-right: 65px !important; } td:first-child::before, td:nth-child(2)::before { display: none; } td:nth-child(2) { grid-column: 2; grid-row: 1; justify-self: end; align-self: center; } td:nth-child(3) { grid-column: 1; grid-row: 2; } td:nth-child(4) { grid-column: 2; grid-row: 2; } td:nth-child(4) .time-part { display: block; margin: 5px 0 0; } td:nth-child(5) { grid-column: 1 / -1; grid-row: 3; display: flex; align-items: center; justify-content: space-between; border-top: 1px dashed #e8ede5; padding-top: 14px !important; } td:nth-child(5)::before { margin: 0; } td:nth-child(5) .time-part { display: inline; margin-left: 8px; }
      .avatar { width: 31px; height: 35px; border-radius: 8px; } .account-id { font-size: 11px; } .account-cell { gap: 9px; } .copy-button { padding: 4px; } .time-part { display: inline; margin-left: 6px; } .panel-footer { padding: 15px 18px; font-size: 9px; } .notice { padding-top: 16px; } .notice p { font-size: 10px; } .footer-inner { flex-wrap: wrap; padding-block: 20px; font-size: 9px; } .footer-caption { gap: 7px; }
    }
    @media (max-width: 380px) { .hero { gap: 10px; } .button-primary span { display: none; } .button-primary { padding: 10px; } .stat-next dd { font-size: 20px; } .next-time { font-size: 13px; } .account-id { font-size: 10px; } }
    @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
  </style>
</head>
<body>
  <header class="topbar"><div class="shell topbar-inner">
    <div class="brand"><div class="brand-lockup"><span class="brand-mark">${icon("layers")}</span><span class="brand-name">katabump<span class="text-green">.</span></span></div><span class="brand-divider"></span><span class="brand-context">自动续期工作台</span></div>
    <div class="topbar-status"><span class="status-dot"></span>自动调度 · 每日检查</div>
  </div></header>
  <main class="shell">
    <nav class="breadcrumb" aria-label="当前位置"><span>工作台</span>${icon("chevron")}<span>续期计划</span></nav>
    <section class="hero" aria-labelledby="page-title">
      <div><p class="eyebrow">RENEWAL SCHEDULE</p><h1 id="page-title">让每一次续期，<br class="sr-only">都有安排<span class="text-green">。</span></h1><p class="description">所有账号的续期计划，一目了然。到期后自动触发，省心一点。</p></div>
      <div class="hero-actions"><a class="button button-secondary" id="json-link" href="" hidden>${icon("code")}JSON 数据</a><a class="button button-primary" href="">${icon("refresh")}<span>刷新计划</span></a></div>
    </section>
    <dl class="stats" aria-label="计划概览">
      <div class="stat"><dt class="stat-label">管理中的账号<span class="stat-icon">${icon("users")}</span></dt><dd>${schedules.length}<span class="unit">个</span></dd><p class="stat-note">${counts.waiting} 个计划中${counts.unknown ? ` · ${counts.unknown} 个待初始化` : schedules.length ? " · 续期计划已同步" : " · 等待首次同步"}</p></div>
      <div class="stat"><dt class="stat-label">已到期 · 待触发<span class="stat-icon">${icon("clock")}</span></dt><dd>${counts.due}<span class="unit">个</span></dd><p class="stat-note">${counts.due ? "等待定时检查或计划回写" : "暂时没有到期的续期计划"}</p></div>
      <div class="stat stat-next"><dt class="stat-label">下一次计划触发<span class="stat-icon">${icon("calendar")}</span></dt><dd>${next ? `${next.date.slice(5).replace("-", " / ")}<span class="next-time">${next.time.slice(0, 5)}</span>` : '<span class="next-time">暂无后续计划</span>'}</dd><p class="stat-note">${next ? `${relativeTime(nextSchedule.next_trigger_at, now)} · 北京时间` : "账号初始化后将自动显示"}</p></div>
    </dl>
    <section class="panel" aria-labelledby="schedule-heading">
      <div class="panel-header"><div><div class="table-title"><h2 id="schedule-heading">账号续期计划</h2><span class="count-pill">${schedules.length}</span></div><p class="panel-description">每个账号独立调度，按下次触发时间排序</p></div><span class="zone">${icon("clock")}北京时间 · UTC+8</span></div>
      <div class="table-tools" id="table-tools" hidden>
        <div class="filters" role="group" aria-label="筛选调度状态">${filters.map(([state, label, count]) => `<button type="button" class="filter" data-filter="${state}" aria-pressed="${state === "all"}">${label}<span class="filter-count">${count}</span></button>`).join("")}</div>
        <label class="search">${icon("search")}<span class="sr-only">搜索账号标识</span><input id="account-search" type="search" placeholder="搜索账号标识…" autocomplete="off" spellcheck="false"></label>
      </div>
      <table aria-labelledby="schedule-heading"><thead><tr><th scope="col">账号标识</th><th scope="col">调度状态</th><th scope="col">可续期日期</th><th scope="col">下次触发</th><th scope="col">最近更新</th></tr></thead><tbody id="schedule-rows">${sorted.map((schedule, index) => scheduleRow(schedule, index, now)).join("")}</tbody></table>
      <div class="empty-state" id="empty-state"${schedules.length ? " hidden" : ""}>${icon("inbox")}<h3 id="empty-title">还没有续期计划</h3><p id="empty-description">在 GitHub Actions 中手动运行一次续期工作流，<br>即可初始化账号并在这里查看计划。</p></div>
      <div class="panel-footer"><span id="result-count" role="status">共 <strong>${schedules.length}</strong> 个账号</span><span class="legend"><span class="status-dot"></span>计划随续期结果更新</span></div>
    </section>
    <aside class="notice" aria-label="调度说明">${icon("info")}<p><strong>计划会自己往前走。</strong> 到期账号将在下一次定时检查时尝试触发，续期后自动更新下一次计划。<br>此页仅供查看；状态按计划时间计算，不代表 GitHub Actions 实时状态。数据同步可能有短暂延迟。</p></aside>
  </main>
  <footer><div class="shell footer-inner"><span class="footer-brand">${icon("layers")}Katabump Renew<span class="muted">/</span>让服务持续在线</span><span class="footer-caption">本次同步 <time datetime="${new Date(now).toISOString()}">${current.date} ${current.time}</time><span>UTC+8</span></span></div></footer>
  <div id="toast" class="toast" role="status" hidden></div>
  <script nonce="${nonce}">
    (() => {
      const rows = Array.from(document.querySelectorAll('#schedule-rows tr'));
      const filters = Array.from(document.querySelectorAll('[data-filter]'));
      const search = document.getElementById('account-search');
      const empty = document.getElementById('empty-state');
      const count = document.getElementById('result-count');
      const toast = document.getElementById('toast');
      let state = 'all';
      let toastTimer;
      function filterRows() {
        const query = search.value.trim().toLowerCase();
        let visible = 0;
        rows.forEach(row => {
          row.hidden = (state !== 'all' && row.dataset.state !== state) || !row.dataset.account.includes(query);
          if (!row.hidden) visible++;
        });
        empty.hidden = visible > 0;
        if (rows.length) {
          document.getElementById('empty-title').textContent = '没有找到匹配的账号';
          document.getElementById('empty-description').textContent = '试试其他账号标识，或切换调度状态。';
        }
        count.textContent = '显示 ' + visible + ' / ' + rows.length + ' 个账号';
      }
      filters.forEach(button => button.addEventListener('click', () => {
        state = button.dataset.filter;
        filters.forEach(item => item.setAttribute('aria-pressed', String(item === button)));
        filterRows();
      }));
      search.addEventListener('input', filterRows);
      document.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(button.dataset.copy);
          toast.textContent = '完整账号标识已复制';
        } catch {
          toast.textContent = '复制失败，请选择账号标识后手动复制';
        }
        toast.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { toast.hidden = true; }, 2800);
      }));
      const jsonLink = document.getElementById('json-link');
      const jsonUrl = new URL(window.location.href);
      jsonUrl.searchParams.set('format', 'json');
      jsonLink.href = jsonUrl.pathname + jsonUrl.search;
      jsonLink.hidden = false;
      document.getElementById('table-tools').hidden = false;
    })();
  </script>
</body>
</html>`;
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "vary": "Accept",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    },
  });
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
