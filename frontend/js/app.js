import { ApiError, createApi } from "./api.js";
import { configureMock, expireMockSessions, getMockEmailCode, MOCK_TEST_USERS, removeMockTodo, resetMockData } from "./mock-api.js";
import { createSession } from "./session.js";
import { dueInfo, formatDate, formatDateTime, isOverdue, isValidYmd, todayKST } from "./date.js";
import {
  charCount, clearToasts, el, errorMessage, isFormBusy, resetForm, scrubSecret, setAriaDisabled, setFormBusy,
  setupForm, showFieldErrors, showFormError, showModal, toast, updateCounters,
} from "./ui.js";

const TITLE_MAX = 100;
const DESCRIPTION_MAX = 2000;
const EMAIL_MAX = 254;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 64;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_PATTERN = /^\d{6}$/;
const STATUS_VALUES = ["all", "active", "completed"];
const SORT_VALUES = ["latest", "due_date"];
const SIZE_VALUES = [5, 10, 20];
const DEFAULT_QUERY = { status: "all", sort: "latest", page: 1, size: 10 };
const NO_TODOS_MESSAGE = "아직 할 일이 없어요. 위에서 첫 할 일을 추가해 보세요.";
const EMPTY_FILTER_MESSAGES = {
  all: NO_TODOS_MESSAGE,
  active: "미완료 할 일이 없어요. 모두 끝냈어요! 🎉",
  completed: "완료한 할 일이 아직 없어요.",
};
const AUTH_NOTICES = {
  expired: { text: "로그인이 만료되었거나 유효하지 않아요. 다시 로그인해 주세요.", tone: "warning" },
  loggedOut: { text: "로그아웃했어요.", tone: "info" },
  signedUp: { text: "회원가입이 완료되었어요. 가입한 이메일로 로그인해 주세요.", tone: "success" },
};
const UNAVAILABLE_TEXT = {
  403: { title: "이 할 일을 볼 권한이 없어요", message: "다른 사용자의 할 일이에요. 목록을 새로 불러올게요." },
  404: { title: "할 일을 찾을 수 없어요", message: "이미 삭제되었거나 다른 곳에서 바뀌었을 수 있어요. 목록을 새로 불러올게요." },
};
const EMAIL_FORMAT_MESSAGE = "올바른 이메일 형식이 아닙니다";
const EMAIL_TAKEN_MESSAGE = "이미 가입된 이메일이에요. 로그인하거나 다른 이메일을 사용해 주세요.";
const SERVER_FIELD_ALIASES = { username: "email" }; // OAuth2 로그인 form의 username = 이메일
const SLOW_LOADING_MS = 250; // 이보다 빨리 끝나는 재조회는 "불러오는 중" 문구를 띄우지 않는다.

// ---------- 설정 ----------
const config = window.STEPTODO_CONFIG ?? {};
const initialParams = new URLSearchParams(location.search);
// ?mock=1 은 로컬 개발 주소에서만 받는다. 배포 화면은 config.js의 useMock만 따른다.
const isLocalHost = ["localhost", "127.0.0.1", "[::1]", ""].includes(location.hostname);
const useMock = isLocalHost && initialParams.has("mock") ? initialParams.get("mock") !== "0" : Boolean(config.useMock);
const session = createSession();
const api = createApi({ apiBaseUrl: config.apiBaseUrl ?? "/api", useMock, session, onUnauthorized: handleUnauthorized });

const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
const positiveInt = (value, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
};
const isNotFound = (err) => err instanceof ApiError && err.status === 404;
const isUnavailable = (err) => err instanceof ApiError && (err.status === 403 || err.status === 404); // 없는 항목 또는 남의 항목

// 필터·정렬·페이지는 주소창에도 남겨서 새로고침해도 유지되게 한다. (같은 탭에서 로그인이 복원될 때)
const state = {
  user: null, // 로그인한 사용자 { id, email }
  status: pick(initialParams.get("status"), STATUS_VALUES, DEFAULT_QUERY.status),
  sort: pick(initialParams.get("sort"), SORT_VALUES, DEFAULT_QUERY.sort),
  page: positiveInt(initialParams.get("page"), DEFAULT_QUERY.page),
  size: pick(Number(initialParams.get("size")), SIZE_VALUES, DEFAULT_QUERY.size),
  total: 0,
  items: [],
  loaded: false, // 첫 목록 응답을 받았는지
  loadFailed: false,
  hasAnyTodo: true, // 필터와 상관없이 할 일이 하나라도 있는지 (빈 화면 안내 구분용)
  detail: null, // 상세 창에 열려 있는 할 일
};
// 회원가입 이메일 인증 진행 상태. status: idle → sending → sent → verifying → verified
const verification = { status: "idle", email: "", expiresAt: 0, resendAt: 0, seq: 0, timer: null };
const pending = new Map(); // 할 일 id → "toggle" | "delete" (요청이 끝날 때까지 같은 항목의 중복 요청을 막는다)
let listRequestSeq = 0;
let loadingTimer = null;
let detailReturn = null; // 상세 창을 닫으면 포커스를 돌려줄 목록 위치 { id, index }
let detailIsOpen = false;
let confirmSeq = 0;
let booting = false;

