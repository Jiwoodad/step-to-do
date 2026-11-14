// api.js — 실제 서버(fetch)로 보낼 때의 요청 형식, 오류 해석, 인증 처리.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installMemoryStorage } from "../support/memory-storage.mjs";

installMemoryStorage();
globalThis.window = { location: { href: "http://localhost:5500/" } };
const { createApi, ApiError, redactForLog } = await import("../../js/api.js");
const { createSession } = await import("../../js/session.js");

let calls, nextResponse, session, unauthorizedCount, api, logged;
const originalError = console.error;
const originalWarn = console.warn;

beforeEach(() => {
  sessionStorage.clear();
  calls = [];
  logged = [];
  unauthorizedCount = 0;
  console.error = (...args) => logged.push(args);
  console.warn = (...args) => logged.push(args);
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = typeof nextResponse === "function" ? await nextResponse(init) : nextResponse;
    if (next === "network-down") throw new TypeError("Failed to fetch");
    return new Response(next.body === undefined ? null : typeof next.body === "string" ? next.body : JSON.stringify(next.body), { status: next.status });
  };
  session = createSession();
  api = createApi({ apiBaseUrl: "http://localhost:8000/api/", session, onUnauthorized: () => unauthorizedCount++ });
});

afterEach(() => {
  console.error = originalError;
  console.warn = originalWarn;
});

const settled = (promise, ms = 50) => Promise.race([promise.then(() => "resolved", () => "rejected"), new Promise((r) => setTimeout(() => r("pending"), ms))]);
const rejection = async (promise) => {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail("실패해야 하는 요청이 성공했습니다.");
};
const todo = { id: 1, title: "a", is_completed: false };

test("할 일 요청에는 Authorization: Bearer 토큰과 X-Request-ID를 붙이고, 토큰은 URL에 넣지 않는다", async () => {
  session.start({ access_token: "secret-token", expires_in: 60 });
  nextResponse = { status: 200, body: { items: [], total: 0, page: 2, size: 5 } };
  await api.listTodos({ status: "active", sort: "due_date", page: 2, size: 5 });
  const { url, init } = calls[0];
  assert.equal(url, "http://localhost:8000/api/todos?status=active&sort=due_date&page=2&size=5");
  assert.equal(init.headers.Authorization, "Bearer secret-token");
  assert.ok(init.headers["X-Request-ID"]);
  assert.ok(!url.includes("secret-token"));
});

test("로그인은 OAuth2 Password 방식: form 인코딩으로 username·password를 보낸다", async () => {
  nextResponse = { status: 200, body: { access_token: "t", token_type: "bearer", expires_in: 3600 } };
  await api.login({ email: "a@b.co", password: "p@ss w+rd&=한글" });
  const { url, init } = calls[0];
  assert.equal(url, "http://localhost:8000/api/auth/login");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(init.headers.Authorization, undefined);
  assert.equal(typeof init.body, "string");
  const form = new URLSearchParams(init.body);
  assert.deepEqual(Object.fromEntries(form), { grant_type: "password", username: "a@b.co", password: "p@ss w+rd&=한글" });
});

test("회원가입·이메일 인증은 JSON, 토큰 없음, 비밀번호 확인은 보내지 않는다", async () => {
  nextResponse = { status: 201, body: { id: 1, email: "a@b.co", created_at: "2026-10-30T00:00:00Z" } };
  await api.signup({ email: "a@b.co", password: "password123", name: "에이", password_confirm: "password123" });
  assert.equal(calls[0].url, "http://localhost:8000/api/auth/signup");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(Object.keys(JSON.parse(calls[0].init.body)), ["email", "password", "name"]);

  nextResponse = { status: 200, body: { expires_in: 300, resend_after: 60 } };
  await api.sendEmailCode({ email: "a@b.co" });
  assert.equal(calls[1].url, "http://localhost:8000/api/auth/email-verification/send");
  assert.deepEqual(JSON.parse(calls[1].init.body), { email: "a@b.co" });

  nextResponse = { status: 200, body: { verified: true, expires_in: 1800 } };
  await api.verifyEmailCode({ email: "a@b.co", code: "123456" });
  assert.equal(calls[2].url, "http://localhost:8000/api/auth/email-verification/verify");
  assert.deepEqual(JSON.parse(calls[2].init.body), { email: "a@b.co", code: "123456" });
  for (const call of calls) assert.equal(call.init.headers.Authorization, undefined);
});

