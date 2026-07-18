import type { Express, Request, Response } from "express";
import express from "express";
import pool from "./db";

const largeBodyParser = express.json({ limit: "30mb" });

// FASTAPI_URL 환경 변수로 FastAPI 주소를 외부 구성 가능 (Render 등 배포 환경 대응)
// 기본값을 127.0.0.1로 사용 — Node 18+ 에서 localhost가 IPv6(::1)로 해석될 때 ECONNREFUSED 방지
// Render fromService(property: host)는 프로토콜 없는 hostname만 반환하므로 https:// 자동 보완
// 마크다운 링크 형식([url](url)) 오염 방어: 대괄호·소괄호 제거 후 순수 URL만 추출
const _rawFastapiUrl = (process.env.FASTAPI_URL ?? "http://127.0.0.1:8080")
  .replace(/[\[\]()]/g, "")
  .trim();
const FASTAPI_BASE = _rawFastapiUrl.startsWith("http")
  ? _rawFastapiUrl
  : `https://${_rawFastapiUrl}`;
const FASTAPI_TIMEOUT_MS = 75_000; // 75초 타임아웃 (프론트 120s - 콜드스타트 최대 28s - 여유 17s)
console.log(`[WeldAnalysis] FastAPI endpoint (sanitized) = ${FASTAPI_BASE}`);

// ── AbortSignal 기반 타임아웃 fetch (클라이언트 연결 해제 시 즉시 중단) ────
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
  parentSignal?: AbortSignal,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // 부모 신호(클라이언트 연결 종료)를 전파: 클라이언트가 끊기면 FastAPI 호출도 즉시 중단
  let parentListener: (() => void) | undefined;
  if (parentSignal) {
    if (parentSignal.aborted) {
      clearTimeout(timer);
      controller.abort();
    } else {
      parentListener = () => controller.abort();
      parentSignal.addEventListener("abort", parentListener, { once: true });
    }
  }

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (parentSignal && parentListener) {
      parentSignal.removeEventListener("abort", parentListener);
    }
  }
}

// ── 인터럽트 가능 지연 (clientAbort 발동 시 즉시 해제) ─────────────
// setTimeout을 AbortSignal로 래핑: 클라이언트가 끊기면 대기를 즉시 해제해 좀비 방지.
function delayMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

// Render 프록시 콜드 스타트 에러 판정 (재시도 대상 여부)
// 502/503/504 = Render 게이트웨이가 FastAPI 기동 전에 반환하는 상태코드
// fetch failed / ECONNREFUSED = FastAPI 프로세스 자체가 아직 수신 준비 미완료
function isColdStartError(e: any): boolean {
  const s = e?.status as number | undefined;
  if (s === 502 || s === 503 || s === 504) return true;
  const msg: string = e?.message ?? "";
  return msg.includes("fetch failed") || msg.includes("ECONNREFUSED");
}