// ---------- DOM ----------
const $ = (selector, root = document) => root.querySelector(selector);
const els = {
  mockBadge: $("#mock-badge"),
  userBar: $("#user-bar"),
  userEmail: $("#user-email"),
  logoutButton: $("#logout-button"),
  bootView: $("#boot-view"),
  bootMessage: $("#boot-message"),
  bootActions: $("#boot-actions"),
  bootRetry: $("#boot-retry"),
  bootRelogin: $("#boot-relogin"),
  authView: $("#auth-view"),
  authHeading: $("#auth-heading"),
  authNotice: $("#auth-notice"),
  loginForm: $("#login-form"),
  signupForm: $("#signup-form"),
  mockAccounts: $("#mock-accounts"),
  mockMailbox: $("#mock-mailbox"),
  emailCodeSend: $("#email-code-send"),
  emailCodeField: $("#email-code-field"),
  emailCodeTimer: $("#email-code-timer"),
  emailCodeVerify: $("#email-code-verify"),
  emailVerified: $("#email-verified"),
  emailChange: $("#email-change"),
  todoView: $("#todo-view"),
  createForm: $("#create-form"),
  statusButtons: document.querySelectorAll("[data-status]"),
  sortSelect: $("#sort-select"),
  sizeSelect: $("#size-select"),
  banner: $("#banner"),
  bannerMessage: $("#banner-message"),
  bannerRetry: $("#banner-retry"),
  bannerMockLink: $("#banner-mock-link"),
  summary: $("#list-summary"),
  listLoading: $("#list-loading"),
  list: $("#todo-list"),
  empty: $("#list-empty"),
  emptyMessage: $("#list-empty-message"),
  emptyReset: $("#list-empty-reset"),
  pagination: $("#pagination"),
  detailDialog: $("#detail-dialog"),
  detailView: $("#detail-view"),
  detailMissing: $("#detail-missing"),
  detailBack: $("#detail-back"),
  detailMissingTitle: $("#detail-missing-title"),
  detailMissingMessage: $("#detail-missing-message"),
  detailTitle: $("#detail-title"),
  detailBadges: $("#detail-badges"),
  detailDescription: $("#detail-description"),
  detailDue: $("#detail-due"),
  detailCreated: $("#detail-created"),
  detailUpdated: $("#detail-updated"),
  detailCompleted: $("#detail-completed"),
  detailToggle: $("#detail-toggle"),
  detailEdit: $("#detail-edit"),
  detailDelete: $("#detail-delete"),
  editForm: $("#edit-form"),
  editCancel: $("#edit-cancel"),
  confirmDialog: $("#confirm-dialog"),
  confirmMessage: $("#confirm-message"),
};

// ---------- 화면 전환 ----------
const VIEW_TITLES = { boot: "StepTodo", auth: "로그인 · StepTodo", todo: "StepTodo" };

/** boot(로그인 확인 중) · auth(로그인·회원가입) · todo(할 일). 할 일 화면은 로그인한 뒤에만 보인다. */
function showView(name) {
  els.bootView.hidden = name !== "boot";
  els.authView.hidden = name !== "auth";
  els.todoView.hidden = name !== "todo";
  els.userBar.hidden = name !== "todo";
  document.title = VIEW_TITLES[name];
}

// ---------- 세션 ----------
/** 새로고침했을 때: 이 탭에 저장된 토큰이 있으면 /me로 확인해서 로그인을 복원한다. */
async function boot() {
  if (booting) return; // "다시 시도" 연타 방지
  if (!session.hasToken()) return showAuth("login");
  if (session.isExpired()) {
    session.end();
    return showAuth("login", { notice: AUTH_NOTICES.expired });
  }

  showView("boot");
  els.bootMessage.textContent = "로그인 상태를 확인하는 중…";
  els.bootActions.hidden = true;
  booting = true;
  let user;
  try {
    user = await api.me(); // 401이면 handleUnauthorized가 로그인 화면으로 보낸다.
  } catch (err) {
    booting = false;
    // 서버에 닿지 못했거나 5xx: 토큰은 그대로 두고 다시 시도할 수 있게 한다.
    els.bootMessage.textContent = `로그인 상태를 확인하지 못했어요.\n${errorMessage(err)}`;
    els.bootActions.hidden = false;
    els.bootRetry.focus();
    return;
  }
  booting = false;
  enterApp(user);
}

function enterApp(user, { fresh = false, focus = false } = {}) {
  if (fresh) resetTodoState(); // 새로 로그인한 경우: 이전 사용자의 흔적(필터·페이지 포함)을 지우고 시작
  state.user = user;
  els.userEmail.textContent = user.email;
  els.userEmail.title = user.email;
  showView("todo");
  renderList();
  loadList();
  if (focus) els.createForm.elements.title.focus();
}

/** 로그아웃·만료: 토큰을 지우고, 이전 사용자의 목록·상세·입력·오류 상태를 모두 비운다. */
function endSession(notice) {
  session.end(); // 진행 중인 요청의 응답은 이제 화면에 반영되지 않는다.
  booting = false;
  state.user = null;
  els.userEmail.textContent = "";
  els.userEmail.title = "";
  resetTodoState();
  clearToasts();
  showAuth("login", { notice });
}

/** 인증이 필요한 요청이 401을 받았을 때 (api.js가 한 세션에 한 번 부른다). */
function handleUnauthorized() {
  endSession(AUTH_NOTICES.expired);
}

function resetTodoState() {
  Object.assign(state, DEFAULT_QUERY, {
    total: 0, items: [], loaded: false, loadFailed: false, hasAnyTodo: true, detail: null,
  });
  pending.clear();
  listRequestSeq += 1; // 아직 도착하지 않은 목록 응답은 버린다.
  clearTimeout(loadingTimer);
  setListLoading(false);

  // 열려 있던 창은 포커스를 돌려주지 않고 닫는다. (다음 화면이 포커스를 정한다)
  detailReturn = null;
  if (els.confirmDialog.open) els.confirmDialog.close("cancel");
  closeDetail();

  for (const form of [els.createForm, els.editForm]) resetForm(form);
  els.list.replaceChildren();
  els.pagination.replaceChildren();
  els.pagination.hidden = true;
  els.summary.textContent = "";
  els.empty.hidden = true;
  hideBanner();
  renderControls();
  syncUrl();
}

// ---------- 로그인 · 회원가입 ----------
function setAuthMode(mode) {
  els.loginForm.hidden = mode !== "login";
  els.signupForm.hidden = mode !== "signup";
  els.authHeading.textContent = mode === "login" ? "로그인" : "회원가입";
  VIEW_TITLES.auth = `${els.authHeading.textContent} · StepTodo`;
  document.title = VIEW_TITLES.auth;
}

function showAuthNotice(notice) {
  els.authNotice.hidden = !notice;
  els.authNotice.textContent = notice?.text ?? "";
  els.authNotice.className = `auth-notice${notice ? ` tone-${notice.tone}` : ""}`;
}

/** 로그인·회원가입 화면을 깨끗한 상태로 연다. 비밀번호 칸은 항상 비운다. */
function showAuth(mode, { notice = null, email = "" } = {}) {
  resetForm(els.loginForm);
  resetForm(els.signupForm);
  resetEmailVerification();
  setAuthMode(mode);
  showAuthNotice(notice);
  showView("auth");
  const form = mode === "login" ? els.loginForm : els.signupForm;
  form.elements.email.value = email;
  (email ? form.elements.password : form.elements.email).focus();
}

function switchAuthMode(mode) {
  // 입력하던 이메일은 옮기고, 비밀번호는 옮기지 않는다.
  const from = mode === "login" ? els.signupForm : els.loginForm;
  const email = from.elements.email.value.trim();
  showAuth(mode, { email });
  if (!email) (mode === "login" ? els.loginForm : els.signupForm).elements.email.focus();
}

