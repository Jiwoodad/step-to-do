// mock-api.js — API.md 계약을 흉내 내는지. (실제 백엔드 테스트가 아니다)
// api.js를 거쳐 호출해서 화면이 실제로 받는 형태 그대로 확인한다.
import { before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { installMemoryStorage } from "../support/memory-storage.mjs";

installMemoryStorage();
console.warn = () => {};
console.error = () => {};
const mock = await import("../../js/mock-api.js");
const { createApi, ApiError } = await import("../../js/api.js");
const { createSession } = await import("../../js/session.js");
const [ALICE, BOB] = mock.MOCK_TEST_USERS;

let unauthorized = 0;
function client() {
  const session = createSession();
  const api = createApi({ useMock: true, session, onUnauthorized: () => { unauthorized++; session.end(); } });
  return { session, api };
}
async function loggedIn(user) {
  const c = client();
  c.session.start(await c.api.login(user));
  return c;
}
const rejection = async (promise) => {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail("실패해야 하는 요청이 성공했습니다.");
};
/** 인증코드를 받아 확인하고 가입까지 마친다. */
async function verifiedSignup(api, email, password, name = "테스터") {
  await api.sendEmailCode({ email });
  await api.verifyEmailCode({ email, code: await mock.getMockEmailCode(email) });
  return api.signup({ email, password, name });
}
const wrongCode = (code) => (code === "000000" ? "111111" : "000000");
const settled = (promise, ms = 80) => Promise.race([promise.then(() => "resolved", () => "rejected"), new Promise((r) => setTimeout(() => r("pending"), ms))]);

before(() => mock.configureMock({ delayMs: 0, fail: [], failStatus: 500, tokenTtlSec: 3600 }));
beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  unauthorized = 0;
  mock.configureMock({ fail: [], tokenTtlSec: 3600, emailCodeTtlSec: 300, resendAfterSec: 60, verifiedTtlSec: 1800 });
  await mock.resetMockData();
});

