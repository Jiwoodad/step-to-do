# StepTodo API 연동 명세 (프론트엔드 기준)

프론트엔드가 실제 FastAPI 백엔드에 기대하는 사항을 정리한 문서다.
지금은 [`js/mock-api.js`](js/mock-api.js)가 이 명세대로 동작하므로, 백엔드가 같은 요청·응답을 주면 화면을 고치지 않고 연결된다.
명세를 바꾸고 싶으면 이 문서와 [`js/api.js`](js/api.js)를 함께 고친다.

- **범위: 첫 버전부터 회원가입·로그인·로그아웃과 사용자별 할 일 관리를 포함한다.**
- **연동 상태: 화면은 Mock API로만 검증했다. 실제 백엔드와의 연동은 아직 하지 않았다.**
- 기본 경로: `/api` (`config.js`의 `apiBaseUrl`) · 본문 형식: JSON (`Content-Type: application/json`)
- 이 문서의 내용은 모두 합의됐다. 결정 목록은 §13, 이메일 인증 세부 값은 §14에 있다.

이번 범위에 넣지 않은 것: refresh token, 서버 쪽 토큰 폐기(로그아웃 API), 비밀번호 재설정, 소셜 로그인.

## 1. 엔드포인트 요약

| 기능 | 요청 | 인증 | 성공 응답 | 화면에서 쓰는 곳 |
|---|---|---|---|---|
| 인증코드 발송 | `POST /api/auth/email-verification/send` | 없음 | `200` | 회원가입: "인증코드 받기" |
| 인증코드 확인 | `POST /api/auth/email-verification/verify` | 없음 | `200` | 회원가입: "확인" |
| 회원가입 | `POST /api/auth/signup` | 없음 | `201` 사용자 | 회원가입 화면 |
| 로그인 (OAuth2 form) | `POST /api/auth/login` | 없음 | `200` 토큰 | 로그인 화면 |
| 현재 사용자 | `GET /api/me` | 필요 | `200` 사용자 | 로그인 직후, 새로고침 시 로그인 복원 |
| 목록 | `GET /api/todos?status=&sort=&page=&size=` | 필요 | `200` 목록 | 처음 열 때, 조건 변경, 모든 변경 후 재조회 |
| 상세 | `GET /api/todos/{id}` | 필요 | `200` Todo | 항목을 눌러 상세 창을 열 때 |
| 추가 | `POST /api/todos` | 필요 | `201` Todo | 추가 폼 |
| 수정 | `PATCH /api/todos/{id}` | 필요 | `200` Todo | 상세 창 → 수정 |
| 완료 / 완료 취소 | `PATCH /api/todos/{id}` `{"is_completed": bool}` | 필요 | `200` Todo | 목록 체크박스, 상세 창 버튼 |
| 삭제 | `DELETE /api/todos/{id}` | 필요 | `204` (본문 없음) | 목록 휴지통, 상세 창 |

"인증 필요" 요청에는 화면이 `Authorization: Bearer <access_token>` 헤더를 붙인다. 헤더가 없거나 토큰이 무효·만료면 `401`을 준다.
본문 형식은 JSON이고, **로그인만 OAuth2 form**(`application/x-www-form-urlencoded`)이다.

## 2. 인증 API

### 2.1 이메일 인증 (SMTP + Redis)

**먼저 이메일 형식만 검사한다.** 형식이 아니면 `올바른 이메일 형식이 아닙니다`를 표시하고 코드를 보내지 않는다. 통과하면 인증코드 절차로 넘어가고, 메일로 보낸 코드를 확인해야 가입할 수 있다.
방식은 SMTP 발송 + Redis 저장이다.

```
이메일 입력 → 형식 검사 → POST .../send → 메일 수신 → 코드 입력 → POST .../verify → 비밀번호 입력 → POST /auth/signup
```

**가입 전에 인증**한다. 계정을 먼저 만들지 않으므로 "미인증 계정"이 없고, 로그인 쪽은 바뀌지 않는다.

**코드 발송** `POST /api/auth/email-verification/send`

```json
// 요청
{ "email": "carol@example.com" }
```

```json
// 200 OK — 코드는 응답에 넣지 않는다. 메일로만 보낸다.
{ "expires_in": 300, "resend_after": 60 }
```

| 상태 | 언제 | 본문 예 | 화면 |
|---|---|---|---|
| `200` | 메일 발송 | 위 응답 | 코드 입력칸 표시, `expires_in`으로 남은 시간, `resend_after`로 재발송 대기 표시 |
| `409` | 이미 가입된 이메일 | `{"detail": "이미 가입된 이메일입니다."}` | 이메일 칸 아래 안내 |
| `422` | 이메일 형식 위반 | Pydantic 기본 형식 | 서버 문구와 관계없이 이메일 칸 아래 `올바른 이메일 형식이 아닙니다` 표시 |
| `429` | 재발송 대기 중 | `{"detail": "인증코드를 방금 보냈습니다. 잠시 후 다시 요청해 주세요."}` | 이메일 칸 아래 안내 |
| `5xx` | SMTP 실패 등 | 무엇이든 | 폼 안에서 "서버 오류" + 요청 ID. 입력 유지 |

**코드 확인** `POST /api/auth/email-verification/verify`

```json
// 요청
{ "email": "carol@example.com", "code": "123456" }
```

```json
// 200 OK — expires_in: 인증 성공 후 가입을 끝내야 하는 시간(초)
{ "verified": true, "expires_in": 1800 }
```

| 상태 | 언제 | 본문 예 | 화면 |
|---|---|---|---|
| `200` | 코드 일치 | 위 응답 | "이메일 인증을 완료했어요", 이메일 칸 잠금, 비밀번호 칸으로 이동 |
| `400` | 코드가 틀림 또는 만료 | `{"detail": "인증코드가 올바르지 않습니다."}` | 코드 칸 아래에 `detail` 표시 |
| `422` | 코드 형식 위반 | Pydantic 기본 형식 (`loc: ["body","code"]`) | 코드 칸 아래 표시 |
| `429` | 시도 횟수 초과 | `{"detail": "시도 횟수를 넘었습니다. 인증코드를 다시 요청해 주세요."}` | 코드 칸 아래 표시. 다시 받기 가능 |

