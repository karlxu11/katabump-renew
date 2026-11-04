import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import worker from "../workers.js";

const DAY = 86400000;
const ACCOUNT_A = "a".repeat(64);
const ACCOUNT_B = "b".repeat(64);
let env;
let dispatches;

function memoryKV() {
  const data = new Map();
  return {
    data,
    async get(key, type) {
      const value = data.get(key) ?? null;
      return value && type === "json" ? JSON.parse(value) : value;
    },
    async put(key, value) { data.set(key, value); },
    async list({ prefix }) {
      return { keys: [...data.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })), list_complete: true };
    },
  };
}

beforeEach(() => {
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-04T04:00:00Z") });
  env = { AUTH_KEY: "test-key", GH_PAT: "test-pat", GH_USER: "owner", GH_REPO: "repo", RENEW_KV: memoryKV() };
  dispatches = [];
  mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://api.github.com/repos/owner/repo/dispatches");
    dispatches.push(JSON.parse(options.body));
    return new Response(null, { status: 204 });
  });
});

afterEach(() => { mock.restoreAll(); mock.timers.reset(); });

function request(path, body) {
  return worker.fetch(new Request(`https://worker.example${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
}

async function saveSchedule(accountId, nextTriggerAt) {
  // 模拟 Actions 通过 Cloudflare REST API 写入的 KV 数据。
  await env.RENEW_KV.put(`schedule:${accountId}`, JSON.stringify({
    account_id: accountId, next_trigger_at: nextTriggerAt,
  }));
}

async function cron() {
  let pending;
  await worker.scheduled({ scheduledTime: Date.now() }, env, { waitUntil(promise) { pending = promise; } });
  return pending;
}

test("不同账号独立调度，仍不可续期时次日重试，Actions 更新日期后等待", async () => {
  await saveSchedule(ACCOUNT_A, "2026-11-06T00:12:00.000Z");
  await saveSchedule(ACCOUNT_B, "2026-11-11T00:12:00.000Z");
  assert.equal((await cron()).dispatched, 0);

  mock.timers.tick(2 * DAY);
  assert.equal((await cron()).dispatched, 1);
  assert.deepEqual(dispatches[0], { event_type: "cf_timer", client_payload: { account_ids: [ACCOUNT_A] } });
  assert.equal((await cron()).dispatched, 0);
  await saveSchedule(ACCOUNT_A, "2026-11-07T00:12:00.000Z");

  mock.timers.tick(DAY);
  assert.equal((await cron()).dispatched, 1);
  await saveSchedule(ACCOUNT_A, "2026-11-29T00:12:00.000Z");
  mock.timers.tick(DAY);
  assert.equal((await cron()).dispatched, 0);
  mock.timers.tick(3 * DAY);
  assert.equal((await cron()).dispatched, 1);
  assert.deepEqual(dispatches.at(-1).client_payload.account_ids, [ACCOUNT_B]);
});

test("触发时间精确到北京时间 08:12", async () => {
  await saveSchedule(ACCOUNT_A, "2026-11-06T00:12:00.000Z");
  mock.timers.tick(Date.parse("2026-11-06T00:11:59Z") - Date.now());
  assert.equal((await cron()).dispatched, 0);
  mock.timers.tick(1000);
  assert.equal((await cron()).dispatched, 1);
});

test("GitHub 派发失败不写入回执，可再次派发", async () => {
  await saveSchedule(ACCOUNT_A, "2026-11-06T00:12:00.000Z");
  mock.timers.tick(2 * DAY);
  globalThis.fetch.mock.mockImplementation(async () => new Response("unavailable", { status: 503 }));
  await assert.rejects(cron(), /GitHub 触发失败 \(503\)/);
  assert.equal([...env.RENEW_KV.data.keys()].filter(key => key.startsWith("dispatch:")).length, 0);
  globalThis.fetch.mock.mockImplementation(async () => new Response(null, { status: 204 }));
  assert.equal((await cron()).dispatched, 1);
});

test("Actions 失败或没有更新日期的账号会在下一天重试", async () => {
  await saveSchedule(ACCOUNT_A, "2026-11-06T00:12:00.000Z");
  mock.timers.tick(2 * DAY);
  await cron();
  mock.timers.tick(DAY);
  assert.equal((await cron()).dispatched, 1);
  assert.equal(dispatches.length, 2);
});

test("Actions 更新与派发回执不会相互覆盖", async () => {
  await saveSchedule(ACCOUNT_A, "2026-11-06T00:12:00.000Z");
  mock.timers.tick(2 * DAY);
  globalThis.fetch.mock.mockImplementation(async () => {
    await saveSchedule(ACCOUNT_A, "2026-11-29T00:12:00.000Z");
    return new Response(null, { status: 204 });
  });
  await cron();
  const saved = await env.RENEW_KV.get(`schedule:${ACCOUNT_A}`, "json");
  assert.equal(saved.next_trigger_at, "2026-11-29T00:12:00.000Z");
});

test("手动强制初始化全部账号，普通 URL 只检查到期账号", async () => {
  assert.equal((await (await request("/")).json()).dispatched, 0);
  assert.equal((await (await request("/?all=1")).json()).dispatched, "all");
  assert.deepEqual(dispatches, [{ event_type: "cf_timer" }]);
});

test("所有读写和手动派发都需要认证，保留 query key 兼容", async () => {
  for (const path of ["/", "/?all=1", "/schedules", "/schedule"]) {
    const response = await worker.fetch(new Request(`https://worker.example${path}`), env);
    assert.equal(response.status, 401);
  }
  assert.equal((await worker.fetch(new Request("https://worker.example/?key=test-key"), env)).status, 200);
  assert.equal(dispatches.length, 0);
});

