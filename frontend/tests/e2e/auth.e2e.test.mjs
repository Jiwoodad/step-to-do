// 인증 흐름 e2e (Mock API). 실제 백엔드 연동 검증이 아니다.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../support/server.mjs";
import {
  ALICE, BOB, NON_LOCAL_HOST, addTodo, currentView, focused, hasNoHorizontalScroll, idle, launchBrowser, login, logout,
  mockDb, openApp, titles, toastTexts, verifySignupEmail, waitForFocus, waitForView,
} from "../support/browser.mjs";

let server, browser;
before(async () => {
  server = await startServer();
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close();
  await server?.close();
});

const bodyText = (page) => page.evaluate(() => document.body.innerText);
const storedSession = (page) => page.evaluate(() => sessionStorage.getItem("steptodo:session:v1"));
const EMAIL_FORMAT_MESSAGE = "올바른 이메일 형식이 아닙니다";

test("회원가입 → 로그인 → 할 일 관리 → 로그아웃", async () => {
  const { page, context, errors } = await openApp(browser, server.origin);
  assert.equal(await currentView(page), "auth");
  assert.ok(await page.isHidden("#todo-view"), "로그인 전에는 할 일 화면이 없다");

  await page.click('[data-auth-mode="signup"]');
  assert.equal(await page.textContent("#auth-heading"), "회원가입");
  assert.equal(await focused(page), "|signup-email");

  // 이메일: 형식을 먼저 검사하고, 이미 가입된 이메일에는 코드를 보내지 않는다.
  await page.click('#signup-form button[type="submit"]');
  assert.ok(await page.isVisible('#signup-form [data-error-for="email"]'));
  await page.fill("#signup-email", "carol@example");
  await page.click("#email-code-send");
  assert.equal((await page.textContent('#signup-form [data-error-for="email"]')).trim(), EMAIL_FORMAT_MESSAGE);
  assert.ok(await page.isHidden("#email-code-field"), "형식이 틀리면 코드를 보내지 않는다");
  await page.fill("#signup-email", "a".repeat(300));
  await page.click("#email-code-send");
  assert.equal((await page.textContent('#signup-form [data-error-for="email"]')).trim(), EMAIL_FORMAT_MESSAGE, "길이보다 형식을 먼저 본다");
  assert.ok(await page.isHidden("#email-code-field"));
  await page.fill("#signup-email", ALICE.email);
  await page.click("#email-code-send");
  await page.waitForFunction(() => document.querySelector('#signup-form [data-error-for="email"]').textContent.includes("이미 가입된"));

  // 인증 전에는 가입할 수 없다.
  await page.fill("#signup-email", "carol@example.com");
  await page.fill("#signup-name", "캐롤");
  await page.fill("#signup-password", "carol-password");
  await page.fill("#signup-password-confirm", "carol-password");
  await page.click('#signup-form button[type="submit"]');
  assert.match(await page.textContent('#signup-form [data-error-for="email"]'), /이메일 인증을 먼저/);

  // 코드 받기 → 틀린 코드 → 맞는 코드
  await page.click("#email-code-send");
  await page.waitForSelector("#email-code-field:not([hidden])");
  assert.equal(await focused(page), "|signup-code");
  assert.match(await page.textContent("#mock-mailbox"), /Mock 메일함/);
  const code = await page.evaluate((email) => window.steptodoMock.emailCode(email), "carol@example.com");
  await page.fill("#signup-code", "12");
  await page.click("#email-code-verify");
  assert.match(await page.textContent('#signup-form [data-error-for="code"]'), /숫자 6자리/);
  await page.fill("#signup-code", code === "000000" ? "111111" : "000000");
  await page.click("#email-code-verify");
  await page.waitForFunction(() => document.querySelector('#signup-form [data-error-for="code"]').textContent.includes("올바르지 않습니다"));
  await page.fill("#signup-code", code);
  await page.click("#email-code-verify");
  await page.waitForSelector("#email-verified:not([hidden])");
  assert.ok(await page.isHidden("#email-code-field"));
  assert.ok(await page.isHidden("#email-code-send"));
  assert.ok(await page.isHidden("#mock-mailbox"));
  assert.equal(await page.getAttribute("#signup-email", "readonly"), "", "인증한 이메일은 바꿀 수 없다");
  assert.equal(await focused(page), "|signup-name");

  // 이름: 공백만이면 안내, 20자 초과면 길이 안내
  await page.fill("#signup-name", "   ");
  await page.click('#signup-form button[type="submit"]');
  assert.equal(await page.textContent('#signup-form [data-error-for="name"]'), "이름을 입력해 주세요.");
  await page.fill("#signup-name", "가".repeat(21));
  await page.click('#signup-form button[type="submit"]');
  assert.match(await page.textContent('#signup-form [data-error-for="name"]'), /20자 이하.*21자/);
  await page.fill("#signup-name", "  캐롤  ");

  // 비밀번호: 길이, 확인 불일치 — 문구에 비밀번호가 나오지 않는다.
  await page.fill("#signup-password", "abc1234");
  await page.fill("#signup-password-confirm", "abc1234");
  await page.click('#signup-form button[type="submit"]');
  assert.match(await page.textContent('#signup-form [data-error-for="password"]'), /8자 이상.*7자/);
  assert.ok(!(await bodyText(page)).includes("abc1234"));
  await page.fill("#signup-password", "carol-password");
  await page.fill("#signup-password-confirm", "carol-passw0rd");
  await page.click('#signup-form button[type="submit"]');
  assert.equal(await page.textContent('#signup-form [data-error-for="password_confirm"]'), "비밀번호가 일치하지 않아요.");

  // 가입 성공 → 로그인 화면으로 안내 (자동 로그인 아님), 이메일은 채워 두고 비밀번호 칸으로
  await page.fill("#signup-password-confirm", "carol-password");
  await page.click('#signup-form button[type="submit"]');
  await page.waitForSelector("#login-form:not([hidden])");
  assert.match(await page.textContent("#auth-notice"), /회원가입이 완료/);
  assert.equal(await page.inputValue("#login-email"), "carol@example.com");
  assert.equal(await page.inputValue("#login-password"), "");
  assert.equal(await focused(page), "|login-password");
  assert.equal(await storedSession(page), null);

  await login(page, { email: "carol@example.com", password: "carol-password" });
  assert.equal(await page.textContent("#user-name"), "캐롤님", "앞뒤 공백을 뺀 이름으로 가입된다");
  assert.equal(await page.getAttribute("#user-name", "title"), "carol@example.com");
  assert.ok(await page.isVisible("#logout-button"));
  assert.match(await page.textContent("#list-empty-message"), /아직 할 일이 없어요/);
  assert.equal(await focused(page), "|create-title");

  await addTodo(page, "캐럴의 첫 할 일");
  assert.deepEqual(await titles(page), ["캐럴의 첫 할 일"]);
  await page.locator(".todo-check").first().click();
  await idle(page);
  assert.ok(await page.locator(".todo-check").first().isChecked());
  await page.locator(".todo-main").first().click();
  await page.click("#detail-edit");
  await page.fill("#edit-title", "수정한 할 일");
  await page.click('#edit-form button[type="submit"]');
  await page.waitForFunction(() => document.querySelector("#detail-title").textContent === "수정한 할 일");
  await page.click("#detail-delete");
  await page.click('#confirm-dialog button[value="confirm"]');
  await idle(page);
  assert.deepEqual(await titles(page), []);

  await logout(page);
  assert.match(await page.textContent("#auth-notice"), /로그아웃했어요/);
  assert.equal(await storedSession(page), null, "토큰을 지운다");
  assert.equal(await page.$$eval("#todo-list > *", (nodes) => nodes.length), 0);
  assert.equal(await focused(page), "|login-email");
  assert.deepEqual(errors, []);
  await context.close();
});

