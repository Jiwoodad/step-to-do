# StepTodo 프론트엔드

빌드 도구 없이 HTML · CSS · JavaScript(ES 모듈)만으로 만든 화면이다.
회원가입·로그인·로그아웃과 사용자별 할 일 관리를 포함한다.
[API.md](API.md)의 명세대로 백엔드를 만들면 화면을 고치지 않고 연결된다.
**현재는 Mock API로만 검증했고, 실제 백엔드와의 연동은 아직 하지 않았다.**

```
frontend/
├── index.html        화면 구조 (로그인 확인 중 · 로그인/회원가입 · 할 일 화면, 상세·수정·삭제 확인 창)
├── config.js         API 주소 · Mock 모드 설정 (환경마다 이 파일만 교체)
├── API.md            실제 연동에 필요한 API 명세 (백엔드 작업 기준)
├── css/style.css
├── js/
│   ├── app.js        화면 동작 (세션 흐름, 로그인·회원가입, 할 일 목록·상세)
│   ├── api.js        API 호출·오류 해석·인증 헤더·401 처리 — 엔드포인트가 바뀌면 여기만 수정
│   ├── session.js    access token 보관(sessionStorage)과 세션 번호(epoch)
│   ├── ui.js         공통 UI 도우미 (토스트, 모달, 폼 처리 중·오류 표시)
│   ├── mock-api.js   백엔드 없이 쓰는 가짜 API (localStorage 저장, 인증은 흉내)
│   └── date.js       한국 시간 기준 날짜 계산 (오늘, D-day, 기한 초과)
├── tests/            단위 테스트(node:test)와 브라우저 e2e 테스트(Playwright) — 배포하지 않음
└── package.json      개발 서버·테스트 실행용 (화면 자체는 의존성 없음)
```

배포(Nginx 등)할 때는 `index.html`, `config.js`, `css/`, `js/`만 내보낸다.

## 실행하기