function validateEmail(email) {
  if (!email) return "이메일을 입력해 주세요.";
  if (!EMAIL_PATTERN.test(email)) return EMAIL_FORMAT_MESSAGE;
  if (charCount(email) > EMAIL_MAX) return `이메일은 ${EMAIL_MAX}자 이하로 입력해 주세요.`;
  return null;
}

/** 오류 문구에는 비밀번호 값을 넣지 않는다. 길이만 알려준다. */
function validateAuthForm(form, { signup }) {
  const email = form.elements.email.value.trim();
  const password = form.elements.password.value; // 비밀번호는 공백도 그대로 쓴다(trim 안 함).
  const errors = {};
  const emailError = validateEmail(email);
  if (emailError) errors.email = [emailError];
  else if (signup && verification.status !== "verified") {
    const message = ["이메일 인증을 먼저 완료해 주세요."];
    if (els.emailCodeField.hidden) errors.email = message;
    else errors.code = message;
  }

  if (!password) errors.password = ["비밀번호를 입력해 주세요."];
  else if (signup && charCount(password) < PASSWORD_MIN) errors.password = [`비밀번호는 ${PASSWORD_MIN}자 이상이어야 해요. (지금 ${charCount(password)}자)`];
  else if (signup && charCount(password) > PASSWORD_MAX) errors.password = [`비밀번호는 ${PASSWORD_MAX}자 이하여야 해요. (지금 ${charCount(password)}자)`];

  if (signup) {
    // 비밀번호 확인은 화면에서만 검사하고 API에는 보내지 않는다.
    const confirm = form.elements.password_confirm.value;
    if (!confirm) errors.password_confirm = ["비밀번호를 한 번 더 입력해 주세요."];
    else if (!errors.password && confirm !== password) errors.password_confirm = ["비밀번호가 일치하지 않아요."];
  }
  return { email, password, errors };
}

/** 서버가 거절한 이유를 로그인·회원가입 폼 안에 보여준다. 비밀번호 값은 어떤 문구에도 넣지 않는다. */
function showAuthServerError(form, err, password, overrides = {}) {
  const fieldErrors = {};
  for (const [serverName, messages] of Object.entries(err instanceof ApiError ? err.fieldErrors : {})) {
    const name = SERVER_FIELD_ALIASES[serverName] ?? serverName;
    if (form.elements[name]) fieldErrors[name] = messages.map((message) => scrubSecret(message, password));
  }
  const override = err instanceof ApiError ? overrides[err.status] : null;
  if (override?.field) fieldErrors[override.field] = [override.message];
  showFieldErrors(form, fieldErrors);
  const hasFieldErrors = Object.keys(fieldErrors).length > 0;
  showFormError(form, override && !override.field ? override.message : hasFieldErrors ? null : scrubSecret(errorMessage(err), password));
}

async function handleLogin(event) {
  event.preventDefault();
  const form = els.loginForm;
  if (isFormBusy(form)) return; // 로그인 중 Enter·버튼 연타 방지
  showFormError(form, null);
  showAuthNotice(null);
  const { email, password, errors } = validateAuthForm(form, { signup: false });
  showFieldErrors(form, errors);
  if (Object.keys(errors).length) return;

  setFormBusy(form, true);
  let token;
  try {
    token = await api.login({ email, password });
  } catch (err) {
    setFormBusy(form, false);
    // 로그인 실패의 401은 세션 만료가 아니므로 이 화면 안에서 안내한다.
    showAuthServerError(form, err, password, { 401: { message: "이메일 또는 비밀번호가 올바르지 않아요." } });
    if (err instanceof ApiError && err.status === 401) {
      form.elements.password.value = "";
      form.elements.password.focus();
    }
    return;
  }

  session.start(token);
  let user;
  try {
    user = await api.me(); // 401이면 handleUnauthorized가 처리한다.
  } catch (err) {
    session.end();
    setFormBusy(form, false);
    showAuthServerError(form, err, password);
    return;
  }
  setFormBusy(form, false);
  enterApp(user, { fresh: true, focus: true });
}

async function handleSignup(event) {
  event.preventDefault();
  const form = els.signupForm;
  if (isFormBusy(form)) return;
  showFormError(form, null);
  showAuthNotice(null);
  const { email, password, errors } = validateAuthForm(form, { signup: true });
  showFieldErrors(form, errors);
  if (Object.keys(errors).length) return;

  setFormBusy(form, true);
  try {
    await api.signup({ email, password }); // password_confirm은 보내지 않는다.
  } catch (err) {
    setFormBusy(form, false);
    // 인증이 만료됐거나(403) 그 사이 같은 이메일이 가입됐으면(409) 이메일 인증부터 다시 한다.
    if (err instanceof ApiError && (err.status === 403 || err.status === 409)) resetEmailVerification();
    else renderEmailVerification();
    showAuthServerError(form, err, password, {
      403: { field: "email", message: "이메일 인증이 만료되었어요. 다시 인증해 주세요." },
      409: { field: "email", message: EMAIL_TAKEN_MESSAGE },
    });
    return;
  }
  setFormBusy(form, false);
  // 가입만 하고 자동 로그인은 하지 않는다. 로그인 화면으로 안내한다.
  showAuth("login", { notice: AUTH_NOTICES.signedUp, email });
}

