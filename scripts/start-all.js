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

const ROOT = path.resolve(__dirname, "..");
const FASTAPI_PORT = process.env.FASTAPI_PORT ?? "8080";
const NODE_PORT    = process.env.PORT          ?? "5000";

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

const fastapi = startProcess(
  "FastAPI",
  "uvicorn",
  ["main:app", "--host", "0.0.0.0", "--port", FASTAPI_PORT, "--reload"],
  { FASTAPI_PORT }
);

// ── Node.js (tsx dev) ──────────────────────────────────────────
const nodeServer = startProcess(
  "Node",
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["cross-env", "NODE_ENV=development", "tsx", "--env-file=.env", "server/index.ts"],
  { PORT: NODE_PORT, FASTAPI_URL: `http://localhost:${FASTAPI_PORT}` }
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
┌─────────────────────────────────────────────────┐
│  🔧 AI 용접 진단 — 개발 서버 시작                  │
│  FastAPI  → http://localhost:${FASTAPI_PORT}           │
│  Node.js  → http://localhost:${NODE_PORT}           │
└─────────────────────────────────────────────────┘
`));
