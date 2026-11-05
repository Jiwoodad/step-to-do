// 할 일 기능 회귀 e2e (Mock API, 로그인한 상태). 체크리스트 1~3번.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../support/server.mjs";
import {
  ALICE, addTodo, focused, hasNoHorizontalScroll, idle, kstToday, launchBrowser, login, mockDb, openApp, shiftDate,
  titles, toastTexts, waitForFocus,
} from "../support/browser.mjs";

let server, browser, opened;
before(async () => {
  server = await startServer();
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close();
  await server?.close();
});
afterEach(async () => {
  if (opened) assert.deepEqual(opened.errors, [], "페이지 예외 없음");
  await opened?.context.close();
  opened = null;
});

/** 앨리스로 로그인한 새 화면. emptyList면 예시 할 일을 지우고 시작한다. */
async function start({ query = "", mockDelay, emptyList = false } = {}) {
  opened = await openApp(browser, server.origin, { query, mockDelay });
  const { page } = opened;
  await login(page, ALICE);
  if (emptyList) {
    await page.evaluate(() => {
      const db = JSON.parse(localStorage.getItem("steptodo:mock-db:v2"));
      db.todos = db.todos.filter((todo) => todo.owner_id !== 1);
      localStorage.setItem("steptodo:mock-db:v2", JSON.stringify(db));
    });
    await page.click('[data-status="active"]');
    await page.click('[data-status="all"]');
    await idle(page);
  }
  return page;
}
const aliceTodos = async (page) => (await mockDb(page)).todos.filter((todo) => todo.owner_id === 1);

test("1-1·1-2 추가 후 목록 반영, 상세에서 설명 포함 전체 내용", async () => {
  const page = await start();
  await addTodo(page, "설명 있는 항목", { description: "첫 줄\n둘째 줄\n셋째 줄" });
  assert.equal((await titles(page))[0], "설명 있는 항목");
  await page.locator(".todo-main").first().click();
  await page.waitForSelector("#detail-dialog[open]");
  assert.equal(await page.textContent("#detail-description"), "첫 줄\n둘째 줄\n셋째 줄");
});

test("1-3·1-4·1-5 수정·마감일 비우기·완료/취소·완료 후 수정", async () => {
  const page = await start();
  await addTodo(page, "수정 대상", { due: "2026-12-25" });
  await page.locator(".todo-main").first().click();
  await page.click("#detail-edit");
  await page.fill("#edit-title", "수정 완료");
  await page.fill("#edit-description", "새 설명");
  await page.click('#edit-form [data-clear-for="due_date"]');
  await page.click('#edit-form button[type="submit"]');
  await page.waitForFunction(() => document.querySelector("#detail-title").textContent === "수정 완료");
  assert.equal(await page.textContent("#detail-due"), "없음");
  await page.click("#detail-toggle");
  await idle(page);
  assert.equal(await page.textContent("#detail-badges"), "완료");
  await page.click("#detail-edit");
  await page.fill("#edit-title", "완료 후 수정");
  await page.click('#edit-form button[type="submit"]');
  await page.waitForFunction(() => document.querySelector("#detail-title").textContent === "완료 후 수정");
  await page.click("#detail-toggle");
  await idle(page);
  assert.equal(await page.textContent("#detail-completed"), "-");
});

test("1-6 삭제 확인, 취소·Esc면 유지", async () => {
  const page = await start();
  const before = await titles(page);
  await page.locator(".todo-delete").first().click();
  await page.click('#confirm-dialog button[value="cancel"]');
  await page.locator(".todo-delete").first().click();
  await page.keyboard.press("Escape");
  await idle(page);
  assert.deepEqual(await titles(page), before);
  await page.locator(".todo-delete").first().click();
  await page.click('#confirm-dialog button[value="confirm"]');
  await idle(page);
  assert.deepEqual(await titles(page), before.slice(1));
});

test("1-7·1-8 필터·정렬, 2-4 마감일순에서 날짜 없는 항목은 맨 뒤", async () => {
  const page = await start();
  await page.click('[data-status="completed"]');
  await idle(page);
  assert.ok(await page.$$eval(".todo-check", (nodes) => nodes.length > 0 && nodes.every((n) => n.checked)));
  await page.click('[data-status="active"]');
  await idle(page);
  assert.ok(await page.$$eval(".todo-check", (nodes) => nodes.every((n) => !n.checked)));
  await page.click('[data-status="all"]');
  await page.selectOption("#sort-select", "due_date");
  await idle(page);
  const todos = await aliceTodos(page);
  const dueOf = (title) => todos.find((todo) => todo.title === title).due_date;
  const order = (await titles(page)).map(dueOf);
  const firstNull = order.indexOf(null);
  assert.ok(firstNull > 0 && order.slice(firstNull).every((due) => due === null));
  assert.deepEqual(order.slice(0, firstNull), [...order.slice(0, firstNull)].sort());
});