test("无 KV 绑定时报告配置错误，不派发全部账号", async () => {
  delete env.RENEW_KV;
  assert.equal((await request("/")).status, 500);
  await assert.rejects(cron(), /RENEW_KV/);
  assert.equal(dispatches.length, 0);
});

test("Worker 公开端点不接受账号计划写入", async () => {
  assert.equal((await request("/schedule", { account_id: ACCOUNT_A, renewal_date: "2026-11-07" })).status, 404);
  assert.equal(env.RENEW_KV.data.size, 0);
});

test("KV list 空页但未结束时仍读取下一页", async () => {
  await saveSchedule(ACCOUNT_A, "2026-11-06T00:12:00.000Z");
  const cursors = [];
  env.RENEW_KV.list = async ({ cursor }) => {
    cursors.push(cursor);
    return cursor
      ? { keys: [{ name: `schedule:${ACCOUNT_A}` }], list_complete: true }
      : { keys: [], list_complete: false, cursor: "page-two" };
  };
  const schedules = (await (await request("/schedules")).json()).schedules;
  assert.equal(schedules.length, 1);
  assert.deepEqual(cursors, [undefined, "page-two"]);
});

function browserRequest(path = "/schedules") {
  return worker.fetch(new Request(`https://worker.example${path}`, {
    headers: { Authorization: "Bearer test-key", Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
  }), env);
}

test("浏览器显示只读续期面板，日期使用北京时间并按下次触发排序", async () => {
  await env.RENEW_KV.put(`schedule:${ACCOUNT_B}`, JSON.stringify({
    account_id: ACCOUNT_B, renewal_date: "2026-11-08", next_trigger_at: "2026-11-07T00:12:00.000Z",
  }));
  await env.RENEW_KV.put(`schedule:${ACCOUNT_A}`, JSON.stringify({
    account_id: ACCOUNT_A, renewal_date: "2026-11-07", next_trigger_at: "2026-11-06T00:12:00.000Z",
    updated_at: "2026-11-03T20:32:00.000Z",
  }));
  const before = [...env.RENEW_KV.data.entries()];
  const response = await browserRequest();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("vary"), "Accept");
  const html = await response.text();
  assert.match(html, /账号续期计划/);
  assert.match(html, /北京时间 · UTC\+8/);
  assert.match(html, /2026-11-06<span class="time-part">08:12:00/);
  assert.match(html, /2026-11-04<span class="time-part">04:32:00/);
  assert.ok(html.indexOf(`data-account="${ACCOUNT_A}"`) < html.indexOf(`data-account="${ACCOUNT_B}"`));
  const nonce = html.match(/<script nonce="([a-f0-9]+)"/)[1];
  assert.ok(response.headers.get("content-security-policy").includes(`'nonce-${nonce}'`));
  assert.ok(!html.includes("test-pat"));
  assert.ok(!html.includes("test-key"));
  assert.deepEqual([...env.RENEW_KV.data.entries()], before);
  assert.equal(dispatches.length, 0);
});

test("保留默认 JSON 格式，浏览器也能显式请求 JSON，query key 仍然有效", async () => {
  await saveSchedule(ACCOUNT_A, "2026-11-06T00:12:00.000Z");
  const original = await (await request("/schedules")).json();
  const response = await browserRequest("/schedules?format=json");
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.deepEqual(await response.json(), original);
  const queryResponse = await worker.fetch(new Request("https://worker.example/schedules?key=test-key", {
    headers: { Accept: "text/html" },
  }), env);
  assert.match(queryResponse.headers.get("content-type"), /text\/html/);
  const unauthorized = await worker.fetch(new Request("https://worker.example/schedules?format=html", {
    headers: { Accept: "text/html" },
  }), env);
  assert.equal(unauthorized.status, 401);
});

test("空列表有初始化引导，过期和无效时间各自显示正确状态", async () => {
  assert.match(await (await browserRequest()).text(), /还没有续期计划/);
  await saveSchedule(ACCOUNT_A, "2026-11-04T03:59:59.000Z");
  await saveSchedule(ACCOUNT_B, null);
  const html = await (await browserRequest()).text();
  assert.match(html, /data-state="due"/);
  assert.match(html, /data-state="unknown"/);
  assert.match(html, /等待定时检查/);
  assert.match(html, /暂无后续计划/);
  assert.equal(dispatches.length, 0);
});

test("计划数据中的 HTML 被转义，非法日期不导致页面失败", async () => {
  const injected = '</script><img src=x onerror="alert(1)">';
  await env.RENEW_KV.put(`schedule:${ACCOUNT_A}`, JSON.stringify({
    account_id: injected, renewal_date: "2026-99-99", next_trigger_at: '" onmouseover="alert(1)', updated_at: "invalid",
  }));
  const response = await browserRequest();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(!html.includes(injected));
  assert.match(html, /&lt;\/script&gt;&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /尚未获取/);
  assert.match(html, /暂无记录/);
});

test("同日到期账号合并为一批，超过 100 个时分批", async () => {
  for (let index = 1; index <= 101; index++) {
    await saveSchedule(index.toString(16).padStart(64, "0"), "2026-11-06T00:12:00.000Z");
  }
  mock.timers.tick(2 * DAY);
  assert.equal((await cron()).dispatched, 101);
  assert.deepEqual(dispatches.map(item => item.client_payload.account_ids.length), [100, 1]);
  assert.equal((await cron()).dispatched, 0);
});
