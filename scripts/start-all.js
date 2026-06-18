#!/usr/bin/env node
/**
 * 개발 환경: Node.js Express 서버 + Python FastAPI 서버를 함께 시작.
 *
 * 사용: node scripts/start-all.js
 *   또는: npm run dev:all
 *
 * 환경 변수:
 *   FASTAPI_PORT  — FastAPI 포트 (기본 8080)
 *   PORT          — Node.js 포트 (기본 5001)
 *
 * Python uvicorn이 PATH에 있어야 합니다.
 *   pip install uvicorn fastapi openai anthropic httpx numpy opencv-python-headless python-multipart
 */

const { spawn, execSync } = require("child_process");
const net  = require("net");
const path = require("path");
const fs   = require("fs");
const os   = require("os");
const ROOT = path.resolve(__dirname, "..");
const FASTAPI_PORT = process.env.FASTAPI_PORT ?? "8080";
const NODE_PORT    = process.env.PORT          ?? "5001";

// 로컬 Wi-Fi/이더넷 IP 자동 감지 (모바일 기기가 접속해야 할 주소)
// 가상 어댑터(WSL, VMware, vEthernet 등)를 건너뛰고 물리 랜카드 IP만 반환.
function getLocalIP() {
  const VIRTUAL_NAMES = ["vethernet", "wsl", "vmware", "virtualbox", "virtual", "hyper-v", "bluetooth", "tap", "tun", "docker", "loopback"];
  const PREFERRED_NAMES = ["wi-fi", "wifi", "wlan", "wireless", "ethernet", "이더넷", "local area connection", "lan"];

  const ifaces = os.networkInterfaces();
  const candidates = [];

  for (const [name, addrs] of Object.entries(ifaces)) {
    const nameLower = name.toLowerCase();
    // 가상/루프백 어댑터 제외
    if (VIRTUAL_NAMES.some((k) => nameLower.includes(k))) continue;

    for (const iface of addrs) {
      if (iface.family !== "IPv4" || iface.internal) continue;
      // 사설 IP 대역만 허용 (172.x.x.x는 WSL2 대역으로 제외)
      const isPrivate =
        iface.address.startsWith("192.168.") ||
        iface.address.startsWith("10.");
      if (!isPrivate) continue;

      const preferred = PREFERRED_NAMES.some((k) => nameLower.includes(k));
      candidates.push({ ip: iface.address, preferred, name });
    }
  }

  if (candidates.length === 0) return "127.0.0.1";

  // 물리 Wi-Fi/이더넷 어댑터 우선
  candidates.sort((a, b) => (b.preferred ? 1 : 0) - (a.preferred ? 1 : 0));
  const chosen = candidates[0];
  console.log(`[start-all] 로컬 IP 선택: ${chosen.ip} (어댑터: "${chosen.name}")`);
  if (candidates.length > 1) {
    console.log(`[start-all] 후보 IP 목록: ${candidates.map((c) => `${c.ip}(${c.name})`).join(", ")}`);
  }
  return chosen.ip;
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

/**
 * 지정한 포트를 점유 중인 프로세스를 강제 종료한다.
 * - Windows : netstat -ano + taskkill /PID /F
 * - Linux/Mac: fuser / lsof + kill -9
 * 이미 비어 있으면 조용히 넘어간다.
 */
function killPort(port) {
  if (process.platform === "win32") {
    let pids;
    try {
      // netstat -ano | findstr :PORT — LISTENING 상태의 PID 추출
      const raw = execSync(`netstat -ano | findstr :${port}`, {
        encoding: "utf8", timeout: 5000,
      });
      pids = new Set(
        raw.split("\n")
          .filter((l) => l.includes("LISTENING"))
          .map((l) => l.trim().split(/\s+/).pop())
          .filter((p) => p && /^\d+$/.test(p) && p !== "0")
      );
    } catch {
      // findstr이 아무것도 못 찾으면 에러 발생 → 포트 비어있음
      console.log(`[start-all] 포트 ${port} 비어있음 — 스킵`);
      return;
    }

    if (pids.size === 0) {
      console.log(`[start-all] 포트 ${port} 비어있음 — 스킵`);
      return;
    }

    console.log(`[start-all] 포트 ${port} 점유 감지 (${pids.size}개 PID) → 강제 종료`);
    for (const pid of pids) {
      try {
        execSync(`taskkill /PID ${pid} /F`, { encoding: "utf8" });
        console.log(`[start-all] ✅ PID ${pid} 종료 완료 (포트 ${port})`);
      } catch (e) {
        console.warn(`[start-all] ⚠ PID ${pid} 종료 실패: ${e.message}`);
      }
    }
  } else {
    // Linux / Mac
    try {
      execSync(`fuser -k ${port}/tcp 2>/dev/null`, { shell: true });
      console.log(`[start-all] ✅ 포트 ${port} 프로세스 종료 (fuser)`);
    } catch {
      try {
        execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null`, { shell: true });
        console.log(`[start-all] ✅ 포트 ${port} 프로세스 종료 (lsof)`);
      } catch {
        console.log(`[start-all] 포트 ${port} 비어있음 — 스킵`);
      }
    }
  }
  // 종료 후 500ms 대기 (소켓 TIME_WAIT 해소)
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); } catch { /* ignore */ }
}

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

// ── 포트 선점 프로세스 강제 종료 ─────────────────────────────
console.log("[start-all] 포트 선점 프로세스 정리...");
killPort(NODE_PORT);
killPort(FASTAPI_PORT);
console.log("[start-all] 포트 정리 완료 → 서버 시작");

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

// ── FastAPI 준비 대기 (최대 30초) ─────────────────────────────────
// FastAPI가 완전히 기동된 뒤 Node.js를 시작하여 시작 직후 health-ping 경고를 방지한다.
async function waitForFastAPI(port, maxWaitMs = 30_000) {
  const http   = require("http");
  const start  = Date.now();
  let attempt  = 0;
  console.log(color("cyan", `[start-all] FastAPI 기동 대기 (최대 ${maxWaitMs / 1000}초)...`));
  while (Date.now() - start < maxWaitMs) {
    const ok = await new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/docs`, (res) => {
        resolve(res.statusCode < 400);
        res.resume();
      });
      req.on("error", () => resolve(false));
      req.setTimeout(1_500, () => { req.destroy(); resolve(false); });
    });
    if (ok) {
      console.log(color("cyan", `[start-all] ✅ FastAPI 준비 완료 (${attempt + 1}회 시도) — http://127.0.0.1:${port}`));
      return true;
    }
    attempt++;
    await new Promise((r) => setTimeout(r, 1_500));
  }
  console.warn(color("yellow", `[start-all] ⚠ FastAPI ${maxWaitMs / 1000}초 내 응답 없음 — 비전 분석이 동작하지 않을 수 있습니다`));
  return false;
}

// ── Node.js (tsx dev) ──────────────────────────────────────────
// FastAPI 준비 완료 후 Node.js 시작 (준비 실패해도 Node는 시작)
let nodeServer;
waitForFastAPI(FASTAPI_PORT).finally(() => {
  nodeServer = startProcess(
    "Node",
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["cross-env", "NODE_ENV=development", "tsx", "watch", "--env-file=.env", "server/index.ts"],
    { PORT: NODE_PORT, FASTAPI_URL: `http://127.0.0.1:${FASTAPI_PORT}` }
  );
});

// ── 종료 처리 ──────────────────────────────────────────────────
function shutdown() {
  console.log("\n[start-all] 종료 중...");
  fastapi.kill();
  if (nodeServer) nodeServer.kill();
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