test("이메일 인증: 재발송 대기, 이메일을 바꾸면 처음부터, 화면 전환 시 늦은 응답 무시", async () => {
  const { page, context } = await openApp(browser, server.origin, { query: "&mockResendAfter=2" });
  await page.click('[data-auth-mode="signup"]');
  await page.fill("#signup-email", "dana@example.com");
  await page.click("#email-code-send");
  await page.waitForSelector("#email-code-field:not([hidden])");

  // 재발송 대기 중에는 버튼이 막혀 있고, 시간이 지나면 다시 받을 수 있다.
  assert.match(await page.textContent("#email-code-send"), /다시 받기 \(\d초\)/);
  assert.equal(await page.getAttribute("#email-code-send", "aria-disabled"), "true");
  const firstCode = await page.evaluate(() => window.steptodoMock.emailCode("dana@example.com"));
  await page.click("#email-code-send", { force: true });
  assert.equal(await page.evaluate(() => window.steptodoMock.emailCode("dana@example.com")), firstCode, "대기 중 클릭은 무시");
  await page.waitForFunction(() => document.querySelector("#email-code-send").textContent === "다시 받기", null, { timeout: 4000 });
  await page.click("#email-code-send");
  await page.waitForFunction(() => document.querySelector("#email-code-send").textContent.includes("초"));
  assert.match(await page.textContent("#email-code-timer"), /남은 시간 \d:\d\d/);

  // 코드를 받은 뒤 이메일을 고치면 처음부터
  await page.fill("#signup-email", "dana2@example.com");
  assert.ok(await page.isHidden("#email-code-field"));
  assert.equal(await page.textContent("#email-code-send"), "인증코드 받기");

  // 인증을 마친 뒤 "이메일 변경"을 누르면 다시 인증한다.
  await verifySignupEmail(page, "dana2@example.com");
  await page.click("#email-change");
  assert.ok(await page.isHidden("#email-verified"));
  assert.equal(await page.getAttribute("#signup-email", "readonly"), null);
  assert.equal(await focused(page), "|signup-email");

  // 발송 중에 로그인 화면으로 옮기면 늦게 온 응답은 무시한다.
  await page.evaluate(() => window.steptodoMock.configure({ delayMs: 400, resendAfterSec: 0 }));
  await page.fill("#signup-email", "dana3@example.com");
  await page.click("#email-code-send");
  assert.equal(await page.textContent("#email-code-send"), "보내는 중…");
  await page.click('#signup-form [data-auth-mode="login"]');
  await page.waitForTimeout(600);
  await page.click('[data-auth-mode="signup"]');
  assert.ok(await page.isHidden("#email-code-field"), "새 화면에 코드 입력칸이 나타나지 않는다");
  assert.ok(await page.isHidden("#mock-mailbox"));
  await context.close();
});