| 값 | 내용 | 비고 |
|---|---|---|
| 코드 형식 | 숫자 6자리 | 화면이 형식을 먼저 검사한다. 바꾸면 화면도 함께 고쳐야 한다 |
| 코드 유효 시간 | 5분 (`expires_in: 300`) | 화면은 응답 값을 따른다 |
| 재발송 대기 | 60초 (`resend_after: 60`) | 화면은 응답 값을 따른다. 새 코드를 보내면 이전 코드는 무효 |
| 시도 제한 | 5번 틀리면 코드 폐기 | 무차별 대입 방지 |
| 인증 유효 시간 | 30분 (`expires_in: 1800`) | 이 안에 가입을 끝내야 한다 |

Redis 키 예: `email_code:{이메일}` (값: 코드 해시·시도 횟수, TTL 5분), `email_code_cooldown:{이메일}` (TTL 60초), `email_verified:{이메일}` (TTL 30분). 이메일은 §2.6의 소문자 정규화를 거친 값으로 쓴다.
코드는 서버 로그에 남기지 않는다. 화면의 콘솔 로그도 `code` 값을 가린다.

### 2.2 회원가입 `POST /api/auth/signup`

```json
// 요청 — 비밀번호 확인 칸은 화면에서만 검사하고 보내지 않는다.
{ "email": "carol@example.com", "password": "carol-password", "name": "캐롤" }
```

```json
// 201 Created — 비밀번호(해시 포함)는 절대 응답에 넣지 않는다.
{ "id": 3, "email": "carol@example.com", "name": "캐롤", "created_at": "2026-10-30T02:00:00Z" }
```

| 상태 | 언제 | 본문 예 | 화면 |
|---|---|---|---|
| `201` | 가입 성공 | 위 사용자 | 로그인 화면으로 이동, "회원가입이 완료되었어요" 안내, 이메일 채워 둠. **자동 로그인하지 않는다** |
| `403` | 이메일 인증을 안 했거나 인증 유효 시간이 지남 | `{"detail": "이메일 인증이 필요합니다."}` | "이메일 인증이 만료되었어요" 안내 후 인증부터 다시 |
| `409` | 이미 가입된 이메일 | `{"detail": "이미 가입된 이메일입니다."}` | 이메일 칸 아래 안내, 인증부터 다시 |
| `422` | 이메일 형식·비밀번호 길이·이름 길이 위반 | Pydantic 기본 `detail` 배열 (`loc: ["body","email"]`, `["body","name"]` 등) | 해당 칸 아래 `msg` 표시 |

- 화면은 응답에 `id`와 `email`(문자열)이 있는지 확인한다. `name`은 상단 표시에 쓰고, 없으면 이메일을 대신 보여준다.
- 서버는 화면의 인증 표시를 믿지 않고 `email_verified` 기록을 직접 확인한다. 가입에 성공하면 그 기록을 지운다.
- 인증 여부는 서버가 Redis 기록으로 확인한다. `signup` 요청에는 이메일·비밀번호·이름만 담긴다.

### 2.3 로그인 `POST /api/auth/login` (OAuth2 Password 방식)

FastAPI의 `OAuth2PasswordRequestForm` 형식이다. **JSON이 아니라 form**으로 보낸다. `username`에 이메일을 넣는다.

```http
POST /api/auth/login
Content-Type: application/x-www-form-urlencoded

grant_type=password&username=carol%40example.com&password=carol-password
```

```json
// 200 OK
{ "access_token": "<JWT>", "token_type": "bearer", "expires_in": 3600 }
```

| 필드 | 형식 | 화면에서 쓰는 방법 |
|---|---|---|
| `access_token` | 문자열 (필수) | `Authorization: Bearer <access_token>`으로 보낸다. 화면은 내용을 해석하지 않는다(서명·만료 검증은 서버 몫) |
| `token_type` | `"bearer"` | 다른 값이면 계약 위반으로 처리 |
| `expires_in` | 초 단위 정수 | 저장할 때 만료 시각을 계산해 둔다. 새로고침 때 이미 지났으면 `/me`를 부르지 않고 로그인 화면으로 보낸다 |

| 상태 | 언제 | 본문 예 | 화면 |
|---|---|---|---|
| `200` | 성공 | 위 토큰 | 토큰 저장 → `GET /api/me` → 할 일 화면 |
| `401` | 이메일 없음 **또는** 비밀번호 틀림 | `{"detail": "이메일 또는 비밀번호가 올바르지 않습니다."}` | **로그인 화면 안에서** "이메일 또는 비밀번호가 올바르지 않아요." 표시. 비밀번호 칸 비움. 세션 만료 처리와 섞지 않는다 |
| `422` | `username`·`password` 누락 | Pydantic 기본 형식 (`loc: ["body","username"]`) | `username` 오류를 이메일 칸 아래에 표시 |

- 두 실패 경우(없는 이메일, 틀린 비밀번호)에 **같은 문구·같은 상태 코드**를 쓴다.
- `OAuth2PasswordBearer(tokenUrl="api/auth/login")`로 설정하면 Swagger의 "Authorize" 버튼도 같은 엔드포인트를 쓴다.
- 응답에 FastAPI 튜토리얼의 두 필드만 주지 말고 `expires_in`도 넣는다. 튜토리얼 예제에는 없는 필드다.
- `username`은 서버에서 이메일과 같은 규칙으로 앞뒤 공백 제거·소문자 정규화해서 찾는다(§2.6).
- 로그인 시도 횟수 제한은 첫 버전에 넣지 않는다. 나중에 넣으면 `429`로 주면 화면은 일반 오류로 안내한다.

### 2.4 현재 사용자 `GET /api/me`

```http
GET /api/me
Authorization: Bearer <access_token>
```

