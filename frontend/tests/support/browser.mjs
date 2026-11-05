// e2e 테스트 도우미: 브라우저 실행, Mock 화면 열기, 로그인, "처리 끝남" 기다리기.
// 고정 시간만큼 쉬는 대신, 화면이 처리를 마쳤다는 조건을 기다린다.
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { MOCK_TEST_USERS } from "../../js/mock-api.js";

export const [ALICE, BOB] = MOCK_TEST_USERS;
export const NON_LOCAL_HOST = "steptodo.test"; // 배포 주소 흉내 (브라우저에서 127.0.0.1로 연결)

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];

/** 설치된 Chrome을 쓴다. 없으면 `npx playwright-core install chromium`으로 받은 브라우저를 쓴다. */
export function launchBrowser() {
  const executablePath = CHROME_CANDIDATES.find((path) => path && existsSync(path));
  return chromium.launch({ executablePath, args: [`--host-resolver-rules=MAP ${NON_LOCAL_HOST} 127.0.0.1`] });
}

/**
 * 새 브라우저 컨텍스트(= 새 사용자 브라우저)에서 Mock 화면을 연다.
 * @returns {{ page, context, errors: string[] }} errors: 페이지에서 난 처리되지 않은 예외
 */
export async function openApp(browser, origin, { query = "", mockDelay = 40, path = "/", contextOptions = {} } = {}) {
  const context = await browser.newContext({ viewport: { width: 900, height: 1000 }, locale: "ko-KR", ...contextOptions });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${origin}${path}?mock=1&mockDelay=${mockDelay}${query}`);
  await waitForView(page);
  return { page, context, errors };
}

/** 로그인 확인이 끝나고 로그인 화면이나 할 일 화면 중 하나가 보일 때까지 */
export function waitForView(page) {
  return page.waitForFunction(() => !document.querySelector("#auth-view").hidden || !document.querySelector("#todo-view").hidden || !document.querySelector("#boot-actions").hidden);
}

export const currentView = (page) =>
  page.evaluate(() => ["boot", "auth", "todo"].find((name) => !document.querySelector(`#${name}-view`).hidden));

export async function login(page, user = ALICE) {
  await page.fill("#login-email", user.email);
  await page.fill("#login-password", user.password);
  await page.click('#login-form button[type="submit"]');
  await page.waitForFunction(() => !document.querySelector("#todo-view").hidden);
  await idle(page);
}

/** 회원가입 화면에서 이메일 인증까지 마친다. Mock 메일함의 코드를 쓴다. */
export async function verifySignupEmail(page, email) {
  await page.fill("#signup-email", email);
  await page.click("#email-code-send");
  await page.waitForSelector("#email-code-field:not([hidden])");
  const code = await page.evaluate((address) => window.steptodoMock.emailCode(address), email);
  await page.fill("#signup-code", code);
  await page.click("#email-code-verify");
  await page.waitForSelector("#email-verified:not([hidden])");
}

export async function logout(page) {
  await page.click("#logout-button");
  await page.waitForFunction(() => !document.querySelector("#auth-view").hidden);
}

/** 목록 조회·저장·완료 전환·삭제가 모두 끝날 때까지 */
export async function idle(page) {
  await page.waitForTimeout(60); // 클릭 직후 아직 요청을 시작하지 않은 순간을 건너뛴다.
  await page.waitForFunction(() =>
    document.querySelector("#todo-list").getAttribute("aria-busy") !== "true" &&
    !document.querySelector(".is-pending") &&
    !document.querySelector("form[data-busy]"));
}

export async function addTodo(page, title, { due, description } = {}) {
  await page.fill("#create-title", title);
  if (description !== undefined) await page.fill("#create-description", description);
  if (due !== undefined) await page.fill("#create-due", due);
  await page.click('#create-form button[type="submit"]');
  await idle(page);
}

export const titles = (page) => page.$$eval(".todo-title", (nodes) => nodes.map((node) => node.textContent));
export const toastTexts = (page) => page.$$eval(".toast", (nodes) => nodes.map((node) => node.textContent));

/** 포커스 위치를 "항목 제목|요소 id 또는 class"로 돌려준다. */
export const focused = (page) =>
  page.evaluate(() => {
    const active = document.activeElement;
    const title = active.closest(".todo-item")?.querySelector(".todo-title")?.textContent ?? "";
    return `${title}|${active.id || active.className || active.tagName}`;
  });

/** 조건이 맞을 때까지 기다린 뒤 포커스 위치를 확인한다. (비동기로 옮겨지는 포커스를 즉시 검사하지 않기 위해) */
export async function waitForFocus(page, expected, timeout = 2000) {
  try {
    await page.waitForFunction((want) => {
      const active = document.activeElement;
      const title = active.closest(".todo-item")?.querySelector(".todo-title")?.textContent ?? "";
      return `${title}|${active.id || active.className || active.tagName}` === want;
    }, expected, { timeout });
  } catch {
    // 아래에서 실제 값과 함께 실패를 보여준다.
  }
  return focused(page);
}

/** 가로 스크롤이 없는지. 모바일에서는 넘치는 내용이 있으면 화면 폭 자체가 넓어지므로 기기 폭과 비교한다. */
export const hasNoHorizontalScroll = (page) =>
  page.evaluate(() => {
    const deviceWidth = Math.round(window.visualViewport?.width ?? window.innerWidth);
    return window.innerWidth <= deviceWidth && document.documentElement.scrollWidth <= deviceWidth;
  });

export const mockDb = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("steptodo:mock-db:v2")));

export const kstToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
export const shiftDate = (ymd, days) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};