test("1-9·1-10·1-11 페이지 크기·이전/다음, 조건 바꾸면 1페이지, 삭제로 빈 페이지면 앞 페이지", async () => {
  const page = await start();
  await page.selectOption("#size-select", "5");
  await idle(page);
  for (let i = 0; i < 12; i++) await addTodo(page, `페이지 항목 ${i}`); // 예시 5개 + 12개 → 어떤 조건에서도 2페이지 이상
  await page.click("[aria-label='다음 페이지']");
  await idle(page);
  assert.ok(page.url().includes("page=2"));
  await page.click("[aria-label='이전 페이지']");
  await idle(page);
  assert.ok(!page.url().includes("page="));
  for (const change of [
    () => page.click('[data-status="active"]'),
    () => page.selectOption("#size-select", "10"),
    () => page.selectOption("#sort-select", "due_date"),
  ]) {
    await page.click("[aria-label='다음 페이지']");
    await idle(page);
    await change();
    await idle(page);
    assert.ok(!page.url().includes("page="), `조건 변경 → 1페이지: ${page.url()}`);
  }
  await page.selectOption("#sort-select", "latest");
  await page.click('[data-status="all"]');
  await page.selectOption("#size-select", "5");
  await idle(page);
  const last = await page.$$eval(".page-btn[aria-label$='페이지']", (nodes) =>
    Math.max(...nodes.map((n) => parseInt(n.getAttribute("aria-label"), 10)).filter(Number.isFinite)));
  await page.click(`[aria-label='${last}페이지']`);
  await idle(page);
  while (page.url().includes(`page=${last}`)) { // 마지막 페이지를 모두 지운다
    await page.locator(".todo-delete").first().click();
    await page.click('#confirm-dialog button[value="confirm"]');
    await idle(page);
  }
  assert.ok(page.url().includes(`page=${last - 1}`), page.url());
  assert.equal((await titles(page)).length, 5, "빈 페이지 대신 앞 페이지를 보여준다");
});

test("2-1·2-2 제목·설명 길이, 잘못된 날짜 거절, 과거 날짜 허용", async () => {
  const page = await start();
  await page.fill("#create-title", "    ");
  await page.click('#create-form button[type="submit"]');
  assert.ok(await page.isVisible('#create-form [data-error-for="title"]'));
  await page.fill("#create-title", "가 ".repeat(50) + "가");
  assert.equal(await page.textContent('#create-form [data-counter-for="title"]'), "101 / 100");
  await page.click('#create-form button[type="submit"]');
  assert.match(await page.textContent('#create-form [data-error-for="title"]'), /100자/);
  await page.fill("#create-title", `  ${"😀".repeat(100)}  `);
  await page.fill("#create-description", "x".repeat(2001));
  await page.click('#create-form button[type="submit"]');
  assert.match(await page.textContent('#create-form [data-error-for="description"]'), /2,000자/);
  await page.fill("#create-description", "");
  await page.click("#create-due");
  await page.keyboard.type("2026");
  await page.click('#create-form button[type="submit"]');
  assert.ok(await page.isVisible('#create-form [data-error-for="due_date"]'), "일부만 입력한 날짜");
  await page.fill("#create-due", "2001-01-01");
  await page.click('#create-form button[type="submit"]');
  await idle(page);
  assert.equal((await titles(page))[0], "😀".repeat(100));
});

test("2-3 한국 날짜 기준 기한 초과 (브라우저 시간대가 달라도)", async () => {
  opened = await openApp(browser, server.origin, { contextOptions: { timezoneId: "America/Los_Angeles" } });
  const { page } = opened;
  await login(page, ALICE);
  const today = kstToday();
  await addTodo(page, "어제 마감", { due: shiftDate(today, -1) });
  await addTodo(page, "오늘 마감 항목", { due: today });
  const badge = (title) => page.locator(".todo-item", { hasText: title }).locator(".badge").textContent();
  assert.match(await badge("어제 마감"), /기한 초과/);
  assert.equal(await badge("오늘 마감 항목"), "오늘 마감");
});