test("할 일 생성 본문에는 소유자 ID가 없다", async () => {
  session.start({ access_token: "t" });
  nextResponse = { status: 201, body: todo };
  await api.createTodo({ title: "x", description: null, due_date: null, owner_id: 99, user_id: 99 });
  assert.deepEqual(Object.keys(JSON.parse(calls[0].init.body)).sort(), ["description", "due_date", "title"]);
});

test("인증이 필요한 요청의 401 → onUnauthorized는 한 번만, 호출부는 결과를 받지 않는다", async () => {
  // 앱(app.js)처럼 첫 401에서 세션을 끝낸다.
  const appLike = createApi({ apiBaseUrl: "http://localhost:8000/api", session, onUnauthorized: () => { unauthorizedCount++; session.end(); } });
  session.start({ access_token: "t" });
  nextResponse = { status: 401, body: { detail: "Token has expired" } };
  const results = await Promise.all([appLike.listTodos({}), appLike.getTodo(1), appLike.me()].map((p) => settled(p)));
  assert.deepEqual(results, ["pending", "pending", "pending"]);
  assert.equal(unauthorizedCount, 1, "동시에 401을 받아도 세션 정리는 한 번");
});

test("로그인 실패 401은 onUnauthorized가 아니라 오류로 돌려준다", async () => {
  nextResponse = { status: 401, body: { detail: "이메일 또는 비밀번호가 올바르지 않습니다." } };
  const err = await rejection(api.login({ email: "a@b.co", password: "wrong-pass" }));
  assert.ok(err instanceof ApiError);
  assert.equal(err.status, 401);
  assert.equal(unauthorizedCount, 0);
});

test("토큰 없이 보호된 API를 부르면 요청하지 않고 onUnauthorized", async () => {
  const promise = api.me();
  assert.equal(await settled(promise), "pending");
  assert.equal(calls.length, 0);
  assert.equal(unauthorizedCount, 1);
});

test("요청 중에 로그아웃·다른 사용자 로그인이 있으면 이전 응답은 버린다 (성공·실패 모두)", async () => {
  session.start({ access_token: "alice" });
  let release;
  nextResponse = () => new Promise((resolve) => (release = resolve));
  const late = api.listTodos({});
  await new Promise((r) => setTimeout(r, 5));
  session.end();
  session.start({ access_token: "bob" });
  release({ status: 200, body: { items: [todo], total: 1, page: 1, size: 10 } });
  assert.equal(await settled(late), "pending");

  nextResponse = () => new Promise((resolve) => (release = resolve));
  const lateFailure = api.getTodo(1);
  await new Promise((r) => setTimeout(r, 5));
  session.end();
  release({ status: 500, body: "Internal Server Error" });
  assert.equal(await settled(lateFailure), "pending");
  assert.equal(unauthorizedCount, 0);
});

test("세션이 끝나면 진행 중인 fetch에 abort 신호를 보낸다", async () => {
  session.start({ access_token: "t" });
  let signal;
  nextResponse = (init) => {
    signal = init.signal;
    return new Promise(() => {});
  };
  api.listTodos({});
  await new Promise((r) => setTimeout(r, 5));
  session.end();
  assert.equal(signal.aborted, true);
});

test("403·404는 오류로 돌려주고 로그아웃시키지 않는다", async () => {
  session.start({ access_token: "t" });
  nextResponse = { status: 403, body: { detail: "Not enough permissions" } };
  const forbidden = await rejection(api.updateTodo(1, { title: "x" }));
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.message, "이 작업을 할 권한이 없어요. (Not enough permissions)");
  nextResponse = { status: 403, body: {} };
  assert.equal((await rejection(api.deleteTodo(1))).message, "이 작업을 할 권한이 없어요.");
  nextResponse = { status: 404, body: { detail: "Todo not found" } };
  assert.equal((await rejection(api.getTodo(1))).message, "Todo not found");
  assert.equal(unauthorizedCount, 0);
});