// ── FastAPI /analyze-welding 호출 ─────────────────────────────
async function callFastApiAnalyze(params: {
  frontPhoto:    string;
  sidePhoto?:    string;
  backPhoto?:    string;
  process:       string;
  posture:       string;
  material:      string;
  beadType:      string;
  passType:      string;
  aiModel:       string;
  adminFeedback: string;
  userHistory:    string;
  plateThickness: string;
  pipeOuterDiameterMm: string;
  language:       string;
  analysisMode:   string;
  measurementContext?: string;  // 재분석 시 LLM system 프롬프트에 주입할 Ground-Truth
  // 추가 파라미터 (FastAPI Form 기본값 있음)
  isFillet?:         boolean;
  hasLaser?:         boolean;
  laserAngleDeg?:    string;
  shootingAngleDeg?: string;
  parentSignal?:     AbortSignal; // 클라이언트 연결 해제 시 fetch 즉시 중단용
}): Promise<any> {
  const formData = new FormData();

  const frontBuf = Buffer.from(params.frontPhoto, "base64");
  formData.append("file", new Blob([frontBuf], { type: "image/jpeg" }), "front.jpg");

  if (params.sidePhoto) {
    const sideBuf = Buffer.from(params.sidePhoto, "base64");
    formData.append("side_file", new Blob([sideBuf], { type: "image/jpeg" }), "side.jpg");
  }
  if (params.backPhoto) {
    const backBuf = Buffer.from(params.backPhoto, "base64");
    formData.append("back_file", new Blob([backBuf], { type: "image/jpeg" }), "back.jpg");
  }

  formData.append("process",        params.process);
  formData.append("posture",        params.posture);
  formData.append("material",       params.material);
  formData.append("bead_type",      params.beadType);
  formData.append("pass_type",      params.passType);
  formData.append("ai_model",       params.aiModel === "claude-sonnet" ? "claude" : "gpt");
  formData.append("admin_feedback", params.adminFeedback);
  formData.append("user_history",   params.userHistory);
  formData.append("plate_thickness", params.plateThickness);
  formData.append("pipe_outer_diameter_mm", params.pipeOuterDiameterMm);
  formData.append("language",       params.language);
  formData.append("analysis_mode",  params.analysisMode || "quick");
  // 재분석용 Ground-Truth: system 프롬프트에 주입되어 환각 방지
  if (params.measurementContext) {
    formData.append("measurement_context", params.measurementContext);
  }
  // 필릿·레이저 파라미터 — FastAPI Form 기본값(false/45)이 있으나 명시 전달
  formData.append("is_fillet",          params.isFillet  ? "true" : "false");
  formData.append("has_laser",          params.hasLaser  ? "true" : "false");
  // 기본 45°: tan(45°)=1.0 → height_mm = deformation_px / ppm (직관적 공식)
  // 90° 전달 시 tan(90°)≈∞ → height≈0 버그 방지 (Python 엔진에서도 clamp 처리됨)
  formData.append("laser_angle_deg",    params.laserAngleDeg    ?? "45");
  formData.append("shooting_angle_deg", params.shootingAngleDeg ?? "90");

  const resp = await fetchWithTimeout(
    `${FASTAPI_BASE}/analyze-welding`,
    { method: "POST", body: formData },
    FASTAPI_TIMEOUT_MS,
    params.parentSignal,
  );

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    // 400 = 사용자 입력 문제 (잘못된 사진/마커 미검출) → 재시도하지 않고
    // 그대로 전파해 상위에서 메시지를 사용자에게 보여줌
    const err: any = new Error(`FastAPI ${resp.status}: ${errText.slice(0, 300)}`);
    err.status = resp.status;
    err.body = errText;
    throw err;
  }

  return await resp.json();
}