describe("인증", () => {
  test("회원가입 → 로그인 → /me", async () => {
    const { api, session } = client();
    const user = await verifiedSignup(api, "  New@Example.com ", "my password!", "  새 사용자  ");
    assert.equal(user.email, "new@example.com");
    assert.equal(user.name, "새 사용자", "앞뒤 공백을 빼고 저장한다");
    assert.equal(user.password, undefined);
    assert.equal(user.password_hash, undefined);
    const token = await api.login({ email: "new@example.com", password: "my password!" });
    assert.equal(token.token_type, "bearer");
    assert.equal(token.expires_in, 3600);
    session.start(token);
    assert.equal((await api.me()).email, "new@example.com");
    assert.equal((await api.me()).name, "새 사용자");
  });

  test("테스트 사용자 두 명으로 로그인할 수 있다", async () => {
    for (const user of [ALICE, BOB]) {
      const { api } = await loggedIn(user);
      const me = await api.me();
      assert.equal(me.email, user.email);
      assert.equal(me.name, user.name);
    }
  });

  test("중복 이메일 → 409 (대소문자 무시)", async () => {
    const { api } = client();
    const err = await rejection(api.signup({ email: ALICE.email.toUpperCase(), password: "password123", name: "다른 앨리스" }));
    assert.equal(err.status, 409);
  });

  test("가입 검증: 이메일 형식, 비밀번호 8~64자 → 422 필드 오류", async () => {
    const { api } = client();
    const err = await rejection(api.signup({ email: "not-an-email", password: "short", name: "테스터" }));
    assert.equal(err.status, 422);
    assert.deepEqual(Object.keys(err.fieldErrors).sort(), ["email", "password"]);
    assert.equal((await rejection(api.signup({ email: "a@b.co", password: "x".repeat(65), name: "테스터" }))).status, 422);
    assert.ok(await verifiedSignup(api, "a@b.co", "😀".repeat(8)), "문자 수로 센다");
  });

  test("가입 검증: 이름은 필수, 앞뒤 공백 제거 후 1~20자 → 422 name 필드 오류", async () => {
    const { api } = client();
    for (const name of [undefined, "   ", "가".repeat(21)]) {
      const err = await rejection(api.signup({ email: "a@b.co", password: "password123", name }));
      assert.equal(err.status, 422);
      assert.deepEqual(Object.keys(err.fieldErrors), ["name"]);
    }
    assert.equal((await verifiedSignup(api, "a@b.co", "password123", "😀".repeat(20))).name, "😀".repeat(20), "문자 수로 센다");
  });

  test("로그인은 OAuth2 form만 받는다: JSON 본문은 422(username·password 누락)", async () => {
    const res = await mock.mockTransport({ method: "POST", path: "/auth/login", body: { email: ALICE.email, password: ALICE.password } });
    assert.equal(res.status, 422);
    assert.deepEqual(res.body.detail.map((item) => item.loc), [["body", "username"], ["body", "password"]]);
    const ok = await mock.mockTransport({ method: "POST", path: "/auth/login", form: { grant_type: "password", username: ALICE.email, password: ALICE.password } });
    assert.equal(ok.status, 200);
  });

  test("잘못된 로그인 → 401, 없는 이메일과 틀린 비밀번호는 같은 문구", async () => {
    const { api } = client();
    const wrong = await rejection(api.login({ email: ALICE.email, password: "wrong-password" }));
    const missing = await rejection(api.login({ email: "nobody@example.com", password: "wrong-password" }));
    assert.equal(wrong.status, 401);
    assert.equal(wrong.message, missing.message);
    assert.equal(unauthorized, 0, "로그인 실패는 세션 만료 처리가 아니다");
  });

  test("토큰 없이·모르는 토큰·만료된 토큰 → 401", async () => {
    const noHeader = await mock.mockTransport({ method: "GET", path: "/todos", headers: {} });
    assert.equal(noHeader.status, 401);
    const unknown = await mock.mockTransport({ method: "GET", path: "/me", headers: { Authorization: "Bearer made-up" } });
    assert.equal(unknown.status, 401);

    mock.configureMock({ tokenTtlSec: 0.05 });
    const { api } = await loggedIn(ALICE);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(await settled(api.listTodos({})), "pending");
    assert.equal(unauthorized, 1);
  });

  test("서버에서 세션이 만료된 상황(expireMockSessions) → 다음 요청 401", async () => {
    const { api } = await loggedIn(ALICE);
    await api.me();
    await mock.expireMockSessions();
    assert.equal(await settled(api.me()), "pending");
    assert.equal(unauthorized, 1);
  });

  test("Mock 토큰은 JWT가 아니다 (동작 확인용)", async () => {
    const { api } = client();
    const { access_token } = await api.login(ALICE);
    assert.equal(access_token.split(".").length, 2);
    assert.ok(access_token.startsWith("mock-token."));
  });

  test("비밀번호는 평문으로 저장하지 않는다", async () => {
    const { api } = client();
    await verifiedSignup(api, "c@d.co", "plain-text-pw");
    assert.ok(!localStorage.getItem("steptodo:mock-db:v2").includes("plain-text-pw"));
  });
});

