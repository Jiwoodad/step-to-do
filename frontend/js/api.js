// API 호출을 한곳에 모아둔 모듈. 엔드포인트가 바뀌면 이 파일만 고치면 된다.
// 실제 서버(fetch)와 가짜 서버(mock) 모두 { status, body } 형태로 응답하고,
// 오류 해석·인증 헤더·401 처리·이전 세션 응답 버리기는 아래 request()에서 같은 코드로 처리한다.
import { mockTransport } from "./mock-api.js";

export const FIELD_LABELS = {
  title: "제목",
  description: "설명",
  due_date: "마감일",
  is_completed: "완료 여부",
  email: "이메일",
  username: "이메일", // OAuth2 로그인 form의 username = 이메일
  password: "비밀번호",
  code: "인증코드",
  status: "필터",
  sort: "정렬",
  page: "페이지",
  size: "페이지 크기",
  todo_id: "할 일 ID",
};

export class ApiError extends Error {
  constructor(message, { status = 0, fieldErrors = {}, requestId = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status; // 0이면 서버에 닿지 못한 경우(네트워크·CORS 오류)
    this.fieldErrors = fieldErrors; // { title: ["..."], due_date: ["..."] }
    this.requestId = requestId;
  }
}

function newRequestId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

/** 끝나지 않는 Promise. 이전 세션의 응답을 받은 호출부가 아무것도 하지 않게 만든다. */
const never = () => new Promise(() => {});

// 콘솔에 응답 본문을 남길 때 비밀번호·토큰을 가린다.
// FastAPI 422의 `input`에는 사용자가 보낸 값(비밀번호 포함)이 그대로 들어 있으므로 항상 가린다.
const SECRET_KEY = /pass(word)?|token|secret|authorization|^code$/i;
export function redactForLog(value) {
  if (Array.isArray(value)) return value.map(redactForLog);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, SECRET_KEY.test(key) || key === "input" ? "[redacted]" : redactForLog(v)]),
    );
  }
  return value;
}

function createFetchTransport(baseUrl) {
  const base = baseUrl.replace(/\/+$/, "");
  return async ({ method, path, query, body, form, headers, signal }) => {
    const url = new URL(base + path, window.location.href);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, value);
    }

    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Accept: "application/json",
          ...(body !== undefined && { "Content-Type": "application/json" }),
          ...(form !== undefined && { "Content-Type": "application/x-www-form-urlencoded" }),
          ...headers,
        },
        body: form !== undefined ? new URLSearchParams(form).toString() : body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (networkError) {
      return { status: 0, body: null, networkError, aborted: networkError?.name === "AbortError" };
    }

    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text; // 예: 처리 안 된 예외에서 나오는 "Internal Server Error"
      }
    }
    return { status: res.status, body: data };
  };
}

function defaultMessage(status) {
  if (status === 400) return "잘못된 요청입니다.";
  if (status === 401) return "로그인이 필요해요.";
  if (status === 403) return "이 작업을 할 권한이 없어요.";
  if (status === 404) return "요청한 할 일을 찾을 수 없습니다. 이미 삭제되었을 수 있어요.";
  if (status === 405) return "지원하지 않는 요청 방식입니다.";
  if (status === 409) return "이미 사용 중인 정보예요.";
  if (status === 422) return "입력값을 확인해 주세요.";
  if (status === 429) return "요청이 너무 많아요. 잠시 후 다시 시도해 주세요.";
  if (status >= 500) return `서버 오류가 발생했습니다. (${status})`;
  return `요청을 처리하지 못했습니다. (${status})`;
}

/**
 * FastAPI 오류 응답을 화면용 메시지로 바꾼다.
 * - HTTPException:     { "detail": "Todo not found" }
 * - 요청 검증 실패(422): { "detail": [{ "loc": ["body", "title"], "msg": "...", "type": "..." }] }
 * - 직접 만든 형식:     { "detail": { "message": "..." } } 또는 { "message": "..." }
 * `input`(보낸 값)은 화면에 쓰지 않는다.
 */