test("이메일 인증: 코드 만료, 시도 초과, 인증 유효 시간 만료, 발송 실패", async () => {
  const { page, context } = await openApp(browser, server.origin, { query: "&mockCodeTtl=1&mockVerifiedTtl=1&mockResendAfter=0" });
  await page.click('[data-auth-mode="signup"]');
  await page.fill("#signup-email", "erin@example.com");
  await page.click("#email-code-send");
  await page.waitForSelector("#email-code-field:not([hidden])");
  await page.waitForFunction(() => document.querySelector('#signup-form [data-error-for="code"]').textContent.includes("만료"), null, { timeout: 3000 });
  assert.equal(await page.textContent("#email-code-timer"), "만료됨");

  // 인증한 뒤 유효 시간이 지나서 가입하면 다시 인증하라고 안내한다. (서버 403)
  await page.evaluate(() => window.steptodoMock.configure({ emailCodeTtlSec: 60 }));
  await verifySignupEmail(page, "erin@example.com");
  await page.fill("#signup-name", "에린");
  await page.fill("#signup-password", "erin-password");
  await page.fill("#signup-password-confirm", "erin-password");
  await page.waitForTimeout(1100);
  await page.click('#signup-form button[type="submit"]');
  await page.waitForFunction(() => document.querySelector('#signup-form [data-error-for="email"]').textContent.includes("다시 인증"));
  assert.ok(await page.isHidden("#email-verified"));
  assert.equal(await page.getAttribute("#signup-email", "readonly"), null);
  assert.equal(await currentView(page), "auth");

  // 시도 횟수 초과 (서버 429)
  await page.click("#email-code-send");
  await page.waitForSelector("#email-code-field:not([hidden])");
  const code = await page.evaluate(() => window.steptodoMock.emailCode("erin@example.com"));
  const wrong = code === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) {
    await page.fill("#signup-code", wrong);
    await page.click("#email-code-verify");
    await page.waitForFunction(() => document.querySelector("#email-code-verify").textContent === "확인");
  }
  await page.waitForFunction(() => document.querySelector('#signup-form [data-error-for="code"]').textContent.includes("시도 횟수"));

  // 메일 서버 실패(500) → 요청 ID와 함께 폼 안에서 안내
  await page.evaluate(() => window.steptodoMock.configure({ fail: ["emailSend"], failStatus: 500 }));
  await page.click("#email-code-send");
  await page.waitForFunction(() => document.querySelector("#signup-form [data-form-error]").textContent.includes("요청 ID"));
  await context.close();
});

