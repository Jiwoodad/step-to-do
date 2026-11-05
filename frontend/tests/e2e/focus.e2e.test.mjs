// 상세 창을 닫을 때 포커스 복귀 (예전 간헐 실패 재발 방지).
// 원인 1: 완료 전환으로 목록이 다시 그려져 상세를 열었던 버튼이 사라지면 브라우저 기본 포커스 복원이 실패한다.
//        예전에는 비동기 close 이벤트에서야 포커스를 돌려줘서 Esc 직후 잠깐 닫힌 창 안에 포커스가 남았다.
// 원인 2: 닫자마자 다시 열면, 이전에 닫힌 창의 close 이벤트가 새 창이 열린 뒤에 도착해 새 창의 상태를 비웠다.
//        그러면 Esc로 닫아도 포커스를 돌려주지 않았다. (아래 "바로 다시 열기" 테스트가 이 경우)
// 지금은 닫는 즉시 포커스를 돌려주고, 열려 있는 동안 도착한 늦은 close 이벤트는 무시하므로 기다리지 않고 바로 검사한다.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../support/server.mjs";
import { ALICE, focused, idle, launchBrowser, login, openApp } from "../support/browser.mjs";

let server, browser, page, context;
before(async () => {
  server = await startServer();
  browser = await launchBrowser();
  ({ page, context } = await openApp(browser, server.origin));
  await login(page, ALICE);
});
after(async () => {
  await context?.close();
  await browser?.close();
  await server?.close();
});

const state = () => page.evaluate(() => {
  const active = document.activeElement;
  const title = active.closest(".todo-item")?.querySelector(".todo-title")?.textContent ?? "";
  return { open: document.querySelector("#detail-dialog").open, focus: `${title}|${active.id || active.className}` };
});

async function openThird() {
  const title = await page.locator(".todo-title").nth(2).textContent();
  await page.locator(".todo-main").nth(2).focus();
  await page.keyboard.press("Enter");
  await page.waitForSelector("#detail-dialog[open]");
  return title;
}

test("완료 전환(목록 다시 그림) 직후 Esc → 즉시 닫히고 같은 항목으로 포커스 (30회, 기다리지 않고 바로 다시 열기)", async () => {
  const misses = [];
  for (let i = 0; i < 30; i++) {
    const title = await openThird();
    await page.focus("#detail-toggle");
    await page.keyboard.press("Enter");
    await idle(page);
    await page.keyboard.press("Escape");
    const now = await state(); // 기다리지 않고 바로 확인
    if (now.open || now.focus !== `${title}|todo-main`) misses.push({ i, ...now, expected: title });
  }
  assert.deepEqual(misses, []);
});

test("닫자마자 다시 연 상세 창도 정상 동작한다 (늦은 close 이벤트 무시)", async () => {
  for (let i = 0; i < 10; i++) {
    await openThird();
    await page.keyboard.press("Escape");
    await openThird(); // 바로 다시 열기
    const before = await page.textContent("#detail-badges");
    await page.click("#detail-toggle");
    await idle(page);
    assert.notEqual(await page.textContent("#detail-badges"), before, `${i}회차: 완료 버튼이 동작해야 한다`);
    await page.keyboard.press("Escape");
  }
});

test("처리 중(완료 전환 응답 전)에 Esc를 눌러도 닫히고 포커스가 목록으로 간다", async () => {
  await page.evaluate(() => window.steptodoMock.configure({ delayMs: 400 }));
  for (let i = 0; i < 5; i++) {
    await openThird();
    await page.focus("#detail-toggle");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    const now = await state();
    assert.equal(now.open, false);
    assert.match(now.focus, /todo-main$/);
    await idle(page);
  }
  await page.evaluate(() => window.steptodoMock.configure({ delayMs: 40 }));
});

test("닫기(✕) 버튼과 바깥 클릭도 즉시 포커스 복귀", async () => {
  let title = await openThird();
  await page.click('#detail-view [data-close-dialog]');
  assert.equal((await state()).focus, `${title}|todo-main`);

  title = await openThird();
  await page.mouse.click(5, 5); // 대화상자 바깥(배경)
  const now = await state();
  assert.equal(now.open, false);
  assert.equal(now.focus, `${title}|todo-main`);
});

test("한글 입력 조합 중 Esc는 창을 닫지 않는다", async () => {
  await openThird();
  await page.click("#detail-edit");
  await page.dispatchEvent("#edit-title", "keydown", { key: "Escape", isComposing: true, bubbles: true });
  assert.ok(await page.isVisible("#edit-form"));
  await page.keyboard.press("Escape");
  assert.ok(await page.isVisible("#detail-view"));
  assert.equal(await focused(page), "|detail-edit");
  await page.keyboard.press("Escape");
});