// ── 메인 라우트: Express → FastAPI 프록시 ──────────────────────
export function registerWeldAnalysisRoute(app: Express): void {
  app.post("/api/analyze-weld", largeBodyParser, async (req: Request, res: Response) => {
    const {
      photos, imageBase64,
      process: weldingProcess, posture, material,
      beadType, passType, aiModel,
      previousResultsSummary, plateThickness, pipeOuterDiameterMm,
      language,
      isFillet, hasLaser, laserAngle, shootingAngle,
    } = req.body;

    const frontPhoto = photos?.front || imageBase64;
    if (!frontPhoto) {
      return res.status(400).json({ error: "정면 사진이 필요합니다." });
    }

    const imgSizeKB = Math.round(frontPhoto.length * 0.75 / 1024);
    console.log(`[analyze-weld] 요청 수신 | 이미지크기=${imgSizeKB}KB | 공정=${weldingProcess} | AI모델=${aiModel}`);
    console.log(`[analyze-weld] ▶ 호출 시도 URL: ${FASTAPI_BASE}/analyze-welding`);

    try {
      // 1) 관리자 피드백 (DB) → FastAPI에 전달
      let adminFeedback = "";
      try {
        const fb = await pool.query(
          "SELECT feedback_text FROM admin_feedback ORDER BY created_at DESC LIMIT 20"
        );
        if (fb.rows.length > 0) {
          adminFeedback = fb.rows
            .map((r: any, i: number) => `${i + 1}. ${r.feedback_text}`)
            .join("\n");
        }
      } catch {}

      // 2) FastAPI에 모든 분석 위임 (콜드 스타트 대응: 최대 3회 시도, 백오프 5s → 10s)
      const callParams = {
        frontPhoto,
        sidePhoto:    photos?.side,
        backPhoto:    photos?.back,
        process:      weldingProcess  || "FCAW",
        posture:      posture  || "1G",
        material:     material || "탄소강 평판",
        beadType:     beadType || "위빙 비드",
        passType:     passType || "",
        aiModel:      aiModel  || "gpt",
        adminFeedback,
        userHistory:    previousResultsSummary || "",
        plateThickness: plateThickness || "",
        pipeOuterDiameterMm: pipeOuterDiameterMm ? String(pipeOuterDiameterMm) : "",
        language:       language || "ko",
        analysisMode:   "quick",        // 최초 분석은 항상 quick 모드 (LLM 없음)
        isFillet:          isFillet === true || isFillet === "true",
        hasLaser:          hasLaser === true || hasLaser === "true",
        laserAngleDeg:     laserAngle    ? String(laserAngle)    : "90",
        shootingAngleDeg:  shootingAngle ? String(shootingAngle) : "90",
      };

      // ── 클라이언트 연결 해제 감지 (좀비 프로세스 방지) ────────────────
      // 프론트엔드 AbortController(120s)가 발동하면 res "close" 이벤트 발생.
      // clientAbort.signal이 abort되면 fetchWithTimeout이 즉시 fetch를 취소함.
      const clientAbort = new AbortController();
      const onClientClose = (): void => {
        if (!clientAbort.signal.aborted) {
          clientAbort.abort();
          console.warn("[analyze-weld] 클라이언트 연결 끊김 → FastAPI 호출 즉시 중단");
        }
      };
      res.on("close", onClientClose);

      try {
        // 클라이언트가 이미 없으면 FastAPI 호출 자체를 생략
        if (clientAbort.signal.aborted || req.socket.destroyed) {
          console.warn("[analyze-weld] 요청 수신 전 클라이언트 이미 없음 → 처리 생략");
          return;
        }

        // Smart Retry: 콜드 스타트(502/503/504/연결실패)에 한해 최대 5회 × 10s 재시도.
        // Render 무료 티어 콜드 스타트 최대 약 60초 → 10s × 5회 = 50s 커버.
        // 400·422·AbortError 등 비-콜드스타트 에러는 즉시 상위 catch로 전파(Fail-fast 유지).
        // 각 대기 전·후에 clientAbort 상태를 확인해 좀비 프로세스를 방지.
        const COLD_START_RETRIES  = 5;       // 최대 5회 (콜드 스타트 커버리지 30s→37s)
        const COLD_START_DELAY_MS = 7_000;  // 7s (이전 10s에서 단축) → 최대 대기 28s

        let result: any   = null;
        let lastColdErr: any = null;

        for (let attempt = 0; attempt <= COLD_START_RETRIES; attempt++) {
          // 대기 후 또는 루프 진입 시 클라이언트 상태 재확인
          if (clientAbort.signal.aborted) {
            console.warn("[analyze-weld] 클라이언트 끊김 — 재시도 루프 중단");
            return;
          }
          try {
            result = await callFastApiAnalyze({ ...callParams, parentSignal: clientAbort.signal });
            lastColdErr = null;
            break; // 성공
          } catch (e: any) {
            if (clientAbort.signal.aborted) {
              console.warn("[analyze-weld] 클라이언트 끊김으로 인한 abort — 응답 생략");
              return;
            }
            if (!isColdStartError(e)) {
              throw e; // 400·422·AbortError → 즉시 상위 catch로
            }
            lastColdErr = e;
            if (attempt < COLD_START_RETRIES) {
              console.warn(
                `[analyze-weld] 콜드 스타트 감지 (HTTP ${e?.status ?? "연결실패"}) — ` +
                `${attempt + 1}/${COLD_START_RETRIES}회 완료. ${COLD_START_DELAY_MS / 1000}s 후 재시도...`,
              );
              await delayMs(COLD_START_DELAY_MS, clientAbort.signal);
            }
          }
        }

        if (lastColdErr) throw lastColdErr;
        if (!result) throw new Error("FastAPI 호출 실패 (원인 불명)");

        console.log(`[analyze-weld] 성공 | aiScore=${result.aiScore} | 판정=${result.overallVerdict}`);

        if (!clientAbort.signal.aborted) {
          res.json({
            ...result,
            laserAnalysis:  result.visionMeasurement?.laser_analysis ?? null,
            filletAnalysis: result.filletAnalysis ?? null,
          });
        }
      } finally {
        res.off("close", onClientClose);
      }

    } catch (err: any) {
      // 사용자 입력 문제 (400) — FastAPI의 사용자 친화 메시지를 그대로 전달
      if (err?.status === 400) {
        let userMessage = "용접 사진을 인식하지 못했습니다. 선명한 용접 사진을 다시 업로드해 주세요.";
        let code = "INVALID_WELD_PHOTO";
        try {
          const parsed = JSON.parse(err.body ?? "{}");
          if (parsed?.message) userMessage = parsed.message;
          if (parsed?.code) code = parsed.code;
        } catch {}
        console.warn(`[analyze-weld] 잘못된 사진 — 사용자에게 안내: ${userMessage}`);
        return res.status(400).json({ error: code, message: userMessage });
      }
      // FastAPI 연산 크래시 (422) — Traceback이 Render 로그에 찍혔으므로 즉시 앱에 알림
      if (err?.status === 422) {
        let detail = "분석 연산 중 예기치 않은 오류가 발생했습니다.";
        try {
          const parsed = JSON.parse(err.body ?? "{}");
          if (parsed?.detail) detail = parsed.detail;
          else if (parsed?.message) detail = parsed.message;
        } catch {}
        console.error(`[analyze-weld] FastAPI 연산 오류(422): ${detail}`);
        return res.status(500).json({ error: "ANALYSIS_FAILED", message: detail });
      }
      // isColdStart: 502/503/504 또는 ECONNREFUSED/fetch failed — 5회 재시도 후 최종 실패
      const isColdStart = isColdStartError(err);
      const isTimeout   = err.message?.includes("AbortError") || err.name === "AbortError";
      console.error(`[analyze-weld] ══ 최종 실패 ══`);
      console.error(`[analyze-weld]  호출 시도 URL : ${FASTAPI_BASE}/analyze-welding`);
      console.error(`[analyze-weld]  오류 메시지   : ${err.message}`);
      console.error(`[analyze-weld]  HTTP 상태     : ${err?.status ?? "N/A"}`);
      console.error(`[analyze-weld]  응답 본문     : ${err?.body?.slice(0, 300) ?? "N/A"}`);
      if (isColdStart) {
        console.error(`[analyze-weld]  → 콜드 스타트(502/503/504/연결실패) — 5회 × 10s 재시도 후 최종 실패`);
        console.error(`[analyze-weld]  → FASTAPI_URL = ${process.env.FASTAPI_URL ?? "(미설정 — 127.0.0.1:8080 폴백)"}`);
      }
      if (isTimeout) {
        console.error(`[analyze-weld]  → ${FASTAPI_TIMEOUT_MS / 1000}초 타임아웃 초과 — FastAPI 처리 지연`);
      }
      res.status(503).json({
        error: "AI_ANALYSIS_FAILED",
        message: isColdStart
          ? "AI 분석 서버가 예열 중입니다(최대 1분 소요). 잠시 후 다시 시도해 주세요."
          : isTimeout
          ? "AI 분석 서버 응답 시간이 초과되었습니다. 사진 파일 크기를 줄이거나 잠시 후 다시 시도해주세요."
          : "AI 분석 서버에 일시적인 문제가 발생했습니다. 잠시 후 다시 시도해주세요.",
        detail: err.message?.slice(0, 200),
      });
    }
  });

  // ── 빠른 측정 결과를 AI 종합 분석으로 재분석 ─────────────────────
  app.post("/api/reanalyze", largeBodyParser, async (req: Request, res: Response) => {
    // laserAnalysis, filletAnalysis, visionData 는 DB에 없으므로 프론트에서 전달받음
    const { resultId, aiModel, laserAnalysis, filletAnalysis, visionData } = req.body;
    if (!resultId) return res.status(400).json({ error: "resultId 필요" });

    try {
      const dbRes = await pool.query(
        "SELECT * FROM weld_results WHERE id = $1",
        [resultId]
      );
      if (dbRes.rows.length === 0) return res.status(404).json({ error: "결과를 찾을 수 없습니다." });

      const row = dbRes.rows[0];
      const photos = row.photos as { front?: string; side?: string; back?: string } | null;
      const frontUrl = photos?.front || row.photo_uri;
      if (!frontUrl) return res.status(400).json({ error: "사진 데이터가 없습니다." });

      const urlToBase64 = async (url: string): Promise<string | undefined> => {
        try {
          if (url.startsWith("data:")) return url.split(",")[1];
          const resp = await fetchWithTimeout(url, { method: "GET" }, 15000);
          if (!resp.ok) return undefined;
          const buf = await resp.arrayBuffer();
          return Buffer.from(buf).toString("base64");
        } catch { return undefined; }
      };

      const frontBase64 = await urlToBase64(frontUrl);
      if (!frontBase64) return res.status(400).json({ error: "사진을 가져올 수 없습니다." });
      const sideBase64 = photos?.side ? await urlToBase64(photos.side) : undefined;
      const backBase64 = photos?.back ? await urlToBase64(photos.back) : undefined;

      // ── 기존 비전 측정값 → LLM 시스템 컨텍스트 문자열로 직렬화 ──
      const safeJson = (v: any) => {
        if (!v) return null;
        return typeof v === "string" ? JSON.parse(v) : v;
      };
      const dbBead    = safeJson(row.bead_analysis);
      const dbDefects = (safeJson(row.defects) ?? []) as any[];
      const dbTop3    = (safeJson(row.top3_defects) ?? []) as string[];

      // ── Ground-Truth 블록 빌드 (Key-Value 형식, 환각 방지용) ──────
      // DB 값을 기준으로 프론트 전달값(레이저/필릿/visionData)으로 보완
      const fv = visionData ?? {};  // front-end 전달 visionData
      const beadSrc  = fv.beadAnalysis ?? dbBead;
      const defectSrc = (fv.defects ?? dbDefects) as any[];
      const top3Src   = (fv.top3Defects ?? dbTop3) as string[];

      const kv = (label: string, val: any) =>
        val != null && val !== "" ? `  ${label}: ${val}` : null;

      const ctxLines: string[] = [
        "=== 1차 비전 측정 Ground-Truth ===",
        "경고: 아래 수치는 비전 AI가 확정한 실측값이다.",
        "히트맵·시각적 분석 화면에 표시된 수치와 100% 동일한 값이다.",
        "리포트 작성 시 반드시 이 수치들을 소수점 둘째 자리까지 정확히 그대로 인용하라.",
        "아래에 없는 수치를 지어내거나(Hallucination) 반올림·변형하여 쓰는 것은 금지다.",
        "",
        "[기본 정보]",
        kv("AI점수",     fv.aiScore    ?? row.ai_score),
        kv("판정",       fv.overallVerdict ?? row.overall_verdict),
        kv("자체점수",   fv.selfScore),
        kv("공정",       fv.process    ?? row.process),
        kv("자세",       fv.posture    ?? row.posture),
        kv("재료",       fv.material   ?? row.material),
        kv("비드유형",   fv.beadType   ?? row.bead_type),
        kv("패스유형",   fv.passType),
      ].filter(Boolean) as string[];

      if (beadSrc) {
        ctxLines.push("", "[비드 분석 — 화면 히트맵 표시값과 동일]");
        if (kv("비드총점",   beadSrc.totalScore))      ctxLines.push(kv("비드총점", beadSrc.totalScore)!);
        if (beadSrc.width)       ctxLines.push(`  비드폭: ${beadSrc.width.value} (${beadSrc.width.score}점)`);
        if (beadSrc.straightness) ctxLines.push(`  직진도: ${beadSrc.straightness.value} (${beadSrc.straightness.score}점)`);
        if (beadSrc.height)      ctxLines.push(`  비드높이: ${beadSrc.height.value} (${beadSrc.height.score}점)`);
      }

      // 사진별 히트맵 수치 (front/side/back 각각 독립 측정값)
      const photoAnalyses = fv.photoAnalyses as Record<string, any> | null | undefined;
      if (photoAnalyses) {
        const viewLabel: Record<string, string> = { front: "정면", side: "측면", back: "이면" };
        for (const view of ["front", "side", "back"] as const) {
          const pa = photoAnalyses[view];
          if (!pa?.beadAnalysis) continue;
          const ba = pa.beadAnalysis;
          ctxLines.push(`  [${viewLabel[view]} 히트맵] 비드폭=${ba.width?.value ?? "-"} (${ba.width?.score ?? "-"}점) / 직진도=${ba.straightness?.value ?? "-"} (${ba.straightness?.score ?? "-"}점)`);
        }
      }

      if (top3Src.length > 0) {
        ctxLines.push("", "[주요 결함 Top3]");
        top3Src.forEach((d, i) => ctxLines.push(`  ${i + 1}위: ${d}`));
      }

      const detectedDefects = defectSrc.filter((d: any) => d.detected);
      if (detectedDefects.length > 0) {
        ctxLines.push("", "[결함 상세]");
        detectedDefects.forEach((d: any) =>
          ctxLines.push(`  - ${d.name}: 심각도=${d.severity}, 측정=${d.measured}, 기준=${d.limit}, 결과=${d.result}`)
        );
      }

      // 레이저 3D (DB 없음 → 프론트 전달)
      if (laserAnalysis?.status === "success") {
        ctxLines.push("", "[레이저 3D 측정]");
        ctxLines.push(`  최대높이: ${laserAnalysis.beadHeightMax}mm`);
        ctxLines.push(`  최소높이: ${laserAnalysis.beadHeightMin}mm`);
        ctxLines.push(`  평균높이: ${laserAnalysis.beadHeightAvg}mm`);
        ctxLines.push(`  볼록성: ${laserAnalysis.convexity} (${laserAnalysis.convexityMm}mm)`);
        if (laserAnalysis.is_cross_validated) {
          ctxLines.push(`  교차검증 신뢰도: ${laserAnalysis.confidence_score}%`);
        }
      }

      // 필릿 분석 (DB 없음 → 프론트 전달)
      if (filletAnalysis?.beadWidth != null) {
        ctxLines.push("", "[필렛 분석]");
        ctxLines.push(`  비드 표면너비: ${filletAnalysis.beadWidth}mm`);
        ctxLines.push(`  등각장(Z): ${filletAnalysis.equalLeg}mm`);
        ctxLines.push(`  이론 목두께: ${filletAnalysis.theoreticalThroat}mm`);
        ctxLines.push(`  실제 목두께: ${filletAnalysis.actualThroat}mm`);
        ctxLines.push(`  볼록성: ${filletAnalysis.convexity?.type} (${filletAnalysis.convexity?.value_mm}mm)`);
        if (filletAnalysis.unequalLeg?.isUnequal) {
          ctxLines.push(`  부등각장: Z1=${filletAnalysis.unequalLeg.z1}mm / Z2=${filletAnalysis.unequalLeg.z2}mm`);
        }
      }

      ctxLines.push("", "=== Ground-Truth 끝 ===");

      const measurementContext = ctxLines.join("\n");
      console.log(`[reanalyze] Ground-Truth ${ctxLines.length}줄 → LLM system 프롬프트 주입`);

      // ── 사용자 과거 진단 이력 조회 (Section 2~5 추세 분석용) ────
      let userHistory = "";
      try {
        const historyRes = await pool.query(
          `SELECT ai_score, overall_verdict, top3_defects, bead_analysis, timestamp
           FROM weld_results
           WHERE user_id = $1 AND id != $2
           ORDER BY timestamp ASC
           LIMIT 10`,
          [row.user_id, resultId]
        );
        if (historyRes.rows.length > 0) {
          userHistory = historyRes.rows.map((hr: any, i: number) => {
            const date = new Date(Number(hr.timestamp)).toLocaleDateString("ko-KR");
            const t3 = safeJson(hr.top3_defects) as string[] ?? [];
            const bd = safeJson(hr.bead_analysis);
            return (
              `[${i + 1}회차] ${date} - ` +
              `AI점수:${hr.ai_score}점(${hr.overall_verdict}) ` +
              `결함:${t3.length > 0 ? t3.join(",") : "없음"} ` +
              `비드총점:${bd?.totalScore ?? "N/A"}`
            );
          }).join("\n");
          console.log(`[reanalyze] 과거 이력 ${historyRes.rows.length}건 userHistory 구성`);
        }
      } catch (e) {
        console.warn("[reanalyze] 이력 조회 실패 (무시):", e);
      }

      let adminFeedback = "";
      try {
        const fb = await pool.query(
          "SELECT feedback_text FROM admin_feedback ORDER BY created_at DESC LIMIT 20"
        );
        if (fb.rows.length > 0) {
          adminFeedback = fb.rows.map((r: any, i: number) => `${i + 1}. ${r.feedback_text}`).join("\n");
        }
      } catch {}

      const aiData = await callFastApiAnalyze({
        frontPhoto: frontBase64,
        sidePhoto:  sideBase64,
        backPhoto:  backBase64,
        process:    visionData?.process    || row.process  || "FCAW",
        posture:    visionData?.posture    || row.posture  || "1G",
        material:   visionData?.material   || row.material || "탄소강 평판",
        beadType:   visionData?.beadType   || row.bead_type || "위빙 비드",
        passType:   visionData?.passType   || "",
        aiModel:    aiModel || "gpt",
        adminFeedback,
        userHistory,                        // Section 2~5: 과거 이력 기반 추세 분석
        measurementContext,                  // Section 1: 환각 방지용 system 프롬프트 주입
        plateThickness:     "",
        pipeOuterDiameterMm: "",
        language:    "ko",
        analysisMode: "ai",
      });

      // LLM 생성 필드만 DB 업데이트 (비전 측정값은 원본 보존)
      await pool.query(`
        UPDATE weld_results SET
          improvements       = $1,
          comprehensive_report = $2,
          top3_defects       = $3
        WHERE id = $4
      `, [
        JSON.stringify(aiData.improvements ?? []),
        aiData.comprehensiveReport ?? null,
        JSON.stringify(aiData.top3Defects ?? []),
        resultId,
      ]);

      console.log(`[reanalyze] 완료: ${resultId} | 리포트 ${aiData.comprehensiveReport?.length ?? 0}자`);
      // 프론트가 병합(merge)할 수 있도록 LLM 생성 필드만 반환
      res.json({
        comprehensiveReport: aiData.comprehensiveReport,
        improvements:        aiData.improvements ?? [],
        top3Defects:         aiData.top3Defects ?? [],
        overallVerdict:      aiData.overallVerdict,
        aiScore:             aiData.aiScore,
      });
    } catch (err: any) {
      console.error("[reanalyze] 오류:", err);
      if (err?.status === 400) {
        let userMessage = "용접 사진을 인식하지 못했습니다.";
        try {
          const parsed = JSON.parse(err.body ?? "{}");
          if (parsed?.message) userMessage = parsed.message;
        } catch {}
        return res.status(400).json({ error: "INVALID_WELD_PHOTO", message: userMessage });
      }
      res.status(500).json({ error: "재분석 실패", message: err.message?.slice(0, 200) });
    }
  });
}
