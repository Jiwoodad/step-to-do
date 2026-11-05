// StepTodo 화면 설정. 실행 환경이 바뀌면 이 파일만 바꿔 끼우면 된다.
window.STEPTODO_CONFIG = {
  // FastAPI 주소 + 경로 접두사.
  // - 로컬 개발: "http://localhost:8000/api" (FastAPI에 CORS 설정 필요)
  // - Nginx가 /api 요청을 FastAPI로 넘겨주는 환경: "/api"
  apiBaseUrl: "http://localhost:8000/api",

  // true면 백엔드 없이 브라우저 localStorage에 저장하는 가짜 API를 쓴다.
  // 주소 뒤에 ?mock=1 을 붙여도 켜진다. (?mock=0 이면 끔. localhost·127.0.0.1에서만 동작)
  // Mock의 로그인은 흐름 확인용 흉내이며 실제 인증이 아니다. 배포 환경에서는 반드시 false.
  useMock: false,
};