// ---------- 회원가입 이메일 인증 ----------
/** 인증 진행 상태를 화면에 그린다. 다른 곳은 상태만 바꾸고 이 함수를 부른다. */
function renderEmailVerification() {
  const { status, resendAt, expiresAt } = verification;
  const form = els.signupForm;
  const busy = isFormBusy(form);
  const verified = status === "verified";
  const codeVisible = status === "sent" || status === "verifying";
  const resendWait = Math.ceil((resendAt - Date.now()) / 1000);

  form.elements.email.readOnly = busy || verified || status === "sending" || status === "verifying";
  els.emailVerified.hidden = !verified;
  els.emailCodeSend.hidden = verified;
  els.emailCodeField.hidden = !codeVisible;
  form.elements.code.readOnly = busy || status === "verifying";

  if (status === "sending") els.emailCodeSend.textContent = "보내는 중…";
  else if (!codeVisible) els.emailCodeSend.textContent = "인증코드 받기";
  else els.emailCodeSend.textContent = resendWait > 0 ? `다시 받기 (${resendWait}초)` : "다시 받기";
  setAriaDisabled(els.emailCodeSend, busy || status === "sending" || status === "verifying" || resendWait > 0);

  els.emailCodeVerify.textContent = status === "verifying" ? "확인 중…" : "확인";
  setAriaDisabled(els.emailCodeVerify, busy || status === "verifying");

  const left = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  els.emailCodeTimer.textContent = left > 0 ? `남은 시간 ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "만료됨";
}

function stopVerificationTimer() {
  clearInterval(verification.timer);
  verification.timer = null;
}

function resetEmailVerification() {
  stopVerificationTimer();
  verification.seq += 1; // 진행 중인 발송·확인 응답은 버린다.
  Object.assign(verification, { status: "idle", email: "", expiresAt: 0, resendAt: 0 });
  els.signupForm.elements.code.value = "";
  els.mockMailbox.hidden = true;
  els.mockMailbox.textContent = "";
  renderEmailVerification();
}

function startVerificationTimer() {
  stopVerificationTimer();
  verification.timer = setInterval(() => {
    renderEmailVerification();
    if (Date.now() >= verification.expiresAt) {
      stopVerificationTimer();
      showFieldErrors(els.signupForm, { code: ["인증코드가 만료되었어요. 다시 받아 주세요."] }, { focus: false });
    }
  }, 1000);
}

/** Mock에는 메일 서버가 없으므로 "보낸" 코드를 화면에 보여준다. 실제 API에서는 나타나지 않는다. */
async function showMockMailbox(email) {
  if (!useMock) return;
  const code = await getMockEmailCode(email);
  if (verification.status !== "sent" || verification.email !== email) return;
  els.mockMailbox.textContent = `Mock 메일함 (실제 메일은 보내지 않아요)\n${email} 인증코드: ${code}`;
  els.mockMailbox.hidden = false;
}

async function handleSendCode() {
  const form = els.signupForm;
  const v = verification;
  const blocked = isFormBusy(form) || ["sending", "verifying", "verified"].includes(v.status) || Date.now() < v.resendAt;
  if (blocked) return;

  const email = form.elements.email.value.trim();
  const emailError = validateEmail(email); // 형식을 먼저 확인한 뒤에 메일을 보낸다.
  showFormError(form, null);
  showFieldErrors(form, emailError ? { email: [emailError] } : {});
  if (emailError) return;

  const previousStatus = v.status;
  const seq = ++v.seq;
  v.status = "sending";
  renderEmailVerification();
  let sent;
  try {
    sent = await api.sendEmailCode({ email });
  } catch (err) {
    if (seq !== v.seq) return;
    v.status = previousStatus;
    renderEmailVerification();
    showAuthServerError(form, err, form.elements.password.value, {
      409: { field: "email", message: EMAIL_TAKEN_MESSAGE },
      422: { field: "email", message: EMAIL_FORMAT_MESSAGE }, // 서버 규칙이 화면보다 엄격해 걸린 경우에도 같은 문구
      429: { field: "email", message: err.message },
    });
    return;
  }
  if (seq !== v.seq) return; // 그 사이 이메일을 바꾸거나 화면을 옮겼다.

  const now = Date.now();
  Object.assign(v, { status: "sent", email, expiresAt: now + sent.expires_in * 1000, resendAt: now + (sent.resend_after ?? 0) * 1000 });
  form.elements.code.value = "";
  startVerificationTimer();
  renderEmailVerification();
  showMockMailbox(email);
  form.elements.code.focus();
}

async function handleVerifyCode() {
  const form = els.signupForm;
  const v = verification;
  if (isFormBusy(form) || v.status !== "sent") return;

  const code = form.elements.code.value.trim();
  showFormError(form, null);
  if (!CODE_PATTERN.test(code)) {
    showFieldErrors(form, { code: ["인증코드는 숫자 6자리예요."] });
    return;
  }

  const seq = ++v.seq;
  v.status = "verifying";
  renderEmailVerification();
  try {
    await api.verifyEmailCode({ email: v.email, code });
  } catch (err) {
    if (seq !== v.seq) return;
    v.status = "sent";
    renderEmailVerification();
    showAuthServerError(form, err, form.elements.password.value, {
      400: { field: "code", message: err.message }, // 틀렸거나 만료된 코드
      429: { field: "code", message: err.message }, // 시도 횟수 초과
    });
    return;
  }
  if (seq !== v.seq) return;

  stopVerificationTimer();
  v.status = "verified";
  form.elements.code.value = "";
  els.mockMailbox.hidden = true;
  showFieldErrors(form, {}, { focus: false });
  renderEmailVerification();
  form.elements.password.focus();
}

// ---------- 할 일 폼 ----------
function readTodoForm(form) {
  const description = form.elements.description.value;
  return {
    title: form.elements.title.value.trim(),
    description: description.trim() === "" ? null : description,
    due_date: form.elements.due_date.value || null,
  };
}

/** 서버와 같은 규칙으로 먼저 확인해서, 명백한 실수는 요청 전에 알려준다. */
function validateTodoForm(form, data) {
  const errors = {};
  // 제목: 앞뒤 공백 제거 후 1~100자, 내부 공백은 길이에 포함 (readTodoForm에서 이미 trim)
  const titleLength = charCount(data.title);
  if (titleLength < 1) errors.title = ["제목을 입력해 주세요. (공백만으로는 안 돼요)"];
  else if (titleLength > TITLE_MAX) errors.title = [`제목은 앞뒤 공백을 빼고 ${TITLE_MAX}자 이하로 입력해 주세요. (지금 ${titleLength}자)`];

  const descriptionLength = data.description ? charCount(data.description) : 0;
  if (descriptionLength > DESCRIPTION_MAX) {
    errors.description = [`설명은 ${DESCRIPTION_MAX.toLocaleString()}자 이하로 입력해 주세요. (지금 ${descriptionLength.toLocaleString()}자)`];
  }

  // 날짜를 일부만 입력하면 브라우저가 값을 비우고 badInput으로 알려준다. 과거 날짜는 허용한다.
  const dueInput = form.elements.due_date;
  if (dueInput.validity.badInput || (data.due_date && !isValidYmd(data.due_date))) {
    errors.due_date = ["올바른 날짜를 입력해 주세요. (연도·월·일을 모두 입력하거나 비워 두세요)"];
  }
  return errors;
}

/** 서버가 거절한 이유를 입력칸 아래와 토스트로 보여준다. 입력한 내용은 그대로 둔다. */
function showServerError(form, err) {
  const fieldErrors = err instanceof ApiError ? err.fieldErrors : {};
  const known = Object.fromEntries(Object.entries(fieldErrors).filter(([name]) => form.elements[name]));
  showFieldErrors(form, known);
  toast(errorMessage(err), "error");
}

async function handleCreate(event) {
  event.preventDefault();
  const form = els.createForm;
  if (isFormBusy(form)) return; // 저장 중 Enter·버튼 연타 방지
  const data = readTodoForm(form);
  const errors = validateTodoForm(form, data);
  showFieldErrors(form, errors);
  if (Object.keys(errors).length) return;

  setFormBusy(form, true);
  try {
    await api.createTodo(data); // 소유자 ID는 보내지 않는다. 서버가 토큰의 사용자로 정한다.
  } catch (err) {
    setFormBusy(form, false);
    showServerError(form, err);
    return;
  }
  setFormBusy(form, false);
  form.reset();
  updateCounters(form);
  toast(state.status === "completed" ? "할 일을 추가했어요. (완료 목록에는 보이지 않아요)" : "할 일을 추가했어요.");
  form.elements.title.focus();
  state.page = 1;
  syncUrl();
  await loadList();
}

// ---------- 목록 ----------
function syncUrl() {
  const params = new URLSearchParams(location.search);
  for (const [key, fallback] of Object.entries(DEFAULT_QUERY)) {
    if (state[key] === fallback) params.delete(key);
    else params.set(key, state[key]);
  }
  const query = params.toString();
  history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}`);
}