describe("이메일 인증 (SMTP + Redis 흉내)", () => {
  const email = "new@example.com";

  test("인증 없이 가입하면 403, 다른 이메일로 인증해도 403", async () => {
    const { api } = client();
    assert.equal((await rejection(api.signup({ email, password: "password123", name: "테스터" }))).status, 403);
    await api.sendEmailCode({ email: "other@example.com" });
    await api.verifyEmailCode({ email: "other@example.com", code: await mock.getMockEmailCode("other@example.com") });
    assert.equal((await rejection(api.signup({ email, password: "password123", name: "테스터" }))).status, 403);
  });

  test("발송 응답에는 코드가 없다. 이메일 형식이 틀리면 보내지 않는다", async () => {
    const { api } = client();
    const sent = await api.sendEmailCode({ email });
    assert.deepEqual(sent, { expires_in: 300, resend_after: 60 });
    const err = await rejection(api.sendEmailCode({ email: "not-an-email" }));
    assert.equal(err.status, 422);
    assert.deepEqual(err.fieldErrors.email, ["올바른 이메일 형식이 아닙니다"]);
    assert.equal(await mock.getMockEmailCode("not-an-email"), null);
  });

  test("이미 가입된 이메일은 코드를 보내지 않는다 (409, 대소문자 무시)", async () => {
    const { api } = client();
    assert.equal((await rejection(api.sendEmailCode({ email: ALICE.email.toUpperCase() }))).status, 409);
  });

  test("재발송 제한: resend_after 안에 다시 요청하면 429, 지나면 새 코드", async () => {
    const { api } = client();
    mock.configureMock({ resendAfterSec: 0.05 });
    await api.sendEmailCode({ email });
    assert.equal((await rejection(api.sendEmailCode({ email }))).status, 429);
    await new Promise((r) => setTimeout(r, 70));
    assert.ok(await api.sendEmailCode({ email }));
  });

  test("틀린 코드 400, 5번 틀리면 429 후 코드 폐기, 형식이 틀리면 422", async () => {
    const { api } = client();
    await api.sendEmailCode({ email });
    const code = await mock.getMockEmailCode(email);
    assert.ok((await rejection(api.verifyEmailCode({ email, code: "12ab" }))).fieldErrors.code);
    for (let i = 0; i < 4; i++) assert.equal((await rejection(api.verifyEmailCode({ email, code: wrongCode(code) }))).status, 400);
    assert.equal((await rejection(api.verifyEmailCode({ email, code: wrongCode(code) }))).status, 429);
    assert.equal(await mock.getMockEmailCode(email), null);
    assert.equal((await rejection(api.verifyEmailCode({ email, code }))).status, 400, "폐기된 코드는 쓸 수 없다");
  });

  test("만료된 코드 400", async () => {
    const { api } = client();
    mock.configureMock({ emailCodeTtlSec: 0.03 });
    await api.sendEmailCode({ email });
    const code = await mock.getMockEmailCode(email);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await rejection(api.verifyEmailCode({ email, code }))).status, 400);
  });

  test("인증 유효 시간이 지나면 가입 403, 코드는 한 번만 쓸 수 있다", async () => {
    const { api } = client();
    mock.configureMock({ verifiedTtlSec: 0.03 });
    await api.sendEmailCode({ email });
    const code = await mock.getMockEmailCode(email);
    await api.verifyEmailCode({ email, code });
    assert.equal((await rejection(api.verifyEmailCode({ email, code }))).status, 400);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await rejection(api.signup({ email, password: "password123", name: "테스터" }))).status, 403);
  });
});

