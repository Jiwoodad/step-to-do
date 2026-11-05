import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installMemoryStorage } from "../support/memory-storage.mjs";

installMemoryStorage();
const { createSession } = await import("../../js/session.js");

beforeEach(() => sessionStorage.clear());

test("토큰은 sessionStorage에 저장되고, 새 세션 객체(=새로고침)에서 복원된다", () => {
  const first = createSession();
  assert.equal(first.hasToken(), false);
  first.start({ access_token: "abc", token_type: "bearer", expires_in: 60 });
  assert.equal(first.accessToken, "abc");
  assert.equal(localStorage.getItem("steptodo:session:v1"), null, "localStorage에는 두지 않는다");

  const reloaded = createSession();
  assert.equal(reloaded.accessToken, "abc");
  assert.equal(reloaded.isExpired(), false);
});

test("expires_in이 지나면 만료로 본다. expires_in이 없으면 서버 401로만 판단", () => {
  const session = createSession();
  session.start({ access_token: "abc", expires_in: 60 });
  assert.equal(session.isExpired(Date.now() + 61_000), true);
  session.start({ access_token: "abc" });
  assert.equal(session.isExpired(Date.now() + 10 ** 9), false);
});

test("로그인·로그아웃마다 epoch가 오르고, 로그아웃하면 저장된 토큰도 지운다", () => {
  const session = createSession();
  const e0 = session.epoch;
  session.start({ access_token: "a" });
  const e1 = session.epoch;
  session.end();
  assert.ok(e0 < e1 && e1 < session.epoch);
  assert.equal(session.accessToken, null);
  assert.equal(createSession().hasToken(), false);
});

test("세션이 끝나면 진행 중인 요청을 끊는다", () => {
  const session = createSession();
  session.start({ access_token: "a" });
  const controller = new AbortController();
  session.track(controller);
  session.end();
  assert.equal(controller.signal.aborted, true);
});

test("저장된 값이 깨져 있으면 로그인 안 된 상태로 시작", () => {
  sessionStorage.setItem("steptodo:session:v1", "{not json");
  assert.equal(createSession().hasToken(), false);
});