test("실제 서버 경로(fetch)의 요청 형식: 로그인 form 전송, Bearer 헤더 (요청을 가로챈 스텁, 백엔드 연동 아님)", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests = [];
  const json = (route, status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/config.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: 'window.STEPTODO_CONFIG = { apiBaseUrl: "/api", useMock: false };' }));
  await page.route("**/api/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    requests.push({ path, method: request.method(), headers: request.headers(), body: request.postData() });
    if (path === "/api/auth/email-verification/send") return json(route, 200, { expires_in: 300, resend_after: 60 });
    if (path === "/api/auth/email-verification/verify") return json(route, 200, { verified: true, expires_in: 1800 });
    if (path === "/api/auth/signup") return json(route, 201, { id: 7, email: "stub@example.com", created_at: "2026-10-31T00:00:00Z" });
    if (path === "/api/auth/login") return json(route, 200, { access_token: "stub-jwt", token_type: "bearer", expires_in: 3600 });
    if (path === "/api/me") return json(route, 200, { id: 7, email: "stub@example.com", created_at: "2026-10-31T00:00:00Z" });
    return json(route, 200, { items: [], total: 0, page: 1, size: 10 });
  });
  await page.goto(`${server.origin}/`);
  await waitForView(page);
  assert.ok(await page.isHidden("#mock-badge"));
  const find = (path) => requests.find((request) => request.path === path);

  await page.click('[data-auth-mode="signup"]');
  await page.fill("#signup-email", "stub@example.com");
  await page.click("#email-code-send");
  await page.waitForSelector("#email-code-field:not([hidden])");
  assert.ok(await page.isHidden("#mock-mailbox"), "실제 API에서는 코드를 화면에 보여주지 않는다");
  await page.fill("#signup-code", "123456");
  await page.click("#email-code-verify");
  await page.waitForSelector("#email-verified:not([hidden])");
  await page.fill("#signup-name", "스텁");
  await page.fill("#signup-password", "p@ss w+rd&=1");
  await page.fill("#signup-password-confirm", "p@ss w+rd&=1");
  await page.click('#signup-form button[type="submit"]');
  await page.waitForSelector("#login-form:not([hidden])");
  assert.deepEqual(JSON.parse(find("/api/auth/signup").body), { email: "stub@example.com", password: "p@ss w+rd&=1", name: "스텁" });
  assert.deepEqual(JSON.parse(find("/api/auth/email-verification/verify").body), { email: "stub@example.com", code: "123456" });

  await page.fill("#login-password", "p@ss w+rd&=1");
  await page.click('#login-form button[type="submit"]');
  await page.waitForSelector("#todo-view:not([hidden])");
  await page.waitForFunction(() => document.querySelector("#todo-list").getAttribute("aria-busy") === "false");

  const loginRequest = find("/api/auth/login");
  assert.equal(loginRequest.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(loginRequest.headers.authorization, undefined);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(loginRequest.body)), { grant_type: "password", username: "stub@example.com", password: "p@ss w+rd&=1" });
  assert.equal(find("/api/me").headers.authorization, "Bearer stub-jwt");
  assert.equal(find("/api/todos").headers.authorization, "Bearer stub-jwt");
  assert.ok(find("/api/todos").headers["x-request-id"]);
  assert.ok(!page.url().includes("stub-jwt"));
  await context.close();
});

test("이메일 형식 오류 문구: 로그인 폼도 같고, 서버 422가 영어 문구여도 같다 (요청을 가로챈 스텁, 백엔드 연동 아님)", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const sent = [];
  await page.route("**/config.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: 'window.STEPTODO_CONFIG = { apiBaseUrl: "/api", useMock: false };' }));
  await page.route("**/api/**", (route) => {
    sent.push(new URL(route.request().url()).pathname);
    route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({ detail: [{ loc: ["body", "email"], msg: "value is not a valid email address: The domain name x.y does not exist.", type: "value_error" }] }),
    });
  });
  await page.goto(`${server.origin}/`);
  await waitForView(page);

  await page.fill("#login-email", "carol@example");
  await page.fill("#login-password", "password123");
  await page.click('#login-form button[type="submit"]');
  assert.equal((await page.textContent('#login-form [data-error-for="email"]')).trim(), EMAIL_FORMAT_MESSAGE);

  await page.click('[data-auth-mode="signup"]');
  await page.fill("#signup-email", "carol@example");
  await page.click("#email-code-send");
  assert.equal((await page.textContent('#signup-form [data-error-for="email"]')).trim(), EMAIL_FORMAT_MESSAGE);
  assert.deepEqual(sent, [], "화면 검사에서 걸리면 요청을 보내지 않는다");

  await page.fill("#signup-email", "carol@x.y");
  await page.click("#email-code-send");
  await page.waitForFunction((message) => document.querySelector('#signup-form [data-error-for="email"]').textContent.trim() === message, EMAIL_FORMAT_MESSAGE);
  assert.deepEqual(sent, ["/api/auth/email-verification/send"]);
  assert.ok(await page.isHidden("#email-code-field"), "서버가 거절하면 코드 단계로 넘어가지 않는다");
  await context.close();
});