test("422 해석: 필드 오류 분리, 보낸 값(input)은 메시지에 넣지 않는다", async () => {
  nextResponse = {
    status: 422,
    body: { detail: [
      { type: "string_too_short", loc: ["body", "password"], msg: "String should have at least 8 characters", input: "short12" },
      { type: "value_error", loc: ["body", "email"], msg: "value is not a valid email address", input: "nope" },
    ] },
  };
  const err = await rejection(api.signup({ email: "nope", password: "short12" }));
  assert.deepEqual(Object.keys(err.fieldErrors), ["password", "email"]);
  assert.ok(!err.message.includes("short12"));
  assert.match(err.message, /비밀번호: String should have at least 8 characters/);
});

test("콘솔 로그에는 비밀번호·토큰이 남지 않는다", async () => {
  nextResponse = { status: 422, body: { detail: [{ loc: ["body", "password"], msg: "too short", input: "hunter2-secret" }] } };
  await rejection(api.signup({ email: "a@b.co", password: "hunter2-secret" }));
  nextResponse = { status: 400, body: { detail: "인증코드가 올바르지 않습니다.", code: "654321" } };
  await rejection(api.verifyEmailCode({ email: "a@b.co", code: "654321" }));
  nextResponse = { status: 200, body: { token: "leaky-token-value" } }; // 계약과 다른 응답 형식
  await rejection(api.login({ email: "a@b.co", password: "hunter2-secret" }));
  session.start({ access_token: "bearer-secret" });
  nextResponse = { status: 401, body: { detail: "expired" } };
  api.me();
  await new Promise((r) => setTimeout(r, 10));
  const text = JSON.stringify(logged.map((args) => args.map((a) => (a instanceof Error ? a.message : a))));
  for (const secret of ["hunter2-secret", "leaky-token-value", "bearer-secret", "654321"]) assert.ok(!text.includes(secret), `${secret} 노출: ${text}`);
  assert.deepEqual(redactForLog({ access_token: "x", nested: [{ password: "y", ok: 1 }] }), { access_token: "[redacted]", nested: [{ password: "[redacted]", ok: 1 }] });
});

test("로그인 422의 username은 필드 오류로 돌려준다 (화면에서 이메일 칸에 표시)", async () => {
  nextResponse = { status: 422, body: { detail: [{ type: "missing", loc: ["body", "username"], msg: "Field required", input: null }] } };
  const err = await rejection(api.login({ email: "", password: "x" }));
  assert.deepEqual(err.fieldErrors, { username: ["Field required"] });
  assert.match(err.message, /이메일: Field required/);
});

test("계약과 다른 성공 응답은 원인을 알려준다", async () => {
  session.start({ access_token: "t" });
  nextResponse = { status: 200, body: [todo] };
  assert.match((await rejection(api.listTodos({}))).message, /items, total, page, size/);
  nextResponse = { status: 200, body: { access_token: "" } };
  assert.match((await rejection(api.login({ email: "a@b.co", password: "x" }))).message, /access_token/);
  nextResponse = { status: 200, body: { id: 1 } };
  assert.match((await rejection(api.me())).message, /id, email/);
  nextResponse = { status: 200, body: {} };
  assert.match((await rejection(api.sendEmailCode({ email: "a@b.co" }))).message, /expires_in/);
  nextResponse = { status: 200, body: { verified: false } };
  assert.match((await rejection(api.verifyEmailCode({ email: "a@b.co", code: "123456" }))).message, /verified/);
});

test("5xx·연결 실패 메시지", async () => {
  session.start({ access_token: "t" });
  nextResponse = { status: 500, body: "Internal Server Error" };
  const err = await rejection(api.getTodo(1));
  assert.equal(err.message, "서버 오류가 발생했습니다. (500)");
  assert.ok(err.requestId);
  nextResponse = "network-down";
  assert.equal((await rejection(api.getTodo(1))).status, 0);
});
