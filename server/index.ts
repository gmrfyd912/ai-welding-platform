import express from "express";
import type { Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import * as fs from "fs";
import * as path from "path";
import {
  ensurePermissionsColumn,
  ensureVisitorTable,
  ensureDateColumns,
  ensureNameColumn,
} from "./auth-routes";
import {
  ensureColumns,
  ensureAdminFeedbackTable,
  ensureCommentsTable,
  backfillMissingPhotoAnalyses,
} from "./results-routes";
import { ensureExamTable } from "./exam-routes";
import { ensureFieldTables } from "./schema";
import { ensureOxTables } from "./ox-routes";
import { ensureTheoryTable } from "./theory-routes";

const app = express();
const log = console.log;

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

function setupCors(app: express.Application) {
  app.use((req, res, next) => {
    const origins = new Set<string>();

    if (process.env.REPLIT_DEV_DOMAIN) {
      origins.add(`https://${process.env.REPLIT_DEV_DOMAIN}`);
    }

    if (process.env.REPLIT_DOMAINS) {
      process.env.REPLIT_DOMAINS.split(",").forEach((d) => {
        origins.add(`https://${d.trim()}`);
      });
    }

    const origin = req.header("origin");

    // Allow localhost origins for Expo web development (any port)
    const isLocalhost =
      origin?.startsWith("http://localhost:") ||
      origin?.startsWith("http://127.0.0.1:");

    if (origin && (origins.has(origin) || isLocalhost)) {
      res.header("Access-Control-Allow-Origin", origin);
      res.header(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS",
      );
      res.header("Access-Control-Allow-Headers", "Content-Type");
      res.header("Access-Control-Allow-Credentials", "true");
    }

    if (req.method === "OPTIONS") {
      return res.sendStatus(200);
    }

    next();
  });
}

function setupBodyParsing(app: express.Application) {
  app.use(
    express.json({
      limit: "50mb",
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );

  app.use(express.urlencoded({ extended: false, limit: "50mb" }));
}

function setupRequestLogging(app: express.Application) {
  app.use((req, res, next) => {
    const start = Date.now();
    const path = req.path;
    let capturedJsonResponse: Record<string, unknown> | undefined = undefined;

    const originalResJson = res.json;
    res.json = function (bodyJson, ...args) {
      capturedJsonResponse = bodyJson;
      return originalResJson.apply(res, [bodyJson, ...args]);
    };

    res.on("finish", () => {
      if (!path.startsWith("/api")) return;

      const duration = Date.now() - start;

      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    });

    next();
  });
}

function getAppName(): string {
  try {
    const appJsonPath = path.resolve(process.cwd(), "app.json");
    const appJsonContent = fs.readFileSync(appJsonPath, "utf-8");
    const appJson = JSON.parse(appJsonContent);
    return appJson.expo?.name || "App Landing Page";
  } catch {
    return "App Landing Page";
  }
}

function serveExpoManifest(platform: string, res: Response) {
  const manifestPath = path.resolve(
    process.cwd(),
    "static-build",
    platform,
    "manifest.json",
  );

  if (!fs.existsSync(manifestPath)) {
    return res
      .status(404)
      .json({ error: `Manifest not found for platform: ${platform}` });
  }

  res.setHeader("expo-protocol-version", "1");
  res.setHeader("expo-sfv-version", "0");
  res.setHeader("content-type", "application/json");

  const manifest = fs.readFileSync(manifestPath, "utf-8");
  res.send(manifest);
}

function serveLandingPage({
  req,
  res,
  landingPageTemplate,
  appName,
}: {
  req: Request;
  res: Response;
  landingPageTemplate: string;
  appName: string;
}) {
  const forwardedProto = req.header("x-forwarded-proto");
  const protocol = forwardedProto || req.protocol || "https";
  const forwardedHost = req.header("x-forwarded-host");
  const host = forwardedHost || req.get("host");
  const baseUrl = `${protocol}://${host}`;
  const expsUrl = `${host}`;

  log(`baseUrl`, baseUrl);
  log(`expsUrl`, expsUrl);

  const html = landingPageTemplate
    .replace(/BASE_URL_PLACEHOLDER/g, baseUrl)
    .replace(/EXPS_URL_PLACEHOLDER/g, expsUrl)
    .replace(/APP_NAME_PLACEHOLDER/g, appName);

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(html);
}

function configureExpoAndLanding(app: express.Application) {
  const templatePath = path.resolve(
    process.cwd(),
    "server",
    "templates",
    "landing-page.html",
  );
  const landingPageTemplate = fs.readFileSync(templatePath, "utf-8");
  const appName = getAppName();

  log("Serving static Expo files with dynamic manifest routing");

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith("/api")) {
      return next();
    }

    if (req.path !== "/" && req.path !== "/manifest") {
      return next();
    }

    const platform = req.header("expo-platform");
    if (platform && (platform === "ios" || platform === "android")) {
      return serveExpoManifest(platform, res);
    }

    if (req.path === "/") {
      return serveLandingPage({
        req,
        res,
        landingPageTemplate,
        appName,
      });
    }

    next();
  });

  app.use("/assets", express.static(path.resolve(process.cwd(), "assets")));
  app.use(express.static(path.resolve(process.cwd(), "static-build")));

  log("Expo routing: Checking expo-platform header on / and /manifest");
}