test("로그인 실패는 로그인 화면 안에서 안내하고, 비밀번호를 노출하지 않는다", async () => {
  const { page, context } = await openApp(browser, server.origin, { mockDelay: 300 });
  const consoleText = [];
  page.on("console", (message) => consoleText.push(message.text()));

  await page.click('#login-form button[type="submit"]');
  assert.ok(await page.isVisible('#login-form [data-error-for="email"]'));
  assert.ok(await page.isVisible('#login-form [data-error-for="password"]'));

  await page.fill("#login-email", ALICE.email);
  await page.fill("#login-password", "Wrong-Secret-987");
  await page.click('#login-form button[type="submit"]');
  assert.equal(await page.textContent('#login-form button[type="submit"]'), "로그인 중…");
  await page.click('#login-form button[type="submit"]', { force: true }); // 처리 중 연타
  await page.press("#login-password", "Enter");
  await page.waitForSelector("#login-form [data-form-error]:not([hidden])");
  assert.equal(await page.textContent("#login-form [data-form-error]"), "이메일 또는 비밀번호가 올바르지 않아요.");
  assert.equal(await currentView(page), "auth");
  assert.equal(await page.inputValue("#login-password"), "", "틀린 비밀번호는 지운다");
  assert.equal(await page.inputValue("#login-email"), ALICE.email, "이메일은 유지");
  assert.equal(await focused(page), "|login-password");
  for (const text of [await bodyText(page), page.url(), consoleText.join("\n")]) {
    assert.ok(!text.includes("Wrong-Secret-987"), "비밀번호가 화면·주소·콘솔에 없다");
  }

  // 연결 실패·서버 오류도 폼 안에서
  await page.evaluate(() => window.steptodoMock.configure({ fail: ["login"], failStatus: 0, delayMs: 30 }));
  await page.fill("#login-password", ALICE.password);
  await page.click('#login-form button[type="submit"]');
  await page.waitForFunction(() => document.querySelector("#login-form [data-form-error]").textContent.includes("연결할 수 없습니다"));
  await page.evaluate(() => window.steptodoMock.configure({ failStatus: 500 }));
  await page.fill("#login-password", ALICE.password);
  await page.click('#login-form button[type="submit"]');
  await page.waitForFunction(() => document.querySelector("#login-form [data-form-error]").textContent.includes("요청 ID"));

  await page.evaluate(() => window.steptodoMock.configure({ fail: [] }));
  await page.fill("#login-password", ALICE.password);
  await page.click('#login-form button[type="submit"]');
  await page.waitForFunction(() => !document.querySelector("#todo-view").hidden);
  assert.ok(!consoleText.join("\n").includes("mock-token."), "토큰이 콘솔에 없다");
  await context.close();
});

test("인증 만료(401) → 사용자·할 일 상태를 비우고 재로그인 안내", async () => {
  const { page, context } = await openApp(browser, server.origin);
  await login(page, ALICE);
  await page.fill("#create-title", "저장 안 한 입력");
  await page.locator(".todo-main").first().click();
  await page.waitForSelector("#detail-dialog[open]");

  await page.evaluate(() => window.steptodoMock.expireSessions()); // 서버 쪽에서 토큰 만료
  await page.click("#detail-toggle");
  await page.waitForSelector("#auth-view:not([hidden])");
  assert.match(await page.textContent("#auth-notice"), /만료되었거나 유효하지 않아요/);
  assert.equal(await page.evaluate(() => document.querySelector("#detail-dialog").open), false);
  assert.equal(await page.$$eval("#todo-list > *", (nodes) => nodes.length), 0);
  assert.equal(await page.inputValue("#create-title"), "");
  assert.equal(await storedSession(page), null);
  assert.equal(await focused(page), "|login-email");

  // 토큰 수명이 짧을 때 자연 만료
  await page.evaluate(() => window.steptodoMock.configure({ tokenTtlSec: 1 }));
  await login(page, BOB);
  await page.waitForTimeout(1200);
  await page.click('[data-status="completed"]');
  await page.waitForSelector("#auth-view:not([hidden])");
  assert.match(await page.textContent("#auth-notice"), /만료/);
  await context.close();
});

