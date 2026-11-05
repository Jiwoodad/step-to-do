// 개발·테스트용 정적 서버. 배포 대상 파일(index.html, config.js, css/, js/)만 내보낸다.
//   npm run serve            → http://127.0.0.1:5500/?mock=1
//   PORT=8080 npm run serve
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url))); // frontend/
const SERVED = ["index.html", "config.js", "css/", "js/"]; // tests/, node_modules/, 문서는 내보내지 않는다.
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

export function startServer({ port = 0, host = "127.0.0.1" } = {}) {
  const server = createServer(async (req, res) => {
    let path;
    try {
      path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    } catch {
      res.writeHead(400).end("Bad Request");
      return;
    }
    const relative = normalize(path === "/" ? "/index.html" : path).replace(/^[/\\]+/, "").split(sep).join("/");
    const file = resolve(ROOT, relative);
    const allowed = file.startsWith(ROOT + sep) && SERVED.some((entry) => relative === entry || (entry.endsWith("/") && relative.startsWith(entry)));
    if (!allowed) {
      res.writeHead(404).end("Not Found");
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
      res.end(body);
    } catch {
      res.writeHead(404).end("Not Found");
    }
  });

  return new Promise((resolveStart, rejectStart) => {
    server.once("error", rejectStart);
    server.listen(port, host, () => {
      const { port: actualPort } = server.address();
      resolveStart({
        origin: `http://${host}:${actualPort}`,
        close: () => new Promise((done) => {
          server.closeAllConnections?.();
          server.close(() => done());
        }),
      });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 5500);
  const { origin } = await startServer({ port });
  console.log(`StepTodo 화면: ${origin}/?mock=1  (실제 API: ${origin}/ , 종료: Ctrl+C)`);
}