function setupErrorHandler(app: express.Application) {
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const error = err as {
      status?: number;
      statusCode?: number;
      message?: string;
    };

    const status = error.status || error.statusCode || 500;
    const message = error.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });
}

async function initializeDatabase(): Promise<void> {
  log("[DB init] 순차 DDL 초기화 시작...");
  await ensurePermissionsColumn();
  await ensureVisitorTable();
  await ensureDateColumns();
  await ensureNameColumn();
  await ensureColumns();
  await ensureAdminFeedbackTable();
  await ensureCommentsTable();
  await backfillMissingPhotoAnalyses();
  await ensureExamTable();
  await ensureFieldTables();
  await ensureOxTables();
  await ensureTheoryTable();
  log("[DB init] 모든 테이블 검증 완료 (커넥션 1개, 순차 실행)");
}

(async () => {
  setupCors(app);
  setupBodyParsing(app);
  setupRequestLogging(app);

  configureExpoAndLanding(app);

  const server = await registerRoutes(app);

  await initializeDatabase().catch((err) => {
    console.error("[DB init] 초기화 중 오류 (서버는 계속 기동):", err);
  });

  setupErrorHandler(app);

  const basePort = parseInt(process.env.PORT || "5001", 10);

  /**
   * EADDRINUSE 발생 시 포트를 1씩 올려 자동 재시도.
   * 최대 5회(basePort+4까지) 시도 후 실패하면 프로세스 종료.
   */
  function tryListen(port: number, remaining: number): void {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" && remaining > 0) {
        const next = port + 1;
        log(`⚠ 포트 ${port} 사용 중 → 포트 ${next} 자동 전환 (남은 시도: ${remaining - 1}회)`);
        tryListen(next, remaining - 1);
      } else {
        log(`서버 시작 실패 (${err.code ?? err.message})`);
        process.exit(1);
      }
    });
    server.listen({ port }, () => {
      log(`express server serving on port ${port}`);
    });
  }

  tryListen(basePort, 5);

  // ── FastAPI Keep-alive: Render 무료 티어 15분 스핀다운 방지 ────────────
  const FASTAPI_URL_FOR_PING = (process.env.FASTAPI_URL || "").trim();
  if (FASTAPI_URL_FOR_PING) {
    const pingUrl = FASTAPI_URL_FOR_PING.replace(/\/+$/, "") + "/docs";
    setInterval(async () => {
      try {
        const r = await fetch(pingUrl, { signal: AbortSignal.timeout(10_000) });
        log(`[Keepalive] FastAPI ping → HTTP ${r.status}`);
      } catch (e: unknown) {
        log(`[Keepalive] FastAPI ping 실패 (무시): ${(e as Error)?.message ?? e}`);
      }
    }, 300_000); // 5분마다
    log(`[Keepalive] FastAPI 5분 주기 ping 시작: ${pingUrl}`);
  }
})();