function setListLoading(loading) {
  els.list.setAttribute("aria-busy", String(loading));
  els.list.classList.toggle("is-loading", loading);
  clearTimeout(loadingTimer);
  if (loading && state.loaded) {
    loadingTimer = setTimeout(() => (els.listLoading.hidden = false), SLOW_LOADING_MS);
  } else {
    els.listLoading.hidden = true;
  }
}

/** 필터 결과가 비었을 때, 할 일 자체가 없는 것인지 확인한다. 확인하지 못하면 필터 안내를 보여준다. */
async function checkHasAnyTodo() {
  try {
    const data = await api.listTodos({ status: "all", sort: "latest", page: 1, size: 1 });
    return data.total > 0;
  } catch {
    return true;
  }
}

async function loadList() {
  const seq = ++listRequestSeq;
  setListLoading(true);
  try {
    const data = await api.listTodos({ status: state.status, sort: state.sort, page: state.page, size: state.size });
    if (seq !== listRequestSeq) return; // 그 사이 다른 조건으로 다시 불렀으면 이 응답은 버린다.

    // 서버가 페이지를 보정해서 돌려줬다면 그 값을 따른다.
    if (Number.isInteger(data.page) && data.page >= 1 && data.page !== state.page) {
      state.page = data.page;
      syncUrl();
    }
    const lastPage = Math.max(1, Math.ceil(data.total / state.size));
    if (state.page > lastPage) {
      // 마지막 페이지의 항목을 지우거나 완료 처리해서 페이지가 사라진 경우 → 남아 있는 마지막 페이지로
      state.page = lastPage;
      syncUrl();
      await loadList();
      return;
    }

    let hasAnyTodo = data.total > 0;
    if (!hasAnyTodo && state.status !== "all") hasAnyTodo = await checkHasAnyTodo();
    if (seq !== listRequestSeq) return;

    Object.assign(state, { total: data.total, items: data.items, loaded: true, loadFailed: false, hasAnyTodo });
    hideBanner();
    renderList();
  } catch (err) {
    if (seq !== listRequestSeq) return;
    Object.assign(state, { total: 0, items: [], loaded: true, loadFailed: true });
    renderList();
    showBanner(err);
  } finally {
    if (seq === listRequestSeq) setListLoading(false);
  }
}

function showBanner(err) {
  els.bannerMessage.textContent = errorMessage(err);
  els.bannerMockLink.hidden = useMock || !isLocalHost || !(err instanceof ApiError && err.status === 0);
  els.banner.hidden = false;
}

function hideBanner() {
  els.banner.hidden = true;
}

function renderControls() {
  for (const button of els.statusButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.status === state.status));
  }
  els.sortSelect.value = state.sort;
  els.sizeSelect.value = String(state.size);
}

const ROW_PARTS = { check: ".todo-check", main: ".todo-main", delete: ".todo-delete" };
const listRows = () => [...els.list.children];
const findRow = (id) => listRows().find((row) => row.dataset.id === String(id));

/** 목록을 다시 그리기 전에, 목록 안에 있던 포커스 위치를 기억한다. */
function captureListFocus() {
  const active = document.activeElement;
  const row = active?.closest?.(".todo-item");
  if (!row || !els.list.contains(row)) return null;
  const part = Object.keys(ROW_PARTS).find((name) => active.matches(ROW_PARTS[name])) ?? "main";
  return { id: row.dataset.id, part, index: listRows().indexOf(row) };
}

function fallbackFocusTarget() {
  return els.emptyReset.hidden ? els.createForm.elements.title : els.emptyReset;
}

/** 같은 항목이 남아 있으면 그 자리로, 사라졌으면 같은 순서의 항목으로 포커스를 옮긴다. */
function focusListPosition({ id, part = "main", index = 0 }) {
  const rows = listRows();
  const same = rows.find((row) => row.dataset.id === String(id));
  const target = same
    ? same.querySelector(ROW_PARTS[part])
    : rows[Math.min(Math.max(index, 0), rows.length - 1)]?.querySelector(ROW_PARTS.main);
  (target ?? fallbackFocusTarget()).focus();
}

function renderList() {
  const focus = captureListFocus();
  const failed = state.loadFailed;
  const today = todayKST();
  els.list.replaceChildren(...state.items.map((todo) => renderItem(todo, today)));

  let emptyMessage = null;
  if (!state.loaded) emptyMessage = "할 일을 불러오는 중…";
  else if (!failed && state.items.length === 0) emptyMessage = state.hasAnyTodo ? EMPTY_FILTER_MESSAGES[state.status] : NO_TODOS_MESSAGE;
  els.empty.hidden = emptyMessage === null;
  els.emptyMessage.textContent = emptyMessage ?? "";
  els.emptyReset.hidden = !(emptyMessage && state.loaded && state.hasAnyTodo && state.status !== "all");

  if (failed || state.total === 0) {
    els.summary.textContent = "";
  } else {
    const start = (state.page - 1) * state.size + 1;
    const end = start + state.items.length - 1;
    els.summary.textContent = `총 ${state.total}개 중 ${start}–${end}`;
  }
  renderPagination(failed);
  if (focus) focusListPosition(focus);
}