test("2-5 전체가 빈 상태 vs 필터 결과 없음", async () => {
  const page = await start({ emptyList: true });
  assert.match(await page.textContent("#list-empty-message"), /아직 할 일이 없어요/);
  await page.click('[data-status="active"]');
  await idle(page);
  assert.match(await page.textContent("#list-empty-message"), /아직 할 일이 없어요/);
  await page.click('[data-status="all"]');
  await addTodo(page, "하나 있음");
  await page.click('[data-status="completed"]');
  await idle(page);
  assert.match(await page.textContent("#list-empty-message"), /완료한 할 일이 아직 없어요/);
  await page.click("#list-empty-reset");
  await idle(page);
  assert.deepEqual(await titles(page), ["하나 있음"]);
});

test("2-6·2-7·2-8 처리 중 표시, 중복 클릭 방지, 성공 전 체크 표시 안 함", async () => {
  const page = await start({ mockDelay: 700 });
  const count = async () => (await aliceTodos(page)).length;
  const before = await count();
  await page.fill("#create-title", "연타 테스트");
  await page.click('#create-form button[type="submit"]');
  assert.equal(await page.textContent('#create-form button[type="submit"]'), "추가 중…");
  await page.click('#create-form button[type="submit"]', { force: true });
  await page.press("#create-title", "Enter");
  await page.waitForSelector("#list-loading:not([hidden])");
  await idle(page);
  assert.equal(await count(), before + 1);

  const row = page.locator(".todo-item", { has: page.locator(".todo-check:not(:checked)") }).first();
  const title = await row.locator(".todo-title").textContent();
  await row.locator(".todo-check").click();
  assert.equal(await row.locator(".todo-check").isChecked(), false, "요청 중엔 체크 안 됨");
  await row.locator(".todo-check").click({ force: true });
  await idle(page);
  assert.ok(await page.locator(".todo-item", { hasText: title }).locator(".todo-check").isChecked(), "한 번만 전환");

  const target = page.locator(".todo-item").first();
  await target.locator(".todo-delete").click();
  await page.click('#confirm-dialog button[value="confirm"]');
  await page.waitForSelector(".todo-item.is-pending");
  await target.locator(".todo-delete").click({ force: true });
  assert.ok(await page.isHidden("#confirm-dialog"), "삭제 중엔 확인창이 다시 뜨지 않음");
  await idle(page);
  assert.equal(await count(), before);
});

test("2-8 요청 실패 시 입력 유지, 성공 표시 없음", async () => {
  const page = await start({ query: "&mockFail=create,update,toggle,delete&mockFailStatus=500" });
  await page.fill("#create-title", "실패할 제목");
  await page.fill("#create-description", "실패할 설명");
  await page.click('#create-form button[type="submit"]');
  await idle(page);
  assert.equal(await page.inputValue("#create-title"), "실패할 제목");
  assert.equal(await page.inputValue("#create-description"), "실패할 설명");
  const toasts = await toastTexts(page);
  assert.ok(toasts.some((t) => t.includes("서버 오류") && t.includes("요청 ID")));
  assert.ok(!toasts.some((t) => t.includes("추가했어요")));
  const wasChecked = await page.locator(".todo-check").first().isChecked();
  await page.locator(".todo-check").first().click();
  await idle(page);
  assert.equal(await page.locator(".todo-check").first().isChecked(), wasChecked);
  const firstTitle = (await titles(page))[0];
  await page.locator(".todo-delete").first().click();
  await page.click('#confirm-dialog button[value="confirm"]');
  await idle(page);
  assert.equal((await titles(page))[0], firstTitle);
});

test("2-9 없는 항목 접근 안내 + 목록으로 돌아가기", async () => {
  const page = await start();
  const title = (await titles(page))[1];
  const id = await page.locator(".todo-item").nth(1).getAttribute("data-id");
  await page.evaluate((todoId) => window.steptodoMock.remove(todoId), id);
  await page.locator(".todo-main").nth(1).click();
  await page.waitForSelector("#detail-missing:not([hidden])");
  assert.equal(await focused(page), "|detail-back");
  await page.click("#detail-back");
  await idle(page);
  assert.ok(!(await titles(page)).includes(title));
  assert.match(await focused(page), /todo-main$/);
});