function toErrorInfo(status, body) {
  const fieldErrors = {};
  let message = null;
  const detail = body && typeof body === "object" ? (body.detail ?? body.message ?? body.error) : null;

  if (Array.isArray(detail)) {
    const lines = [];
    for (const item of detail) {
      const loc = Array.isArray(item?.loc) ? item.loc.map(String) : [];
      const msg = typeof item?.msg === "string" ? item.msg : "입력값을 확인해 주세요.";
      const name = loc.length > 1 ? loc[loc.length - 1] : null;
      if (name && loc[0] === "body") (fieldErrors[name] ??= []).push(msg);
      lines.push(name ? `${FIELD_LABELS[name] ?? name}: ${msg}` : msg);
    }
    message = lines.join("\n") || null;
  } else if (typeof detail === "string") {
    message = detail;
  } else if (detail && typeof detail.message === "string") {
    message = detail.message;
  }

  if (status >= 500 || !message) message = defaultMessage(status);
  // 403은 항상 권한 안내로 시작한다. 서버 문구(예: "Not enough permissions")는 괄호로 덧붙인다.
  else if (status === 403 && message !== defaultMessage(403)) message = `${defaultMessage(403)} (${message})`;
  return { message, fieldErrors };
}

// 성공 응답이 API.md의 계약과 맞는지 가볍게 확인한다. 실제 백엔드를 처음 붙일 때 원인을 바로 찾기 위함.
const isTodo = (data) =>
  Boolean(data) && typeof data === "object" && data.id !== undefined && data.id !== null &&
  typeof data.title === "string" && typeof data.is_completed === "boolean";
const isTodoPage = (data) =>
  Boolean(data) && Array.isArray(data.items) && Number.isInteger(data.total) && data.items.every(isTodo);
const isUser = (data) =>
  Boolean(data) && typeof data === "object" && data.id !== undefined && data.id !== null && typeof data.email === "string";
const isTokenResponse = (data) =>
  Boolean(data) && typeof data.access_token === "string" && data.access_token.length > 0 &&
  (data.token_type === undefined || String(data.token_type).toLowerCase() === "bearer");

const isCodeSent = (data) => Boolean(data) && Number.isFinite(data.expires_in);
const isCodeVerified = (data) => Boolean(data) && data.verified === true;

const TODO_SHAPE = "{ id, title, is_completed, ... } 형식의 할 일";
const PAGE_SHAPE = "{ items, total, page, size } 형식의 목록";
const USER_SHAPE = "{ id, email, name, ... } 형식의 사용자";
const TOKEN_SHAPE = "{ access_token, token_type: \"bearer\", expires_in } 형식의 토큰";
const CODE_SENT_SHAPE = "{ expires_in, resend_after } 형식의 응답";
const CODE_VERIFIED_SHAPE = "{ verified: true, expires_in } 형식의 응답";

/**
 * @param {object} options
 * @param {ReturnType<import("./session.js").createSession>} options.session
 * @param {() => void} options.onUnauthorized 인증이 필요한 요청이 401을 받았을 때 (한 세션에 한 번)
 */