function renderItem(todo, today) {
  const overdue = isOverdue(todo, today);
  const due = dueInfo(todo, today);
  const busy = pending.has(todo.id);

  const checkbox = el("input", {
    type: "checkbox",
    className: "todo-check",
    checked: todo.is_completed,
    "aria-label": `“${todo.title}” ${todo.is_completed ? "완료 취소" : "완료로 표시"}`,
    "aria-disabled": busy ? "true" : null,
  });
  // 체크 표시는 서버가 성공을 알려준 뒤 목록을 다시 받아서 바꾼다. (실패했는데 체크된 것처럼 보이지 않게)
  checkbox.addEventListener("click", (event) => {
    event.preventDefault();
    toggleCompleted(todo);
  });

  const firstLine = todo.description?.split("\n").find((line) => line.trim()) ?? null;

  return el(
    "li",
    {
      className: ["todo-item", todo.is_completed && "is-completed", overdue && "is-overdue", busy && "is-pending"].filter(Boolean).join(" "),
      dataset: { id: todo.id },
      "aria-busy": busy ? "true" : null,
    },
    checkbox,
    el(
      "button",
      { type: "button", className: "todo-main", onClick: () => openDetail(todo) },
      el("span", { className: "todo-title" }, todo.title),
      firstLine && el("span", { className: "todo-snippet" }, firstLine),
      due && el("span", { className: "todo-meta" }, el("span", { className: `badge badge-${due.tone}` }, due.label)),
    ),
    el("button", {
      type: "button",
      className: "btn-icon todo-delete",
      "aria-label": `“${todo.title}” 삭제`,
      title: "삭제",
      "aria-disabled": busy ? "true" : null,
      onClick: () => deleteFlow(todo),
    }, el("span", { "aria-hidden": "true" }, "🗑")),
  );
}

/** 목록을 다시 그리지 않고 한 항목의 처리 중 표시만 바꾼다. (포커스 유지) */
function setPending(id, operation) {
  if (operation) pending.set(id, operation);
  else pending.delete(id);

  const row = findRow(id);
  if (row) {
    row.classList.toggle("is-pending", Boolean(operation));
    if (operation) row.setAttribute("aria-busy", "true");
    else row.removeAttribute("aria-busy");
    for (const control of row.querySelectorAll(".todo-check, .todo-delete")) setAriaDisabled(control, Boolean(operation));
  }
  if (state.detail?.id === id) renderDetail();
}

function pageNumbers(current, last) {
  const pages = [...new Set([1, current - 1, current, current + 1, last])]
    .filter((n) => n >= 1 && n <= last)
    .sort((a, b) => a - b);
  const result = [];
  let prev = 0;
  for (const n of pages) {
    if (n - prev === 2) result.push(prev + 1);
    else if (n - prev > 2) result.push("…");
    result.push(n);
    prev = n;
  }
  return result;
}

