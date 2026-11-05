// 화면 여러 곳(할 일·인증)에서 같이 쓰는 UI 도우미.
import { ApiError } from "./api.js";

const toastsEl = document.querySelector("#toasts");
const supportsPopover = typeof HTMLElement.prototype.showPopover === "function";

/** 길이는 서버(Python len)와 같게 문자 수로 센다. 이모지처럼 .length가 2로 세는 문자도 1자. */
export const charCount = (text) => [...text].length;

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "className") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}

export function errorMessage(err) {
  if (!(err instanceof ApiError)) {
    console.error(err);
    return "알 수 없는 오류가 발생했습니다.";
  }
  // 서버 오류는 요청 ID를 같이 보여줘서 백엔드 로그에서 찾을 수 있게 한다.
  return err.status >= 500 && err.requestId ? `${err.message}\n요청 ID: ${err.requestId}` : err.message;
}

/** 화면에 보일 문구에서 비밀번호처럼 감춰야 할 값을 지운다. (서버 메시지가 입력값을 되돌려주는 경우 대비) */
export function scrubSecret(text, secret) {
  if (!secret || typeof text !== "string") return text;
  return text.split(secret).join("•••");
}

// ---------- 토스트 ----------
function showToasts() {
  if (supportsPopover && !toastsEl.matches(":popover-open")) toastsEl.showPopover();
}

export function toast(message, tone = "success") {
  const node = el("div", { className: `toast toast-${tone}`, role: tone === "error" ? "alert" : "status" }, message);
  toastsEl.append(node);
  showToasts();
  setTimeout(() => {
    node.classList.add("toast-leave");
    node.addEventListener("animationend", () => {
      node.remove();
      if (supportsPopover && !toastsEl.childElementCount && toastsEl.matches(":popover-open")) toastsEl.hidePopover();
    }, { once: true });
  }, tone === "error" ? 6000 : 3000);
}

export function clearToasts() {
  toastsEl.replaceChildren();
  if (supportsPopover && toastsEl.matches(":popover-open")) toastsEl.hidePopover();
}

/** 모달을 연 뒤에도 토스트가 그 위에 보이도록, 떠 있는 토스트를 최상위로 다시 올린다. */
export function showModal(dialog) {
  dialog.showModal();
  if (supportsPopover && toastsEl.matches(":popover-open")) {
    toastsEl.hidePopover();
    toastsEl.showPopover();
  }
}

/** 처리 중인 버튼. disabled는 포커스를 잃게 하므로 aria-disabled로 막고, 클릭 처리에서 한 번 더 거른다. */
export function setAriaDisabled(node, disabled) {
  if (disabled) node.setAttribute("aria-disabled", "true");
  else node.removeAttribute("aria-disabled");
}

// ---------- 폼 ----------
export function showFieldErrors(form, fieldErrors = {}, { focus = true } = {}) {
  for (const node of form.querySelectorAll("[data-error-for]")) {
    const name = node.dataset.errorFor;
    const messages = fieldErrors[name];
    const input = form.elements[name];
    node.hidden = !messages?.length;
    node.textContent = messages?.join(" ") ?? "";
    if (!input) continue;
    input.toggleAttribute("aria-invalid", Boolean(messages?.length));
    // 원래 있던 안내 문구 연결(aria-describedby)은 두고, 오류 문구를 덧붙인다.
    const base = (input.dataset.describedby ??= input.getAttribute("aria-describedby") ?? "");
    if (messages?.length) {
      node.id ||= `${form.id}-${name}-error`;
      input.setAttribute("aria-describedby", `${base} ${node.id}`.trim());
    } else if (base) {
      input.setAttribute("aria-describedby", base);
    } else {
      input.removeAttribute("aria-describedby");
    }
  }
  if (!focus) return;
  const first = Object.keys(fieldErrors).map((name) => form.elements[name]).find(Boolean);
  first?.focus();
}

/** 특정 입력칸이 아닌 폼 전체의 오류(로그인 실패, 연결 실패 등). */
export function showFormError(form, message) {
  const node = form.querySelector("[data-form-error]");
  if (!node) return;
  node.textContent = message ?? "";
  node.hidden = !message;
}

export function updateCounters(form) {
  for (const counter of form.querySelectorAll("[data-counter-for]")) {
    const name = counter.dataset.counterFor;
    const max = Number(counter.dataset.max);
    const value = form.elements[name].value;
    const length = charCount(name === "title" ? value.trim() : value);
    counter.textContent = `${length.toLocaleString()} / ${max.toLocaleString()}`;
    counter.classList.toggle("is-over", length > max);
  }
}

export const isFormBusy = (form) => form.dataset.busy === "true";

/**
 * 저장 중에는 입력을 읽기 전용으로, 버튼은 aria-disabled로 막는다.
 * (disabled를 쓰면 입력칸에 있던 포커스가 사라져서 키보드 사용자가 위치를 잃는다.)
 */
export function setFormBusy(form, busy) {
  if (busy) form.dataset.busy = "true";
  else delete form.dataset.busy;
  form.toggleAttribute("aria-busy", busy);
  for (const control of form.elements) {
    if (control.matches("input, textarea")) control.readOnly = busy;
    else if (control.tagName === "BUTTON") setAriaDisabled(control, busy);
  }
  const submit = form.querySelector('[type="submit"]');
  submit.textContent = busy ? submit.dataset.busyLabel : submit.dataset.label;
}

/** 입력값·오류·처리 중 표시를 모두 처음 상태로 되돌린다. (로그아웃·사용자 전환 때) */
export function resetForm(form) {
  form.reset();
  setFormBusy(form, false);
  showFieldErrors(form, {}, { focus: false });
  showFormError(form, null);
  updateCounters(form);
}

export function setupForm(form) {
  const submit = form.querySelector('[type="submit"]');
  submit.dataset.label = submit.textContent;

  form.addEventListener("input", (event) => {
    updateCounters(form);
    const name = event.target.name;
    const errorNode = name && form.querySelector(`[data-error-for="${name}"]`);
    if (errorNode && !errorNode.hidden) {
      errorNode.hidden = true;
      event.target.removeAttribute("aria-invalid");
    }
  });
  form.addEventListener("click", (event) => {
    const button = event.target.closest("[data-clear-for]");
    if (!button || isFormBusy(form)) return;
    const input = form.elements[button.dataset.clearFor];
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  });
  updateCounters(form);
}
