import type { Express, Request, Response } from "express";
import express from "express";
import pool from "./db";

const largeBodyParser = express.json({ limit: "30mb" });

const FASTAPI_BASE = "http://localhost:8080";
const FASTAPI_TIMEOUT_MS = 90_000; // 90초 타임아웃

// ── AbortSignal 기반 타임아웃 fetch ─────────────────────────────
async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(timer);
  }
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
  formData.append("analysis_mode",  params.analysisMode || "ai");

  const resp = await fetchWithTimeout(
    `${FASTAPI_BASE}/analyze-welding`,
    { method: "POST", body: formData },
    FASTAPI_TIMEOUT_MS,
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
      process, posture, material,
      selfScore, beadType, passType, aiModel,
      previousResultsSummary, plateThickness, pipeOuterDiameterMm,
      language, analysisMode,
    } = req.body;

    const frontPhoto = photos?.front || imageBase64;
    if (!frontPhoto) {
      return res.status(400).json({ error: "정면 사진이 필요합니다." });
    }

    const imgSizeKB = Math.round(frontPhoto.length * 0.75 / 1024);
    console.log(`[analyze-weld] 요청 수신 | 이미지크기=${imgSizeKB}KB | 공정=${process} | AI모델=${aiModel}`);

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
        process:      process  || "FCAW",
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
        analysisMode:   analysisMode || "ai",
      };

      // 콜드 스타트 사전 워밍업: FastAPI에 가벼운 ping (실패해도 무시)
      try {
        await fetchWithTimeout(`${FASTAPI_BASE}/`, { method: "GET" }, 3000);
      } catch {
        // 무시 — 본 요청에서 어차피 재시도함
      }

      const BACKOFFS_MS = [0, 5000, 10000]; // 1차 즉시, 2차 5초 후, 3차 10초 후
      let result: any = null;
      let lastErr: any = null;
      for (let attempt = 0; attempt < BACKOFFS_MS.length; attempt++) {
        if (BACKOFFS_MS[attempt] > 0) {
          console.warn(`[analyze-weld] ${attempt}차 실패 → ${BACKOFFS_MS[attempt] / 1000}초 후 재시도...`);
          await new Promise((r) => setTimeout(r, BACKOFFS_MS[attempt]));
        }
        try {
          result = await callFastApiAnalyze(callParams);
          if (attempt > 0) console.log(`[analyze-weld] ${attempt + 1}차 시도에서 성공`);
          break;
        } catch (e: any) {
          lastErr = e;
          // 400 = 사용자 입력 문제 (잘못된 사진/마커 미검출) → 재시도 의미 없음
          if (e?.status === 400) {
            console.warn(`[analyze-weld] 사용자 입력 문제 (재시도 안 함): ${e.message}`);
            break;
          }
          console.warn(`[analyze-weld] ${attempt + 1}차 시도 실패: ${e.message}`);
        }
      }
      if (!result) throw lastErr ?? new Error("FastAPI 호출 실패 (원인 불명)");

      console.log(`[analyze-weld] 성공 | aiScore=${result.aiScore} | 판정=${result.overallVerdict}`);
      res.json(result);

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
      console.error(`[analyze-weld] 최종 실패 | 오류: ${err.message}`);
      res.status(503).json({
        error: "AI_ANALYSIS_FAILED",
        message: "AI 분석 서버에 일시적인 문제가 발생했습니다. 잠시 후 다시 시도해주세요.",
        detail: err.message?.slice(0, 200),
      });
    }
  });

  // ── 빠른 측정 결과를 AI 종합 분석으로 재분석 ─────────────────────
  app.post("/api/reanalyze", largeBodyParser, async (req: Request, res: Response) => {
    const { resultId, aiModel } = req.body;
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
        process:    row.process  || "FCAW",
        posture:    row.posture  || "1G",
        material:   row.material || "탄소강 평판",
        beadType:   row.bead_type || "위빙 비드",
        passType:   "",
        aiModel:    aiModel || "gpt",
        adminFeedback,
        userHistory:        "",
        plateThickness:     "",
        pipeOuterDiameterMm: "",
        language:    "ko",
        analysisMode: "ai",
      });

      await pool.query(`
        UPDATE weld_results SET
          ai_score           = $1,
          overall_verdict    = $2,
          bead_analysis      = $3,
          defects            = $4,
          defect_locations   = $5,
          photo_analyses     = $6,
          improvements       = $7,
          comprehensive_report = $8,
          top3_defects       = $9
        WHERE id = $10
      `, [
        aiData.aiScore,
        aiData.overallVerdict,
        JSON.stringify(aiData.beadAnalysis),
        JSON.stringify(aiData.defects),
        JSON.stringify(aiData.defectLocations ?? []),
        aiData.photoAnalyses ? JSON.stringify(aiData.photoAnalyses) : null,
        JSON.stringify(aiData.improvements ?? []),
        aiData.comprehensiveReport ?? null,
        JSON.stringify(aiData.top3Defects ?? []),
        resultId,
      ]);

      console.log(`[reanalyze] 완료: ${resultId} | aiScore=${aiData.aiScore}`);
      res.json(aiData);
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