test("새로고침: 같은 탭은 로그인 유지, 새 탭(새 세션)은 다시 로그인, 만료·확인 실패 처리", async () => {
  const { page, context } = await openApp(browser, server.origin);
  await login(page, ALICE);
  await page.click('[data-status="active"]');
  await idle(page);
  await page.reload();
  await waitForView(page);
  assert.equal(await currentView(page), "todo");
  assert.equal(await page.textContent("#user-name"), `${ALICE.name}님`);
  assert.equal(await page.getAttribute('[data-status="active"]', "aria-pressed"), "true", "같은 사용자는 필터도 유지");
  assert.ok(!page.url().includes("mock-token"), "토큰은 주소에 없다");

  // 새 탭: sessionStorage는 탭마다 따로 → 로그인 화면
  const other = await context.newPage();
  await other.goto(`${server.origin}/?mock=1&mockDelay=40`);
  await waitForView(other);
  assert.equal(await currentView(other), "auth");
  await other.close();

  // /me 확인이 서버 오류로 실패하면 토큰을 지우지 않고 다시 시도할 수 있게 한다.
  await page.goto(`${server.origin}/?mock=1&mockDelay=40&mockFail=me&mockFailStatus=500`);
  await waitForView(page);
  assert.equal(await currentView(page), "boot");
  assert.match(await page.textContent("#boot-message"), /확인하지 못했어요/);
  assert.equal(await focused(page), "|boot-retry");
  await page.evaluate(() => window.steptodoMock.configure({ fail: [] }));
  await page.click("#boot-retry");
  await page.waitForSelector("#todo-view:not([hidden])");

  // 만료 시각이 지난 토큰은 /me를 부르지 않고 로그인 화면으로
  await page.evaluate(() => {
    const stored = JSON.parse(sessionStorage.getItem("steptodo:session:v1"));
    sessionStorage.setItem("steptodo:session:v1", JSON.stringify({ ...stored, expiresAt: Date.now() - 1000 }));
  });
  await page.reload();
  await waitForView(page);
  assert.equal(await currentView(page), "auth");
  assert.match(await page.textContent("#auth-notice"), /만료/);
  await context.close();
});

test("사용자 전환: 이전 사용자의 목록·상세·입력·오류·필터가 남지 않는다", async () => {
  const { page, context } = await openApp(browser, server.origin);
  await login(page, ALICE);
  const aliceTitles = await titles(page);
  await page.click('[data-status="active"]');
  await page.selectOption("#size-select", "5");
  await idle(page);
  await page.fill("#create-title", "x".repeat(101));
  await page.click('#create-form button[type="submit"]'); // 오류 표시 상태
  await page.fill("#create-description", "앨리스가 쓰던 설명");
  await page.locator(".todo-main").first().click();
  await page.click("#detail-edit");
  await page.fill("#edit-title", "앨리스 수정 중");
  await page.keyboard.press("Escape"); // 수정 → 상세 보기
  await page.click('[data-close-dialog]:visible');

  await logout(page);
  await login(page, BOB);
  const text = await bodyText(page);
  for (const title of [...aliceTitles, "앨리스가 쓰던 설명", "앨리스 수정 중"]) assert.ok(!text.includes(title), `남은 내용: ${title}`);
  assert.deepEqual(await titles(page), ["bob: 운동 30분", "bob: 장보기 목록 정리"]);
  assert.equal(await page.inputValue("#create-title"), "");
  assert.equal(await page.inputValue("#create-description"), "");
  assert.ok(await page.isHidden('#create-form [data-error-for="title"]'));
  assert.equal(await page.getAttribute('[data-status="all"]', "aria-pressed"), "true");
  assert.equal(await page.inputValue("#size-select"), "10");
  assert.equal(await page.textContent("#user-name"), `${BOB.name}님`);
  await context.close();
});

test("이전 사용자가 보낸 요청이 늦게 도착해도 현재 화면에 반영되지 않는다", async () => {
  const { page, context } = await openApp(browser, server.origin);
  await login(page, ALICE);
  const aliceTitles = await titles(page);

  // 앨리스의 목록 조회·완료 전환·상세 조회를 아주 느리게 보내 둔다.
  await page.evaluate(() => window.steptodoMock.configure({ delayMs: 2500 }));
  await page.locator(".todo-check").nth(1).click();
  await page.click('[data-status="completed"]');
  await page.locator(".todo-main").first().click();
  await page.evaluate(() => {
    window.__seen = [];
    const record = (node) => window.__seen.push(node.textContent ?? "");
    for (const target of ["#todo-list", "#toasts", "#detail-dialog"]) {
      new MutationObserver((records) => records.forEach((r) => r.addedNodes.forEach(record)))
        .observe(document.querySelector(target), { childList: true, subtree: true, characterData: true });
    }
  });
  await page.evaluate(() => window.steptodoMock.configure({ delayMs: 40 }));
  await page.keyboard.press("Escape");
  await logout(page);
  await login(page, BOB);
  await page.waitForTimeout(3000); // 앨리스의 응답이 모두 도착할 시간

  const seen = (await page.evaluate(() => window.__seen)).join("\n");
  for (const title of aliceTitles) assert.ok(!seen.includes(title), `늦은 응답이 화면에 나타남: ${title}`);
  assert.ok(!(await toastTexts(page)).some((t) => t.includes("완료")), "앨리스의 완료 전환 결과 토스트가 없다");
  assert.deepEqual(await titles(page), ["bob: 운동 30분", "bob: 장보기 목록 정리"]);
  assert.equal(await page.getAttribute('[data-status="all"]', "aria-pressed"), "true");
  assert.equal(await currentView(page), "todo", "늦게 온 응답 때문에 로그아웃되지 않는다");
  await context.close();
});