export function createApi({ apiBaseUrl = "/api", useMock = false, session, onUnauthorized = () => {} } = {}) {
  const transport = useMock ? mockTransport : createFetchTransport(apiBaseUrl);

  async function request(method, path, { query, body, form, auth = true, expect, expected } = {}) {
    // 요청마다 ID를 붙여 보낸다. 백엔드가 이 값을 로그에 남기면 화면의 오류와 서버 로그를 짝지을 수 있다.
    const requestId = newRequestId();
    const epoch = session.epoch;
    const headers = { "X-Request-ID": requestId };
    if (auth) {
      if (!session.accessToken) {
        onUnauthorized();
        return never();
      }
      headers.Authorization = `Bearer ${session.accessToken}`;
    }

    const controller = new AbortController();
    const untrack = session.track(controller);
    let res;
    try {
      res = await transport({ method, path, query, body, form, headers, signal: controller.signal });
    } finally {
      untrack();
    }

    // 그 사이 로그아웃·다른 사용자 로그인·만료 처리가 있었다면, 이전 세션의 응답은 화면에 반영하지 않는다.
    if (epoch !== session.epoch || res.aborted) return never();

    if (res.status === 0) {
      console.error(`[StepTodo] ${method} ${path} → 연결 실패 (request id: ${requestId})`, res.networkError);
      throw new ApiError(
        "API 서버에 연결할 수 없습니다. 서버가 켜져 있는지, config.js의 주소와 CORS 설정이 맞는지 확인해 주세요.",
        { status: 0, requestId },
      );
    }
    if (auth && res.status === 401) {
      // 토큰 없음·만료·무효. 호출부는 결과를 받지 않고, 앱이 세션을 정리하고 다시 로그인하게 한다.
      console.warn(`[StepTodo] ${method} ${path} → 401 인증 실패 또는 만료 (request id: ${requestId})`);
      onUnauthorized();
      return never();
    }
    if (res.status >= 200 && res.status < 300) {
      if (expect && !expect(res.body)) {
        console.error(`[StepTodo] ${method} ${path} → ${res.status} 응답이 API 계약과 다릅니다. 기대: ${expected} (request id: ${requestId})`, redactForLog(res.body));
        throw new ApiError(`서버 응답 형식이 예상과 다릅니다. (${method} ${path}: ${expected}이 필요해요)`, { status: res.status, requestId });
      }
      return res.body;
    }

    const { message, fieldErrors } = toErrorInfo(res.status, res.body);
    console.error(`[StepTodo] ${method} ${path} → ${res.status} (request id: ${requestId})`, redactForLog(res.body));
    throw new ApiError(message, { status: res.status, fieldErrors, requestId });
  }

  const todoPath = (id) => `/todos/${encodeURIComponent(id)}`;

  return {
    useMock,

    // ---------- 인증 (로그인 전에도 부르는 요청은 auth: false) ----------
    /** 이메일로 인증코드를 보낸다. 가입 전에 호출한다. */
    sendEmailCode: ({ email }) =>
      request("POST", "/auth/email-verification/send", { auth: false, body: { email }, expect: isCodeSent, expected: CODE_SENT_SHAPE }),
    verifyEmailCode: ({ email, code }) =>
      request("POST", "/auth/email-verification/verify", { auth: false, body: { email, code }, expect: isCodeVerified, expected: CODE_VERIFIED_SHAPE }),
    signup: ({ email, password, name }) =>
      request("POST", "/auth/signup", { auth: false, body: { email, password, name }, expect: isUser, expected: USER_SHAPE }),
    /** OAuth2 Password 방식: application/x-www-form-urlencoded로 username(=이메일)·password를 보낸다. */
    login: ({ email, password }) =>
      request("POST", "/auth/login", { auth: false, form: { grant_type: "password", username: email, password }, expect: isTokenResponse, expected: TOKEN_SHAPE }),
    me: () => request("GET", "/me", { expect: isUser, expected: USER_SHAPE }),

    // ---------- 할 일 (모두 로그인 필요. 소유자는 서버가 토큰으로 정한다) ----------
    /** @returns {{ items: Todo[], total: number, page: number, size: number }} */
    listTodos: ({ status, sort, page, size }) =>
      request("GET", "/todos", { query: { status, sort, page, size }, expect: isTodoPage, expected: PAGE_SHAPE }),
    getTodo: (id) => request("GET", todoPath(id), { expect: isTodo, expected: TODO_SHAPE }),
    createTodo: ({ title, description, due_date }) =>
      request("POST", "/todos", { body: { title, description, due_date }, expect: isTodo, expected: TODO_SHAPE }),
    updateTodo: (id, changes) =>
      request("PATCH", todoPath(id), { body: changes, expect: isTodo, expected: TODO_SHAPE }),
    setCompleted: (id, isCompleted) =>
      request("PATCH", todoPath(id), { body: { is_completed: isCompleted }, expect: isTodo, expected: TODO_SHAPE }),
    deleteTodo: (id) => request("DELETE", todoPath(id)),
  };
}