ES 모듈을 쓰므로 `index.html`을 더블클릭(file://)하면 동작하지 않는다. 정적 서버로 띄운다.

```bash
cd frontend
npm run serve                 # http://127.0.0.1:5500  (Node 20.11 이상, 의존성 설치 없이 동작)
# 또는
python3 -m http.server 5500
```

### 1) 백엔드 없이 화면만 보기 (Mock 모드)

<http://localhost:5500/?mock=1> 로 연다. 로그인 화면에 Mock 테스트 계정이 보인다.

| 계정 | 비밀번호 | 예시 할 일 |
|---|---|---|
| `alice@example.com` | `password123` | 5개 (로그인 기능 전 Mock 데이터가 있었다면 그 할 일) |
| `bob@example.com` | `password123` | 2개 |

새 계정으로 가입하려면 이메일 인증이 필요하다. Mock은 메일을 보내지 않으므로, "인증코드 받기"를 누르면 화면의 **Mock 메일함**에 코드가 나타난다. 데이터는 이 브라우저의 localStorage에만 저장된다. **Mock 인증은 흐름 확인용 흉내이고 실제 JWT 보안 검증이 아니다.** 실제 비밀번호를 넣지 말 것.
`?mock=1`은 `localhost`·`127.0.0.1`에서만 동작한다. 배포 주소에서는 무시되므로 Mock 표시와 테스트 계정 안내가 나타나지 않는다.

처리 중 상태와 실패 처리는 주소 옵션으로 확인할 수 있다.

| 옵션 | 예 | 효과 |
|---|---|---|
| `mockDelay` | `?mock=1&mockDelay=1500` | 모든 응답을 1.5초 늦춘다 |
| `mockFail` | `?mock=1&mockFail=login,create` | 해당 요청을 실패시킨다. `emailSend` `emailVerify` `signup` `login` `me` `list` `get` `create` `update` `toggle` `delete` `all` |
| `mockFailStatus` | `&mockFailStatus=403` | 실패 응답 코드 (기본 `500`, `0`이면 연결 실패, `401` `403` `404` 등) |
| `mockTokenTtl` | `&mockTokenTtl=10` | 로그인 토큰 수명(초). 만료 흐름 확인용 |
| `mockCodeTtl` | `&mockCodeTtl=5` | 이메일 인증코드 유효 시간(초, 기본 300) |
| `mockResendAfter` | `&mockResendAfter=3` | 인증코드 재발송 대기(초, 기본 60) |
| `mockVerifiedTtl` | `&mockVerifiedTtl=5` | 인증 후 가입을 끝내야 하는 시간(초, 기본 1800) |

개발자 도구 콘솔 도우미:

```js
steptodoMock.expireSessions()  // 서버에서 토큰이 만료된 상황 → 다음 요청이 401
await steptodoMock.emailCode("new@example.com")  // 그 이메일로 "보낸" 인증코드 확인
steptodoMock.remove(3)         // 다른 탭에서 지운 것처럼 3번을 몰래 삭제 → "없는 항목" 안내 확인
steptodoMock.configure({ delayMs: 1000, fail: ["update"], failStatus: 403, tokenTtlSec: 30 })
steptodoMock.reset()           // 테스트 사용자·예시 데이터로 되돌리기 (로그아웃됨)
```

### 2) FastAPI와 연결하기

1. FastAPI를 `http://localhost:8000`에서 실행한다. (주소가 다르면 `config.js`의 `apiBaseUrl` 수정)
2. 화면(5500)과 API(8000)의 출처가 다르므로 CORS를 연다. **`Authorization` 헤더를 허용해야 한다.**

   ```python
   from fastapi.middleware.cors import CORSMiddleware

   app.add_middleware(
       CORSMiddleware,
       allow_origins=["http://localhost:5500", "http://127.0.0.1:5500"],
       allow_methods=["GET", "POST", "PATCH", "DELETE"],
       allow_headers=["Content-Type", "Authorization", "X-Request-ID"],
   )
   ```
3. <http://localhost:5500> 을 연다(`?mock=1` 없이). 연동 확인 순서는 [API.md §12](API.md#12-연동-확인-순서)에 있다.

연결이 안 되면 화면에 안내가 뜨고, 브라우저 콘솔에 `[StepTodo] POST /auth/login → ...` 형태로 원인이 찍힌다(비밀번호·토큰은 가린다).
CORS 오류는 콘솔에만 자세히 나오므로 먼저 콘솔을 확인한다.

### 3) 나중에 Nginx로 함께 띄울 때 (5단계)

정적 파일을 서빙하고 `/api/` 요청만 FastAPI로 넘기면 된다.
그때는 `config.js`의 `apiBaseUrl`을 `"/api"`로, `useMock`은 `false`로 둔다. 출처가 같아지므로 CORS 설정도 필요 없어진다.

## 로그인 정책 (요약, 자세한 내용은 [API.md §3](API.md#3-화면의-세션-처리))

| 항목 | 동작 |
|---|---|
| 회원가입 | 이메일 형식 검사(틀리면 "올바른 이메일 형식이 아닙니다"를 표시하고 코드를 보내지 않음) → 인증코드 받기 → 코드 확인 → 비밀번호 입력 → 가입 → 로그인 화면. 인증 전에는 가입할 수 없음 |
| 로그인 요청 | OAuth2 Password 방식: form으로 `username`(이메일)·`password` 전송 |
| 토큰 저장 | `sessionStorage`: 새로고침해도 유지, 탭을 닫으면 사라짐, 다른 탭과 공유 안 함. URL·로그에 남기지 않음 |
| 새로고침 | 저장된 토큰으로 `GET /api/me` → 성공하면 그대로 이어서 사용. 만료 시각이 지났거나 `401`이면 로그인 화면 |
| 만료 | 인증이 필요한 요청이 `401` → 사용자·할 일 상태를 모두 비우고 "다시 로그인" 안내 |
| 로그인 실패 | 로그인 화면 안에서 안내. 비밀번호 칸을 비우고, 어떤 문구에도 비밀번호를 넣지 않음 |
| 403 · 404 | 남의 할 일은 403, 없는 항목은 404. 각각 안내하고 로그아웃시키지 않음 |
| 로그아웃 | 화면에서 토큰 삭제 + 진행 중 요청 중단 + 상태 초기화. 서버 토큰은 만료 전까지 유효(서버 폐기 기능은 범위 밖) |
| 사용자 전환 | 이전 사용자의 목록·상세·입력·오류·필터를 초기화. 이전 세션의 응답은 늦게 와도 반영하지 않음 |

로그인 전에는 할 일 화면을 그리지 않고 할 일 API도 부르지 않지만, **화면에서 숨기는 것은 보안이 아니다.** 소유권 검사는 백엔드가 한다.

## 테스트

```bash
cd frontend
npm install                  # 처음 한 번 (playwright-core)
npm test                     # 단위 + e2e 전체
npm run test:unit            # 단위 테스트만 (브라우저 필요 없음, 1초 안팎)
npm run test:e2e             # 브라우저 e2e (2~3분)
node --test --test-name-pattern="사용자 전환" "tests/e2e/**/*.test.mjs"   # 이름으로 골라 실행
```

- e2e는 설치된 Chrome을 쓴다(macOS·Linux 기본 경로 자동 탐색, 또는 `CHROME_PATH=/path/to/chrome`).
  Chrome이 없으면 `npx playwright-core install chromium`으로 받는다.
- e2e는 테스트마다 정적 서버(빈 포트)와 새 브라우저 컨텍스트를 만든다. 모두 Mock API로 돈다. **실제 백엔드 연동 테스트가 아니다.**

| 파일 | 확인하는 것 |
|---|---|
| `tests/unit/date.test.mjs` | 한국 시간 기준 오늘·기한 초과·배지 문구·서버 시각 해석 |
| `tests/unit/session.test.mjs` | 토큰 저장·복원·만료 계산·로그아웃 시 삭제·요청 중단 |
| `tests/unit/api.test.mjs` | 로그인 form 전송, 이메일 인증 요청, Bearer 헤더, 401 처리(한 번만), 로그인 401 구분, 이전 세션 응답 무시, 403·404·422·5xx 해석, 로그에서 비밀번호·토큰 가림 |
| `tests/unit/mock-api.test.mjs` | Mock 인증(이메일 인증·가입·로그인·/me·중복·만료·누락), 사용자별 분리·소유권 403, 소유자 필드 422, 이전 Mock 데이터 이전, 할 일 규칙 |
| `tests/e2e/auth.e2e.test.mjs` | 이메일 인증→가입→로그인→할 일→로그아웃, 로그인 실패, 만료, 새로고침, 사용자 전환, 늦은 응답, 403·404, 키보드, 모바일, 배포 주소, 실제로 나가는 요청 형식(가로챈 스텁) |
| `tests/e2e/todo.e2e.test.mjs` | 기존 체크리스트 1~3번 회귀 (추가·상세·수정·완료·삭제·필터·정렬·페이지·검증·처리 중·실패·키보드·모바일) |
| `tests/e2e/focus.e2e.test.mjs` | 상세 창을 닫을 때 포커스 복귀 (예전 간헐 실패의 재발 방지) |

## 화면 동작 메모

- 필터·정렬·페이지·개수는 주소창(`?status=active&sort=due_date&page=2`)에 남아서 새로고침해도 유지된다(같은 사용자). 조건을 바꾸면 항상 1페이지부터 다시 조회한다.
- 삭제나 완료 처리로 현재 페이지가 비면 남아 있는 마지막 페이지를 다시 조회한다.
- 제목·설명·날짜·이메일·비밀번호는 서버와 같은 규칙으로 화면에서 먼저 확인하지만, **최종 판단은 서버가 한다.**
- 처리 중 표시: 목록 재조회가 길어지면 "불러오는 중…", 저장 중이면 버튼이 "추가 중… / 저장 중… / 처리 중… / 삭제 중… / 로그인 중… / 가입 중…"으로 바뀌고, 그동안 같은 요청은 다시 보내지 않는다.
- 요청이 실패하면 입력 내용과 체크 상태는 그대로 두고 이유만 알려준다. 체크박스는 서버가 성공을 알려준 뒤에 바뀐다.
- 키보드: 추가 폼에서 Enter로 추가, 항목에서 Enter로 상세, Space로 완료 전환, Esc로 창 닫기(수정 중이면 상세 보기로 돌아감). 창을 닫으면 원래 항목으로 포커스가 돌아가고, 그 항목이 지워졌으면 다음 항목으로 간다.
