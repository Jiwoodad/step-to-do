// 로그인 세션(access token) 보관.
//
// - 저장 위치: sessionStorage. 새로고침해도 유지되고, 탭을 닫으면 사라지며, 다른 탭과 공유하지 않는다.
//   (localStorage보다 노출 기간이 짧다. 다만 XSS가 있으면 어느 쪽이든 읽힐 수 있다 → API.md 참고)
// - 토큰은 URL·콘솔 로그에 남기지 않는다. 이 모듈 밖에서는 Authorization 헤더를 만들 때만 꺼낸다.
// - epoch: 로그인·로그아웃·만료 때마다 1씩 오른다. 요청을 보낼 때의 epoch와 응답이 왔을 때의 epoch가
//   다르면 이전 세션의 응답이므로 화면에 반영하지 않는다. (api.js)
const STORAGE_KEY = "steptodo:session:v1";

function readStored() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return typeof data?.accessToken === "string" && data.accessToken ? data : null;
  } catch {
    return null;
  }
}

export function createSession() {
  let current = readStored(); // { accessToken, expiresAt: number | null }
  let epoch = 0;
  const controllers = new Set();

  function persist() {
    try {
      if (current) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(current));
      else sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // 저장소를 못 쓰면 이 탭의 메모리에서만 유지된다. (새로고침하면 다시 로그인)
    }
  }

  function abortInFlight() {
    for (const controller of controllers) controller.abort();
    controllers.clear();
  }

  return {
    get epoch() {
      return epoch;
    },
    get accessToken() {
      return current?.accessToken ?? null;
    },
    hasToken() {
      return Boolean(current);
    },
    /** 로그인 응답의 expires_in으로 계산한 만료 시각이 지났는지. 모르면 false — 최종 판단은 서버의 401. */
    isExpired(now = Date.now()) {
      return Boolean(current?.expiresAt && now >= current.expiresAt);
    },
    /** 로그인 성공: 진행 중인 이전 요청을 끊고 새 세션을 시작한다. */
    start({ access_token, expires_in }) {
      abortInFlight();
      epoch += 1;
      const seconds = Number(expires_in);
      current = {
        accessToken: access_token,
        expiresAt: Number.isFinite(seconds) && seconds > 0 ? Date.now() + seconds * 1000 : null,
      };
      persist();
    },
    /** 로그아웃·만료: 토큰을 지우고, 진행 중인 요청의 응답은 모두 버린다. (서버의 토큰은 만료 전까지 유효) */
    end() {
      abortInFlight();
      epoch += 1;
      current = null;
      persist();
    },
    /** fetch를 끊을 수 있게 등록한다. 반환한 함수로 등록을 해제한다. */
    track(controller) {
      controllers.add(controller);
      return () => controllers.delete(controller);
    },
  };
}
