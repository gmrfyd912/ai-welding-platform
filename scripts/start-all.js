#!/usr/bin/env node
/**
 * 개발 환경: Node.js Express 서버 + Python FastAPI 서버를 함께 시작.
 *
 * 사용: node scripts/start-all.js
 *   또는: npm run dev:all
 *
 * 환경 변수:
 *   FASTAPI_PORT  — FastAPI 포트 (기본 8080)
 *   PORT          — Node.js 포트 (기본 5000)
 *
 * Python uvicorn이 PATH에 있어야 합니다.
 *   pip install uvicorn fastapi openai anthropic httpx numpy opencv-python-headless python-multipart
 */

const { spawn } = require("child_process");
const path      = require("path");
const fs        = require("fs");

const os   = require("os");
const ROOT = path.resolve(__dirname, "..");
const FASTAPI_PORT = process.env.FASTAPI_PORT ?? "8080";
const NODE_PORT    = process.env.PORT          ?? "5000";

// 로컬 Wi-Fi IP 자동 감지 (모바일 기기가 접속해야 할 주소)
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        // 192.168.x.x 또는 10.x.x.x 대역 우선
        if (iface.address.startsWith("192.168.") || iface.address.startsWith("10.")) {
          return iface.address;
        }
      }
    }
  }
  return "127.0.0.1";
}
const LOCAL_IP = getLocalIP();

// .env 파일 파싱 → FastAPI 프로세스에 환경 변수로 전달
function loadDotEnv(envFile) {
  const envPath = path.join(ROOT, envFile);
  if (!fs.existsSync(envPath)) return {};
  const vars = {};
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // 따옴표 제거
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    vars[key] = val;
  }
  return vars;
}
const dotEnvVars = loadDotEnv(".env");
console.log(`[start-all] .env 로드: ${Object.keys(dotEnvVars).length}개 변수`);

function color(c, msg) {
  const codes = { cyan: "\x1b[36m", yellow: "\x1b[33m", red: "\x1b[31m", reset: "\x1b[0m" };
  return `${codes[c] ?? ""}${msg}${codes.reset}`;
}

function startProcess(label, cmd, args, env = {}) {
  const proc = spawn(cmd, args, {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
    shell: process.platform === "win32",
  });

  proc.stdout.on("data", (d) =>
    process.stdout.write(color("cyan", `[${label}] `) + d)
  );
  proc.stderr.on("data", (d) =>
    process.stderr.write(color("yellow", `[${label}] `) + d)
  );
  proc.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(color("red", `[${label}] 프로세스 종료 (code ${code})`));
    }
  });
  return proc;
}

// ── FastAPI (uvicorn) ──────────────────────────────────────────
const mainPy = path.join(ROOT, "main.py");
if (!fs.existsSync(mainPy)) {
  console.error(color("red", `[FastAPI] main.py not found at ${mainPy}`));
  process.exit(1);
}

// uvicorn 실행 파일 탐색 (우선순위 순)
const UVICORN_CANDIDATES = [
  process.env.UVICORN_PATH,                                                          // 환경 변수 우선
  path.join(process.env.APPDATA ?? "", "Python", "Python313", "Scripts", "uvicorn.exe"), // Windows 사용자 Python
  path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Python", "Python313", "Scripts", "uvicorn.exe"),
  "/usr/local/bin/uvicorn",                                                           // Linux/Mac
  "/usr/bin/uvicorn",
  "uvicorn",                                                                          // PATH 폴백
];
const uvicornCmd = UVICORN_CANDIDATES.find(
  (p) => p && (p === "uvicorn" || fs.existsSync(p))
) ?? "uvicorn";
console.log(color("cyan", `[FastAPI] uvicorn: ${uvicornCmd}`));

// PYTHONPATH: uvicorn의 site-packages 경로 추가 (openai/anthropic 포함)
const EXTRA_PYTHONPATH = path.join(process.env.APPDATA ?? "", "Python", "Python313", "site-packages");

const fastapi = startProcess(
  "FastAPI",
  uvicornCmd,
  ["main:app", "--host", "0.0.0.0", "--port", FASTAPI_PORT, "--reload"],
  {
    ...dotEnvVars,                                                         // .env 전체 주입
    FASTAPI_PORT,
    PYTHONPATH: `${EXTRA_PYTHONPATH}${path.delimiter}${process.env.PYTHONPATH ?? ""}`,
  }
);

// ── Node.js (tsx dev) ──────────────────────────────────────────
const nodeServer = startProcess(
  "Node",
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["cross-env", "NODE_ENV=development", "tsx", "--env-file=.env", "server/index.ts"],
  { PORT: NODE_PORT, FASTAPI_URL: `http://127.0.0.1:${FASTAPI_PORT}` }
);

// ── 종료 처리 ──────────────────────────────────────────────────
function shutdown() {
  console.log("\n[start-all] 종료 중...");
  fastapi.kill();
  nodeServer.kill();
  process.exit(0);
}
process.on("SIGINT",  shutdown);
process.on("SIGTERM", shutdown);

console.log(color("cyan", `
┌──────────────────────────────────────────────────────────┐
│  🔧 AI 용접 진단 — 개발 서버 시작                          │
│                                                          │
│  FastAPI  → http://127.0.0.1:${FASTAPI_PORT}                   │
│  Node.js  → http://127.0.0.1:${NODE_PORT}                   │
│                                                          │
│  📱 모바일(Expo Go) 접속 주소:                            │
│     http://${LOCAL_IP}:${NODE_PORT}                         │
│                                                          │
│  Expo 시작: EXPO_PUBLIC_DOMAIN=http://${LOCAL_IP}:${NODE_PORT} npx expo start │
└──────────────────────────────────────────────────────────┘
`));