function renderPagination(failed) {
  const focusedLabel = els.pagination.contains(document.activeElement)
    ? document.activeElement.getAttribute("aria-label")
    : null;
  const last = Math.max(1, Math.ceil(state.total / state.size));
  els.pagination.hidden = failed || last <= 1;
  if (els.pagination.hidden) return els.pagination.replaceChildren();

  const goTo = (page) => () => {
    state.page = page;
    syncUrl();
    loadList();
    els.list.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  const items = pageNumbers(state.page, last).map((n) =>
    n === "…"
      ? el("span", { className: "page-gap", "aria-hidden": "true" }, "…")
      : el("button", {
          type: "button",
          className: "page-btn",
          "aria-current": n === state.page ? "page" : null,
          "aria-label": `${n}페이지`,
          onClick: goTo(n),
        }, String(n)),
  );
  els.pagination.replaceChildren(
    el("button", { type: "button", className: "page-btn", disabled: state.page <= 1, "aria-label": "이전 페이지", onClick: goTo(state.page - 1) }, "‹"),
    ...items,
    el("button", { type: "button", className: "page-btn", disabled: state.page >= last, "aria-label": "다음 페이지", onClick: goTo(state.page + 1) }, "›"),
  );

  // 키보드로 페이지를 넘긴 경우, 다시 그려진 같은 버튼(끝에 닿았으면 현재 페이지 버튼)으로 포커스를 돌려준다.
  if (focusedLabel) {
    const buttons = [...els.pagination.querySelectorAll("button")];
    const target = buttons.find((b) => b.getAttribute("aria-label") === focusedLabel && !b.disabled)
      ?? els.pagination.querySelector('[aria-current="page"]');
    target?.focus();
  }
}

/** 항목이 없거나(404) 내 것이 아닐 때(403): 상세 창이 열려 있으면 그 안에서 안내하고, 아니면 토스트로 알린 뒤 목록을 새로 받는다. */
function handleTodoUnavailable(id, err) {
  if (state.detail?.id === id && els.detailDialog.open) {
    const text = UNAVAILABLE_TEXT[err.status];
    els.detailMissingTitle.textContent = text.title;
    els.detailMissingMessage.textContent = text.message;
    showDetailPanel("missing");
  } else {
    toast(errorMessage(err), "error");
  }
  loadList();
}

async function toggleCompleted(todo) {
  if (pending.has(todo.id)) return;
  setPending(todo.id, "toggle");
  try {
    const updated = await api.setCompleted(todo.id, !todo.is_completed);
    if (state.detail?.id === todo.id) state.detail = updated;
    toast(updated.is_completed ? "완료했어요." : "완료를 취소했어요.");
  } catch (err) {
    setPending(todo.id, null);
    // 404는 항목 없음, 403은 남의 항목 안내. 둘 다 로그아웃시키지 않는다.
    if (isUnavailable(err)) handleTodoUnavailable(todo.id, err);
    else toast(errorMessage(err), "error");
    return;
  }
  await loadList();
  setPending(todo.id, null);
}

async function deleteFlow(todo) {
  if (pending.has(todo.id)) return;
  if (!(await confirmDelete(todo))) return; // 취소하면 아무것도 바뀌지 않는다.
  if (pending.has(todo.id) || !state.user) return;

  setPending(todo.id, "delete");
  try {
    await api.deleteTodo(todo.id);
  } catch (err) {
    setPending(todo.id, null);
    if (isUnavailable(err)) handleTodoUnavailable(todo.id, err);
    else toast(errorMessage(err), "error");
    return;
  }
  toast("삭제했어요.");
  if (state.detail?.id === todo.id) closeDetail({ restoreFocus: true });
  await loadList(); // 현재 페이지가 비었으면 loadList가 앞 페이지로 옮겨 다시 조회한다.
  setPending(todo.id, null);
}

function confirmDelete(todo) {
  return new Promise((resolve) => {
    const dialog = els.confirmDialog;
    const seq = ++confirmSeq;
    els.confirmMessage.textContent = `“${todo.title}”을(를) 삭제하면 복구할 수 없어요.`;
    dialog.returnValue = "";
    const onClose = () => {
      // close 이벤트는 비동기라, 닫자마자 다시 연 경우 이전 창의 이벤트가 늦게 올 수 있다. 지금 열려 있으면 무시.
      if (dialog.open) return;
      dialog.removeEventListener("close", onClose);
      resolve(seq === confirmSeq && dialog.returnValue === "confirm"); // 이전 확인 요청은 항상 "취소"로 끝낸다.
    };
    dialog.addEventListener("close", onClose);
    showModal(dialog);
  });
}

// ---------- 상세 / 수정 ----------
function showDetailPanel(name) {
  els.detailView.hidden = name !== "view";
  els.editForm.hidden = name !== "edit";
  els.detailMissing.hidden = name !== "missing";
  if (name === "missing") els.detailBack.focus();
}

async function openDetail(todo) {
  detailReturn = { id: todo.id, index: listRows().indexOf(findRow(todo.id)) };
  // 목록에 있던 값으로 바로 열고, 서버에서 최신 상세 정보를 받아 다시 그린다.
  state.detail = todo;
  showDetailPanel("view");
  renderDetail();
  if (!els.detailDialog.open) showModal(els.detailDialog);
  detailIsOpen = true;

  try {
    const fresh = await api.getTodo(todo.id);
    if (state.detail?.id !== todo.id) return;
    state.detail = fresh;
    renderDetail();
  } catch (err) {
    if (state.detail?.id !== todo.id) return;
    if (isUnavailable(err)) handleTodoUnavailable(todo.id, err);
    else toast(errorMessage(err), "error");
  }
}

/**
 * 상세 창을 닫고, 닫는 즉시 상세를 열었던 목록 위치로 포커스를 돌려준다.
 * (브라우저의 기본 포커스 복원은 목록이 다시 그려져 원래 버튼이 사라졌으면 실패한다.
 *  close 이벤트는 비동기로 오기 때문에, 거기서 돌려주면 잠깐 동안 닫힌 창 안에 포커스가 남는다.)
 */
function closeDetail({ restoreFocus = true } = {}) {
  if (els.detailDialog.open) els.detailDialog.close();
  afterDetailClosed({ restoreFocus });
}

function afterDetailClosed({ restoreFocus = true } = {}) {
  if (!detailIsOpen) return;
  detailIsOpen = false;
  state.detail = null;
  showDetailPanel("view");
  const target = detailReturn;
  detailReturn = null;
  if (restoreFocus && target) focusListPosition(target);
}

function renderDetail() {
  const todo = state.detail;
  if (!todo) return;
  const today = todayKST();
  const overdue = isOverdue(todo, today);
  const operation = pending.get(todo.id);

  els.detailTitle.textContent = todo.title;
  els.detailTitle.classList.toggle("is-completed", todo.is_completed);

  const due = dueInfo(todo, today);
  const badges = [
    el("span", { className: `badge ${todo.is_completed ? "badge-success" : "badge-muted"}` }, todo.is_completed ? "완료" : "미완료"),
  ];
  if (due && !todo.is_completed) {
    badges.push(el("span", { className: `badge badge-${due.tone}` }, overdue ? due.label : due.label.split(" · ")[0]));
  }
  els.detailBadges.replaceChildren(...badges);

  els.detailDescription.textContent = todo.description || "설명이 없어요.";
  els.detailDescription.classList.toggle("is-empty", !todo.description);
  els.detailDue.textContent = todo.due_date ? formatDate(todo.due_date) : "없음";
  els.detailCreated.textContent = formatDateTime(todo.created_at);
  els.detailUpdated.textContent = formatDateTime(todo.updated_at);
  els.detailCompleted.textContent = todo.completed_at ? formatDateTime(todo.completed_at) : "-";

  els.detailToggle.textContent = operation === "toggle" ? "처리 중…" : todo.is_completed ? "완료 취소" : "완료하기";
  els.detailDelete.textContent = operation === "delete" ? "삭제 중…" : "삭제";
  for (const button of [els.detailToggle, els.detailEdit, els.detailDelete]) setAriaDisabled(button, Boolean(operation));
}

function showEditForm() {
  const todo = state.detail;
  if (!todo || pending.has(todo.id)) return;
  const form = els.editForm;
  form.elements.title.value = todo.title;
  form.elements.description.value = todo.description ?? "";
  form.elements.due_date.value = todo.due_date ?? "";
  showFieldErrors(form, {}, { focus: false });
  updateCounters(form);
  showDetailPanel("edit");
  form.elements.title.focus();
}

function cancelEdit() {
  if (isFormBusy(els.editForm)) return;
  showDetailPanel("view");
  els.detailEdit.focus();
}

async function handleEditSubmit(event) {
  event.preventDefault();
  const form = els.editForm;
  if (isFormBusy(form) || !state.detail) return;
  const data = readTodoForm(form);
  const errors = validateTodoForm(form, data);
  showFieldErrors(form, errors);
  if (Object.keys(errors).length) return;

  const id = state.detail.id;
  setFormBusy(form, true);
  let updated;
  try {
    updated = await api.updateTodo(id, data);
  } catch (err) {
    setFormBusy(form, false);
    if (isNotFound(err)) handleTodoUnavailable(id, err);
    else showServerError(form, err); // 403 포함: 수정 창과 입력 내용은 그대로 둔다.
    return;
  }
  setFormBusy(form, false);
  toast("수정했어요.");
  if (state.detail?.id === id && els.detailDialog.open) {
    state.detail = updated;
    showDetailPanel("view");
    renderDetail();
    els.detailEdit.focus();
  }
  loadList();
}

// ---------- 이벤트 연결 ----------
function changeListQuery(changes) {
  Object.assign(state, changes, { page: 1 }); // 조건이 바뀌면 항상 첫 페이지부터
  renderControls();
  syncUrl();
  loadList();
}

function bindAuthEvents() {
  setupForm(els.loginForm);
  setupForm(els.signupForm);
  els.loginForm.addEventListener("submit", handleLogin);
  els.signupForm.addEventListener("submit", handleSignup);
  for (const button of document.querySelectorAll("[data-auth-mode]")) {
    button.addEventListener("click", () => {
      if (!isFormBusy(els.loginForm) && !isFormBusy(els.signupForm)) switchAuthMode(button.dataset.authMode);
    });
  }
  const signupInputs = els.signupForm.elements;
  els.emailCodeSend.addEventListener("click", handleSendCode);
  els.emailCodeVerify.addEventListener("click", handleVerifyCode);
  els.emailChange.addEventListener("click", () => {
    if (isFormBusy(els.signupForm)) return;
    resetEmailVerification();
    signupInputs.email.focus();
  });
  // 코드를 받은 뒤 이메일을 바꾸면 그 코드는 쓸 수 없으므로 처음부터 다시 한다.
  signupInputs.email.addEventListener("input", () => {
    if (verification.status === "sent" && signupInputs.email.value.trim() !== verification.email) resetEmailVerification();
  });
  // 인증 전에는 이메일·코드 칸의 Enter가 가입 제출이 아니라 코드 받기·확인을 한다.
  signupInputs.email.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing || verification.status === "verified") return;
    event.preventDefault();
    handleSendCode();
  });
  signupInputs.code.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    handleVerifyCode();
  });
  els.logoutButton.addEventListener("click", () => endSession(AUTH_NOTICES.loggedOut));
  els.bootRetry.addEventListener("click", boot);
  els.bootRelogin.addEventListener("click", () => {
    session.end();
    showAuth("login");
  });
}