test("3-4 라벨·버튼 이름", async () => {
  const page = await start();
  const unlabeled = await page.evaluate(() =>
    [...document.querySelectorAll("input, textarea, select")].filter((n) => !(n.labels?.length || n.getAttribute("aria-label"))).map((n) => n.id || n.name));
  assert.deepEqual(unlabeled, []);
  const nameless = await page.evaluate(() =>
    [...document.querySelectorAll("button")].filter((b) => !(b.getAttribute("aria-label") || b.textContent.trim())).map((b) => b.outerHTML.slice(0, 60)));
  assert.deepEqual(nameless, []);
});

test("3-5 키보드: 추가·상세·완료·삭제·페이지, 창을 닫으면 원래 위치로 포커스", async () => {
  const page = await start();
  await page.focus("#create-title");
  await page.keyboard.type("키보드로 추가");
  await page.keyboard.press("Enter");
  await idle(page);
  assert.equal((await titles(page))[0], "키보드로 추가");

  const third = (await titles(page))[2];
  await page.locator(".todo-main").nth(2).focus();
  await page.keyboard.press("Enter");
  await page.waitForSelector("#detail-dialog[open]");
  await page.focus("#detail-toggle");
  await page.keyboard.press("Enter");
  await idle(page);
  await page.keyboard.press("Escape");
  assert.equal(await focused(page), `${third}|todo-main`, "Esc 직후 바로 원래 항목");

  await page.keyboard.press("Shift+Tab");
  assert.match(await focused(page), /todo-check/);
  await page.keyboard.press("Space");
  await idle(page);
  assert.match(await focused(page), /todo-check/, "다시 그려도 체크박스에 포커스");

  const [t0, t1] = await titles(page);
  await page.locator(".todo-main").first().focus();
  await page.keyboard.press("Enter");
  await page.waitForSelector("#detail-dialog[open]");
  await page.focus("#detail-edit");
  await page.keyboard.press("Enter");
  assert.equal(await focused(page), "|edit-title");
  await page.keyboard.press("Escape");
  assert.ok(await page.isVisible("#detail-view"), "수정 중 Esc → 상세 보기");
  assert.equal(await focused(page), "|detail-edit");
  await page.focus("#detail-delete");
  await page.keyboard.press("Enter");
  await page.waitForSelector("#confirm-dialog[open]");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await idle(page);
  assert.equal(await waitForFocus(page, `${t1}|todo-main`), `${t1}|todo-main`, "삭제 후 다음 항목");
  assert.ok(!(await titles(page)).includes(t0));

  await addTodo(page, "페이지용 1");
  await addTodo(page, "페이지용 2");
  await page.selectOption("#size-select", "5");
  await idle(page);
  await page.focus("[aria-label='다음 페이지']");
  await page.keyboard.press("Enter");
  await idle(page);
  const nextDisabled = await page.isDisabled("[aria-label='다음 페이지']");
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")), nextDisabled ? "2페이지" : "다음 페이지");
});

test("토스트가 모달 위에 보임", async () => {
  const page = await start();
  await page.locator(".todo-main").first().click();
  await page.waitForSelector("#detail-dialog[open]");
  await page.click("#detail-toggle");
  await page.waitForSelector(".toast");
  assert.ok(await page.evaluate(() => document.querySelector("#toasts").matches(":popover-open")));
});

test("3-6 모바일에서 추가·조회·수정·삭제", async () => {
  opened = await openApp(browser, server.origin, {
    contextOptions: { viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true },
  });
  const { page } = opened;
  await login(page, ALICE);
  await page.tap("#create-title");
  await page.fill("#create-title", "모바일 추가");
  await page.tap('#create-form button[type="submit"]');
  await idle(page);
  assert.equal((await titles(page))[0], "모바일 추가");
  await page.locator(".todo-main").first().tap();
  await page.tap("#detail-edit");
  await page.fill("#edit-title", "모바일 수정");
  await page.tap('#edit-form button[type="submit"]');
  await page.waitForFunction(() => document.querySelector("#detail-title").textContent === "모바일 수정");
  await page.tap("#detail-delete");
  await page.tap('#confirm-dialog button[value="confirm"]');
  await idle(page);
  assert.ok(!(await titles(page)).includes("모바일 수정"));
  await addTodo(page, "공백없이아주긴제목".repeat(11)); // 99자, 줄바꿈할 곳이 없는 제목
  assert.ok(await hasNoHorizontalScroll(page), "긴 제목도 화면 폭을 넘기지 않는다");
});