```json
// 200 OK
{ "id": 3, "email": "carol@example.com", "name": "캐롤", "created_at": "2026-10-30T02:00:00Z" }
```

화면은 로그인 후 상단에 `name`을 "캐롤님"처럼 표시한다(이메일은 마우스를 올리면 보인다).

`401`이면 화면은 저장된 토큰을 지우고 로그인 화면으로 보낸다. 그 밖의 실패(연결 실패, `5xx`)면 토큰은 지우지 않고 "다시 시도" 버튼을 보여준다.

### 2.5 인증이 필요한 요청의 `401`

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer
{"detail": "Not authenticated"}
```

- 헤더 없음, 서명 불일치, 만료, 탈퇴한 사용자 등 **로그인을 다시 해야 하는 모든 경우는 `401`**로 준다. 본문 문구는 화면에 보이지 않는다(화면 고정 문구를 쓴다).
- 남의 할 일은 `401`이 아니라 `403`으로 준다(§4). 화면은 `401`만 로그아웃 처리하고, `403`·`404`는 안내만 한다.

### 2.6 이메일·비밀번호·이름 검증 규칙

화면도 같은 규칙으로 먼저 검사하지만, 최종 판단은 서버가 한다.

| 항목 | 규칙 | 화면 동작 |
|---|---|---|
| 이메일 | 앞뒤 공백 제거, 1~254자, `이름@도메인.최상위` 형식 검사 후 **인증코드로 소유 확인**(§2.1) | 공백을 빼고 보낸다. 형식이 틀리면 `올바른 이메일 형식이 아닙니다`를 표시하고 코드를 요청하지 않는다. 길이보다 형식을 먼저 본다 |
| 이메일 비교 | **소문자로 바꿔 저장·비교** (`Carol@Example.com` = `carol@example.com`) | 입력한 그대로 보낸다 |
| 비밀번호 | **8~64자**(문자 수), 공백 포함 허용, 앞뒤 공백도 그대로(자르지 않음), 영문·숫자·특수문자 조합 강제 없음 | 자르지 않고 보낸다 |
| 이름 (`name`) | **필수. 앞뒤 공백 제거 후 1~20자**(문자 수), 내부 공백 포함. 중복 허용 | 앞뒤 공백을 빼고 보낸다. 비었거나 20자를 넘으면 이름 칸 아래 안내 |
| 비밀번호 확인 | 화면에서만 검사 | API에 보내지 않는다 |
| 로그인 시 비밀번호 | 비어 있지 않은지만 확인 (길이 규칙은 가입할 때만) | 같다 |

- 이메일 형식은 Pydantic `EmailStr`(email-validator 패키지 필요)로 검사해도 된다. 화면 규칙보다 엄격해도 문제없다. 발송 요청의 `422`는 화면이 같은 문구로 바꿔 보여주므로 서버 문구를 맞출 필요는 없다.
- 이 단계는 **형식만** 본다. 도메인이 실제로 있는지(DNS·MX)는 검사하지 않고, 메일이 실제로 도착하는지는 인증코드로 확인한다. `EmailStr`의 기본 동작도 같다.
- 비밀번호는 반드시 해시로 저장한다(예: argon2, bcrypt). **bcrypt는 72바이트까지만 쓰므로** 한글 비밀번호 64자(최대 192바이트)는 잘린다. 8~64자 규칙은 유지하므로, bcrypt를 쓴다면 긴 입력을 어떻게 처리할지 구현할 때 정해야 한다(argon2는 이 제한이 없다).
- **422 응답에 비밀번호가 다시 담기지 않게 한다.** FastAPI 기본 422 응답의 `input`에는 보낸 값이 그대로 들어간다. 화면은 `input`을 보여주지 않고 콘솔 로그에서도 가리지만, 서버 응답·서버 로그에도 남지 않게 `RequestValidationError` 처리기에서 `input`을 빼는 것을 권장한다.

### 2.7 토큰

| 항목 | 내용 |
|---|---|
| 형식 | JWT (HS256), 서버 비밀키는 환경 변수로. 코드·저장소에 넣지 않는다 |
| 클레임 | `sub`: 사용자 id(문자열), `exp`: 만료 시각. 이메일 등 개인 정보는 넣지 않는 안 |
| 수명 | 60분 (`expires_in: 3600`) |
| 갱신 | 없음. 만료되면 다시 로그인한다 (refresh token은 이번 범위 아님) |
| 폐기 | 없음. 서버는 토큰을 기억하지 않는다 (§3.5 참고) |

## 3. 화면의 세션 처리

백엔드가 알아 두면 좋은 화면 동작이다. 구현은 [`js/session.js`](js/session.js), [`js/api.js`](js/api.js), [`js/app.js`](js/app.js).

### 3.1 저장 위치: `sessionStorage`

- 키 `steptodo:session:v1`에 `{ accessToken, expiresAt }`을 저장한다.
- 새로고침해도 유지되고, **탭을 닫으면 사라지며, 다른 탭과 공유하지 않는다.** 새 탭에서는 다시 로그인한다.
- localStorage보다 노출 기간이 짧다. 다만 페이지에 XSS가 있으면 sessionStorage든 localStorage든 스크립트로 읽힌다. 화면은 모든 사용자 입력을 `textContent`로 그려서(HTML로 해석하지 않음) XSS를 막고 있다.
- 첫 버전은 Bearer 헤더 방식으로 간다. (HttpOnly 쿠키는 스크립트로 읽을 수 없어 더 안전하지만 CSRF 대응과 CORS `allow_credentials` 설정이 필요하다.)
- 토큰은 **URL·쿼리스트링·콘솔 로그에 남기지 않는다.** 화면의 콘솔 로그는 응답 본문의 `password`·`token`·`input` 값을 `[redacted]`로 바꿔 찍는다.

### 3.2 새로고침 시 로그인 복원

```
저장된 토큰 없음                 → 로그인 화면
저장된 만료 시각이 지남           → 토큰 삭제, 로그인 화면 + "로그인이 만료되었어요" (서버 요청 없음)
그 밖                            → "로그인 상태를 확인하는 중…" → GET /api/me
   200                           → 할 일 화면 (주소의 필터·정렬·페이지 유지)
   401                           → 토큰 삭제, 로그인 화면 + 만료 안내
   연결 실패·5xx                  → 토큰 유지, "다시 시도" / "다시 로그인하기"