test("다른 사용자의 할 일(403): 상세 창에서 권한 안내 후 목록으로, 로그아웃하지 않는다", async () => {
  const { page, context } = await openApp(browser, server.origin);
  await login(page, ALICE);
  const title = (await titles(page))[1];
  const id = Number(await page.locator(".todo-item").nth(1).getAttribute("data-id"));
  // 화면이 목록을 받은 뒤 그 할 일의 주인이 다른 사용자로 바뀐 상황
  const changeOwner = (todoId) => page.evaluate((target) => {
    const db = JSON.parse(localStorage.getItem("steptodo:mock-db:v2"));
    db.todos.find((todo) => todo.id === target).owner_id = 2;
    localStorage.setItem("steptodo:mock-db:v2", JSON.stringify(db));
  }, todoId);
  await changeOwner(id);

  await page.locator(".todo-main").nth(1).click();
  await page.waitForSelector("#detail-missing:not([hidden])");
  assert.equal(await page.textContent("#detail-missing-title"), "이 할 일을 볼 권한이 없어요");
  assert.equal(await focused(page), "|detail-back");
  await page.click("#detail-back");
  await idle(page);
  assert.ok(!(await titles(page)).includes(title), "목록을 새로 받으면 사라진다");
  assert.equal(await currentView(page), "todo");

  // 목록에서 바로 완료 체크·삭제해도 토스트로 안내하고 목록을 새로 받는다.
  const nextId = Number(await page.locator(".todo-item").first().getAttribute("data-id"));
  await changeOwner(nextId);
  await page.locator(".todo-check").first().click();
  await page.waitForSelector(".toast-error");
  assert.ok((await toastTexts(page)).some((text) => text.includes("권한")));
  await idle(page);
  assert.equal(await page.textContent("#user-name"), `${ALICE.name}님`);
  assert.ok(!(await mockDb(page)).todos.find((todo) => todo.id === nextId && todo.owner_id === 1));
  await context.close();
});

test("403·404는 각각 안내하고 로그아웃시키지 않는다", async () => {
  const { page, context } = await openApp(browser, server.origin);
  await login(page, ALICE);
  await page.evaluate(() => window.steptodoMock.configure({ fail: ["update"], failStatus: 403 }));
  await page.locator(".todo-main").first().click();
  await page.click("#detail-edit");
  await page.fill("#edit-title", "권한 없는 수정");
  await page.click('#edit-form button[type="submit"]');
  await page.waitForSelector(".toast-error");
  assert.ok((await toastTexts(page)).some((t) => t.includes("권한")));
  assert.equal(await currentView(page), "todo");
  assert.equal(await page.inputValue("#edit-title"), "권한 없는 수정", "입력 유지");

  await page.evaluate(() => window.steptodoMock.configure({ fail: [] }));
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  const id = await page.locator(".todo-item").nth(1).getAttribute("data-id");
  await page.evaluate((todoId) => window.steptodoMock.remove(todoId), id);
  await page.locator(".todo-main").nth(1).click();
  await page.waitForSelector("#detail-missing:not([hidden])");
  assert.equal(await currentView(page), "todo");
  await page.click("#detail-back");
  await idle(page);
  assert.equal(await page.textContent("#user-name"), `${ALICE.name}님`);
  await context.close();
});

test("키보드만으로 회원가입 화면 이동·로그인·로그아웃", async () => {
  const { page, context } = await openApp(browser, server.origin);
  assert.equal(await focused(page), "|login-email");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab"); // 이메일 → 비밀번호 → 로그인 버튼 → 회원가입 링크
  assert.match(await focused(page), /link-button/);
  await page.keyboard.press("Enter");
  assert.equal(await focused(page), "|signup-email");
  await page.keyboard.type("keyboard@example.com");
  await page.click('#signup-form [data-auth-mode="login"]');
  assert.equal(await page.inputValue("#login-email"), "keyboard@example.com", "이메일은 옮겨 준다");

  await page.fill("#login-email", "");
  await page.focus("#login-email");
  await page.keyboard.type(ALICE.email);
  await page.keyboard.press("Tab");
  await page.keyboard.type(ALICE.password);
  await page.keyboard.press("Enter");
  await page.waitForSelector("#todo-view:not([hidden])");
  assert.equal(await waitForFocus(page, "|create-title"), "|create-title");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await focused(page), "|logout-button");
  await page.keyboard.press("Enter");
  await page.waitForSelector("#auth-view:not([hidden])");
  assert.equal(await focused(page), "|login-email");
  await context.close();
});