describe("사용자별 할 일", () => {
  test("목록은 자기 것만, total도 자기 것 기준", async () => {
    const alice = await loggedIn(ALICE);
    const bob = await loggedIn(BOB);
    const a = await alice.api.listTodos({});
    const b = await bob.api.listTodos({});
    assert.equal(a.total, 5);
    assert.equal(b.total, 2);
    assert.ok(b.items.every((todo) => todo.title.startsWith("bob:")));
    assert.ok(a.items.every((todo) => todo.owner_id === undefined), "소유자 ID는 응답에 없다");
  });

  test("다른 사용자의 할 일 조회·수정·완료·삭제 → 403, 없는 id는 404, 원본은 그대로", async () => {
    const alice = await loggedIn(ALICE);
    const bob = await loggedIn(BOB);
    const target = (await alice.api.listTodos({})).items[0];
    for (const call of [
      () => bob.api.getTodo(target.id),
      () => bob.api.updateTodo(target.id, { title: "hacked" }),
      () => bob.api.setCompleted(target.id, !target.is_completed),
      () => bob.api.deleteTodo(target.id),
    ]) {
      assert.equal((await rejection(call())).status, 403);
    }
    assert.equal((await rejection(bob.api.getTodo(99999))).status, 404);
    assert.deepEqual(await alice.api.getTodo(target.id), target);
  });

  test("생성 요청에 소유자 필드를 넣으면 422, 할 일은 만들어지지 않는다", async () => {
    const alice = await loggedIn(ALICE);
    const before = (await alice.api.listTodos({})).total;
    const res = await mock.mockTransport({
      method: "POST", path: "/todos",
      body: { title: "주인 바꾸기 시도", owner_id: 2, user_id: 2 },
      headers: { Authorization: `Bearer ${alice.session.accessToken}` },
    });
    assert.equal(res.status, 422);
    assert.deepEqual(res.body.detail.map((item) => [item.type, item.loc[1]]), [["extra_forbidden", "owner_id"], ["extra_forbidden", "user_id"]]);
    assert.equal((await alice.api.listTodos({})).total, before);
  });

  test("로그인 기능 전 Mock 데이터(v1)는 첫 테스트 사용자(alice)에게 옮긴다", async () => {
    localStorage.clear();
    localStorage.setItem("steptodo:mock-db:v1", JSON.stringify({
      nextId: 8,
      todos: [{ id: 7, title: "예전 할 일", description: null, is_completed: false, due_date: null, created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z", completed_at: null }],
    }));
    const alice = await loggedIn(ALICE);
    const bob = await loggedIn(BOB);
    assert.deepEqual((await alice.api.listTodos({})).items.map((t) => t.title), ["예전 할 일"]);
    assert.equal((await bob.api.listTodos({})).total, 2);
    assert.equal(localStorage.getItem("steptodo:mock-db:v1"), null);
    const created = await alice.api.createTodo({ title: "새 할 일" });
    assert.ok(created.id > 7, "id가 겹치지 않는다");
  });
});

describe("할 일 규칙 (기존 기능 회귀)", () => {
  let api;
  beforeEach(async () => {
    ({ api } = await loggedIn(ALICE));
    for (const todo of (await api.listTodos({ size: 100 })).items) await api.deleteTodo(todo.id);
  });
  const ids = (page) => page.items.map((todo) => todo.id);

  test("정렬: 최신순 / 마감일순(날짜 없으면 맨 뒤)", async () => {
    const a = await api.createTodo({ title: "A", due_date: "2026-11-05" });
    const b = await api.createTodo({ title: "B", description: "x", due_date: null });
    const c = await api.createTodo({ title: "C", due_date: "2026-11-01" });
    const old = await api.createTodo({ title: "C", due_date: "2020-01-01" }); // 같은 제목·과거 날짜 허용
    assert.deepEqual(ids(await api.listTodos({ sort: "latest" })), [old.id, c.id, b.id, a.id]);
    assert.deepEqual(ids(await api.listTodos({ sort: "due_date" })), [old.id, c.id, a.id, b.id]);
  });

  test("필터·완료 시각·완료 후 수정", async () => {
    const t = await api.createTodo({ title: "T" });
    const done = await api.setCompleted(t.id, true);
    assert.ok(done.completed_at);
    assert.deepEqual(ids(await api.listTodos({ status: "completed" })), [t.id]);
    assert.equal((await api.listTodos({ status: "active" })).total, 0);
    assert.equal((await api.updateTodo(t.id, { title: "T2", due_date: null })).is_completed, true);
    assert.equal((await api.setCompleted(t.id, false)).completed_at, null);
  });

  test("페이지 나누기", async () => {
    for (let i = 0; i < 4; i++) await api.createTodo({ title: `P${i}` });
    const page2 = await api.listTodos({ page: 2, size: 3 });
    assert.equal(page2.total, 4);
    assert.equal(page2.items.length, 1);
  });

  test("제목: 앞뒤 공백 제거 후 1~100자, 내부 공백 포함, 문자 수 기준", async () => {
    assert.equal((await api.createTodo({ title: "  장 보기  " })).title, "장 보기");
    assert.equal((await rejection(api.createTodo({ title: "   " }))).status, 422);
    assert.equal((await api.createTodo({ title: `  ${"가".repeat(100)}  ` })).title.length, 100);
    assert.ok((await rejection(api.createTodo({ title: `${"가 ".repeat(50)}가` }))).fieldErrors.title);
    assert.equal([...(await api.createTodo({ title: "😀".repeat(100) })).title].length, 100);
    assert.ok((await rejection(api.createTodo({ title: "ok", description: "x".repeat(2001) }))).fieldErrors.description);
    assert.ok((await rejection(api.createTodo({ title: "ok", due_date: "2026-02-30" }))).fieldErrors.due_date);
  });

  test("없는 항목 404, 잘못된 쿼리 422", async () => {
    assert.equal((await rejection(api.getTodo(99999))).status, 404);
    assert.equal((await rejection(api.listTodos({ status: "weird" }))).status, 422);
  });
});

test("실패 흉내: mockFail로 지정한 요청만 실패", async () => {
  const { api } = await loggedIn(ALICE);
  mock.configureMock({ fail: ["create"], failStatus: 403 });
  assert.equal((await rejection(api.createTodo({ title: "x" }))).status, 403);
  assert.ok((await api.listTodos({})).total >= 0);
  mock.configureMock({ fail: ["login"], failStatus: 500 });
  const err = await rejection(client().api.login(ALICE));
  assert.ok(err instanceof ApiError && err.status === 500);
  mock.configureMock({ fail: [] });
});
