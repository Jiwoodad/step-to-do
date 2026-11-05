// 백엔드 없이 화면을 확인하기 위한 가짜 API.
// API.md와 같은 요청/응답·오류 형식을 흉내 내고, 데이터는 브라우저 localStorage에 둔다.
//
// ⚠️ 인증은 "흐름 확인용 흉내"일 뿐 보안 기능이 아니다.
//   - access_token은 JWT가 아니라 임의 문자열이고, 서명·만료 검증은 이 파일의 표(tokens)만 본다.
//   - 비밀번호는 소금 없는 SHA-256으로만 바꿔 저장한다. 실제 서비스의 비밀번호 보관 방식이 아니다.
//   - 사용자별 데이터 분리(소유권 검사)도 여기서는 흉내다. 실제 보안은 백엔드가 책임진다.
//   - 이메일 인증코드는 메일을 보내지 않고 localStorage에 둔다. 화면의 "Mock 메일함"으로 확인한다.
//   - 데이터는 이 브라우저의 localStorage에 그대로 남으므로 실제 비밀번호를 넣지 말 것.
import { isValidYmd, todayKST } from "./date.js";

const STORAGE_KEY = "steptodo:mock-db:v2";
const LEGACY_STORAGE_KEY = "steptodo:mock-db:v1"; // 로그인 기능 전의 Mock 데이터 (사용자 구분 없음)
const OPERATIONS = ["emailSend", "emailVerify", "signup", "login", "me", "list", "get", "create", "update", "toggle", "delete"];
const CREATE_FIELDS = ["title", "description", "due_date"];
const CODE_PATTERN = /^\d{6}$/;
const MAX_CODE_ATTEMPTS = 5;
const STATUS_VALUES = ["all", "active", "completed"];
const SORT_VALUES = ["latest", "due_date"];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Mock 테스트 계정. 화면의 로그인 안내와 테스트에서 쓴다. */
export const MOCK_TEST_USERS = Object.freeze([
  Object.freeze({ email: "alice@example.com", password: "password123" }),
  Object.freeze({ email: "bob@example.com", password: "password123" }),
]);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clone = (value) => JSON.parse(JSON.stringify(value));
const nowIso = () => new Date().toISOString();
const charCount = (text) => [...text].length; // Python len()과 같은 문자 수
const normalizeEmail = (email) => email.trim().toLowerCase();

