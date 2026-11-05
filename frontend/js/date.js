// 날짜 판단은 모두 한국 시간(Asia/Seoul) 기준으로 한다.
const TIME_ZONE = "Asia/Seoul";
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const DAY_MS = 24 * 60 * 60 * 1000;

const ymdFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const dateTimeFormatter = new Intl.DateTimeFormat("ko-KR", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});

/** 한국 시간 기준 오늘 날짜 ("YYYY-MM-DD") */
export function todayKST(now = new Date()) {
  const parts = Object.fromEntries(ymdFormatter.formatToParts(now).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** "YYYY-MM-DD" 형식이면서 실제로 존재하는 날짜인지 (2026-02-30 같은 값은 거절) */
export function isValidYmd(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function ymdToUtc(value) {
  const [y, m, d] = value.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** from → to 까지 며칠인지. to가 더 이르면 음수 */
export function daysBetween(from, to) {
  return Math.round((ymdToUtc(to) - ymdToUtc(from)) / DAY_MS);
}

/** "2026년 10월 30일 (금)" */
export function formatDate(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(ymdToUtc(ymd)).getUTCDay()];
  return `${y}년 ${m}월 ${d}일 (${weekday})`;
}

/** 올해면 "10월 30일", 아니면 "2027년 1월 3일" */
export function formatShortDate(ymd, today = todayKST()) {
  const [y, m, d] = ymd.split("-").map(Number);
  return y === Number(today.slice(0, 4)) ? `${m}월 ${d}일` : `${y}년 ${m}월 ${d}일`;
}

/**
 * 서버가 준 시각 문자열을 Date로 바꾼다.
 * 시간대 표시가 없는 값("2026-10-30T02:00:00")은 UTC로 간주한다.
 */
export function parseServerDateTime(value) {
  if (!value) return null;
  let text = String(value).trim().replace(" ", "T");
  text = text.replace(/(\.\d{3})\d+/, "$1"); // 마이크로초 → 밀리초
  if (!/([zZ]|[+-]\d{2}:?\d{2})$/.test(text)) text += "Z";
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "2026년 10월 30일 (금) 오전 11:02" (한국 시간) */
export function formatDateTime(value) {
  const date = parseServerDateTime(value);
  return date ? dateTimeFormatter.format(date) : "-";
}

/**
 * 기한 초과 여부. 서버가 is_overdue를 주면 그 값을 쓰고, 없으면 직접 계산한다.
 * 마감일이 지났고 미완료일 때만 초과. 오늘이 마감이면 초과가 아니다.
 */
export function isOverdue(todo, today = todayKST()) {
  if (typeof todo.is_overdue === "boolean") return todo.is_overdue;
  return !todo.is_completed && Boolean(todo.due_date) && todo.due_date < today;
}

/** 목록에 보여줄 마감일 배지 정보. 마감일이 없으면 null */
export function dueInfo(todo, today = todayKST()) {
  if (!todo.due_date) return null;
  const short = formatShortDate(todo.due_date, today);
  if (todo.is_completed) return { tone: "muted", label: `${short} 마감` };

  const diff = daysBetween(today, todo.due_date);
  if (isOverdue(todo, today)) {
    return { tone: "danger", label: `기한 초과 · ${Math.max(1, -diff)}일 지남` };
  }
  if (diff === 0) return { tone: "warning", label: "오늘 마감" };
  if (diff === 1) return { tone: "info", label: "내일 마감" };
  return { tone: "info", label: `D-${diff} · ${short}` };
}