```

로그인 전에는 할 일 화면을 그리지 않고 할 일 API도 부르지 않는다. 다만 **화면을 숨기는 것은 보안이 아니다.** 보호는 서버의 `401`·소유권 검사로 한다.

### 3.3 만료 처리

- 기준은 **서버의 `401`**이다. `expires_in`은 새로고침 때 결과가 뻔한 요청을 건너뛰는 데만 쓴다.
- 인증이 필요한 요청이 `401`을 받으면 화면은 **한 번만** 다음을 한다. 동시에 여러 요청이 `401`을 받아도 한 번이다.
  1. 토큰 삭제
  2. 진행 중인 요청 중단(abort). 아직 도착하지 않은 응답은 무시한다.
  3. 사용자·목록·상세·입력·오류·필터 상태를 초기화한다.
  4. 로그인 화면에 "로그인이 만료되었거나 유효하지 않아요. 다시 로그인해 주세요." 안내를 띄운다.
- **로그인 요청의 `401`은 예외**다. 로그인 화면 안에서 실패로 안내한다.

### 3.4 로그아웃

로그아웃 버튼은 **화면에서만** 처리한다. 서버에 요청을 보내지 않는다(로그아웃 API 없음). 순서는 이렇다.

1. 토큰 삭제
2. 진행 중인 요청 중단, 늦게 도착한 응답 무시
3. 상태 초기화
4. 로그인 화면으로 이동

### 3.5 프론트 로그아웃과 서버 토큰 만료의 차이

| | 프론트 로그아웃 (버튼) | 서버 토큰 만료 (`exp` 지남) |
|---|---|---|
| 일어나는 곳 | 이 브라우저 탭 | 서버가 매 요청마다 판단 |
| 토큰 자체 | **서버에서는 `exp`까지 여전히 유효**. 이 탭이 버렸을 뿐이다 | 모든 곳에서 무효 |
| 다른 곳에 복사된 토큰 | (유출됐다면) 만료 전까지 계속 쓸 수 있다 | 쓸 수 없다 |
| 화면 반응 | 즉시 로그인 화면 | 다음 요청이 `401` → 로그인 화면 + 만료 안내 |

로그아웃 후에도 만료 전까지는 토큰이 살아 있다. 이것을 막으려면 서버 쪽 폐기(차단 목록, 토큰 버전 등)가 필요한데, **이번 범위에는 넣지 않는다.** 대신 토큰 수명을 짧게(60분) 가져간다.

### 3.6 사용자 전환과 늦게 도착한 응답

- 로그인·로그아웃·만료 때마다 화면은 세션 번호(epoch)를 올린다. **요청을 보낼 때와 응답이 왔을 때의 세션 번호가 다르면, 그 응답은 성공이든 실패든 화면에 반영하지 않는다.** 실제 서버 요청은 abort도 한다.
- 그래서 A 사용자가 보낸 느린 요청이 B로 로그인한 뒤에 도착해도 B의 화면에 섞이지 않는다.
- 다만 이미 서버에 도착한 요청(예: A의 완료 전환)은 서버에서 처리됐을 수 있다. 화면은 결과만 무시한다.

## 4. 사용자별 할 일 규칙

- **소유자는 서버가 토큰으로 정한다.** 할 일 생성 요청에 소유자 ID를 넣지 않는다. 화면은 `title`, `description`, `due_date`만 보낸다.
- **생성 본문에 `user_id`·`owner_id` 같은 필드가 오면 `422`로 거절한다.** Pydantic `model_config = ConfigDict(extra="forbid")`로 처리한다(`type: "extra_forbidden"`, `loc: ["body", "owner_id"]`). 화면은 이 필드를 보내지 않으므로 평소에는 볼 일이 없다.
- 목록은 로그인한 사용자의 할 일만 준다. `total`도 그 사용자 기준이다.
- 상세·수정·완료·삭제에서 **남의 할 일 id는 `403`, 없는 id는 `404`**를 준다. id로 찾은 뒤 주인을 확인하는 순서다.

  ```python
  todo = db.get(Todo, todo_id)
  if todo is None:
      raise HTTPException(404, "Todo not found")
  if todo.user_id != current_user.id:
      raise HTTPException(403, "Not enough permissions")
  ```
- `403` 화면 동작: 상세 창이면 창 안에서 "이 할 일을 볼 권한이 없어요" + 목록으로 돌아가기, 목록에서 누른 경우는 토스트 + 목록 재조회, 수정 저장 중이면 토스트 후 입력 유지. 어느 쪽이든 로그아웃시키지 않는다.
- Todo 응답에 소유자 ID는 넣지 않는다. 화면이 쓰지 않는다.
- **화면이 목록을 숨기거나 거르는 것은 보안이 아니다.** 목록 쿼리에는 `WHERE user_id = :현재 사용자`를, 상세·수정·삭제에는 위의 주인 확인을 서버가 반드시 건다.
- **DB**: `todos.user_id`를 처음 설계할 때부터 `users.id`를 가리키는 외래 키(NOT NULL)로 둔다. 목록 정렬용으로 `(user_id, created_at)`, `(user_id, due_date)` 인덱스를 검토한다.

## 5. 할 일(Todo) 형식

```json
{
  "id": 1,
  "title": "FastAPI 튜토리얼 읽기",
  "description": "Path·Query 파라미터까지",
  "is_completed": false,
  "due_date": "2026-11-04",
  "created_at": "2026-10-30T02:00:00Z",
  "updated_at": "2026-10-30T02:00:00Z",
  "completed_at": null
}
```

| 필드 | 형식 | 규칙 |
|---|---|---|
| `id` | 정수 | 필수 |
| `title` | 문자열 | 필수. **앞뒤 공백 제거 후 1~100자, 내부 공백은 길이에 포함.** 앞뒤 공백을 뺀 값으로 저장. 같은 제목 중복 허용 |
| `description` | 문자열 \| `null` | 최대 2,000자. 비어 있으면 `null` |
| `is_completed` | 불리언 | 필수. 생성 시 `false` |
| `due_date` | `"YYYY-MM-DD"` \| `null` | 날짜만. 과거 날짜 허용 |
| `created_at` · `updated_at` | ISO 8601 시각 | 서버가 기록. 내용이 바뀌거나 완료 상태가 바뀌면 `updated_at` 갱신 |
| `completed_at` | ISO 8601 시각 \| `null` | 완료로 바꾸면 기록, 완료 취소하면 `null` |
| `is_overdue` | 불리언 (선택) | 보내면 화면이 그대로 쓰고, 없으면 화면이 계산한다 |

**제목 길이 기준**: 앞뒤 공백 제거 후 1~100자, 내부 공백은 길이에 포함한다.

| 보낸 값 | 저장되는 값 | 길이 | 결과 |
|---|---|---|---|
| `"  장 보기  "` | `"장 보기"` | 4 (가운데 공백 포함) | 허용 |
| `"     "` | — | 0 | `422` |
| 앞뒤에 공백이 붙은 100자 | 100자 | 100 | 허용 |
| 101자 | — | 101 | `422` |

- 길이는 **문자 수**(Python `len()`, 유니코드 코드 포인트)로 센다. 화면도 같은 방식으로 센다(이모지 1개 = 1자). 설명 2,000자, 이메일 254자, 비밀번호 8~64자, 이름 20자도 같은 기준이다.
- 공백은 Python `str.strip()`이 지우는 문자 기준이다. 화면의 `String.prototype.trim()`과 사실상 같다.
- Pydantic v2 예: `Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]`. 공백을 먼저 지우고 길이를 검사한다.
- 화면은 성공 응답이 `id`, `title`(문자열), `is_completed`(불리언)를 갖췄는지 확인한다. 빠지면 "서버 응답 형식이 예상과 다릅니다"를 띄우고 콘솔에 실제 응답을 찍는다.
- **시각에는 시간대를 붙인다** (`Z` 또는 `+09:00`). 시간대가 없으면 화면은 **UTC로 간주**한다. MySQL `DATETIME`은 시간대를 저장하지 않으므로, UTC로 저장하고 응답할 때 `Z`를 붙이는 방식을 권장한다.
- **기한 초과**: `due_date < 오늘(한국 시간)`이면서 미완료. 오늘이 마감이면 초과가 아니다. 서버에서 `is_overdue`를 계산한다면 같은 기준(Asia/Seoul)을 쓴다.

## 6. 목록 조회

`GET /api/todos?status=active&sort=due_date&page=2&size=10` (인증 필요)

| 파라미터 | 값 | 기본값 | 잘못된 값 |
|---|---|---|---|
| `status` | `all` · `active`(미완료) · `completed`(완료) | `all` | `422` |
| `sort` | `latest`(최신순) · `due_date`(마감일순) | `latest` | `422` |
| `page` | 1 이상 정수 | `1` | `422` |
| `size` | 1~100 정수. 화면은 5·10·20만 보낸다 | `10` | `422` |

```json
{ "items": [ /* Todo */ ], "total": 34, "page": 2, "size": 10 }
```

- `total`: **로그인한 사용자의** 할 일 중 필터를 적용한 개수(페이지를 나누기 전). 화면의 "총 N개 중 a–b"와 페이지 수가 이 값으로 계산된다.
- `page`: 실제로 돌려준 페이지 번호. 서버가 보정했다면(예: 범위를 넘으면 마지막 페이지로) 화면은 이 값을 따른다.
- **범위를 넘는 `page`**: 빈 `items`와 올바른 `total`을 주거나, 마지막 페이지로 보정해서 주면 된다. 빈 목록을 받으면 화면이 `ceil(total/size)` 페이지로 다시 요청한다. 삭제·완료 처리로 마지막 페이지가 비었을 때 앞 페이지로 이동하는 동작이 이 규칙에 기댄다.
- `items`가 배열이 아니거나 `total`이 정수가 아니면 화면은 계약 위반으로 처리한다. 목록을 배열 그대로 돌려주지 말 것.

**정렬 규칙** (Mock과 같게 맞추면 화면 결과가 일치한다)

| `sort` | 순서 |
|---|---|
| `latest` | `created_at` 내림차순 → `id` 내림차순 |
| `due_date` | `due_date` 오름차순, **날짜 없는 항목은 맨 뒤** → 같으면 `latest` 순서 |

> MySQL은 오름차순에서 `NULL`을 맨 앞에 둔다. SQLAlchemy 예:
> `order_by(Todo.due_date.is_(None), Todo.due_date.asc(), Todo.created_at.desc(), Todo.id.desc())`
>
> 정렬 기준이 완전히 결정되지 않으면(같은 값끼리 순서가 매번 달라지면) 페이지를 넘길 때 항목이 겹치거나 빠진다. 마지막에 `id`를 꼭 넣는다.

**화면이 보내는 추가 요청**: 필터(`active`/`completed`) 결과가 비면, 할 일이 아예 없는 것인지 구분하려고
`GET /api/todos?status=all&sort=latest&page=1&size=1`을 한 번 더 보낸다. 이 요청이 실패해도 화면은 필터 안내로 대신한다.

## 7. 추가 · 수정 · 완료 · 삭제 (모두 인증 필요)

**추가** `POST /api/todos` → `201`

```json
{ "title": "할 일", "description": null, "due_date": "2026-11-04" }
```

화면은 세 필드를 항상 보낸다. 비어 있는 값은 `null`로 보낸다. 소유자 ID는 보내지 않고, 이 세 필드 외의 값이 오면 서버는 `422`로 거절한다(§4).
제목은 앞뒤 공백을 빼서 보내지만, 서버도 [제목 길이 기준](#5-할-일todo-형식)대로 앞뒤 공백을 빼고 검사해야 한다.

**수정** `PATCH /api/todos/{id}` → `200` (바뀐 Todo 전체)

- 부분 수정: 보낸 필드만 바꾼다. 화면의 수정 창은 `title`, `description`, `due_date` 세 필드를 모두 보낸다.
- `description`, `due_date`에 `null`을 보내면 비운다. "마감일 지우기"가 이 방식이다.
- `title`에 `null`이나 공백만 보내면 `422`.
- 완료한 할 일도 수정할 수 있어야 한다. 수정해도 `is_completed`와 `completed_at`은 그대로 둔다.

**완료 / 완료 취소** `PATCH /api/todos/{id}` `{"is_completed": true}` 또는 `false` → `200`

- 같은 값을 다시 보내도 오류가 아니다. 이미 완료된 항목에 `true`를 보내면 `completed_at`은 처음 값을 유지하는 것을 권장한다.
- 화면은 이 응답이 성공한 뒤에야 체크 표시를 바꾼다.

**삭제** `DELETE /api/todos/{id}` → `204`

- 복구는 없다. 확인은 화면에서 받는다.
- 이미 지워졌으면 `404`, 남의 항목이면 `403`. 화면은 각각 안내하고 목록을 새로 받는다.

## 8. 오류 응답

FastAPI 기본 형식을 그대로 쓰면 된다.

| 상황 | 상태 코드 | 본문 | 화면 표시 |
|---|---|---|---|
| 토큰 없음·무효·만료 (인증 필요 요청) | `401` | `{"detail": "..."}` + `WWW-Authenticate: Bearer` | 상태 초기화 → 로그인 화면 + 만료 안내 (§3.3) |
| 로그인 실패 | `401` | `{"detail": "이메일 또는 비밀번호가 올바르지 않습니다."}` | 로그인 화면 안에서 안내 |
| 남의 할 일 | `403` | `{"detail": "Not enough permissions"}` | 상세 창이면 창 안에서 "이 할 일을 볼 권한이 없어요" + **목록으로 돌아가기**. 그 밖에는 "이 작업을 할 권한이 없어요. (서버 문구)" 토스트. **로그아웃하지 않음** |
| 이메일 미인증 (가입) | `403` | `{"detail": "이메일 인증이 필요합니다."}` | 인증부터 다시 하도록 안내 |
| 없는 `id` | `404` | `{"detail": "Todo not found"}` | 상세 창이면 창 안에서 "할 일을 찾을 수 없어요" + **목록으로 돌아가기**. 목록에서 누른 경우는 토스트 + 목록 재조회. 로그아웃하지 않음 |
| 틀리거나 만료된 인증코드 | `400` | `{"detail": "인증코드가 올바르지 않습니다."}` | 코드 칸 아래에 `detail` 표시 |
| 이메일 중복 | `409` | `{"detail": "이미 가입된 이메일입니다."}` | 이메일 칸 아래 안내 |
| 재발송 대기·시도 초과 | `429` | `{"detail": "..."}` | 이메일·코드 칸 아래에 `detail` 표시 |
| 본문 검증 실패 | `422` | Pydantic 기본 `detail` 배열 | `loc: ["body", "<필드>"]`의 `msg`를 해당 입력칸 아래에 표시. 입력 내용은 유지 |
| 쿼리·경로 검증 실패 | `422` | `loc: ["query", "status"]` 등 | 목록 위 빨간 안내 + 다시 시도 |
| 서버 오류 | `5xx` | 무엇이든 | "서버 오류가 발생했습니다 (500)" + **요청 ID** |
| 연결 실패 · CORS 차단 | — | — | "API 서버에 연결할 수 없습니다" 안내 |

```jsonc
// 422 예시
{
  "detail": [
    { "type": "string_too_short", "loc": ["body", "title"], "msg": "String should have at least 1 character", "input": "" },
    { "type": "date_from_datetime_parsing", "loc": ["body", "due_date"], "msg": "Input should be a valid date", "input": "2026-02-30" }
  ]
}
```

- 필드 이름은 `title`, `description`, `due_date`, `is_completed`, `email`, `password`, `name`, `code`를 그대로 쓴다. 이 이름이 화면의 입력칸과 연결된다. 로그인의 `username`은 이메일 칸에 연결한다.
- `msg`는 그대로 화면에 보인다. 한국어로 보이게 하려면 서버에서 `msg`만 바꾸면 된다. 화면은 `input`을 쓰지 않는다. 그래도 `msg`에 비밀번호가 들어 있으면 `•••`로 가린다.
- 직접 만든 형식 `{"detail": {"message": "..."}}`, `{"message": "..."}`도 읽는다.

## 9. 필요한 백엔드 설정

**CORS**: 화면(예: `:5500`)과 API(`:8000`)의 출처가 다를 때만 필요하다. Nginx 뒤에서 같은 출처가 되면 없어도 된다.
**`Authorization` 헤더 허용이 새로 필요하다.**

```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5500", "http://127.0.0.1:5500"],
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["Content-Type", "Authorization", "X-Request-ID"],
    # 헤더(Bearer) 방식이므로 allow_credentials는 필요 없다.
)
```

로그인의 `application/x-www-form-urlencoded`는 CORS에서 따로 허용하지 않아도 되지만, 위 설정의 `Content-Type` 허용은 JSON 요청 때문에 그대로 필요하다.

- **요청 ID**: 화면은 모든 요청에 `X-Request-ID: <UUID>` 헤더를 붙인다. 서버가 이 값을 로그에 남기면, 5xx 토스트와 브라우저 콘솔에 찍힌 요청 ID로 서버 로그를 바로 찾을 수 있다. CORS에서 이 헤더를 허용하지 않으면 모든 요청이 막힌다.
- **로그 위생**: 서버 로그에 `Authorization` 헤더, 요청 본문의 `password`, 인증코드, 422의 `input`을 남기지 않는다.
- **비밀값**: JWT 서명 키, DB 비밀번호, SMTP 계정, Redis 비밀번호는 환경 변수로 주입한다. 코드·저장소·이미지에 넣지 않는다.
- **새로 필요한 인프라**: 이메일 인증에 SMTP 서버와 Redis가 필요하다. 로컬 실행(Docker Compose)과 배포 환경에 Redis 서비스와 SMTP 설정을 추가해야 한다.
- **처리 중 중복 요청**: 화면은 저장·완료 전환·삭제·로그인·가입이 끝날 때까지 같은 요청을 다시 보내지 않는다. 이것은 화면의 편의 기능이고 서버의 보장은 아니다. 첫 버전에서 POST 중복 생성 방지는 보장하지 않는다. 같은 제목의 항목도 별도로 생성한다.

## 10. 기존 데이터 처리

**Mock 데이터 (화면 쪽)**: 로그인 기능 전의 Mock 데이터(localStorage `steptodo:mock-db:v1`, 사용자 구분 없음)가 있으면 처음 열 때 새 형식(`v2`)으로 옮긴다. 기존 할 일은 **첫 번째 테스트 사용자(alice)의 것**이 되고 v1 키는 지운다. 할 일 id는 그대로 유지한다.

**실제 DB**: 설계 단계부터 `todos` 엔티티에 사용자 id 외래 키를 둔다. 소유자 없는 행이 생기지 않으므로 별도 마이그레이션은 필요 없다.

## 11. Mock 인증 (동작 검증용)

> ⚠️ Mock 인증은 **화면 흐름을 확인하기 위한 흉내**이고 실제 JWT 보안 검증이 아니다.
> 토큰은 JWT가 아닌 임의 문자열(`mock-token.<uuid>`)이고, 서명·만료는 Mock 내부 표만 본다.
> 비밀번호는 소금 없는 SHA-256으로 브라우저 localStorage에 저장된다. 실제 비밀번호를 넣지 말 것.
> 사용자별 분리도 흉내다. 실제 소유권 검사는 백엔드 책임이다.
> 이메일 인증코드는 메일을 보내지 않고 화면의 "Mock 메일함"에 표시한다. 이 표시는 Mock에서만 나타난다.
> `?mock=1`은 `localhost`·`127.0.0.1`에서만 켜진다. 배포 주소에서는 무시된다.

- 테스트 계정: `alice@example.com`, `bob@example.com` / 비밀번호 `password123`. 각자 다른 예시 할 일을 갖고 있다.
- 실패 재현 (주소 옵션, 콘솔 `steptodoMock.configure({...})`로도 바꿀 수 있다)

| 재현할 상황 | 방법 |
|---|---|
| 잘못된 로그인 | 틀린 비밀번호로 로그인 → `401` |
| 중복 이메일 | `alice@example.com`으로 코드 받기 → `409` |
| 틀린 인증코드 | 다른 숫자 입력 → `400`, 5번 틀리면 `429` |
| 인증코드 만료 | `?mock=1&mockCodeTtl=5` (5초) |
| 재발송 대기 | 기본 60초. `&mockResendAfter=3`으로 줄일 수 있다 |
| 인증 후 가입 시간 초과 | `&mockVerifiedTtl=5` → 가입 `403` |
| 인증 누락 | Mock은 `Authorization` 헤더가 없으면 `401` (단위 테스트로 확인) |
| 서버에서 토큰 만료 | 콘솔 `steptodoMock.expireSessions()` → 다음 요청 `401` |
| 짧은 토큰 수명 | `?mock=1&mockTokenTtl=10` (10초) |
| 로그인·가입·/me·메일 발송 실패 | `&mockFail=login` 또는 `signup`, `me`, `emailSend`, `emailVerify` + `&mockFailStatus=500` (`0`이면 연결 실패) |
| 권한 없음 | `&mockFail=update&mockFailStatus=403`. Mock은 다른 사용자의 할 일 id에 실제로 `403`을 준다 |
| 다른 곳에서 지워진 항목 | 콘솔 `steptodoMock.remove(id)` |
| 느린 응답 | `&mockDelay=1500` |
| 처음 상태로 | 콘솔 `steptodoMock.reset()` (모든 Mock 로그인도 끊긴다) |

## 12. 연동 확인 순서

백엔드를 띄운 뒤 아래 순서로 확인하면 화면과 계약이 맞는지 빠르게 알 수 있다.

```bash
API=http://localhost:8000/api
J='Content-Type: application/json'