async function hashPassword(password) {
  const bytes = new TextEncoder().encode(`steptodo-mock:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newToken() {
  const random = globalThis.crypto?.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  return `mock-token.${random}`; // JWT 아님
}

function addDays(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function sampleTodos(email) {
  const today = todayKST();
  if (email === MOCK_TEST_USERS[1].email) {
    return [
      { title: "bob: 장보기 목록 정리", description: "우유, 계란", due_date: today },
      { title: "bob: 운동 30분", description: null, due_date: addDays(today, 2) },
    ];
  }
  return [
    { title: "FastAPI 공식 튜토리얼 읽기", description: "Path·Query 파라미터와 Pydantic 모델 부분까지.", due_date: addDays(today, -2) },
    { title: "MySQL 컨테이너 띄워보기", description: null, due_date: today },
    { title: "Alembic 첫 마이그레이션 만들기", description: "todos 테이블 생성", due_date: addDays(today, 5) },
    { title: "pytest로 할 일 생성 테스트 작성", description: null, due_date: null },
    { title: "프로젝트 명세 정리", description: "1~8단계 통과 기준 확인", due_date: addDays(today, -1), done: true },
  ];
}

function pushTodo(db, ownerId, sample) {
  const time = nowIso();
  db.todos.push({
    id: db.nextId++,
    owner_id: ownerId,
    title: sample.title,
    description: sample.description ?? null,
    is_completed: Boolean(sample.done),
    due_date: sample.due_date ?? null,
    created_at: time,
    updated_at: time,
    completed_at: sample.done ? time : null,
  });
}

/**
 * 테스트 사용자 두 명과 예시 할 일을 만든다.
 * 로그인 기능 전의 Mock 데이터(v1)가 있으면, 그 할 일은 첫 번째 테스트 사용자(alice)의 것으로 옮긴다.
 */
async function seed({ legacyTodos = null } = {}) {
  const db = { nextUserId: 1, users: [], nextId: 1, todos: [], tokens: {} };
  for (const { email, password } of MOCK_TEST_USERS) {
    db.users.push({ id: db.nextUserId++, email, password_hash: await hashPassword(password), created_at: nowIso() });
  }
  const [alice, bob] = db.users;
  if (legacyTodos) {
    for (const todo of legacyTodos) db.todos.push({ ...todo, owner_id: alice.id });
    db.nextId = Math.max(0, ...db.todos.map((todo) => todo.id)) + 1;
  } else {
    for (const sample of sampleTodos(alice.email)) pushTodo(db, alice.id, sample);
  }
  for (const sample of sampleTodos(bob.email)) pushTodo(db, bob.id, sample);
  return db;
}

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

let seeding = null; // 처음 만들 때 동시에 온 요청들이 시드를 한 번만 만들게 한다.

async function load() {
  const stored = readJson(STORAGE_KEY);
  if (stored) return stored;

  seeding ??= (async () => {
    const legacy = readJson(LEGACY_STORAGE_KEY);
    const db = await seed({ legacyTodos: Array.isArray(legacy?.todos) ? legacy.todos : null });
    save(db);
    try {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      // 지우지 못해도 v2가 있으면 다시 읽지 않는다.
    }
    return db;
  })().finally(() => {
    seeding = null;
  });
  return clone(await seeding);
}

function save(db) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch {
    // 사생활 보호 모드 등에서는 저장되지 않는다.
  }
}

// ---------- 개발자 도구 콘솔·테스트용 도우미 ----------
/** Mock 데이터를 지우고 테스트 사용자·예시 데이터로 되돌린다. (모든 Mock 로그인도 무효가 된다) */
export async function resetMockData() {
  save(await seed());
}

/** 화면 밖에서(다른 탭 등) 지워진 상황을 흉내 낸다. 화면은 아직 그 항목을 보여주고 있다. */
export async function removeMockTodo(id) {
  const db = await load();
  db.todos = db.todos.filter((todo) => todo.id !== Number(id));
  save(db);
}

/** 서버에서 모든 토큰이 만료된 상황을 흉내 낸다. 다음 인증 요청부터 401. */
export async function expireMockSessions() {
  const db = await load();
  db.tokens = {};
  save(db);
}

/** SMTP 대신: 해당 이메일로 "보낸" 인증코드를 돌려준다. 없으면 null. */
export async function getMockEmailCode(email) {
  const db = await load();
  return db.emailCodes?.[normalizeEmail(email)]?.code ?? null;
}

// ---------- 지연·실패 흉내 ----------
// 처리 중 상태와 실패 처리를 백엔드 없이 확인하기 위한 설정.
// 주소: ?mock=1&mockDelay=1500&mockFail=create,login&mockFailStatus=500&mockTokenTtl=30&mockCodeTtl=10&mockResendAfter=2
const settings = {
  delayMs: 150, fail: new Set(), failStatus: 500, tokenTtlSec: 3600,
  emailCodeTtlSec: 300, resendAfterSec: 60, verifiedTtlSec: 1800,
};

export function configureMock({ delayMs, fail, failStatus, tokenTtlSec, emailCodeTtlSec, resendAfterSec, verifiedTtlSec } = {}) {
  const number = (value) => (value === undefined || value === null || value === "" ? NaN : Number(value));
  if (Number.isFinite(number(delayMs)) && number(delayMs) >= 0) settings.delayMs = number(delayMs);
  if (fail !== undefined && fail !== null) {
    const names = Array.isArray(fail) ? fail : String(fail).split(",");
    settings.fail = new Set(names.map((name) => name.trim()).filter((name) => name === "all" || OPERATIONS.includes(name)));
  }
  if (Number.isInteger(number(failStatus)) && number(failStatus) >= 0) settings.failStatus = number(failStatus);
  if (Number.isFinite(number(tokenTtlSec)) && number(tokenTtlSec) > 0) settings.tokenTtlSec = number(tokenTtlSec);
  if (Number.isFinite(number(emailCodeTtlSec)) && number(emailCodeTtlSec) > 0) settings.emailCodeTtlSec = number(emailCodeTtlSec);
  if (Number.isFinite(number(resendAfterSec)) && number(resendAfterSec) >= 0) settings.resendAfterSec = number(resendAfterSec);
  if (Number.isFinite(number(verifiedTtlSec)) && number(verifiedTtlSec) > 0) settings.verifiedTtlSec = number(verifiedTtlSec);
  return { ...settings, fail: [...settings.fail] };
}

function operationOf(method, path, body) {
  if (path === "/auth/email-verification/send") return "emailSend";
  if (path === "/auth/email-verification/verify") return "emailVerify";
  if (path === "/auth/signup") return "signup";
  if (path === "/auth/login") return "login";
  if (path === "/me") return "me";
  const withId = /^\/todos\/[^/]+\/?$/.test(path);
  if (method === "GET") return withId ? "get" : "list";
  if (method === "POST") return "create";
  if (method === "DELETE") return "delete";
  if (method === "PATCH") {
    const keys = body && typeof body === "object" ? Object.keys(body) : [];
    return keys.length === 1 && keys[0] === "is_completed" ? "toggle" : "update";
  }
  return null;
}

function injectedFailure() {
  if (settings.failStatus === 0) return { status: 0, body: null, networkError: new TypeError("Mock: 네트워크 오류") };
  if (settings.failStatus === 401) return unauthorized("Mock: 일부러 실패시킨 인증 요청입니다.");
  if (settings.failStatus === 404) return notFound();
  if (settings.failStatus >= 500) return { status: settings.failStatus, body: "Internal Server Error" };
  return { status: settings.failStatus, body: { detail: "Mock: 일부러 실패시킨 요청입니다." } };
}

// ---------- 응답 형식 ----------
// FastAPI의 422 응답 형식: { detail: [{ type, loc, msg, input }] }
function validationError(errors) {
  return {
    status: 422,
    body: { detail: errors.map(({ loc, msg, type, input }) => ({ type, loc, msg, input })) },
  };
}

function notFound() {
  return { status: 404, body: { detail: "할 일을 찾을 수 없습니다." } };
}

function forbidden() {
  return { status: 403, body: { detail: "Not enough permissions" } };
}

function unauthorized(detail) {
  return { status: 401, body: { detail }, headers: { "WWW-Authenticate": "Bearer" } };
}

const publicUser = ({ id, email, created_at }) => ({ id, email, created_at });
// 소유자 ID는 응답에 내보내지 않는다. (API.md: 소유자는 서버가 토큰으로 정한다)
const publicTodo = ({ owner_id, ...todo }) => todo;

// ---------- 인증 ----------
function validateEmailField(input) {
  const email = input?.email;
  const error = (msg, type) => [{ loc: ["body", "email"], msg, type, input: email }];
  if (typeof email !== "string" || email.trim() === "") return error("이메일은 필수입니다.", "missing");
  if (!EMAIL_PATTERN.test(email.trim())) return error("올바른 이메일 형식이 아닙니다", "value_error");
  if (charCount(email.trim()) > 254) return error("이메일은 254자 이하여야 합니다.", "string_too_long");
  return [];
}

function isRegistered(db, email) {
  return db.users.some((user) => user.email === email);
}

const emailTaken = () => ({ status: 409, body: { detail: "이미 가입된 이메일입니다." } });

/** 인증코드 발송. 실제 서버라면 SMTP로 보내고 Redis에 TTL과 함께 저장하는 자리. */
function sendEmailCode(db, body) {
  const errors = validateEmailField(body);
  if (errors.length) return validationError(errors);
  const email = normalizeEmail(body.email);
  if (isRegistered(db, email)) return emailTaken();

  db.emailCodes ??= {};
  const previous = db.emailCodes[email];
  if (previous && Date.now() < previous.resendAt) {
    return { status: 429, body: { detail: "인증코드를 방금 보냈습니다. 잠시 후 다시 요청해 주세요." } };
  }
  db.emailCodes[email] = {
    code: String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0"),
    expiresAt: Date.now() + settings.emailCodeTtlSec * 1000,
    resendAt: Date.now() + settings.resendAfterSec * 1000,
    attempts: 0,
  };
  save(db);
  return { status: 200, body: { expires_in: settings.emailCodeTtlSec, resend_after: settings.resendAfterSec } };
}

function verifyEmailCode(db, body) {
  const errors = validateEmailField(body);
  if (typeof body?.code !== "string" || !CODE_PATTERN.test(body.code)) {
    errors.push({ loc: ["body", "code"], msg: "인증코드는 숫자 6자리입니다.", type: "string_pattern_mismatch", input: "[hidden]" });
  }
  if (errors.length) return validationError(errors);

  const email = normalizeEmail(body.email);
  db.emailCodes ??= {};
  const entry = db.emailCodes[email];
  if (!entry || Date.now() >= entry.expiresAt) {
    delete db.emailCodes[email];
    save(db);
    return { status: 400, body: { detail: "인증코드가 만료되었습니다. 다시 요청해 주세요." } };
  }
  if (entry.code !== body.code) {
    entry.attempts += 1;
    if (entry.attempts >= MAX_CODE_ATTEMPTS) {
      delete db.emailCodes[email];
      save(db);
      return { status: 429, body: { detail: "시도 횟수를 넘었습니다. 인증코드를 다시 요청해 주세요." } };
    }
    save(db);
    return { status: 400, body: { detail: "인증코드가 올바르지 않습니다." } };
  }
  delete db.emailCodes[email];
  db.verifiedEmails ??= {};
  db.verifiedEmails[email] = Date.now() + settings.verifiedTtlSec * 1000;
  save(db);
  return { status: 200, body: { verified: true, expires_in: settings.verifiedTtlSec } };
}

function signup(db, body, passwordHash) {
  const errors = validateEmailField(body);
  const password = body?.password;
  const passwordError = (msg, type) => errors.push({ loc: ["body", "password"], msg, type, input: "[hidden]" });
  if (typeof password !== "string" || password === "") passwordError("비밀번호는 필수입니다.", "missing");
  else if (charCount(password) < 8) passwordError("비밀번호는 8자 이상이어야 합니다.", "string_too_short");
  else if (charCount(password) > 64) passwordError("비밀번호는 64자 이하여야 합니다.", "string_too_long");
  if (errors.length) return validationError(errors);

  const email = normalizeEmail(body.email);
  if (isRegistered(db, email)) return emailTaken();
  const verifiedUntil = db.verifiedEmails?.[email];
  if (!verifiedUntil || Date.now() >= verifiedUntil) {
    return { status: 403, body: { detail: "이메일 인증이 필요합니다." } };
  }
  delete db.verifiedEmails[email];
  const user = { id: db.nextUserId++, email, password_hash: passwordHash, created_at: nowIso() };
  db.users.push(user);
  save(db);
  return { status: 201, body: publicUser(user) };
}

/** OAuth2 Password 방식: form의 username(=이메일)·password. FastAPI OAuth2PasswordRequestForm과 같이 필수값만 검사한다. */
function login(db, form, passwordHash) {
  const missing = ["username", "password"].filter((name) => !form?.[name]);
  if (missing.length) {
    return validationError(missing.map((name) => ({ loc: ["body", name], msg: "Field required", type: "missing", input: null })));
  }
  const user = db.users.find((candidate) => candidate.email === normalizeEmail(form.username));
  // 이메일이 없는 경우와 비밀번호가 틀린 경우를 같은 문구로 답한다. (어느 쪽이 틀렸는지 알려주지 않음)
  if (!user || user.password_hash !== passwordHash) {
    return { status: 401, body: { detail: "이메일 또는 비밀번호가 올바르지 않습니다." } };
  }
  const token = newToken();
  db.tokens[token] = { userId: user.id, expiresAt: Date.now() + settings.tokenTtlSec * 1000 };
  save(db);
  return { status: 200, body: { access_token: token, token_type: "bearer", expires_in: settings.tokenTtlSec } };
}

/** Authorization: Bearer <token> 을 확인한다. 없거나·모르거나·만료되면 401. */
function authenticate(db, headers) {
  const header = headers?.Authorization ?? headers?.authorization ?? "";
  const match = /^Bearer\s+(\S+)$/.exec(header);
  if (!match) return { error: unauthorized("Not authenticated") };
  const entry = db.tokens[match[1]];
  if (!entry) return { error: unauthorized("Could not validate credentials") };
  if (Date.now() >= entry.expiresAt) {
    delete db.tokens[match[1]];
    save(db);
    return { error: unauthorized("Token has expired") };
  }
  const user = db.users.find((candidate) => candidate.id === entry.userId);
  if (!user) return { error: unauthorized("Could not validate credentials") };
  return { user };
}

// ---------- 할 일 ----------
function validateTodoBody(input, { partial }) {
  const errors = [];
  const values = {};
  const err = (field, msg, type, value) => errors.push({ loc: ["body", field], msg, type, input: value });

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { errors: [{ loc: ["body"], msg: "요청 본문은 JSON 객체여야 합니다.", type: "model_type", input }], values };
  }

  if (!partial || "title" in input) {
    const title = input.title;
    if (title === undefined) err("title", "제목은 필수입니다.", "missing", title);
    else if (typeof title !== "string") err("title", "제목은 문자열이어야 합니다.", "string_type", title);
    else {
      // 앞뒤 공백 제거 후 1~100자, 내부 공백은 길이에 포함
      const trimmed = title.trim();
      if (charCount(trimmed) < 1) err("title", "제목은 앞뒤 공백을 제거한 뒤 1자 이상이어야 합니다.", "string_too_short", title);
      else if (charCount(trimmed) > 100) err("title", "제목은 앞뒤 공백을 제거한 뒤 100자 이하여야 합니다.", "string_too_long", title);
      else values.title = trimmed;
    }
  }

  if ("description" in input) {
    const description = input.description;
    if (description === null || description === "") values.description = null;
    else if (typeof description !== "string") err("description", "설명은 문자열이어야 합니다.", "string_type", description);
    else if (charCount(description) > 2000) err("description", "설명은 2000자 이하여야 합니다.", "string_too_long", description);
    else values.description = description;
  } else if (!partial) {
    values.description = null;
  }

  if ("due_date" in input) {
    const dueDate = input.due_date;
    if (dueDate === null || dueDate === "") values.due_date = null;
    else if (!isValidYmd(dueDate)) err("due_date", "올바른 날짜(YYYY-MM-DD)가 아닙니다.", "date_from_datetime_parsing", dueDate);
    else values.due_date = dueDate;
  } else if (!partial) {
    values.due_date = null;
  }

  if (partial && "is_completed" in input) {
    if (typeof input.is_completed !== "boolean") {
      err("is_completed", "완료 여부는 true 또는 false여야 합니다.", "bool_type", input.is_completed);
    } else {
      values.is_completed = input.is_completed;
    }
  }
  return { errors, values };
}

function parseIntParam(query, name, fallback, min, max) {
  const raw = query?.[name];
  if (raw === undefined || raw === null || raw === "") return { value: fallback };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    return { error: { loc: ["query", name], msg: `${min} 이상 ${max} 이하의 정수여야 합니다.`, type: "int_parsing", input: raw } };
  }
  return { value };
}

function listTodos(db, user, query) {
  const errors = [];
  const status = query?.status ?? "all";
  const sort = query?.sort ?? "latest";
  if (!STATUS_VALUES.includes(status)) {
    errors.push({ loc: ["query", "status"], msg: `${STATUS_VALUES.join(", ")} 중 하나여야 합니다.`, type: "enum", input: status });
  }
  if (!SORT_VALUES.includes(sort)) {
    errors.push({ loc: ["query", "sort"], msg: `${SORT_VALUES.join(", ")} 중 하나여야 합니다.`, type: "enum", input: sort });
  }
  const page = parseIntParam(query, "page", 1, 1, Number.MAX_SAFE_INTEGER);
  const size = parseIntParam(query, "size", 10, 1, 100);
  if (page.error) errors.push(page.error);
  if (size.error) errors.push(size.error);
  if (errors.length) return validationError(errors);

  let items = db.todos.filter((todo) => {
    if (todo.owner_id !== user.id) return false; // 내 할 일만
    if (status === "active") return !todo.is_completed;
    if (status === "completed") return todo.is_completed;
    return true;
  });

  const latestFirst = (a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id;
  items.sort((a, b) => {
    if (sort === "due_date") {
      // 마감일 빠른 순, 마감일 없는 항목은 맨 뒤. 같으면 최신순.
      if (a.due_date !== b.due_date) {
        if (a.due_date === null) return 1;
        if (b.due_date === null) return -1;
        return a.due_date.localeCompare(b.due_date);
      }
    }
    return latestFirst(a, b);
  });

  const total = items.length;
  const start = (page.value - 1) * size.value;
  items = items.slice(start, start + size.value).map(publicTodo);
  return { status: 200, body: { items, total, page: page.value, size: size.value } };
}

function createTodo(db, user, body) {
  const { errors, values } = validateTodoBody(body, { partial: false });
  // 소유자는 토큰으로 정하므로 owner_id·user_id 등 정해진 필드 밖의 값은 422로 거절한다. (Pydantic extra="forbid")
  if (body && typeof body === "object" && !Array.isArray(body)) {
    for (const name of Object.keys(body).filter((key) => !CREATE_FIELDS.includes(key))) {
      errors.push({ loc: ["body", name], msg: "Extra inputs are not permitted", type: "extra_forbidden", input: body[name] });
    }
  }
  if (errors.length) return validationError(errors);
  const time = nowIso();
  const todo = {
    id: db.nextId++,
    owner_id: user.id, // 요청 본문이 아니라 로그인한 사용자로 정한다.
    title: values.title,
    description: values.description,
    is_completed: false,
    due_date: values.due_date,
    created_at: time,
    updated_at: time,
    completed_at: null,
  };
  db.todos.push(todo);
  save(db);
  return { status: 201, body: publicTodo(todo) };
}

function updateTodo(db, todo, body) {
  const { errors, values } = validateTodoBody(body, { partial: true });
  if (errors.length) return validationError(errors);

  if ("is_completed" in values && values.is_completed !== todo.is_completed) {
    todo.completed_at = values.is_completed ? nowIso() : null;
  }
  Object.assign(todo, values);
  todo.updated_at = nowIso();
  save(db);
  return { status: 200, body: publicTodo(todo) };
}

async function route(method, path, query, body, headers, form) {
  // 해시는 DB를 읽기 전에 계산한다. (읽고 → 기다리고 → 저장하는 사이에 다른 요청의 변경을 덮어쓰지 않게)
  const password = path === "/auth/login" ? form?.password : path === "/auth/signup" ? body?.password : null;
  const passwordHash = typeof password === "string" ? await hashPassword(password) : null;
  const db = await load();
  const publicRoutes = {
    "/auth/email-verification/send": () => sendEmailCode(db, body),
    "/auth/email-verification/verify": () => verifyEmailCode(db, body),
    "/auth/signup": () => signup(db, body, passwordHash),
    "/auth/login": () => login(db, form, passwordHash),
  };
  if (publicRoutes[path]) return method === "POST" ? publicRoutes[path]() : { status: 405, body: { detail: "Method Not Allowed" } };

  const match = path.match(/^\/todos(?:\/([^/]+))?\/?$/);
  if (path !== "/me" && !match) return { status: 404, body: { detail: "Not Found" } };

  const { user, error } = authenticate(db, headers);
  if (error) return error;

  if (path === "/me") return method === "GET" ? { status: 200, body: publicUser(user) } : { status: 405, body: { detail: "Method Not Allowed" } };

  if (match[1] === undefined) {
    if (method === "GET") return listTodos(db, user, query);
    if (method === "POST") return createTodo(db, user, body);
    return { status: 405, body: { detail: "Method Not Allowed" } };
  }

  const id = Number(decodeURIComponent(match[1]));
  if (!Number.isInteger(id)) {
    return validationError([{ loc: ["path", "todo_id"], msg: "정수여야 합니다.", type: "int_parsing", input: match[1] }]);
  }
  const index = db.todos.findIndex((todo) => todo.id === id);
  if (index === -1) return notFound();
  const todo = db.todos[index];
  if (todo.owner_id !== user.id) return forbidden(); // 다른 사용자의 할 일

  if (method === "GET") return { status: 200, body: publicTodo(todo) };
  if (method === "PATCH") return updateTodo(db, todo, body);
  if (method === "DELETE") {
    db.todos.splice(index, 1);
    save(db);
    return { status: 204, body: null };
  }
  return { status: 405, body: { detail: "Method Not Allowed" } };
}

export async function mockTransport({ method, path, query, body, form, headers }) {
  await delay(settings.delayMs);
  const operation = operationOf(method, path, body);
  if (settings.fail.has("all") || settings.fail.has(operation)) {
    console.warn(`[StepTodo] Mock: ${operation} 요청을 일부러 실패시킵니다. (status ${settings.failStatus})`);
    return injectedFailure();
  }
  const res = await route(method, path, query, body === undefined ? undefined : clone(body), headers, form);
  return { status: res.status, body: res.body === null ? null : clone(res.body) };
}
