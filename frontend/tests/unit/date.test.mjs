import { test } from "node:test";
import assert from "node:assert/strict";
import * as d from "../../js/date.js";

test("한국 시간 기준 오늘", () => {
  assert.equal(d.todayKST(new Date("2026-10-30T15:30:00Z")), "2026-10-31"); // KST 10-31 00:30
  assert.equal(d.todayKST(new Date("2026-10-30T14:59:00Z")), "2026-10-30");
});

test("날짜 형식 검사와 일수 계산", () => {
  assert.equal(d.isValidYmd("2026-02-30"), false);
  assert.equal(d.isValidYmd("2028-02-29"), true);
  assert.equal(d.isValidYmd("26-1-1"), false);
  assert.equal(d.daysBetween("2026-12-31", "2027-01-01"), 1);
  assert.equal(d.formatDate("2026-10-30"), "2026년 10월 30일 (금)");
});

test("기한 초과: 지난 마감일 + 미완료만. 오늘 마감은 아님", () => {
  const today = "2026-10-30";
  assert.equal(d.isOverdue({ is_completed: false, due_date: "2026-10-29" }, today), true);
  assert.equal(d.isOverdue({ is_completed: false, due_date: today }, today), false);
  assert.equal(d.isOverdue({ is_completed: true, due_date: "2026-10-01" }, today), false);
  assert.equal(d.isOverdue({ is_completed: false, due_date: null }, today), false);
  assert.equal(d.isOverdue({ is_completed: false, due_date: "2026-10-01", is_overdue: false }, today), false, "서버 값 우선");
});

test("마감일 배지 문구", () => {
  const today = "2026-10-30";
  assert.equal(d.dueInfo({ is_completed: false, due_date: today }, today).label, "오늘 마감");
  assert.equal(d.dueInfo({ is_completed: false, due_date: "2026-10-31" }, today).label, "내일 마감");
  assert.equal(d.dueInfo({ is_completed: false, due_date: "2026-11-04" }, today).label, "D-5 · 11월 4일");
  assert.equal(d.dueInfo({ is_completed: false, due_date: "2026-10-27" }, today).label, "기한 초과 · 3일 지남");
  assert.equal(d.dueInfo({ is_completed: true, due_date: "2026-10-27" }, today).label, "10월 27일 마감");
});

test("서버 시각: 시간대가 없으면 UTC로 간주", () => {
  assert.equal(d.parseServerDateTime("2026-10-30T02:00:00").toISOString(), "2026-10-30T02:00:00.000Z");
  assert.equal(d.parseServerDateTime("2026-10-30 02:00:00.123456").toISOString(), "2026-10-30T02:00:00.123Z");
  assert.equal(d.parseServerDateTime("2026-10-30T11:00:00+09:00").toISOString(), "2026-10-30T02:00:00.000Z");
  assert.equal(d.parseServerDateTime("nonsense"), null);
});