# 이메일 인증 + 회원가입
curl -s -X POST "$API/auth/email-verification/send" -H "$J" -d '{"email":"carol@example.com"}'           # 200 {expires_in,resend_after}, 코드는 메일로만
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/auth/email-verification/send" -H "$J" -d '{"email":"carol@example.com"}'  # 429 (재발송 대기)
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/auth/signup" -H "$J" -d '{"email":"carol@example.com","password":"carol-password","name":"캐롤"}'  # 403 (인증 전)
curl -s -X POST "$API/auth/email-verification/verify" -H "$J" -d '{"email":"carol@example.com","code":"<메일로 받은 코드>"}'  # 200 {verified:true,...}
curl -s -X POST "$API/auth/signup" -H "$J" -d '{"email":"carol@example.com","password":"carol-password","name":"캐롤"}'  # 201 {id,email,name,...}, 비밀번호 없음
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/auth/email-verification/send" -H "$J" -d '{"email":"Carol@Example.com"}'  # 409

# 로그인 (OAuth2 form)
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/auth/login" -d 'grant_type=password&username=carol@example.com&password=wrong-pass'  # 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/auth/login" -H "$J" -d '{"email":"carol@example.com","password":"carol-password"}'    # 422 (JSON은 받지 않음)
TOKEN=$(curl -s -X POST "$API/auth/login" -d 'grant_type=password&username=carol@example.com&password=carol-password' | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
A="Authorization: Bearer $TOKEN"
curl -s "$API/me" -H "$A"                                              # 200 {id,email,...}
curl -s -o /dev/null -w '%{http_code}\n' "$API/todos"                  # 401 (헤더 없음)
curl -s -o /dev/null -w '%{http_code}\n' "$API/todos" -H 'Authorization: Bearer nope'  # 401

# 할 일
curl -s "$API/todos" -H "$A" | python3 -m json.tool                   # { items, total, page, size }
curl -s -X POST "$API/todos" -H "$A" -H "$J" -d '{"title":"  연동 확인  ","description":null,"due_date":null}'  # 201, title "연동 확인"
curl -s -X POST "$API/todos" -H "$A" -H "$J" -d '{"title":"주인 지정","user_id":999}'  # 422, type extra_forbidden
curl -s -X POST "$API/todos" -H "$A" -H "$J" -d '{"title":"   "}'     # 422, loc ["body","title"]
curl -s -X PATCH "$API/todos/1" -H "$A" -H "$J" -d '{"is_completed":true}'   # completed_at 채워짐
curl -s -X PATCH "$API/todos/1" -H "$A" -H "$J" -d '{"due_date":null}'       # 마감일 비우기
curl -s "$API/todos?sort=due_date&size=100" -H "$A"                    # 날짜 없는 항목이 맨 뒤
curl -s "$API/todos?status=weird" -H "$A"                              # 422
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE "$API/todos/1" -H "$A"   # 204
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE "$API/todos/1" -H "$A"   # 404

# 다른 사용자 (소유권): 두 번째 계정으로 로그인한 뒤 첫 계정의 할 일 id로 GET/PATCH/DELETE → 모두 403, 없는 id는 404, 목록 total은 각자 따로

# CORS
curl -s -i -X OPTIONS "$API/todos" -H 'Origin: http://localhost:5500' \
     -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: authorization,content-type,x-request-id'
```

그다음 `config.js`의 `useMock: false` 상태로 <http://localhost:5500>을 열어 실제 화면에서 같은 흐름을 확인한다.
이메일 인증 → 가입 → 로그인 → 할 일 관리 → 새로고침 → 로그아웃 → 다른 계정 로그인 순서로 본다.
화면에 "서버 응답 형식이 예상과 다릅니다"가 뜨면 브라우저 콘솔에 실제 응답(비밀번호·토큰은 가림)과 기대 형식이 함께 찍혀 있다.

## 13. 합의 결과

| # | 항목 | 결정 |
|---|---|---|
| 1 | 로그인 요청 형식 | **OAuth2 Password form** (`username`·`password`, `OAuth2PasswordRequestForm`) |
| 2 | 토큰 응답·수명 | `{access_token, token_type: "bearer", expires_in}`, 60분, refresh 없음 |
| 3 | JWT 클레임 | `sub`=사용자 id, `exp`. 개인 정보 넣지 않음 |
| 4 | 이메일 규칙 | 앞뒤 공백 제거, 소문자 정규화, 254자. **형식만 먼저 검사**(틀리면 `올바른 이메일 형식이 아닙니다`), 통과하면 **SMTP + Redis 인증코드로 인증** |
| 5 | 비밀번호 규칙 | 8~64자, 자르지 않음, 조합 강제 없음 |
| 6 | 중복 이메일 응답 | `409` |
| 7 | 남의 할 일 접근 | **`403`** (없는 id는 `404`) |
| 8 | 생성 본문의 소유자 필드 | **`422`** (`extra="forbid"`) |
| 9 | Todo 응답의 소유자 ID | 넣지 않음 |
| 10 | 422의 `input` 값 | 응답·로그에서 제거 (특히 비밀번호) |
| 11 | 기존 `todos` 행의 소유자 | **설계 단계부터 사용자 id 외래 키**. 별도 마이그레이션 없음 |
| 12 | 토큰 저장 방식 | sessionStorage + Bearer 헤더 |
| 13 | 로그인 시도 제한 | 첫 버전 없음 |
| 14 | 사용자 이름 | **`name` 필수**, 앞뒤 공백 제거 후 1~20자. 가입 요청·가입 응답·`/me` 응답에 포함. 화면 상단에 "OO님"으로 표시 (2026-11-14 추가) |

## 14. 이메일 인증 세부 합의

모두 Mock에 같은 형식으로 구현되어 있다. 구현하다 바꿔야 하면 마지막 열에서 화면 영향을 확인한다.

| # | 항목 | 결정 | 바꾸면 화면에 미치는 영향 |
|---|---|---|---|
| 1 | 인증 시점 | 가입 **전**에 인증 (미인증 계정 없음) | 가입 후 인증으로 바꾸면 흐름 변경, 로그인에도 미인증 처리 추가 |
| 2 | 발송·확인 경로 | `POST /api/auth/email-verification/send`, `.../verify` | `js/api.js`의 경로만 수정 |
| 3 | 응답 필드 | 발송 `{expires_in, resend_after}`, 확인 `{verified, expires_in}` | `js/api.js`와 표시 수정 |
| 4 | 코드 형식 | 숫자 6자리 | 화면 입력 검사 수정 |
| 5 | 시간·횟수 | 코드 5분, 재발송 60초, 5회 시도, 인증 유효 30분 | 시간은 응답 값을 따르므로 수정 없음 |
| 6 | 틀린 코드 상태 코드 | `400` (만료도 같음) | 코드 칸 처리 수정 |
| 7 | 재발송·시도 초과 | `429` | 표시 수정 |
| 8 | 가입 시 인증 확인 | 서버가 Redis 기록 확인, 미인증은 `403` | 일회용 토큰 방식이면 `signup` 요청에 필드 추가 |
| 9 | 이미 가입된 이메일 확인 시점 | 코드 **발송 단계**에서 `409`, 코드를 보내지 않음 | 발송 단계에서 빼면 가입 단계의 `409`로 안내하며 화면 수정 없음 |