test("키보드만으로 이메일 인증 회원가입", async () => {
  const { page, context } = await openApp(browser, server.origin);
  await page.click('[data-auth-mode="signup"]');
  await page.keyboard.type("keys@example.com");
  await page.keyboard.press("Enter"); // 이메일 칸의 Enter = 코드 받기
  await page.waitForSelector("#email-code-field:not([hidden])");
  assert.equal(await focused(page), "|signup-code");
  await page.keyboard.type(await page.evaluate(() => window.steptodoMock.emailCode("keys@example.com")));
  await page.keyboard.press("Enter"); // 코드 칸의 Enter = 확인
  await page.waitForSelector("#email-verified:not([hidden])");
  assert.equal(await waitForFocus(page, "|signup-name"), "|signup-name");
  await page.keyboard.type("키보드");
  await page.keyboard.press("Tab");
  assert.equal(await focused(page), "|signup-password");
  await page.keyboard.type("keyboard-pass");
  await page.keyboard.press("Tab");
  assert.equal(await focused(page), "|signup-password-confirm");
  await page.keyboard.type("keyboard-pass");
  await page.keyboard.press("Enter");
  await page.waitForSelector("#login-form:not([hidden])");
  assert.equal(await waitForFocus(page, "|login-password"), "|login-password");
  await context.close();
});

test("모바일: 로그인·추가·삭제·로그아웃, 가로 스크롤 없음", async () => {
  const { page, context } = await openApp(browser, server.origin, {
    contextOptions: { viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true },
  });
  const noOverflow = () => hasNoHorizontalScroll(page);
  assert.ok(await noOverflow());
  await page.tap("#login-email");
  await page.fill("#login-email", "a-very-long-email-address-for-mobile@example.com");
  await page.click('[data-auth-mode="signup"]');
  await verifySignupEmail(page, "a-very-long-email-address-for-mobile@example.com");
  assert.ok(await noOverflow(), "이메일 인증 화면도 넘치지 않는다");
  await page.fill("#signup-name", "모바일");
  await page.fill("#signup-password", "mobile-pass-1");
  await page.fill("#signup-password-confirm", "mobile-pass-1");
  await page.tap('#signup-form button[type="submit"]');
  await page.waitForSelector("#login-form:not([hidden])");
  await page.fill("#login-password", "mobile-pass-1");
  await page.tap('#login-form button[type="submit"]');
  await page.waitForSelector("#todo-view:not([hidden])");
  await idle(page);
  assert.ok(await noOverflow(), "긴 이메일이 헤더를 넘치지 않는다");
  assert.ok(await page.isVisible("#logout-button"));
  await page.fill("#create-title", "모바일 할 일");
  await page.tap('#create-form button[type="submit"]');
  await idle(page);
  await page.locator(".todo-delete").first().tap();
  await page.tap('#confirm-dialog button[value="confirm"]');
  await idle(page);
  assert.deepEqual(await titles(page), []);
  await page.tap("#logout-button");
  await page.waitForSelector("#auth-view:not([hidden])");
  await context.close();
});

test("배포 주소에서는 ?mock=1이 무시되고 Mock 표시·테스트 계정 안내가 없다", async () => {
  const port = new URL(server.origin).port;
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`http://${NON_LOCAL_HOST}:${port}/?mock=1`);
  await waitForView(page);
  assert.equal(await currentView(page), "auth");
  assert.ok(await page.isHidden("#mock-badge"));
  assert.ok(await page.isHidden("#mock-accounts"));
  await page.fill("#login-email", ALICE.email);
  await page.fill("#login-password", ALICE.password);
  await page.click('#login-form button[type="submit"]');
  // Mock이었다면 로그인됐을 것이다. 실제 API(config.js의 apiBaseUrl)로 요청했으므로 연결 실패 등으로 로그인 화면에 남는다.
  await page.waitForSelector("#login-form [data-form-error]:not([hidden])");
  assert.equal(await currentView(page), "auth");
  assert.equal(await page.evaluate(() => localStorage.getItem("steptodo:mock-db:v2")), null, "Mock 저장소를 만들지 않았다");
  await context.close();
});