function bindTodoEvents() {
  setupForm(els.createForm);
  setupForm(els.editForm);
  els.createForm.addEventListener("submit", handleCreate);
  els.editForm.addEventListener("submit", handleEditSubmit);

  for (const button of els.statusButtons) {
    button.addEventListener("click", () => {
      if (state.status !== button.dataset.status) changeListQuery({ status: button.dataset.status });
    });
  }
  els.sortSelect.addEventListener("change", () => changeListQuery({ sort: els.sortSelect.value }));
  els.sizeSelect.addEventListener("change", () => changeListQuery({ size: Number(els.sizeSelect.value) }));
  els.emptyReset.addEventListener("click", () => {
    changeListQuery({ status: "all" });
    $('[data-status="all"]').focus();
  });
  els.bannerRetry.addEventListener("click", loadList);

  els.detailToggle.addEventListener("click", () => state.detail && toggleCompleted(state.detail));
  els.detailEdit.addEventListener("click", showEditForm);
  els.detailDelete.addEventListener("click", () => state.detail && deleteFlow(state.detail));
  els.editCancel.addEventListener("click", cancelEdit);
  els.detailBack.addEventListener("click", () => closeDetail());

  // 바깥 어두운 영역을 누르면 닫는다.
  els.detailDialog.addEventListener("click", (event) => {
    if (event.target === els.detailDialog) closeDetail();
  });
  els.confirmDialog.addEventListener("click", (event) => {
    if (event.target === els.confirmDialog) els.confirmDialog.close("cancel");
  });
  for (const button of document.querySelectorAll("[data-close-dialog]")) {
    button.addEventListener("click", () => closeDetail());
  }
  // Esc는 직접 처리해서 닫는 즉시 포커스를 돌려준다. 수정 중이면 창을 닫지 않고 상세 보기로 돌아간다.
  els.detailDialog.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return; // 한글 입력 조합 중 Esc는 조합 취소
    event.preventDefault();
    if (!els.editForm.hidden) cancelEdit();
    else closeDetail();
  });
  // 키보드가 아닌 방법(모바일 뒤로 가기 등)으로 닫히려 할 때
  els.detailDialog.addEventListener("cancel", (event) => {
    if (els.editForm.hidden) return;
    event.preventDefault();
    cancelEdit();
  });
  els.detailDialog.addEventListener("close", () => {
    // close 이벤트는 비동기라, 닫자마자 다시 연 경우 이전에 닫힌 창의 이벤트가 새 창이 열린 뒤에 도착한다.
    // 그때 상세 상태를 비우면 새 창이 동작하지 않으므로, 실제로 닫혀 있을 때만 처리한다.
    if (!els.detailDialog.open) afterDetailClosed();
  });

  // 탭을 오래 열어둔 사이 날짜가 바뀌었을 수 있으니, 돌아오면 배지를 다시 계산한다.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.user && state.loaded) renderList();
  });
}

function setupMock() {
  if (!useMock) return;
  const settings = configureMock({
    delayMs: initialParams.get("mockDelay"),
    fail: initialParams.get("mockFail"),
    failStatus: initialParams.get("mockFailStatus"),
    tokenTtlSec: initialParams.get("mockTokenTtl"),
    emailCodeTtlSec: initialParams.get("mockCodeTtl"),
    resendAfterSec: initialParams.get("mockResendAfter"),
    verifiedTtlSec: initialParams.get("mockVerifiedTtl"),
  });
  els.mockAccounts.hidden = false;
  els.mockAccounts.textContent = `Mock 테스트 계정 (동작 확인용, 실제 인증 아님)\n${MOCK_TEST_USERS.map((u) => u.email).join(" · ")} / 비밀번호 ${MOCK_TEST_USERS[0].password}`;
  // 개발자 도구 콘솔에서 쓰는 도우미. 토큰 값은 어디에도 출력하지 않는다.
  window.steptodoMock = {
    configure: configureMock,
    reset: async () => {
      await resetMockData();
      endSession(null);
    },
    remove: removeMockTodo,
    expireSessions: expireMockSessions,
    emailCode: getMockEmailCode,
  };
  console.info("[StepTodo] Mock API 사용 중 — 데이터는 이 브라우저의 localStorage에만 저장되며, 인증은 동작 확인용 흉내입니다.", settings,
    "\n콘솔 도우미: steptodoMock.configure({...}), steptodoMock.expireSessions(), steptodoMock.emailCode(email), steptodoMock.remove(id), steptodoMock.reset()");
}

function init() {
  els.mockBadge.hidden = !useMock;
  setupMock();
  renderControls();
  bindAuthEvents();
  bindTodoEvents();
  boot();
}

init();
