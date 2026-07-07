// server/index.ts
import express3 from "express";

// server/routes.ts
import { createServer } from "http";

// server/weld-analysis.ts
import express from "express";

// server/db.ts
import { Pool } from "pg";
var pool = new Pool({
  connectionString: process.env.DATABASE_URL
});
var db_default = pool;

// server/weld-analysis.ts
var largeBodyParser = express.json({ limit: "30mb" });
var _rawFastapiUrl = process.env.FASTAPI_URL ?? "http://127.0.0.1:8080";
var FASTAPI_BASE = _rawFastapiUrl.startsWith("http") ? _rawFastapiUrl : `https://${_rawFastapiUrl}`;
var FASTAPI_TIMEOUT_MS = 9e4;
console.log(`[WeldAnalysis] FastAPI endpoint = ${FASTAPI_BASE}`);
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}
async function callFastApiAnalyze(params) {
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
  formData.append("process", params.process);
  formData.append("posture", params.posture);
  formData.append("material", params.material);
  formData.append("bead_type", params.beadType);
  formData.append("pass_type", params.passType);
  formData.append("ai_model", params.aiModel === "claude-sonnet" ? "claude" : "gpt");
  formData.append("admin_feedback", params.adminFeedback);
  formData.append("user_history", params.userHistory);
  formData.append("plate_thickness", params.plateThickness);
  formData.append("pipe_outer_diameter_mm", params.pipeOuterDiameterMm);
  formData.append("language", params.language);
  formData.append("analysis_mode", params.analysisMode || "quick");
  if (params.measurementContext) {
    formData.append("measurement_context", params.measurementContext);
  }
  formData.append("is_fillet", params.isFillet ? "true" : "false");
  formData.append("has_laser", params.hasLaser ? "true" : "false");
  formData.append("laser_angle_deg", params.laserAngleDeg ?? "45");
  formData.append("shooting_angle_deg", params.shootingAngleDeg ?? "90");
  const resp = await fetchWithTimeout(
    `${FASTAPI_BASE}/analyze-welding`,
    { method: "POST", body: formData },
    FASTAPI_TIMEOUT_MS
  );
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    const err = new Error(`FastAPI ${resp.status}: ${errText.slice(0, 300)}`);
    err.status = resp.status;
    err.body = errText;
    throw err;
  }
  return await resp.json();
}
function registerWeldAnalysisRoute(app2) {
  app2.post("/api/analyze-weld", largeBodyParser, async (req, res) => {
    const {
      photos,
      imageBase64,
      process: weldingProcess,
      posture,
      material,
      beadType,
      passType,
      aiModel,
      previousResultsSummary,
      plateThickness,
      pipeOuterDiameterMm,
      language,
      isFillet,
      hasLaser,
      laserAngle,
      shootingAngle
    } = req.body;
    const frontPhoto = photos?.front || imageBase64;
    if (!frontPhoto) {
      return res.status(400).json({ error: "\uC815\uBA74 \uC0AC\uC9C4\uC774 \uD544\uC694\uD569\uB2C8\uB2E4." });
    }
    const imgSizeKB = Math.round(frontPhoto.length * 0.75 / 1024);
    console.log(`[analyze-weld] \uC694\uCCAD \uC218\uC2E0 | \uC774\uBBF8\uC9C0\uD06C\uAE30=${imgSizeKB}KB | \uACF5\uC815=${weldingProcess} | AI\uBAA8\uB378=${aiModel}`);
    console.log(`[analyze-weld] \u25B6 \uD638\uCD9C \uC2DC\uB3C4 URL: ${FASTAPI_BASE}/analyze-welding`);
    try {
      let adminFeedback = "";
      try {
        const fb = await db_default.query(
          "SELECT feedback_text FROM admin_feedback ORDER BY created_at DESC LIMIT 20"
        );
        if (fb.rows.length > 0) {
          adminFeedback = fb.rows.map((r, i) => `${i + 1}. ${r.feedback_text}`).join("\n");
        }
      } catch {
      }
      const callParams = {
        frontPhoto,
        sidePhoto: photos?.side,
        backPhoto: photos?.back,
        process: weldingProcess || "FCAW",
        posture: posture || "1G",
        material: material || "\uD0C4\uC18C\uAC15 \uD3C9\uD310",
        beadType: beadType || "\uC704\uBE59 \uBE44\uB4DC",
        passType: passType || "",
        aiModel: aiModel || "gpt",
        adminFeedback,
        userHistory: previousResultsSummary || "",
        plateThickness: plateThickness || "",
        pipeOuterDiameterMm: pipeOuterDiameterMm ? String(pipeOuterDiameterMm) : "",
        language: language || "ko",
        analysisMode: "quick",
        // 최초 분석은 항상 quick 모드 (LLM 없음)
        isFillet: isFillet === true || isFillet === "true",
        hasLaser: hasLaser === true || hasLaser === "true",
        laserAngleDeg: laserAngle ? String(laserAngle) : "90",
        shootingAngleDeg: shootingAngle ? String(shootingAngle) : "90"
      };
      try {
        await fetchWithTimeout(`${FASTAPI_BASE}/`, { method: "GET" }, 3e3);
      } catch {
      }
      const BACKOFFS_MS = [0, 5e3, 1e4];
      let result = null;
      let lastErr = null;
      for (let attempt = 0; attempt < BACKOFFS_MS.length; attempt++) {
        if (BACKOFFS_MS[attempt] > 0) {
          console.warn(`[analyze-weld] ${attempt}\uCC28 \uC2E4\uD328 \u2192 ${BACKOFFS_MS[attempt] / 1e3}\uCD08 \uD6C4 \uC7AC\uC2DC\uB3C4...`);
          await new Promise((r) => setTimeout(r, BACKOFFS_MS[attempt]));
        }
        try {
          result = await callFastApiAnalyze(callParams);
          if (attempt > 0)
            console.log(`[analyze-weld] ${attempt + 1}\uCC28 \uC2DC\uB3C4\uC5D0\uC11C \uC131\uACF5`);
          break;
        } catch (e) {
          lastErr = e;
          if (e?.status === 400) {
            console.warn(`[analyze-weld] \uC0AC\uC6A9\uC790 \uC785\uB825 \uBB38\uC81C (\uC7AC\uC2DC\uB3C4 \uC548 \uD568): ${e.message}`);
            break;
          }
          console.warn(`[analyze-weld] ${attempt + 1}\uCC28 \uC2DC\uB3C4 \uC2E4\uD328: ${e.message}`);
        }
      }
      if (!result)
        throw lastErr ?? new Error("FastAPI \uD638\uCD9C \uC2E4\uD328 (\uC6D0\uC778 \uBD88\uBA85)");
      console.log(`[analyze-weld] \uC131\uACF5 | aiScore=${result.aiScore} | \uD310\uC815=${result.overallVerdict}`);
      res.json({
        ...result,
        laserAnalysis: result.visionMeasurement?.laser_analysis ?? null,
        filletAnalysis: result.filletAnalysis ?? null
      });
    } catch (err) {
      if (err?.status === 400) {
        let userMessage = "\uC6A9\uC811 \uC0AC\uC9C4\uC744 \uC778\uC2DD\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4. \uC120\uBA85\uD55C \uC6A9\uC811 \uC0AC\uC9C4\uC744 \uB2E4\uC2DC \uC5C5\uB85C\uB4DC\uD574 \uC8FC\uC138\uC694.";
        let code = "INVALID_WELD_PHOTO";
        try {
          const parsed = JSON.parse(err.body ?? "{}");
          if (parsed?.message)
            userMessage = parsed.message;
          if (parsed?.code)
            code = parsed.code;
        } catch {
        }
        console.warn(`[analyze-weld] \uC798\uBABB\uB41C \uC0AC\uC9C4 \u2014 \uC0AC\uC6A9\uC790\uC5D0\uAC8C \uC548\uB0B4: ${userMessage}`);
        return res.status(400).json({ error: code, message: userMessage });
      }
      const isFetchFailed = err.message?.includes("fetch failed") || err.message?.includes("ECONNREFUSED");
      const isTimeout = err.message?.includes("AbortError") || err.name === "AbortError";
      console.error(`[analyze-weld] \u2550\u2550 \uCD5C\uC885 \uC2E4\uD328 \u2550\u2550`);
      console.error(`[analyze-weld]  \uD638\uCD9C \uC2DC\uB3C4 URL : ${FASTAPI_BASE}/analyze-welding`);
      console.error(`[analyze-weld]  \uC624\uB958 \uBA54\uC2DC\uC9C0   : ${err.message}`);
      console.error(`[analyze-weld]  HTTP \uC0C1\uD0DC     : ${err?.status ?? "N/A"}`);
      console.error(`[analyze-weld]  \uC751\uB2F5 \uBCF8\uBB38     : ${err?.body?.slice(0, 300) ?? "N/A"}`);
      if (isFetchFailed) {
        console.error(`[analyze-weld]  \u2192 ECONNREFUSED/fetch failed \u2014 FastAPI \uC11C\uBE44\uC2A4\uAC00 \uAE30\uB3D9 \uC911\uC778\uC9C0 \uD655\uC778`);
        console.error(`[analyze-weld]  \u2192 Render \uBC30\uD3EC \uC5EC\uBD80: FASTAPI_URL \uD658\uACBD\uBCC0\uC218 = ${process.env.FASTAPI_URL ?? "(\uBBF8\uC124\uC815 \u2014 127.0.0.1:8080 \uD3F4\uBC31)"}`);
      }
      if (isTimeout) {
        console.error(`[analyze-weld]  \u2192 ${FASTAPI_TIMEOUT_MS / 1e3}\uCD08 \uD0C0\uC784\uC544\uC6C3 \uCD08\uACFC \u2014 FastAPI \uCC98\uB9AC \uC9C0\uC5F0`);
      }
      res.status(503).json({
        error: "AI_ANALYSIS_FAILED",
        message: isFetchFailed ? "\uBE44\uC804 \uBD84\uC11D \uC11C\uBC84\uC5D0 \uC5F0\uACB0\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uC7A0\uC2DC \uD6C4 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uAC70\uB098 \uAD00\uB9AC\uC790\uC5D0\uAC8C \uBB38\uC758\uD558\uC138\uC694." : isTimeout ? "AI \uBD84\uC11D \uC11C\uBC84 \uC751\uB2F5 \uC2DC\uAC04\uC774 \uCD08\uACFC\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uC0AC\uC9C4 \uD30C\uC77C \uD06C\uAE30\uB97C \uC904\uC774\uAC70\uB098 \uC7A0\uC2DC \uD6C4 \uB2E4\uC2DC \uC2DC\uB3C4\uD574\uC8FC\uC138\uC694." : "AI \uBD84\uC11D \uC11C\uBC84\uC5D0 \uC77C\uC2DC\uC801\uC778 \uBB38\uC81C\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4. \uC7A0\uC2DC \uD6C4 \uB2E4\uC2DC \uC2DC\uB3C4\uD574\uC8FC\uC138\uC694.",
        detail: err.message?.slice(0, 200)
      });
    }
  });
  app2.post("/api/reanalyze", largeBodyParser, async (req, res) => {
    const { resultId, aiModel, laserAnalysis, filletAnalysis, visionData } = req.body;
    if (!resultId)
      return res.status(400).json({ error: "resultId \uD544\uC694" });
    try {
      const dbRes = await db_default.query(
        "SELECT * FROM weld_results WHERE id = $1",
        [resultId]
      );
      if (dbRes.rows.length === 0)
        return res.status(404).json({ error: "\uACB0\uACFC\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
      const row = dbRes.rows[0];
      const photos = row.photos;
      const frontUrl = photos?.front || row.photo_uri;
      if (!frontUrl)
        return res.status(400).json({ error: "\uC0AC\uC9C4 \uB370\uC774\uD130\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4." });
      const urlToBase64 = async (url) => {
        try {
          if (url.startsWith("data:"))
            return url.split(",")[1];
          const resp = await fetchWithTimeout(url, { method: "GET" }, 15e3);
          if (!resp.ok)
            return void 0;
          const buf = await resp.arrayBuffer();
          return Buffer.from(buf).toString("base64");
        } catch {
          return void 0;
        }
      };
      const frontBase64 = await urlToBase64(frontUrl);
      if (!frontBase64)
        return res.status(400).json({ error: "\uC0AC\uC9C4\uC744 \uAC00\uC838\uC62C \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
      const sideBase64 = photos?.side ? await urlToBase64(photos.side) : void 0;
      const backBase64 = photos?.back ? await urlToBase64(photos.back) : void 0;
      const safeJson = (v) => {
        if (!v)
          return null;
        return typeof v === "string" ? JSON.parse(v) : v;
      };
      const dbBead = safeJson(row.bead_analysis);
      const dbDefects = safeJson(row.defects) ?? [];
      const dbTop3 = safeJson(row.top3_defects) ?? [];
      const fv = visionData ?? {};
      const beadSrc = fv.beadAnalysis ?? dbBead;
      const defectSrc = fv.defects ?? dbDefects;
      const top3Src = fv.top3Defects ?? dbTop3;
      const kv = (label, val) => val != null && val !== "" ? `  ${label}: ${val}` : null;
      const ctxLines = [
        "=== 1\uCC28 \uBE44\uC804 \uCE21\uC815 Ground-Truth ===",
        "\uACBD\uACE0: \uC544\uB798 \uC218\uCE58\uB294 \uBE44\uC804 AI\uAC00 \uD655\uC815\uD55C \uC2E4\uCE21\uAC12\uC774\uB2E4.",
        "\uD788\uD2B8\uB9F5\xB7\uC2DC\uAC01\uC801 \uBD84\uC11D \uD654\uBA74\uC5D0 \uD45C\uC2DC\uB41C \uC218\uCE58\uC640 100% \uB3D9\uC77C\uD55C \uAC12\uC774\uB2E4.",
        "\uB9AC\uD3EC\uD2B8 \uC791\uC131 \uC2DC \uBC18\uB4DC\uC2DC \uC774 \uC218\uCE58\uB4E4\uC744 \uC18C\uC218\uC810 \uB458\uC9F8 \uC790\uB9AC\uAE4C\uC9C0 \uC815\uD655\uD788 \uADF8\uB300\uB85C \uC778\uC6A9\uD558\uB77C.",
        "\uC544\uB798\uC5D0 \uC5C6\uB294 \uC218\uCE58\uB97C \uC9C0\uC5B4\uB0B4\uAC70\uB098(Hallucination) \uBC18\uC62C\uB9BC\xB7\uBCC0\uD615\uD558\uC5EC \uC4F0\uB294 \uAC83\uC740 \uAE08\uC9C0\uB2E4.",
        "",
        "[\uAE30\uBCF8 \uC815\uBCF4]",
        kv("AI\uC810\uC218", fv.aiScore ?? row.ai_score),
        kv("\uD310\uC815", fv.overallVerdict ?? row.overall_verdict),
        kv("\uC790\uCCB4\uC810\uC218", fv.selfScore),
        kv("\uACF5\uC815", fv.process ?? row.process),
        kv("\uC790\uC138", fv.posture ?? row.posture),
        kv("\uC7AC\uB8CC", fv.material ?? row.material),
        kv("\uBE44\uB4DC\uC720\uD615", fv.beadType ?? row.bead_type),
        kv("\uD328\uC2A4\uC720\uD615", fv.passType)
      ].filter(Boolean);
      if (beadSrc) {
        ctxLines.push("", "[\uBE44\uB4DC \uBD84\uC11D \u2014 \uD654\uBA74 \uD788\uD2B8\uB9F5 \uD45C\uC2DC\uAC12\uACFC \uB3D9\uC77C]");
        if (kv("\uBE44\uB4DC\uCD1D\uC810", beadSrc.totalScore))
          ctxLines.push(kv("\uBE44\uB4DC\uCD1D\uC810", beadSrc.totalScore));
        if (beadSrc.width)
          ctxLines.push(`  \uBE44\uB4DC\uD3ED: ${beadSrc.width.value} (${beadSrc.width.score}\uC810)`);
        if (beadSrc.straightness)
          ctxLines.push(`  \uC9C1\uC9C4\uB3C4: ${beadSrc.straightness.value} (${beadSrc.straightness.score}\uC810)`);
        if (beadSrc.height)
          ctxLines.push(`  \uBE44\uB4DC\uB192\uC774: ${beadSrc.height.value} (${beadSrc.height.score}\uC810)`);
      }
      const photoAnalyses = fv.photoAnalyses;
      if (photoAnalyses) {
        const viewLabel = { front: "\uC815\uBA74", side: "\uCE21\uBA74", back: "\uC774\uBA74" };
        for (const view of ["front", "side", "back"]) {
          const pa = photoAnalyses[view];
          if (!pa?.beadAnalysis)
            continue;
          const ba = pa.beadAnalysis;
          ctxLines.push(`  [${viewLabel[view]} \uD788\uD2B8\uB9F5] \uBE44\uB4DC\uD3ED=${ba.width?.value ?? "-"} (${ba.width?.score ?? "-"}\uC810) / \uC9C1\uC9C4\uB3C4=${ba.straightness?.value ?? "-"} (${ba.straightness?.score ?? "-"}\uC810)`);
        }
      }
      if (top3Src.length > 0) {
        ctxLines.push("", "[\uC8FC\uC694 \uACB0\uD568 Top3]");
        top3Src.forEach((d, i) => ctxLines.push(`  ${i + 1}\uC704: ${d}`));
      }
      const detectedDefects = defectSrc.filter((d) => d.detected);
      if (detectedDefects.length > 0) {
        ctxLines.push("", "[\uACB0\uD568 \uC0C1\uC138]");
        detectedDefects.forEach(
          (d) => ctxLines.push(`  - ${d.name}: \uC2EC\uAC01\uB3C4=${d.severity}, \uCE21\uC815=${d.measured}, \uAE30\uC900=${d.limit}, \uACB0\uACFC=${d.result}`)
        );
      }
      if (laserAnalysis?.status === "success") {
        ctxLines.push("", "[\uB808\uC774\uC800 3D \uCE21\uC815]");
        ctxLines.push(`  \uCD5C\uB300\uB192\uC774: ${laserAnalysis.beadHeightMax}mm`);
        ctxLines.push(`  \uCD5C\uC18C\uB192\uC774: ${laserAnalysis.beadHeightMin}mm`);
        ctxLines.push(`  \uD3C9\uADE0\uB192\uC774: ${laserAnalysis.beadHeightAvg}mm`);
        ctxLines.push(`  \uBCFC\uB85D\uC131: ${laserAnalysis.convexity} (${laserAnalysis.convexityMm}mm)`);
        if (laserAnalysis.is_cross_validated) {
          ctxLines.push(`  \uAD50\uCC28\uAC80\uC99D \uC2E0\uB8B0\uB3C4: ${laserAnalysis.confidence_score}%`);
        }
      }
      if (filletAnalysis?.beadWidth != null) {
        ctxLines.push("", "[\uD544\uB81B \uBD84\uC11D]");
        ctxLines.push(`  \uBE44\uB4DC \uD45C\uBA74\uB108\uBE44: ${filletAnalysis.beadWidth}mm`);
        ctxLines.push(`  \uB4F1\uAC01\uC7A5(Z): ${filletAnalysis.equalLeg}mm`);
        ctxLines.push(`  \uC774\uB860 \uBAA9\uB450\uAED8: ${filletAnalysis.theoreticalThroat}mm`);
        ctxLines.push(`  \uC2E4\uC81C \uBAA9\uB450\uAED8: ${filletAnalysis.actualThroat}mm`);
        ctxLines.push(`  \uBCFC\uB85D\uC131: ${filletAnalysis.convexity?.type} (${filletAnalysis.convexity?.value_mm}mm)`);
        if (filletAnalysis.unequalLeg?.isUnequal) {
          ctxLines.push(`  \uBD80\uB4F1\uAC01\uC7A5: Z1=${filletAnalysis.unequalLeg.z1}mm / Z2=${filletAnalysis.unequalLeg.z2}mm`);
        }
      }
      ctxLines.push("", "=== Ground-Truth \uB05D ===");
      const measurementContext = ctxLines.join("\n");
      console.log(`[reanalyze] Ground-Truth ${ctxLines.length}\uC904 \u2192 LLM system \uD504\uB86C\uD504\uD2B8 \uC8FC\uC785`);
      let userHistory = "";
      try {
        const historyRes = await db_default.query(
          `SELECT ai_score, overall_verdict, top3_defects, bead_analysis, timestamp
           FROM weld_results
           WHERE user_id = $1 AND id != $2
           ORDER BY timestamp ASC
           LIMIT 10`,
          [row.user_id, resultId]
        );
        if (historyRes.rows.length > 0) {
          userHistory = historyRes.rows.map((hr, i) => {
            const date = new Date(Number(hr.timestamp)).toLocaleDateString("ko-KR");
            const t3 = safeJson(hr.top3_defects) ?? [];
            const bd = safeJson(hr.bead_analysis);
            return `[${i + 1}\uD68C\uCC28] ${date} - AI\uC810\uC218:${hr.ai_score}\uC810(${hr.overall_verdict}) \uACB0\uD568:${t3.length > 0 ? t3.join(",") : "\uC5C6\uC74C"} \uBE44\uB4DC\uCD1D\uC810:${bd?.totalScore ?? "N/A"}`;
          }).join("\n");
          console.log(`[reanalyze] \uACFC\uAC70 \uC774\uB825 ${historyRes.rows.length}\uAC74 userHistory \uAD6C\uC131`);
        }
      } catch (e) {
        console.warn("[reanalyze] \uC774\uB825 \uC870\uD68C \uC2E4\uD328 (\uBB34\uC2DC):", e);
      }
      let adminFeedback = "";
      try {
        const fb = await db_default.query(
          "SELECT feedback_text FROM admin_feedback ORDER BY created_at DESC LIMIT 20"
        );
        if (fb.rows.length > 0) {
          adminFeedback = fb.rows.map((r, i) => `${i + 1}. ${r.feedback_text}`).join("\n");
        }
      } catch {
      }
      const aiData = await callFastApiAnalyze({
        frontPhoto: frontBase64,
        sidePhoto: sideBase64,
        backPhoto: backBase64,
        process: visionData?.process || row.process || "FCAW",
        posture: visionData?.posture || row.posture || "1G",
        material: visionData?.material || row.material || "\uD0C4\uC18C\uAC15 \uD3C9\uD310",
        beadType: visionData?.beadType || row.bead_type || "\uC704\uBE59 \uBE44\uB4DC",
        passType: visionData?.passType || "",
        aiModel: aiModel || "gpt",
        adminFeedback,
        userHistory,
        // Section 2~5: 과거 이력 기반 추세 분석
        measurementContext,
        // Section 1: 환각 방지용 system 프롬프트 주입
        plateThickness: "",
        pipeOuterDiameterMm: "",
        language: "ko",
        analysisMode: "ai"
      });
      await db_default.query(`
        UPDATE weld_results SET
          improvements       = $1,
          comprehensive_report = $2,
          top3_defects       = $3
        WHERE id = $4
      `, [
        JSON.stringify(aiData.improvements ?? []),
        aiData.comprehensiveReport ?? null,
        JSON.stringify(aiData.top3Defects ?? []),
        resultId
      ]);
      console.log(`[reanalyze] \uC644\uB8CC: ${resultId} | \uB9AC\uD3EC\uD2B8 ${aiData.comprehensiveReport?.length ?? 0}\uC790`);
      res.json({
        comprehensiveReport: aiData.comprehensiveReport,
        improvements: aiData.improvements ?? [],
        top3Defects: aiData.top3Defects ?? [],
        overallVerdict: aiData.overallVerdict,
        aiScore: aiData.aiScore
      });
    } catch (err) {
      console.error("[reanalyze] \uC624\uB958:", err);
      if (err?.status === 400) {
        let userMessage = "\uC6A9\uC811 \uC0AC\uC9C4\uC744 \uC778\uC2DD\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.";
        try {
          const parsed = JSON.parse(err.body ?? "{}");
          if (parsed?.message)
            userMessage = parsed.message;
        } catch {
        }
        return res.status(400).json({ error: "INVALID_WELD_PHOTO", message: userMessage });
      }
      res.status(500).json({ error: "\uC7AC\uBD84\uC11D \uC2E4\uD328", message: err.message?.slice(0, 200) });
    }
  });
}

// server/auth-routes.ts
var BUILD_TOKEN = Date.now().toString();
async function ensurePermissionsColumn() {
  await db_default.query(`ALTER TABLE weld_users ADD COLUMN IF NOT EXISTS permissions TEXT DEFAULT '[]'`);
}
ensurePermissionsColumn().catch(console.error);
async function ensureVisitorTable() {
  await db_default.query(`
    CREATE TABLE IF NOT EXISTS site_visitors (
      visit_date DATE PRIMARY KEY,
      count INT DEFAULT 0
    )
  `);
}
ensureVisitorTable().catch(console.error);
async function ensureDateColumns() {
  await db_default.query(`ALTER TABLE weld_users ADD COLUMN IF NOT EXISTS enroll_date DATE`);
  await db_default.query(`ALTER TABLE weld_users ADD COLUMN IF NOT EXISTS graduate_date DATE`);
}
ensureDateColumns().catch(console.error);
async function ensureNameColumn() {
  await db_default.query(`ALTER TABLE weld_users ADD COLUMN IF NOT EXISTS name TEXT`);
  await db_default.query(`UPDATE weld_users SET name = username WHERE name IS NULL`);
}
ensureNameColumn().catch(console.error);
function rowToUser(u) {
  let perms = [];
  try {
    perms = JSON.parse(u.permissions || "[]");
  } catch {
  }
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    role: u.role,
    courseName: u.course_name ?? void 0,
    profilePhotoUri: u.profile_photo_uri ?? void 0,
    permissions: perms,
    enrollDate: u.enroll_date ? u.enroll_date.toISOString().slice(0, 10) : void 0,
    graduateDate: u.graduate_date ? u.graduate_date.toISOString().slice(0, 10) : void 0
  };
}
function rowToAdminUser(u) {
  let perms = [];
  try {
    perms = JSON.parse(u.permissions || "[]");
  } catch {
  }
  return {
    id: u.id,
    username: u.username,
    password: u.password,
    name: u.name,
    role: u.role,
    courseName: u.course_name ?? void 0,
    profilePhotoUri: u.profile_photo_uri ?? void 0,
    permissions: perms,
    enrollDate: u.enroll_date ? u.enroll_date.toISOString().slice(0, 10) : void 0,
    graduateDate: u.graduate_date ? u.graduate_date.toISOString().slice(0, 10) : void 0
  };
}
function registerAuthRoutes(app2) {
  app2.get("/api/app-version", (_req, res) => {
    res.json({ buildToken: BUILD_TOKEN });
  });
  app2.post("/api/auth/login", async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: "\uC544\uC774\uB514\uC640 \uD328\uC2A4\uC6CC\uB4DC\uB97C \uC785\uB825\uD574\uC8FC\uC138\uC694." });
    try {
      const result = await db_default.query(
        "SELECT * FROM weld_users WHERE username = $1 AND password = $2",
        [username, password]
      );
      if (result.rows.length === 0)
        return res.status(401).json({ error: "\uC544\uC774\uB514 \uB610\uB294 \uD328\uC2A4\uC6CC\uB4DC\uAC00 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4." });
      res.json(rowToUser(result.rows[0]));
    } catch (err) {
      console.error("login error:", err);
      res.status(500).json({ error: "\uC11C\uBC84 \uC624\uB958" });
    }
  });
  app2.post("/api/auth/register", async (req, res) => {
    const { username, password, name, role, courseName, profilePhotoUri, enrollDate, graduateDate } = req.body;
    if (!username || !password || !name)
      return res.status(400).json({ error: "\uD544\uC218 \uD56D\uBAA9\uC744 \uC785\uB825\uD574\uC8FC\uC138\uC694." });
    try {
      const dupName = await db_default.query("SELECT id FROM weld_users WHERE name = $1", [name]);
      if (dupName.rows.length > 0)
        return res.status(409).json({ error: "\uC774\uBBF8 \uC0AC\uC6A9 \uC911\uC778 \uC774\uB984\uC785\uB2C8\uB2E4. \uB2E4\uB978 \uC774\uB984\uC744 \uC0AC\uC6A9\uD574\uC8FC\uC138\uC694." });
      const id = Date.now().toString() + Math.random().toString(36).substr(2, 6);
      await db_default.query(
        `INSERT INTO weld_users 
         (id, username, password, name, role, course_name, profile_photo_uri, enroll_date, graduate_date) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id,
          username,
          password,
          name,
          role || "\uAD50\uC721\uC0DD",
          courseName || null,
          profilePhotoUri || null,
          enrollDate || null,
          graduateDate || null
        ]
      );
      const result = await db_default.query("SELECT * FROM weld_users WHERE id = $1", [id]);
      res.json(rowToUser(result.rows[0]));
    } catch (err) {
      if (err.code === "23505")
        return res.status(409).json({ error: "\uC774\uBBF8 \uC0AC\uC6A9 \uC911\uC778 \uC544\uC774\uB514\uC785\uB2C8\uB2E4." });
      console.error("register error:", err);
      res.status(500).json({ error: "\uC11C\uBC84 \uC624\uB958" });
    }
  });
  app2.put("/api/auth/profile", async (req, res) => {
    const { id, name, profilePhotoUri, password } = req.body;
    if (!id)
      return res.status(400).json({ error: "\uC0AC\uC6A9\uC790 ID\uAC00 \uD544\uC694\uD569\uB2C8\uB2E4." });
    try {
      const fields = [];
      const values = [];
      let idx = 1;
      if (name !== void 0) {
        fields.push(`name = $${idx++}`);
        values.push(name);
      }
      if (profilePhotoUri !== void 0) {
        fields.push(`profile_photo_uri = $${idx++}`);
        values.push(profilePhotoUri);
      }
      if (password !== void 0) {
        fields.push(`password = $${idx++}`);
        values.push(password);
      }
      if (fields.length === 0)
        return res.status(400).json({ error: "\uBCC0\uACBD\uD560 \uB0B4\uC6A9\uC774 \uC5C6\uC2B5\uB2C8\uB2E4." });
      values.push(id);
      const result = await db_default.query(
        `UPDATE weld_users SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`,
        values
      );
      if (result.rows.length === 0)
        return res.status(404).json({ error: "\uC0AC\uC6A9\uC790\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
      res.json(rowToUser(result.rows[0]));
    } catch (err) {
      console.error("profile update error:", err);
      res.status(500).json({ error: "\uC11C\uBC84 \uC624\uB958" });
    }
  });
  app2.get("/api/auth/user/:id", async (req, res) => {
    try {
      const result = await db_default.query("SELECT * FROM weld_users WHERE id = $1", [req.params.id]);
      if (result.rows.length === 0)
        return res.status(404).json({ error: "\uC0AC\uC6A9\uC790\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
      res.json(rowToUser(result.rows[0]));
    } catch (err) {
      console.error("get user error:", err);
      res.status(500).json({ error: "\uC11C\uBC84 \uC624\uB958" });
    }
  });
  app2.get("/api/auth/students", async (req, res) => {
    try {
      const { courseName } = req.query;
      let query = `SELECT * FROM weld_users WHERE role = '\uAD50\uC721\uC0DD' ORDER BY name ASC`;
      const params = [];
      if (courseName) {
        query = `SELECT * FROM weld_users WHERE role = '\uAD50\uC721\uC0DD' AND course_name = $1 ORDER BY name ASC`;
        params.push(courseName);
      }
      const result = await db_default.query(query, params);
      res.json(result.rows.map(rowToUser));
    } catch (err) {
      console.error("get students error:", err);
      res.status(500).json({ error: "\uC11C\uBC84 \uC624\uB958" });
    }
  });
  app2.get("/api/auth/courses/progress", async (_req, res) => {
    try {
      const result = await db_default.query(`
        SELECT course_name, enroll_date, graduate_date, COUNT(*) as student_count
        FROM weld_users
        WHERE role = '\uAD50\uC721\uC0DD' AND course_name IS NOT NULL
        GROUP BY course_name, enroll_date, graduate_date
        ORDER BY enroll_date ASC
      `);
      res.json(result.rows.map((r) => ({
        courseName: r.course_name,
        enrollDate: r.enroll_date ? r.enroll_date.toISOString().slice(0, 10) : null,
        graduateDate: r.graduate_date ? r.graduate_date.toISOString().slice(0, 10) : null,
        studentCount: parseInt(r.student_count)
      })));
    } catch (err) {
      console.error("courses progress error:", err);
      res.status(500).json({ error: "\uC11C\uBC84 \uC624\uB958" });
    }
  });
  app2.get("/api/admin/users", async (_req, res) => {
    try {
      const result = await db_default.query(
        `SELECT id, username, password, name, role, course_name, profile_photo_uri, permissions, enroll_date, graduate_date
         FROM weld_users
         ORDER BY CASE role WHEN '\uAD00\uB9AC\uC790' THEN 0 WHEN '\uAD50\uC0AC' THEN 1 ELSE 2 END, name ASC`
      );
      res.json(result.rows.map(rowToAdminUser));
    } catch (err) {
      console.error("admin get users error:", err);
      res.status(500).json({ error: "\uC11C\uBC84 \uC624\uB958" });
    }
  });
  app2.put("/api/admin/users/:id", async (req, res) => {
    const { id } = req.params;
    const { role, password, courseName, permissions, profilePhotoUri, enrollDate, graduateDate } = req.body;
    try {
      const fields = [];
      const values = [];
      let idx = 1;
      if (role !== void 0) {
        fields.push(`role = $${idx++}`);
        values.push(role);
      }
      if (password !== void 0 && password !== "") {
        fields.push(`password = $${idx++}`);
        values.push(password);
      }
      if (courseName !== void 0) {
        fields.push(`course_name = $${idx++}`);
        values.push(courseName || null);
      }
      if (permissions !== void 0) {
        fields.push(`permissions = $${idx++}`);
        values.push(JSON.stringify(permissions));
      }
      if (profilePhotoUri !== void 0) {
        fields.push(`profile_photo_uri = $${idx++}`);
        values.push(profilePhotoUri || null);
      }
      if (enrollDate !== void 0) {
        fields.push(`enroll_date = $${idx++}`);
        values.push(enrollDate || null);
      }
      if (graduateDate !== void 0) {
        fields.push(`graduate_date = $${idx++}`);
        values.push(graduateDate || null);
      }
      if (fields.length === 0)
        return res.status(400).json({ error: "\uBCC0\uACBD\uD560 \uB0B4\uC6A9\uC774 \uC5C6\uC2B5\uB2C8\uB2E4." });
      values.push(id);
      const result = await db_default.query(
        `UPDATE weld_users SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`,
        values
      );
      if (result.rows.length === 0)
        return res.status(404).json({ error: "\uC0AC\uC6A9\uC790\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
      res.json(rowToAdminUser(result.rows[0]));
    } catch (err) {
      console.error("admin update user error:", err);
      res.status(500).json({ error: "\uC11C\uBC84 \uC624\uB958" });
    }
  });
  app2.get("/api/visitors", async (_req, res) => {
    try {
      const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
      await db_default.query(
        `INSERT INTO site_visitors (visit_date, count) VALUES ($1, 1)
         ON CONFLICT (visit_date) DO UPDATE SET count = site_visitors.count + 1`,
        [today]
      );
      const totalRes = await db_default.query(`SELECT COALESCE(SUM(count), 0) as total FROM site_visitors`);
      const todayRes = await db_default.query(`SELECT COALESCE(count, 0) as today FROM site_visitors WHERE visit_date = $1`, [today]);
      res.json({
        total: parseInt(totalRes.rows[0].total),
        today: parseInt(todayRes.rows[0]?.today ?? "0")
      });
    } catch (err) {
      console.error("visitor error:", err);
      res.json({ total: 0, today: 0 });
    }
  });
  app2.delete("/api/admin/users/:id", async (req, res) => {
    const { id } = req.params;
    try {
      const check = await db_default.query("SELECT username FROM weld_users WHERE id = $1", [id]);
      if (check.rows.length === 0)
        return res.status(404).json({ error: "\uC0AC\uC6A9\uC790\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
      if (check.rows[0].username === "admin")
        return res.status(403).json({ error: "\uAD00\uB9AC\uC790 \uACC4\uC815\uC740 \uC0AD\uC81C\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
      await db_default.query("DELETE FROM weld_comments WHERE user_id = $1", [id]);
      await db_default.query("DELETE FROM weld_results WHERE user_id = $1", [id]);
      await db_default.query("DELETE FROM weld_users WHERE id = $1", [id]);
      res.json({ success: true });
    } catch (err) {
      console.error("admin delete user error:", err);
      res.status(500).json({ error: "\uC11C\uBC84 \uC624\uB958" });
    }
  });
  app2.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: (/* @__PURE__ */ new Date()).toISOString() });
  });
}

// server/google-drive.ts
import { google } from "googleapis";
import { Readable } from "stream";
var FOLDER_NAME = "HHI_Welding_Photos";
var cachedFolderId = null;
function getOAuth2Client() {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    "https://developers.google.com/oauthplayground"
  );
  client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return client;
}
function getDriveClient() {
  return google.drive({ version: "v3", auth: getOAuth2Client() });
}
async function getOrCreateFolder() {
  if (cachedFolderId)
    return cachedFolderId;
  const drive = getDriveClient();
  const searchRes = await drive.files.list({
    q: `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id, name)"
  });
  if (searchRes.data.files && searchRes.data.files.length > 0) {
    cachedFolderId = searchRes.data.files[0].id;
    console.log("\u{1F4C1} \uB4DC\uB77C\uC774\uBE0C \uD3F4\uB354 \uC7AC\uC0AC\uC6A9:", cachedFolderId);
    return cachedFolderId;
  }
  const createRes = await drive.files.create({
    requestBody: {
      name: FOLDER_NAME,
      mimeType: "application/vnd.google-apps.folder"
    },
    fields: "id"
  });
  cachedFolderId = createRes.data.id;
  console.log("\u{1F4C1} \uB4DC\uB77C\uC774\uBE0C \uD3F4\uB354 \uC0DD\uC131:", cachedFolderId);
  return cachedFolderId;
}
async function makeFilePublic(drive, fileId) {
  await drive.permissions.create({
    fileId,
    requestBody: { role: "reader", type: "anyone" }
  });
}
async function uploadBase64ToGoogleDrive(base64, fileName) {
  const drive = getDriveClient();
  let folderId;
  try {
    folderId = await getOrCreateFolder();
  } catch (folderErr) {
    cachedFolderId = null;
    throw folderErr;
  }
  const buffer = Buffer.from(base64, "base64");
  const stream = Readable.from(buffer);
  const uploadRes = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId]
    },
    media: {
      mimeType: "image/jpeg",
      body: stream
    },
    fields: "id"
  });
  const fileId = uploadRes.data.id;
  if (!fileId)
    throw new Error("Google Drive \uD30C\uC77C \uC5C5\uB85C\uB4DC \uC2E4\uD328: fileId \uC5C6\uC74C");
  await makeFilePublic(drive, fileId);
  const url = `https://drive.google.com/uc?export=view&id=${fileId}`;
  console.log(`\u2705 \uB4DC\uB77C\uC774\uBE0C \uC5C5\uB85C\uB4DC \uC644\uB8CC: ${fileName} \u2192 ${url}`);
  return url;
}

// server/results-routes.ts
import express2 from "express";
var largeBodyParser2 = express2.json({ limit: "30mb" });
async function ensureColumns() {
  await db_default.query(`ALTER TABLE weld_results ADD COLUMN IF NOT EXISTS user_course_name TEXT`);
  await db_default.query(`ALTER TABLE weld_results ADD COLUMN IF NOT EXISTS bead_type TEXT`);
  await db_default.query(`ALTER TABLE weld_results ADD COLUMN IF NOT EXISTS fillet_analysis JSONB`);
  await db_default.query(`ALTER TABLE weld_results ADD COLUMN IF NOT EXISTS laser_analysis JSONB`);
  await db_default.query(`ALTER TABLE weld_results ADD COLUMN IF NOT EXISTS is_fillet BOOLEAN DEFAULT FALSE`);
}
ensureColumns().catch(console.error);
async function backfillMissingPhotoAnalyses() {
  try {
    const fallback = `jsonb_build_object(
      'beadAnalysis', NULL::jsonb,
      'defects', '[]'::jsonb,
      'defectLocations', '[]'::jsonb,
      'straightnessLines', '[]'::jsonb,
      'analysisStatus', 'no_bead_detected'
    )`;
    const sideResult = await db_default.query(`
      UPDATE weld_results
      SET photo_analyses = COALESCE(photo_analyses, '{}'::jsonb) || jsonb_build_object('side', ${fallback})
      WHERE photos->>'side' IS NOT NULL AND (photo_analyses IS NULL OR (photo_analyses->'side') IS NULL)
    `);
    const backResult = await db_default.query(`
      UPDATE weld_results
      SET photo_analyses = COALESCE(photo_analyses, '{}'::jsonb) || jsonb_build_object('back', ${fallback})
      WHERE photos->>'back' IS NOT NULL AND (photo_analyses IS NULL OR (photo_analyses->'back') IS NULL)
    `);
    const total = (sideResult.rowCount ?? 0) + (backResult.rowCount ?? 0);
    if (total > 0) {
      console.log(
        `[Migration] photo_analyses \uBCF4\uC815 \uC644\uB8CC \u2014 \uCE21\uBA74 ${sideResult.rowCount ?? 0}\uD589, \uC774\uBA74 ${backResult.rowCount ?? 0}\uD589`
      );
    }
  } catch (err) {
    console.error("[Migration] photo_analyses \uBCF4\uC815 \uC2E4\uD328:", err);
  }
}
backfillMissingPhotoAnalyses().catch(console.error);
async function ensureAdminFeedbackTable() {
  await db_default.query(`
    CREATE TABLE IF NOT EXISTS admin_feedback (
      id SERIAL PRIMARY KEY,
      result_id VARCHAR(255),
      user_name VARCHAR(255),
      feedback_text TEXT NOT NULL,
      created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000
    )
  `);
}
ensureAdminFeedbackTable().catch(console.error);
async function ensureCommentsTable() {
  await db_default.query(`
    CREATE TABLE IF NOT EXISTS weld_comments (
      id SERIAL PRIMARY KEY,
      result_id VARCHAR(255) NOT NULL,
      parent_id INT REFERENCES weld_comments(id) ON DELETE CASCADE,
      user_id VARCHAR(255) NOT NULL,
      user_name VARCHAR(255) NOT NULL,
      user_role VARCHAR(50) NOT NULL DEFAULT '\uAD50\uC721\uC0DD',
      content TEXT NOT NULL,
      created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000
    )
  `);
  await db_default.query(`CREATE INDEX IF NOT EXISTS idx_weld_comments_result_id ON weld_comments(result_id)`);
}
ensureCommentsTable().catch(console.error);
function rowToResult(row) {
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    userProfileUri: row.user_profile_uri,
    userCourseName: row.user_course_name ?? void 0,
    photoUri: row.photo_uri,
    photos: row.photos,
    process: row.process,
    processCustom: row.process_custom,
    posture: row.posture,
    postureCustom: row.posture_custom,
    material: row.material,
    materialCustom: row.material_custom,
    beadType: row.bead_type ?? void 0,
    selfScore: Number(row.self_score),
    aiScore: Number(row.ai_score),
    grade: row.grade,
    overallVerdict: row.overall_verdict,
    beadAnalysis: row.bead_analysis,
    defects: row.defects,
    defectLocations: row.defect_locations,
    photoAnalyses: row.photo_analyses,
    improvements: row.improvements,
    comprehensiveReport: row.comprehensive_report,
    top3Defects: row.top3_defects,
    trendScores: row.trend_scores,
    timestamp: Number(row.timestamp),
    // 필릿·레이저 분석: JSONB → pg가 자동 파싱, null이면 JS null 반환
    filletAnalysis: row.fillet_analysis ?? null,
    laserAnalysis: row.laser_analysis ?? null,
    isFillet: row.is_fillet ?? false
  };
}
function rowToResultLite(row) {
  const r = rowToResult(row);
  const stripBase64 = (v) => typeof v === "string" && (v.startsWith("http://") || v.startsWith("https://") || v.startsWith("data:")) ? v : void 0;
  const photos = r.photos;
  const litePhotos = photos ? {
    front: stripBase64(photos.front),
    side: stripBase64(photos.side),
    back: stripBase64(photos.back)
  } : void 0;
  return {
    ...r,
    photoUri: stripBase64(r.photoUri),
    photos: litePhotos,
    // 목록에서 무거운 상세 분석 필드 제외 (상세 조회 GET /api/results/:id 에서만 반환)
    photoAnalyses: void 0,
    improvements: void 0,
    comprehensiveReport: void 0,
    defectLocations: void 0,
    laserAnalysis: void 0,
    filletAnalysis: void 0
  };
}
function registerResultsRoutes(app2) {
  app2.post("/api/upload-photo", largeBodyParser2, async (req, res) => {
    const { base64, fileName } = req.body;
    if (!base64 || !fileName)
      return res.status(400).json({ error: "base64, fileName \uD544\uC694" });
    try {
      const url = await uploadBase64ToGoogleDrive(base64, fileName);
      res.json({ url });
    } catch (err) {
      console.error("[Node] \uAD6C\uAE00 \uB4DC\uB77C\uC774\uBE0C \uBC31\uC5C5 \uC2E4\uD328 (\uBB34\uC2DC\uD558\uACE0 \uB85C\uCEEC \uBD84\uC11D \uC9C4\uD589):", err?.message ?? err);
      res.json({ url: null });
    }
  });
  app2.get("/api/results", async (req, res) => {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "20"), 10) || 20, 1), 100);
    const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);
    try {
      const result = await db_default.query(
        `SELECT r.id, r.user_id, r.user_name, r.user_profile_uri,
                COALESCE(r.user_course_name, u.course_name) AS user_course_name,
                r.photo_uri, r.photos,
                r.process, r.process_custom, r.posture, r.posture_custom,
                r.material, r.material_custom, r.bead_type,
                r.self_score, r.ai_score, r.grade, r.overall_verdict,
                r.bead_analysis, r.defects, r.top3_defects, r.trend_scores,
                r.timestamp, r.is_fillet
         FROM weld_results r
         LEFT JOIN weld_users u ON r.user_id = u.id
         ORDER BY r.timestamp DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      res.json(result.rows.map(rowToResultLite));
    } catch (err) {
      console.error("get results error:", err);
      res.status(500).json({ error: "\uC11C\uBC84 \uC624\uB958" });
    }
  });
  app2.get("/api/results/user/:userId", async (req, res) => {
    try {
      const result = await db_default.query(
        "SELECT r.*, COALESCE(r.user_course_name, u.course_name) as user_course_name FROM weld_results r LEFT JOIN weld_users u ON r.user_id = u.id WHERE r.user_id = $1 ORDER BY r.timestamp DESC",
        [req.params.userId]
      );
      res.json(result.rows.map(rowToResultLite));
    } catch (err) {
      console.error("get user results error:", err);
      res.status(500).json({ error: "\uC11C\uBC84 \uC624\uB958" });
    }
  });
  app2.get("/api/results/:id", async (req, res) => {
    try {
      const result = await db_default.query(
        "SELECT r.*, COALESCE(r.user_course_name, u.course_name) as user_course_name FROM weld_results r LEFT JOIN weld_users u ON r.user_id = u.id WHERE r.id = $1",
        [req.params.id]
      );
      if (result.rows.length === 0)
        return res.status(404).json({ error: "\uACB0\uACFC\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
      res.json(rowToResult(result.rows[0]));
    } catch (err) {
      console.error("get result error:", err);
      res.status(500).json({ error: "\uC11C\uBC84 \uC624\uB958" });
    }
  });
  app2.post("/api/results", async (req, res) => {
    const r = req.body;
    if (!r.id || !r.userId)
      return res.status(400).json({ error: "\uD544\uC218 \uD56D\uBAA9\uC774 \uC5C6\uC2B5\uB2C8\uB2E4." });
    try {
      await db_default.query(
        `INSERT INTO weld_results (
          id, user_id, user_name, user_profile_uri, user_course_name, photo_uri, photos,
          process, process_custom, posture, posture_custom, material, material_custom,
          bead_type, self_score, ai_score, grade, overall_verdict,
          bead_analysis, defects, defect_locations, photo_analyses, improvements,
          comprehensive_report, top3_defects, trend_scores, timestamp,
          fillet_analysis, laser_analysis, is_fillet
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
          $13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,
          $28,$29,$30
        ) ON CONFLICT (id) DO NOTHING`,
        [
          r.id,
          r.userId,
          r.userName,
          r.userProfileUri ?? null,
          r.userCourseName ?? null,
          r.photoUri ?? null,
          JSON.stringify(r.photos ?? null),
          r.process,
          r.processCustom ?? null,
          r.posture,
          r.postureCustom ?? null,
          r.material,
          r.materialCustom ?? null,
          r.beadType ?? null,
          r.selfScore,
          r.aiScore,
          r.grade,
          r.overallVerdict,
          JSON.stringify(r.beadAnalysis),
          JSON.stringify(r.defects),
          JSON.stringify(r.defectLocations ?? []),
          r.photoAnalyses ? JSON.stringify(r.photoAnalyses) : null,
          JSON.stringify(r.improvements ?? []),
          r.comprehensiveReport ?? null,
          JSON.stringify(r.top3Defects ?? []),
          JSON.stringify(r.trendScores ?? []),
          r.timestamp,
          // 필릿·레이저: null이면 SQL NULL로 저장 (JSON.stringify(null)="null" 방지)
          r.filletAnalysis ? JSON.stringify(r.filletAnalysis) : null,
          r.laserAnalysis ? JSON.stringify(r.laserAnalysis) : null,
          r.filletAnalysis ? true : false
        ]
      );
      res.json({ success: true });
    } catch (err) {
      console.error("add result error:", err);
      res.status(500).json({ error: "\uC11C\uBC84 \uC624\uB958" });
    }
  });
  app2.delete("/api/results/:id", async (req, res) => {
    try {
      await db_default.query("DELETE FROM weld_results WHERE id = $1", [req.params.id]);
      res.json({ success: true });
    } catch (err) {
      console.error("delete result error:", err);
      res.status(500).json({ error: "\uC11C\uBC84 \uC624\uB958" });
    }
  });
  app2.put("/api/results/:id/photos", async (req, res) => {
    const { photoUri, photos } = req.body;
    try {
      await db_default.query(
        `UPDATE weld_results SET
          photo_uri = COALESCE($1, photo_uri),
          photos = COALESCE($2::jsonb, photos)
        WHERE id = $3`,
        [photoUri ?? null, photos ? JSON.stringify(photos) : null, req.params.id]
      );
      res.json({ success: true });
    } catch (err) {
      console.error("update photos error:", err);
      res.status(500).json({ error: "\uC11C\uBC84 \uC624\uB958" });
    }
  });
  app2.put("/api/results/:id/profile", async (req, res) => {
    const { userName, userProfileUri } = req.body;
    try {
      await db_default.query(
        "UPDATE weld_results SET user_name = COALESCE($1, user_name), user_profile_uri = COALESCE($2, user_profile_uri) WHERE user_id = $3",
        [userName ?? null, userProfileUri ?? null, req.params.id]
      );
      res.json({ success: true });
    } catch (err) {
      console.error("update result profile error:", err);
      res.status(500).json({ error: "\uC11C\uBC84 \uC624\uB958" });
    }
  });
  app2.post("/api/admin-feedback", async (req, res) => {
    const { resultId, userName, feedbackText } = req.body;
    if (!feedbackText?.trim())
      return res.status(400).json({ error: "\uD53C\uB4DC\uBC31 \uB0B4\uC6A9\uC774 \uC5C6\uC2B5\uB2C8\uB2E4." });
    try {
      await db_default.query(
        "INSERT INTO admin_feedback (result_id, user_name, feedback_text) VALUES ($1, $2, $3)",
        [resultId ?? null, userName ?? null, feedbackText.trim()]
      );
      res.json({ success: true });
    } catch (err) {
      console.error("admin feedback error:", err);
      res.status(500).json({ error: "\uC11C\uBC84 \uC624\uB958" });
    }
  });
  app2.get("/api/admin-feedback", async (_req, res) => {
    try {
      const result = await db_default.query(
        "SELECT id, result_id, user_name, feedback_text, created_at FROM admin_feedback ORDER BY created_at DESC"
      );
      res.json(result.rows);
    } catch (err) {
      console.error("get admin feedback error:", err);
      res.status(500).json({ error: "\uC11C\uBC84 \uC624\uB958" });
    }
  });
  app2.delete("/api/admin-feedback/:id", async (req, res) => {
    try {
      await db_default.query("DELETE FROM admin_feedback WHERE id = $1", [req.params.id]);
      res.json({ success: true });
    } catch (err) {
      console.error("delete admin feedback error:", err);
      res.status(500).json({ error: "\uC11C\uBC84 \uC624\uB958" });
    }
  });
  app2.get("/api/comments/:resultId", async (req, res) => {
    try {
      const { rows } = await db_default.query(
        "SELECT * FROM weld_comments WHERE result_id = $1 ORDER BY created_at ASC",
        [req.params.resultId]
      );
      const topLevel = rows.filter((r) => !r.parent_id);
      const replies = rows.filter((r) => r.parent_id);
      const structured = topLevel.map((c) => ({
        id: c.id,
        resultId: c.result_id,
        parentId: null,
        userId: c.user_id,
        userName: c.user_name,
        userRole: c.user_role,
        content: c.content,
        createdAt: Number(c.created_at),
        replies: replies.filter((r) => r.parent_id === c.id).map((r) => ({
          id: r.id,
          resultId: r.result_id,
          parentId: r.parent_id,
          userId: r.user_id,
          userName: r.user_name,
          userRole: r.user_role,
          content: r.content,
          createdAt: Number(r.created_at),
          replies: []
        }))
      }));
      res.json(structured);
    } catch (err) {
      console.error("get comments error:", err);
      res.status(500).json({ error: "\uC11C\uBC84 \uC624\uB958" });
    }
  });
  app2.get("/api/comments-count", async (req, res) => {
    try {
      const { rows } = await db_default.query(
        "SELECT result_id, COUNT(*) as count FROM weld_comments GROUP BY result_id"
      );
      const map = {};
      rows.forEach((r) => {
        map[r.result_id] = Number(r.count);
      });
      res.json(map);
    } catch (err) {
      console.error("get comments count error:", err);
      res.status(500).json({ error: "\uC11C\uBC84 \uC624\uB958" });
    }
  });
  app2.post("/api/comments", async (req, res) => {
    const { resultId, parentId, userId, userName, userRole, content } = req.body;
    if (!resultId || !userId || !content?.trim()) {
      return res.status(400).json({ error: "\uD544\uC218 \uD56D\uBAA9\uC774 \uC5C6\uC2B5\uB2C8\uB2E4." });
    }
    try {
      const { rows } = await db_default.query(
        `INSERT INTO weld_comments (result_id, parent_id, user_id, user_name, user_role, content)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [resultId, parentId ?? null, userId, userName, userRole ?? "\uAD50\uC721\uC0DD", content.trim()]
      );
      const r = rows[0];
      res.json({
        id: r.id,
        resultId: r.result_id,
        parentId: r.parent_id,
        userId: r.user_id,
        userName: r.user_name,
        userRole: r.user_role,
        content: r.content,
        createdAt: Number(r.created_at),
        replies: []
      });
    } catch (err) {
      console.error("post comment error:", err);
      res.status(500).json({ error: "\uC11C\uBC84 \uC624\uB958" });
    }
  });
  app2.delete("/api/comments/:id", async (req, res) => {
    const { userId, isAdmin } = req.query;
    try {
      if (isAdmin === "true") {
        await db_default.query("DELETE FROM weld_comments WHERE id = $1", [req.params.id]);
      } else {
        await db_default.query("DELETE FROM weld_comments WHERE id = $1 AND user_id = $2", [req.params.id, userId]);
      }
      res.json({ success: true });
    } catch (err) {
      console.error("delete comment error:", err);
      res.status(500).json({ error: "\uC11C\uBC84 \uC624\uB958" });
    }
  });
}

// shared/theory-questions.ts
var THEORY_QUESTIONS = [
  {
    "id": "s1q1",
    "set": 1,
    "num": 1,
    "difficulty": "easy",
    "category": "\uC6A9\uC811\uACFC \uAD00\uB828\uB41C \uC548\uC804",
    "question": "GTAW \uC6A9\uC811 \uC791\uC5C5 \uC2DC \uBC1C\uC0DD\uD558\uB294 \uAC15\uD55C \uC790\uC678\uC120\uC73C\uB85C\uBD80\uD130 \uB208\uACFC \uC548\uBA74\uC744 \uBCF4\uD638\uD558\uAE30 \uC704\uD574 \uBC18\uB4DC\uC2DC \uCC29\uC6A9\uD574\uC57C \uD558\uB294 \uBCF4\uD638\uAD6C\uB294?",
    "options": [
      "\uC77C\uBC18 \uBCF4\uC548\uACBD",
      "\uD22C\uBA85 \uC544\uD06C\uB9B4 \uBA74",
      "\uCC28\uAD11 \uC720\uB9AC\uAC00 \uBD80\uCC29\uB41C \uC6A9\uC811\uBA74",
      "\uC120\uAE00\uB77C\uC2A4"
    ],
    "correctIndex": 2,
    "explanation": "\uC544\uD06C \uC6A9\uC811 \uC2DC \uBC1C\uC0DD\uD558\uB294 \uC790\uC678\uC120\uACFC \uC801\uC678\uC120\uC740 \uB9DD\uB9C9 \uD654\uC0C1\uC744 \uC720\uBC1C\uD560 \uC218 \uC788\uC73C\uBBC0\uB85C \uBC18\uB4DC\uC2DC \uADDC\uC815\uB41C \uCC28\uAD11 \uBC88\uD638\uC758 \uC6A9\uC811\uBA74\uC744 \uCC29\uC6A9\uD574\uC57C \uD569\uB2C8\uB2E4."
  },
  {
    "id": "s1q2",
    "set": 1,
    "num": 2,
    "difficulty": "medium",
    "category": "\uC6A9\uC811\uACFC \uAD00\uB828\uB41C \uC548\uC804",
    "question": "\uC6A9\uC811 \uC791\uC5C5\uC7A5\uC758 \uD658\uAE30 \uC2DC\uC124\uC5D0 \uB300\uD55C \uC124\uBA85\uC73C\uB85C \uAC00\uC7A5 \uC62C\uBC14\uB978 \uAC83\uC740?",
    "options": [
      "\uC544\uB974\uACE4 \uAC00\uC2A4\uB294 \uACF5\uAE30\uBCF4\uB2E4 \uAC00\uBCBC\uC6CC \uC704\uB85C \uD37C\uC9C0\uBBC0\uB85C \uCC9C\uC7A5 \uD658\uAE30\uD32C\uB9CC \uCF1C\uB454\uB2E4.",
      "\uD658\uAE30 \uC2DC\uC124\uC740 \uC6A9\uC811 \uC544\uD06C\uB97C \uC9C1\uC811 \uD5A5\uD558\uB3C4\uB85D \uAC15\uD558\uAC8C \uD2C0\uC5B4\uC900\uB2E4.",
      "\uC544\uB974\uACE4(Ar)\uC740 \uACF5\uAE30\uBCF4\uB2E4 \uBB34\uAC70\uC6CC \uBC14\uB2E5\uC5D0 \uAC00\uB77C\uC549\uC73C\uBBC0\uB85C \uBC00\uD3D0\uACF5\uAC04\uC5D0\uC11C\uB294 \uC0B0\uC18C \uACB0\uD54D\uC5D0 \uC8FC\uC758\uD558\uACE0 \uD558\uB2E8 \uBC30\uAE30\uB97C \uC2E4\uC2DC\uD55C\uB2E4.",
      "\uACA8\uC6B8\uCCA0\uC5D0\uB294 \uBCF4\uC628\uC744 \uC704\uD574 \uD658\uAE30\uB97C \uC0DD\uB7B5\uD574\uB3C4 \uBB34\uBC29\uD558\uB2E4."
    ],
    "correctIndex": 2,
    "explanation": "GTAW\uC758 \uBCF4\uD638\uAC00\uC2A4\uC778 \uC544\uB974\uACE4\uC740 \uACF5\uAE30\uBCF4\uB2E4 \uBB34\uAC70\uC6CC \uBC00\uD3D0\uB41C \uACF3\uC5D0\uC11C\uB294 \uBC14\uB2E5\uC5D0 \uC313\uC5EC \uC9C8\uC2DD\uC744 \uC720\uBC1C\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4."
  },
  {
    "id": "s1q3",
    "set": 1,
    "num": 3,
    "difficulty": "hard",
    "category": "\uC6A9\uC811\uACFC \uAD00\uB828\uB41C \uC548\uC804",
    "question": "\uC6A9\uC811\uAE30 \uC0AC\uC6A9 \uC911 \uAC10\uC804 \uC0AC\uACE0\uB97C \uC608\uBC29\uD558\uAE30 \uC704\uD55C \uC870\uCE58\uB85C \uD2C0\uB9B0 \uAC83\uC740?",
    "options": [
      "\uD640\uB354\uB098 \uD1A0\uCE58\uC758 \uC808\uC5F0 \uC0C1\uD0DC\uB97C \uC218\uC2DC\uB85C \uC810\uAC80\uD55C\uB2E4.",
      "\uC6A9\uC811\uAE30 \uCF00\uC774\uC2A4\uB294 \uBC18\uB4DC\uC2DC \uC811\uC9C0(Earth)\uB97C \uC2E4\uC2DC\uD55C\uB2E4.",
      "\uB540\uC5D0 \uC816\uC740 \uC7A5\uAC11\uC774\uB098 \uC791\uC5C5\uBCF5\uC744 \uC785\uACE0 \uC791\uC5C5\uD558\uC9C0 \uC54A\uB294\uB2E4.",
      "\uC804\uACA9\uBC29\uC9C0\uAE30\uB294 \uC544\uD06C \uBC1C\uC0DD \uC2DC\uC5D0\uB9CC \uC804\uC555\uC744 \uB0AE\uCDB0\uC8FC\uB294 \uC7A5\uCE58\uC774\uBBC0\uB85C \uC0C1\uC2DC \uAEBC\uB454\uB2E4."
    ],
    "correctIndex": 3,
    "explanation": "\uC804\uACA9\uBC29\uC9C0\uAE30\uB294 \uC544\uD06C\uAC00 \uBC1C\uC0DD\uD558\uC9C0 \uC54A\uB294 \uBB34\uBD80\uD558 \uC0C1\uD0DC\uC5D0\uC11C \uC804\uC555\uC744 20~30V \uC774\uD558\uC758 \uC548\uC804\uC804\uC555\uC73C\uB85C \uB0AE\uCDB0\uC8FC\uC5B4 \uAC10\uC804\uC744 \uC608\uBC29\uD558\uB294 \uC7A5\uCE58\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s1q4",
    "set": 1,
    "num": 4,
    "difficulty": "easy",
    "category": "\uC7A5\uBE44 \uBC0F \uB3C4\uAD6C, \uBA85\uCE6D\uACFC \uAE30\uB2A5",
    "question": "GTAW \uD1A0\uCE58 \uBD80\uD488 \uC911, \uD145\uC2A4\uD150 \uC804\uADF9\uBD09\uC744 \uAF49 \uC7A1\uC544\uC8FC\uC5B4 \uC804\uB958\uB97C \uC804\uB2EC\uD558\uB294 \uC5ED\uD560\uC744 \uD558\uB294 \uBD80\uD488\uC740?",
    "options": [
      "\uC138\uB77C\uBBF9 \uB178\uC990",
      "\uCF5C\uB9BF (Collet)",
      "\uAC00\uC2A4 \uB80C\uC988",
      "\uBC31 \uCEA1 (Back cap)"
    ],
    "correctIndex": 1,
    "explanation": "\uCF5C\uB9BF\uC740 \uC804\uADF9\uBD09\uC744 \uBB3C\uB9AC\uC801\uC73C\uB85C \uACE0\uC815\uD558\uACE0 \uC6A9\uC811\uAE30 \uCF00\uC774\uBE14\uB85C\uBD80\uD130 \uC628 \uC804\uB958\uB97C \uD145\uC2A4\uD150 \uC804\uADF9\uC73C\uB85C \uC804\uB2EC\uD558\uB294 \uD575\uC2EC \uBD80\uD488\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s1q5",
    "set": 1,
    "num": 5,
    "difficulty": "medium",
    "category": "\uC7A5\uBE44 \uBC0F \uB3C4\uAD6C, \uBA85\uCE6D\uACFC \uAE30\uB2A5",
    "question": "\uC6A9\uC811\uAE30 \uC804\uBA74 \uD328\uB110\uC5D0\uC11C '\uD06C\uB808\uC774\uD130 \uCC98\uB9AC(Crater fill)' \uAE30\uB2A5\uC758 \uC8FC\uB41C \uBAA9\uC801\uC740 \uBB34\uC5C7\uC778\uAC00?",
    "options": [
      "\uC544\uD06C\uB97C \uCC98\uC74C \uBC1C\uC0DD\uC2DC\uD0AC \uB54C \uC804\uC555\uC744 \uB192\uC5EC\uC8FC\uAE30 \uC704\uD574",
      "\uC6A9\uC811 \uC2DC\uC791 \uC804 \uBCF4\uD638\uAC00\uC2A4\uB97C \uBBF8\uB9AC \uB0B4\uBCF4\uB0B4\uAE30 \uC704\uD574",
      "\uC6A9\uC811 \uC885\uB8CC \uC2DC \uC804\uB958\uB97C \uC11C\uC11C\uD788 \uB0AE\uCDB0 \uD06C\uB808\uC774\uD130 \uADE0\uC5F4\uC774\uB098 \uACB0\uD568\uC744 \uBC29\uC9C0\uD558\uAE30 \uC704\uD574",
      "\uC6A9\uC811 \uC911 \uAD50\uB958 \uC8FC\uD30C\uC218\uB97C \uC870\uC808\uD558\uAE30 \uC704\uD574"
    ],
    "correctIndex": 2,
    "explanation": "\uD06C\uB808\uC774\uD130 \uCC98\uB9AC\uB294 \uC6A9\uC811\uC744 \uB05D\uB0BC \uB54C \uC804\uB958\uB97C \uC810\uC9C4\uC801\uC73C\uB85C \uAC10\uC18C\uC2DC\uCF1C(\uB2E4\uC6B4 \uC2AC\uB85C\uD504) \uC6A9\uC735\uC9C0(\uD06C\uB808\uC774\uD130)\uAC00 \uAE09\uACA9\uD788 \uC2DD\uC73C\uBA74\uC11C \uC0DD\uAE30\uB294 \uC218\uCD95 \uADE0\uC5F4\uACFC \uD540\uD640\uC744 \uB9C9\uC544\uC90D\uB2C8\uB2E4."
  },
  {
    "id": "s1q6",
    "set": 1,
    "num": 6,
    "difficulty": "easy",
    "category": "\uC6A9\uC811\uC758 \uC885\uB958",
    "question": "\uBAA8\uC7AC\uB97C \uB179\uC774\uC9C0 \uC54A\uACE0 \uC6A9\uAC00\uC7AC(Filler metal)\uB9CC \uB179\uC5EC\uC11C \uBAA8\uC7AC\uB97C \uACB0\uD569\uD558\uB294 \uC6A9\uC811\uBC95\uC740?",
    "options": [
      "\uD53C\uBCF5\uC544\uD06C\uC6A9\uC811",
      "\uBE0C\uB808\uC774\uC9D5 (Brazing)",
      "\uAC00\uC2A4\uBA54\uD0C8\uC544\uD06C\uC6A9\uC811(GMAW)",
      "\uC11C\uBE0C\uBA38\uC9C0\uB4DC\uC544\uD06C\uC6A9\uC811(SAW)"
    ],
    "correctIndex": 1,
    "explanation": "\uBE0C\uB808\uC774\uC9D5(\uACBD\uB0A9\uB55C)\uACFC \uC194\uB354\uB9C1(\uC5F0\uB0A9\uB55C)\uC740 \uBAA8\uC7AC\uC758 \uC6A9\uC735\uC810 \uC774\uD558\uC5D0\uC11C \uC6A9\uAC00\uC7AC\uB9CC \uB179\uC5EC \uC811\uD569\uD558\uB294 \uBC29\uC2DD\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s1q7",
    "set": 1,
    "num": 7,
    "difficulty": "medium",
    "category": "\uC6A9\uC811\uC758 \uC885\uB958",
    "question": "\uB2E4\uC74C \uC911 \uACE0\uC0C1\uC6A9\uC811(Solid-state welding)\uC5D0 \uD574\uB2F9\uD558\uC9C0 \uC54A\uB294 \uAC83\uC740?",
    "options": [
      "\uB9C8\uCC30\uC6A9\uC811",
      "\uCD08\uC74C\uD30C\uC6A9\uC811",
      "\uD3ED\uBC1C\uC6A9\uC811",
      "\uC77C\uB809\uD2B8\uB85C\uC2AC\uB798\uADF8\uC6A9\uC811"
    ],
    "correctIndex": 3,
    "explanation": "\uC77C\uB809\uD2B8\uB85C\uC2AC\uB798\uADF8 \uC6A9\uC811\uC740 \uC6A9\uC735\uB41C \uC2AC\uB798\uADF8\uC758 \uC800\uD56D\uC5F4\uC744 \uC774\uC6A9\uD558\uC5EC \uBAA8\uC7AC\uC640 \uC6A9\uAC00\uC7AC\uB97C \uB179\uC774\uB294 \uC6A9\uC735\uC6A9\uC811\uC758 \uC77C\uC885\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s1q8",
    "set": 1,
    "num": 8,
    "difficulty": "easy",
    "category": "\uC544\uD06C\uC758 \uC774\uD574",
    "question": "GTAW \uC6A9\uC811 \uC911 \uD1A0\uCE58\uB97C \uBAA8\uC7AC\uC5D0\uC11C \uB108\uBB34 \uBA40\uB9AC \uB744\uC6CC \uC544\uD06C \uAE38\uC774\uAC00 \uAE38\uC5B4\uC84C\uC744 \uB54C \uB098\uD0C0\uB098\uB294 \uD604\uC0C1\uC740?",
    "options": [
      "\uC804\uC555\uC774 \uAC10\uC18C\uD55C\uB2E4.",
      "\uC544\uD06C\uAC00 \uC548\uC815\uB41C\uB2E4.",
      "\uBCF4\uD638\uAC00\uC2A4 \uD6A8\uACFC\uAC00 \uB5A8\uC5B4\uC838 \uAE30\uACF5(Porosity)\uC774 \uBC1C\uC0DD\uD558\uAE30 \uC27D\uB2E4.",
      "\uC6A9\uC785\uC774 \uAE4A\uC5B4\uC9C4\uB2E4."
    ],
    "correctIndex": 2,
    "explanation": "\uC544\uD06C \uAE38\uC774\uAC00 \uAE38\uC5B4\uC9C0\uBA74 \uC544\uD06C\uAC00 \uBD88\uC548\uC815\uD574\uC9C0\uACE0 \uAC00\uC2A4 \uC274\uB4DC \uBC94\uC704\uAC00 \uBC97\uC5B4\uB098 \uC678\uBD80 \uACF5\uAE30\uAC00 \uCE68\uD22C\uD558\uC5EC \uAE30\uACF5 \uC0B0\uD654 \uACB0\uD568\uC774 \uC0DD\uAE41\uB2C8\uB2E4."
  },
  {
    "id": "s1q9",
    "set": 1,
    "num": 9,
    "difficulty": "hard",
    "category": "\uC544\uD06C\uC758 \uC774\uD574",
    "question": "\uC6A9\uC811 \uC911 \uC544\uD06C \uC3E0\uB9BC(Arc Blow) \uD604\uC0C1\uC774 \uBC1C\uC0DD\uD560 \uB54C\uC758 \uB300\uCC45\uC73C\uB85C \uC801\uC808\uD558\uC9C0 \uC54A\uC740 \uAC83\uC740?",
    "options": [
      "\uAD50\uB958(AC) \uC6A9\uC811\uAE30\uB97C \uC0AC\uC6A9\uD55C\uB2E4.",
      "\uC811\uC9C0\uC810(Earth)\uC744 \uC6A9\uC811\uBD80\uC5D0\uC11C \uBA40\uB9AC \uD558\uAC70\uB098 \uC591\uCABD\uC73C\uB85C \uBD84\uC0B0\uC2DC\uD0A8\uB2E4.",
      "\uC544\uD06C \uAE38\uC774\uB97C \uCD5C\uB300\uD55C \uAE38\uAC8C \uC720\uC9C0\uD55C\uB2E4.",
      "\uAC00\uC811(Tack welding)\uC744 \uC5EC\uB7EC \uACF3\uC5D0 \uD2BC\uD2BC\uD558\uAC8C \uD55C\uB2E4."
    ],
    "correctIndex": 2,
    "explanation": "\uC544\uD06C \uC3E0\uB9BC\uC744 \uBC29\uC9C0\uD558\uB824\uBA74 \uC544\uD06C \uAE38\uC774\uB97C \uC9E7\uAC8C \uC720\uC9C0\uD558\uC5EC \uC790\uB825\uC120\uC758 \uC601\uD5A5\uC744 \uCD5C\uC18C\uD654\uD574\uC57C \uD569\uB2C8\uB2E4."
  },
  {
    "id": "s1q10",
    "set": 1,
    "num": 10,
    "difficulty": "easy",
    "category": "\uC6A9\uC811 \uACB0\uD568",
    "question": "\uC6A9\uC811 \uC804\uB958\uAC00 \uB108\uBB34 \uB192\uAC70\uB098 \uC6B4\uBD09 \uC18D\uB3C4\uAC00 \uB290\uB9B4 \uB54C, \uBAA8\uC7AC\uAC00 \uB179\uC544\uB0B4\uB824 \uAD6C\uBA4D\uC774 \uB6AB\uB9AC\uB294 \uACB0\uD568\uC740?",
    "options": [
      "\uC5B8\uB354\uCEF7 (Undercut)",
      "\uC624\uBC84\uB7A9 (Overlap)",
      "\uC6A9\uB77D (Burn-through)",
      "\uC2AC\uB798\uADF8 \uC11E\uC784 (Slag inclusion)"
    ],
    "correctIndex": 2,
    "explanation": "\uACFC\uB3C4\uD55C \uC785\uC5F4\uB7C9\uC73C\uB85C \uC778\uD574 \uBAA8\uC7AC\uAC00 \uC644\uC804\uD788 \uB179\uC544\uB0B4\uB824 \uBC18\uB300\uD3B8\uC73C\uB85C \uAD6C\uBA4D\uC774 \uC0DD\uAE30\uB294 \uD604\uC0C1\uC744 \uC6A9\uB77D\uC774\uB77C\uACE0 \uD569\uB2C8\uB2E4."
  },
  {
    "id": "s1q11",
    "set": 1,
    "num": 11,
    "difficulty": "medium",
    "category": "\uC6A9\uC811 \uACB0\uD568",
    "question": "GTAW \uC6A9\uC811 \uC2DC '\uD145\uC2A4\uD150 \uD63C\uC785(Tungsten Inclusion)'\uC774 \uBC1C\uC0DD\uD558\uB294 \uC6D0\uC778\uC73C\uB85C \uAC00\uC7A5 \uAC70\uB9AC\uAC00 \uBA3C \uAC83\uC740?",
    "options": [
      "\uD145\uC2A4\uD150 \uC804\uADF9\uC774 \uC6A9\uC735\uC9C0(\uBAA8\uC7AC)\uC5D0 \uC9C1\uC811 \uB2FF\uC558\uC744 \uB54C",
      "\uC6A9\uC811 \uC804\uB958\uB97C \uC804\uADF9\uBD09 \uD5C8\uC6A9 \uC804\uB958\uBCF4\uB2E4 \uB108\uBB34 \uB192\uAC8C \uC124\uC815\uD588\uC744 \uB54C",
      "\uC804\uADF9\uBD09 \uC5F0\uB9C8 \uC2DC \uACB0\uC774 \uAE38\uC774 \uBC29\uD5A5\uC774 \uC544\uB2CC \uAC00\uB85C \uBC29\uD5A5\uC73C\uB85C \uB0AC\uC744 \uB54C",
      "\uBCF4\uD638\uAC00\uC2A4 \uC720\uB7C9\uC744 \uAD8C\uC7A5\uB7C9\uBCF4\uB2E4 2\uBC30 \uC774\uC0C1 \uACFC\uB3C4\uD558\uAC8C \uB192\uC600\uC744 \uB54C"
    ],
    "correctIndex": 3,
    "explanation": "\uBCF4\uD638\uAC00\uC2A4 \uC720\uB7C9\uC774 \uACFC\uB3C4\uD558\uBA74 \uB09C\uB958\uAC00 \uC0DD\uACA8 \uAE30\uACF5\uC774 \uC0DD\uAE38 \uC218\uB294 \uC788\uC73C\uB098, \uD145\uC2A4\uD150 \uD63C\uC785\uC740 \uC804\uADF9\uBD09\uC774 \uB179\uAC70\uB098 \uC9C1\uC811 \uB2FF\uC544 \uBD80\uB7EC\uC9C8 \uB54C \uBC1C\uC0DD\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s1q12",
    "set": 1,
    "num": 12,
    "difficulty": "easy",
    "category": "\uBE44\uD30C\uAD34 \uAC80\uC0AC",
    "question": "\uC6A9\uC811\uBD80\uC758 \uD45C\uBA74\uC5D0 \uC5F4\uB824\uC788\uB294 \uBBF8\uC138\uD55C \uADE0\uC5F4\uC774\uB098 \uACB0\uD568\uC744 \uCC3E\uAE30 \uC704\uD574 \uBD89\uC740\uC0C9 \uCE68\uD22C\uC561\uACFC \uD558\uC580\uC0C9 \uD604\uC0C1\uC561\uC744 \uC0AC\uC6A9\uD558\uB294 \uAC80\uC0AC\uBC95\uC740?",
    "options": [
      "\uBC29\uC0AC\uC120\uD22C\uACFC\uAC80\uC0AC (RT)",
      "\uCD08\uC74C\uD30C\uD0D0\uC0C1\uAC80\uC0AC (UT)",
      "\uC790\uBD84\uD0D0\uC0C1\uAC80\uC0AC (MT)",
      "\uCE68\uD22C\uD0D0\uC0C1\uAC80\uC0AC (PT)"
    ],
    "correctIndex": 3,
    "explanation": "\uBAA8\uC138\uAD00 \uD604\uC0C1\uC744 \uC774\uC6A9\uD574 \uD45C\uBA74 \uACB0\uD568\uC744 \uCC3E\uB294 \uBC29\uBC95\uC774 \uC561\uCCB4\uCE68\uD22C\uD0D0\uC0C1\uAC80\uC0AC(PT)\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s1q13",
    "set": 1,
    "num": 13,
    "difficulty": "medium",
    "category": "\uC7AC\uB8CC \uBC0F \uC131\uBD84",
    "question": "\uC2A4\uD14C\uC778\uB9AC\uC2A4\uAC15(STS) \uC6A9\uC811 \uC2DC \uB0B4\uBD80\uC2DD\uC131\uC744 \uC720\uC9C0\uD558\uAE30 \uC704\uD574 \uC6A9\uC811\uBD80 \uC774\uBA74(Back side)\uC5D0 \uAC00\uC2A4\uB97C \uCC44\uC6CC \uC0B0\uD654\uB97C \uBC29\uC9C0\uD558\uB294 \uC791\uC5C5\uC740?",
    "options": [
      "\uBC31 \uAC00\uC6B0\uC9D5 (Back gouging)",
      "\uBC31 \uD37C\uC9D5 (Back purging)",
      "\uC608\uC5F4 (Pre-heating)",
      "\uC20F \uD53C\uB2DD (Shot peening)"
    ],
    "correctIndex": 1,
    "explanation": "\uC2A4\uD14C\uC778\uB9AC\uC2A4\uAC15, \uD2F0\uD0C0\uB284 \uB4F1\uC744 \uBC30\uAD00 \uC6A9\uC811\uD560 \uB54C \uC0B0\uC18C\uC640 \uB2FF\uC544 \uC774\uBA74\uC774 \uC0B0\uD654\uB418\uB294 \uAC83\uC744 \uB9C9\uAE30 \uC704\uD574 \uD30C\uC774\uD504 \uB0B4\uBD80\uC5D0 \uBD88\uC131 \uAC00\uC2A4(\uC8FC\uB85C Ar)\uB97C \uCC44\uC6B0\uB294 \uAC83\uC744 \uD37C\uC9D5\uC774\uB77C\uACE0 \uD569\uB2C8\uB2E4."
  },
  {
    "id": "s1q14",
    "set": 1,
    "num": 14,
    "difficulty": "medium",
    "category": "\uC6A9\uC811 \uADF9\uC131",
    "question": "\uC54C\uB8E8\uBBF8\uB284\uC774\uB098 \uB9C8\uADF8\uB124\uC298 \uC6A9\uC811 \uC2DC \uD45C\uBA74\uC758 \uC0B0\uD654\uB9C9\uC744 \uAE68\uB294 '\uCCAD\uC815 \uC791\uC6A9(Cleaning action)'\uC744 \uC5BB\uAE30 \uC704\uD574 \uAC00\uC7A5 \uC801\uD569\uD55C \uC6A9\uC811 \uADF9\uC131\uC740?",
    "options": [
      "\uC9C1\uB958 \uC815\uADF9\uC131 (DCEN)",
      "\uC9C1\uB958 \uC5ED\uADF9\uC131 (DCEP)",
      "\uACE0\uC8FC\uD30C \uAD50\uB958 (AC)",
      "\uD384\uC2A4 \uC9C1\uB958"
    ],
    "correctIndex": 2,
    "explanation": "\uAD50\uB958(AC)\uB294 +\uC640 -\uAC00 \uAD50\uCC28\uD558\uBBC0\uB85C, \uC5ED\uADF9\uC131 \uAD6C\uAC04\uC5D0\uC11C \uC0B0\uD654\uB9C9\uC744 \uD30C\uAD34(\uCCAD\uC815 \uC791\uC6A9)\uD558\uACE0 \uC815\uADF9\uC131 \uAD6C\uAC04\uC5D0\uC11C \uBAA8\uC7AC \uC6A9\uC785\uACFC \uC804\uADF9 \uB0C9\uAC01\uC744 \uB3D9\uC2DC\uC5D0 \uC218\uD589\uD558\uBBC0\uB85C \uC54C\uB8E8\uBBF8\uB284 \uC6A9\uC811\uC5D0 \uD544\uC218\uC801\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s1q15",
    "set": 1,
    "num": 15,
    "difficulty": "hard",
    "category": "\uC804\uC6D0 \uD2B9\uC131",
    "question": "\uC218\uB3D9 GTAW \uBC0F SMAW \uC6A9\uC811\uAE30\uC5D0\uC11C \uC544\uD06C \uAE38\uC774\uAC00 \uBCC0\uD558\uC5EC \uC804\uC555\uC774 \uBCC0\uB3D9\uB418\uB354\uB77C\uB3C4 \uC6A9\uC811 \uC804\uB958\uB294 \uAC70\uC758 \uC77C\uC815\uD558\uAC8C \uC720\uC9C0\uB418\uB3C4\uB85D \uC124\uACC4\uB41C \uC804\uC6D0 \uD2B9\uC131\uC740?",
    "options": [
      "\uC218\uD558 \uD2B9\uC131 (\uC815\uC804\uB958 \uD2B9\uC131)",
      "\uC815\uC804\uC555 \uD2B9\uC131",
      "\uC0C1\uC2B9 \uD2B9\uC131",
      "\uBCF5\uD569 \uD2B9\uC131"
    ],
    "correctIndex": 0,
    "explanation": "\uC218\uB3D9 \uC6A9\uC811\uC740 \uC791\uC5C5\uC790 \uC190\uB5A8\uB9BC\uC73C\uB85C \uC544\uD06C \uAE38\uC774\uAC00 \uBCC0\uD558\uAE30 \uC26C\uC6B0\uBBC0\uB85C, \uC804\uC555\uC774 \uBCC0\uD574\uB3C4 \uC804\uB958 \uBCC0\uD654\uAC00 \uC801\uC740 \uC815\uC804\uB958(\uC218\uD558) \uD2B9\uC131\uC758 \uC804\uC6D0\uC744 \uC0AC\uC6A9\uD558\uC5EC \uC6A9\uC785\uC744 \uC77C\uC815\uD558\uAC8C \uC720\uC9C0\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s1q16",
    "set": 1,
    "num": 16,
    "difficulty": "medium",
    "category": "\uC785\uC5F4\uB7C9\uACFC \uBCC0\uD615",
    "question": "\uC6A9\uC811 \uC785\uC5F4\uB7C9(Heat Input)\uC744 \uAD6C\uD558\uB294 \uACF5\uC2DD H = 60EI/V \uC5D0\uC11C V\uAC00 \uC758\uBBF8\uD558\uB294 \uAC83\uC740?",
    "options": [
      "\uC6A9\uC811 \uC804\uC555 (Voltage)",
      "\uC6A9\uC811 \uC18D\uB3C4 (Velocity)",
      "\uBD80\uD53C (Volume)",
      "\uC6A9\uC811 \uC804\uB958 (Current)"
    ],
    "correctIndex": 1,
    "explanation": "\uC785\uC5F4\uB7C9 \uACF5\uC2DD\uC5D0\uC11C E\uB294 \uC804\uC555, I\uB294 \uC804\uB958, V\uB294 \uC6A9\uC811 \uC6B4\uBD09 \uC18D\uB3C4(cm/min)\uC785\uB2C8\uB2E4. \uC989 \uC18D\uB3C4\uAC00 \uBE60\uB97C\uC218\uB85D \uC785\uC5F4\uB7C9\uC740 \uC791\uC544\uC9D1\uB2C8\uB2E4."
  },
  {
    "id": "s2q1",
    "set": 2,
    "num": 1,
    "difficulty": "easy",
    "category": "\uC6A9\uC811\uACFC \uAD00\uB828\uB41C \uC548\uC804",
    "question": "\uC6A9\uC811 \uC791\uC5C5 \uC911 \uD654\uC7AC \uD3ED\uBC1C\uC744 \uC608\uBC29\uD558\uAE30 \uC704\uD574 \uC6A9\uC811 \uC791\uC5C5\uC7A5 \uC8FC\uBCC0\uC758 \uAC00\uC5F0\uC131 \uBB3C\uC9C8\uC740 \uCD5C\uC18C \uBA87 \uBBF8\uD130(m) \uC774\uC0C1 \uC774\uACA9\uC2DC\uCF1C\uC57C \uD558\uB294\uAC00?",
    "options": [
      "2m",
      "5m",
      "11m",
      "20m"
    ],
    "correctIndex": 2,
    "explanation": "\uC0B0\uC5C5\uC548\uC804\uBCF4\uAC74\uAE30\uC900\uC5D0 \uB530\uB77C \uBD88\uAF43\uC774 \uD280\uB294 \uBE44\uC0B0\uAC70\uB9AC\uC778 \uCD5C\uC18C 11m \uC774\uB0B4\uC5D0\uB294 \uAC00\uC5F0\uC131 \uBB3C\uC9C8\uC744 \uB450\uC9C0 \uC54A\uAC70\uB098 \uBC29\uC5FC\uD3EC\uB85C \uB36E\uC5B4\uC57C \uD569\uB2C8\uB2E4."
  },
  {
    "id": "s2q2",
    "set": 2,
    "num": 2,
    "difficulty": "medium",
    "category": "\uC6A9\uC811\uACFC \uAD00\uB828\uB41C \uC548\uC804",
    "question": "\uBC00\uD3D0\uB41C \uD0F1\uD06C \uB0B4\uBD80\uC5D0\uC11C GTAW \uC6A9\uC811 \uC2DC \uAC00\uC7A5 \uC62C\uBC14\uB978 \uC548\uC804 \uC870\uCE58\uB294?",
    "options": [
      "\uC544\uB974\uACE4 \uAC00\uC2A4\uB97C \uBBF8\uB9AC \uAC00\uB4DD \uCC44\uC6CC \uD654\uC7AC\uB97C \uC608\uBC29\uD55C\uB2E4.",
      "\uC0B0\uC18C \uACB0\uD54D\uC744 \uB9C9\uAE30 \uC704\uD574 \uC21C\uC218 \uC0B0\uC18C\uB97C \uACF5\uAE09\uD55C\uB2E4.",
      "\uC9C0\uC18D\uC801\uC73C\uB85C \uD658\uAE30 \uC7A5\uCE58\uB97C \uAC00\uB3D9\uD558\uACE0 \uC791\uC5C5 \uC804\uD6C4\uB85C \uC0B0\uC18C \uB18D\uB3C4\uB97C \uCE21\uC815\uD55C\uB2E4.",
      "\uBC29\uC9C4\uB9C8\uC2A4\uD06C\uB9CC \uCC29\uC6A9\uD558\uACE0 \uC791\uC5C5\uC744 \uC9C4\uD589\uD55C\uB2E4."
    ],
    "correctIndex": 2,
    "explanation": "\uBC00\uD3D0\uACF5\uAC04\uC5D0\uC11C\uB294 \uBCF4\uD638\uAC00\uC2A4(Ar)\uC5D0 \uC758\uD55C \uC9C8\uC2DD \uC704\uD5D8\uC774 \uD06C\uBBC0\uB85C \uD658\uAE30 \uBC0F \uC0B0\uC18C \uB18D\uB3C4 \uCE21\uC815\uC774 \uD544\uC218\uC774\uBA70, \uC21C\uC218 \uC0B0\uC18C\uB97C \uACF5\uAE09\uD558\uBA74 \uD3ED\uBC1C \uC704\uD5D8\uC774 \uCEE4\uC838 \uC808\uB300 \uAE08\uBB3C\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s2q3",
    "set": 2,
    "num": 3,
    "difficulty": "easy",
    "category": "\uC7A5\uBE44 \uBC0F \uB3C4\uAD6C, \uBA85\uCE6D\uACFC \uAE30\uB2A5",
    "question": "\uACE0\uC804\uB958\uB97C \uC0AC\uC6A9\uD558\uB294 GTAW \uC6A9\uC811\uC5D0\uC11C \uD1A0\uCE58\uC758 \uACFC\uC5F4\uC744 \uBC29\uC9C0\uD558\uAE30 \uC704\uD574 \uC8FC\uB85C \uC0AC\uC6A9\uD558\uB294 \uB0C9\uAC01 \uBC29\uC2DD\uC740?",
    "options": [
      "\uC790\uC5F0 \uACF5\uB7AD\uC2DD",
      "\uAC15\uC81C \uACF5\uB7AD\uC2DD",
      "\uC218\uB0C9\uC2DD(Water-cooled)",
      "\uC720\uB0C9\uC2DD(Oil-cooled)"
    ],
    "correctIndex": 2,
    "explanation": "\uC77C\uBC18\uC801\uC73C\uB85C 200A \uC774\uC0C1\uC758 \uB192\uC740 \uC804\uB958\uB97C \uC5F0\uC18D\uC73C\uB85C \uC0AC\uC6A9\uD560 \uB54C\uB294 \uB0C9\uAC01\uC218\uB97C \uC21C\uD658\uC2DC\uCF1C \uD1A0\uCE58\uB97C \uC2DD\uD788\uB294 \uC218\uB0C9\uC2DD \uD1A0\uCE58\uB97C \uC0AC\uC6A9\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s2q4",
    "set": 2,
    "num": 4,
    "difficulty": "hard",
    "category": "\uC7A5\uBE44 \uBC0F \uB3C4\uAD6C, \uBA85\uCE6D\uACFC \uAE30\uB2A5",
    "question": "\uD384\uC2A4(Pulse) TIG \uC6A9\uC811\uAE30 \uD328\uB110\uC5D0\uC11C '\uBCA0\uC774\uC2A4 \uC804\uB958(Base Current)'\uAC00 \uD558\uB294 \uC8FC\uB41C \uC5ED\uD560\uC740 \uBB34\uC5C7\uC778\uAC00?",
    "options": [
      "\uBAA8\uC7AC\uB97C \uAE4A\uAC8C \uC6A9\uC735\uC2DC\uD0A4\uB294 \uC5ED\uD560",
      "\uC544\uD06C\uB97C \uC548\uC815\uC801\uC73C\uB85C \uC720\uC9C0\uD558\uBA70 \uC6A9\uC735\uC9C0\uB97C \uB0C9\uAC01\uC2DC\uD0A4\uB294 \uC5ED\uD560",
      "\uC544\uD06C\uB97C \uCD5C\uCD08\uB85C \uBC1C\uC0DD\uC2DC\uD0AC \uB54C \uC804\uC555\uC744 \uB192\uC5EC\uC8FC\uB294 \uC5ED\uD560",
      "\uAD50\uB958 \uC6A9\uC811 \uC2DC \uCCAD\uC815 \uC791\uC6A9\uC744 \uC77C\uC73C\uD0A4\uB294 \uC5ED\uD560"
    ],
    "correctIndex": 1,
    "explanation": "\uD384\uC2A4 TIG\uB294 \uB192\uC740 '\uD53C\uD06C \uC804\uB958(\uC6A9\uC735)'\uC640 \uB0AE\uC740 '\uBCA0\uC774\uC2A4 \uC804\uB958(\uB0C9\uAC01 \uBC0F \uC544\uD06C \uC720\uC9C0)'\uB97C \uAD50\uCC28\uC2DC\uCF1C \uC785\uC5F4\uB7C9\uC744 \uC904\uC774\uACE0 \uBE44\uB4DC\uB97C \uC608\uC058\uAC8C \uC81C\uC5B4\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s2q5",
    "set": 2,
    "num": 5,
    "difficulty": "easy",
    "category": "\uC6A9\uC811\uC758 \uC885\uB958",
    "question": "\uB2E4\uC74C \uC911 \uC5F4\uC6D0\uACFC \uAE30\uACC4\uC801 \uC555\uB825\uC744 \uB3D9\uC2DC\uC5D0 \uAC00\uD558\uC5EC \uBAA8\uC7AC\uB97C \uB179\uC774\uC9C0 \uC54A\uACE0 \uC811\uD569\uD558\uB294 \uACE0\uC0C1\uC6A9\uC811(Solid-state welding)\uC5D0 \uC18D\uD558\uB294 \uAC83\uC740?",
    "options": [
      "\uC11C\uBE0C\uBA38\uC9C0\uB4DC \uC544\uD06C \uC6A9\uC811",
      "\uD53C\uBCF5 \uC544\uD06C \uC6A9\uC811",
      "\uB9C8\uCC30 \uC6A9\uC811",
      "\uAC00\uC2A4 \uD145\uC2A4\uD150 \uC544\uD06C \uC6A9\uC811"
    ],
    "correctIndex": 2,
    "explanation": "\uB9C8\uCC30 \uC6A9\uC811\uC740 \uAE30\uACC4\uC801 \uB9C8\uCC30\uC5F4\uACFC \uC555\uB825\uC744 \uC774\uC6A9\uD55C \uACE0\uC0C1\uC6A9\uC811\uC774\uBA70, \uB098\uBA38\uC9C0\uB294 \uBAA8\uB450 \uBAA8\uC7AC\uB97C \uB179\uC774\uB294 \uC6A9\uC735\uC6A9\uC811\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s2q6",
    "set": 2,
    "num": 6,
    "difficulty": "medium",
    "category": "\uC6A9\uC811\uC758 \uC885\uB958",
    "question": "\uC194\uB354\uB9C1(\uC5F0\uB0A9\uB55C)\uACFC \uBE0C\uB808\uC774\uC9D5(\uACBD\uB0A9\uB55C)\uC744 \uAD6C\uBD84\uD558\uB294 \uAE30\uC900 \uC628\uB3C4\uB294 \uB300\uB7B5 \uBA87 \uB3C4(\u2103)\uC778\uAC00?",
    "options": [
      "250\u2103",
      "450\u2103",
      "750\u2103",
      "1000\u2103"
    ],
    "correctIndex": 1,
    "explanation": "\uC6A9\uAC00\uC7AC\uC758 \uC6A9\uC735\uC810\uC774 450\u2103 \uC774\uD558\uC774\uBA74 \uC5F0\uB0A9\uB55C(Soldering), 450\u2103 \uC774\uC0C1\uC774\uBA74 \uACBD\uB0A9\uB55C(Brazing)\uC73C\uB85C \uBD84\uB958\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s2q7",
    "set": 2,
    "num": 7,
    "difficulty": "easy",
    "category": "\uC544\uD06C\uC758 \uC774\uD574",
    "question": "\uC6A9\uC811 \uC804\uB958\uAC00 \uC99D\uAC00\uD560 \uB54C \uB098\uD0C0\uB098\uB294 \uD604\uC0C1\uC73C\uB85C \uC62C\uBC14\uB978 \uAC83\uC740?",
    "options": [
      "\uC6A9\uC785 \uAE4A\uC774\uAC00 \uC595\uC544\uC9C4\uB2E4.",
      "\uC6A9\uC811 \uBE44\uB4DC\uC758 \uD3ED\uC774 \uC881\uC544\uC9C4\uB2E4.",
      "\uC544\uD06C \uC5F4\uC774 \uAC15\uD574\uC838 \uBAA8\uC7AC\uC758 \uC6A9\uC785 \uAE4A\uC774\uAC00 \uAE4A\uC5B4\uC9C4\uB2E4.",
      "\uC804\uADF9\uBD09\uC758 \uC18C\uBAA8\uAC00 \uC904\uC5B4\uB4E0\uB2E4."
    ],
    "correctIndex": 2,
    "explanation": "\uC6A9\uC811 \uC804\uB958\uAC00 \uB192\uC544\uC9C8\uC218\uB85D \uC5F4\uC5D0\uB108\uC9C0\uAC00 \uC99D\uAC00\uD558\uC5EC \uC6A9\uC811\uBD80\uC758 \uC6A9\uC735\uB7C9\uC774 \uB9CE\uC544\uC9C0\uACE0 \uC6A9\uC785\uC774 \uAE4A\uC5B4\uC9D1\uB2C8\uB2E4."
  },
  {
    "id": "s2q8",
    "set": 2,
    "num": 8,
    "difficulty": "hard",
    "category": "\uC544\uD06C\uC758 \uC774\uD574",
    "question": "GTAW \uC6A9\uC811 \uC2DC \uBCF4\uD638\uAC00\uC2A4(Ar) \uC720\uB7C9\uC744 \uD544\uC694 \uC774\uC0C1\uC73C\uB85C \uACFC\uB3C4\uD558\uAC8C \uB192\uAC8C \uC124\uC815\uD588\uC744 \uB54C \uB098\uD0C0\uB0A0 \uC218 \uC788\uB294 \uD604\uC0C1\uC740?",
    "options": [
      "\uD145\uC2A4\uD150 \uC804\uADF9\uBD09\uC774 \uC6A9\uC735\uB41C\uB2E4.",
      "\uB300\uAE30 \uC911\uC758 \uC0B0\uC18C\uAC00 \uC644\uBCBD\uD788 \uCC28\uB2E8\uB418\uC5B4 \uC6A9\uC811 \uD488\uC9C8\uC774 \uBB34\uC870\uAC74 \uD5A5\uC0C1\uB41C\uB2E4.",
      "\uAC00\uC2A4 \uB178\uC990 \uB05D\uC5D0 \uB09C\uB958(Turbulence)\uAC00 \uBC1C\uC0DD\uD558\uC5EC \uC678\uBD80 \uACF5\uAE30\uAC00 \uB9D0\uB824\uB4E4\uC5B4 \uAE30\uACF5\uC774 \uC0DD\uAE34\uB2E4.",
      "\uC544\uD06C \uAE38\uC774\uAC00 \uC790\uB3D9\uC73C\uB85C \uC9E7\uC544\uC9C4\uB2E4."
    ],
    "correctIndex": 2,
    "explanation": "\uAC00\uC2A4\uAC00 \uB108\uBB34 \uC138\uAC8C \uBD84\uC0AC\uB418\uBA74 \uCE35\uB958\uAC00 \uAE68\uC9C0\uACE0 \uC18C\uC6A9\uB3CC\uC774(\uB09C\uB958)\uAC00 \uBC1C\uC0DD\uD574 \uC624\uD788\uB824 \uC8FC\uBCC0 \uACF5\uAE30\uB97C \uC6A9\uC735\uC9C0 \uC18D\uC73C\uB85C \uB04C\uC5B4\uB4E4\uC5EC \uBE14\uB85C\uC6B0\uD640 \uB4F1 \uACB0\uD568\uC774 \uC0DD\uAE41\uB2C8\uB2E4."
  },
  {
    "id": "s2q9",
    "set": 2,
    "num": 9,
    "difficulty": "easy",
    "category": "\uC6A9\uC811 \uACB0\uD568",
    "question": "\uC6A9\uC811 \uBE44\uB4DC\uC758 \uD45C\uBA74\uC774 \uBAA8\uC7AC\uC758 \uD45C\uBA74\uBCF4\uB2E4 \uB0AE\uAC8C \uCC44\uC6CC\uC9C4 \uACB0\uD568\uC73C\uB85C, \uC6A9\uAC00\uC7AC(\uC6A9\uC811\uBD09)\uC758 \uACF5\uAE09\uC774 \uBD80\uC871\uD560 \uB54C \uC8FC\uB85C \uBC1C\uC0DD\uD558\uB294 \uAC83\uC740?",
    "options": [
      "\uC624\uBC84\uB7A9 (Overlap)",
      "\uC5B8\uB354\uCEF7 (Undercut)",
      "\uC5B8\uB354\uD544 (Underfill)",
      "\uAE30\uACF5 (Porosity)"
    ],
    "correctIndex": 2,
    "explanation": "\uC5B8\uB354\uD544\uC740 \uAC1C\uC120\uD648(\uADF8\uB8E8\uBE0C)\uC744 \uCDA9\uBD84\uD788 \uCC44\uC6B0\uC9C0 \uBABB\uD574 \uBE44\uB4DC\uAC00 \uBAA8\uC7AC \uD45C\uBA74\uBCF4\uB2E4 \uB0AE\uAC8C \uD615\uC131\uB41C \uC0C1\uD0DC\uB97C \uB9D0\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s2q10",
    "set": 2,
    "num": 10,
    "difficulty": "easy",
    "category": "\uC6A9\uC811 \uACB0\uD568",
    "question": "\uC6A9\uC811 \uC911 \uB179\uC740 \uAE08\uC18D\uC774 \uBAA8\uC7AC\uC640 \uC735\uD569\uB418\uC9C0 \uC54A\uACE0 \uBAA8\uC7AC \uD45C\uBA74 \uC704\uB85C \uACB9\uCCD0\uC11C \uD758\uB7EC\uB0B4\uB9B0 \uACB0\uD568\uC740?",
    "options": [
      "\uC5B8\uB354\uCEF7 (Undercut)",
      "\uC624\uBC84\uB7A9 (Overlap)",
      "\uC6A9\uB77D (Burn-through)",
      "\uC2AC\uB798\uADF8 \uC11E\uC784 (Slag inclusion)"
    ],
    "correctIndex": 1,
    "explanation": "\uC624\uBC84\uB7A9\uC740 \uC804\uB958\uAC00 \uB108\uBB34 \uB0AE\uAC70\uB098 \uC6A9\uC811 \uC18D\uB3C4\uAC00 \uB290\uB824 \uC1F3\uBB3C\uB9CC \uBAA8\uC7AC \uC704\uC5D0 \uC5B9\uD600\uC9C4(\uACB9\uCE5C) \uC0C1\uD0DC\uC758 \uACB0\uD568\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s2q11",
    "set": 2,
    "num": 11,
    "difficulty": "medium",
    "category": "\uC6A9\uC811 \uACB0\uD568",
    "question": "\uC6A9\uC811\uBD80\uC5D0 \uBC1C\uC0DD\uD558\uB294 \uAE30\uACF5(Porosity, \uD540\uD640/\uBE14\uB85C\uC6B0\uD640)\uC758 \uC8FC\uB41C \uC6D0\uC778\uC73C\uB85C \uBCFC \uC218 \uC5C6\uB294 \uAC83\uC740?",
    "options": [
      "\uBAA8\uC7AC \uD45C\uBA74\uC5D0 \uAE30\uB984, \uB179, \uD398\uC778\uD2B8 \uB4F1\uC758 \uC624\uC5FC\uBB3C\uC774 \uC788\uC744 \uB54C",
      "\uBC14\uB78C\uC774 \uBD88\uC5B4 \uC274\uB4DC \uAC00\uC2A4\uAC00 \uD769\uC5B4\uC9C8 \uB54C",
      "\uC6A9\uC811\uBD09\uC744 \uB108\uBB34 \uC790\uC8FC \uC6A9\uC735\uC9C0\uC5D0\uC11C \uB5BC\uC5B4\uB0B4\uBA70 \uACF5\uAE09\uD560 \uB54C",
      "\uD1A0\uCE58 \uC774\uB3D9 \uC18D\uB3C4(\uC6B4\uBD09)\uB97C \uB9E4\uC6B0 \uB290\uB9AC\uAC8C \uD560 \uB54C"
    ],
    "correctIndex": 3,
    "explanation": "\uC6B4\uBD09\uC774 \uB290\uB9AC\uBA74 \uC785\uC5F4\uB7C9\uC774 \uCEE4\uC838 \uB2E4\uB978 \uACB0\uD568(\uC6A9\uB77D \uB4F1)\uC774 \uC0DD\uAE38 \uC218\uB294 \uC788\uC73C\uB098, \uAE30\uACF5\uC740 \uC8FC\uB85C \uAC00\uC2A4 \uBCF4\uD638\uB9C9\uC774 \uD30C\uAD34\uB418\uAC70\uB098 \uBD88\uC21C\uBB3C\uC774 \uD0C0\uC11C \uAC00\uC2A4\uAC00 \uBC1C\uC0DD\uD560 \uB54C \uC0DD\uAE41\uB2C8\uB2E4."
  },
  {
    "id": "s2q12",
    "set": 2,
    "num": 12,
    "difficulty": "hard",
    "category": "\uC6A9\uC811 \uACB0\uD568",
    "question": "\uC6A9\uC811 \uAE08\uC18D\uC774 \uC751\uACE0\uD558\uB294 \uACFC\uC815\uC5D0\uC11C \uC8FC\uB85C \uBC1C\uC0DD\uD558\uBA70, \uC720\uD669(S)\uC774\uB098 \uC778(P) \uAC19\uC740 \uBD88\uC21C\uBB3C\uC774 \uC6D0\uC778\uC774 \uB418\uC5B4 \uC6A9\uC811\uBD80 \uC911\uC559\uC5D0 \uAE38\uAC8C \uC0DD\uAE30\uB294 \uADE0\uC5F4(Crack)\uC740?",
    "options": [
      "\uC800\uC628 \uADE0\uC5F4 (Cold crack)",
      "\uACE0\uC628 \uADE0\uC5F4 (Hot crack)",
      "\uB8E8\uD2B8 \uADE0\uC5F4 (Root crack)",
      "\uD1A0\uC6B0 \uADE0\uC5F4 (Toe crack)"
    ],
    "correctIndex": 1,
    "explanation": "\uACE0\uC628 \uADE0\uC5F4\uC740 \uC1F3\uBB3C\uC774 \uAD73\uB294 \uACE0\uC628 \uC0C1\uD0DC\uC5D0\uC11C \uBD88\uC21C\uBB3C\uC758 \uD3B8\uC11D \uB4F1\uC5D0 \uC758\uD574 \uBC1C\uC0DD\uD558\uBA70, \uC800\uC628 \uADE0\uC5F4\uC740 \uC218\uC18C(H)\uC640 \uC8FC\uB85C \uAD00\uB828\uC774 \uC788\uC2B5\uB2C8\uB2E4."
  },
  {
    "id": "s2q13",
    "set": 2,
    "num": 13,
    "difficulty": "easy",
    "category": "\uBE44\uD30C\uAD34 \uAC80\uC0AC",
    "question": "\uC6A9\uC811\uBD80 \uB0B4\uBD80\uC758 \uAE30\uACF5\uC774\uB098 \uAC1C\uC7AC\uBB3C \uB4F1\uC744 \uD655\uC778\uD558\uAE30 \uC704\uD574 X\uC120\uC774\uB098 \u03B3(\uAC10\uB9C8)\uC120\uC744 \uC870\uC0AC\uD558\uC5EC \uD544\uB984\uC758 \uB18D\uB3C4\uCC28\uB85C \uACB0\uD568\uC744 \uCC3E\uB294 \uAC80\uC0AC\uBC95\uC740?",
    "options": [
      "\uCD08\uC74C\uD30C\uD0D0\uC0C1\uAC80\uC0AC(UT)",
      "\uC790\uAE30\uD0D0\uC0C1\uAC80\uC0AC(MT)",
      "\uBC29\uC0AC\uC120\uD22C\uACFC\uAC80\uC0AC(RT)",
      "\uC721\uC548\uAC80\uC0AC(VT)"
    ],
    "correctIndex": 2,
    "explanation": "\uBC29\uC0AC\uC120\uD22C\uACFC\uAC80\uC0AC(RT)\uB294 \uC5D1\uC2A4\uB808\uC774 \uC0AC\uC9C4\uC744 \uCC0D\uB4EF \uBC29\uC0AC\uC120\uC744 \uD22C\uACFC\uC2DC\uCF1C \uB0B4\uBD80 \uACB0\uD568\uC744 \uC2DC\uAC01\uC801\uC73C\uB85C \uBCF4\uC5EC\uC90D\uB2C8\uB2E4."
  },
  {
    "id": "s2q14",
    "set": 2,
    "num": 14,
    "difficulty": "medium",
    "category": "\uBE44\uD30C\uAD34 \uAC80\uC0AC",
    "question": "\uCD08\uC74C\uD30C\uD0D0\uC0C1\uAC80\uC0AC(UT)\uC758 \uD2B9\uC9D5\uC5D0 \uB300\uD55C \uC124\uBA85\uC73C\uB85C \uAC00\uC7A5 \uAC70\uB9AC\uAC00 \uBA3C \uAC83\uC740?",
    "options": [
      "\uC0AC\uB78C\uC758 \uADC0\uC5D0 \uB4E4\uB9AC\uC9C0 \uC54A\uB294 \uB192\uC740 \uC8FC\uD30C\uC218\uC758 \uC74C\uD30C\uB97C \uC0AC\uC6A9\uD55C\uB2E4.",
      "\uB0B4\uBD80 \uACB0\uD568\uC758 \uAE4A\uC774\uC640 \uC704\uCE58\uB97C \uC815\uD655\uD558\uAC8C \uC54C \uC218 \uC788\uB2E4.",
      "\uB0B4\uBD80 \uACB0\uD568\uC758 \uB450\uAED8\uC640 \uD615\uC0C1\uC744 RT\uBCF4\uB2E4 \uB354 \uC9C1\uAD00\uC801\uC778 \uC0AC\uC9C4\uC73C\uB85C \uB0A8\uAE38 \uC218 \uC788\uB2E4.",
      "\uD45C\uBA74\uC774 \uB9E4\uB044\uB7EC\uC6CC\uC57C \uD558\uBA70 \uC811\uCD09\uB9E4\uC9C8(\uAE00\uB9AC\uC138\uB9B0 \uB4F1)\uC774 \uD544\uC694\uD558\uB2E4."
    ],
    "correctIndex": 2,
    "explanation": "UT\uB294 \uACB0\uD568\uC758 \uAE4A\uC774\uB294 \uC798 \uC54C \uC218 \uC788\uC73C\uB098, \uD30C\uD615(\uADF8\uB798\uD504)\uC73C\uB85C \uACB0\uACFC\uB97C \uD655\uC778\uD558\uBBC0\uB85C RT\uCC98\uB7FC \uC9C1\uAD00\uC801\uC778 \uC0AC\uC9C4 \uD544\uB984\uC744 \uB0A8\uAE30\uAE30 \uC5B4\uB835\uC2B5\uB2C8\uB2E4."
  },
  {
    "id": "s2q15",
    "set": 2,
    "num": 15,
    "difficulty": "easy",
    "category": "\uC7AC\uB8CC \uBC0F \uC131\uBD84",
    "question": "\uC54C\uB8E8\uBBF8\uB284\uC774\uB098 \uADF8 \uD569\uAE08\uC744 GTAW\uB85C \uC6A9\uC811\uD560 \uB54C \uAC00\uC7A5 \uBC29\uD574\uAC00 \uB418\uB294 \uC7AC\uB8CC\uC801 \uD2B9\uC131\uC740?",
    "options": [
      "\uC735\uC810\uC774 \uCCA0\uBCF4\uB2E4 \uB192\uB2E4.",
      "\uD45C\uBA74\uC5D0 \uC735\uC810\uC774 \uB9E4\uC6B0 \uB192\uC740 \uC0B0\uD654\uC54C\uB8E8\uBBF8\uB284 \uD53C\uB9C9\uC774 \uD615\uC131\uB418\uC5B4 \uC788\uB2E4.",
      "\uC790\uC131\uC744 \uB760\uC5B4 \uC544\uD06C \uC3E0\uB9BC\uC774 \uC2EC\uD558\uB2E4.",
      "\uC5F4\uC804\uB3C4\uC728\uC774 \uB9E4\uC6B0 \uB0AE\uB2E4."
    ],
    "correctIndex": 1,
    "explanation": "\uC54C\uB8E8\uBBF8\uB284 \uC790\uCCB4\uB294 \uC735\uC810\uC774 \uB0AE\uC9C0\uB9CC(\uC57D 660\uB3C4), \uD45C\uBA74\uC758 \uC0B0\uD654\uB9C9 \uC735\uC810\uC740 \uC57D 2050\uB3C4\uB85C \uB9E4\uC6B0 \uB192\uC544 \uAD50\uB958(AC) \uC6A9\uC811\uC744 \uD1B5\uD55C \uCCAD\uC815\uC791\uC6A9\uC73C\uB85C \uC0B0\uD654\uB9C9\uC744 \uD30C\uAD34\uD574\uC57C \uD569\uB2C8\uB2E4."
  },
  {
    "id": "s2q16",
    "set": 2,
    "num": 16,
    "difficulty": "medium",
    "category": "\uC7AC\uB8CC \uBC0F \uC131\uBD84",
    "question": "\uC624\uC2A4\uD14C\uB098\uC774\uD2B8\uACC4 \uC2A4\uD14C\uC778\uB9AC\uC2A4\uAC15 \uC6A9\uC811 \uC2DC, \uC6A9\uC811 \uD6C4 \uB0C9\uAC01 \uC18D\uB3C4\uB97C \uCD5C\uB300\uD55C \uC5B4\uB5BB\uAC8C \uD574\uC57C \uD558\uB294\uAC00?",
    "options": [
      "\uCC9C\uCC9C\uD788 \uB0C9\uAC01\uC2DC\uCF1C\uC57C \uD55C\uB2E4(\uC11C\uB7AD).",
      "400\uB3C4\uC5D0\uC11C \uBCF4\uC628\uD574\uC57C \uD55C\uB2E4.",
      "\uBE60\uB974\uAC8C \uB0C9\uAC01\uC2DC\uCF1C\uC57C \uD55C\uB2E4(\uAE09\uB7AD).",
      "\uC608\uC5F4\uC744 300\uB3C4 \uC774\uC0C1 \uC62C\uB824\uC57C \uD55C\uB2E4."
    ],
    "correctIndex": 2,
    "explanation": "\uC624\uC2A4\uD14C\uB098\uC774\uD2B8\uACC4 \uC2A4\uD14C\uC778\uB9AC\uC2A4\uAC15\uC740 500~800\uB3C4 \uAD6C\uAC04\uC5D0\uC11C \uD0C4\uD654\uBB3C\uC774 \uC11D\uCD9C\uB418\uC5B4 \uB0B4\uC2DD\uC131\uC774 \uB5A8\uC5B4\uC9C0\uBBC0\uB85C(\uC608\uBBFC\uD654 \uD604\uC0C1), \uC774 \uC628\uB3C4 \uAD6C\uAC04\uC744 \uBE68\uB9AC \uC9C0\uB098\uB3C4\uB85D \uAE09\uB7AD\uD574\uC57C \uD569\uB2C8\uB2E4."
  },
  {
    "id": "s2q17",
    "set": 2,
    "num": 17,
    "difficulty": "easy",
    "category": "\uC6A9\uC811 \uADF9\uC131",
    "question": "\uC9C1\uB958 \uC5ED\uADF9\uC131(DCEP)\uC744 \uC0AC\uC6A9\uD558\uC5EC GTAW \uC6A9\uC811\uC744 \uD560 \uB54C \uD145\uC2A4\uD150 \uC804\uADF9\uBD09\uC5D0 \uB098\uD0C0\uB098\uB294 \uD604\uC0C1\uC740?",
    "options": [
      "\uC804\uADF9\uC774 \uAC70\uC758 \uC18C\uBAA8\uB418\uC9C0 \uC54A\uB294\uB2E4.",
      "\uC804\uC790\uAC00 \uBAA8\uC7AC\uB85C \uCDA9\uB3CC\uD558\uBBC0\uB85C \uBAA8\uC7AC\uAC00 \uAE4A\uAC8C \uD30C\uC778\uB2E4.",
      "\uBAA8\uC7AC\uC5D0\uC11C \uC804\uADF9 \uCABD\uC73C\uB85C \uC804\uC790\uAC00 \uC774\uB3D9\uD558\uC5EC \uC804\uADF9\uC774 \uC27D\uAC8C \uACFC\uC5F4\uB418\uACE0 \uC18C\uBAA8\uB41C\uB2E4.",
      "\uC544\uD06C\uAC00 \uC804\uD600 \uBC1C\uC0DD\uD558\uC9C0 \uC54A\uB294\uB2E4."
    ],
    "correctIndex": 2,
    "explanation": "\uC5ED\uADF9\uC131(DCEP)\uC740 \uC804\uADF9\uBD09\uC774 (+)\uC774\uBBC0\uB85C, \uC804\uCCB4 \uC5F4\uC758 70%\uAC00 \uC804\uADF9\uBD09\uC5D0 \uC9D1\uC911\uB418\uC5B4 \uC804\uADF9\uC774 \uC27D\uAC8C \uB179\uC544\uB0B4\uB9AC\uBBC0\uB85C \uC77C\uBC18\uC801\uC778 GTAW\uC5D0\uC11C\uB294 \uC798 \uC4F0\uC774\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4."
  },
  {
    "id": "s2q18",
    "set": 2,
    "num": 18,
    "difficulty": "medium",
    "category": "\uC804\uC6D0 \uD2B9\uC131",
    "question": "\uC6A9\uC811 \uC911 \uC544\uD06C \uAE38\uC774\uAC00 \uC57D\uAC04 \uBCC0\uD574\uB3C4 \uC6A9\uC811 \uC804\uC555\uC740 \uAC70\uC758 \uC77C\uC815\uD558\uAC8C \uC720\uC9C0\uB418\uBA70, \uC8FC\uB85C GMAW(\uBC18\uC790\uB3D9\uC6A9\uC811)\uC5D0 \uC0AC\uC6A9\uB418\uB294 \uC804\uC6D0 \uD2B9\uC131\uC740?",
    "options": [
      "\uC218\uD558 \uD2B9\uC131",
      "\uC815\uC804\uB958 \uD2B9\uC131",
      "\uC815\uC804\uC555 \uD2B9\uC131",
      "\uBD80\uC800\uD56D \uD2B9\uC131"
    ],
    "correctIndex": 2,
    "explanation": "\uC815\uC804\uC555 \uD2B9\uC131\uC740 \uC640\uC774\uC5B4 \uC1A1\uAE09 \uC18D\uB3C4\uAC00 \uC77C\uC815\uD560 \uB54C \uC544\uD06C \uAE38\uC774\uC5D0 \uB530\uB77C \uC804\uB958\uAC00 \uC2A4\uC2A4\uB85C \uBCC0\uD558\uC5EC \uC544\uD06C \uAE38\uC774\uB97C \uC6D0\uB798\uB300\uB85C \uBCF5\uC6D0\uD558\uB294(\uC790\uAE30\uC81C\uC5B4 \uD2B9\uC131) \uBC29\uC2DD\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s2q19",
    "set": 2,
    "num": 19,
    "difficulty": "easy",
    "category": "\uC785\uC5F4\uB7C9\uACFC \uBCC0\uD615",
    "question": "\uC6A9\uC811 \uD6C4 \uBAA8\uC7AC\uC5D0 \uB0A8\uC544\uC788\uB294 \uC794\uB958 \uC751\uB825\uC744 \uC81C\uAC70\uD558\uC5EC \uADE0\uC5F4\uC744 \uBC29\uC9C0\uD558\uAE30 \uC704\uD574 \uC2E4\uC2DC\uD558\uB294 \uC5F4\uCC98\uB9AC \uBC29\uBC95\uC740?",
    "options": [
      "\uB2F4\uAE08\uC9C8 (Quenching)",
      "\uC751\uB825\uC81C\uAC70 \uD480\uB9BC (Stress Relief Annealing)",
      "\uB728\uC784 (Tempering)",
      "\uD45C\uBA74\uACBD\uD654 (Surface hardening)"
    ],
    "correctIndex": 1,
    "explanation": "\uC6A9\uC811 \uC751\uB825\uC744 \uC81C\uAC70\uD558\uAE30 \uC704\uD574 \uBCC0\uD0DC\uC810 \uC774\uD558\uC758 \uC628\uB3C4\uB85C \uAC00\uC5F4\uD55C \uD6C4 \uC11C\uC11C\uD788 \uC2DD\uD788\uB294 \uC5F4\uCC98\uB9AC\uB97C \uC751\uB825\uC81C\uAC70 \uD480\uB9BC(SR)\uC774\uB77C\uACE0 \uD569\uB2C8\uB2E4."
  },
  {
    "id": "s2q20",
    "set": 2,
    "num": 20,
    "difficulty": "hard",
    "category": "\uC785\uC5F4\uB7C9\uACFC \uBCC0\uD615",
    "question": "\uC6A9\uC811 \uC2DC \uBC1C\uC0DD\uD558\uB294 \uAC01\uBCC0\uD615\uC744 \uBC29\uC9C0\uD558\uAE30 \uC704\uD574, \uBBF8\uB9AC \uC218\uCD95\uB420 \uBC29\uD5A5\uC758 \uBC18\uB300 \uBC29\uD5A5\uC73C\uB85C \uBAA8\uC7AC\uB97C \uAEBE\uC5B4\uB450\uAC70\uB098 \uAC01\uB3C4\uB97C \uC8FC\uC5B4 \uC870\uB9BD\uD558\uB294 \uBC29\uBC95\uC740?",
    "options": [
      "\uD53C\uB2DD (Peening)",
      "\uC5ED\uBCC0\uD615\uBC95 (Pre-setting / Pre-bending)",
      "\uAC15\uB825 \uAD6C\uC18D\uBC95",
      "\uC2A4\uD0B5 \uC6A9\uC811 (Skip welding)"
    ],
    "correctIndex": 1,
    "explanation": "\uC6A9\uC811 \uD6C4 \uC218\uCD95\uC73C\uB85C \uC778\uD574 \uBCC0\uD615\uB420 \uC591\uC744 \uBBF8\uB9AC \uC608\uCE21\uD558\uC5EC \uBC18\uB300 \uBC29\uD5A5\uC73C\uB85C \uAC01\uB3C4\uB97C \uC8FC\uC5B4 \uAC00\uC811\uD558\uB294 \uAC83\uC744 \uC5ED\uBCC0\uD615\uBC95\uC774\uB77C\uACE0 \uD569\uB2C8\uB2E4."
  },
  {
    "id": "s3q1",
    "set": 3,
    "num": 1,
    "difficulty": "easy",
    "category": "\uC6A9\uC811\uACFC \uAD00\uB828\uB41C \uC548\uC804",
    "question": "\uC6A9\uC811 \uC791\uC5C5 \uC2DC \uBC1C\uC0DD\uD558\uB294 \uC720\uD574 \uAD11\uC120 \uC911, \uD53C\uBD80\uC5D0 \uB178\uCD9C\uB420 \uACBD\uC6B0 \uD654\uC0C1\uC744 \uC785\uD788\uAC70\uB098 \uC548\uAD6C\uC5D0 \uC804\uAE30\uC131 \uC548\uC5FC(\uC544\uD06C\uC544\uC774)\uC744 \uC77C\uC73C\uD0A4\uB294 \uC8FC\uB41C \uAD11\uC120\uC740?",
    "options": [
      "\uAC00\uC2DC\uAD11\uC120",
      "\uC801\uC678\uC120",
      "\uC790\uC678\uC120",
      "\uAC10\uB9C8\uC120"
    ],
    "correctIndex": 2,
    "explanation": "\uC790\uC678\uC120\uC740 \uAC15\uB825\uD55C \uC5D0\uB108\uC9C0\uB97C \uAC00\uC9C0\uACE0 \uC788\uC5B4 \uB178\uCD9C \uC2DC \uD53C\uBD80 \uD654\uC0C1 \uBC0F \uC548\uAD6C \uACB0\uB9C9\uC5FC\uC744 \uC720\uBC1C\uD558\uBBC0\uB85C \uBCF4\uD638\uAD6C \uCC29\uC6A9\uC774 \uD544\uC218\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s3q2",
    "set": 3,
    "num": 2,
    "difficulty": "medium",
    "category": "\uC6A9\uC811\uACFC \uAD00\uB828\uB41C \uC548\uC804",
    "question": "\uD654\uC7AC\uC758 \uBD84\uB958 \uC911 \uC804\uAE30\uC5D0 \uC758\uD55C \uD654\uC7AC(C\uAE09 \uD654\uC7AC)\uAC00 \uBC1C\uC0DD\uD588\uC744 \uB54C, \uAC00\uC7A5 \uC801\uC808\uD558\uC9C0 \uC54A\uC740 \uC18C\uD654 \uBC29\uBC95\uC740?",
    "options": [
      "\uC774\uC0B0\uD654\uD0C4\uC18C(CO2) \uC18C\uD654\uAE30 \uC0AC\uC6A9",
      "\uD560\uB860(Halon) \uC18C\uD654\uAE30 \uC0AC\uC6A9",
      "\uBD84\uB9D0 \uC18C\uD654\uAE30 \uC0AC\uC6A9",
      "\uB2E4\uB7C9\uC758 \uBB3C\uC744 \uBFCC\uB9AC\uB294 \uD3EC\uC18C\uD654\uAE30 \uC0AC\uC6A9"
    ],
    "correctIndex": 3,
    "explanation": "\uC804\uAE30 \uD654\uC7AC\uC5D0 \uBB3C\uC744 \uBFCC\uB9AC\uBA74 \uAC10\uC804\uC758 \uC704\uD5D8\uC774 \uC788\uC73C\uBBC0\uB85C \uBC18\uB4DC\uC2DC \uBE44\uC804\uB3C4\uC131 \uC18C\uD654 \uC57D\uC81C\uB97C \uC0AC\uC6A9\uD574\uC57C \uD569\uB2C8\uB2E4."
  },
  {
    "id": "s3q3",
    "set": 3,
    "num": 3,
    "difficulty": "easy",
    "category": "\uC7A5\uBE44 \uBC0F \uB3C4\uAD6C",
    "question": "GTAW\uC5D0\uC11C \uBD88\uD65C\uC131 \uAC00\uC2A4\uC758 \uC720\uB7C9\uC744 \uC870\uC808\uD558\uACE0 \uD604\uC7AC \uD750\uB974\uB294 \uC591\uC744 \uD45C\uC2DC\uD574\uC8FC\uB294 \uC7A5\uCE58\uB294?",
    "options": [
      "\uC555\uB825\uACC4",
      "\uC720\uB7C9\uACC4 (Flow meter)",
      "\uAC00\uC2A4 \uB80C\uC988",
      "\uCCB4\uD06C \uBC38\uBE0C"
    ],
    "correctIndex": 1,
    "explanation": "\uC720\uB7C9\uACC4\uB294 \uC2E4\uB9B0\uB354\uC5D0\uC11C \uB098\uC624\uB294 \uAC00\uC2A4\uC758 \uC591(L/min)\uC744 \uC870\uC808\uD558\uACE0 \uC721\uC548\uC73C\uB85C \uD655\uC778\uD558\uAC8C \uD574\uC90D\uB2C8\uB2E4."
  },
  {
    "id": "s3q4",
    "set": 3,
    "num": 4,
    "difficulty": "medium",
    "category": "\uC7A5\uBE44 \uBC0F \uB3C4\uAD6C",
    "question": "\uD145\uC2A4\uD150 \uC804\uADF9\uBD09\uC758 \uC885\uB958 \uC911 \uC2DD\uBCC4 \uC0C9\uC0C1\uC774 '\uBE68\uAC04\uC0C9'\uC774\uBA70, \uC544\uD06C \uBC1C\uC0DD\uC774 \uC27D\uACE0 \uC218\uBA85\uC774 \uAE38\uC5B4 \uC9C1\uB958 \uC815\uADF9\uC131(DCEN) \uC6A9\uC811\uC5D0 \uB110\uB9AC \uC4F0\uC774\uB294 \uAC83\uC740?",
    "options": [
      "\uC21C\uC218 \uD145\uC2A4\uD150 (\uB179\uC0C9)",
      "\uC138\uB968 \uD145\uC2A4\uD150 (\uD68C\uC0C9)",
      "\uD1A0\uB968 \uD145\uC2A4\uD150 (\uBE68\uAC04\uC0C9)",
      "\uB780\uD0C4 \uD145\uC2A4\uD150 (\uAC80\uC815\uC0C9)"
    ],
    "correctIndex": 2,
    "explanation": "2% \uD1A0\uB968 \uD145\uC2A4\uD150 \uC804\uADF9\uBD09\uC740 \uC804\uC790 \uBC29\uCD9C \uB2A5\uB825\uC774 \uC88B\uC544 \uC544\uD06C \uAE30\uB3D9\uC774 \uC6B0\uC218\uD558\uBA70 \uC9C1\uB958 \uC6A9\uC811\uC758 \uD45C\uC900\uC73C\uB85C \uC4F0\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s3q5",
    "set": 3,
    "num": 5,
    "difficulty": "hard",
    "category": "\uC7A5\uBE44 \uBC0F \uB3C4\uAD6C",
    "question": "\uC6A9\uC811\uAE30 \uC804\uBA74 \uD328\uB110\uC758 '\uC5C5 \uC2AC\uB85C\uD504(Up-Slope)' \uAE30\uB2A5\uC758 \uC8FC\uC694 \uD6A8\uACFC\uB294 \uBB34\uC5C7\uC778\uAC00?",
    "options": [
      "\uC6A9\uC811 \uC885\uB8CC \uC2DC \uC804\uB958\uB97C \uC11C\uC11C\uD788 \uB0AE\uCD98\uB2E4.",
      "\uC544\uD06C\uAC00 \uC2DC\uC791\uB420 \uB54C \uC804\uB958\uB97C \uC11C\uC11C\uD788 \uB192\uC5EC \uBAA8\uC7AC\uC758 \uAE09\uACA9\uD55C \uAC00\uC5F4\uC744 \uB9C9\uACE0 \uCD08\uCE35 \uC6A9\uC785\uC744 \uC548\uC815\uC2DC\uD0A8\uB2E4.",
      "\uAD50\uB958 \uC6A9\uC811 \uC2DC \uC804\uADF9\uBD09\uC758 \uCCAD\uC815 \uD3ED\uC744 \uC870\uC808\uD55C\uB2E4.",
      "\uAC00\uC2A4 \uC808\uC57D\uC744 \uC704\uD574 \uC0AC\uD6C4 \uAC00\uC2A4 \uC2DC\uAC04\uC744 \uC870\uC808\uD55C\uB2E4."
    ],
    "correctIndex": 1,
    "explanation": "\uC5C5 \uC2AC\uB85C\uD504\uB294 \uCD08\uAE30 \uC804\uB958\uC5D0\uC11C \uBCF8 \uC6A9\uC811 \uC804\uB958\uAE4C\uC9C0 \uC2DC\uAC04\uC744 \uB450\uACE0 \uC11C\uC11C\uD788 \uC62C\uB824\uC8FC\uB294 \uAE30\uB2A5\uC73C\uB85C, \uC2DC\uC791 \uBD80\uC704\uC758 \uACB0\uD568\uC744 \uBC29\uC9C0\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s3q6",
    "set": 3,
    "num": 6,
    "difficulty": "easy",
    "category": "\uC6A9\uC811\uC758 \uC885\uB958",
    "question": "\uACE0\uC5D0\uB108\uC9C0 \uBC00\uB3C4\uB97C \uAC00\uC9C4 \uC544\uD06C\uB97C \uC0AC\uC6A9\uD558\uC5EC \uB450\uAEBC\uC6B4 \uD310\uB3C4 \uD55C \uBC88\uC5D0 \uC6A9\uC811\uC774 \uAC00\uB2A5\uD558\uBA70, TIG \uC6A9\uC811\uACFC \uC6D0\uB9AC\uB294 \uBE44\uC2B7\uD558\uB098 \uC218\uCD95\uB41C \uC544\uD06C\uB97C \uC0AC\uC6A9\uD558\uB294 \uC6A9\uC811\uBC95\uC740?",
    "options": [
      "\uD50C\uB77C\uC988\uB9C8 \uC544\uD06C \uC6A9\uC811 (PAW)",
      "\uD53C\uBCF5 \uC544\uD06C \uC6A9\uC811 (SMAW)",
      "\uAC00\uC2A4 \uC6A9\uC811 (OFW)",
      "\uC77C\uB809\uD2B8\uB85C \uAC00\uC2A4 \uC6A9\uC811 (EGW)"
    ],
    "correctIndex": 0,
    "explanation": "\uD50C\uB77C\uC988\uB9C8 \uC6A9\uC811\uC740 \uB178\uC990\uB85C \uC544\uD06C\uB97C \uC555\uCD95\uC2DC\uCF1C \uACE0\uC628/\uACE0\uBC00\uB3C4\uC758 \uC544\uD06C\uB97C \uD615\uC131\uD558\uB294 \uBC29\uC2DD\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s3q7",
    "set": 3,
    "num": 7,
    "difficulty": "medium",
    "category": "\uC6A9\uC811\uC758 \uC885\uB958",
    "question": "\uB450 \uBAA8\uC7AC \uC0AC\uC774\uC5D0 \uC587\uC740 \uAE08\uC18D\uBC15\uC744 \uB123\uACE0 \uACE0\uC9C4\uACF5 \uC0C1\uD0DC\uC5D0\uC11C \uAC00\uC5F4 \uBC0F \uC555\uB825\uC744 \uAC00\uD558\uC5EC \uC6D0\uC790\uC758 \uD655\uC0B0\uC744 \uD1B5\uD574 \uC811\uD569\uD558\uB294 \uC6A9\uC811\uBC95\uC740?",
    "options": [
      "\uD3ED\uBC1C \uC6A9\uC811",
      "\uD655\uC0B0 \uC6A9\uC811",
      "\uC720\uB3C4 \uC6A9\uC811",
      "\uD14C\uB974\uBC0B \uC6A9\uC811"
    ],
    "correctIndex": 1,
    "explanation": "\uD655\uC0B0 \uC6A9\uC811\uC740 \uACE0\uCCB4 \uC0C1\uD0DC\uC5D0\uC11C \uC6D0\uC790\uC758 \uC774\uB3D9(\uD655\uC0B0)\uC744 \uC774\uC6A9\uD558\uB294 \uB300\uD45C\uC801\uC778 \uACE0\uC0C1 \uC6A9\uC811\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s3q8",
    "set": 3,
    "num": 8,
    "difficulty": "easy",
    "category": "\uC544\uD06C\uC758 \uC774\uD574",
    "question": "\uC544\uD06C \uC6A9\uC811 \uC2DC \uBC1C\uC0DD\uD558\uB294 \uC5F4\uC5D0\uB108\uC9C0\uC758 \uBC30\uBD84 \uC911 \uC77C\uBC18\uC801\uC73C\uB85C \uC9C1\uB958 \uC815\uADF9\uC131(DCEN)\uC5D0\uC11C \uBAA8\uC7AC \uCABD\uC5D0 \uC9D1\uC911\uB418\uB294 \uC5F4\uB7C9 \uBE44\uC728\uC740?",
    "options": [
      "\uC57D 30%",
      "\uC57D 50%",
      "\uC57D 70%",
      "\uC57D 100%"
    ],
    "correctIndex": 2,
    "explanation": "\uC815\uADF9\uC131\uC5D0\uC11C\uB294 \uC804\uC790\uAC00 \uBAA8\uC7AC(+)\uB85C \uCDA9\uB3CC\uD558\uBBC0\uB85C \uBAA8\uC7AC \uCABD\uC5D0 \uC57D 70%\uC758 \uC5F4\uC774 \uBC1C\uC0DD\uD558\uC5EC \uC6A9\uC785\uC774 \uAE4A\uC5B4\uC9D1\uB2C8\uB2E4."
  },
  {
    "id": "s3q9",
    "set": 3,
    "num": 9,
    "difficulty": "hard",
    "category": "\uC544\uD06C\uC758 \uC774\uD574",
    "question": "\uC544\uD06C\uC758 \uC804\uC555-\uC804\uB958 \uACE1\uC120\uC5D0\uC11C \uC804\uB958\uAC00 \uC99D\uAC00\uD568\uC5D0 \uB530\uB77C \uC804\uC555\uC774 \uAC10\uC18C\uD558\uB2E4\uAC00 \uB2E4\uC2DC \uC99D\uAC00\uD558\uB294 \uD2B9\uC131\uC744 \uBB34\uC5C7\uC774\uB77C \uD558\uB294\uAC00?",
    "options": [
      "\uC634\uC758 \uBC95\uCE59",
      "\uC544\uD06C\uC758 \uBD80\uC800\uD56D \uD2B9\uC131",
      "\uC218\uD558 \uD2B9\uC131",
      "\uC790\uAE30 \uC81C\uC5B4 \uD2B9\uC131"
    ],
    "correctIndex": 1,
    "explanation": "\uC544\uD06C \uCD08\uAE30 \uB2E8\uACC4\uC5D0\uC11C \uC804\uB958\uAC00 \uB298\uBA74 \uC774\uC628\uD654\uAC00 \uCD09\uC9C4\uB418\uC5B4 \uC800\uD56D\uC774 \uB0AE\uC544\uC9C0\uACE0 \uC804\uC555\uC774 \uB5A8\uC5B4\uC9C0\uB294 \uD604\uC0C1\uC744 \uBD80\uC800\uD56D \uD2B9\uC131\uC774\uB77C\uACE0 \uD569\uB2C8\uB2E4."
  },
  {
    "id": "s3q10",
    "set": 3,
    "num": 10,
    "difficulty": "easy",
    "category": "\uC6A9\uC811 \uACB0\uD568",
    "question": "\uC6A9\uC811\uBD80 \uB0B4\uBD80\uB098 \uD45C\uBA74\uC5D0 \uC0DD\uAE30\uB294 \uC791\uC740 \uAD6C\uBA4D\uC73C\uB85C, \uACF5\uAE30 \uC911\uC758 \uC9C8\uC18C\uB098 \uBCF4\uD638\uAC00\uC2A4 \uBD80\uC871\uC73C\uB85C \uC778\uD574 \uBC1C\uC0DD\uD558\uB294 \uACB0\uD568\uC740?",
    "options": [
      "\uC624\uBC84\uB7A9",
      "\uAE30\uACF5 (Porosity)",
      "\uC5B8\uB354\uCEF7",
      "\uC2AC\uB798\uADF8 \uD63C\uC785"
    ],
    "correctIndex": 1,
    "explanation": "\uAE30\uACF5\uC740 \uC6A9\uC735 \uAE08\uC18D \uC18D\uC5D0 \uB179\uC544 \uB4E4\uC5B4\uAC04 \uAC00\uC2A4\uAC00 \uAD73\uC73C\uBA74\uC11C \uBE60\uC838\uB098\uC624\uC9C0 \uBABB\uD574 \uC0DD\uAE30\uB294 \uAD6C\uBA4D\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s3q11",
    "set": 3,
    "num": 11,
    "difficulty": "medium",
    "category": "\uC6A9\uC811 \uACB0\uD568",
    "question": "\uC6A9\uC811 \uBE44\uB4DC \uB05D\uBD80\uBD84(Toe)\uC5D0\uC11C \uBAA8\uC7AC\uAC00 \uAC00\uB298\uAC8C \uD30C\uC5EC \uACE8\uC774 \uC0DD\uAE34 \uACB0\uD568\uC758 \uC774\uB984\uACFC \uAC00\uC7A5 \uD070 \uC6D0\uC778\uC740?",
    "options": [
      "\uC624\uBC84\uB7A9 - \uB0AE\uC740 \uC804\uB958",
      "\uC5B8\uB354\uCEF7 - \uACFC\uB3C4\uD55C \uC804\uB958 \uBC0F \uBE60\uB978 \uC18D\uB3C4",
      "\uC6A9\uB77D - \uB108\uBB34 \uB290\uB9B0 \uC18D\uB3C4",
      "\uD145\uC2A4\uD150 \uD63C\uC785 - \uC804\uADF9\uBD09 \uC811\uCD09"
    ],
    "correctIndex": 1,
    "explanation": "\uC5B8\uB354\uCEF7\uC740 \uACFC\uB3C4\uD55C \uC5F4\uB85C \uBAA8\uC7AC\uAC00 \uB179\uC544\uB0B4\uB9B0 \uD6C4 \uC6A9\uAC00\uC7AC\uAC00 \uCC44\uC6CC\uC9C0\uC9C0 \uBABB\uD574 \uC0DD\uAE30\uB294 \uACE8\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s3q12",
    "set": 3,
    "num": 12,
    "difficulty": "hard",
    "category": "\uC6A9\uC811 \uACB0\uD568",
    "question": "\uC8FC\uB85C \uADF9\uD6C4\uD310 \uC6A9\uC811 \uC2DC \uAC15\uC7AC\uC758 \uB450\uAED8 \uBC29\uD5A5\uC73C\uB85C \uAC00\uD574\uC9C0\uB294 \uC778\uC7A5\uB825\uC5D0 \uC758\uD574 \uAC15\uD310 \uB0B4\uBD80\uC5D0\uC11C \uCE35\uC0C1(\uACC4\uB2E8 \uBAA8\uC591)\uC73C\uB85C \uAC08\uB77C\uC9C0\uB294 \uADE0\uC5F4\uC740?",
    "options": [
      "\uACE0\uC628 \uADE0\uC5F4",
      "\uC800\uC628 \uADE0\uC5F4",
      "\uB77C\uBA5C\uB77C \uD14C\uC5B4\uB9C1 (Lamellar Tearing)",
      "\uD1A0\uC6B0 \uADE0\uC5F4"
    ],
    "correctIndex": 2,
    "explanation": "\uAC15\uD310 \uC81C\uC870 \uC2DC \uD3EC\uD568\uB41C \uBE44\uAE08\uC18D \uAC1C\uC7AC\uBB3C\uC774 \uC6D0\uC778\uC774 \uB418\uC5B4 \uB450\uAED8 \uBC29\uD5A5 \uC218\uCD95\uB825\uC5D0 \uC758\uD574 \uBC1C\uC0DD\uD558\uB294 \uCE35\uC0C1 \uADE0\uC5F4\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s3q13",
    "set": 3,
    "num": 13,
    "difficulty": "easy",
    "category": "\uBE44\uD30C\uAD34 \uAC80\uC0AC",
    "question": "\uAC80\uC0AC\uC6D0\uC774 \uC9C1\uC811 \uB208\uC73C\uB85C \uC6A9\uC811\uBD80\uC758 \uBE44\uB4DC \uC678\uAD00, \uC5B8\uB354\uCEF7, \uC624\uBC84\uB7A9 \uB4F1\uC744 \uD655\uC778\uD558\uB294 \uAC00\uC7A5 \uAE30\uBCF8\uC801\uC774\uACE0 \uACBD\uC81C\uC801\uC778 \uAC80\uC0AC\uBC95\uC740?",
    "options": [
      "\uC721\uC548 \uAC80\uC0AC (VT)",
      "\uBC29\uC0AC\uC120 \uAC80\uC0AC (RT)",
      "\uCD08\uC74C\uD30C \uAC80\uC0AC (UT)",
      "\uC640\uB958 \uAC80\uC0AC (ET)"
    ],
    "correctIndex": 0,
    "explanation": "\uC721\uC548 \uAC80\uC0AC(VT)\uB294 \uBAA8\uB4E0 \uBE44\uD30C\uAD34 \uAC80\uC0AC\uC758 \uC2DC\uC791\uC774\uBA70 \uAC00\uC7A5 \uBA3C\uC800 \uC2DC\uD589\uB418\uB294 \uAE30\uCD08 \uAC80\uC0AC\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s3q14",
    "set": 3,
    "num": 14,
    "difficulty": "hard",
    "category": "\uBE44\uD30C\uAD34 \uAC80\uC0AC",
    "question": "\uB3C4\uCCB4\uC5D0 \uAD50\uB958\uB97C \uD758\uB824 \uBC1C\uC0DD\uD55C \uC790\uAE30\uC7A5\uC774 \uACB0\uD568\uC5D0 \uC758\uD574 \uD750\uD2B8\uB7EC\uC9C0\uB294 \uAC83\uC744 \uAC10\uC9C0\uD558\uB294 \uBC29\uBC95\uC73C\uB85C, \uC804\uB3C4\uCCB4 \uD45C\uBA74\uC758 \uBBF8\uC138 \uADE0\uC5F4\uC744 \uBE60\uB974\uAC8C \uAC80\uC0AC\uD558\uB294 \uBC95\uC740?",
    "options": [
      "\uC790\uBD84\uD0D0\uC0C1\uAC80\uC0AC (MT)",
      "\uC640\uB958\uD0D0\uC0C1\uAC80\uC0AC (ET)",
      "\uCE68\uD22C\uD0D0\uC0C1\uAC80\uC0AC (PT)",
      "\uC911\uC131\uC790 \uD68C\uC808\uAC80\uC0AC"
    ],
    "correctIndex": 1,
    "explanation": "\uC640\uB958\uD0D0\uC0C1(Eddy Current Testing)\uC740 \uC804\uB3C4\uCCB4 \uD45C\uBA74\uC5D0 \uC720\uB3C4\uB418\uB294 \uC640\uC804\uB958\uC758 \uBCC0\uD654\uB97C \uC774\uC6A9\uD574 \uACB0\uD568\uC744 \uCC3E\uC2B5\uB2C8\uB2E4."
  },
  {
    "id": "s3q15",
    "set": 3,
    "num": 15,
    "difficulty": "easy",
    "category": "\uC7AC\uB8CC \uBC0F \uC131\uBD84",
    "question": "\uAC15\uCCA0\uC758 5\uB300 \uC6D0\uC18C \uC911 \uC6A9\uC811\uBD80\uC758 \uACE0\uC628 \uADE0\uC5F4\uC744 \uC720\uBC1C\uD558\uAE30 \uC26C\uC6CC \uD568\uC720\uB7C9\uC744 \uC5C4\uACA9\uD788 \uC81C\uD55C\uD558\uB294 \uC131\uBD84\uC740?",
    "options": [
      "\uD0C4\uC18C (C), \uADDC\uC18C (Si)",
      "\uB9DD\uAC04 (Mn), \uC778 (P)",
      "\uD669 (S), \uC778 (P)",
      "\uD06C\uB86C (Cr), \uB2C8\uCF08 (Ni)"
    ],
    "correctIndex": 2,
    "explanation": "\uD669(S)\uACFC \uC778(P)\uC740 \uAE08\uC18D\uC758 \uACB0\uC815 \uC785\uACC4\uC5D0 \uD3B8\uC11D\uB418\uC5B4 \uACE0\uC628\uC5D0\uC11C \uCDE8\uC131\uC744 \uC720\uBC1C\uD558\uACE0 \uADE0\uC5F4\uC744 \uC77C\uC73C\uD0A4\uB294 \uC720\uD574 \uC6D0\uC18C\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s3q16",
    "set": 3,
    "num": 16,
    "difficulty": "medium",
    "category": "\uC7AC\uB8CC \uBC0F \uC131\uBD84",
    "question": "\uC54C\uB8E8\uBBF8\uB284 \uD569\uAE08 \uC6A9\uC811 \uC804 \uD45C\uBA74\uC758 \uC0B0\uD654\uD53C\uB9C9\uC744 \uC81C\uAC70\uD558\uAE30 \uC704\uD574 \uC0AC\uC6A9\uD558\uB294 \uD654\uD559\uC801 \uCCAD\uC815 \uBC29\uBC95\uC740?",
    "options": [
      "\uC54C\uCE7C\uB9AC \uC138\uCC99 \uBC0F \uC9C8\uC0B0 \uC911\uD654",
      "\uC5FC\uC0B0 \uCE68\uC804",
      "\uD669\uC0B0 \uAC00\uC5F4",
      "\uC544\uC138\uD1A4 \uB3C4\uD3EC"
    ],
    "correctIndex": 0,
    "explanation": "\uC54C\uB8E8\uBBF8\uB284\uC740 \uC54C\uCE7C\uB9AC \uC6A9\uC561\uC73C\uB85C \uC720\uBD84\uC744 \uC81C\uAC70\uD558\uACE0 \uC9C8\uC0B0 \uB4F1\uC73C\uB85C \uC0B0\uD654\uB9C9\uC744 \uC81C\uAC70\uD558\uB294 \uACFC\uC815\uC744 \uAC70\uCE69\uB2C8\uB2E4."
  },
  {
    "id": "s3q17",
    "set": 3,
    "num": 17,
    "difficulty": "easy",
    "category": "\uC6A9\uC811 \uADF9\uC131",
    "question": "GTAW\uC5D0\uC11C \uC9C1\uB958 \uC815\uADF9\uC131(DCEN) \uC0AC\uC6A9 \uC2DC \uC804\uADF9\uBD09\uC758 \uB05D \uBAA8\uC591\uC740 \uC5B4\uB5BB\uAC8C \uD558\uB294 \uAC83\uC774 \uAC00\uC7A5 \uC88B\uC740\uAC00?",
    "options": [
      "\uBB49\uB69D\uD558\uAC8C \uB465\uADFC \uBAA8\uC591",
      "\uBFB0\uC871\uD558\uAC8C \uC5F0\uB9C8\uD55C \uBAA8\uC591",
      "\uC0AC\uAC01\uD615 \uBAA8\uC591",
      "\uC5F0\uB9C8\uD558\uC9C0 \uC54A\uC740 \uC0C1\uD0DC"
    ],
    "correctIndex": 1,
    "explanation": "\uC815\uADF9\uC131\uC5D0\uC11C\uB294 \uC804\uADF9\uBD09\uC5D0 \uC5F4\uC774 \uC801\uAC8C \uAC78\uB9AC\uBBC0\uB85C \uB05D\uC744 \uBFB0\uC871\uD558\uAC8C \uC5F0\uB9C8\uD558\uC5EC \uC544\uD06C \uC9D1\uC911\uB3C4\uB97C \uB192\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s3q18",
    "set": 3,
    "num": 18,
    "difficulty": "easy",
    "category": "\uC804\uC6D0 \uD2B9\uC131",
    "question": "\uC6A9\uC811\uAE30\uC5D0 \uBA85\uC2DC\uB41C '\uC0AC\uC6A9\uB960(Duty Cycle)'\uC774 40%\uB77C\uB294 \uC758\uBBF8\uB294 \uBB34\uC5C7\uC778\uAC00? (10\uBD84 \uAE30\uC900)",
    "options": [
      "4\uBD84 \uC6A9\uC811\uD558\uACE0 6\uBD84 \uD734\uC2DD\uD574\uC57C \uD568",
      "10\uBD84 \uB0B4\uB0B4 \uC6A9\uC811 \uAC00\uB2A5\uD568",
      "\uC804\uCCB4 \uC791\uC5C5 \uC2DC\uAC04\uC758 40%\uB9CC \uCF1C\uB450\uC5B4\uC57C \uD568",
      "40\uB3C4 \uC628\uB3C4\uC5D0\uC11C\uB9CC \uC791\uB3D9\uD568"
    ],
    "correctIndex": 0,
    "explanation": "\uC0AC\uC6A9\uB960\uC740 \uC815\uACA9 \uC804\uB958\uB85C 10\uBD84 \uB3D9\uC548 \uC2E4\uC81C \uC544\uD06C\uB97C \uBC1C\uC0DD\uC2DC\uD0AC \uC218 \uC788\uB294 \uC2DC\uAC04\uC758 \uBE44\uC728\uC744 \uC758\uBBF8\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s3q19",
    "set": 3,
    "num": 19,
    "difficulty": "medium",
    "category": "\uC804\uC6D0 \uD2B9\uC131",
    "question": "\uC6A9\uC811\uAE30\uC758 \uBB34\uBD80\uD558 \uC804\uC555(\uC804\uAE30\uAC00 \uD750\uB974\uC9C0 \uC54A\uC744 \uB54C\uC758 \uC804\uC555)\uC774 \uB108\uBB34 \uB192\uC744 \uACBD\uC6B0 \uBC1C\uC0DD\uD558\uAE30 \uC26C\uC6B4 \uC0AC\uACE0\uB294?",
    "options": [
      "\uC544\uD06C \uC815\uC9C0",
      "\uC804\uACA9 \uC0AC\uACE0 (\uAC10\uC804)",
      "\uC6A9\uC811\uAE30 \uACFC\uC5F4",
      "\uAC00\uC2A4 \uD3ED\uBC1C"
    ],
    "correctIndex": 1,
    "explanation": "\uBB34\uBD80\uD558 \uC804\uC555\uC774 \uB192\uC73C\uBA74 \uC544\uD06C\uB294 \uC798 \uC0DD\uAE30\uC9C0\uB9CC, \uC791\uC5C5\uC790\uAC00 \uC804\uADF9\uC5D0 \uC811\uCD09\uD588\uC744 \uB54C \uAC10\uC804\uB420 \uC704\uD5D8\uC774 \uCEE4\uC9D1\uB2C8\uB2E4."
  },
  {
    "id": "s3q20",
    "set": 3,
    "num": 20,
    "difficulty": "hard",
    "category": "\uC785\uC5F4\uB7C9\uACFC \uBCC0\uD615",
    "question": "\uC6A9\uC811 \uBCC0\uD615 \uBC29\uC9C0\uBC95 \uC911 '\uD6C4\uD1F4\uBC95(Back-step method)'\uC758 \uC8FC\uC694 \uC6D0\uB9AC\uB294 \uBB34\uC5C7\uC778\uAC00?",
    "options": [
      "\uD55C\uAEBC\uBC88\uC5D0 \uAE38\uAC8C \uC6A9\uC811\uD558\uC5EC \uC5F4\uC744 \uC9D1\uC911\uC2DC\uD0A8\uB2E4.",
      "\uC9E7\uC740 \uAD6C\uAC04\uC529 \uB098\uB204\uC5B4 \uC804\uCCB4 \uC6A9\uC811 \uBC29\uD5A5\uACFC \uBC18\uB300 \uBC29\uD5A5\uC73C\uB85C \uC6A9\uC811\uD558\uC5EC \uC5F4\uC744 \uBD84\uC0B0\uC2DC\uD0A8\uB2E4.",
      "\uBAA8\uC7AC\uB97C \uC218\uC911\uC5D0 \uB2F4\uAC00 \uB0C9\uAC01\uC2DC\uD0A8\uB2E4.",
      "\uC9C0\uADF8\uB85C \uAF49 \uB20C\uB7EC\uC11C \uBABB \uC6C0\uC9C1\uC774\uAC8C \uD55C\uB2E4."
    ],
    "correctIndex": 1,
    "explanation": "\uD6C4\uD1F4\uBC95\uC740 \uC6A9\uC811 \uC9C4\uD589 \uBC29\uD5A5\uACFC \uAC1C\uBCC4 \uBE44\uB4DC\uC758 \uC9C4\uD589 \uBC29\uD5A5\uC744 \uBC18\uB300\uB85C \uD558\uC5EC \uC628\uB3C4 \uBD84\uD3EC\uB97C \uADE0\uC77C\uD558\uAC8C \uD558\uACE0 \uBCC0\uD615\uC744 \uC5B5\uC81C\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s4q1",
    "set": 4,
    "num": 1,
    "difficulty": "easy",
    "category": "\uC6A9\uC811\uACFC \uAD00\uB828\uB41C \uC548\uC804",
    "question": "GTAW \uC6A9\uC811 \uC791\uC5C5 \uC2DC \uD53C\uBD80\uB97C \uBCF4\uD638\uD558\uAE30 \uC704\uD574 \uAC00\uC8FD \uC55E\uCE58\uB9C8\uC640 \uD314\uD1A0\uC2DC\uB97C \uCC29\uC6A9\uD558\uB294 \uAC00\uC7A5 \uC8FC\uB41C \uC774\uC720\uB294 \uBB34\uC5C7\uC73C\uB85C\uBD80\uD130 \uD53C\uBD80\uB97C \uBCF4\uD638\uD558\uAE30 \uC704\uD568\uC778\uAC00?",
    "options": [
      "Ar \uAC00\uC2A4",
      "\uC790\uC678\uC120(UV) \uBC0F \uBC29\uC0AC\uC5F4",
      "\uC0B0\uC18C \uACB0\uD54D",
      "\uACE0\uC8FC\uD30C \uC804\uB958"
    ],
    "correctIndex": 1,
    "explanation": "\uC544\uD06C \uC6A9\uC811 \uC2DC \uBC1C\uC0DD\uD558\uB294 \uAC15\uB825\uD55C \uC790\uC678\uC120\uACFC \uC801\uC678\uC120(\uC5F4)\uC73C\uB85C\uBD80\uD130 \uD53C\uBD80 \uD654\uC0C1\uC744 \uC608\uBC29\uD558\uAE30 \uC704\uD574 \uAC00\uC8FD \uBCF4\uD638\uAD6C\uB97C \uCC29\uC6A9\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s4q2",
    "set": 4,
    "num": 2,
    "difficulty": "medium",
    "category": "\uC6A9\uC811\uACFC \uAD00\uB828\uB41C \uC548\uC804",
    "question": "GTAW \uC544\uD06C\uC758 \uAC15\uD55C \uC790\uC678\uC120\uC774 \uACF5\uAE30 \uC911\uC758 \uC0B0\uC18C(O2)\uC640 \uBC18\uC751\uD558\uC5EC \uC0DD\uC131\uB418\uBA70, \uBC00\uD3D0 \uACF5\uAC04\uC5D0\uC11C \uD761\uC785 \uC2DC \uB450\uD1B5\uACFC \uD638\uD761\uAE30 \uC9C8\uD658\uC744 \uC720\uBC1C\uD558\uB294 \uC720\uD574 \uAC00\uC2A4\uB294?",
    "options": [
      "CO (\uC77C\uC0B0\uD654\uD0C4\uC18C)",
      "O3 (\uC624\uC874)",
      "CO2 (\uC774\uC0B0\uD654\uD0C4\uC18C)",
      "H2S (\uD669\uD654\uC218\uC18C)"
    ],
    "correctIndex": 1,
    "explanation": "\uC790\uC678\uC120 \uBC29\uC0AC \uC5D0\uB108\uC9C0\uAC00 \uC8FC\uBCC0 \uC0B0\uC18C\uB97C \uBD84\uD574\uD558\uC5EC \uB3C5\uC131\uC774 \uC788\uB294 O3(\uC624\uC874)\uB97C \uBC1C\uC0DD\uC2DC\uD0A4\uBBC0\uB85C \uD658\uAE30\uAC00 \uD544\uC218\uC801\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s4q3",
    "set": 4,
    "num": 3,
    "difficulty": "easy",
    "category": "\uC7A5\uBE44 \uBC0F \uB3C4\uAD6C",
    "question": "GTAW Torch \uBD80\uD488 \uC911, Shielding gas\uB97C \uC6D0\uD558\uB294 \uBC29\uD5A5\uACFC \uBC94\uC704\uB85C \uBAA8\uC544\uC8FC\uBA70 \uC8FC\uB85C \uC138\uB77C\uBBF9 \uC7AC\uC9C8\uB85C \uB9CC\uB4E4\uC5B4\uC9C0\uB294 \uBD80\uD488\uC740?",
    "options": [
      "Collet",
      "Collet body",
      "Nozzle (Cup)",
      "Back cap"
    ],
    "correctIndex": 2,
    "explanation": "\uC138\uB77C\uBBF9 Nozzle\uC740 \uC5F4\uC5D0 \uAC15\uD558\uBA70 \uAC00\uC2A4\uB97C \uC6A9\uC811\uBD80 \uC8FC\uC704\uB85C \uACE0\uB974\uAC8C \uBD84\uC0AC\uD558\uB294 \uC5ED\uD560\uC744 \uD569\uB2C8\uB2E4."
  },
  {
    "id": "s4q4",
    "set": 4,
    "num": 4,
    "difficulty": "easy",
    "category": "\uC7A5\uBE44 \uBC0F \uB3C4\uAD6C",
    "question": "\uC6A9\uC811\uAE30 \uD328\uB110\uC758 'Post-flow(\uC0AC\uD6C4 \uAC00\uC2A4)' \uC124\uC815 \uC2DC\uAC04\uC740 \uC6A9\uC811\uC774 \uB05D\uB09C \uD6C4 \uC5B4\uB5A4 \uC5ED\uD560\uC744 \uD558\uB294\uAC00?",
    "options": [
      "Arc\uB97C \uB2E4\uC2DC \uBC1C\uC0DD\uC2DC\uD0A4\uAE30 \uC704\uD574 \uB300\uAE30\uD55C\uB2E4.",
      "\uC2DD\uC9C0 \uC54A\uC740 Tungsten \uC804\uADF9\uACFC \uC6A9\uC735\uC9C0\uAC00 \uC0B0\uD654\uB418\uB294 \uAC83\uC744 \uB9C9\uC544\uC900\uB2E4.",
      "\uC6A9\uC811\uAE30\uC758 \uC804\uC6D0\uC744 \uC790\uB3D9\uC73C\uB85C \uCC28\uB2E8\uD55C\uB2E4.",
      "\uB2E4\uC74C \uC6A9\uC811\uC758 \uCD08\uAE30 \uC804\uB958\uB97C \uB192\uC5EC\uC900\uB2E4."
    ],
    "correctIndex": 1,
    "explanation": "\uC6A9\uC811 \uC885\uB8CC \uD6C4\uC5D0\uB3C4 \uC77C\uC815 \uC2DC\uAC04 Ar \uAC00\uC2A4\uB97C \uD758\uB824\uBCF4\uB0B4 \uACE0\uC628 \uC0C1\uD0DC\uC758 \uC804\uADF9\uACFC \uC6A9\uC811\uBD80\uAC00 \uACF5\uAE30 \uC911 \uC0B0\uC18C\uC640 \uB2FF\uC544 \uC0B0\uD654(\uAC80\uAC8C \uBCC0\uC0C9)\uB418\uB294 \uAC83\uC744 \uBC29\uC9C0\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s4q5",
    "set": 4,
    "num": 5,
    "difficulty": "hard",
    "category": "\uC7A5\uBE44 \uBC0F \uB3C4\uAD6C",
    "question": "200A \uC774\uC0C1\uC758 \uACE0\uC804\uB958\uB97C \uC0AC\uC6A9\uD558\uB294 \uC218\uB0C9\uC2DD(Water-cooled) Torch \uC2DC\uC2A4\uD15C\uC5D0\uC11C \uB0C9\uAC01\uC218 \uC21C\uD658\uC774 \uBA48\uCD98 \uC0C1\uD0DC\uB85C \uACC4\uC18D \uC6A9\uC811\uD560 \uACBD\uC6B0 \uAC00\uC7A5 \uBA3C\uC800 \uBC1C\uC0DD\uD560 \uC218 \uC788\uB294 \uC2EC\uAC01\uD55C \uBB38\uC81C\uB294?",
    "options": [
      "Ar \uAC00\uC2A4\uC758 \uACF5\uAE09\uC774 \uCC28\uB2E8\uB41C\uB2E4.",
      "Tungsten \uC804\uADF9\uC774 \uB179\uC544 \uBAA8\uC7AC\uC5D0 \uD761\uC218\uB41C\uB2E4.",
      "Torch \uB0B4\uBD80\uC758 Power cable\uC774 \uACFC\uC5F4\uB418\uC5B4 \uB179\uC544 \uB04A\uC5B4\uC9C4\uB2E4.",
      "\uACE0\uC8FC\uD30C \uBC1C\uC0DD \uC7A5\uCE58\uAC00 \uD3ED\uBC1C\uD55C\uB2E4."
    ],
    "correctIndex": 2,
    "explanation": "\uC218\uB0C9\uC2DD Torch\uC758 Power cable\uC740 \uC587\uC740 \uAD6C\uB9AC\uC120\uC774 \uB0C9\uAC01\uC218 \uD638\uC2A4 \uC548\uC5D0 \uB4E4\uC5B4\uC788\uB294 \uAD6C\uC870\uC774\uBBC0\uB85C, \uBB3C\uC774 \uD750\uB974\uC9C0 \uC54A\uC73C\uBA74 \uC989\uAC01\uC801\uC73C\uB85C \uACFC\uC5F4\uB418\uC5B4 \uD0C0\uBC84\uB9BD\uB2C8\uB2E4."
  },
  {
    "id": "s4q6",
    "set": 4,
    "num": 6,
    "difficulty": "easy",
    "category": "\uC6A9\uC811\uC758 \uC885\uB958",
    "question": "\uBE44\uC18C\uBAA8\uC131 \uC804\uADF9\uC744 \uC0AC\uC6A9\uD558\uBA70 \uBD88\uD65C\uC131 \uAC00\uC2A4\uB85C \uC6A9\uC735\uC9C0\uB97C \uBCF4\uD638\uD558\uB294 \uC6A9\uC811 \uD504\uB85C\uC138\uC2A4\uB294?",
    "options": [
      "SMAW",
      "GMAW",
      "FCAW",
      "GTAW"
    ],
    "correctIndex": 3,
    "explanation": "GTAW(Gas Tungsten Arc Welding)\uB294 \uC18C\uBAA8\uB418\uC9C0 \uC54A\uB294 Tungsten\uC744 \uC804\uADF9\uC73C\uB85C \uC0AC\uC6A9\uD558\uB294 \uBC29\uC2DD\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s4q7",
    "set": 4,
    "num": 7,
    "difficulty": "medium",
    "category": "\uC6A9\uC811\uC758 \uC885\uB958",
    "question": "Brazing\uACFC Soldering\uC744 \uAD6C\uBD84\uD558\uB294 \uAE30\uC900 \uC628\uB3C4\uB294 \uC6A9\uAC00\uC7AC\uC758 \uC6A9\uC735\uC810 \uBA87 \uB3C4(\u2103)\uB97C \uAE30\uC900\uC73C\uB85C \uD558\uB294\uAC00?",
    "options": [
      "250\u2103",
      "450\u2103",
      "750\u2103",
      "1000\u2103"
    ],
    "correctIndex": 1,
    "explanation": "\uC6A9\uAC00\uC7AC \uC6A9\uC735\uC810 450\u2103 \uC774\uC0C1\uC740 Brazing(\uACBD\uB0A9\uB55C), 450\u2103 \uC774\uD558\uB294 Soldering(\uC5F0\uB0A9\uB55C)\uC73C\uB85C \uBD84\uB958\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s4q8",
    "set": 4,
    "num": 8,
    "difficulty": "easy",
    "category": "\uC544\uD06C\uC758 \uC774\uD574",
    "question": "\uC6A9\uC811 \uC911 \uC791\uC5C5\uC790\uC758 \uC190\uB5A8\uB9BC \uB4F1\uC73C\uB85C \uC778\uD574 Arc length\uAC00 \uAE38\uC5B4\uC84C\uC744 \uB54C \uC804\uAE30\uC801\uC73C\uB85C \uC77C\uC5B4\uB098\uB294 \uBCC0\uD654\uB294?",
    "options": [
      "Arc \uC804\uC555\uC774 \uC0C1\uC2B9\uD55C\uB2E4.",
      "Arc \uC804\uB958\uAC00 \uAE09\uC99D\uD55C\uB2E4.",
      "Arc \uC804\uC555\uC774 \uD558\uB77D\uD55C\uB2E4.",
      "\uC544\uBB34 \uBCC0\uD654\uAC00 \uC5C6\uB2E4."
    ],
    "correctIndex": 0,
    "explanation": "Arc \uAE38\uC774\uAC00 \uAE38\uC5B4\uC9C0\uBA74 \uC800\uD56D\uC774 \uC99D\uAC00\uD558\uBBC0\uB85C \uC774\uB97C \uB6AB\uACE0 \uC804\uAE30\uB97C \uBCF4\uB0B4\uAE30 \uC704\uD574 \uC804\uC555\uC774 \uC790\uC5F0\uC2A4\uB7FD\uAC8C \uC0C1\uC2B9\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s4q9",
    "set": 4,
    "num": 9,
    "difficulty": "hard",
    "category": "\uC544\uD06C\uC758 \uC774\uD574",
    "question": "DCEN(\uC9C1\uB958 \uC815\uADF9\uC131) GTAW\uC5D0\uC11C Arc\uB97C \uC720\uC9C0\uD558\uAE30 \uC704\uD55C \uC804\uC790\uB294 \uC8FC\uB85C \uC5B4\uB514\uC5D0\uC11C \uBC29\uCD9C\uB418\uB294\uAC00?",
    "options": [
      "\uBAA8\uC7AC \uD45C\uBA74\uC758 \uC0B0\uD654\uB9C9",
      "Shielding gas\uC758 \uC774\uC628\uD654",
      "\uAC00\uC5F4\uB41C Tungsten \uC804\uADF9 \uB05D\uBD80\uBD84 (\uC5F4\uC804\uC790 \uBC29\uCD9C)",
      "\uC811\uC9C0(Earth) Cable"
    ],
    "correctIndex": 2,
    "explanation": "\uACE0\uC628\uC73C\uB85C \uAC00\uC5F4\uB41C Tungsten \uC804\uADF9 \uB05D\uC5D0\uC11C \uC804\uC790\uAC00 \uD280\uC5B4\uB098\uC624\uB294 \uC5F4\uC804\uC790 \uBC29\uCD9C \uD604\uC0C1\uC774 Arc\uB97C \uC548\uC815\uC801\uC73C\uB85C \uC720\uC9C0\uD558\uB294 \uD575\uC2EC\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s4q10",
    "set": 4,
    "num": 10,
    "difficulty": "easy",
    "category": "\uC6A9\uC811 \uACB0\uD568",
    "question": "\uBAA8\uC7AC\uC758 \uB4B7\uBA74(Root)\uAE4C\uC9C0 \uC5F4\uC774 \uCDA9\uBD84\uD788 \uC804\uB2EC\uB418\uC9C0 \uC54A\uC544 \uC644\uC804\uD788 \uB179\uC9C0 \uC54A\uACE0 \uD648\uC774 \uCC44\uC6CC\uC9C0\uC9C0 \uC54A\uC740 \uC0C1\uD0DC\uB85C \uB0A8\uB294 \uACB0\uD568\uC740?",
    "options": [
      "Overlap",
      "Incomplete penetration (\uC6A9\uC785\uBD88\uB7C9)",
      "Undercut",
      "Porosity (\uAE30\uACF5)"
    ],
    "correctIndex": 1,
    "explanation": "\uC774\uBA74 \uBE44\uB4DC\uAC00 \uC81C\uB300\uB85C \uD615\uC131\uB418\uC9C0 \uC54A\uACE0 Root \uBD80\uC704\uAC00 \uB179\uC9C0 \uC54A\uC740 \uC0C1\uD0DC\uB97C \uC6A9\uC785\uBD88\uB7C9\uC774\uB77C\uACE0 \uD569\uB2C8\uB2E4."
  },
  {
    "id": "s4q11",
    "set": 4,
    "num": 11,
    "difficulty": "medium",
    "category": "\uC6A9\uC811 \uACB0\uD568",
    "question": "\uC6A9\uC811 \uC911 Arc\uAC00 \uD280\uBA74\uC11C \uAE08\uC18D \uBC29\uC6B8(Spatter)\uC774 \uBAA8\uC7AC \uD45C\uBA74\uC5D0 \uB4E4\uB7EC\uBD99\uB294 \uD604\uC0C1\uC5D0 \uB300\uD55C \uC124\uBA85\uC73C\uB85C \uC633\uC740 \uAC83\uC740?",
    "options": [
      "GTAW\uC5D0\uC11C\uB294 SMAW\uBCF4\uB2E4 Spatter\uAC00 \uD6E8\uC52C \uB9CE\uC774 \uBC1C\uC0DD\uD55C\uB2E4.",
      "GTAW\uB294 \uAE30\uBCF8\uC801\uC73C\uB85C Spatter\uAC00 \uAC70\uC758 \uBC1C\uC0DD\uD558\uC9C0 \uC54A\uB294 \uB9E4\uC6B0 \uAE68\uB057\uD55C \uD504\uB85C\uC138\uC2A4\uC774\uB2E4.",
      "Spatter\uB294 \uC6A9\uC811\uBD80\uC758 \uAC15\uB3C4\uB97C \uB192\uC5EC\uC8FC\uB294 \uC88B\uC740 \uC694\uC18C\uC774\uB2E4.",
      "Ar \uAC00\uC2A4 \uC720\uB7C9\uC744 \uB192\uC774\uBA74 Spatter\uAC00 \uBB34\uC870\uAC74 \uB9CE\uC774 \uC0DD\uAE34\uB2E4."
    ],
    "correctIndex": 1,
    "explanation": "GTAW\uB294 \uD50C\uB7ED\uC2A4\uAC00 \uC5C6\uACE0 \uC548\uC815\uB41C \uBE44\uC18C\uBAA8\uC131 \uC804\uADF9\uC744 \uC0AC\uC6A9\uD558\uBBC0\uB85C Spatter \uBC1C\uC0DD\uC774 \uADF9\uD788 \uC801\uC5B4 \uD6C4\uCC98\uB9AC\uAC00 \uD3B8\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s4q12",
    "set": 4,
    "num": 12,
    "difficulty": "medium",
    "category": "\uC6A9\uC811 \uACB0\uD568",
    "question": "\uC54C\uB8E8\uBBF8\uB284 \uC6A9\uC811 \uC2DC \uC6A9\uC811\uC744 \uB9C8\uCE58\uB294 \uB05D\uBD80\uBD84\uC5D0 \uC0DD\uAE30\uB294 Crater crack(\uC218\uCD95 \uADE0\uC5F4)\uC744 \uBC29\uC9C0\uD558\uAE30 \uC704\uD574 \uC6A9\uC811\uAE30 \uD328\uB110\uC5D0\uC11C \uBC18\uB4DC\uC2DC \uD65C\uC131\uD654\uD574\uC57C \uD558\uB294 \uAE30\uB2A5\uC740?",
    "options": [
      "Up-slope",
      "Down-slope",
      "Pulse",
      "Pre-flow"
    ],
    "correctIndex": 1,
    "explanation": "Down-slope(\uC804\uB958 \uC810\uAC10) \uAE30\uB2A5\uC744 \uC0AC\uC6A9\uD558\uC5EC \uC6A9\uC735\uC9C0\uB97C \uCC9C\uCC9C\uD788 \uC2DD\uD788\uACE0 \uCC44\uC6CC\uC8FC\uBA74 \uC218\uCD95\uC73C\uB85C \uC778\uD55C \uAC08\uB77C\uC9D0\uC744 \uB9C9\uC744 \uC218 \uC788\uC2B5\uB2C8\uB2E4."
  },
  {
    "id": "s4q13",
    "set": 4,
    "num": 13,
    "difficulty": "easy",
    "category": "\uBE44\uD30C\uAD34 \uAC80\uC0AC",
    "question": "\uC0AC\uB78C\uC758 \uADC0\uC5D0 \uB4E4\uB9AC\uC9C0 \uC54A\uB294 \uB192\uC740 \uC8FC\uD30C\uC218\uC758 \uC74C\uD30C\uB97C \uBAA8\uC7AC\uC5D0 \uC3D8\uC544 \uB0B4\uBD80\uC5D0 \uC788\uB294 \uACB0\uD568\uC5D0 \uBD80\uB52A\uD600 \uB3CC\uC544\uC624\uB294 \uC2E0\uD638\uB97C \uBD84\uC11D\uD558\uB294 \uBE44\uD30C\uAD34 \uAC80\uC0AC\uBC95\uC740?",
    "options": [
      "RT (Radiographic Testing)",
      "UT (Ultrasonic Testing)",
      "MT (Magnetic Particle Testing)",
      "PT (Penetrant Testing)"
    ],
    "correctIndex": 1,
    "explanation": "UT\uB294 \uCD08\uC74C\uD30C\uB97C \uC774\uC6A9\uD558\uC5EC \uBAA8\uC7AC \uB0B4\uBD80\uC758 \uACB0\uD568 \uC704\uCE58\uC640 \uD06C\uAE30\uB97C \uD30C\uC545\uD558\uB294 \uAC80\uC0AC\uBC95\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s4q14",
    "set": 4,
    "num": 14,
    "difficulty": "medium",
    "category": "\uBE44\uD30C\uAD34 \uAC80\uC0AC",
    "question": "PT (Penetrant Testing) \uAC80\uC0AC\uC758 \uAC00\uC7A5 \uD070 \uD55C\uACC4\uC810(\uB2E8\uC810)\uC740 \uBB34\uC5C7\uC778\uAC00?",
    "options": [
      "\uC790\uC131\uC744 \uB760\uB294 \uCCA0\uAC15 \uC7AC\uB8CC\uC5D0\uB9CC \uC0AC\uC6A9\uD560 \uC218 \uC788\uB2E4.",
      "\uC7A5\uBE44\uAC00 \uB9E4\uC6B0 \uBB34\uAC81\uACE0 \uBE44\uC2F8\uB2E4.",
      "\uBAA8\uC7AC \uB0B4\uBD80\uC5D0 \uC788\uB294 \uC228\uACA8\uC9C4 \uACB0\uD568\uC740 \uCC3E\uC744 \uC218 \uC5C6\uB2E4.",
      "\uBC29\uC0AC\uC120 \uD53C\uD3ED\uC758 \uC704\uD5D8\uC774 \uC788\uB2E4."
    ],
    "correctIndex": 2,
    "explanation": "PT\uB294 \uC561\uCCB4\uAC00 \uC2A4\uBA70\uB4DC\uB294 \uBAA8\uC138\uAD00 \uD604\uC0C1\uC744 \uC774\uC6A9\uD558\uBBC0\uB85C \uD45C\uBA74\uC5D0 \uC5F4\uB824 \uC788\uB294 \uACB0\uD568\uB9CC \uCC3E\uC744 \uC218 \uC788\uC73C\uBA70 \uB0B4\uBD80 \uACB0\uD568\uC740 \uBD88\uAC00\uB2A5\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s4q15",
    "set": 4,
    "num": 15,
    "difficulty": "easy",
    "category": "\uC7AC\uB8CC \uBC0F \uC131\uBD84",
    "question": "\uC54C\uB8E8\uBBF8\uB284\uC774\uB098 \uB9C8\uADF8\uB124\uC298 \uC6A9\uC811 \uC2DC \uC8FC\uB85C \uC0AC\uC6A9\uB418\uB294 '\uC21C\uC218 \uD145\uC2A4\uD150 \uC804\uADF9\uBD09'\uC758 \uC2DD\uBCC4 \uC0C9\uC0C1\uC740?",
    "options": [
      "\uBE68\uAC04\uC0C9",
      "\uD68C\uC0C9",
      "\uCD08\uB85D\uC0C9 (\uB179\uC0C9)",
      "\uAC80\uC815\uC0C9"
    ],
    "correctIndex": 2,
    "explanation": "\uAD50\uB958(AC) \uC6A9\uC811\uC5D0 \uC801\uD569\uD55C \uC21C\uC218 \uD145\uC2A4\uD150(Pure tungsten)\uC740 \uB05D\uBD80\uBD84 \uC2DD\uBCC4\uC0C9\uC774 \uCD08\uB85D\uC0C9\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s4q16",
    "set": 4,
    "num": 16,
    "difficulty": "hard",
    "category": "\uC7AC\uB8CC \uBC0F \uC131\uBD84",
    "question": "Titanium \uC6A9\uC811 \uC2DC \uACE0\uC628\uC5D0\uC11C \uC0B0\uC18C(O2), \uC9C8\uC18C(N2)\uC640 \uACB0\uD569\uD558\uC5EC \uCDE8\uC131(\uAE68\uC9C0\uB294 \uC131\uC9C8)\uC774 \uAE09\uACA9\uD788 \uC99D\uAC00\uD558\uBBC0\uB85C, \uC774\uB97C \uBC29\uC9C0\uD558\uAE30 \uC704\uD574 \uC0AC\uC6A9\uD558\uB294 \uD2B9\uC218\uD55C \uC7A5\uCE58\uB294?",
    "options": [
      "Gas lens",
      "Trailing shield (\uD6C4\uD589 \uC274\uB4DC)",
      "Water cooler",
      "Foot pedal"
    ],
    "correctIndex": 1,
    "explanation": "Titanium\uC740 \uC6A9\uC811\uC774 \uB05D\uB09C \uC9C1\uD6C4 \uAD73\uC5B4\uAC00\uB294 \uACE0\uC628 \uC0C1\uD0DC\uC5D0\uC11C\uB3C4 \uC0B0\uD654\uAC00 \uC77C\uC5B4\uB098\uBBC0\uB85C, Torch \uB4A4\uB97C \uB530\uB77C\uAC00\uBA70 \uAC00\uC2A4\uB97C \uB36E\uC5B4\uC8FC\uB294 Trailing shield\uAC00 \uD544\uC218\uC801\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s4q17",
    "set": 4,
    "num": 17,
    "difficulty": "easy",
    "category": "\uC6A9\uC811 \uADF9\uC131",
    "question": "\uC5F0\uAC15\uC774\uB098 \uC2A4\uD14C\uC778\uB9AC\uC2A4\uAC15 \uB450\uAEBC\uC6B4 \uD310\uC744 \uC6A9\uC811\uD560 \uB54C, \uBAA8\uC7AC\uC5D0 \uC5F4\uC744 70% \uC9D1\uC911\uC2DC\uCF1C \uAE4A\uC740 Penetration(\uC6A9\uC785)\uC744 \uC5BB\uAE30 \uC704\uD574 \uC124\uC815\uD558\uB294 \uADF9\uC131\uC740?",
    "options": [
      "AC (\uAD50\uB958)",
      "DCEN (\uC9C1\uB958 \uC815\uADF9\uC131)",
      "DCEP (\uC9C1\uB958 \uC5ED\uADF9\uC131)",
      "Pulse AC"
    ],
    "correctIndex": 1,
    "explanation": "DCEN\uC740 \uC804\uC790\uAC00 \uBAA8\uC7AC \uCABD\uC5D0 \uBD80\uB52A\uD600 \uBAA8\uC7AC\uAC00 \uAE4A\uAC8C \uB179\uC73C\uBBC0\uB85C GTAW \uCCA0\uAC15 \uC6A9\uC811\uC758 \uAE30\uBCF8 \uADF9\uC131\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s4q18",
    "set": 4,
    "num": 18,
    "difficulty": "medium",
    "category": "\uC804\uC6D0 \uD2B9\uC131",
    "question": "\uC218\uB3D9 GTAW \uC6A9\uC811\uAE30\uC758 \uC804\uC6D0 \uD2B9\uC131\uC778 '\uC815\uC804\uB958 \uD2B9\uC131'\uC774 \uC791\uC5C5\uC790\uC5D0\uAC8C \uC81C\uACF5\uD558\uB294 \uAC00\uC7A5 \uD070 \uC774\uC810\uC740?",
    "options": [
      "\uC190\uB5A8\uB9BC\uC73C\uB85C Arc length\uAC00 \uBCC0\uD574\uB3C4 \uC6A9\uC811 \uC804\uB958\uAC00 \uAC70\uC758 \uC77C\uC815\uD558\uAC8C \uC720\uC9C0\uB41C\uB2E4.",
      "Arc length\uAC00 \uAE38\uC5B4\uC9C0\uBA74 \uC804\uB958\uAC00 \uC790\uB3D9\uC73C\uB85C \uC0C1\uC2B9\uD558\uC5EC \uBE44\uB4DC\uB97C \uB113\uD600\uC900\uB2E4.",
      "\uC6A9\uC811 \uC18D\uB3C4\uC5D0 \uB9DE\uCDB0 \uC804\uC555\uC744 \uC790\uB3D9\uC73C\uB85C \uC870\uC808\uD55C\uB2E4.",
      "\uAC00\uC2A4 \uC720\uB7C9\uC744 \uC804\uB958\uC5D0 \uBE44\uB840\uD558\uC5EC \uC790\uB3D9\uC73C\uB85C \uB9DE\uCD98\uB2E4."
    ],
    "correctIndex": 0,
    "explanation": "\uC815\uC804\uB958(\uC218\uD558) \uD2B9\uC131\uC740 \uC804\uC555 \uBCC0\uB3D9\uC5D0 \uB300\uD55C \uC804\uB958 \uBCC0\uD654\uD3ED\uC774 \uC801\uC5B4 \uC791\uC5C5\uC790\uAC00 \uC77C\uC815\uD55C \uC6A9\uC785\uC744 \uC720\uC9C0\uD558\uB3C4\uB85D \uB3D5\uC2B5\uB2C8\uB2E4."
  },
  {
    "id": "s4q19",
    "set": 4,
    "num": 19,
    "difficulty": "easy",
    "category": "\uC785\uC5F4\uB7C9\uACFC \uBCC0\uD615",
    "question": "\uC6A9\uC811 \uD6C4 \uBAA8\uC7AC\uAC00 \uD718\uAC70\uB098 \uD2C0\uC5B4\uC9C0\uB294 \uBCC0\uD615(Deformation)\uC744 \uC904\uC774\uAE30 \uC704\uD55C \uBC29\uBC95\uC73C\uB85C \uC633\uC9C0 \uC54A\uC740 \uAC83\uC740?",
    "options": [
      "\uC6A9\uC811 \uC21C\uC11C\uB97C \uB300\uCE6D\uC73C\uB85C \uD55C\uB2E4.",
      "\uD55C \uBC88\uC5D0 \uB04A\uC9C0 \uC54A\uACE0 \uB05D\uAE4C\uC9C0 \uC5F0\uC18D\uC73C\uB85C \uAE38\uAC8C \uC6A9\uC811\uD55C\uB2E4.",
      "Back-step (\uD6C4\uD1F4\uBC95)\uC744 \uC0AC\uC6A9\uD55C\uB2E4.",
      "\uAC00\uC811(Tack weld)\uC744 \uD2BC\uD2BC\uD558\uACE0 \uCD18\uCD18\uD558\uAC8C \uD55C\uB2E4."
    ],
    "correctIndex": 1,
    "explanation": "\uD55C \uBC29\uD5A5\uC73C\uB85C \uC5F0\uC18D\uD574\uC11C \uC5F4\uC744 \uAC00\uD558\uBA74 \uBCC0\uD615\uC774 \uD55C\uCABD\uC73C\uB85C \uB204\uC801\uB418\uBBC0\uB85C, \uB04A\uC5B4\uC11C \uBD84\uC0B0 \uC6A9\uC811\uC744 \uD574\uC57C \uD569\uB2C8\uB2E4."
  },
  {
    "id": "s4q20",
    "set": 4,
    "num": 20,
    "difficulty": "hard",
    "category": "\uC785\uC5F4\uB7C9\uACFC \uBCC0\uD615",
    "question": "\uD0C4\uC18C\uAC15 \uC6A9\uC811 \uC2DC \uC785\uC5F4\uB7C9(Heat input)\uC774 \uB108\uBB34 \uB192\uC744 \uB54C \uC5F4\uC601\uD5A5\uBD80(HAZ)\uC758 \uAE08\uC18D \uC870\uC9C1\uC5D0 \uB098\uD0C0\uB098\uB294 \uD604\uC0C1\uC740?",
    "options": [
      "\uACB0\uC815\uB9BD(Grain)\uC774 \uBBF8\uC138\uD574\uC838 \uAC15\uC778\uD574\uC9C4\uB2E4.",
      "\uACB0\uC815\uB9BD\uC774 \uC870\uB300\uD654(\uCEE4\uC9D0)\uB418\uC5B4 \uCDA9\uACA9\uC5D0 \uC57D\uD574\uC9C4\uB2E4(\uC778\uC131 \uC800\uD558).",
      "\uC624\uC2A4\uD14C\uB098\uC774\uD2B8 \uC870\uC9C1\uC73C\uB85C \uC601\uAD6C \uBCC0\uD0DC\uD55C\uB2E4.",
      "\uB0B4\uC2DD\uC131\uC774 \uADF9\uB3C4\uB85C \uD5A5\uC0C1\uB41C\uB2E4."
    ],
    "correctIndex": 1,
    "explanation": "\uC5F4\uC744 \uB9CE\uC774, \uC624\uB798 \uBC1B\uC73C\uBA74 \uAE08\uC18D \uC870\uC9C1\uC758 \uACB0\uC815\uC774 \uAD75\uC5B4\uC9C0\uACE0 \uAC70\uCE60\uC5B4\uC838 \uC678\uBD80 \uCDA9\uACA9\uC5D0 \uC27D\uAC8C \uAE68\uC9C0\uB294 \uC131\uC9C8\uC744 \uAC16\uAC8C \uB429\uB2C8\uB2E4."
  },
  {
    "id": "s5q1",
    "set": 5,
    "num": 1,
    "difficulty": "easy",
    "category": "\uC6A9\uC811\uACFC \uAD00\uB828\uB41C \uC548\uC804",
    "question": "Arc \uC6A9\uC811 \uC791\uC5C5 \uC911 \uAC10\uC804 \uC0AC\uACE0\uB97C \uBAA9\uACA9\uD588\uC744 \uB54C \uAC00\uC7A5 \uBA3C\uC800 \uCDE8\uD574\uC57C \uD560 \uC548\uC804 \uC870\uCE58\uB294 \uBB34\uC5C7\uC778\uAC00?",
    "options": [
      "\uB9E8\uC190\uC73C\uB85C \uC791\uC5C5\uC790\uB97C \uC2E0\uC18D\uD788 \uB5BC\uC5B4\uB0B8\uB2E4.",
      "\uC778\uACF5\uD638\uD761\uC744 \uC989\uC2DC \uC2E4\uC2DC\uD55C\uB2E4.",
      "\uC6A9\uC811\uAE30 \uC804\uC6D0 \uC2A4\uC704\uCE58\uB97C \uCC3E\uC544 \uC989\uC2DC \uCC28\uB2E8\uD55C\uB2E4.",
      "\uC18C\uD654\uAE30\uB97C \uBFCC\uB9B0\uB2E4."
    ],
    "correctIndex": 2,
    "explanation": "\uAC10\uC804 \uC0AC\uACE0 \uBC1C\uC0DD \uC2DC 2\uCC28 \uAC10\uC804\uC744 \uC608\uBC29\uD558\uAE30 \uC704\uD574 \uAC00\uC7A5 \uBA3C\uC800 \uC804\uC6D0(\uC804\uAE30)\uC744 \uCC28\uB2E8\uD558\uB294 \uAC83\uC774 \uC6D0\uCE59\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s5q2",
    "set": 5,
    "num": 2,
    "difficulty": "medium",
    "category": "\uC6A9\uC811\uACFC \uAD00\uB828\uB41C \uC548\uC804",
    "question": "\uBC00\uD3D0\uB41C \uACF5\uAC04\uC5D0\uC11C Ar(\uC544\uB974\uACE4) \uAC00\uC2A4\uB97C \uC0AC\uC6A9\uD558\uC5EC GTAW \uC791\uC5C5\uC744 \uD560 \uB54C, \uC0B0\uC18C\uACB0\uD54D\uC99D \uC704\uD5D8 \uAE30\uC900\uC774 \uB418\uB294 \uACF5\uAE30 \uC911 \uC0B0\uC18C \uB18D\uB3C4\uB294 \uBA87 % \uBBF8\uB9CC\uC778\uAC00?",
    "options": [
      "10%",
      "15%",
      "18%",
      "21%"
    ],
    "correctIndex": 2,
    "explanation": "\uC0B0\uC5C5\uC548\uC804\uBCF4\uAC74\uBC95\uC0C1 \uC0B0\uC18C \uB18D\uB3C4\uAC00 18% \uBBF8\uB9CC\uC778 \uC0C1\uD0DC\uB97C \uC0B0\uC18C\uACB0\uD54D\uC73C\uB85C \uADDC\uC815\uD558\uBA70 \uC9C8\uC2DD \uC704\uD5D8\uC774 \uD06C\uBBC0\uB85C \uD658\uAE30\uAC00 \uD544\uC218\uC801\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s5q3",
    "set": 5,
    "num": 3,
    "difficulty": "easy",
    "category": "\uC7A5\uBE44 \uBC0F \uB3C4\uAD6C",
    "question": "GTAW Torch\uC758 Nozzle(\uC138\uB77C\uBBF9 \uCEF5) \uD06C\uAE30\uB97C \uB098\uD0C0\uB0B4\uB294 \uBC88\uD638(\uC608: #4, #6, #8)\uC758 \uAE30\uC900 \uB2E8\uC704\uB294 \uBB34\uC5C7\uC778\uAC00?",
    "options": [
      "1 mm",
      "1 cm",
      "1/16 inch",
      "1/8 inch"
    ],
    "correctIndex": 2,
    "explanation": "Nozzle \uBC88\uD638\uB294 1/16 inch \uB2E8\uC704\uB97C \uC0AC\uC6A9\uD569\uB2C8\uB2E4. \uC608\uB97C \uB4E4\uC5B4 #8 Nozzle\uC740 8/16 inch, \uC989 \uB0B4\uACBD\uC774 1/2 inch(\uC57D 12.7mm)\uC784\uC744 \uC758\uBBF8\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s5q4",
    "set": 5,
    "num": 4,
    "difficulty": "easy",
    "category": "\uC7A5\uBE44 \uBC0F \uB3C4\uAD6C",
    "question": "\uC6A9\uC811\uAE30 \uD328\uB110\uC5D0 \uB0B4\uC7A5\uB41C \uACE0\uC8FC\uD30C(High Frequency) \uBC1C\uC0DD \uC7A5\uCE58\uC758 \uC8FC\uB41C \uC5ED\uD560\uC740 \uBB34\uC5C7\uC778\uAC00?",
    "options": [
      "\uC6A9\uC811 \uC804\uB958\uB97C AC\uC5D0\uC11C DC\uB85C \uBCC0\uD658\uD55C\uB2E4.",
      "Tungsten \uC804\uADF9\uC774 \uBAA8\uC7AC\uC5D0 \uB2FF\uC9C0 \uC54A\uC544\uB3C4 \uACF5\uC911\uC5D0\uC11C Arc\uB97C \uC27D\uAC8C \uBC1C\uC0DD(Start)\uC2DC\uD0A8\uB2E4.",
      "\uBAA8\uC7AC\uB97C \uBBF8\uB9AC \uAC00\uC5F4\uD574 \uC900\uB2E4.",
      "\uAC00\uC2A4 \uC18C\uBAA8\uB7C9\uC744 \uC904\uC5EC\uC900\uB2E4."
    ],
    "correctIndex": 1,
    "explanation": "\uACE0\uC8FC\uD30C \uC804\uC555\uC774 \uACF5\uAE30\uC758 \uC808\uC5F0\uC744 \uD30C\uAD34\uD558\uC5EC \uBE44\uC811\uCD09 \uC0C1\uD0DC\uC5D0\uC11C\uB3C4 Arc\uAC00 \uAE30\uB3D9\uD560 \uC218 \uC788\uB3C4\uB85D \uB3C4\uC640 Tungsten \uC624\uC5FC\uC744 \uBC29\uC9C0\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s5q5",
    "set": 5,
    "num": 5,
    "difficulty": "hard",
    "category": "\uC7A5\uBE44 \uBC0F \uB3C4\uAD6C",
    "question": "Water-cooled torch(\uC218\uB0C9\uC2DD \uD1A0\uCE58) \uC2DC\uC2A4\uD15C \uB0B4\uBD80\uC758 \uB0C9\uAC01\uC218\uAC00 \uC6D0\uD65C\uD558\uAC8C \uD750\uB974\uC9C0 \uC54A\uC744 \uB54C, Torch \uCF00\uC774\uBE14\uC774 \uD0C0\uBC84\uB9AC\uB294 \uAC83\uC744 \uB9C9\uAE30 \uC704\uD574 \uC6A9\uC811\uAE30 \uCD9C\uB825\uC744 \uC790\uB3D9\uC73C\uB85C \uCC28\uB2E8\uD558\uB294 \uC548\uC804\uC7A5\uCE58\uB294?",
    "options": [
      "Flow switch (\uC720\uB7C9 \uC2A4\uC704\uCE58)",
      "Gas regulator (\uAC00\uC2A4 \uC870\uC815\uAE30)",
      "Earth clamp (\uC811\uC9C0 \uD074\uB7A8\uD504)",
      "High frequency generator (\uACE0\uC8FC\uD30C \uBC1C\uC0DD\uAE30)"
    ],
    "correctIndex": 0,
    "explanation": "\uB0C9\uAC01\uC218\uAC00 \uC77C\uC815 \uC555\uB825/\uC720\uB7C9\uC73C\uB85C \uD750\uB974\uC9C0 \uC54A\uC73C\uBA74 Flow switch\uAC00 \uC774\uB97C \uAC10\uC9C0\uD558\uC5EC \uC6A9\uC811\uAE30\uC758 \uC791\uB3D9\uC744 \uBA48\uCD94\uAC8C \uD574 Torch\uC758 \uC18C\uC190\uC744 \uBC29\uC9C0\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s5q6",
    "set": 5,
    "num": 6,
    "difficulty": "easy",
    "category": "\uC6A9\uC811\uC758 \uC885\uB958",
    "question": "\uAC00\uC5F0\uC131 \uAC00\uC2A4(\uC8FC\uB85C \uC544\uC138\uD2F8\uB80C)\uC640 \uC0B0\uC18C\uC758 \uD63C\uD569 \uC5F0\uC18C\uC5F4\uC744 \uC5F4\uC6D0\uC73C\uB85C \uC0AC\uC6A9\uD558\uC5EC \uBAA8\uC7AC\uB97C \uB179\uC774\uB294 \uC6A9\uC811\uBC95\uC740?",
    "options": [
      "GTAW",
      "SMAW",
      "OFW (Gas welding)",
      "FCAW"
    ],
    "correctIndex": 2,
    "explanation": "\uC0B0\uC18C-\uAC00\uC2A4 \uC5F0\uC18C\uC5F4\uC744 \uC774\uC6A9\uD558\uB294 \uAC00\uC2A4 \uC6A9\uC811(Oxy-Fuel Welding)\uC5D0 \uB300\uD55C \uC124\uBA85\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s5q7",
    "set": 5,
    "num": 7,
    "difficulty": "medium",
    "category": "\uC6A9\uC811\uC758 \uC885\uB958",
    "question": "SAW(Submerged Arc Welding)\uC758 \uD2B9\uC9D5\uC5D0 \uB300\uD55C \uC124\uBA85\uC73C\uB85C \uC62C\uBC14\uB974\uC9C0 \uC54A\uC740 \uAC83\uC740?",
    "options": [
      "\uBBF8\uC138\uD55C Flux(\uC6A9\uC81C) \uC18D\uC5D0 Arc\uB97C \uBC1C\uC0DD\uC2DC\uCF1C \uC791\uC5C5\uD55C\uB2E4.",
      "Arc \uBD88\uBE5B\uC774 \uBC16\uC73C\uB85C \uBCF4\uC774\uC9C0 \uC54A\uC544 \uBCF4\uC548\uACBD\uB9CC\uC73C\uB85C\uB3C4 \uC791\uC5C5\uC774 \uAC00\uB2A5\uD558\uB2E4.",
      "\uC587\uC740 \uBC15\uD310\uC758 \uC218\uB3D9 \uC6A9\uC811\uC5D0 \uAC00\uC7A5 \uB110\uB9AC \uC0AC\uC6A9\uB41C\uB2E4.",
      "\uC790\uB3D9 \uC6A9\uC811\uC774\uBBC0\uB85C \uB2A5\uB960\uC774 \uB192\uACE0 \uACB0\uD568\uC774 \uC801\uB2E4."
    ],
    "correctIndex": 2,
    "explanation": "SAW(\uC7A0\uD638 \uC6A9\uC811)\uB294 \uD558\uD5A5 \uC790\uB3D9 \uC6A9\uC811\uBC95\uC73C\uB85C, \uC8FC\uB85C \uC120\uBC15\uC774\uB098 \uCCA0\uACE8 \uAD6C\uC870\uBB3C \uB4F1\uC758 \uB450\uAEBC\uC6B4 \uD6C4\uD310(\uB450\uAEBC\uC6B4 \uCCA0\uD310) \uC6A9\uC811\uC5D0 \uC0AC\uC6A9\uB429\uB2C8\uB2E4."
  },
  {
    "id": "s5q8",
    "set": 5,
    "num": 8,
    "difficulty": "easy",
    "category": "\uC544\uD06C\uC758 \uC774\uD574",
    "question": "\uC6A9\uC811 \uC791\uC5C5 \uC2DC Torch\uB97C \uBAA8\uC7AC\uC5D0\uC11C \uB4E4\uC5B4 \uC62C\uB824 Arc length(\uC544\uD06C \uAE38\uC774)\uAC00 \uAE38\uC5B4\uC9C0\uAC8C \uB418\uBA74 \uC804\uC555\uC740 \uC5B4\uB5BB\uAC8C \uBCC0\uD558\uB294\uAC00?",
    "options": [
      "\uB0AE\uC544\uC9C4\uB2E4.",
      "\uBCC0\uD558\uC9C0 \uC54A\uB294\uB2E4.",
      "\uB192\uC544\uC9C4\uB2E4.",
      "\uC804\uB958\uC640 \uB3D9\uC77C\uD574\uC9C4\uB2E4."
    ],
    "correctIndex": 2,
    "explanation": "Arc length\uAC00 \uAE38\uC5B4\uC9C0\uBA74 \uC804\uAE30\uC801 \uC800\uD56D\uC774 \uCEE4\uC9C0\uBBC0\uB85C \uC774\uB97C \uB6AB\uACE0 \uC804\uAE30\uB97C \uD750\uB974\uAC8C \uD558\uAE30 \uC704\uD574 \uC804\uC555\uC774 \uC790\uC5F0\uC2A4\uB7FD\uAC8C \uC0C1\uC2B9\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s5q9",
    "set": 5,
    "num": 9,
    "difficulty": "hard",
    "category": "\uC544\uD06C\uC758 \uC774\uD574",
    "question": "Arc stiffness(\uC544\uD06C \uAC15\uC131)\uAC00 \uC88B\uB2E4\uB294 \uAC83\uC740 \uBB34\uC5C7\uC744 \uC758\uBBF8\uD558\uB294\uAC00?",
    "options": [
      "Arc\uC758 \uC628\uB3C4\uAC00 \uB9E4\uC6B0 \uB192\uC74C\uC744 \uC758\uBBF8\uD55C\uB2E4.",
      "Arc\uAC00 \uC678\uBD80\uC758 \uBC14\uB78C\uC774\uB098 \uC790\uC7A5(Magnetic field)\uC758 \uC601\uD5A5\uC744 \uB35C \uBC1B\uACE0 \uC9C1\uC9C4\uC131\uC744 \uC720\uC9C0\uD558\uB294 \uC131\uC9C8\uC744 \uC758\uBBF8\uD55C\uB2E4.",
      "Arc\uAC00 \uB113\uAC8C \uD37C\uC838 \uB113\uC740 \uBA74\uC801\uC744 \uB179\uC774\uB294 \uC131\uC9C8\uC744 \uC758\uBBF8\uD55C\uB2E4.",
      "\uC804\uB958\uAC00 \uC804\uC555\uBCF4\uB2E4 \uC6D4\uB4F1\uD788 \uB192\uC74C\uC744 \uC758\uBBF8\uD55C\uB2E4."
    ],
    "correctIndex": 1,
    "explanation": "\uC544\uD06C\uAC00 \uBD80\uB4DC\uB7FD\uC9C0 \uC54A\uACE0 \uBEE3\uBEE3\uD558\uAC8C(Stiff) \uC9C1\uC9C4\uD558\uB824\uB294 \uC131\uC9C8\uC774 \uAC15\uD558\uBA74 \uC6D0\uD558\uB294 \uBD80\uC704\uC5D0 \uC815\uD655\uD788 \uC5F4\uC744 \uC9D1\uC911\uC2DC\uD0AC \uC218 \uC788\uC2B5\uB2C8\uB2E4."
  },
  {
    "id": "s5q10",
    "set": 5,
    "num": 10,
    "difficulty": "easy",
    "category": "\uC6A9\uC811 \uACB0\uD568",
    "question": "\uC6A9\uC811 Bead \uD45C\uBA74\uC758 \uB05D\uBD80\uBD84\uC774 \uBAA8\uC7AC\uC640 \uC735\uD569\uB418\uC9C0 \uBABB\uD558\uACE0 \uBAA8\uC7AC \uC704\uB85C \uBCFC\uB85D\uD558\uAC8C \uACB9\uCCD0\uC11C \uD758\uB7EC\uB0B4\uB9B0 \uD615\uD0DC\uC758 \uACB0\uD568\uC740?",
    "options": [
      "Undercut",
      "Overlap",
      "Crack",
      "Porosity"
    ],
    "correctIndex": 1,
    "explanation": "Overlap\uC740 \uC1F3\uBB3C\uC774 \uB108\uBB34 \uCC28\uAC11\uAC70\uB098 \uC6B4\uBD09\uC774 \uB290\uB824 \uBAA8\uC7AC \uD45C\uBA74\uC744 \uB179\uC774\uC9C0 \uBABB\uD55C \uCC44 \uB2E8\uC21C\uD788 \uC5B9\uD600\uC9C4(\uACB9\uCE5C) \uC0C1\uD0DC\uB97C \uB9D0\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s5q11",
    "set": 5,
    "num": 11,
    "difficulty": "medium",
    "category": "\uC6A9\uC811 \uACB0\uD568",
    "question": "GTAW \uC6A9\uC811 \uC911 Tungsten \uC804\uADF9\uC774 \uBAA8\uC7AC\uC758 \uC6A9\uC735\uC9C0(Pool)\uB098 \uC6A9\uAC00\uC7AC\uC5D0 \uC9C1\uC811 \uB2FF\uC544 \uBD80\uB7EC\uC838 \uBE44\uB4DC \uB0B4\uBD80\uC5D0 \uB0A8\uAC8C \uB418\uB294 \uACB0\uD568\uC740?",
    "options": [
      "Slag inclusion",
      "Tungsten inclusion",
      "Underfill",
      "Crater pipe"
    ],
    "correctIndex": 1,
    "explanation": "\uD145\uC2A4\uD150\uC740 \uB179\uB294\uC810\uC774 \uB9E4\uC6B0 \uB192\uC544 \uBAA8\uC7AC\uC5D0 \uB2FF\uC73C\uBA74 \uBD80\uB7EC\uC838 \uC1F3\uBB3C \uC18D\uC5D0 \uC11E\uC774\uAC8C \uB418\uBA70, \uC774\uB97C \uD145\uC2A4\uD150 \uD63C\uC785(Tungsten inclusion)\uC774\uB77C\uACE0 \uD569\uB2C8\uB2E4."
  },
  {
    "id": "s5q12",
    "set": 5,
    "num": 12,
    "difficulty": "easy",
    "category": "\uC6A9\uC811 \uACB0\uD568",
    "question": "\uC6A9\uC811 \uACB0\uD568 \uC911 \uC678\uBD80 \uACF5\uAE30\uC758 \uCE68\uD22C\uB098 \uBAA8\uC7AC \uD45C\uBA74\uC758 \uBD88\uC21C\uBB3C\uB85C \uC778\uD574 Bead \uB0B4\uBD80\uC5D0 \uAC00\uC2A4\uAC00 \uAC07\uD600 \uC0DD\uAE30\uB294 \uB465\uADFC \uD615\uD0DC\uC758 \uAD6C\uBA4D\uC740?",
    "options": [
      "Spatter",
      "Porosity (\uAE30\uACF5)",
      "Undercut",
      "Overlap"
    ],
    "correctIndex": 1,
    "explanation": "Porosity(\uAE30\uACF5/\uBE14\uB85C\uC6B0\uD640)\uB294 \uC1F3\uBB3C \uC18D \uAC00\uC2A4\uAC00 \uAD73\uC73C\uBA74\uC11C \uBE60\uC838\uB098\uC624\uC9C0 \uBABB\uD574 \uC0DD\uC131\uB41C \uBE48 \uACF5\uAC04\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s5q13",
    "set": 5,
    "num": 13,
    "difficulty": "easy",
    "category": "\uBE44\uD30C\uAD34 \uAC80\uC0AC",
    "question": "\uC790\uC131\uC744 \uB760\uC9C0 \uC54A\uB294 \uBE44\uC790\uC131\uCCB4(\uC54C\uB8E8\uBBF8\uB284\uC774\uB098 \uC624\uC2A4\uD14C\uB098\uC774\uD2B8\uACC4 STS)\uC758 \uD45C\uBA74\uC5D0 \uBC1C\uC0DD\uD55C \uBBF8\uC138\uD55C \uADE0\uC5F4\uC744 \uAC80\uC0AC\uD558\uAE30 \uC704\uD574 \uAC00\uC7A5 \uB110\uB9AC \uC0AC\uC6A9\uB418\uB294 \uBE44\uD30C\uAD34 \uAC80\uC0AC\uBC95\uC740?",
    "options": [
      "MT (\uC790\uBD84 \uD0D0\uC0C1)",
      "UT (\uCD08\uC74C\uD30C \uD0D0\uC0C1)",
      "RT (\uBC29\uC0AC\uC120 \uD22C\uACFC)",
      "PT (\uC561\uCCB4 \uCE68\uD22C \uD0D0\uC0C1)"
    ],
    "correctIndex": 3,
    "explanation": "MT\uB294 \uC790\uC131\uCCB4(\uCCA0\uAC15)\uC5D0\uB9CC \uAC00\uB2A5\uD558\uBBC0\uB85C, \uBE44\uC790\uC131 \uAE08\uC18D\uC758 \uD45C\uBA74 \uACB0\uD568\uC740 \uBAA8\uC138\uAD00 \uD604\uC0C1\uC744 \uC774\uC6A9\uD55C PT\uB85C \uAC80\uC0AC\uD574\uC57C \uD569\uB2C8\uB2E4."
  },
  {
    "id": "s5q14",
    "set": 5,
    "num": 14,
    "difficulty": "medium",
    "category": "\uBE44\uD30C\uAD34 \uAC80\uC0AC",
    "question": "RT(\uBC29\uC0AC\uC120 \uD22C\uACFC \uAC80\uC0AC) \uD544\uB984\uC5D0\uC11C Tungsten inclusion(\uD145\uC2A4\uD150 \uD63C\uC785) \uACB0\uD568\uC740 \uC5B4\uB5A4 \uD615\uD0DC\uB85C \uAD00\uCC30\uB418\uB294\uAC00?",
    "options": [
      "\uC8FC\uBCC0\uBCF4\uB2E4 \uD6E8\uC52C \uC5B4\uB450\uC6B4(\uAC80\uC740) \uC810",
      "\uAC00\uB298\uACE0 \uAE34 \uC9C0\uADF8\uC7AC\uADF8 \uC120",
      "\uC8FC\uBCC0\uBCF4\uB2E4 \uD6E8\uC52C \uBC1D\uC740(\uD558\uC580) \uC810",
      "\uD76C\uBBF8\uD55C \uD68C\uC0C9 \uAD6C\uB984 \uBAA8\uC591"
    ],
    "correctIndex": 2,
    "explanation": "\uD145\uC2A4\uD150\uC740 \uBE44\uC911\uACFC \uBC00\uB3C4\uAC00 \uB192\uC544 \uBC29\uC0AC\uC120\uC774 \uC798 \uD22C\uACFC\uD558\uC9C0 \uBABB\uD558\uBBC0\uB85C, \uD22C\uACFC\uB41C \uC591\uC774 \uC801\uC5B4 \uD544\uB984 \uC0C1\uC5D0\uC11C \uC8FC\uBCC0\uBCF4\uB2E4 \uBC1D\uC740 \uD770\uC0C9 \uC810\uC73C\uB85C \uB098\uD0C0\uB0A9\uB2C8\uB2E4 (\uAE30\uACF5\uC740 \uAC80\uC740\uC0C9)."
  },
  {
    "id": "s5q15",
    "set": 5,
    "num": 15,
    "difficulty": "easy",
    "category": "\uC7AC\uB8CC \uBC0F \uC131\uBD84",
    "question": "\uC77C\uBC18\uC801\uC778 \uD0C4\uC18C\uAC15\uC5D0\uC11C \uD0C4\uC18C(C)\uC758 \uD568\uC720\uB7C9\uC774 \uC99D\uAC00\uD560\uC218\uB85D \uB098\uD0C0\uB098\uB294 \uAE30\uACC4\uC801 \uC131\uC9C8\uC758 \uBCC0\uD654\uB85C \uC62C\uBC14\uB978 \uAC83\uC740?",
    "options": [
      "\uACBD\uB3C4\uC640 \uAC15\uB3C4\uAC00 \uB0AE\uC544\uC9C4\uB2E4.",
      "\uC5F0\uC131(\uB298\uC5B4\uB098\uB294 \uC131\uC9C8)\uC774 \uC99D\uAC00\uD55C\uB2E4.",
      "\uACBD\uB3C4\uC640 \uAC15\uB3C4\uB294 \uC99D\uAC00\uD558\uC9C0\uB9CC, \uCDE8\uC131(\uAE68\uC9C0\uB294 \uC131\uC9C8)\uC774 \uCEE4\uC9C4\uB2E4.",
      "\uC6A9\uC811\uC131\uC774 \uB9E4\uC6B0 \uC88B\uC544\uC9C4\uB2E4."
    ],
    "correctIndex": 2,
    "explanation": "\uD0C4\uC18C\uB7C9\uC774 \uB9CE\uC544\uC9C0\uBA74 \uAE08\uC18D\uC740 \uB2E8\uB2E8\uD574\uC9C0\uC9C0\uB9CC(\uAC15\uB3C4/\uACBD\uB3C4 \uC99D\uAC00), \uADF8\uB9CC\uD07C \uC798 \uAE68\uC9C0\uACE0(\uCDE8\uC131 \uC99D\uAC00) \uC6A9\uC811 \uC2DC \uADE0\uC5F4 \uBC1C\uC0DD \uC704\uD5D8\uC774 \uB192\uC544\uC9D1\uB2C8\uB2E4."
  },
  {
    "id": "s5q16",
    "set": 5,
    "num": 16,
    "difficulty": "medium",
    "category": "\uC7AC\uB8CC \uBC0F \uC131\uBD84",
    "question": "\uC624\uC2A4\uD14C\uB098\uC774\uD2B8\uACC4 STS\uC758 \uC6A9\uC811 \uC2DC \uC5F4\uC601\uD5A5\uBD80(HAZ)\uC5D0\uC11C \uBC1C\uC0DD\uD558\uB294 \uC608\uBBFC\uD654(Sensitization, \uB0B4\uBD80\uC2DD\uC131 \uC800\uD558) \uD604\uC0C1\uC744 \uBC29\uC9C0\uD558\uAE30 \uC704\uD574 \uC8FC\uB85C \uCCA8\uAC00\uD558\uB294 \uC548\uC815\uD654 \uC6D0\uC18C\uB294?",
    "options": [
      "\uD0C4\uC18C (C)",
      "\uD2F0\uD0C0\uB284 (Ti) \uB610\uB294 \uB2C8\uC624\uBE00 (Nb)",
      "\uAD6C\uB9AC (Cu)",
      "\uB0A9 (Pb)"
    ],
    "correctIndex": 1,
    "explanation": "\uC608\uBBFC\uD654\uB294 \uD06C\uB86C \uD0C4\uD654\uBB3C\uC774 \uC11D\uCD9C\uB418\uC5B4 \uB0B4\uC2DD\uC131\uC774 \uB5A8\uC5B4\uC9C0\uB294 \uD604\uC0C1\uC774\uBBC0\uB85C, \uD06C\uB86C\uBCF4\uB2E4 \uD0C4\uC18C\uC640 \uACB0\uD569\uB825\uC774 \uC88B\uC740 Ti, Nb\uB97C \uCCA8\uAC00\uD558\uC5EC(STS 321, 347 \uB4F1) \uD06C\uB86C\uC744 \uBCF4\uC874\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s5q17",
    "set": 5,
    "num": 17,
    "difficulty": "easy",
    "category": "\uC6A9\uC811 \uADF9\uC131",
    "question": "GTAW \uCCA0\uAC15 \uC6A9\uC811\uC758 \uAE30\uBCF8 \uADF9\uC131\uC73C\uB85C, \uC804\uADF9\uC774 \uB9C8\uC774\uB108\uC2A4(-), \uBAA8\uC7AC\uAC00 \uD50C\uB7EC\uC2A4(+)\uB85C \uC5F0\uACB0\uB418\uC5B4 \uBAA8\uC7AC\uC5D0 \uAE4A\uC740 \uC6A9\uC785\uC744 \uC8FC\uB294 \uADF9\uC131\uC740?",
    "options": [
      "AC",
      "DCEP (\uC9C1\uB958 \uC5ED\uADF9\uC131)",
      "DCEN (\uC9C1\uB958 \uC815\uADF9\uC131)",
      "DCRP"
    ],
    "correctIndex": 2,
    "explanation": "DCEN(\uC9C1\uB958 \uC815\uADF9\uC131)\uC740 \uC804\uC790\uAC00 \uBAA8\uC7AC\uB85C \uCDA9\uB3CC\uD558\uC5EC \uC57D 70%\uC758 \uC5F4\uC774 \uBAA8\uC7AC\uC5D0 \uC9D1\uC911\uB418\uBBC0\uB85C \uAC00\uC7A5 \uBCF4\uD3B8\uC801\uC73C\uB85C \uC4F0\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s5q18",
    "set": 5,
    "num": 18,
    "difficulty": "medium",
    "category": "\uC804\uC6D0 \uD2B9\uC131",
    "question": "\uC218\uB3D9 \uC6A9\uC811\uAE30(SMAW, GTAW) \uC804\uC6D0\uC758 \uC678\uBD80 \uD2B9\uC131 \uACE1\uC120\uC73C\uB85C, \uBD80\uD558 \uC804\uB958\uAC00 \uC99D\uAC00\uD560 \uB54C \uB2E8\uC790 \uC804\uC555\uC774 \uAE09\uACA9\uD558\uAC8C \uB0AE\uC544\uC838 Arc\uAC00 \uC548\uC815\uC801\uC73C\uB85C \uC720\uC9C0\uB418\uB3C4\uB85D \uD558\uB294 \uD2B9\uC131\uC740?",
    "options": [
      "\uC218\uD558 \uD2B9\uC131 (Drooping characteristic)",
      "\uC815\uC804\uC555 \uD2B9\uC131 (Constant voltage)",
      "\uC0C1\uC2B9 \uD2B9\uC131 (Rising characteristic)",
      "\uBD80\uC800\uD56D \uD2B9\uC131 (Negative resistance)"
    ],
    "correctIndex": 0,
    "explanation": "\uC218\uD558 \uD2B9\uC131\uC740 \uC804\uC555\uACFC \uC804\uB958\uC758 \uAD00\uACC4 \uACE1\uC120\uC774 \uBC11\uC73C\uB85C \uB69D \uB5A8\uC5B4\uC9C0\uB294(Drooping) \uBAA8\uC591\uC73C\uB85C, Arc length\uAC00 \uBCC0\uD574\uB3C4 \uC804\uB958\uC758 \uBCC0\uB3D9 \uD3ED\uC744 \uC904\uC5EC\uC8FC\uB294 \uC218\uB3D9 \uC6A9\uC811\uC758 \uD575\uC2EC \uD2B9\uC131\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s5q19",
    "set": 5,
    "num": 19,
    "difficulty": "easy",
    "category": "\uC785\uC5F4\uB7C9\uACFC \uBCC0\uD615",
    "question": "\uC6A9\uC811 \uD6C4 \uAE08\uC18D\uC774 \uAC00\uC5F4 \uBC0F \uB0C9\uAC01\uB418\uB294 \uACFC\uC815\uC5D0\uC11C \uD33D\uCC3D\uACFC \uC218\uCD95\uC774 \uBD88\uADE0\uC77C\uD558\uAC8C \uC77C\uC5B4\uB098 \uBAA8\uC7AC\uC758 \uC6D0\uB798 \uBAA8\uC591\uC774 \uD2C0\uC5B4\uC9C0\uB294 \uD604\uC0C1\uC744 \uBB34\uC5C7\uC774\uB77C \uD558\uB294\uAC00?",
    "options": [
      "Deformation (\uBCC0\uD615)",
      "Penetration (\uC6A9\uC785)",
      "Peening (\uD53C\uB2DD)",
      "Fusion (\uC735\uD569)"
    ],
    "correctIndex": 0,
    "explanation": "\uAD6D\uBD80\uC801\uC778 \uAC00\uC5F4\uACFC \uAE09\uB7AD\uC5D0 \uC758\uD574 \uBC1C\uC0DD\uD558\uB294 \uAE08\uC18D\uC758 \uD615\uC0C1 \uD2C0\uC5B4\uC9D0\uC744 \uC6A9\uC811 \uBCC0\uD615(Deformation)\uC774\uB77C\uACE0 \uD569\uB2C8\uB2E4."
  },
  {
    "id": "s5q20",
    "set": 5,
    "num": 20,
    "difficulty": "hard",
    "category": "\uC785\uC5F4\uB7C9\uACFC \uBCC0\uD615",
    "question": "\uC6A9\uC811 \uC2DC \uBC1C\uC0DD\uD558\uB294 \uC794\uB958 \uC751\uB825(Residual stress)\uC744 \uC81C\uC5B4\uD558\uAE30 \uC704\uD55C \uC124\uBA85\uC73C\uB85C \uC798\uBABB\uB41C \uAC83\uC740?",
    "options": [
      "\uC794\uB958 \uC751\uB825\uC740 \uC8FC\uB85C \uAE08\uC18D\uC774 \uC218\uCD95\uD558\uB824\uB294 \uD798 \uB54C\uBB38\uC5D0 \uBC1C\uC0DD\uD55C\uB2E4.",
      "\uAD6C\uC18D \uC9C0\uADF8(Jig)\uB85C \uBAA8\uC7AC\uB97C \uAC15\uD558\uAC8C \uACE0\uC815\uD558\uBA74 \uC678\uBD80 \uBCC0\uD615\uC740 \uB9C9\uC744 \uC218 \uC788\uC9C0\uB9CC \uB0B4\uBD80\uC758 \uC794\uB958 \uC751\uB825\uC740 \uCEE4\uC9C4\uB2E4.",
      "Pre-heating(\uC608\uC5F4)\uC744 \uC2E4\uC2DC\uD558\uBA74 \uC794\uB958 \uC751\uB825\uC744 \uC644\uD654\uD558\uB294 \uB370 \uB3C4\uC6C0\uC774 \uB41C\uB2E4.",
      "\uC6A9\uC811 \uC785\uC5F4\uB7C9(Heat input)\uC744 \uCD5C\uB300\uD55C \uB192\uC5EC \uCC9C\uCC9C\uD788 \uC2DD\uAC8C \uB9CC\uB4E4\uBA74 \uC794\uB958 \uC751\uB825\uC774 \uC644\uC804\uD788 \uC0AC\uB77C\uC9C4\uB2E4."
    ],
    "correctIndex": 3,
    "explanation": "\uC785\uC5F4\uB7C9\uC744 \uBB34\uB9AC\uD558\uAC8C \uB192\uC774\uBA74 \uC218\uCD95\uB7C9 \uC790\uCCB4\uAC00 \uCEE4\uC9C0\uBBC0\uB85C \uC794\uB958 \uC751\uB825\uACFC \uBCC0\uD615\uC774 \uC624\uD788\uB824 \uC99D\uAC00\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4."
  },
  {
    "id": "s6q1",
    "set": 6,
    "num": 1,
    "difficulty": "easy",
    "category": "\uC6A9\uC811\uACFC \uAD00\uB828\uB41C \uC548\uC804",
    "question": "GTAW \uC791\uC5C5 \uC2DC \uBC1C\uACFC \uB2E4\uB9AC\uB85C \uB5A8\uC5B4\uC9C0\uB294 \uACE0\uC628\uC758 \uAE08\uC18D \uC870\uAC01\uC774\uB098 \uC5F4\uAE30\uB85C\uBD80\uD130 \uC791\uC5C5\uC790\uB97C \uBCF4\uD638\uD558\uAE30 \uC704\uD574 \uC548\uC804\uD654 \uC704\uC5D0 \uCD94\uAC00\uB85C \uCC29\uC6A9\uD558\uB294 \uAC00\uC8FD \uBCF4\uD638\uAD6C\uB294?",
    "options": [
      "\uC55E\uCE58\uB9C8",
      "\uAC01\uBC18 (Spats)",
      "\uD314\uD1A0\uC2DC",
      "\uBC29\uC9C4\uB9C8\uC2A4\uD06C"
    ],
    "correctIndex": 1,
    "explanation": "\uAC01\uBC18(Spats)\uC740 \uC548\uC804\uD654 \uC548\uC73C\uB85C \uB728\uAC70\uC6B4 \uAE08\uC18D \uC774\uBB3C\uC9C8\uC774 \uB4E4\uC5B4\uAC00\uB294 \uAC83\uC744 \uB9C9\uACE0 \uBC1C\uB4F1\uACFC \uBC1C\uBAA9\uC744 \uBCF4\uD638\uD558\uB294 \uD544\uC218 \uAC00\uC8FD \uBCF4\uD638\uAD6C\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s6q2",
    "set": 6,
    "num": 2,
    "difficulty": "easy",
    "category": "\uC6A9\uC811\uACFC \uAD00\uB828\uB41C \uC548\uC804",
    "question": "\uBC00\uD3D0\uB41C \uD0F1\uD06C \uB0B4\uBD80\uC5D0\uC11C GTAW \uC6A9\uC811\uC744 \uD560 \uB54C \uAC00\uC7A5 \uC8FC\uC758\uD574\uC57C \uD560 \uC548\uC804 \uC0AC\uACE0 \uC720\uD615\uC740?",
    "options": [
      "\uAC10\uC804",
      "\uCD94\uB77D",
      "\uC9C8\uC2DD (\uC0B0\uC18C \uACB0\uD54D)",
      "\uBC29\uC0AC\uC120 \uD53C\uD3ED"
    ],
    "correctIndex": 2,
    "explanation": "Ar \uAC00\uC2A4\uB294 \uACF5\uAE30\uBCF4\uB2E4 \uBB34\uAC70\uC6CC \uBC00\uD3D0 \uACF5\uAC04 \uD558\uB2E8\uC5D0 \uC313\uC774\uAC8C \uB418\uBA70, \uC774\uB294 \uC0B0\uC18C\uB97C \uBC00\uC5B4\uB0B4\uC5B4 \uC9C8\uC2DD\uC744 \uC720\uBC1C\uD558\uBBC0\uB85C \uD658\uAE30\uAC00 \uC808\uB300\uC801\uC73C\uB85C \uD544\uC694\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s6q3",
    "set": 6,
    "num": 3,
    "difficulty": "easy",
    "category": "\uC7A5\uBE44 \uBC0F \uB3C4\uAD6C",
    "question": "\uC77C\uBC18\uC801\uC778 \uC218\uB0C9\uC2DD(Water-cooled) GTAW Torch\uC758 \uCF00\uC774\uBE14\uC744 \uAD6C\uC131\uD558\uB294 \uC694\uC18C\uAC00 \uC544\uB2CC \uAC83\uC740?",
    "options": [
      "\uB0C9\uAC01\uC218 \uACF5\uAE09 \uD638\uC2A4",
      "Ar \uAC00\uC2A4 \uACF5\uAE09 \uD638\uC2A4",
      "Flux (\uD50C\uB7ED\uC2A4) \uACF5\uAE09 \uD29C\uBE0C",
      "\uC804\uC6D0(Power) \uCF00\uC774\uBE14"
    ],
    "correctIndex": 2,
    "explanation": "GTAW\uB294 Flux\uB97C \uC0AC\uC6A9\uD558\uC9C0 \uC54A\uB294 \uBD88\uD65C\uC131 \uAC00\uC2A4 \uC544\uD06C \uC6A9\uC811\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s6q4",
    "set": 6,
    "num": 4,
    "difficulty": "medium",
    "category": "\uC7A5\uBE44 \uBC0F \uB3C4\uAD6C",
    "question": "\uC6A9\uC811\uAE30 \uD328\uB110\uC758 'Crater fill (\uD06C\uB808\uC774\uD130 \uCC98\uB9AC)' \uAE30\uB2A5\uACFC \uAC00\uC7A5 \uC5F0\uAD00\uC774 \uAE4A\uC740 Torch \uC2A4\uC704\uCE58 \uC870\uC791 \uACB0\uACFC\uB294?",
    "options": [
      "\uC2A4\uC704\uCE58\uB97C \uB204\uB974\uB294 \uC21C\uAC04 Arc \uC804\uC555\uC774 \uCD5C\uB300\uB85C \uC0C1\uC2B9\uD55C\uB2E4.",
      "\uC2A4\uC704\uCE58\uB97C \uB193\uC558\uC744 \uB54C Arc\uAC00 \uC989\uC2DC \uAEBC\uC9C0\uC9C0 \uC54A\uACE0 \uC124\uC815\uB41C \uC2DC\uAC04 \uB3D9\uC548 \uC804\uB958\uAC00 \uC904\uC5B4\uB4E4\uBA70 \uC720\uC9C0\uB41C\uB2E4.",
      "\uC2A4\uC704\uCE58\uB97C \uB204\uB974\uBA74 \uAD50\uB958 \uC8FC\uD30C\uC218\uAC00 \uBCC0\uACBD\uB41C\uB2E4.",
      "\uC2A4\uC704\uCE58\uB97C \uB450 \uBC88 \uC5F0\uC18D \uB204\uB974\uBA74 \uAC00\uC2A4 \uC720\uB7C9\uC774 2\uBC30\uB85C \uC99D\uAC00\uD55C\uB2E4."
    ],
    "correctIndex": 1,
    "explanation": "Crater \uCC98\uB9AC\uB294 \uC2A4\uC704\uCE58\uB97C \uB193\uC558\uC744 \uB54C Down-slope \uAE30\uB2A5\uC774 \uC791\uB3D9\uD558\uC5EC \uC804\uB958\uAC00 \uC11C\uC11C\uD788 \uAC10\uC18C\uD558\uB3C4\uB85D \uB9CC\uB4E4\uC5B4 \uC6A9\uC735\uC9C0\uB97C \uCC44\uC6CC\uC8FC\uB294 \uAE30\uB2A5\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s6q5",
    "set": 6,
    "num": 5,
    "difficulty": "hard",
    "category": "\uC6A9\uC811\uC758 \uC885\uB958",
    "question": "\uACE0\uC0C1 \uC6A9\uC811(Solid-state welding) \uC911 \uD558\uB098\uC778 \uCD08\uC74C\uD30C \uC6A9\uC811(Ultrasonic welding)\uC758 \uC8FC\uB41C \uD2B9\uC9D5\uC73C\uB85C \uAC00\uC7A5 \uAC70\uB9AC\uAC00 \uBA3C \uAC83\uC740?",
    "options": [
      "\uACE0\uC8FC\uD30C \uC9C4\uB3D9 \uC5D0\uB108\uC9C0\uB97C \uAE30\uACC4\uC801 \uB9C8\uCC30 \uC5D0\uB108\uC9C0\uB85C \uBCC0\uD658\uD558\uC5EC \uC811\uD569\uD55C\uB2E4.",
      "\uC587\uC740 \uAE08\uC18D \uBC15\uD310\uC774\uB098 \uD50C\uB77C\uC2A4\uD2F1, \uC804\uC120 \uB4F1\uC758 \uC815\uBC00 \uC811\uD569\uC5D0 \uC8FC\uB85C \uC4F0\uC778\uB2E4.",
      "\uC870\uC120\uC18C\uC758 \uB450\uAEBC\uC6B4 \uD6C4\uD310 \uAC15\uD310 \uC6A9\uC811\uC5D0 \uAC00\uC7A5 \uB110\uB9AC \uC0AC\uC6A9\uB41C\uB2E4.",
      "\uBAA8\uC7AC\uB97C \uC735\uC810 \uC774\uC0C1\uC73C\uB85C \uC644\uC804\uD788 \uB179\uC774\uC9C0 \uC54A\uACE0 \uC811\uD569\uD55C\uB2E4."
    ],
    "correctIndex": 2,
    "explanation": "\uCD08\uC74C\uD30C \uC6A9\uC811\uC740 \uC5D0\uB108\uC9C0\uAC00 \uC791\uC544 \uB450\uAEBC\uC6B4 \uCCA0\uD310(\uD6C4\uD310) \uC6A9\uC811\uC5D0\uB294 \uBD88\uAC00\uB2A5\uD558\uBA70, \uC8FC\uB85C \uBC18\uB3C4\uCCB4 \uBC30\uC120\uC774\uB098 \uC587\uC740 \uBC15\uB9C9 \uC6A9\uC811\uC5D0 \uC0AC\uC6A9\uB429\uB2C8\uB2E4."
  },
  {
    "id": "s6q6",
    "set": 6,
    "num": 6,
    "difficulty": "easy",
    "category": "\uC544\uD06C\uC758 \uC774\uD574",
    "question": "Arc \uC6A9\uC811 \uC2DC \uC804\uC555\uACFC \uC804\uB958\uC758 \uAD00\uACC4\uC5D0\uC11C, \uC804\uB958\uC758 \uB2E8\uC704\uB294 A(Ampere)\uB97C \uC0AC\uC6A9\uD55C\uB2E4. \uC804\uC555\uC758 \uB2E8\uC704\uB294 \uBB34\uC5C7\uC778\uAC00?",
    "options": [
      "W (Watt)",
      "V (Voltage)",
      "\u03A9 (Ohm)",
      "Hz (Hertz)"
    ],
    "correctIndex": 1,
    "explanation": "\uC804\uC555\uC758 \uB2E8\uC704\uB294 \uBCFC\uD2B8(V)\uC774\uBA70, \uC774\uB294 \uC804\uAE30\uB97C \uBC00\uC5B4\uB0B4\uB294 \uC555\uB825\uC744 \uC758\uBBF8\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s6q7",
    "set": 6,
    "num": 7,
    "difficulty": "medium",
    "category": "\uC544\uD06C\uC758 \uC774\uD574",
    "question": "Arc \uC6A9\uC811\uC5D0\uC11C 'Arc blow (\uC790\uAE30 \uC3E0\uB9BC)' \uD604\uC0C1\uC774 \uBC1C\uC0DD\uD588\uC744 \uB54C \uB098\uD0C0\uB098\uB294 \uACB0\uACFC\uB85C \uAC00\uC7A5 \uC801\uC808\uD558\uC9C0 \uC54A\uC740 \uAC83\uC740?",
    "options": [
      "Spatter\uAC00 \uC2EC\uD558\uAC8C \uBC1C\uC0DD\uD55C\uB2E4.",
      "Arc\uAC00 \uD55C\uCABD\uC73C\uB85C \uD718\uC5B4\uC838 \uBD88\uC548\uC815\uD574\uC9C4\uB2E4.",
      "\uC6A9\uC785\uC774 \uBD88\uADE0\uC77C\uD558\uAC8C \uD615\uC131\uB418\uACE0 \uACB0\uD568\uC774 \uBC1C\uC0DD\uD558\uAE30 \uC27D\uB2E4.",
      "Arc\uAC00 \uB9E4\uC6B0 \uC548\uC815\uB418\uC5B4 \uC6A9\uC785\uC774 \uAE4A\uACE0 \uACE0\uB974\uAC8C \uD615\uC131\uB41C\uB2E4."
    ],
    "correctIndex": 3,
    "explanation": "Arc blow\uB294 \uC790\uAE30\uC7A5\uC5D0 \uC758\uD574 Arc\uAC00 \uD718\uCCAD\uAC70\uB9AC\uB294 \uD604\uC0C1\uC73C\uB85C, \uC6A9\uC811\uC744 \uB9E4\uC6B0 \uBC29\uD574\uD558\uACE0 \uACB0\uD568\uC744 \uC720\uBC1C\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s6q8",
    "set": 6,
    "num": 8,
    "difficulty": "easy",
    "category": "\uC6A9\uC811 \uACB0\uD568",
    "question": "\uC6A9\uC811 Bead\uC758 \uB192\uC774\uAC00 \uBAA8\uC7AC \uD45C\uBA74\uBCF4\uB2E4 \uB0AE\uAC8C \uD615\uC131\uB418\uC5B4 \uD648(Groove)\uC774 \uB2E4 \uCC44\uC6CC\uC9C0\uC9C0 \uC54A\uC740 \uACB0\uD568\uC740?",
    "options": [
      "Overlap",
      "Underfill",
      "Porosity",
      "Crack"
    ],
    "correctIndex": 1,
    "explanation": "\uC6A9\uAC00\uC7AC\uC758 \uACF5\uAE09\uC774 \uBD80\uC871\uD558\uAC70\uB098 \uC6A9\uC811 \uC18D\uB3C4\uAC00 \uB108\uBB34 \uBE60\uB97C \uB54C \uD648\uC774 \uC644\uC804\uD788 \uCC44\uC6CC\uC9C0\uC9C0 \uC54A\uC740 \uC0C1\uD0DC\uB97C Underfill\uC774\uB77C\uACE0 \uD569\uB2C8\uB2E4."
  },
  {
    "id": "s6q9",
    "set": 6,
    "num": 9,
    "difficulty": "medium",
    "category": "\uC6A9\uC811 \uACB0\uD568",
    "question": "GTAW \uC6A9\uC811\uC5D0\uC11C Bead \uD45C\uBA74\uC774 \uC2EC\uD558\uAC8C \uC0B0\uD654\uB418\uC5B4 \uD751\uD68C\uC0C9\uC73C\uB85C \uBCC0\uC0C9\uB418\uACE0 \uAC70\uCE60\uC5B4\uC9C0\uB294 \uC8FC\uB41C \uC6D0\uC778\uC740?",
    "options": [
      "Shielding gas\uC758 \uBCF4\uD638\uAC00 \uC81C\uB300\uB85C \uC774\uB8E8\uC5B4\uC9C0\uC9C0 \uC54A\uC544\uC11C",
      "\uC6A9\uC811 \uC804\uB958\uAC00 \uB108\uBB34 \uB0AE\uC544\uC11C",
      "\uC9C1\uB958 \uC5ED\uADF9\uC131(DCEP)\uC744 \uC0AC\uC6A9\uD588\uAE30 \uB54C\uBB38\uC5D0",
      "\uC804\uADF9\uBD09\uC744 \uBFB0\uC871\uD558\uAC8C \uC5F0\uB9C8\uD588\uAE30 \uB54C\uBB38\uC5D0"
    ],
    "correctIndex": 0,
    "explanation": "Ar \uAC00\uC2A4\uAC00 \uBC14\uB78C\uC5D0 \uB0A0\uC544\uAC00\uAC70\uB098 \uC720\uB7C9\uC774 \uBD80\uC871/\uACFC\uB2E4\uD558\uC5EC \uB300\uAE30 \uC911\uC758 \uC0B0\uC18C\uAC00 \uACE0\uC628\uC758 \uC1F3\uBB3C\uACFC \uBC18\uC751\uD558\uBA74 \uC2EC\uD55C \uC0B0\uD654 \uBD88\uB7C9\uC774 \uBC1C\uC0DD\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s6q10",
    "set": 6,
    "num": 10,
    "difficulty": "easy",
    "category": "\uC6A9\uC811 \uACB0\uD568",
    "question": "\uBAA8\uC7AC\uAC00 \uC644\uC804\uD788 \uB179\uC544\uB0B4\uB824 \uBC18\uB300\uD3B8\uC73C\uB85C \uAD6C\uBA4D\uC774 \uB6AB\uB9AC\uB294 \uACB0\uD568\uC740?",
    "options": [
      "Undercut",
      "Overlap",
      "Spatter",
      "Burn-through (\uC6A9\uB77D)"
    ],
    "correctIndex": 3,
    "explanation": "\uC785\uC5F4\uB7C9\uC774 \uBAA8\uC7AC \uB450\uAED8\uC5D0 \uBE44\uD574 \uB108\uBB34 \uB192\uAC70\uB098 \uC6B4\uBD09\uC774 \uB290\uB9B4 \uB54C \uC1F3\uBB3C\uC774 \uBC11\uC73C\uB85C \uC3DF\uC544\uC838 \uB0B4\uB9AC\uB294 \uACB0\uD568\uC744 Burn-through\uB77C\uACE0 \uD569\uB2C8\uB2E4."
  },
  {
    "id": "s6q11",
    "set": 6,
    "num": 11,
    "difficulty": "easy",
    "category": "\uBE44\uD30C\uAD34 \uAC80\uC0AC",
    "question": "\uC6A9\uC811\uBD80\uC758 \uD45C\uBA74\uC5D0 \uC5F4\uB824 \uC788\uB294 \uBBF8\uC138\uD55C \uADE0\uC5F4\uC744 \uCC3E\uAE30 \uC704\uD574 \uCE68\uD22C\uC561\uC758 \uBAA8\uC138\uAD00 \uD604\uC0C1\uC744 \uC774\uC6A9\uD558\uB294 \uBE44\uD30C\uAD34 \uAC80\uC0AC\uBC95\uC740?",
    "options": [
      "UT (Ultrasonic Testing)",
      "RT (Radiographic Testing)",
      "MT (Magnetic Particle Testing)",
      "PT (Penetrant Testing)"
    ],
    "correctIndex": 3,
    "explanation": "PT\uB294 \uBD89\uC740\uC0C9 \uCE68\uD22C\uC561\uC744 \uD45C\uBA74 \uACB0\uD568\uC5D0 \uC2A4\uBA70\uB4E4\uAC8C \uD55C \uD6C4 \uD558\uC580\uC0C9 \uD604\uC0C1\uC561\uC73C\uB85C \uC774\uB97C \uB044\uC9D1\uC5B4\uB0B4\uC5B4 \uC2DC\uAC01\uC801\uC73C\uB85C \uD655\uC778\uD558\uB294 \uBC29\uBC95\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s6q12",
    "set": 6,
    "num": 12,
    "difficulty": "hard",
    "category": "\uBE44\uD30C\uAD34 \uAC80\uC0AC",
    "question": "\uCD08\uC74C\uD30C \uD0D0\uC0C1 \uAC80\uC0AC(UT)\uC5D0\uC11C \uD0D0\uCD09\uC790(Probe)\uC640 \uBAA8\uC7AC \uD45C\uBA74 \uC0AC\uC774\uC758 \uACF5\uAE30\uCE35\uC744 \uC81C\uAC70\uD558\uACE0 \uCD08\uC74C\uD30C\uC758 \uC804\uB2EC\uC744 \uB3D5\uAE30 \uC704\uD574 \uBC14\uB974\uB294 \uB9E4\uC9C8\uC740?",
    "options": [
      "Developer (\uD604\uC0C1\uC561)",
      "Penetrant (\uCE68\uD22C\uC561)",
      "Couplant (\uC811\uCD09\uB9E4\uC9C8)",
      "Etchant (\uBD80\uC2DD\uC561)"
    ],
    "correctIndex": 2,
    "explanation": "\uCD08\uC74C\uD30C\uB294 \uACF5\uAE30\uB97C \uD1B5\uACFC\uD560 \uB54C \uD06C\uAC8C \uAC10\uC1E0\uD558\uBBC0\uB85C, \uD0D0\uCD09\uC790\uC640 \uBAA8\uC7AC \uC0AC\uC774\uC5D0 \uAE00\uB9AC\uC138\uB9B0\uC774\uB098 \uC624\uC77C \uAC19\uC740 \uC811\uCD09\uB9E4\uC9C8(Couplant)\uC744 \uBC1C\uB77C\uC57C \uD569\uB2C8\uB2E4."
  },
  {
    "id": "s6q13",
    "set": 6,
    "num": 13,
    "difficulty": "easy",
    "category": "\uC7AC\uB8CC \uBC0F \uC131\uBD84",
    "question": "\uC54C\uB8E8\uBBF8\uB284(Al) \uD45C\uBA74\uC5D0 \uC790\uC5F0\uC801\uC73C\uB85C \uD615\uC131\uB418\uBA70, \uC6A9\uC811\uC744 \uBC29\uD574\uD558\uB294 \uC0B0\uD654\uC54C\uB8E8\uBBF8\uB284 \uD53C\uB9C9\uC758 \uC6A9\uC735\uC810\uC740 \uB300\uB7B5 \uBA87 \uB3C4(\u2103)\uC778\uAC00?",
    "options": [
      "\uC57D 660\u2103",
      "\uC57D 1530\u2103",
      "\uC57D 2050\u2103",
      "\uC57D 3000\u2103"
    ],
    "correctIndex": 2,
    "explanation": "\uC21C\uC218 \uC54C\uB8E8\uBBF8\uB284\uC758 \uC6A9\uC735\uC810\uC740 \uC57D 660\u2103\uC774\uC9C0\uB9CC, \uD45C\uBA74\uC758 \uC0B0\uD654\uB9C9\uC740 \uC57D 2050\u2103\uB85C \uB9E4\uC6B0 \uB192\uC544 \uAD50\uB958 \uCCAD\uC815 \uC791\uC6A9\uC73C\uB85C \uC774\uB97C \uD30C\uAD34\uD574\uC57C \uD569\uB2C8\uB2E4."
  },
  {
    "id": "s6q14",
    "set": 6,
    "num": 14,
    "difficulty": "medium",
    "category": "\uC7AC\uB8CC \uBC0F \uC131\uBD84",
    "question": "\uD0C4\uC18C\uAC15(Carbon steel) \uC6A9\uC811 \uC2DC \uBAA8\uC7AC\uC758 \uB450\uAED8\uAC00 \uB450\uAECD\uAC70\uB098 \uD0C4\uC18C \uB2F9\uB7C9(CE)\uC774 \uB192\uC744 \uB54C \uC800\uC628 \uADE0\uC5F4(Cold crack)\uC744 \uC608\uBC29\uD558\uAE30 \uC704\uD55C \uAC00\uC7A5 \uD6A8\uACFC\uC801\uC778 \uBC29\uBC95\uC740?",
    "options": [
      "Pre-heating (\uC608\uC5F4)\uC744 \uC2E4\uC2DC\uD55C\uB2E4.",
      "\uC6A9\uC811 \uC18D\uB3C4\uB97C \uCD5C\uB300\uD55C \uBE60\uB974\uAC8C \uD55C\uB2E4.",
      "\uB0C9\uAC01\uC218\uB97C \uBD80\uC5B4 \uAE09\uB7AD\uC2DC\uD0A8\uB2E4.",
      "\uAC00\uC2A4 \uC720\uB7C9\uC744 \uCD5C\uC18C\uB85C \uC904\uC778\uB2E4."
    ],
    "correctIndex": 0,
    "explanation": "\uB450\uAEBC\uC6B4 \uD0C4\uC18C\uAC15\uC740 \uC6A9\uC811 \uD6C4 \uBE68\uB9AC \uC2DD\uC5B4 \uB2E8\uB2E8\uD574\uC9C0\uBA70 \uAE68\uC9C0\uAE30 \uC26C\uC6B0\uBBC0\uB85C(\uC218\uC18C \uC9C0\uC5F0 \uADE0\uC5F4), \uC608\uC5F4\uC744 \uD1B5\uD574 \uB0C9\uAC01 \uC18D\uB3C4\uB97C \uB2A6\uCDB0\uC8FC\uC5B4\uC57C \uD569\uB2C8\uB2E4."
  },
  {
    "id": "s6q15",
    "set": 6,
    "num": 15,
    "difficulty": "easy",
    "category": "\uC6A9\uC811 \uADF9\uC131",
    "question": "\uC9C1\uB958 \uC815\uADF9\uC131(DCEN)\uC5D0\uC11C \uC804\uC790\uB294 \uC5B4\uB290 \uBC29\uD5A5\uC73C\uB85C \uC774\uB3D9\uD558\uB294\uAC00?",
    "options": [
      "Tungsten \uC804\uADF9(-)\uC5D0\uC11C \uBAA8\uC7AC(+)\uB85C",
      "\uBAA8\uC7AC(-)\uC5D0\uC11C Tungsten \uC804\uADF9(+)\uC73C\uB85C",
      "\uBAA8\uC7AC(+)\uC5D0\uC11C Earth(-)\uB85C",
      "\uC774\uB3D9\uD558\uC9C0 \uC54A\uACE0 \uBA38\uBB34\uB978\uB2E4."
    ],
    "correctIndex": 0,
    "explanation": "\uC804\uC790\uB294 \uD56D\uC0C1 (-)\uADF9\uC5D0\uC11C (+)\uADF9\uC73C\uB85C \uC774\uB3D9\uD558\uBA70, DCEN\uC5D0\uC11C\uB294 \uBAA8\uC7AC\uAC00 (+)\uC774\uBBC0\uB85C \uC804\uC790\uAC00 \uBAA8\uC7AC\uC5D0 \uCDA9\uB3CC\uD558\uC5EC \uAE4A\uC740 \uC6A9\uC785\uC744 \uB9CC\uB4ED\uB2C8\uB2E4."
  },
  {
    "id": "s6q16",
    "set": 6,
    "num": 16,
    "difficulty": "hard",
    "category": "\uC6A9\uC811 \uADF9\uC131",
    "question": "\uC54C\uB8E8\uBBF8\uB284 GTAW \uC6A9\uC811 \uC2DC \uAD50\uB958(AC) \uC804\uC6D0\uC758 Balance(\uCCAD\uC815 \uD3ED) \uC124\uC815\uC5D0\uC11C EP(\uC5ED\uADF9\uC131) \uBE44\uC728\uC744 \uACFC\uB3C4\uD558\uAC8C \uB192\uAC8C \uC124\uC815\uD588\uC744 \uB54C \uBC1C\uC0DD\uD558\uB294 \uD604\uC0C1\uC73C\uB85C \uC62C\uBC14\uB978 \uAC83\uC740?",
    "options": [
      "\uC6A9\uC785\uC774 \uB9E4\uC6B0 \uAE4A\uC5B4\uC9C4\uB2E4.",
      "Tungsten \uC804\uADF9\uC774 \uACFC\uC5F4\uB418\uC5B4 \uB05D\uC774 \uB465\uAE00\uAC8C \uB179\uC544\uB0B4\uB9AC\uAC70\uB098 \uBAA8\uC7AC\uB85C \uB5A8\uC5B4\uC9C8 \uC218 \uC788\uB2E4.",
      "\uC0B0\uD654\uB9C9\uC774 \uC804\uD600 \uD30C\uAD34\uB418\uC9C0 \uC54A\uB294\uB2E4.",
      "Arc\uAC00 \uBC1C\uC0DD\uD558\uC9C0 \uC54A\uB294\uB2E4."
    ],
    "correctIndex": 1,
    "explanation": "EP(\uC5ED\uADF9\uC131) \uBE44\uC728\uC774 \uB192\uC544\uC9C0\uBA74 \uCCAD\uC815 \uC791\uC6A9\uC740 \uAC15\uD574\uC9C0\uC9C0\uB9CC, \uC804\uADF9\uBD09(+)\uC5D0 \uC5F4\uC774 \uACFC\uB3C4\uD558\uAC8C \uC9D1\uC911\uB418\uC5B4 \uD145\uC2A4\uD150\uC774 \uB179\uC544\uB0B4\uB9B4 \uC704\uD5D8\uC774 \uD07D\uB2C8\uB2E4."
  },
  {
    "id": "s6q17",
    "set": 6,
    "num": 17,
    "difficulty": "easy",
    "category": "\uC804\uC6D0 \uD2B9\uC131",
    "question": "\uC218\uB3D9 GTAW \uC6A9\uC811\uAE30\uC758 \uC678\uBD80 \uD2B9\uC131\uC73C\uB85C, Arc length\uAC00 \uC57D\uAC04 \uBCC0\uD574\uB3C4 \uC6A9\uC811 \uC804\uB958\uB294 \uAC70\uC758 \uC77C\uC815\uD558\uAC8C \uC720\uC9C0\uB418\uB294 \uD2B9\uC131\uC740?",
    "options": [
      "\uC815\uC804\uC555 \uD2B9\uC131",
      "\uC815\uC804\uB958 \uD2B9\uC131 (\uC218\uD558 \uD2B9\uC131)",
      "\uC0C1\uC2B9 \uD2B9\uC131",
      "\uBCF5\uD569 \uD2B9\uC131"
    ],
    "correctIndex": 1,
    "explanation": "\uC791\uC5C5\uC790\uC758 \uC190\uB5A8\uB9BC\uC5D0\uB3C4 \uC804\uB958\uAC00 \uC77C\uC815\uD558\uAC8C \uC720\uC9C0\uB418\uC5B4 \uC6A9\uC785\uC744 \uACE0\uB974\uAC8C \uD558\uB294 \uC218\uB3D9 \uC6A9\uC811\uC758 \uD544\uC218\uC801\uC778 \uC804\uC6D0 \uD2B9\uC131\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s6q18",
    "set": 6,
    "num": 18,
    "difficulty": "easy",
    "category": "\uC785\uC5F4\uB7C9\uACFC \uBCC0\uD615",
    "question": "\uC6A9\uC811 \uC785\uC5F4\uB7C9 \uACF5\uC2DD(H=60EI/V)\uC5D0\uC11C H\uC758 \uB2E8\uC704\uB85C \uC8FC\uB85C \uC0AC\uC6A9\uB418\uB294 \uAC83\uC740?",
    "options": [
      "Joule/cm (J/cm)",
      "Newton (N)",
      "Pascal (Pa)",
      "Watt (W)"
    ],
    "correctIndex": 0,
    "explanation": "\uC785\uC5F4\uB7C9\uC740 \uC6A9\uC811 \uAE38\uC774 1cm\uB2F9 \uAC00\uD574\uC9C0\uB294 \uC5F4\uC5D0\uB108\uC9C0(Joule)\uB97C \uB098\uD0C0\uB0B4\uBBC0\uB85C J/cm \uB2E8\uC704\uB97C \uC0AC\uC6A9\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s6q19",
    "set": 6,
    "num": 19,
    "difficulty": "medium",
    "category": "\uC785\uC5F4\uB7C9\uACFC \uBCC0\uD615",
    "question": "\uC6A9\uC811 \uBCC0\uD615\uC744 \uCD5C\uC18C\uD654\uD558\uAE30 \uC704\uD574 \uC0AC\uC6A9\uD558\uB294 \uC6B4\uBD09 \uC21C\uC11C \uC911, \uC804\uCCB4 \uC6A9\uC811 \uAE38\uC774\uB97C \uC9E7\uC740 \uAD6C\uAC04\uC73C\uB85C \uB098\uB204\uC5B4 \uC6A9\uC811 \uC9C4\uD589 \uBC29\uD5A5\uACFC \uAC1C\uBCC4 \uBE44\uB4DC\uC758 \uC9C4\uD589 \uBC29\uD5A5\uC744 \uBC18\uB300\uB85C \uD558\uC5EC \uB098\uAC00\uB294 \uBC29\uBC95\uC740?",
    "options": [
      "\uC5F0\uC18D \uC6A9\uC811\uBC95",
      "Back-step\uBC95 (\uD6C4\uD1F4\uBC95)",
      "\uB300\uCE6D\uBC95",
      "\uBE44\uB4DC \uC313\uAE30"
    ],
    "correctIndex": 1,
    "explanation": "Back-step\uBC95\uC740 \uC5F4\uC744 \uBD84\uC0B0\uC2DC\uD0A4\uACE0 \uC794\uB958 \uC751\uB825\uC744 \uC0C1\uC1C4\uD558\uC5EC \uC587\uACE0 \uAE34 \uBAA8\uC7AC\uC758 \uBCC0\uD615\uC744 \uB9C9\uB294 \uB370 \uB9E4\uC6B0 \uD6A8\uACFC\uC801\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s6q20",
    "set": 6,
    "num": 20,
    "difficulty": "hard",
    "category": "\uC785\uC5F4\uB7C9\uACFC \uBCC0\uD615",
    "question": "\uC794\uB958 \uC751\uB825(Residual stress)\uC744 \uC81C\uAC70\uD558\uAE30 \uC704\uD55C \uC5F4\uCC98\uB9AC \uBC29\uBC95\uC778 SR(Stress Relief) \uCC98\uB9AC\uC758 \uC628\uB3C4\uB85C \uD0C4\uC18C\uAC15\uC7AC\uC5D0 \uAC00\uC7A5 \uC801\uD569\uD55C \uC628\uB3C4\uB294?",
    "options": [
      "100~200\u2103",
      "300~400\u2103",
      "600~650\u2103 \uBD80\uADFC (\uBCC0\uD0DC\uC810 \uC774\uD558)",
      "1000\u2103 \uC774\uC0C1"
    ],
    "correctIndex": 2,
    "explanation": "\uC751\uB825 \uC81C\uAC70 \uD480\uB9BC(SR)\uC740 \uAE08\uC18D\uC758 \uC870\uC9C1\uC774 \uBCC0\uD558\uC9C0 \uC54A\uB294 \uC7AC\uACB0\uC815 \uC628\uB3C4(\uBCC0\uD0DC\uC810) \uC774\uD558\uC778 600~650\uB3C4 \uBD80\uADFC\uC5D0\uC11C \uAC00\uC5F4 \uD6C4 \uC11C\uC11C\uD788 \uC2DD\uD788\uB294 \uACFC\uC815\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s7q1",
    "set": 7,
    "num": 1,
    "difficulty": "easy",
    "category": "\uC6A9\uC811\uACFC \uAD00\uB828\uB41C \uC548\uC804",
    "question": "GTAW \uC6A9\uC811 \uC2DC \uBC1C\uC0DD\uD558\uB294 \uC790\uC678\uC120(UV)\uC73C\uB85C\uBD80\uD130 \uD53C\uBD80\uB97C \uBCF4\uD638\uD558\uAE30 \uC704\uD574 \uAC00\uC7A5 \uC62C\uBC14\uB978 \uBCF5\uC7A5\uC740?",
    "options": [
      "\uD1B5\uD48D\uC774 \uC798\uB418\uB294 \uBC18\uD314 \uC791\uC5C5\uBCF5",
      "\uC790\uC678\uC120 \uCC28\uB2E8 \uB85C\uC158\uB9CC \uBC14\uB978 \uB9E8\uC0B4",
      "\uC18C\uB9E4\uAC00 \uAE38\uACE0 \uB450\uAEBC\uC6B4 \uBA74\uC774\uB098 \uAC00\uC8FD \uC7AC\uC9C8\uC758 \uC791\uC5C5\uBCF5",
      "\uC587\uC740 \uB098\uC77C\uB860 \uC810\uD37C"
    ],
    "correctIndex": 2,
    "explanation": "\uC544\uD06C\uC5D0\uC11C \uBC1C\uC0DD\uD558\uB294 \uAC15\uB825\uD55C \uC790\uC678\uC120\uC740 \uB9E8\uC0B4\uC5D0 \uB178\uCD9C \uC2DC \uD654\uC0C1(\uC544\uD06C \uD654\uC0C1)\uC744 \uC720\uBC1C\uD558\uBBC0\uB85C, \uBC18\uB4DC\uC2DC \uAE34 \uC18C\uB9E4\uC758 \uB09C\uC5F0\uC131 \uC791\uC5C5\uBCF5\uC774\uB098 \uAC00\uC8FD \uBCF4\uD638\uAD6C\uB97C \uCC29\uC6A9\uD574\uC57C \uD569\uB2C8\uB2E4."
  },
  {
    "id": "s7q2",
    "set": 7,
    "num": 2,
    "difficulty": "medium",
    "category": "\uC6A9\uC811\uACFC \uAD00\uB828\uB41C \uC548\uC804",
    "question": "\uACE0\uC555 \uAC00\uC2A4 Cylinder(\uC6A9\uAE30)\uB97C \uC6B4\uBC18\uD558\uAC70\uB098 \uBCF4\uAD00\uD560 \uB54C \uBC18\uB4DC\uC2DC \uC9C0\uCF1C\uC57C \uD560 \uC548\uC804 \uC218\uCE59\uC73C\uB85C \uAC00\uC7A5 \uC62C\uBC14\uB978 \uAC83\uC740?",
    "options": [
      "\uBC14\uB2E5\uC5D0 \uB215\uD600\uC11C \uAD74\uB9AC\uBA70 \uC774\uB3D9\uD55C\uB2E4.",
      "\uC0AC\uC6A9\uD560 \uB54C\uB97C \uC81C\uC678\uD558\uACE0\uB294 \uD56D\uC0C1 \uBCF4\uD638 \uCEA1(Cap)\uC744 \uC50C\uC6CC\uB454\uB2E4.",
      "\uACA8\uC6B8\uCCA0\uC5D0\uB294 \uAC00\uC2A4\uAC00 \uC798 \uB098\uC624\uB3C4\uB85D \uC6A9\uAE30 \uC8FC\uBCC0\uC5D0 \uBD88\uC744 \uD53C\uC6CC \uAC00\uC5F4\uD55C\uB2E4.",
      "\uAC00\uC2A4\uAC00 \uC0C8\uB294\uC9C0 \uD655\uC778\uD558\uAE30 \uC704\uD574 \uB77C\uC774\uD130 \uBD88\uAF43\uC744 \uAC00\uAE4C\uC774 \uB300\uBCF8\uB2E4."
    ],
    "correctIndex": 1,
    "explanation": "\uACE0\uC555 \uAC00\uC2A4 \uC6A9\uAE30\uC758 \uBC38\uBE0C\uAC00 \uD30C\uC190\uB418\uBA74 \uB85C\uCF13\uCC98\uB7FC \uB0A0\uC544\uAC08 \uD3ED\uBC1C \uC704\uD5D8\uC774 \uC788\uC73C\uBBC0\uB85C, \uC774\uB3D9 \uBC0F \uBCF4\uAD00 \uC2DC \uBC18\uB4DC\uC2DC \uBCF4\uD638 \uCEA1\uC744 \uC50C\uC6CC\uC57C \uD569\uB2C8\uB2E4."
  },
  {
    "id": "s7q3",
    "set": 7,
    "num": 3,
    "difficulty": "easy",
    "category": "\uC7A5\uBE44 \uBC0F \uB3C4\uAD6C",
    "question": "\uACE0\uC555 \uAC00\uC2A4 Cylinder\uC5D0 \uBD80\uCC29\uD558\uC5EC, \uC6A9\uAE30 \uB0B4\uBD80\uC758 \uB192\uC740 \uC555\uB825\uC744 \uC791\uC5C5\uC5D0 \uD544\uC694\uD55C \uB0AE\uC740 \uC555\uB825\uC73C\uB85C \uC77C\uC815\uD558\uAC8C \uB0AE\uCDB0\uC8FC\uB294 \uC7A5\uCE58\uB294?",
    "options": [
      "Flow meter (\uC720\uB7C9\uACC4)",
      "Regulator (\uC555\uB825 \uC870\uC815\uAE30)",
      "Gas lens",
      "Solenoid valve"
    ],
    "correctIndex": 1,
    "explanation": "Regulator(\uC555\uB825 \uC870\uC815\uAE30)\uB294 \uC2E4\uB9B0\uB354 \uC548\uC758 \uACE0\uC555\uC744 \uC6A9\uC811\uC5D0 \uC801\uD569\uD55C \uC791\uC5C5 \uC555\uB825\uC73C\uB85C \uAC10\uC555\uC2DC\uCF1C \uC8FC\uB294 \uD544\uC218 \uC7A5\uBE44\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s7q4",
    "set": 7,
    "num": 4,
    "difficulty": "hard",
    "category": "\uC7A5\uBE44 \uBC0F \uB3C4\uAD6C",
    "question": "GTAW \uC6A9\uC811\uAE30\uC5D0\uC11C Arc \uAE30\uB3D9\uC744 \uC704\uD574 \uC0AC\uC6A9\uD558\uB294 High Frequency(\uACE0\uC8FC\uD30C)\uAC00 \uC8FC\uBCC0\uC758 CNC \uC7A5\uBE44\uB098 \uC804\uC790\uAE30\uAE30\uC5D0 \uC624\uC791\uB3D9\uC744 \uC77C\uC73C\uD0A4\uB294 \uAC83\uC744 \uBC29\uC9C0\uD558\uAE30 \uC704\uD55C \uAC00\uC7A5 \uD655\uC2E4\uD55C \uC870\uCE58\uB294?",
    "options": [
      "\uC6A9\uC811\uAE30 \uC678\uD568\uC744 \uADDC\uC815\uC5D0 \uB9DE\uAC8C \uD655\uC2E4\uD788 \uC811\uC9C0(Earth)\uD55C\uB2E4.",
      "\uC6A9\uC811 \uC804\uB958\uB97C \uB0AE\uCD98\uB2E4.",
      "Gas \uC720\uB7C9\uC744 \uB192\uC5EC \uC804\uD30C\uB97C \uCC28\uB2E8\uD55C\uB2E4.",
      "Torch \uCF00\uC774\uBE14\uC744 \uB465\uAE00\uAC8C \uB9D0\uC544\uC11C \uC0AC\uC6A9\uD55C\uB2E4."
    ],
    "correctIndex": 0,
    "explanation": "\uACE0\uC8FC\uD30C \uC804\uB958\uB294 \uC8FC\uBCC0 \uC804\uC790\uAE30\uAE30\uC5D0 \uB178\uC774\uC988\uB97C \uBC1C\uC0DD\uC2DC\uCF1C \uC2EC\uAC01\uD55C \uC624\uC791\uB3D9\uC744 \uC720\uBC1C\uD560 \uC218 \uC788\uC73C\uBBC0\uB85C, \uD655\uC2E4\uD55C \uC811\uC9C0(Earth)\uB97C \uD1B5\uD574 \uACE0\uC8FC\uD30C \uB178\uC774\uC988\uB97C \uB545\uC73C\uB85C \uD758\uB824\uBCF4\uB0B4\uC57C \uD569\uB2C8\uB2E4."
  },
  {
    "id": "s7q5",
    "set": 7,
    "num": 5,
    "difficulty": "easy",
    "category": "\uC6A9\uC811\uC758 \uC885\uB958",
    "question": "\uC5F0\uC18D\uC73C\uB85C \uC1A1\uAE09\uB418\uB294 \uC640\uC774\uC5B4 \uD615\uD0DC\uC758 \uC18C\uBAA8\uC131 \uC804\uADF9\uC744 \uC0AC\uC6A9\uD558\uBA70, \uC8FC\uB85C CO2\uB098 Ar \uD63C\uD569 \uAC00\uC2A4\uB97C \uBCF4\uD638\uAC00\uC2A4\uB85C \uC0AC\uC6A9\uD558\uB294 \uBC18\uC790\uB3D9 \uC6A9\uC811\uBC95\uC740?",
    "options": [
      "GTAW",
      "SMAW",
      "GMAW",
      "SAW"
    ],
    "correctIndex": 2,
    "explanation": "GMAW(MIG/MAG)\uB294 \uB9B4(Reel)\uC5D0 \uAC10\uAE34 \uC640\uC774\uC5B4\uAC00 \uC5F0\uC18D\uC73C\uB85C \uACF5\uAE09\uB418\uBA70 \uB179\uB294 \uB300\uD45C\uC801\uC778 \uBC18\uC790\uB3D9 \uC6A9\uC811\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s7q6",
    "set": 7,
    "num": 6,
    "difficulty": "medium",
    "category": "\uC6A9\uC811\uC758 \uC885\uB958",
    "question": "\uC54C\uB8E8\uBBF8\uB284 \uBD84\uB9D0\uACFC \uC0B0\uD654\uCCA0 \uBD84\uB9D0\uC744 \uD63C\uD569\uD558\uC5EC \uC810\uD654\uC2DC\uCF30\uC744 \uB54C \uBC1C\uC0DD\uD558\uB294 \uAC15\uB825\uD55C \uD654\uD559 \uBC18\uC751\uC5F4\uC744 \uC774\uC6A9\uD558\uC5EC \uB808\uC77C(Rail) \uB4F1\uC744 \uC811\uD569\uD558\uB294 \uC6A9\uC811\uBC95\uC740?",
    "options": [
      "Thermit welding (\uD14C\uB974\uBC0B \uC6A9\uC811)",
      "Laser welding (\uB808\uC774\uC800 \uC6A9\uC811)",
      "Plasma welding (\uD50C\uB77C\uC988\uB9C8 \uC6A9\uC811)",
      "Stud welding (\uC2A4\uD130\uB4DC \uC6A9\uC811)"
    ],
    "correctIndex": 0,
    "explanation": "\uD14C\uB974\uBC0B \uC6A9\uC811\uC740 \uC678\uBD80 \uC804\uC6D0 \uC5C6\uC774 \uAE08\uC18D \uC0B0\uD654\uBB3C\uACFC \uC54C\uB8E8\uBBF8\uB284\uC758 \uD654\uD559\uC801 \uD658\uC6D0 \uBC18\uC751\uC5F4\uC744 \uC774\uC6A9\uD558\uB294 \uD2B9\uC218 \uC6A9\uC811\uBC95\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s7q7",
    "set": 7,
    "num": 7,
    "difficulty": "easy",
    "category": "\uC544\uD06C\uC758 \uC774\uD574",
    "question": "Arc \uC6A9\uC811 \uC2DC \uC804\uC555\uACFC Arc length(\uAE38\uC774)\uC758 \uC0C1\uAD00\uAD00\uACC4\uB85C \uC62C\uBC14\uB978 \uAC83\uC740?",
    "options": [
      "Arc length\uAC00 \uAE38\uC5B4\uC9C0\uBA74 \uC804\uC555\uC740 \uB0AE\uC544\uC9C4\uB2E4.",
      "Arc length\uAC00 \uAE38\uC5B4\uC9C0\uBA74 \uC804\uC555\uC740 \uB192\uC544\uC9C4\uB2E4.",
      "Arc length\uC640 \uC804\uC555\uC740 \uC544\uBB34\uB7F0 \uAD00\uACC4\uAC00 \uC5C6\uB2E4.",
      "Arc length\uAC00 \uC9E7\uC544\uC9C0\uBA74 \uC804\uC555\uC740 \uCD5C\uACE0\uC870\uC5D0 \uB2EC\uD55C\uB2E4."
    ],
    "correctIndex": 1,
    "explanation": "Arc \uAE38\uC774\uAC00 \uAE38\uC5B4\uC9C8\uC218\uB85D \uACF5\uAE30 \uCE35\uC758 \uC800\uD56D\uC774 \uCEE4\uC9C0\uAE30 \uB54C\uBB38\uC5D0, \uC774\uB97C \uADF9\uBCF5\uD558\uAE30 \uC704\uD574 \uC804\uC555\uC774 \uBE44\uB840\uD558\uC5EC \uB192\uC544\uC9D1\uB2C8\uB2E4."
  },
  {
    "id": "s7q8",
    "set": 7,
    "num": 8,
    "difficulty": "medium",
    "category": "\uC544\uD06C\uC758 \uC774\uD574",
    "question": "\uC9C1\uB958(DC) \uC6A9\uC811 \uC2DC \uC790\uAE30\uC7A5\uC758 \uBD88\uADE0\uD615\uC73C\uB85C \uC778\uD574 Arc\uAC00 \uD55C\uCABD\uC73C\uB85C \uC3E0\uB9AC\uB294 Arc blow \uD604\uC0C1\uC744 \uBC29\uC9C0\uD558\uAE30 \uC704\uD55C \uB300\uCC45\uC73C\uB85C \uD2C0\uB9B0 \uAC83\uC740?",
    "options": [
      "\uAD50\uB958(AC) \uC6A9\uC811\uAE30\uB85C \uBCC0\uACBD\uD558\uC5EC \uC6A9\uC811\uD55C\uB2E4.",
      "\uC811\uC9C0(Earth) \uC704\uCE58\uB97C \uC6A9\uC811\uBD80\uC5D0\uC11C \uBA40\uB9AC \uB454\uB2E4.",
      "\uC9E7\uC740 Arc length\uB97C \uC720\uC9C0\uD55C\uB2E4.",
      "\uC6A9\uC811\uBD80\uC758 \uC2DC\uC791\uACFC \uB05D\uC5D0 End tab\uC744 \uBD80\uCC29\uD55C\uB2E4."
    ],
    "correctIndex": 1,
    "explanation": "\uC811\uC9C0 \uC704\uCE58\uAC00 \uBA40\uAC70\uB098 \uD55C\uCABD\uC73C\uB85C \uCE58\uC6B0\uCE58\uBA74 \uC790\uAE30\uC7A5\uC774 \uD3B8\uD615\uB418\uC5B4 Arc blow\uAC00 \uC2EC\uD574\uC9C0\uBBC0\uB85C, \uC811\uC9C0\uB97C \uAC00\uAE5D\uAC8C \uD558\uAC70\uB098 \uC591\uCABD\uC73C\uB85C \uBD84\uC0B0\uC2DC\uCF1C\uC57C \uD569\uB2C8\uB2E4."
  },
  {
    "id": "s7q9",
    "set": 7,
    "num": 9,
    "difficulty": "easy",
    "category": "\uC6A9\uC811 \uACB0\uD568",
    "question": "\uC6A9\uC811\uBD80 \uB0B4\uBD80\uC5D0 \uC2AC\uB798\uADF8(Slag)\uAC00 \uB0A8\uC544 \uC11E\uC774\uB294 Slag inclusion(\uC2AC\uB798\uADF8 \uD63C\uC785) \uACB0\uD568\uC774 GTAW \uACF5\uC815\uC5D0\uC11C \uAC70\uC758 \uBC1C\uC0DD\uD558\uC9C0 \uC54A\uB294 \uC774\uC720\uB294?",
    "options": [
      "\uC6A9\uC811 \uC628\uB3C4\uAC00 SMAW\uBCF4\uB2E4 \uD6E8\uC52C \uB192\uAE30 \uB54C\uBB38\uC5D0",
      "\uC6A9\uC811 \uC18D\uB3C4\uAC00 \uB9E4\uC6B0 \uBE60\uB974\uAE30 \uB54C\uBB38\uC5D0",
      "Flux(\uC6A9\uC81C)\uB97C \uC804\uD600 \uC0AC\uC6A9\uD558\uC9C0 \uC54A\uB294 \uACF5\uC815\uC774\uAE30 \uB54C\uBB38\uC5D0",
      "Ar \uAC00\uC2A4\uAC00 \uC2AC\uB798\uADF8\uB97C \uBC16\uC73C\uB85C \uB0A0\uB824 \uBCF4\uB0B4\uAE30 \uB54C\uBB38\uC5D0"
    ],
    "correctIndex": 2,
    "explanation": "GTAW\uB294 \uD53C\uBCF5\uC81C(Flux)\uAC00 \uC5C6\uB294 \uC329 \uD145\uC2A4\uD150\uACFC \uC21C\uC218 \uAC00\uC2A4\uB9CC\uC744 \uC0AC\uC6A9\uD558\uBBC0\uB85C, \uC6A9\uC735\uC9C0\uC5D0 \uC2AC\uB798\uADF8 \uC790\uCCB4\uAC00 \uC0DD\uC131\uB418\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4."
  },
  {
    "id": "s7q10",
    "set": 7,
    "num": 10,
    "difficulty": "hard",
    "category": "\uC6A9\uC811 \uACB0\uD568",
    "question": "\uBAA8\uC7AC\uC758 \uAC1C\uC120\uBA74(Groove face)\uC774\uB098 \uC774\uC804 \uBE44\uB4DC\uC640 \uC1F3\uBB3C\uC774 \uC644\uC804\uD788 \uACB0\uD569\uD558\uC9C0 \uBABB\uD558\uACE0 \uB5A8\uC5B4\uC838 \uC788\uB294 \uC0C1\uD0DC\uB97C Incomplete fusion(\uC735\uD569 \uBD88\uB7C9)\uC774\uB77C \uD55C\uB2E4\uBA74, \uBAA8\uC7AC\uC758 \uC774\uBA74(Root)\uAE4C\uC9C0 \uC1F3\uBB3C\uC774 \uB2FF\uC9C0 \uC54A\uC544 \uAC1C\uC120\uD648\uC758 \uBC14\uB2E5\uC774 \uCC44\uC6CC\uC9C0\uC9C0 \uC54A\uC740 \uACB0\uD568\uC740 \uBB34\uC5C7\uC778\uAC00?",
    "options": [
      "Undercut",
      "Incomplete penetration (\uC6A9\uC785 \uBD88\uB7C9)",
      "Overlap",
      "Crater pipe"
    ],
    "correctIndex": 1,
    "explanation": "\uC735\uD569 \uBD88\uB7C9\uC740 \uC606\uBA74(\uCE21\uBCBD)\uC774\uB098 \uCE35\uAC04\uC5D0 \uC1F3\uBB3C\uC774 \uBD99\uC9C0 \uC54A\uC740 \uAC83\uC774\uACE0, \uC6A9\uC785 \uBD88\uB7C9\uC740 \uC5F4\uC774 \uBC14\uB2E5(Root)\uAE4C\uC9C0 \uB3C4\uB2EC\uD558\uC9C0 \uBABB\uD574 \uC548 \uB179\uC740 \uC0C1\uD0DC\uB97C \uB9D0\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s7q11",
    "set": 7,
    "num": 11,
    "difficulty": "easy",
    "category": "\uBE44\uD30C\uAD34 \uAC80\uC0AC",
    "question": "\uCCA0\uAC15 \uBAA8\uC7AC\uC5D0 \uAC15\uD55C \uC790\uC11D(\uC790\uC7A5)\uC744 \uAC78\uC5B4\uC900 \uD6C4 \uC1F3\uAC00\uB8E8(\uC790\uBD84)\uB97C \uBFCC\uB824, \uACB0\uD568 \uBD80\uC704\uC5D0\uC11C \uC0C8\uC5B4 \uB098\uC624\uB294 \uC790\uAE30\uB825\uC120\uC5D0 \uC1F3\uAC00\uB8E8\uAC00 \uBB49\uCE58\uB294 \uD604\uC0C1\uC744 \uBCF4\uACE0 \uD45C\uBA74 \uACB0\uD568\uC744 \uCC3E\uB294 \uAC80\uC0AC\uBC95\uC740?",
    "options": [
      "UT",
      "RT",
      "MT (Magnetic Particle Testing)",
      "PT"
    ],
    "correctIndex": 2,
    "explanation": "\uC790\uC131\uC744 \uB760\uB294 \uCCA0\uAC15 \uC7AC\uB8CC\uC758 \uD45C\uBA74\uC774\uB098 \uD45C\uBA74 \uBC14\uB85C \uC544\uB798 \uACB0\uD568\uC744 \uCC3E\uB294 \uC790\uBD84 \uD0D0\uC0C1 \uAC80\uC0AC\uC5D0 \uB300\uD55C \uC124\uBA85\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s7q12",
    "set": 7,
    "num": 12,
    "difficulty": "medium",
    "category": "\uBE44\uD30C\uAD34 \uAC80\uC0AC",
    "question": "\uB450\uAED8\uAC00 50mm \uC774\uC0C1\uC778 \uB9E4\uC6B0 \uB450\uAEBC\uC6B4 T-Joint(\uD544\uB9BF \uC6A9\uC811\uBD80)\uC758 \uB0B4\uBD80 \uC911\uC2EC\uC5D0 \uC788\uB294 \uBBF8\uC138\uD55C \uADE0\uC5F4\uC744 \uCC3E\uACE0\uC790 \uD560 \uB54C \uAC00\uC7A5 \uC801\uD569\uD558\uACE0 \uC2E0\uB8B0\uC131 \uB192\uC740 \uBE44\uD30C\uAD34 \uAC80\uC0AC\uBC95\uC740?",
    "options": [
      "UT (\uCD08\uC74C\uD30C \uD0D0\uC0C1 \uAC80\uC0AC)",
      "RT (\uBC29\uC0AC\uC120 \uD22C\uACFC \uAC80\uC0AC)",
      "PT (\uCE68\uD22C \uD0D0\uC0C1 \uAC80\uC0AC)",
      "VT (\uC721\uC548 \uAC80\uC0AC)"
    ],
    "correctIndex": 0,
    "explanation": "RT\uB294 \uB450\uAEBC\uC6B4 T-Joint\uC5D0\uC11C\uB294 \uD615\uC0C1 \uAD6C\uC870\uC0C1 \uD544\uB984 \uCD2C\uC601\uACFC \uD310\uB3C5\uC774 \uB9E4\uC6B0 \uC5B4\uB835\uC2B5\uB2C8\uB2E4. \uC774\uB54C\uB294 \uC74C\uD30C\uC758 \uBC18\uC0AC\uB97C \uC774\uC6A9\uD558\uB294 UT\uAC00 \uB0B4\uBD80 \uACB0\uD568 \uD0D0\uC9C0\uC5D0 \uAC00\uC7A5 \uD6A8\uACFC\uC801\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s7q13",
    "set": 7,
    "num": 13,
    "difficulty": "easy",
    "category": "\uC7AC\uB8CC \uBC0F \uC131\uBD84",
    "question": "\uC2A4\uD14C\uC778\uB9AC\uC2A4 \uAC15\uAD00(Pipe)\uC744 GTAW\uB85C \uC6A9\uC811\uD560 \uB54C, \uAD00 \uB0B4\uBD80\uC5D0 Ar \uAC00\uC2A4\uB97C \uCC44\uC6CC \uB123\uB294 Back purging(\uC774\uBA74 \uD37C\uC9D5)\uC744 \uC2E4\uC2DC\uD558\uB294 \uAC00\uC7A5 \uD070 \uC774\uC720\uB294?",
    "options": [
      "\uC6A9\uC811 \uC18D\uB3C4\uB97C \uB192\uC774\uAE30 \uC704\uD574",
      "\uB0B4\uBD80\uC758 \uC555\uB825\uC744 \uB192\uC5EC \uC6A9\uC735\uC9C0\uAC00 \uD758\uB7EC\uB0B4\uB9AC\uB294 \uAC83\uC744 \uB9C9\uAE30 \uC704\uD574",
      "\uC774\uBA74(Root side) \uBE44\uB4DC\uAC00 \uACF5\uAE30\uC640 \uB9CC\uB098 \uC0B0\uD654(Sugaring)\uB418\uB294 \uAC83\uC744 \uBC29\uC9C0\uD558\uAE30 \uC704\uD574",
      "\uAD00 \uB0B4\uBD80\uB97C \uC2DC\uC6D0\uD558\uAC8C \uB0C9\uAC01\uC2DC\uD0A4\uAE30 \uC704\uD574"
    ],
    "correctIndex": 2,
    "explanation": "\uC2A4\uD14C\uC778\uB9AC\uC2A4\uAC15\uC740 \uACE0\uC628\uC5D0\uC11C \uC0B0\uC18C\uC640 \uB2FF\uC73C\uBA74 \uAE4C\uB9E3\uAC8C \uD0C0\uBC84\uB9AC\uACE0 \uB0B4\uC2DD\uC131\uC744 \uC0C1\uC2E4\uD558\uBBC0\uB85C, \uD30C\uC774\uD504 \uB0B4\uBD80 \uACF5\uAE30\uB97C Ar\uC73C\uB85C \uBC00\uC5B4\uB0B4\uC5B4 \uBCF4\uD638\uD574\uC57C \uD569\uB2C8\uB2E4."
  },
  {
    "id": "s7q14",
    "set": 7,
    "num": 14,
    "difficulty": "medium",
    "category": "\uC7AC\uB8CC \uBC0F \uC131\uBD84",
    "question": "\uC624\uC2A4\uD14C\uB098\uC774\uD2B8\uACC4 \uC2A4\uD14C\uC778\uB9AC\uC2A4\uAC15(\uC608: 304, 316)\uC744 \uAD6C\uC131\uD558\uB294 3\uB300 \uC8FC\uC694 \uAE08\uC18D \uC6D0\uC18C\uB294 \uCCA0(Fe)\uACFC \uADF8\uB9AC\uACE0 \uBB34\uC5C7\uC778\uAC00?",
    "options": [
      "\uAD6C\uB9AC(Cu), \uC544\uC5F0(Zn)",
      "\uD06C\uB86C(Cr), \uB2C8\uCF08(Ni)",
      "\uC54C\uB8E8\uBBF8\uB284(Al), \uB9C8\uADF8\uB124\uC298(Mg)",
      "\uD145\uC2A4\uD150(W), \uBAB0\uB9AC\uBE0C\uB374(Mo)"
    ],
    "correctIndex": 1,
    "explanation": "\uC624\uC2A4\uD14C\uB098\uC774\uD2B8\uACC4 \uC2A4\uD14C\uC778\uB9AC\uC2A4\uAC15\uC740 \uAE30\uBCF8\uC801\uC73C\uB85C 18%\uC758 Cr(\uD06C\uB86C)\uACFC 8%\uC758 Ni(\uB2C8\uCF08)\uC744 \uD568\uC720\uD558\uC5EC \uBD80\uC2DD\uC744 \uB9C9\uACE0 \uC870\uC9C1\uC744 \uC548\uC815\uD654\uC2DC\uD0A8 \uD569\uAE08\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s7q15",
    "set": 7,
    "num": 15,
    "difficulty": "easy",
    "category": "\uC6A9\uC811 \uADF9\uC131",
    "question": "\uD0C4\uC18C\uAC15\uC774\uB098 \uC2A4\uD14C\uC778\uB9AC\uC2A4\uAC15\uC758 GTAW \uC6A9\uC811 \uC2DC, \uC804\uADF9\uC774 (-) \uADF9\uC131\uC744 \uB760\uACE0 \uBAA8\uC7AC\uAC00 (+) \uADF9\uC131\uC744 \uB760\uC5B4 \uBAA8\uC7AC \uCABD\uC5D0 \uC5F4\uC774 \uC9D1\uC911\uB418\uB3C4\uB85D \uD558\uB294 \uADF9\uC131\uC740?",
    "options": [
      "AC",
      "DCEP",
      "DCEN",
      "HF AC"
    ],
    "correctIndex": 2,
    "explanation": "\uC9C1\uB958 \uC815\uADF9\uC131(DCEN)\uC740 \uC804\uC790\uAC00 \uBAA8\uC7AC \uCABD\uC5D0 \uBD80\uB52A\uD788\uBBC0\uB85C \uBAA8\uC7AC\uAC00 \uAE4A\uAC8C \uB179\uC544 \uCCA0\uAC15\uC7AC GTAW\uC758 \uD45C\uC900 \uADF9\uC131\uC73C\uB85C \uC0AC\uC6A9\uB429\uB2C8\uB2E4."
  },
  {
    "id": "s7q16",
    "set": 7,
    "num": 16,
    "difficulty": "hard",
    "category": "\uC6A9\uC811 \uADF9\uC131",
    "question": "GTAW \uC6A9\uC811\uC5D0\uC11C \uC9C1\uB958 \uC5ED\uADF9\uC131(DCEP)\uC744 \uC0AC\uC6A9\uD560 \uB54C \uB098\uD0C0\uB098\uB294 \uD2B9\uC9D5\uC73C\uB85C \uC62C\uBC14\uB974\uC9C0 \uC54A\uC740 \uAC83\uC740?",
    "options": [
      "\uBAA8\uC7AC\uC758 \uC595\uC740 \uC6A9\uC785\uC744 \uC5BB\uC744 \uC218 \uC788\uB2E4.",
      "Bead\uC758 \uD3ED\uC774 \uB113\uC5B4\uC9C4\uB2E4.",
      "\uC804\uADF9\uBD09(Tungsten)\uC5D0 \uC5F4\uC774 \uC57D 30%\uB9CC \uC9D1\uC911\uB418\uC5B4 \uC804\uADF9 \uC18C\uBAA8\uAC00 \uAC70\uC758 \uC5C6\uB2E4.",
      "\uAE08\uC18D \uD45C\uBA74\uC758 \uC0B0\uD654\uB9C9\uC744 \uD30C\uAD34\uD558\uB294 \uCCAD\uC815 \uC791\uC6A9\uC774 \uC77C\uC5B4\uB09C\uB2E4."
    ],
    "correctIndex": 2,
    "explanation": "DCEP\uB294 \uC804\uADF9\uBD09(+) \uCABD\uC5D0 \uC804\uCCB4 \uC5F4\uC758 \uC57D 70%\uAC00 \uC9D1\uC911\uB418\uBBC0\uB85C \uD145\uC2A4\uD150 \uC804\uADF9\uC774 \uB9E4\uC6B0 \uC27D\uAC8C \uACFC\uC5F4\uB418\uACE0 \uB179\uC544\uB0B4\uB9BD\uB2C8\uB2E4."
  },
  {
    "id": "s7q17",
    "set": 7,
    "num": 17,
    "difficulty": "easy",
    "category": "\uC804\uC6D0 \uD2B9\uC131",
    "question": "\uC6A9\uC811\uAE30\uC5D0 \uD45C\uC2DC\uB41C '\uC0AC\uC6A9\uB960(Duty Cycle)'\uC774 60%\uB77C\uB294 \uAC83\uC740 10\uBD84\uC744 \uAE30\uC900\uC73C\uB85C \uBA87 \uBD84 \uB3D9\uC548 \uC548\uC804\uD558\uAC8C \uC6A9\uC811\uC744 \uC9C0\uC18D\uD560 \uC218 \uC788\uB2E4\uB294 \uC758\uBBF8\uC778\uAC00?",
    "options": [
      "4\uBD84",
      "6\uBD84",
      "10\uBD84",
      "60\uBD84"
    ],
    "correctIndex": 1,
    "explanation": "\uC0AC\uC6A9\uB960 60%\uB294 \uC815\uACA9 \uD55C\uACC4 \uB0B4\uC5D0\uC11C 10\uBD84 \uC911 6\uBD84\uC744 \uC6A9\uC811\uD558\uACE0 4\uBD84\uC740 \uAE30\uACC4\uB97C \uC26C\uAC8C(\uACF5\uB7AD) \uD574\uC57C \uACE0\uC7A5 \uB098\uC9C0 \uC54A\uC74C\uC744 \uC758\uBBF8\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s7q18",
    "set": 7,
    "num": 18,
    "difficulty": "medium",
    "category": "\uC804\uC6D0 \uD2B9\uC131",
    "question": "\uC218\uB3D9 GTAW \uC804\uC6D0\uC758 \uD2B9\uC9D5\uC778 \uC218\uD558 \uD2B9\uC131(Drooping characteristic) \uACE1\uC120\uC5D0\uC11C, \uC6A9\uC811 \uC911 Torch\uAC00 \uBAA8\uC7AC\uC5D0 \uB2FF\uC544 \uB2E8\uB77D(Short circuit)\uC774 \uBC1C\uC0DD\uD588\uC744 \uB54C \uB098\uD0C0\uB098\uB294 \uD604\uC0C1\uC740?",
    "options": [
      "\uC804\uC555\uC774 \uBB34\uD55C\uB300\uB85C \uCE58\uC19F\uB294\uB2E4.",
      "\uB2E8\uB77D \uC804\uB958\uAC00 \uC81C\uD55C\uB418\uC5B4 \uAE30\uACC4 \uD30C\uC190\uC774\uB098 \uC804\uADF9\uC758 \uACFC\uB3C4\uD55C \uC190\uC0C1\uC744 \uB9C9\uC544\uC900\uB2E4.",
      "\uC6A9\uC811\uAE30\uC758 \uC804\uC6D0\uC774 \uC989\uC2DC \uCC28\uB2E8\uB41C\uB2E4.",
      "\uAD50\uB958\uB85C \uADF9\uC131\uC774 \uC790\uB3D9\uC73C\uB85C \uBC14\uB010\uB2E4."
    ],
    "correctIndex": 1,
    "explanation": "\uC218\uD558 \uD2B9\uC131\uC740 \uC804\uC555\uC774 0(\uB2E8\uB77D)\uC774 \uB418\uB354\uB77C\uB3C4 \uC804\uB958\uAC00 \uBB34\uD55C\uD788 \uC99D\uAC00\uD558\uC9C0 \uC54A\uACE0 \uC77C\uC815 \uC218\uC900\uC5D0\uC11C \uAEBE\uC774\uB3C4\uB85D \uC124\uACC4\uB418\uC5B4 \uC788\uC5B4 \uD569\uC120 \uC2DC \uAE30\uAE30\uC640 \uC804\uADF9\uC744 \uBCF4\uD638\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s7q19",
    "set": 7,
    "num": 19,
    "difficulty": "easy",
    "category": "\uC785\uC5F4\uB7C9\uACFC \uBCC0\uD615",
    "question": "\uBCF8 \uC6A9\uC811\uC744 \uD558\uAE30 \uC804\uC5D0 \uBD80\uD488\uB4E4\uC774 \uC6C0\uC9C1\uC774\uC9C0 \uC54A\uB3C4\uB85D \uC704\uCE58\uB97C \uB9DE\uCD94\uACE0 \uC784\uC2DC\uB85C \uC9E7\uAC8C \uB367\uBD99\uC5EC \uB193\uB294 \uC6A9\uC811\uC744 \uBB34\uC5C7\uC774\uB77C \uD558\uB294\uAC00?",
    "options": [
      "Backing weld (\uC774\uBA74 \uC6A9\uC811)",
      "Tack weld (\uAC00\uC811 \uB610\uB294 \uD14C\uD06C \uC6A9\uC811)",
      "Weaving (\uC704\uBE59)",
      "Peening (\uD53C\uB2DD)"
    ],
    "correctIndex": 1,
    "explanation": "Tack weld(\uAC00\uC811)\uB294 \uBCF8 \uC6A9\uC811 \uC911 \uC218\uCD95\uACFC \uBCC0\uD615\uC5D0 \uC758\uD574 \uD615\uC0C1\uC774 \uD2C0\uC5B4\uC9C0\uB294 \uAC83\uC744 \uB9C9\uAE30 \uC704\uD574 \uC784\uC2DC\uB85C \uACE0\uC815\uD558\uB294 \uB9E4\uC6B0 \uC911\uC694\uD55C \uC791\uC5C5\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s7q20",
    "set": 7,
    "num": 20,
    "difficulty": "hard",
    "category": "\uC785\uC5F4\uB7C9\uACFC \uBCC0\uD615",
    "question": "\uB9DE\uB300\uAE30 \uC6A9\uC811 \uC2DC \uC218\uCD95\uC73C\uB85C \uC778\uD574 \uC591\uCABD \uD310\uC774 \uAEBE\uC774\uB294 \uAC01\uBCC0\uD615(Angular distortion)\uC744 \uBC29\uC9C0\uD558\uAE30 \uC704\uD574, \uC6A9\uC811\uBD80 \uB4B7\uBA74\uC5D0 \uC784\uC2DC\uB85C \uB367\uB300\uC5B4 \uC6A9\uC811\uD574 \uB450\uB294 \uD2BC\uD2BC\uD55C \uBCF4\uAC15\uC7AC\uB97C \uBB34\uC5C7\uC774\uB77C \uD558\uB294\uAC00?",
    "options": [
      "Strongback (\uC2A4\uD2B8\uB871\uBC31)",
      "Backing strip (\uBC31\uD0B9 \uC2A4\uD2B8\uB9BD)",
      "End tab (\uC5D4\uB4DC \uD0ED)",
      "Gas lens (\uAC00\uC2A4 \uB80C\uC988)"
    ],
    "correctIndex": 0,
    "explanation": "Strongback\uC740 \uAC15\uC81C\uB85C \uBCC0\uD615\uC744 \uC5B5\uC81C\uD558\uAE30 \uC704\uD574 \uBAA8\uC7AC \uB4B7\uBA74\uC774\uB098 \uD45C\uBA74\uC5D0 \uC6A9\uC811\uD574 \uB450\uB294 \uB450\uAEBC\uC6B4 \uC1F3\uC870\uAC01\uC774\uB098 \uD615\uAC15\uC744 \uC758\uBBF8\uD558\uBA70, \uC6A9\uC811 \uD6C4 \uC81C\uAC70\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s8q1",
    "set": 8,
    "num": 1,
    "difficulty": "easy",
    "category": "\uC6A9\uC811\uACFC \uAD00\uB828\uB41C \uC548\uC804",
    "question": "\uC6A9\uC811 \uC791\uC5C5 \uC911 \uBC1C\uC0DD\uD558\uB294 \uC720\uD574\uD55C Fume(\uC5F0\uAE30)\uC744 \uC81C\uAC70\uD558\uAE30 \uC704\uD574 \uAC00\uC7A5 \uD6A8\uACFC\uC801\uC774\uACE0 \uC6B0\uC120\uC801\uC73C\uB85C \uACE0\uB824\uD574\uC57C \uD558\uB294 \uD658\uAE30 \uBC29\uC2DD\uC740?",
    "options": [
      "\uC804\uCCB4 \uD658\uAE30",
      "\uAD6D\uC18C \uBC30\uAE30 (Local exhaust ventilation)",
      "\uC790\uC5F0 \uD658\uAE30",
      "\uC120\uD48D\uAE30 \uAC00\uB3D9"
    ],
    "correctIndex": 1,
    "explanation": "Fume\uC774 \uC791\uC5C5\uC790\uC758 \uD638\uD761\uAE30\uB85C \uB4E4\uC5B4\uAC00\uAE30 \uC804\uC5D0 \uBC1C\uC0DD\uC6D0 \uADFC\uCC98\uC5D0\uC11C \uC9C1\uC811 \uBE68\uC544\uB4E4\uC774\uB294 \uAD6D\uC18C \uBC30\uAE30 \uC7A5\uCE58\uAC00 \uAC00\uC7A5 \uD6A8\uACFC\uC801\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s8q2",
    "set": 8,
    "num": 2,
    "difficulty": "medium",
    "category": "\uC6A9\uC811\uACFC \uAD00\uB828\uB41C \uC548\uC804",
    "question": "Torch\uC758 Tungsten \uC804\uADF9\uBD09\uC744 \uAD50\uCCB4\uD558\uAC70\uB098 \uC5F0\uB9C8\uD558\uAE30 \uC704\uD574 Torch\uB97C \uBD84\uD574\uD560 \uB54C \uAC10\uC804 \uBC0F \uC548\uC804\uC0AC\uACE0\uB97C \uC608\uBC29\uD558\uAE30 \uC704\uD55C \uAC00\uC7A5 \uC62C\uBC14\uB978 \uC870\uCE58\uB294?",
    "options": [
      "\uC808\uC5F0 \uC7A5\uAC11\uB9CC \uB080 \uCC44\uB85C \uC2E0\uC18D\uD788 \uAD50\uCCB4\uD55C\uB2E4.",
      "\uC6A9\uC811\uAE30\uC758 \uC804\uC6D0 \uC2A4\uC704\uCE58\uB97C \uC644\uC804\uD788 \uCC28\uB2E8(Off)\uD55C \uD6C4 \uAD50\uCCB4\uD55C\uB2E4.",
      "Gas \uBC38\uBE0C\uB9CC \uC7A0\uADF8\uACE0 \uAD50\uCCB4\uD55C\uB2E4.",
      "\uC811\uC9C0(Earth) Cable\uC744 \uBD84\uB9AC\uD55C \uD6C4 \uAD50\uCCB4\uD55C\uB2E4."
    ],
    "correctIndex": 1,
    "explanation": "\uC2A4\uC704\uCE58 \uC624\uC791\uB3D9\uC774\uB098 \uACE0\uC8FC\uD30C(High Frequency)\uC5D0 \uC758\uD55C \uAC10\uC804\uC744 \uC6D0\uCC9C\uC801\uC73C\uB85C \uB9C9\uAE30 \uC704\uD574 \uC804\uC6D0 \uC790\uCCB4\uB97C \uB044\uB294 \uAC83\uC774 \uAC00\uC7A5 \uC548\uC804\uD55C \uC218\uCE59\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s8q3",
    "set": 8,
    "num": 3,
    "difficulty": "easy",
    "category": "\uC7A5\uBE44 \uBC0F \uB3C4\uAD6C",
    "question": "GTAW Torch \uBD80\uD488 \uC911, Collet\uC744 \uC870\uC5EC Tungsten \uC804\uADF9\uC744 \uACE0\uC815\uC2DC\uD0A4\uACE0 Torch \uB4B7\uBD80\uBD84\uC73C\uB85C Gas\uAC00 \uC0C8\uC5B4\uB098\uAC00\uC9C0 \uC54A\uB3C4\uB85D \uBC00\uD3D0\uD558\uB294 \uC5ED\uD560\uC744 \uD558\uB294 \uBD80\uD488\uC740?",
    "options": [
      "Nozzle",
      "Gas lens",
      "Back cap",
      "Torch body"
    ],
    "correctIndex": 2,
    "explanation": "Back cap\uC740 \uB098\uC0AC\uC0B0\uC73C\uB85C \uCCB4\uACB0\uB418\uC5B4 \uC804\uADF9\uC744 \uC555\uBC15 \uACE0\uC815\uD558\uACE0 Torch \uD6C4\uBA74\uC758 \uAE30\uBC00\uC744 \uC720\uC9C0\uD558\uB294 \uB69C\uAED1 \uC5ED\uD560\uC744 \uD569\uB2C8\uB2E4. \uAE38\uC774\uC5D0 \uB530\uB77C Long, Short \uD0C0\uC785\uC774 \uC788\uC2B5\uB2C8\uB2E4."
  },
  {
    "id": "s8q4",
    "set": 8,
    "num": 4,
    "difficulty": "hard",
    "category": "\uC7A5\uBE44 \uBC0F \uB3C4\uAD6C",
    "question": "Pulse GTAW \uAE30\uB2A5\uC5D0\uC11C 'Pulse Frequency(\uC8FC\uD30C\uC218)'\uAC00 \uC758\uBBF8\uD558\uB294 \uAC83\uC740 \uBB34\uC5C7\uC778\uAC00?",
    "options": [
      "1\uCD08 \uB3D9\uC548 \uC804\uB958\uAC00 Peak\uC640 Background\uB85C \uAD50\uCC28 \uBCC0\uD658\uD558\uB294 \uD69F\uC218",
      "Arc\uAC00 \uD55C \uBC88 \uCF1C\uC9C4 \uD6C4 \uAEBC\uC9C8 \uB54C\uAE4C\uC9C0\uC758 \uC804\uCCB4 \uC2DC\uAC04",
      "\uAD50\uB958 \uC6A9\uC811 \uC2DC DCEP\uC640 DCEN\uC758 \uBE44\uC728",
      "\uACE0\uC8FC\uD30C Arc \uAE30\uB3D9 \uC7A5\uCE58\uC758 \uC804\uC555 \uC138\uAE30"
    ],
    "correctIndex": 0,
    "explanation": "Pulse Frequency\uB294 \uB2E8\uC704 \uC2DC\uAC04(1\uCD08, Hz)\uB2F9 \uB192\uC740 \uC804\uB958(Peak)\uC640 \uB0AE\uC740 \uC804\uB958(Background)\uAC00 \uBA87 \uBC88 \uBC18\uBCF5\uB418\uB294\uC9C0\uB97C \uB098\uD0C0\uB0B4\uB294 \uAC12\uC73C\uB85C \uBE44\uB4DC\uC758 \uBB3C\uACB0\uBB34\uB2AC \uCD18\uCD18\uD568\uC744 \uACB0\uC815\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s8q5",
    "set": 8,
    "num": 5,
    "difficulty": "easy",
    "category": "\uC6A9\uC811\uC758 \uC885\uB958",
    "question": "\uBE44\uC18C\uBAA8\uC131 \uC804\uADF9\uC744 \uC0AC\uC6A9\uD558\uBA70, \uC6A9\uC811\uBD80\uC758 \uC0B0\uD654\uB97C \uB9C9\uAE30 \uC704\uD574 \uBD88\uD65C\uC131 \uAC00\uC2A4(\uC8FC\uB85C Ar)\uB97C \uBFDC\uC5B4\uC8FC\uB294 \uC6A9\uC811 \uD504\uB85C\uC138\uC2A4\uB294?",
    "options": [
      "SMAW",
      "GTAW",
      "GMAW",
      "FCAW"
    ],
    "correctIndex": 1,
    "explanation": "GTAW(TIG)\uB294 \uC18C\uBAA8\uB418\uC9C0 \uC54A\uB294 Tungsten \uC804\uADF9\uACFC \uBD88\uD65C\uC131 \uAC00\uC2A4\uB97C \uC0AC\uC6A9\uD558\uB294 \uB300\uD45C\uC801\uC778 \uC815\uBC00 \uC6A9\uC811\uBC95\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s8q6",
    "set": 8,
    "num": 6,
    "difficulty": "medium",
    "category": "\uC6A9\uC811\uC758 \uC885\uB958",
    "question": "PAW(Plasma Arc Welding)\uAC00 \uC77C\uBC18\uC801\uC778 GTAW\uC640 \uAC00\uC7A5 \uD06C\uAC8C \uAD6C\uBCC4\uB418\uB294 \uAD6C\uC870\uC801/\uC6D0\uB9AC\uC801 \uCC28\uC774\uC810\uC740 \uBB34\uC5C7\uC778\uAC00?",
    "options": [
      "PAW\uB294 \uC18C\uBAA8\uC131 \uC640\uC774\uC5B4\uB97C \uC0AC\uC6A9\uD55C\uB2E4.",
      "PAW\uB294 \uC9C4\uACF5 \uC0C1\uD0DC\uC5D0\uC11C\uB9CC \uC6A9\uC811\uC774 \uAC00\uB2A5\uD558\uB2E4.",
      "PAW\uB294 Orifice(\uAD6C\uBA4D)\uB97C \uD1B5\uD574 Arc\uB97C \uAC15\uD558\uAC8C \uC555\uCD95(Constriction)\uC2DC\uCF1C \uC5D0\uB108\uC9C0 \uBC00\uB3C4\uB97C \uB192\uC778\uB2E4.",
      "PAW\uB294 \uBCF4\uD638\uAC00\uC2A4\uB85C \uC774\uC0B0\uD654\uD0C4\uC18C(CO2)\uB9CC \uC0AC\uC6A9\uD55C\uB2E4."
    ],
    "correctIndex": 2,
    "explanation": "PAW\uB294 GTAW\uC640 \uC6D0\uB9AC\uAC00 \uBE44\uC2B7\uD558\uC9C0\uB9CC, \uC218\uB7AD\uC2DD \uAD6C\uB9AC Nozzle\uC758 \uC881\uC740 \uAD6C\uBA4D(Orifice)\uC73C\uB85C \uD50C\uB77C\uC988\uB9C8 Arc\uB97C \uD1B5\uACFC\uC2DC\uCF1C \uD6E8\uC52C \uACE0\uBC00\uB3C4\uC758 \uC5F4\uC6D0\uC744 \uB9CC\uB4ED\uB2C8\uB2E4."
  },
  {
    "id": "s8q7",
    "set": 8,
    "num": 7,
    "difficulty": "easy",
    "category": "\uC544\uD06C\uC758 \uC774\uD574",
    "question": "\uC6A9\uC811 \uC911 Torch\uB97C \uBAA8\uC7AC\uC5D0 \uAC00\uAE5D\uAC8C \uBD99\uC5EC Arc length\uAC00 \uC9E7\uC544\uC9C0\uBA74 Arc \uC804\uC555\uC740 \uC5B4\uB5BB\uAC8C \uBCC0\uD558\uB294\uAC00?",
    "options": [
      "\uB0AE\uC544\uC9C4\uB2E4.",
      "\uBCC0\uD558\uC9C0 \uC54A\uB294\uB2E4.",
      "\uB192\uC544\uC9C4\uB2E4.",
      "0\uC774 \uB41C\uB2E4."
    ],
    "correctIndex": 0,
    "explanation": "Arc length\uAC00 \uC9E7\uC544\uC9C0\uBA74 \uC804\uADF9\uACFC \uBAA8\uC7AC \uC0AC\uC774\uC758 \uACF5\uAE30(\uD50C\uB77C\uC988\uB9C8) \uC800\uD56D\uC774 \uAC10\uC18C\uD558\uBBC0\uB85C \uC804\uC555\uB3C4 \uBE44\uB840\uD558\uC5EC \uB0AE\uC544\uC9D1\uB2C8\uB2E4."
  },
  {
    "id": "s8q8",
    "set": 8,
    "num": 8,
    "difficulty": "medium",
    "category": "\uC544\uD06C\uC758 \uC774\uD574",
    "question": "\uC9C1\uB958(DC) \uC804\uB958\uB97C \uC0AC\uC6A9\uD558\uC5EC \uAC15\uC790\uC131\uCCB4(\uCCA0\uAC15)\uB97C \uC6A9\uC811\uD560 \uB54C Arc\uAC00 \uD55C\uCABD\uC73C\uB85C \uC3E0\uB9AC\uAC70\uB098 \uD718\uC5B4\uC9C0\uB294 \uD604\uC0C1\uC740?",
    "options": [
      "Arc strike",
      "Arc blow",
      "Short circuit",
      "Spatter"
    ],
    "correctIndex": 1,
    "explanation": "Arc blow(\uC790\uAE30 \uC3E0\uB9BC)\uB294 \uC9C1\uB958 \uC6A9\uC811 \uC2DC \uBE44\uB300\uCE6D\uC801\uC778 \uC790\uAE30\uC7A5\uC5D0 \uC758\uD574 \uC544\uD06C\uAC00 \uBC00\uB824\uB098\uAC70\uB098 \uD718\uC5B4\uC9C0\uB294 \uD604\uC0C1\uC73C\uB85C, \uAD50\uB958(AC)\uB97C \uC0AC\uC6A9\uD558\uBA74 \uD574\uACB0\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4."
  },
  {
    "id": "s8q9",
    "set": 8,
    "num": 9,
    "difficulty": "easy",
    "category": "\uC6A9\uC811 \uACB0\uD568",
    "question": "\uBAA8\uC7AC\uC758 \uAC1C\uC120\uBA74 \uC678\uBD80(\uC6A9\uC811\uBD80\uAC00 \uC544\uB2CC \uACF3)\uC5D0 \uC2E4\uC218\uB85C Arc\uB97C \uBC1C\uC0DD\uC2DC\uCF30\uB2E4\uAC00 \uB044\uBA74\uC11C \uD45C\uBA74\uC5D0 \uBBF8\uC138\uD55C \uD760\uC9D1\uACFC \uAE09\uB7AD \uC870\uC9C1\uC744 \uB9CC\uB4E4\uC5B4 \uADE0\uC5F4\uC758 \uC6D0\uC778\uC774 \uB418\uB294 \uACB0\uD568\uC740?",
    "options": [
      "Undercut",
      "Crater pipe",
      "Arc strike",
      "Overlap"
    ],
    "correctIndex": 2,
    "explanation": "Arc strike\uB294 \uBAA8\uC7AC \uD45C\uBA74\uC5D0 \uC21C\uAC04\uC801\uC778 \uACE0\uC5F4\uACFC \uAE09\uB7AD\uC744 \uC720\uBC1C\uD558\uC5EC \uB9C8\uB974\uD150\uC0AC\uC774\uD2B8(\uACBD\uD654 \uC870\uC9C1)\uB97C \uD615\uC131\uD558\uACE0 \uD06C\uB799\uC744 \uC720\uBC1C\uD558\uBBC0\uB85C \uC808\uB300 \uD53C\uD574\uC57C \uD569\uB2C8\uB2E4."
  },
  {
    "id": "s8q10",
    "set": 8,
    "num": 10,
    "difficulty": "easy",
    "category": "\uC6A9\uC811 \uACB0\uD568",
    "question": "\uC6A9\uC811 \uD6C4 \uAE08\uC18D\uC774 \uC0C1\uC628\uC73C\uB85C \uB0C9\uAC01\uB41C \uC774\uD6C4, \uC8FC\uB85C \uC218\uC18C(Hydrogen) \uAC00\uC2A4\uC5D0 \uC758\uD574 \uC2DC\uAC04 \uC9C0\uC5F0\uC744 \uB450\uACE0 \uBC1C\uC0DD\uD558\uB294 \uADE0\uC5F4(Crack)\uC740?",
    "options": [
      "Hot crack",
      "Cold crack (\uC800\uC628 \uADE0\uC5F4)",
      "Crater crack",
      "Solidification crack"
    ],
    "correctIndex": 1,
    "explanation": "\uC6A9\uC811\uBD80\uC5D0 \uCE68\uD22C\uD55C \uC218\uC18C\uAC00 \uBC16\uC73C\uB85C \uBE60\uC838\uB098\uAC00\uC9C0 \uBABB\uD558\uACE0 \uB0C9\uAC01 \uD6C4 \uD33D\uCC3D\uD558\uBA74\uC11C \uB0B4\uBD80 \uC751\uB825\uC744 \uC77C\uC73C\uCF1C \uAC08\uB77C\uC9C0\uB294 \uAC83\uC744 \uC800\uC628 \uADE0\uC5F4(\uC218\uC18C \uC9C0\uC5F0 \uADE0\uC5F4)\uC774\uB77C\uACE0 \uD569\uB2C8\uB2E4."
  },
  {
    "id": "s8q11",
    "set": 8,
    "num": 11,
    "difficulty": "hard",
    "category": "\uC6A9\uC811 \uACB0\uD568",
    "question": "GTAW \uC6A9\uC811 \uC2DC Porosity(\uAE30\uACF5)\uAC00 \uBC1C\uC0DD\uD558\uB294 \uC6D0\uC778\uC73C\uB85C \uAC00\uC7A5 \uAC70\uB9AC\uAC00 \uBA3C \uAC83\uC740?",
    "options": [
      "\uC8FC\uBCC0\uC5D0 \uAC15\uD55C \uBC14\uB78C\uC774 \uBD88\uC5B4 Shielding gas\uAC00 \uB0A0\uC544\uAC08 \uB54C",
      "\uBAA8\uC7AC \uD45C\uBA74\uC5D0 \uAE30\uB984\uC774\uB098 \uC218\uBD84, \uD398\uC778\uD2B8 \uB4F1\uC774 \uBB3B\uC5B4 \uC788\uC744 \uB54C",
      "Gas \uB80C\uC988\uB97C \uC7A5\uCC29\uD558\uC5EC Laminar flow(\uCE35\uB958)\uAC00 \uD615\uC131\uB418\uC5C8\uC744 \uB54C",
      "Gas \uC720\uB7C9\uC774 \uB108\uBB34 \uB9CE\uC544 \uB09C\uB958(Turbulence)\uAC00 \uBC1C\uC0DD\uD558\uC5EC \uACF5\uAE30\uB97C \uBE68\uC544\uB4E4\uC77C \uB54C"
    ],
    "correctIndex": 2,
    "explanation": "Gas \uB80C\uC988\uC5D0 \uC758\uD55C Laminar flow(\uCE35\uB958) \uD615\uC131\uC740 \uAC00\uC2A4 \uBCF4\uD638 \uD6A8\uACFC\uB97C \uADF9\uB300\uD654\uD558\uC5EC Porosity \uBC1C\uC0DD\uC744 \uB9C9\uC544\uC8FC\uB294 \uAE0D\uC815\uC801\uC778 \uC694\uC18C\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s8q12",
    "set": 8,
    "num": 12,
    "difficulty": "easy",
    "category": "\uBE44\uD30C\uAD34 \uAC80\uC0AC",
    "question": "\uC0AC\uB78C\uC758 \uADC0\uC5D0 \uB4E4\uB9AC\uC9C0 \uC54A\uB294 \uACE0\uC8FC\uD30C \uC74C\uD30C\uB97C \uBAA8\uC7AC \uB0B4\uBD80\uC5D0 \uC3D8\uC544 \uBCF4\uB0B4\uC5B4, \uB0B4\uBD80 \uACB0\uD568\uC5D0 \uBD80\uB52A\uD600 \uB418\uB3CC\uC544\uC624\uB294 \uC2E0\uD638\uB97C \uBD84\uC11D\uD558\uB294 \uAC80\uC0AC\uBC95\uC740?",
    "options": [
      "RT",
      "MT",
      "PT",
      "UT (Ultrasonic Testing)"
    ],
    "correctIndex": 3,
    "explanation": "UT\uB294 \uCD08\uC74C\uD30C\uC758 \uBC18\uC0AC \uC6D0\uB9AC\uB97C \uC774\uC6A9\uD558\uC5EC \uBAA8\uC7AC \uB0B4\uBD80\uC758 \uACB0\uD568 \uC704\uCE58\uC640 \uAE4A\uC774\uB97C \uD30C\uC545\uD558\uB294 \uBC29\uC2DD\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s8q13",
    "set": 8,
    "num": 13,
    "difficulty": "medium",
    "category": "\uBE44\uD30C\uAD34 \uAC80\uC0AC",
    "question": "PT(\uCE68\uD22C \uD0D0\uC0C1 \uAC80\uC0AC)\uC758 \uAC00\uC7A5 \uD070 \uC7A5\uC810\uC740 \uBB34\uC5C7\uC778\uAC00?",
    "options": [
      "\uBAA8\uC7AC \uB0B4\uBD80 \uAE4A\uC219\uD55C \uACF3\uC758 \uACB0\uD568\uC744 \uC644\uBCBD\uD558\uAC8C \uCC3E\uC744 \uC218 \uC788\uB2E4.",
      "\uC790\uC131\uC774 \uC5C6\uB294 \uBE44\uC790\uC131\uCCB4(STS, \uC54C\uB8E8\uBBF8\uB284 \uB4F1)\uC758 \uD45C\uBA74 \uACB0\uD568\uB3C4 \uAC80\uCD9C\uD560 \uC218 \uC788\uB2E4.",
      "\uBC29\uC0AC\uC120 \uD53C\uD3ED \uC704\uD5D8\uC774 \uC788\uC5B4 \uBCF4\uC548\uC774 \uCCA0\uC800\uD558\uB2E4.",
      "\uBAA8\uC7AC \uD45C\uBA74\uC774 \uAC70\uCE60\uACE0 \uC624\uC5FC\uB418\uC5B4 \uC788\uC5B4\uB3C4 \uAC80\uC0AC\uAC00 \uAC00\uB2A5\uD558\uB2E4."
    ],
    "correctIndex": 1,
    "explanation": "PT\uB294 \uBAA8\uC138\uAD00 \uD604\uC0C1\uC744 \uC774\uC6A9\uD55C \uC561\uCCB4 \uC2A4\uBA70\uB4E6\uC744 \uBCF4\uBBC0\uB85C, \uC790\uC131\uC774 \uD544\uC694 \uC5C6\uC5B4 \uC54C\uB8E8\uBBF8\uB284\uC774\uB098 \uC624\uC2A4\uD14C\uB098\uC774\uD2B8\uACC4 STS\uC758 \uD45C\uBA74 \uACB0\uD568 \uAC80\uC0AC\uC5D0 \uD544\uC218\uC801\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s8q14",
    "set": 8,
    "num": 14,
    "difficulty": "easy",
    "category": "\uC7AC\uB8CC \uBC0F \uC131\uBD84",
    "question": "\uC2A4\uD14C\uC778\uB9AC\uC2A4\uAC15(STS)\uC774 \uC77C\uBC18 \uD0C4\uC18C\uAC15\uACFC \uB2EC\uB9AC \uB179(Corrosion)\uC774 \uC2AC\uC9C0 \uC54A\uB3C4\uB85D \uB9CC\uB4E4\uC5B4\uC8FC\uB294 \uD575\uC2EC \uCCA8\uAC00 \uC6D0\uC18C\uB294?",
    "options": [
      "\uD0C4\uC18C (C)",
      "\uD06C\uB86C (Cr)",
      "\uD669 (S)",
      "\uB0A9 (Pb)"
    ],
    "correctIndex": 1,
    "explanation": "\uD06C\uB86C(Cr)\uC774 11~12% \uC774\uC0C1 \uCCA8\uAC00\uB418\uBA74 \uD45C\uBA74\uC5D0 \uCE58\uBC00\uD55C \uC0B0\uD654 \uD06C\uB86C(\uBD80\uB3D9\uD0DC \uD53C\uB9C9)\uC744 \uD615\uC131\uD558\uC5EC \uB0B4\uBD80\uC2DD\uC131\uC744 \uD06C\uAC8C \uD5A5\uC0C1\uC2DC\uD0B5\uB2C8\uB2E4."
  },
  {
    "id": "s8q15",
    "set": 8,
    "num": 15,
    "difficulty": "medium",
    "category": "\uC7AC\uB8CC \uBC0F \uC131\uBD84",
    "question": "\uC54C\uB8E8\uBBF8\uB284(Al) GTAW \uC6A9\uC811 \uC2DC \uC5F4\uC804\uB3C4\uC728\uC774 \uB9E4\uC6B0 \uB192\uC544\uC11C \uC0DD\uAE30\uB294 \uD604\uC0C1\uACFC \uB300\uCC45\uC73C\uB85C \uC62C\uBC14\uB978 \uAC83\uC740?",
    "options": [
      "\uC5F4\uC804\uB3C4\uC728\uC774 \uB192\uC544 \uC5F4\uC774 \uC798 \uBAA8\uC774\uBBC0\uB85C \uC804\uB958\uB97C \uB0AE\uAC8C \uC124\uC815\uD55C\uB2E4.",
      "\uBAA8\uC7AC\uAC00 \uC5F4\uC744 \uAE08\uBC29 \uBE7C\uC557\uAE30\uBBC0\uB85C \uCD08\uAE30 \uC6A9\uC785\uC744 \uC5BB\uAE30 \uC704\uD574 \uCD08\uBC18\uC5D0 \uBE44\uAD50\uC801 \uB192\uC740 \uC804\uB958\uB098 \uC608\uC5F4(Pre-heating)\uC774 \uD544\uC694\uD558\uB2E4.",
      "\uC5F4\uC804\uB3C4\uC728\uC774 \uB192\uC73C\uBBC0\uB85C \uC6A9\uC811 \uC18D\uB3C4\uB97C \uBB34\uC870\uAC74 \uCC9C\uCC9C\uD788 \uD574\uC57C \uD55C\uB2E4.",
      "\uBCC0\uD615\uC774 \uC804\uD600 \uC0DD\uAE30\uC9C0 \uC54A\uC73C\uBBC0\uB85C \uAC00\uC811(Tack weld)\uC744 \uC0DD\uB7B5\uD55C\uB2E4."
    ],
    "correctIndex": 1,
    "explanation": "\uC54C\uB8E8\uBBF8\uB284\uC740 \uC8FC\uBCC0\uC73C\uB85C \uC5F4\uC744 \uBE68\uB9AC \uBC29\uCD9C\uD574 \uBC84\uB9AC\uBBC0\uB85C \uC1F3\uBB3C\uC774 \uC798 \uD615\uC131\uB418\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. \uB530\uB77C\uC11C \uC2DC\uC791 \uBD80\uBD84\uC5D0 \uACE0\uC804\uB958\uB97C \uAC00\uD558\uAC70\uB098 \uC608\uC5F4\uC744 \uD574\uC57C \uAE4A\uC740 \uC6A9\uC785\uC744 \uC5BB\uC744 \uC218 \uC788\uC2B5\uB2C8\uB2E4."
  },
  {
    "id": "s8q16",
    "set": 8,
    "num": 16,
    "difficulty": "easy",
    "category": "\uC6A9\uC811 \uADF9\uC131",
    "question": "\uD0C4\uC18C\uAC15(Carbon steel)\uC774\uB098 \uC2A4\uD14C\uC778\uB9AC\uC2A4\uAC15\uC744 GTAW\uB85C \uC6A9\uC811\uD560 \uB54C \uC6A9\uC785\uC744 \uAE4A\uAC8C \uD558\uAE30 \uC704\uD574 \uC124\uC815\uD558\uB294 \uAC00\uC7A5 \uAE30\uBCF8\uC801\uC778 \uADF9\uC131\uC740?",
    "options": [
      "AC",
      "DCEP",
      "DCEN",
      "DCRP"
    ],
    "correctIndex": 2,
    "explanation": "\uC9C1\uB958 \uC815\uADF9\uC131(DCEN)\uC740 \uC804\uC790\uAC00 \uBAA8\uC7AC \uCABD\uC5D0 \uBD80\uB52A\uD600 \uBAA8\uC7AC\uB97C \uC9D1\uC911\uC801\uC73C\uB85C \uAC00\uC5F4\uD558\uBBC0\uB85C \uAE4A\uC740 \uC6A9\uC785(Penetration)\uC774 \uD544\uC694\uD55C \uCCA0\uAC15 \uC7AC\uB8CC\uC5D0 \uC4F0\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s8q17",
    "set": 8,
    "num": 17,
    "difficulty": "hard",
    "category": "\uC6A9\uC811 \uADF9\uC131",
    "question": "AC(\uAD50\uB958) \uC6A9\uC811\uC5D0\uC11C Balance(\uCCAD\uC815 \uD3ED) \uC124\uC815\uC744 \uC870\uC791\uD558\uC5EC EN(\uC815\uADF9\uC131) \uAD6C\uAC04 \uBE44\uC728\uC744 \uB192\uAC8C \uD558\uACE0 EP(\uC5ED\uADF9\uC131) \uAD6C\uAC04 \uBE44\uC728\uC744 \uB0AE\uCD94\uBA74 \uB098\uD0C0\uB098\uB294 \uD604\uC0C1\uC740?",
    "options": [
      "\uC0B0\uD654\uB9C9 \uD30C\uAD34 \uC791\uC6A9\uC774 \uB9E4\uC6B0 \uAC15\uD574\uC9C0\uB098 Tungsten\uC774 \uACFC\uC5F4\uB41C\uB2E4.",
      "\uC0B0\uD654\uB9C9 \uD30C\uAD34 \uC791\uC6A9\uC740 \uC904\uC5B4\uB4E4\uC9C0\uB9CC, \uBAA8\uC7AC\uC758 \uC6A9\uC785(Penetration)\uC774 \uAE4A\uC5B4\uC9C0\uACE0 Tungsten\uC758 \uC18C\uBAA8\uAC00 \uC801\uC5B4\uC9C4\uB2E4.",
      "\uBAA8\uC7AC\uAC00 \uC804\uD600 \uB179\uC9C0 \uC54A\uAC8C \uB41C\uB2E4.",
      "Arc\uAC00 \uC218\uC2DC\uB85C \uAEBC\uC9C4\uB2E4."
    ],
    "correctIndex": 1,
    "explanation": "EN \uBE44\uC728\uC774 \uB192\uB2E4\uB294 \uAC83\uC740 \uBAA8\uC7AC\uC5D0 \uC5F4\uC744 \uC8FC\uB294 \uC2DC\uAC04\uC774 \uAE38\uC5B4\uC9C4\uB2E4\uB294 \uB73B\uC774\uBBC0\uB85C \uC6A9\uC785\uC774 \uAE4A\uC5B4\uC9D1\uB2C8\uB2E4. \uBC18\uBA74 EP(\uCCAD\uC815 \uC791\uC6A9) \uC2DC\uAC04\uC774 \uC9E7\uC544\uC9C0\uBBC0\uB85C \uD145\uC2A4\uD150 \uACFC\uC5F4\uC740 \uBC29\uC9C0\uB429\uB2C8\uB2E4."
  },
  {
    "id": "s8q18",
    "set": 8,
    "num": 18,
    "difficulty": "easy",
    "category": "\uC804\uC6D0 \uD2B9\uC131",
    "question": "\uC218\uB3D9 GTAW \uC6A9\uC811\uAE30\uC758 \uD575\uC2EC \uC804\uC6D0 \uD2B9\uC131\uC73C\uB85C, Arc length\uAC00 \uBCC0\uD558\uC5EC \uC804\uC555\uC774 \uC624\uB974\uB0B4\uB824\uB3C4 \uC804\uB958\uAC12\uC740 \uAC70\uC758 \uC77C\uC815\uD558\uAC8C \uC720\uC9C0\uB418\uB824\uB294 \uC131\uC9C8\uC740?",
    "options": [
      "\uC815\uC804\uC555 \uD2B9\uC131",
      "\uC0C1\uC2B9 \uD2B9\uC131",
      "\uC218\uD558 \uD2B9\uC131 (\uC815\uC804\uB958 \uD2B9\uC131)",
      "\uBD80\uC800\uD56D \uD2B9\uC131"
    ],
    "correctIndex": 2,
    "explanation": "\uC218\uD558(\uC815\uC804\uB958) \uD2B9\uC131 \uB355\uBD84\uC5D0 \uC791\uC5C5\uC790\uC758 \uC190\uB5A8\uB9BC\uC5D0 \uC758\uD55C Arc length \uBCC0\uD654\uC5D0\uB3C4 \uC785\uC5F4\uB7C9(\uC804\uB958)\uC774 \uC77C\uC815\uD558\uAC8C \uC720\uC9C0\uB418\uC5B4 \uBE44\uB4DC\uAC00 \uACE0\uB974\uAC8C \uB098\uC635\uB2C8\uB2E4."
  },
  {
    "id": "s8q19",
    "set": 8,
    "num": 19,
    "difficulty": "hard",
    "category": "\uC804\uC6D0 \uD2B9\uC131",
    "question": "\uC6A9\uC811\uAE30\uC758 OCV(Open Circuit Voltage, \uBB34\uBD80\uD558 \uC804\uC555)\uC5D0 \uB300\uD55C \uC124\uBA85\uC73C\uB85C \uC62C\uBC14\uB978 \uAC83\uC740?",
    "options": [
      "\uC6A9\uC811 \uC911 Arc\uAC00 \uC548\uC815\uC801\uC73C\uB85C \uC720\uC9C0\uB420 \uB54C\uC758 \uC804\uC555\uC774\uB2E4.",
      "Arc\uB97C \uAE30\uB3D9\uD558\uAE30 \uC804, \uC804\uC6D0\uB9CC \uCF1C\uC9C4 \uC0C1\uD0DC\uC5D0\uC11C \uCD9C\uB825 \uB2E8\uC790\uC5D0 \uAC78\uB824 \uC788\uB294 \uB300\uAE30 \uC804\uC555\uC774\uB2E4.",
      "OCV\uAC00 \uB0AE\uC744\uC218\uB85D Arc \uAE30\uB3D9(Start)\uC774 \uD6E8\uC52C \uC26C\uC6CC\uC9C4\uB2E4.",
      "\uD56D\uC0C1 10~20V \uC0AC\uC774\uC758 \uB0AE\uC740 \uC804\uC555\uC744 \uC720\uC9C0\uD55C\uB2E4."
    ],
    "correctIndex": 1,
    "explanation": "OCV\uB294 \uC6A9\uC811\uC744 \uD558\uC9C0 \uC54A\uC744 \uB54C\uC758 \uB300\uAE30 \uC804\uC555(\uBCF4\uD1B5 60~80V)\uC774\uBA70, \uC774 \uC804\uC555\uC774 \uB192\uC744\uC218\uB85D Arc \uBC1C\uC0DD\uC740 \uC27D\uC9C0\uB9CC \uC804\uACA9(\uAC10\uC804) \uC704\uD5D8\uC740 \uCEE4\uC9D1\uB2C8\uB2E4."
  },
  {
    "id": "s8q20",
    "set": 8,
    "num": 20,
    "difficulty": "medium",
    "category": "\uC785\uC5F4\uB7C9\uACFC \uBCC0\uD615",
    "question": "\uC6A9\uC811 \uC785\uC5F4\uB7C9(Heat Input) \uACF5\uC2DD H = 60EI/V \uC5D0\uC11C \uC785\uC5F4\uB7C9(H)\uC774 \uC99D\uAC00\uD558\uB294 \uC870\uAC74\uC73C\uB85C \uC62C\uBC14\uB978 \uAC83\uC740?",
    "options": [
      "\uC804\uC555(E) \uAC10\uC18C, \uC804\uB958(I) \uAC10\uC18C",
      "\uC6B4\uBD09 \uC18D\uB3C4(V) \uC99D\uAC00",
      "\uC804\uB958(I) \uC99D\uAC00, \uC6B4\uBD09 \uC18D\uB3C4(V) \uAC10\uC18C",
      "\uC804\uB958(I) \uC99D\uAC00, \uC6B4\uBD09 \uC18D\uB3C4(V) \uC99D\uAC00"
    ],
    "correctIndex": 2,
    "explanation": "\uC785\uC5F4\uB7C9\uC740 \uC804\uB958(I)\uC640 \uC804\uC555(E)\uC5D0 \uBE44\uB840\uD558\uACE0, \uC18D\uB3C4(V)\uC5D0 \uBC18\uBE44\uB840\uD569\uB2C8\uB2E4. \uC989, \uC804\uB958\uAC00 \uB192\uACE0 \uCC9C\uCC9C\uD788 \uC774\uB3D9\uD560\uC218\uB85D \uBAA8\uC7AC\uC5D0 \uC5F4\uC774 \uB9CE\uC774 \uAC00\uD574\uC9D1\uB2C8\uB2E4."
  },
  {
    "id": "s9q1",
    "set": 9,
    "num": 1,
    "difficulty": "easy",
    "category": "\uC6A9\uC811\uACFC \uAD00\uB828\uB41C \uC548\uC804",
    "question": "\uC6A9\uC811 \uC791\uC5C5\uC7A5 \uB0B4\uC5D0\uC11C \uAC10\uC804 \uC0AC\uACE0\uB97C \uC608\uBC29\uD558\uAE30 \uC704\uD574 \uC9C0\uCF1C\uC57C \uD560 \uC0AC\uD56D\uC73C\uB85C \uC633\uC9C0 \uC54A\uC740 \uAC83\uC740?",
    "options": [
      "\uB540\uC774\uB098 \uBB3C\uC5D0 \uC816\uC740 \uC791\uC5C5\uBCF5\uACFC \uC7A5\uAC11\uC744 \uCC29\uC6A9\uD558\uC9C0 \uC54A\uB294\uB2E4.",
      "\uC6A9\uC811\uAE30 \uC678\uD568\uC740 \uBC18\uB4DC\uC2DC Earth\uB97C \uC2E4\uC2DC\uD55C\uB2E4.",
      "\uC881\uACE0 \uC2B5\uAE30 \uCC2C \uACF5\uAC04\uC5D0\uC11C\uB294 \uAD50\uB958(AC) \uC6A9\uC811\uAE30\uB97C \uC0AC\uC6A9\uD558\uB294 \uAC83\uC774 \uC9C1\uB958(DC)\uBCF4\uB2E4 \uC548\uC804\uD558\uB2E4.",
      "\uC791\uC5C5\uC774 \uB05D\uB098\uBA74 \uBC18\uB4DC\uC2DC \uC6A9\uC811\uAE30\uC758 \uC8FC\uC804\uC6D0 \uC2A4\uC704\uCE58\uB97C Off \uC0C1\uD0DC\uB85C \uB454\uB2E4."
    ],
    "correctIndex": 2,
    "explanation": "\uC881\uACE0 \uC2B5\uAE30 \uCC2C \uACF5\uAC04\uC5D0\uC11C\uB294 \uC804\uACA9 \uC704\uD5D8\uC774 \uD06C\uBBC0\uB85C OCV\uAC00 \uB0AE\uACE0 \uAC10\uC804 \uC704\uD5D8\uC774 \uBE44\uAD50\uC801 \uC801\uC740 \uC9C1\uB958(DC) \uC6A9\uC811\uAE30\uB098 \uC804\uACA9\uBC29\uC9C0\uAE30\uB97C \uC0AC\uC6A9\uD558\uB294 \uAC83\uC774 \uC548\uC804\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s9q2",
    "set": 9,
    "num": 2,
    "difficulty": "medium",
    "category": "\uC6A9\uC811\uACFC \uAD00\uB828\uB41C \uC548\uC804",
    "question": "Tungsten \uC804\uADF9\uBD09\uC744 Grinder\uB85C \uC5F0\uB9C8\uD560 \uB54C \uC9C0\uCF1C\uC57C \uD560 \uC548\uC804 \uC218\uCE59\uC73C\uB85C \uAC00\uC7A5 \uC62C\uBC14\uB978 \uAC83\uC740?",
    "options": [
      "\uBCF4\uC548\uACBD\uC744 \uCC29\uC6A9\uD558\uC9C0 \uC54A\uACE0 \uC721\uC548\uC73C\uB85C \uC138\uBC00\uD558\uAC8C \uD655\uC778\uD558\uBA70 \uC5F0\uB9C8\uD55C\uB2E4.",
      "\uC7A5\uAC11\uC774 Grinder \uD68C\uC804\uBD80\uC5D0 \uB9D0\uB824 \uB4E4\uC5B4\uAC00\uC9C0 \uC54A\uB3C4\uB85D \uBA74\uC7A5\uAC11 \uCC29\uC6A9\uC744 \uAE08\uC9C0\uD558\uACE0 \uB9E8\uC190 \uB610\uB294 \uAC00\uC8FD\uC7A5\uAC11\uC744 \uC8FC\uC758\uD574\uC11C \uC0AC\uC6A9\uD55C\uB2E4.",
      "\uC5F0\uB9C8\uC11D\uC758 \uCE21\uBA74\uC744 \uC774\uC6A9\uD558\uC5EC \uC804\uADF9\uBD09\uC744 \uAC00\uB85C \uBC29\uD5A5\uC73C\uB85C \uAD74\uB9AC\uBA70 \uAC04\uD3B8\uD558\uAC8C \uC5F0\uB9C8\uD55C\uB2E4.",
      "\uBD84\uC9C4\uC774 \uBC1C\uC0DD\uD558\uBBC0\uB85C \uC785\uC73C\uB85C \uBD88\uC5B4\uAC00\uBA70 \uC791\uC5C5\uD55C\uB2E4."
    ],
    "correctIndex": 1,
    "explanation": "\uD68C\uC804\uD558\uB294 Grinder \uC791\uC5C5 \uC2DC \uBA74\uC7A5\uAC11\uC740 \uB9D0\uB824 \uB4E4\uC5B4\uAC08 \uC704\uD5D8\uC774 \uB9E4\uC6B0 \uD07D\uB2C8\uB2E4. \uB610\uD55C \uC5F0\uB9C8\uB294 \uBC18\uB4DC\uC2DC \uC138\uB85C \uBC29\uD5A5\uC73C\uB85C \uD574\uC57C \uD558\uBA70 \uBC29\uC9C4\uB9C8\uC2A4\uD06C\uC640 \uBCF4\uC548\uACBD\uC774 \uD544\uC218\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s9q3",
    "set": 9,
    "num": 3,
    "difficulty": "easy",
    "category": "\uC7A5\uBE44 \uBC0F \uB3C4\uAD6C",
    "question": "GTAW Torch\uC5D0 \uC5F0\uACB0\uB418\uB294 \uCF00\uC774\uBE14 \uC911 \uC804\uB958(Power)\uC640 \uB0C9\uAC01\uC218(Water)\uAC00 \uB3D9\uC2DC\uC5D0 \uD1B5\uACFC\uD558\uB294 \uCF00\uC774\uBE14\uC758 \uBA85\uCE6D\uC740?",
    "options": [
      "Gas hose",
      "Water in hose",
      "Power cable (Water out hose)",
      "Earth cable"
    ],
    "correctIndex": 2,
    "explanation": "\uC218\uB7AD\uC2DD Torch\uC758 Power cable\uC740 \uC804\uAE30\uB97C \uC804\uB2EC\uD558\uB294 \uAD6C\uB9AC\uC120\uC774 \uB0C9\uAC01\uC218 \uBC30\uCD9C \uD638\uC2A4(Water out) \uB0B4\uBD80\uC5D0 \uB4E4\uC5B4\uC788\uC5B4 \uC5F4\uC744 \uC2DD\uD788\uB294 \uAD6C\uC870\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s9q4",
    "set": 9,
    "num": 4,
    "difficulty": "hard",
    "category": "\uC7A5\uBE44 \uBC0F \uB3C4\uAD6C",
    "question": "Pulse GTAW\uC5D0\uC11C 'Pulse width' \uB610\uB294 'Duty cycle'\uC744 30%\uB85C \uC124\uC815\uD588\uB2E4\uB294 \uAC83\uC740 1\uC8FC\uAE30 \uB0B4\uC5D0\uC11C \uC5B4\uB5A4 \uC758\uBBF8\uB97C \uAC00\uC9C0\uB294\uAC00?",
    "options": [
      "Base current\uAC00 30% \uB3D9\uC548 \uC720\uC9C0\uB428\uC744 \uC758\uBBF8\uD55C\uB2E4.",
      "Peak current\uAC00 30% \uB3D9\uC548 \uC720\uC9C0\uB428\uC744 \uC758\uBBF8\uD55C\uB2E4.",
      "\uC804\uCCB4 \uC6A9\uC811 \uC2DC\uAC04 \uC911 30%\uB9CC \uC6A9\uC811\uC774 \uAC00\uB2A5\uD568\uC744 \uC758\uBBF8\uD55C\uB2E4.",
      "\uAC00\uC2A4 \uC18C\uBAA8\uB7C9\uC774 30% \uC808\uAC10\uB428\uC744 \uC758\uBBF8\uD55C\uB2E4."
    ],
    "correctIndex": 1,
    "explanation": "Pulse width(Duty cycle)\uB294 1\uC0AC\uC774\uD074 \uB0B4\uC5D0\uC11C \uBAA8\uC7AC\uB97C \uAC15\uB825\uD558\uAC8C \uB179\uC774\uB294 \uACE0\uC804\uB958\uC778 Peak current\uAC00 \uC9C0\uC18D\uB418\uB294 \uC2DC\uAC04\uC758 \uBE44\uC728(%)\uC744 \uB73B\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s9q5",
    "set": 9,
    "num": 5,
    "difficulty": "easy",
    "category": "\uC6A9\uC811\uC758 \uC885\uB958",
    "question": "\uB2E4\uC74C \uC911 \uC6A9\uC735 \uC6A9\uC811(Fusion welding)\uC5D0 \uD574\uB2F9\uD558\uC9C0 \uC54A\uB294 \uACF5\uC815\uC740?",
    "options": [
      "GMAW",
      "SAW",
      "FSW (Friction Stir Welding)",
      "PAW"
    ],
    "correctIndex": 2,
    "explanation": "FSW\uB294 \uD68C\uC804\uD558\uB294 \uD234\uC758 \uB9C8\uCC30\uC5F4\uC744 \uC774\uC6A9\uD574 \uAE08\uC18D\uC744 \uBD80\uB4DC\uB7FD\uAC8C \uB9CC\uB4E4\uC5B4 \uC11E\uB294 \uACE0\uC0C1 \uC6A9\uC811(Solid-state welding)\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s9q6",
    "set": 9,
    "num": 6,
    "difficulty": "medium",
    "category": "\uC6A9\uC811\uC758 \uC885\uB958",
    "question": "Brazing \uACF5\uC815 \uC2DC \uC811\uD569\uBD80\uC758 \uBAA8\uC138\uAD00 \uD604\uC0C1(Capillary action)\uC774 \uAC00\uC7A5 \uC798 \uC77C\uC5B4\uB098\uAE30 \uC704\uD55C \uB450 \uBAA8\uC7AC \uC0AC\uC774\uC758 \uCD5C\uC801 \uAC04\uADF9(Clearance) \uBC94\uC704\uB294 \uB300\uB7B5 \uC5BC\uB9C8\uC778\uAC00?",
    "options": [
      "0.05 ~ 0.2 mm",
      "1.0 ~ 2.0 mm",
      "3.0 ~ 5.0 mm",
      "\uB531 \uBD99\uC5B4 \uC788\uC5B4\uC57C \uD568 (0 mm)"
    ],
    "correctIndex": 0,
    "explanation": "Brazing\uC5D0\uC11C \uC6A9\uC735\uB41C \uC6A9\uAC00\uC7AC\uAC00 \uD2C8\uC0C8\uB85C \uC6D0\uD65C\uD558\uAC8C \uBE68\uB824 \uB4E4\uC5B4\uAC00\uB824\uBA74 0.05~0.2mm \uC815\uB3C4\uC758 \uB9E4\uC6B0 \uC881\uACE0 \uC77C\uC815\uD55C \uAC04\uADF9\uC774 \uD544\uC694\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s9q7",
    "set": 9,
    "num": 7,
    "difficulty": "easy",
    "category": "\uC544\uD06C\uC758 \uC774\uD574",
    "question": "Welding arc\uC5D0\uC11C \uBC29\uCD9C\uB418\uB294 \uAD11\uC120 \uC911 \uD53C\uBD80\uC5D0 \uB178\uCD9C\uB418\uC5C8\uC744 \uB54C \uAC00\uC7A5 \uC2EC\uAC01\uD55C \uD654\uC0C1(\uD64D\uBC18)\uC744 \uC720\uBC1C\uD558\uB294 \uAD11\uC120\uC740?",
    "options": [
      "Visible light",
      "Infrared ray",
      "Ultraviolet ray",
      "X-ray"
    ],
    "correctIndex": 2,
    "explanation": "Ultraviolet ray(\uC790\uC678\uC120)\uB294 \uC5D0\uB108\uC9C0\uAC00 \uB9E4\uC6B0 \uAC15\uD574 \uC9E7\uC740 \uC2DC\uAC04 \uB178\uCD9C\uB85C\uB3C4 \uAC01\uB9C9\uC5FC\uACFC \uC2EC\uAC01\uD55C \uD53C\uBD80 \uD654\uC0C1\uC744 \uC77C\uC73C\uD0B5\uB2C8\uB2E4."
  },
  {
    "id": "s9q8",
    "set": 9,
    "num": 8,
    "difficulty": "medium",
    "category": "\uC544\uD06C\uC758 \uC774\uD574",
    "question": "GTAW \uC791\uC5C5 \uC911 Arc length\uB97C \uC77C\uC815\uD558\uAC8C \uC720\uC9C0\uD558\uC9C0 \uBABB\uD558\uACE0 \uC218\uC2DC\uB85C \uBCC0\uD558\uAC8C \uD560 \uB54C \uBC1C\uC0DD\uD558\uB294 \uBB38\uC81C\uC810\uC774 \uC544\uB2CC \uAC83\uC740?",
    "options": [
      "Bead \uD3ED\uC774 \uBD88\uADDC\uCE59\uD574\uC9C4\uB2E4.",
      "Penetration \uAE4A\uC774\uAC00 \uC77C\uC815\uD558\uC9C0 \uC54A\uAC8C \uB41C\uB2E4.",
      "Arc \uC804\uC555\uC774 \uBCC0\uB3D9\uD558\uC5EC \uC785\uC5F4\uB7C9\uC774 \uB2EC\uB77C\uC9C4\uB2E4.",
      "Tungsten \uC804\uADF9\uC758 \uC18C\uBAA8\uAC00 \uC644\uC804\uD788 \uC5C6\uC5B4\uC9C4\uB2E4."
    ],
    "correctIndex": 3,
    "explanation": "Arc length\uAC00 \uBCC0\uD558\uBA74 \uC804\uC555\uACFC \uC785\uC5F4\uB7C9\uC774 \uBCC0\uD558\uC5EC Bead \uD615\uC0C1\uC774 \uBD88\uADDC\uCE59\uD574\uC9D1\uB2C8\uB2E4. \uC804\uADF9 \uC18C\uBAA8\uC640\uB294 \uC9C1\uC811\uC801\uC778 \uC778\uACFC\uAC00 \uC801\uC2B5\uB2C8\uB2E4."
  },
  {
    "id": "s9q9",
    "set": 9,
    "num": 9,
    "difficulty": "easy",
    "category": "\uC6A9\uC811 \uACB0\uD568",
    "question": "\uC6A9\uC811 Bead\uAC00 \uB05D\uB098\uB294 \uC9C0\uC810(\uC885\uC810)\uC744 \uC6C0\uD479 \uD30C\uC778 \uC0C1\uD0DC\uB85C \uADF8\uB300\uB85C \uB450\uBA74 \uC751\uACE0 \uC2DC \uC218\uCD95\uC73C\uB85C \uC778\uD574 \uBBF8\uC138\uD55C Crack\uC774 \uBC1C\uC0DD\uD558\uAE30 \uC27D\uB2E4. \uC774 \uACB0\uD568\uC758 \uBA85\uCE6D\uC740?",
    "options": [
      "Arc strike",
      "Crater crack",
      "Overlap",
      "Spatter"
    ],
    "correctIndex": 1,
    "explanation": "\uC6A9\uC735\uC9C0 \uB05D\uBD80\uBD84(Crater)\uC744 \uC81C\uB300\uB85C \uCC44\uC6B0\uC9C0 \uC54A\uACE0 \uAE09\uB0C9\uC2DC\uD0A4\uBA74 \uC218\uCD95 \uC751\uB825\uC774 \uC9D1\uC911\uB418\uC5B4 \uAC08\uB77C\uC9C0\uB294 Crater crack\uC774 \uBC1C\uC0DD\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s9q10",
    "set": 9,
    "num": 10,
    "difficulty": "medium",
    "category": "\uC6A9\uC811 \uACB0\uD568",
    "question": "Tungsten inclusion \uACB0\uD568\uC774 \uC0DD\uACBC\uC744 \uB54C \uC62C\uBC14\uB978 \uC870\uCE58 \uBC29\uBC95\uC740?",
    "options": [
      "\uADF8 \uC704\uC5D0 \uACE0\uC804\uB958\uB85C \uB2E4\uC2DC \uC6A9\uC811\uD558\uC5EC \uB179\uC5EC\uBC84\uB9B0\uB2E4.",
      "Grinder\uB85C \uD574\uB2F9 \uBD80\uC704\uB97C \uC644\uC804\uD788 \uD30C\uB0B4\uC5B4 \uC81C\uAC70\uD55C \uD6C4 \uB2E4\uC2DC \uC6A9\uC811\uD55C\uB2E4.",
      "\uB9DD\uCE58\uB85C \uB450\uB4DC\uB824(Peening) \uD3C9\uD3C9\uD558\uAC8C \uB9CC\uB4E0\uB2E4.",
      "\uACB0\uD568\uC774 \uC791\uC73C\uBA74 \uBB34\uC2DC\uD558\uACE0 \uB2E4\uC74C Pass\uB97C \uC9C4\uD589\uD55C\uB2E4."
    ],
    "correctIndex": 1,
    "explanation": "Tungsten\uC740 \uC6A9\uC735\uC810\uC774 \uCCA0\uBCF4\uB2E4 \uB450 \uBC30 \uC774\uC0C1 \uB192\uC544 \uC6A9\uC811\uC5F4\uB85C \uB2E4\uC2DC \uB179\uC77C \uC218 \uC5C6\uC73C\uBBC0\uB85C, \uBC18\uB4DC\uC2DC \uBB3C\uB9AC\uC801\uC73C\uB85C \uC644\uC804\uD788 \uD30C\uB0B4\uC57C \uD569\uB2C8\uB2E4."
  },
  {
    "id": "s9q11",
    "set": 9,
    "num": 11,
    "difficulty": "hard",
    "category": "\uC6A9\uC811 \uACB0\uD568",
    "question": "\uC2A4\uD14C\uC778\uB9AC\uC2A4\uAC15 Pipe \uC6A9\uC811 \uC2DC, Pipe \uB0B4\uBD80\uC5D0 Ar gas\uB97C \uCDA9\uC804\uD558\uB294 Back purging\uC744 \uC18C\uD640\uD788 \uD588\uC744 \uB54C Root \uC774\uBA74 \uBE44\uB4DC\uC5D0 \uBC1C\uC0DD\uD558\uB294 \uCE58\uBA85\uC801\uC778 \uC0B0\uD654 \uACB0\uD568\uC744 \uBB34\uC5C7\uC774\uB77C \uBD80\uB974\uB294\uAC00?",
    "options": [
      "Sugaring",
      "Cold lap",
      "Lamellar tearing",
      "Blow hole"
    ],
    "correctIndex": 0,
    "explanation": "Back purging \uBD88\uB7C9\uC73C\uB85C \uACE0\uC628\uC758 \uC2A4\uD14C\uC778\uB9AC\uC2A4 \uC774\uBA74\uC774 \uC0B0\uC18C\uC640 \uBC18\uC751\uD558\uC5EC \uC124\uD0D5\uC744 \uBFCC\uB9B0 \uAC83\uCC98\uB7FC \uAC80\uACE0 \uAC70\uCE60\uAC8C \uD0C0\uBC84\uB9AC\uB294 \uC0B0\uD654 \uACB0\uD568\uC744 \uD604\uC7A5 \uC6A9\uC5B4\uB85C Sugaring\uC774\uB77C\uACE0 \uD569\uB2C8\uB2E4."
  },
  {
    "id": "s9q12",
    "set": 9,
    "num": 12,
    "difficulty": "easy",
    "category": "\uBE44\uD30C\uAD34 \uAC80\uC0AC",
    "question": "\uB0B4\uBD80\uC758 \uACB0\uD568\uC744 \uAC80\uC0AC\uD558\uB294 RT(Radiographic Testing) \uD544\uB984\uC5D0\uC11C Porosity\uB294 \uC5B4\uB5A4 \uC0C9\uC0C1\uC73C\uB85C \uB098\uD0C0\uB098\uB294\uAC00?",
    "options": [
      "\uC8FC\uBCC0\uBCF4\uB2E4 \uBC1D\uC740 \uD770\uC0C9",
      "\uC8FC\uBCC0\uBCF4\uB2E4 \uC5B4\uB450\uC6B4 \uAC80\uC740\uC0C9",
      "\uBD89\uC740\uC0C9",
      "\uB178\uB780\uC0C9"
    ],
    "correctIndex": 1,
    "explanation": "Porosity\uB294 \uB0B4\uBD80\uAC00 \uBE48 \uACF5\uAC04\uC774\uBBC0\uB85C \uBC29\uC0AC\uC120\uC774 \uB354 \uB9CE\uC774 \uD22C\uACFC\uD558\uC5EC \uD544\uB984\uC744 \uB354 \uB9CE\uC774 \uAC10\uAD11\uC2DC\uD0A4\uBBC0\uB85C \uAC80\uC740\uC0C9 \uC810\uC73C\uB85C \uB098\uD0C0\uB0A9\uB2C8\uB2E4."
  },
  {
    "id": "s9q13",
    "set": 9,
    "num": 13,
    "difficulty": "medium",
    "category": "\uBE44\uD30C\uAD34 \uAC80\uC0AC",
    "question": "ET(Eddy Current Testing)\uB97C \uC801\uC6A9\uD560 \uC218 \uC5C6\uB294 \uC7AC\uC9C8\uC740 \uBB34\uC5C7\uC778\uAC00?",
    "options": [
      "Carbon steel",
      "Aluminum",
      "Copper",
      "Plastic"
    ],
    "correctIndex": 3,
    "explanation": "ET\uB294 \uC804\uAE30\uAC00 \uD1B5\uD558\uB294 \uB3C4\uCCB4\uC5D0 \uC720\uB3C4\uB418\uB294 \uC640\uC804\uB958\uC758 \uBCC0\uD654\uB97C \uCE21\uC815\uD558\uBBC0\uB85C, \uBD80\uB3C4\uCCB4\uC778 Plastic\uC774\uB098 \uC138\uB77C\uBBF9\uC5D0\uB294 \uC801\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4."
  },
  {
    "id": "s9q14",
    "set": 9,
    "num": 14,
    "difficulty": "easy",
    "category": "\uC7AC\uB8CC \uBC0F \uC131\uBD84",
    "question": "\uC6A9\uC811\uC131\uC774 \uAC00\uC7A5 \uC6B0\uC218\uD558\uC5EC \uD604\uC7A5\uC5D0\uC11C \uAC00\uC7A5 \uB110\uB9AC \uC0AC\uC6A9\uB418\uBA70, \uD0C4\uC18C \uD568\uC720\uB7C9\uC774 \uC57D 0.1~0.3%\uC778 \uAC15\uC7AC\uB294?",
    "options": [
      "High carbon steel",
      "Cast iron",
      "Mild steel",
      "Tool steel"
    ],
    "correctIndex": 2,
    "explanation": "Mild steel(\uC5F0\uAC15)\uC740 \uD0C4\uC18C\uB7C9\uC774 \uC801\uC5B4 \uC6A9\uC811 \uD6C4 \uAE09\uB7AD\uC5D0 \uC758\uD55C \uACBD\uD654\uB098 Crack \uBC1C\uC0DD \uC704\uD5D8\uC774 \uB9E4\uC6B0 \uC801\uC5B4 \uC6A9\uC811\uC131\uC774 \uB6F0\uC5B4\uB0A9\uB2C8\uB2E4."
  },
  {
    "id": "s9q15",
    "set": 9,
    "num": 15,
    "difficulty": "medium",
    "category": "\uC7AC\uB8CC \uBC0F \uC131\uBD84",
    "question": "\uAC15\uC7AC\uC758 CE(Carbon Equivalent) \uAC12\uC774 \uB192\uC544\uC9C8 \uB54C \uC6A9\uC811\uBD80\uC5D0 \uB098\uD0C0\uB098\uB294 \uD604\uC0C1\uC73C\uB85C \uAC00\uC7A5 \uC62C\uBC14\uB978 \uAC83\uC740?",
    "options": [
      "\uC5F0\uC131(Ductility)\uC774 \uD06C\uAC8C \uC99D\uAC00\uD55C\uB2E4.",
      "\uC6A9\uC811\uC131\uC774 \uC88B\uC544\uC838 Pre-heating\uC774 \uD544\uC694 \uC5C6\uC5B4\uC9C4\uB2E4.",
      "\uC5F4\uC601\uD5A5\uBD80(HAZ)\uC758 \uACBD\uD654\uAC00 \uC2EC\uD574\uC838 Cold crack \uBC1C\uC0DD \uC704\uD5D8\uC774 \uCEE4\uC9C4\uB2E4.",
      "\uC5F4\uC804\uB3C4\uC728\uC774 \uAE09\uACA9\uD788 \uD5A5\uC0C1\uB41C\uB2E4."
    ],
    "correctIndex": 2,
    "explanation": "CE(\uD0C4\uC18C \uB2F9\uB7C9)\uB294 \uAC15\uC7AC\uC758 \uACBD\uD654\uC131\uC744 \uD0C4\uC18C \uAE30\uC900\uC73C\uB85C \uD658\uC0B0\uD55C \uAC12\uC73C\uB85C, \uC774 \uAC12\uC774 \uD074\uC218\uB85D \uC6A9\uC811 \uD6C4 \uB2E8\uB2E8\uD574\uC9C0\uACE0 \uAE68\uC9C0\uAE30 \uC26C\uC6B0\uBBC0\uB85C Pre-heating\uC774 \uD544\uC218\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s9q16",
    "set": 9,
    "num": 16,
    "difficulty": "easy",
    "category": "\uC6A9\uC811 \uADF9\uC131",
    "question": "DCEN \uADF9\uC131\uC744 \uC0AC\uC6A9\uD558\uC5EC Aluminum\uC744 GTAW \uC6A9\uC811\uD558\uB824 \uD560 \uB54C \uAC00\uC7A5 \uD070 \uBB38\uC81C\uC810\uC740?",
    "options": [
      "Penetration\uC774 \uB108\uBB34 \uC595\uC544\uC9C4\uB2E4.",
      "\uD45C\uBA74\uC758 \uB2E8\uB2E8\uD55C \uC0B0\uD654\uC54C\uB8E8\uBBF8\uB284 \uD53C\uB9C9\uC774 \uC81C\uAC70\uB418\uC9C0 \uC54A\uC544 \uC1F3\uBB3C\uC774 \uC11E\uC774\uC9C0 \uC54A\uB294\uB2E4.",
      "Tungsten \uC804\uADF9\uC774 \uC21C\uC2DD\uAC04\uC5D0 \uB179\uC544\uB0B4\uB9B0\uB2E4.",
      "Arc\uAC00 \uC804\uD600 \uBC1C\uC0DD\uD558\uC9C0 \uC54A\uB294\uB2E4."
    ],
    "correctIndex": 1,
    "explanation": "Aluminum \uC6A9\uC811\uC5D0\uB294 \uC0B0\uD654\uB9C9\uC744 \uD30C\uAD34\uD558\uB294 Cleaning action\uC774 \uD544\uC218\uC801\uC778\uB370, DCEN\uC5D0\uB294 \uC774 \uAE30\uB2A5\uC774 \uC5C6\uC5B4 \uC6A9\uC811\uC774 \uBD88\uAC00\uB2A5\uD569\uB2C8\uB2E4. (DCEP\uB098 AC \uD544\uC694)"
  },
  {
    "id": "s9q17",
    "set": 9,
    "num": 17,
    "difficulty": "hard",
    "category": "\uC6A9\uC811 \uADF9\uC131",
    "question": "\uCD5C\uC2E0 Inverter GTAW \uC6A9\uC811\uAE30\uC5D0\uC11C \uC81C\uACF5\uD558\uB294 AC Square wave\uAC00 \uAE30\uC874 \uBCC0\uC555\uAE30\uD615\uC758 Sine wave\uBCF4\uB2E4 \uC6B0\uC218\uD55C \uC810\uC740 \uBB34\uC5C7\uC778\uAC00?",
    "options": [
      "\uADF9\uC131\uC774 \uBC14\uB00C\uB294 \uC2DC\uC810(Zero crossing)\uC744 \uD1B5\uACFC\uD558\uB294 \uC2DC\uAC04\uC774 \uB9E4\uC6B0 \uC9E7\uC544 Arc\uAC00 \uAEBC\uC9C0\uC9C0 \uC54A\uACE0 \uC548\uC815\uC801\uC774\uB2E4.",
      "\uC8FC\uD30C\uC218\uB97C 60Hz\uB85C\uB9CC \uACE0\uC815\uD560 \uC218 \uC788\uC5B4 \uC870\uC791\uC774 \uAC04\uD3B8\uD558\uB2E4.",
      "OCV\uAC00 0V\uC774\uB2E4.",
      "\uC804\uB825 \uC18C\uBAA8\uAC00 10\uBC30 \uC774\uC0C1 \uB192\uB2E4."
    ],
    "correctIndex": 0,
    "explanation": "Square wave(\uAD6C\uD615\uD30C)\uB294 \uC218\uC9C1\uC5D0 \uAC00\uAE5D\uAC8C \uADF9\uC131\uC774 \uC804\uD658\uB418\uBBC0\uB85C 0\uBCFC\uD2B8 \uC9C0\uC810\uC744 \uC21C\uC2DD\uAC04\uC5D0 \uC9C0\uB098\uAC00 Arc \uB04A\uAE40\uC774 \uC5C6\uACE0 \uACE0\uC8FC\uD30C\uB97C \uACC4\uC18D \uCF24 \uD544\uC694\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4."
  },
  {
    "id": "s9q18",
    "set": 9,
    "num": 18,
    "difficulty": "medium",
    "category": "\uC804\uC6D0 \uD2B9\uC131",
    "question": "\uC6A9\uC811\uAE30\uC758 \uC131\uB2A5\uC744 \uB098\uD0C0\uB0B4\uB294 \uC9C0\uD45C \uC911 \uD558\uB098\uC778 OCV(Open Circuit Voltage)\uAC00 \uB108\uBB34 \uB192\uAC8C \uC124\uACC4\uB418\uC5C8\uC744 \uB54C \uBC1C\uC0DD\uD560 \uC218 \uC788\uB294 \uAC00\uC7A5 \uD070 \uB2E8\uC810\uC740?",
    "options": [
      "Arc start\uAC00 \uB9E4\uC6B0 \uC5B4\uB824\uC6CC\uC9C4\uB2E4.",
      "\uC6A9\uC811 \uC804\uB958\uAC00 \uC77C\uC815\uD558\uAC8C \uC720\uC9C0\uB418\uC9C0 \uC54A\uB294\uB2E4.",
      "\uC791\uC5C5\uC790\uAC00 \uC804\uADF9\uACFC \uBAA8\uC7AC\uC5D0 \uC811\uCD09 \uC2DC \uAC10\uC804(Electric shock)\uB420 \uC704\uD5D8\uC774 \uCEE4\uC9C4\uB2E4.",
      "\uC6A9\uC811\uAE30\uC758 \uBB34\uAC8C\uAC00 \uAC00\uBCBC\uC6CC\uC9C4\uB2E4."
    ],
    "correctIndex": 2,
    "explanation": "OCV(\uBB34\uBD80\uD558 \uC804\uC555)\uAC00 \uB192\uC73C\uBA74 \uC544\uD06C \uBC1C\uC0DD\uC740 \uB9E4\uC6B0 \uC26C\uC6CC\uC9C0\uC9C0\uB9CC, \uC548\uC804 \uC804\uC555\uC744 \uCD08\uACFC\uD558\uBBC0\uB85C \uC778\uCCB4 \uC811\uCD09 \uC2DC \uCE58\uBA85\uC801\uC778 \uAC10\uC804 \uC704\uD5D8\uC774 \uC788\uC2B5\uB2C8\uB2E4."
  },
  {
    "id": "s9q19",
    "set": 9,
    "num": 19,
    "difficulty": "easy",
    "category": "\uC785\uC5F4\uB7C9\uACFC \uBCC0\uD615",
    "question": "Multi-pass welding\uC744 \uD560 \uB54C, \uB2E4\uC74C Pass\uB97C \uC62C\uB9AC\uAE30 \uC804\uC5D0 \uC720\uC9C0\uD574\uC57C \uD558\uB294 Interpass temperature\uB97C \uAD00\uB9AC\uD558\uB294 \uC8FC\uB41C \uC774\uC720\uB294?",
    "options": [
      "\uC6A9\uC811 \uC2DC\uAC04\uC744 \uB2E8\uCD95\uD558\uAE30 \uC704\uD574",
      "\uBAA8\uC7AC\uC758 \uBAA8\uC591\uC744 \uC608\uC058\uAC8C \uB9CC\uB4E4\uAE30 \uC704\uD574",
      "\uACFC\uC5F4\uC5D0 \uC758\uD55C \uACB0\uC815\uB9BD \uC870\uB300\uD654\uB97C \uB9C9\uACE0 \uAE30\uACC4\uC801 \uC131\uC9C8 \uC800\uD558\uB97C \uBC29\uC9C0\uD558\uAE30 \uC704\uD574",
      "Gas \uC18C\uBAA8\uB7C9\uC744 \uC904\uC774\uAE30 \uC704\uD574"
    ],
    "correctIndex": 2,
    "explanation": "\uCE35\uAC04 \uC628\uB3C4\uAC00 \uB108\uBB34 \uB192\uAC8C \uB204\uC801\uB418\uBA74 \uC1F3\uBB3C\uC774 \uCC9C\uCC9C\uD788 \uC2DD\uC5B4 \uAE08\uC18D \uC870\uC9C1\uC774 \uAC70\uCE60\uC5B4\uC9C0\uACE0 \uC778\uC131\uC774 \uB5A8\uC5B4\uC9C0\uBBC0\uB85C, \uC801\uC815 \uC628\uB3C4 \uC774\uD558\uB85C \uC2DD\uD78C \uD6C4 \uC9C4\uD589\uD574\uC57C \uD569\uB2C8\uB2E4."
  },
  {
    "id": "s9q20",
    "set": 9,
    "num": 20,
    "difficulty": "medium",
    "category": "\uC785\uC5F4\uB7C9\uACFC \uBCC0\uD615",
    "question": "\uC6A9\uC811 \uD6C4 \uBC1C\uC0DD\uD558\uB294 Residual stress\uC640 Deformation\uC758 \uAD00\uACC4\uC5D0 \uB300\uD55C \uC124\uBA85\uC73C\uB85C \uC62C\uBC14\uB978 \uAC83\uC740?",
    "options": [
      "Strongback\uC774\uB098 Jig\uB85C \uBAA8\uC7AC\uB97C \uAC15\uD558\uAC8C \uAD6C\uC18D\uD558\uBA74 \uBCC0\uD615\uB3C4 \uCEE4\uC9C0\uACE0 \uC794\uB958 \uC751\uB825\uB3C4 \uCEE4\uC9C4\uB2E4.",
      "\uBAA8\uC7AC\uB97C \uAC15\uD558\uAC8C \uAD6C\uC18D\uD558\uBA74 \uC678\uD615\uC801\uC778 \uBCC0\uD615\uC740 \uC904\uC5B4\uB4E4\uC9C0\uB9CC, \uB0B4\uBD80\uC5D0 \uAC07\uD78C \uC794\uB958 \uC751\uB825\uC740 \uC624\uD788\uB824 \uC99D\uAC00\uD558\uC5EC Crack \uC704\uD5D8\uC774 \uCEE4\uC9C4\uB2E4.",
      "\uC794\uB958 \uC751\uB825\uACFC \uBCC0\uD615\uC740 \uC544\uBB34\uB7F0 \uC0C1\uAD00\uAD00\uACC4\uAC00 \uC5C6\uB2E4.",
      "\uC6A9\uC811 \uC18D\uB3C4\uB97C \uBB34\uD55C\uC815 \uCC9C\uCC9C\uD788 \uD558\uBA74 \uB450 \uAC00\uC9C0 \uBAA8\uB450 \uC644\uBCBD\uD788 \uC81C\uAC70\uB41C\uB2E4."
    ],
    "correctIndex": 1,
    "explanation": "\uBAA8\uC7AC\uB97C \uACE0\uC815\uD558\uC5EC \uC6C0\uC9C1\uC774\uC9C0 \uBABB\uD558\uAC8C \uB9C9\uC73C\uBA74 \uAC01\uBCC0\uD615\uC740 \uC5B5\uC81C\uB418\uC9C0\uB9CC, \uC218\uCD95\uD558\uB824\uB294 \uD798\uC774 \uD480\uB9AC\uC9C0 \uBABB\uD574 \uAE08\uC18D \uB0B4\uBD80\uC5D0 \uC794\uB958 \uC751\uB825\uC73C\uB85C \uC313\uC774\uAC8C \uB429\uB2C8\uB2E4."
  },
  {
    "id": "s10q1",
    "set": 10,
    "num": 1,
    "difficulty": "easy",
    "category": "\uC6A9\uC811\uACFC \uAD00\uB828\uB41C \uC548\uC804",
    "question": "GTAW \uC791\uC5C5 \uC2DC \uBC1C\uC0DD\uD558\uB294 \uC720\uD574 \uAC00\uC2A4 \uBC0F Fume\uC744 \uC81C\uAC70\uD558\uAE30 \uC704\uD574 \uAC00\uC7A5 \uBA3C\uC800 \uC124\uCE58\uD574\uC57C \uD558\uB294 \uC548\uC804 \uC124\uBE44\uB294?",
    "options": [
      "\uC804\uACA9 \uBC29\uC9C0\uAE30",
      "\uAD6D\uC18C \uBC30\uAE30 \uC7A5\uCE58 (Local exhaust ventilation)",
      "\uC790\uB3D9 \uC18C\uD654\uAE30",
      "\uAC00\uC2A4 \uB204\uCD9C \uACBD\uBCF4\uAE30"
    ],
    "correctIndex": 1,
    "explanation": "Fume\uACFC \uC624\uC874(O3) \uB4F1 \uC720\uD574 \uBB3C\uC9C8\uC774 \uC791\uC5C5\uC790\uC758 \uD638\uD761\uAE30\uB85C \uB4E4\uC5B4\uAC00\uAE30 \uC804\uC5D0 \uC989\uC2DC \uBE68\uC544\uB4E4\uC774\uB294 \uAD6D\uC18C \uBC30\uAE30 \uC7A5\uCE58\uAC00 \uAC00\uC7A5 \uD544\uC218\uC801\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s10q2",
    "set": 10,
    "num": 2,
    "difficulty": "easy",
    "category": "\uC6A9\uC811\uACFC \uAD00\uB828\uB41C \uC548\uC804",
    "question": "\uC6A9\uC811 \uC791\uC5C5 \uC911 \uAC10\uC804(Electric shock) \uC0AC\uACE0\uB97C \uC608\uBC29\uD558\uAE30 \uC704\uD55C \uC62C\uBC14\uB978 \uBCF5\uC7A5 \uC0C1\uD0DC\uB294?",
    "options": [
      "\uB540\uC5D0 \uD760\uBED1 \uC816\uC740 \uBA74\uC7A5\uAC11",
      "\uAE30\uB984\uC774 \uBB3B\uC740 \uC587\uC740 \uC791\uC5C5\uBCF5",
      "\uAC74\uC870\uD558\uACE0 \uCC22\uC5B4\uC9C0\uC9C0 \uC54A\uC740 \uAC00\uC8FD \uC7A5\uAC11 \uBC0F \uC808\uC5F0 \uC548\uC804\uD654",
      "\uBC18\uC18C\uB9E4 \uD2F0\uC154\uCE20"
    ],
    "correctIndex": 2,
    "explanation": "\uB540\uC774\uB098 \uBB3C\uC740 \uC804\uAE30 \uC800\uD56D\uC744 \uAE09\uACA9\uD788 \uB0AE\uCDB0 \uAC10\uC804 \uC704\uD5D8\uC744 \uB192\uC774\uBBC0\uB85C, \uD56D\uC0C1 \uAC74\uC870\uD55C \uC808\uC5F0 \uBCF4\uD638\uAD6C\uB97C \uCC29\uC6A9\uD574\uC57C \uD569\uB2C8\uB2E4."
  },
  {
    "id": "s10q3",
    "set": 10,
    "num": 3,
    "difficulty": "easy",
    "category": "\uC7A5\uBE44 \uBC0F \uB3C4\uAD6C",
    "question": "Tungsten \uC804\uADF9\uBD09\uC744 \uC5F0\uB9C8(Grinding)\uD560 \uB54C \uC62C\uBC14\uB978 \uBC29\uD5A5\uC740?",
    "options": [
      "\uC804\uADF9\uBD09\uC758 \uAC00\uB85C \uBC29\uD5A5",
      "\uC804\uADF9\uBD09\uC758 \uAE38\uC774(\uC138\uB85C) \uBC29\uD5A5",
      "\uB098\uC120\uD615 \uBC29\uD5A5",
      "\uC5F0\uB9C8\uD558\uC9C0 \uC54A\uACE0 \uBD80\uB7EC\uB728\uB824 \uC0AC\uC6A9"
    ],
    "correctIndex": 1,
    "explanation": "\uC804\uADF9\uBD09\uC758 \uAC00\uB85C \uBC29\uD5A5\uC73C\uB85C \uACB0\uC774 \uB098\uBA74 Arc\uAC00 \uD754\uB4E4\uB9AC\uACE0 \uBD88\uC548\uC815\uD574\uC9C0\uBBC0\uB85C \uBC18\uB4DC\uC2DC \uAE38\uC774 \uBC29\uD5A5\uC73C\uB85C \uC5F0\uB9C8\uD574\uC57C \uD569\uB2C8\uB2E4."
  },
  {
    "id": "s10q4",
    "set": 10,
    "num": 4,
    "difficulty": "medium",
    "category": "\uC7A5\uBE44 \uBC0F \uB3C4\uAD6C",
    "question": "CO2 \uC6A9\uC811(GMAW)\uACFC \uB2EC\uB9AC, GTAW\uC5D0\uC11C Ar \uAC00\uC2A4 Regulator(\uC870\uC815\uAE30)\uC5D0 Heater(\uAC00\uC5F4\uAE30)\uAC00 \uAE30\uBCF8\uC801\uC73C\uB85C \uC7A5\uCC29\uB418\uC9C0 \uC54A\uB294 \uAC00\uC7A5 \uD070 \uC774\uC720\uB294?",
    "options": [
      "Ar \uAC00\uC2A4\uAC00 \uB354 \uCC28\uAC11\uAE30 \uB54C\uBB38\uC5D0",
      "Ar \uAC00\uC2A4\uB294 \uAE30\uCCB4 \uC0C1\uD0DC\uB85C \uCDA9\uC804\uB418\uC5B4 \uBC29\uCD9C \uC2DC \uAE30\uD654\uC5F4\uC5D0 \uC758\uD55C \uACB0\uBE59(Freezing) \uD604\uC0C1\uC774 \uC5C6\uAE30 \uB54C\uBB38\uC5D0",
      "Ar \uAC00\uC2A4\uB294 \uBD88\uC774 \uBD99\uAE30 \uC26C\uC6CC \uAC00\uC5F4\uD558\uBA74 \uC704\uD5D8\uD558\uAE30 \uB54C\uBB38\uC5D0",
      "Heater\uB97C \uB2EC\uBA74 Gas \uC720\uB7C9\uC774 \uC904\uC5B4\uB4E4\uAE30 \uB54C\uBB38\uC5D0"
    ],
    "correctIndex": 1,
    "explanation": "CO2\uB294 \uC561\uCCB4\uB85C \uCDA9\uC804\uB418\uC5B4 \uAE30\uD654 \uC2DC \uC8FC\uBCC0 \uC5F4\uC744 \uBE7C\uC557\uC544 Regulator\uAC00 \uC5BC\uC5B4\uBD99\uC9C0\uB9CC, Ar\uC740 \uACE0\uC555 \uAE30\uCCB4\uB85C \uCDA9\uC804\uB418\uC5B4 \uACB0\uBE59 \uD604\uC0C1\uC774 \uC5C6\uC2B5\uB2C8\uB2E4."
  },
  {
    "id": "s10q5",
    "set": 10,
    "num": 5,
    "difficulty": "easy",
    "category": "\uC6A9\uC811\uC758 \uC885\uB958",
    "question": "\uB2E4\uC74C \uC911 \uC5F4\uC744 \uAC00\uD574 \uBAA8\uC7AC\uB97C \uC644\uC804\uD788 \uB179\uC5EC\uC11C \uC811\uD569\uD558\uB294 Fusion welding(\uC6A9\uC735 \uC6A9\uC811)\uC5D0 \uC18D\uD558\uC9C0 \uC54A\uB294 \uAC83\uC740?",
    "options": [
      "GTAW",
      "SMAW",
      "Friction welding (\uB9C8\uCC30 \uC6A9\uC811)",
      "GMAW"
    ],
    "correctIndex": 2,
    "explanation": "\uB9C8\uCC30 \uC6A9\uC811\uC740 \uAE30\uACC4\uC801 \uD68C\uC804\uB825\uC744 \uC774\uC6A9\uD574 \uC5F4\uC744 \uB0B4\uACE0 \uC555\uB825\uC744 \uAC00\uD558\uB294 Solid-state welding(\uACE0\uC0C1 \uC6A9\uC811)\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s10q6",
    "set": 10,
    "num": 6,
    "difficulty": "medium",
    "category": "\uC6A9\uC811\uC758 \uC885\uB958",
    "question": "Brazing(\uACBD\uB0A9\uB55C)\uC5D0\uC11C \uC735\uC735\uB41C \uC6A9\uAC00\uC7AC\uAC00 \uB450 \uBAA8\uC7AC \uC0AC\uC774\uC758 \uC881\uC740 \uD2C8\uC0C8\uB85C \uBE68\uB824 \uB4E4\uC5B4\uAC00\uB294 \uD604\uC0C1\uC744 \uBB34\uC5C7\uC774\uB77C \uD558\uB294\uAC00?",
    "options": [
      "Capillary action (\uBAA8\uC138\uAD00 \uD604\uC0C1)",
      "Skin effect (\uD45C\uD53C \uD6A8\uACFC)",
      "Arc blow (\uC790\uAE30 \uC3E0\uB9BC)",
      "Cleaning action (\uCCAD\uC815 \uC791\uC6A9)"
    ],
    "correctIndex": 0,
    "explanation": "Brazing\uC740 \uBAA8\uC7AC\uB97C \uB179\uC774\uC9C0 \uC54A\uACE0, \uC881\uC740 \uAC04\uADF9 \uC0AC\uC774\uB85C \uC561\uCCB4 \uC0C1\uD0DC\uC758 \uC6A9\uAC00\uC7AC\uAC00 \uBAA8\uC138\uAD00 \uD604\uC0C1\uC5D0 \uC758\uD574 \uC2A4\uBA70\uB4E4\uAC8C \uD558\uC5EC \uC811\uD569\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s10q7",
    "set": 10,
    "num": 7,
    "difficulty": "easy",
    "category": "\uC544\uD06C\uC758 \uC774\uD574",
    "question": "\uC6A9\uC811 \uC911 Torch\uB97C \uC704\uC544\uB798\uB85C \uC6C0\uC9C1\uC5EC Arc length(\uC544\uD06C \uAE38\uC774)\uAC00 \uBCC0\uD560 \uB54C, \uAE38\uC774\uAC00 \uAE38\uC5B4\uC9C0\uBA74 \uC804\uC555(Voltage)\uC740 \uC5B4\uB5BB\uAC8C \uB418\uB294\uAC00?",
    "options": [
      "\uAC10\uC18C\uD55C\uB2E4.",
      "\uC99D\uAC00\uD55C\uB2E4.",
      "\uBCC0\uD568\uC5C6\uB2E4.",
      "0\uC774 \uB41C\uB2E4."
    ],
    "correctIndex": 1,
    "explanation": "Arc length\uAC00 \uAE38\uC5B4\uC9C0\uBA74 \uC800\uD56D\uC774 \uC99D\uAC00\uD558\uBBC0\uB85C \uC774\uB97C \uB6AB\uACE0 \uC804\uAE30\uB97C \uBCF4\uB0B4\uAE30 \uC704\uD574 \uC804\uC555\uC774 \uBE44\uB840\uD558\uC5EC \uC99D\uAC00\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s10q8",
    "set": 10,
    "num": 8,
    "difficulty": "hard",
    "category": "\uC544\uD06C\uC758 \uC774\uD574",
    "question": "\uC9C1\uB958(DC) \uC6A9\uC811 \uC2DC \uC790\uAE30\uC7A5\uC758 \uBD88\uADE0\uD615\uC73C\uB85C Arc\uAC00 \uC3E0\uB9AC\uB294 Arc blow \uD604\uC0C1\uC744 \uC644\uD654\uD558\uAE30 \uC704\uD55C \uB300\uCC45\uC73C\uB85C \uAC70\uB9AC\uAC00 \uBA3C \uAC83\uC740?",
    "options": [
      "AC(\uAD50\uB958) \uC6A9\uC811\uAE30\uB85C \uC804\uD658\uD55C\uB2E4.",
      "Earth(\uC811\uC9C0) \uC704\uCE58\uB97C \uC6A9\uC811\uBD80\uC5D0\uC11C \uCD5C\uB300\uD55C \uBA40\uB9AC \uB454\uB2E4.",
      "Arc length\uB97C \uC9E7\uAC8C \uC720\uC9C0\uD55C\uB2E4.",
      "\uC591\uCABD \uB05D\uC5D0 End tab\uC744 \uC0AC\uC6A9\uD55C\uB2E4."
    ],
    "correctIndex": 1,
    "explanation": "Earth\uAC00 \uB108\uBB34 \uBA40\uAC70\uB098 \uD55C\uCABD\uC73C\uB85C \uCE58\uC6B0\uCE58\uBA74 \uC790\uAE30\uC7A5\uC774 \uD3B8\uD5A5\uB418\uC5B4 Arc blow\uAC00 \uC2EC\uD574\uC9D1\uB2C8\uB2E4. Earth\uB294 2\uAC1C\uB97C \uC591\uCABD\uC5D0 \uBB3C\uB9AC\uAC70\uB098 \uC6A9\uC811\uBD80 \uAC00\uAE4C\uC774 \uB450\uC5B4\uC57C \uD569\uB2C8\uB2E4."
  },
  {
    "id": "s10q9",
    "set": 10,
    "num": 9,
    "difficulty": "easy",
    "category": "\uC6A9\uC811 \uACB0\uD568",
    "question": "\uC785\uC5F4\uB7C9(Heat input)\uC774 \uBAA8\uC7AC \uB450\uAED8\uC5D0 \uBE44\uD574 \uB108\uBB34 \uACFC\uB3C4\uD558\uC5EC \uC1F3\uBB3C\uC774 \uBC11\uC73C\uB85C \uC644\uC804\uD788 \uC3DF\uC544\uC838 \uB0B4\uB824 \uAD6C\uBA4D\uC774 \uB6AB\uB9AC\uB294 \uACB0\uD568\uC740?",
    "options": [
      "Undercut",
      "Porosity",
      "Burn-through",
      "Overlap"
    ],
    "correctIndex": 2,
    "explanation": "\uB108\uBB34 \uB192\uC740 Current \uB610\uB294 \uB108\uBB34 \uB290\uB9B0 \uC6B4\uBD09 \uC18D\uB3C4\uB85C \uC778\uD574 \uC644\uC804\uD788 \uB179\uC544\uB0B4\uB9AC\uB294 \uACB0\uD568\uC744 Burn-through\uB77C\uACE0 \uD569\uB2C8\uB2E4."
  },
  {
    "id": "s10q10",
    "set": 10,
    "num": 10,
    "difficulty": "hard",
    "category": "\uC6A9\uC811 \uACB0\uD568",
    "question": "\uC6A9\uC811\uC774 \uC644\uB8CC\uB41C \uD6C4 \uC0C1\uC628\uC73C\uB85C \uC2DD\uC740 \uC0C1\uD0DC\uC5D0\uC11C, \uBAA8\uC7AC \uB0B4\uBD80\uC5D0 \uCE68\uD22C\uD574 \uC788\uB358 Hydrogen(\uC218\uC18C) \uAC00\uC2A4\uAC00 \uD33D\uCC3D\uD558\uBA70 \uC2DC\uAC04 \uC9C0\uC5F0\uC744 \uB450\uACE0 \uBC1C\uC0DD\uD558\uB294 \uADE0\uC5F4\uC740?",
    "options": [
      "Hot crack",
      "Cold crack",
      "Crater crack",
      "Solidification crack"
    ],
    "correctIndex": 1,
    "explanation": "\uC218\uC18C\uC5D0 \uC758\uD55C \uC9C0\uC5F0 \uADE0\uC5F4\uC740 \uB0C9\uAC01\uC774 \uB05D\uB09C \uD6C4 \uC218 \uC2DC\uAC04~\uC218\uC77C \uB4A4\uC5D0 \uBC1C\uC0DD\uD558\uBBC0\uB85C Cold crack(\uC800\uC628 \uADE0\uC5F4)\uC774\uB77C \uBD80\uB974\uBA70, \uC774\uB97C \uB9C9\uAE30 \uC704\uD574 Pre-heating(\uC608\uC5F4)\uC744 \uC2E4\uC2DC\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s10q11",
    "set": 10,
    "num": 11,
    "difficulty": "easy",
    "category": "\uBE44\uD30C\uAD34 \uAC80\uC0AC",
    "question": "\uBAA8\uC7AC \uD45C\uBA74\uC758 \uACB0\uD568 \uC5EC\uBD80, Bead\uC758 \uC678\uAD00, Undercut \uB4F1\uC744 \uAC80\uC0AC\uC6D0\uC774 \uB208\uACFC \uB3CB\uBCF4\uAE30, \uC6A9\uC811 \uAC8C\uC774\uC9C0\uB85C \uD655\uC778\uD558\uB294 \uAE30\uCD08\uC801\uC778 \uAC80\uC0AC\uB294?",
    "options": [
      "VT (Visual Testing)",
      "RT (Radiographic Testing)",
      "UT (Ultrasonic Testing)",
      "PT (Penetrant Testing)"
    ],
    "correctIndex": 0,
    "explanation": "\uC721\uC548 \uAC80\uC0AC(VT)\uB294 \uBAA8\uB4E0 \uAC80\uC0AC\uC758 \uAE30\uBCF8\uC774\uBA70 \uACB0\uD568 \uC720\uBB34\uB97C 1\uCC28\uC801\uC73C\uB85C \uD310\uBCC4\uD569\uB2C8\uB2E4."
  },
  {
    "id": "s10q12",
    "set": 10,
    "num": 12,
    "difficulty": "medium",
    "category": "\uBE44\uD30C\uAD34 \uAC80\uC0AC",
    "question": "UT(\uCD08\uC74C\uD30C \uD0D0\uC0C1 \uAC80\uC0AC) \uC2DC Probe(\uD0D0\uCD09\uC790)\uC640 \uBAA8\uC7AC \uC0AC\uC774\uC758 \uACF5\uAE30\uCE35\uC744 \uC5C6\uC560\uACE0 \uCD08\uC74C\uD30C\uAC00 \uC798 \uC804\uB2EC\uB418\uB3C4\uB85D \uBC14\uB974\uB294 \uB9E4\uC9C8\uC740?",
    "options": [
      "Couplant (\uC811\uCD09 \uB9E4\uC9C8)",
      "Developer (\uD604\uC0C1\uC561)",
      "Penetrant (\uCE68\uD22C\uC561)",
      "Flux (\uC6A9\uC81C)"
    ],
    "correctIndex": 0,
    "explanation": "\uCD08\uC74C\uD30C\uB294 \uACF5\uAE30\uB97C \uB9CC\uB098\uBA74 \uC0B0\uB780\uB418\uBBC0\uB85C, \uAE00\uB9AC\uC138\uB9B0\uC774\uB098 \uC624\uC77C \uAC19\uC740 Couplant\uB97C \uBC1C\uB77C \uCD08\uC74C\uD30C\uB97C \uBAA8\uC7AC \uB0B4\uBD80\uB85C \uC804\uB2EC\uC2DC\uD0B5\uB2C8\uB2E4."
  },
  {
    "id": "s10q13",
    "set": 10,
    "num": 13,
    "difficulty": "easy",
    "category": "\uC7AC\uB8CC \uBC0F \uC131\uBD84",
    "question": "Carbon steel(\uD0C4\uC18C\uAC15)\uC5D0\uC11C \uD0C4\uC18C(C)\uC758 \uD568\uB7C9\uC774 \uC99D\uAC00\uD560\uC218\uB85D \uC6A9\uC811\uC131\uC5D0 \uBBF8\uCE58\uB294 \uC601\uD5A5\uC73C\uB85C \uAC00\uC7A5 \uC62C\uBC14\uB978 \uAC83\uC740?",
    "options": [
      "\uC6A9\uC811\uC131\uC774 \uB9E4\uC6B0 \uC88B\uC544\uC9C4\uB2E4.",
      "\uACBD\uB3C4\uB294 \uC99D\uAC00\uD558\uC9C0\uB9CC \uCDE8\uC131(\uAE68\uC9C0\uB294 \uC131\uC9C8)\uC774 \uCEE4\uC838 \uC6A9\uC811 \uC2DC Crack\uC774 \uBC1C\uC0DD\uD558\uAE30 \uC27D\uB2E4.",
      "\uC5F4\uC804\uB3C4\uC728\uC774 \uAE09\uACA9\uD788 \uB192\uC544\uC9C4\uB2E4.",
      "\uC5F0\uC131\uC774 \uD06C\uAC8C \uC99D\uAC00\uD55C\uB2E4."
    ],
    "correctIndex": 1,
    "explanation": "\uD0C4\uC18C\uB7C9\uC774 \uB9CE\uC544\uC9C0\uBA74 \uAE08\uC18D\uC740 \uB2E8\uB2E8\uD574\uC9C0\uB098, \uC6A9\uC811 \uD6C4 \uAE09\uB7AD \uC2DC \uB9C8\uB974\uD150\uC0AC\uC774\uD2B8 \uC870\uC9C1\uC774 \uD615\uC131\uB418\uC5B4 \uC27D\uAC8C \uAC08\uB77C\uC9C0\uAC8C \uB429\uB2C8\uB2E4."
  },
  {
    "id": "s10q14",
    "set": 10,
    "num": 14,
    "difficulty": "medium",
    "category": "\uC7AC\uB8CC \uBC0F \uC131\uBD84",
    "question": "Austenitic Stainless Steel(300\uACC4\uC5F4 \uC2A4\uD14C\uC778\uB9AC\uC2A4\uAC15) \uC6A9\uC811 \uC2DC \uB0B4\uC2DD\uC131 \uC800\uD558(\uC608\uBBFC\uD654)\uB97C \uB9C9\uAE30 \uC704\uD55C \uC6A9\uC811 \uD6C4 \uB0C9\uAC01 \uBC29\uBC95\uC740?",
    "options": [
      "\uAC00\uC5F4 \uD6C4 \uC544\uC8FC \uCC9C\uCC9C\uD788 \uC2DD\uD78C\uB2E4.",
      "\uBCF4\uC628 \uB36E\uAC1C\uB85C \uB36E\uC5B4 \uC11C\uB7AD\uD55C\uB2E4.",
      "500~800\u2103 \uAD6C\uAC04\uC744 \uD53C\uD558\uAE30 \uC704\uD574 \uBB3C\uC774\uB098 \uACF5\uAE30\uB85C \uAE09\uB7AD(Quenching)\uC2DC\uD0A8\uB2E4.",
      "Pre-heating\uC744 500\u2103 \uC774\uC0C1\uC73C\uB85C \uD55C\uB2E4."
    ],
    "correctIndex": 2,
    "explanation": "\uC624\uC2A4\uD14C\uB098\uC774\uD2B8\uACC4 STS\uB294 \uD2B9\uC815 \uACE0\uC628 \uAD6C\uAC04\uC5D0\uC11C \uD06C\uB86C \uD0C4\uD654\uBB3C\uC774 \uC11D\uCD9C\uB418\uC5B4 \uB179\uC774 \uC2A4\uB294 \uC131\uC9C8\uB85C \uBCC0\uD558\uBBC0\uB85C, \uC774 \uAD6C\uAC04\uC744 \uBE60\uB974\uAC8C \uC9C0\uB098\uCE58\uB3C4\uB85D \uAE09\uB7AD\uD574\uC57C \uD569\uB2C8\uB2E4."
  },
  {
    "id": "s10q15",
    "set": 10,
    "num": 15,
    "difficulty": "easy",
    "category": "\uC6A9\uC811 \uADF9\uC131",
    "question": "DCEN(\uC9C1\uB958 \uC815\uADF9\uC131) \uADF9\uC131\uC5D0\uC11C \uC804\uC790\uC758 \uC774\uB3D9 \uBC29\uD5A5\uC740 \uC5B4\uB5BB\uAC8C \uB418\uB294\uAC00?",
    "options": [
      "Tungsten \uC804\uADF9(-)\uC5D0\uC11C \uBAA8\uC7AC(+) \uBC29\uD5A5",
      "\uBAA8\uC7AC(-)\uC5D0\uC11C Tungsten \uC804\uADF9(+) \uBC29\uD5A5",
      "\uBAA8\uC7AC\uC5D0\uC11C Earth \uBC29\uD5A5",
      "\uC774\uB3D9\uD558\uC9C0 \uC54A\uB294\uB2E4."
    ],
    "correctIndex": 0,
    "explanation": "\uC804\uC790\uB294 (-)\uC5D0\uC11C (+)\uB85C \uC774\uB3D9\uD558\uBA70, \uC774 \uC804\uC790 \uCDA9\uB3CC\uC5D0 \uC758\uD574 \uBAA8\uC7AC(+) \uCABD\uC5D0 70%\uC758 \uC5F4\uC774 \uC9D1\uC911\uB418\uC5B4 \uAE4A\uC740 Penetration\uC744 \uB9CC\uB4ED\uB2C8\uB2E4."
  },
  {
    "id": "s10q16",
    "set": 10,
    "num": 16,
    "difficulty": "hard",
    "category": "\uC6A9\uC811 \uADF9\uC131",
    "question": "Aluminum\uC744 AC(\uAD50\uB958)\uB85C \uC6A9\uC811\uD560 \uB54C, AC Balance \uC124\uC815\uC744 \uC870\uC791\uD558\uC5EC EN(\uC815\uADF9\uC131) \uBE44\uC728\uC744 \uD06C\uAC8C \uB192\uC774\uACE0 EP(\uC5ED\uADF9\uC131) \uBE44\uC728\uC744 \uB0AE\uCD94\uBA74 \uBC1C\uC0DD\uD558\uB294 \uACB0\uACFC\uB294?",
    "options": [
      "Tungsten \uC804\uADF9\uC774 \uB179\uC544\uB0B4\uB9B0\uB2E4.",
      "Cleaning action(\uCCAD\uC815 \uC791\uC6A9)\uC774 \uB108\uBB34 \uAC15\uD574\uC838 Arc\uAC00 \uBD88\uC548\uC815\uD574\uC9C4\uB2E4.",
      "Cleaning action\uC740 \uC904\uC5B4\uB4E4\uC9C0\uB9CC, Penetration(\uC6A9\uC785)\uC774 \uAE4A\uC5B4\uC9C0\uACE0 \uC804\uADF9 \uC18C\uBAA8\uAC00 \uC801\uC5B4\uC9C4\uB2E4.",
      "\uBAA8\uC7AC \uD45C\uBA74\uC758 \uC0B0\uD654\uB9C9\uC774 \uC804\uD600 \uD30C\uAD34\uB418\uC9C0 \uC54A\uC544 \uC6A9\uC811\uC774 \uC544\uC608 \uBD88\uAC00\uB2A5\uD574\uC9C4\uB2E4."
    ],
    "correctIndex": 2,
    "explanation": "EN \uBE44\uC728\uC774 \uB192\uC73C\uBA74 \uBAA8\uC7AC\uB97C \uB179\uC774\uB294 \uC2DC\uAC04\uC774 \uAE38\uC5B4\uC838 \uC6A9\uC785\uC774 \uAE4A\uC5B4\uC9D1\uB2C8\uB2E4. EP \uBE44\uC728\uC774 \uCD5C\uC18C\uD55C(\uC57D 15~30%)\uB9CC \uC720\uC9C0\uB418\uC5B4\uB3C4 \uC0B0\uD654\uB9C9 \uD30C\uAD34\uB294 \uCDA9\uBD84\uD788 \uC774\uB8E8\uC5B4\uC9D1\uB2C8\uB2E4."
  },
  {
    "id": "s10q17",
    "set": 10,
    "num": 17,
    "difficulty": "medium",
    "category": "\uC804\uC6D0 \uD2B9\uC131",
    "question": "\uC218\uB3D9 GTAW \uC6A9\uC811\uAE30\uC758 \uC804\uC6D0 \uD2B9\uC131\uC778 Constant Current(\uC815\uC804\uB958 \uD2B9\uC131)\uAC00 \uC791\uC5C5\uC790\uC5D0\uAC8C \uC8FC\uB294 \uAC00\uC7A5 \uD070 \uC774\uC810\uC740?",
    "options": [
      "\uC804\uB958\uAC00 0\uC774 \uB418\uC5B4\uB3C4 \uC804\uC555\uC774 \uB192\uAC8C \uC720\uC9C0\uB41C\uB2E4.",
      "\uC791\uC5C5\uC790\uC758 \uC190\uB5A8\uB9BC\uC73C\uB85C Arc length\uAC00 \uBCC0\uD574\uB3C4 Current \uAC12\uC774 \uAC70\uC758 \uC77C\uC815\uD558\uAC8C \uC720\uC9C0\uB418\uC5B4 \uC77C\uC815\uD55C Bead\uB97C \uC5BB\uC744 \uC218 \uC788\uB2E4.",
      "Wire \uACF5\uAE09 \uC18D\uB3C4\uB97C \uC790\uB3D9\uC73C\uB85C \uC870\uC808\uD574\uC900\uB2E4.",
      "\uC6A9\uC811\uAE30\uC758 \uBB34\uAC8C\uB97C \uAC00\uBCCD\uAC8C \uD574\uC900\uB2E4."
    ],
    "correctIndex": 1,
    "explanation": "\uC804\uC555\uC774 \uCD9C\uB801\uC5EC\uB3C4 \uC804\uB958(\uC785\uC5F4\uB7C9)\uB294 \uAC70\uC758 \uBCC0\uD558\uC9C0 \uC54A\uB3C4\uB85D \uB3D5\uB294 \uAC83\uC774 \uC218\uB3D9 \uC6A9\uC811\uAE30 \uD2B9\uC131 \uACE1\uC120(\uC218\uD558 \uD2B9\uC131)\uC758 \uD575\uC2EC \uC6D0\uB9AC\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s10q18",
    "set": 10,
    "num": 18,
    "difficulty": "easy",
    "category": "\uC785\uC5F4\uB7C9\uACFC \uBCC0\uD615",
    "question": "\uBCF8 \uC6A9\uC811\uC744 \uC218\uD589\uD558\uAE30 \uC804, \uBD80\uD488\uB4E4\uC774 \uC5F4\uBCC0\uD615\uC5D0 \uC758\uD574 \uD2C0\uC5B4\uC9C0\uC9C0 \uC54A\uB3C4\uB85D \uC784\uC2DC\uB85C \uACE0\uC815\uD574\uB450\uB294 \uC9E7\uC740 \uC6A9\uC811\uC744 \uBB34\uC5C7\uC774\uB77C \uD558\uB294\uAC00?",
    "options": [
      "Tack weld (\uAC00\uC811)",
      "Backing weld (\uC774\uBA74 \uC6A9\uC811)",
      "Peening (\uD53C\uB2DD)",
      "Weaving (\uC704\uBE59)"
    ],
    "correctIndex": 0,
    "explanation": "Tack weld(\uD14C\uD06C \uC6A9\uC811, \uAC00\uC811)\uB294 \uC815\uBC00\uD55C \uCE58\uC218 \uC720\uC9C0\uB97C \uC704\uD574 \uBCF8 \uC6A9\uC811 \uC804\uC5D0 \uD544\uC218\uC801\uC73C\uB85C \uC218\uD589\uD558\uB294 \uACE0\uC815 \uC791\uC5C5\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s10q19",
    "set": 10,
    "num": 19,
    "difficulty": "medium",
    "category": "\uC785\uC5F4\uB7C9\uACFC \uBCC0\uD615",
    "question": "\uC6A9\uC811 \uC2DC \uBC1C\uC0DD\uD558\uB294 Deformation(\uBCC0\uD615)\uC744 \uC5B5\uC81C\uD558\uAE30 \uC704\uD574, \uC218\uCD95\uB420 \uAC01\uB3C4\uB97C \uBBF8\uB9AC \uACC4\uC0B0\uD558\uC5EC \uBC18\uB300 \uBC29\uD5A5\uC73C\uB85C \uBAA8\uC7AC\uB97C \uAEBE\uC5B4 \uC870\uB9BD\uD558\uB294 \uBC29\uBC95\uC740?",
    "options": [
      "Peening",
      "Pre-setting (\uC5ED\uBCC0\uD615\uBC95)",
      "Strongback",
      "Back-step"
    ],
    "correctIndex": 1,
    "explanation": "\uC6A9\uC811 \uD6C4 \uC218\uCD95\uD558\uB294 \uD798\uC744 \uC5ED\uC73C\uB85C \uC774\uC6A9\uD558\uC5EC, \uC6A9\uC811\uC774 \uB05D\uB0AC\uC744 \uB54C \uBAA8\uC7AC\uAC00 \uC77C\uC9C1\uC120\uC73C\uB85C \uD3B4\uC9C0\uAC8C \uB9CC\uB4DC\uB294 \uAC00\uC7A5 \uD6A8\uACFC\uC801\uC778 \uC870\uB9BD \uAE30\uC220\uC785\uB2C8\uB2E4."
  },
  {
    "id": "s10q20",
    "set": 10,
    "num": 20,
    "difficulty": "hard",
    "category": "\uC785\uC5F4\uB7C9\uACFC \uBCC0\uD615",
    "question": "\uC6A9\uC811 \uC911 \uC794\uB958 \uC751\uB825\uC744 \uC81C\uAC70\uD558\uAE30 \uC704\uD574 \uC6A9\uC811\uBD80\uB97C \uB9DD\uCE58\uB85C \uB450\uB4DC\uB9AC\uB294 Peening \uC791\uC5C5\uC744 \uD53C\uD574\uC57C \uD558\uB294 \uBD80\uC704\uB294 \uC5B4\uB514\uC778\uAC00?",
    "options": [
      "\uD45C\uBA74(Surface) Bead \uBC0F \uCD08\uCE35(Root) Bead",
      "\uB450\uAEBC\uC6B4 \uB2E4\uCE35 \uC6A9\uC811\uC758 \uC911\uAC04 Pass",
      "\uAC00\uC811(Tack weld) \uBD80\uC704",
      "\uBAA8\uC7AC\uC758 \uAC00\uC7A5\uC790\uB9AC"
    ],
    "correctIndex": 0,
    "explanation": "\uAC00\uC7A5 \uBC11\uBC14\uB2E5\uC778 Root bead\uC640 \uCD5C\uC0C1\uB2E8 Surface bead\uB294 \uB450\uAED8\uAC00 \uC587\uACE0 \uCDE8\uC57D\uD558\uC5EC Peening \uD0C0\uACA9\uC744 \uAC00\uD558\uBA74 \uC989\uC2DC Crack\uC774 \uBC1C\uC0DD\uD560 \uC704\uD5D8\uC774 \uB192\uC2B5\uB2C8\uB2E4."
  }
];

// server/theory-routes.ts
async function ensureTheoryTable() {
  await db_default.query(`
    CREATE TABLE IF NOT EXISTS weld_theory_attempts (
      id SERIAL PRIMARY KEY,
      user_id VARCHAR(255) NOT NULL,
      day_key VARCHAR(16) NOT NULL,
      question_id VARCHAR(64) NOT NULL,
      difficulty VARCHAR(16) NOT NULL,
      selected_index INT NOT NULL,
      correct_index INT NOT NULL,
      is_correct BOOLEAN NOT NULL,
      attempted_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
      UNIQUE (user_id, day_key, question_id)
    )
  `);
  await db_default.query(
    `CREATE INDEX IF NOT EXISTS idx_theory_attempts_user_day ON weld_theory_attempts(user_id, day_key)`
  );
}
ensureTheoryTable().catch(console.error);
function getDayKey(date = /* @__PURE__ */ new Date()) {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    return fmt.format(date);
  } catch {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
}
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = h * 31 + s.charCodeAt(i) | 0;
  }
  return Math.abs(h);
}
function pickDailyForUser(userId, dayKey, attemptedIds) {
  const easy = THEORY_QUESTIONS.filter((q) => q.difficulty === "easy");
  const medium = THEORY_QUESTIONS.filter((q) => q.difficulty === "medium");
  const hard = THEORY_QUESTIONS.filter((q) => q.difficulty === "hard");
  const pickFrom = (pool2, salt) => {
    const unattempted = pool2.filter((q) => !attemptedIds.has(q.id));
    const source = unattempted.length > 0 ? unattempted : pool2;
    const seed = hashStr(`${userId}|${dayKey}|${salt}`);
    return source[seed % source.length];
  };
  return [pickFrom(easy, "easy"), pickFrom(medium, "medium"), pickFrom(hard, "hard")];
}
function registerTheoryRoutes(app2) {
  app2.get("/api/theory/daily/:userId", async (req, res) => {
    const userId = String(req.params.userId || "");
    if (!userId)
      return res.status(400).json({ error: "userId required" });
    const dayKey = getDayKey();
    try {
      const { rows: allRows } = await db_default.query(
        "SELECT question_id, day_key, selected_index FROM weld_theory_attempts WHERE user_id = $1",
        [userId]
      );
      const attemptedAllIds = new Set(allRows.map((r) => r.question_id));
      const todayRows = allRows.filter((r) => r.day_key === dayKey);
      const todayMap = /* @__PURE__ */ new Map();
      todayRows.forEach((r) => todayMap.set(r.question_id, r.selected_index));
      const previousIds = /* @__PURE__ */ new Set();
      for (const id of attemptedAllIds) {
        if (!todayMap.has(id))
          previousIds.add(id);
      }
      const picked = pickDailyForUser(userId, dayKey, previousIds);
      const finalByDiff = {};
      for (const q of picked)
        finalByDiff[q.difficulty] = q;
      for (const aRow of todayRows) {
        const q = THEORY_QUESTIONS.find((x) => x.id === aRow.question_id);
        if (q)
          finalByDiff[q.difficulty] = q;
      }
      const ordered = [];
      for (const diff of ["easy", "medium", "hard"]) {
        if (finalByDiff[diff])
          ordered.push(finalByDiff[diff]);
      }
      res.json({
        dayKey,
        questions: ordered.map((q) => ({
          id: q.id,
          difficulty: q.difficulty,
          category: q.category,
          question: q.question,
          options: q.options
        })),
        // Pre-existing selections so the UI can resume mid-session.
        selections: Object.fromEntries(todayMap)
      });
    } catch (err) {
      console.error("theory daily error:", err);
      res.status(500).json({ error: "\uC11C\uBC84 \uC624\uB958" });
    }
  });
  app2.post("/api/theory/attempts", async (req, res) => {
    const { userId, questionId, selectedIndex, dayKey } = req.body;
    if (!userId || !questionId || selectedIndex === void 0) {
      return res.status(400).json({ error: "\uD544\uC218 \uD56D\uBAA9\uC774 \uC5C6\uC2B5\uB2C8\uB2E4." });
    }
    const qid = String(questionId);
    const q = THEORY_QUESTIONS.find((x) => x.id === qid);
    if (!q)
      return res.status(404).json({ error: "\uBB38\uC81C\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
    const isCorrect = q.correctIndex === selectedIndex;
    const dk = dayKey || getDayKey();
    try {
      await db_default.query(
        `INSERT INTO weld_theory_attempts
          (user_id, day_key, question_id, difficulty, selected_index, correct_index, is_correct)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id, day_key, question_id)
         DO UPDATE SET selected_index = EXCLUDED.selected_index,
                       is_correct = EXCLUDED.is_correct,
                       attempted_at = EXTRACT(EPOCH FROM NOW())::BIGINT * 1000`,
        [userId, dk, qid, q.difficulty, selectedIndex, q.correctIndex, isCorrect]
      );
      res.json({ success: true, isCorrect, correctIndex: q.correctIndex });
    } catch (err) {
      console.error("theory attempt error:", err);
      res.status(500).json({ error: "\uC11C\uBC84 \uC624\uB958" });
    }
  });
  app2.get("/api/theory/results/:userId/:dayKey", async (req, res) => {
    const userId = String(req.params.userId || "");
    const dayKey = String(req.params.dayKey || "");
    try {
      const { rows } = await db_default.query(
        "SELECT * FROM weld_theory_attempts WHERE user_id = $1 AND day_key = $2",
        [userId, dayKey]
      );
      const attempts = rows.map((r) => ({
        questionId: r.question_id,
        selectedIndex: r.selected_index,
        correctIndex: r.correct_index,
        isCorrect: r.is_correct,
        attemptedAt: Number(r.attempted_at)
      }));
      const enriched = attempts.map((a) => {
        const q = THEORY_QUESTIONS.find((x) => x.id === a.questionId);
        return q ? { ...a, question: q } : null;
      }).filter((x) => x !== null);
      const order = { easy: 0, medium: 1, hard: 2 };
      enriched.sort((a, b) => order[a.question.difficulty] - order[b.question.difficulty]);
      const score = enriched.filter((e) => e.isCorrect).length;
      res.json({ dayKey, score, total: enriched.length, attempts: enriched });
    } catch (err) {
      console.error("theory results error:", err);
      res.status(500).json({ error: "\uC11C\uBC84 \uC624\uB958" });
    }
  });
  app2.get("/api/theory/history/:userId", async (req, res) => {
    const userId = String(req.params.userId || "");
    try {
      const { rows } = await db_default.query(
        "SELECT * FROM weld_theory_attempts WHERE user_id = $1 ORDER BY attempted_at DESC",
        [userId]
      );
      const attempts = rows.map((r) => {
        const q = THEORY_QUESTIONS.find((x) => x.id === r.question_id);
        return {
          questionId: r.question_id,
          dayKey: r.day_key,
          difficulty: r.difficulty,
          selectedIndex: r.selected_index,
          correctIndex: r.correct_index,
          isCorrect: r.is_correct,
          attemptedAt: Number(r.attempted_at),
          question: q || null
        };
      });
      const byDay = {};
      for (const a of attempts) {
        if (!byDay[a.dayKey])
          byDay[a.dayKey] = [];
        byDay[a.dayKey].push(a);
      }
      const totalAttempted = attempts.length;
      const totalCorrect = attempts.filter((a) => a.isCorrect).length;
      res.json({ totalAttempted, totalCorrect, byDay });
    } catch (err) {
      console.error("theory history error:", err);
      res.status(500).json({ error: "\uC11C\uBC84 \uC624\uB958" });
    }
  });
  app2.get("/api/theory/today-status/:userId", async (req, res) => {
    const userId = String(req.params.userId || "");
    const dayKey = getDayKey();
    try {
      const { rows } = await db_default.query(
        "SELECT COUNT(*)::int AS c FROM weld_theory_attempts WHERE user_id = $1 AND day_key = $2",
        [userId, dayKey]
      );
      const attempted = rows[0]?.c || 0;
      res.json({ dayKey, attempted, completed: attempted >= 3 });
    } catch (err) {
      console.error("theory status error:", err);
      res.status(500).json({ error: "\uC11C\uBC84 \uC624\uB958" });
    }
  });
}

// server/schema.ts
async function ensureOxBankTables() {
  await db_default.query(`
    CREATE TABLE IF NOT EXISTS weld_ox_bank (
      id           SERIAL  PRIMARY KEY,
      ncs_category TEXT    NOT NULL,
      difficulty   TEXT    NOT NULL CHECK (difficulty IN ('easy','medium','hard')),
      question     TEXT    NOT NULL,
      answer       BOOLEAN NOT NULL,
      explanation  TEXT    NOT NULL DEFAULT '',
      source       TEXT    NOT NULL DEFAULT 'ai',
      created_at   TIMESTAMP DEFAULT NOW()
    )
  `);
  await db_default.query(`
    CREATE INDEX IF NOT EXISTS idx_ox_bank_cat_diff
    ON weld_ox_bank (ncs_category, difficulty)
  `);
  await db_default.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ox_bank_question_dedup
    ON weld_ox_bank (ncs_category, difficulty, LEFT(question, 80))
  `);
  await db_default.query(`
    CREATE TABLE IF NOT EXISTS weld_ox_category_lock (
      ncs_category   TEXT    NOT NULL,
      difficulty     TEXT    NOT NULL,
      is_locked      BOOLEAN NOT NULL DEFAULT FALSE,
      question_count INT     NOT NULL DEFAULT 0,
      locked_at      TIMESTAMP,
      lock_reason    TEXT,
      updated_at     TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (ncs_category, difficulty)
    )
  `);
}
async function ensureFieldTables() {
  await db_default.query(`
    CREATE TABLE IF NOT EXISTS field_users (
      id         SERIAL  PRIMARY KEY,
      name       TEXT    NOT NULL,
      role       TEXT    NOT NULL
                   CHECK (role IN ('education', 'field_worker', 'field_manager')),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await db_default.query(`
    CREATE TABLE IF NOT EXISTS field_weld_records (
      id           SERIAL  PRIMARY KEY,
      welder_id    INT     NOT NULL
                     REFERENCES field_users(id) ON DELETE CASCADE,
      project_name TEXT    NOT NULL DEFAULT '',
      current_amp  NUMERIC(7,2),   -- \uC804\uB958 (A)
      voltage_volt NUMERIC(6,2),   -- \uC804\uC555 (V)
      created_at   TIMESTAMP DEFAULT NOW()
    )
  `);
  await db_default.query(`
    CREATE INDEX IF NOT EXISTS idx_field_records_welder
    ON field_weld_records (welder_id)
  `);
  await db_default.query(`
    CREATE INDEX IF NOT EXISTS idx_field_records_created
    ON field_weld_records (created_at DESC)
  `);
  await db_default.query(`
    CREATE TABLE IF NOT EXISTS field_inspections (
      id                 SERIAL  PRIMARY KEY,
      record_id          INT     NOT NULL
                           REFERENCES field_weld_records(id) ON DELETE CASCADE,
      original_image_url TEXT,
      ppm_scale          NUMERIC(10,4),  -- pixels per mm (ArUco \uAE30\uBC18 \uD658\uC0B0 \uACC4\uC218)
      avg_bead_width     NUMERIC(7,2),   -- \uD3C9\uADE0 \uBE44\uB4DC \uD3ED (mm)
      straightness_error NUMERIC(7,2),   -- \uC9C1\uC9C4\uB3C4 \uC624\uCC28 (mm)
      final_status       TEXT    NOT NULL
                           CHECK (final_status IN ('PASS', 'FAIL')),
      created_at         TIMESTAMP DEFAULT NOW()
    )
  `);
  await db_default.query(`
    CREATE INDEX IF NOT EXISTS idx_field_inspections_record
    ON field_inspections (record_id)
  `);
  await db_default.query(`
    ALTER TABLE field_inspections ADD COLUMN IF NOT EXISTS weld_type TEXT DEFAULT 'butt'
  `);
  await db_default.query(`
    -- \uB300\uC2DC\uBCF4\uB4DC \uCFFC\uB9AC: \uAE30\uAC04\uBCC4 \uD569\uACA9/\uBD88\uD569\uACA9 \uC9D1\uACC4
    CREATE INDEX IF NOT EXISTS idx_field_inspections_status_created
    ON field_inspections (final_status, created_at DESC)
  `);
  await db_default.query(`
    CREATE TABLE IF NOT EXISTS field_defects (
      id            SERIAL  PRIMARY KEY,
      inspection_id INT     NOT NULL
                      REFERENCES field_inspections(id) ON DELETE CASCADE,
      defect_type   TEXT    NOT NULL,    -- \uC5B8\uB354\uCEF7, \uAE30\uACF5, \uC2A4\uD328\uD130, \uD06C\uB799 \uB4F1
      confidence    NUMERIC(5,2),        -- \uC2E0\uB8B0\uB3C4 0.00~100.00 (%)
      size_mm       NUMERIC(7,2),        -- \uACB0\uD568 \uD06C\uAE30 \uCD94\uC815 (mm)
      created_at    TIMESTAMP DEFAULT NOW()
    )
  `);
  await db_default.query(`
    CREATE INDEX IF NOT EXISTS idx_field_defects_inspection
    ON field_defects (inspection_id)
  `);
  await db_default.query(`
    -- \uACB0\uD568 \uC720\uD615\uBCC4 \uC9D1\uACC4\uC6A9
    CREATE INDEX IF NOT EXISTS idx_field_defects_type
    ON field_defects (defect_type)
  `);
}

// server/ox-routes.ts
async function ensureOxTables() {
  await db_default.query(`
    CREATE TABLE IF NOT EXISTS weld_ox_state (
      user_id TEXT PRIMARY KEY,
      snapshot JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await db_default.query(`
    CREATE TABLE IF NOT EXISTS weld_ox_scores (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      final_wave INT NOT NULL,
      quiz_correct INT NOT NULL DEFAULT 0,
      quiz_total INT NOT NULL DEFAULT 0,
      accuracy INT NOT NULL DEFAULT 0,
      played_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await db_default.query(`
    CREATE INDEX IF NOT EXISTS idx_weld_ox_scores_rank
    ON weld_ox_scores (final_wave DESC, accuracy DESC, played_at ASC)
  `);
  await ensureOxBankTables();
}
ensureOxTables().catch(console.error);
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  const curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    [prev] = [[...curr]];
  }
  return curr[n];
}
function editSimilarity(a, b) {
  const na = a.toLowerCase().replace(/\s+/g, " ").trim();
  const nb = b.toLowerCase().replace(/\s+/g, " ").trim();
  const dist = levenshtein(na, nb);
  return 1 - dist / Math.max(na.length, nb.length, 1);
}
function jaccardSimilarity(a, b) {
  const words = (s) => new Set(s.toLowerCase().split(/[\s,.?!()]+/).filter((w) => w.length > 1));
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 && wb.size === 0)
    return 1;
  let inter = 0;
  wa.forEach((w) => {
    if (wb.has(w))
      inter++;
  });
  return inter / Math.max(wa.size + wb.size - inter, 1);
}
function isTooSimilar(newQ, existingList, editThresh = 0.75, jaccardThresh = 0.65) {
  for (const q of existingList) {
    if (editSimilarity(newQ, q) >= editThresh)
      return true;
    if (jaccardSimilarity(newQ, q) >= jaccardThresh)
      return true;
  }
  return false;
}
async function isLocked(category, difficulty) {
  try {
    const { rows } = await db_default.query(
      "SELECT is_locked FROM weld_ox_category_lock WHERE ncs_category=$1 AND difficulty=$2",
      [category, difficulty]
    );
    return rows[0]?.is_locked ?? false;
  } catch {
    return false;
  }
}
async function setLock(category, difficulty, reason) {
  await db_default.query(
    `INSERT INTO weld_ox_category_lock
       (ncs_category, difficulty, is_locked, locked_at, lock_reason, updated_at)
     VALUES ($1, $2, TRUE, NOW(), $3, NOW())
     ON CONFLICT (ncs_category, difficulty) DO UPDATE
       SET is_locked=TRUE, locked_at=NOW(), lock_reason=EXCLUDED.lock_reason, updated_at=NOW()`,
    [category, difficulty, reason]
  );
  console.log(
    `[OX-Lock] \u{1F512} \uC7A0\uAE08 \uC124\uC815 | category="${category}" difficulty="${difficulty}" | \uC0AC\uC720: ${reason}`
  );
}
async function releaseLock(category, difficulty) {
  await db_default.query(
    `INSERT INTO weld_ox_category_lock
       (ncs_category, difficulty, is_locked, updated_at)
     VALUES ($1, $2, FALSE, NOW())
     ON CONFLICT (ncs_category, difficulty) DO UPDATE
       SET is_locked=FALSE, locked_at=NULL, lock_reason=NULL, updated_at=NOW()`,
    [category, difficulty]
  );
  console.log(`[OX-Lock] \u{1F513} \uC7A0\uAE08 \uD574\uC81C | category="${category}" difficulty="${difficulty}"`);
}
async function getRandomFromBank(category, difficulty) {
  const { rows } = await db_default.query(
    `SELECT id, ncs_category, difficulty, question, answer, explanation, source, created_at
     FROM weld_ox_bank
     WHERE ncs_category=$1 AND difficulty=$2
     ORDER BY RANDOM() LIMIT 1`,
    [category, difficulty]
  );
  return rows[0] ?? null;
}
async function getExistingQuestions(category, difficulty, limit = 20) {
  const { rows } = await db_default.query(
    `SELECT question FROM weld_ox_bank
     WHERE ncs_category=$1 AND difficulty=$2
     ORDER BY created_at DESC LIMIT $3`,
    [category, difficulty, limit]
  );
  return rows.map((r) => r.question);
}
async function saveToBank(category, difficulty, question, answer, explanation) {
  await db_default.query(
    `INSERT INTO weld_ox_bank (ncs_category, difficulty, question, answer, explanation)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (ncs_category, difficulty, LEFT(question, 80)) DO NOTHING`,
    [category, difficulty, question, answer, explanation]
  );
  await db_default.query(
    `INSERT INTO weld_ox_category_lock (ncs_category, difficulty, question_count, updated_at)
     VALUES ($1, $2, 1, NOW())
     ON CONFLICT (ncs_category, difficulty) DO UPDATE
       SET question_count = weld_ox_category_lock.question_count + 1, updated_at=NOW()`,
    [category, difficulty]
  );
}
async function callOpenAiForOx(category, difficulty, existingQuestions) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("[OX-Generate] OPENAI_API_KEY \uC5C6\uC74C");
    return null;
  }
  const diffLabel = {
    easy: "\uC26C\uC6C0(\uCD08\uAE09 \u2014 \uC6A9\uC811 \uAE30\uCD08 \uAC1C\uB150)",
    medium: "\uBCF4\uD1B5(\uC911\uAE09 \u2014 \uC2E4\uBB34 \uC801\uC6A9)",
    hard: "\uC5B4\uB824\uC6C0(\uACE0\uAE09 \u2014 NCS \uC2EC\uD654/\uACC4\uC0B0)"
  };
  const existingBlock = existingQuestions.length > 0 ? `

[\uC774\uBBF8 \uBB38\uC81C\uC740\uD589\uC5D0 \uC874\uC7AC\uD558\uB294 \uBB38\uC81C \u2014 \uBC18\uB4DC\uC2DC \uD53C\uD560 \uAC83]
` + existingQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n") : "";
  const systemPrompt = `\uB2F9\uC2E0\uC740 \uC6A9\uC811 NCS(\uAD6D\uAC00\uC9C1\uBB34\uB2A5\uB825\uD45C\uC900) \uC804\uBB38 \uCD9C\uC81C\uC790\uC785\uB2C8\uB2E4. OX \uD034\uC988(\uB9DE\uC73C\uBA74 true, \uD2C0\uB9AC\uBA74 false) \uBB38\uC81C\uB97C \uC0DD\uC131\uD569\uB2C8\uB2E4.
\uCE74\uD14C\uACE0\uB9AC: ${category}
\uB09C\uC774\uB3C4: ${diffLabel[difficulty] ?? difficulty}` + existingBlock + `

[\uC0DD\uC131 \uC9C0\uCE68]
- \uC704 \uAE30\uC874 \uBB38\uC81C\uB4E4\uACFC \uAC1C\uB150\xB7\uBB38\uC7A5 \uAD6C\uC870\xB7\uBB3B\uB294 \uBC29\uC2DD\uC774 \uC644\uC804\uD788 \uB2EC\uB77C\uC57C \uD569\uB2C8\uB2E4.
- \uC2E4\uBB34\uC801\uC774\uACE0 \uAD6C\uCCB4\uC801\uC774\uBA70 \uAD50\uC721\uC801 \uAC00\uCE58\uAC00 \uC788\uB294 \uC0C8\uB85C\uC6B4 \uBB38\uC81C\uB97C \uC0DD\uC131\uD558\uC138\uC694.
- \uC8FC\uC5B4\uC9C4 \uCE74\uD14C\uACE0\uB9AC\uC5D0\uC11C \uB354 \uC774\uC0C1 \uC644\uC804\uD788 \uC0C8\uB86D\uACE0 \uC2E4\uBB34\uC801\uC778 \uBB38\uC81C\uB97C \uB3C4\uCD9C\uD560 \uC218 \uC5C6\uB2E4\uBA74 is_exhausted: true\uB97C \uBC18\uD658\uD558\uC138\uC694.

\uB2E4\uC74C JSON \uD615\uC2DD\uC73C\uB85C\uB9CC \uC751\uB2F5\uD558\uC138\uC694:
{"question":"\uBB38\uC81C \uD14D\uC2A4\uD2B8","answer":true,"explanation":"\uD574\uC124 1~2\uBB38\uC7A5","is_exhausted":false}`;
  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: systemPrompt }],
        temperature: 0.92,
        max_tokens: 350,
        response_format: { type: "json_object" }
      })
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error(`[OX-Generate] OpenAI ${resp.status}: ${errText.slice(0, 200)}`);
      return null;
    }
    const data = await resp.json();
    const raw = data.choices?.[0]?.message?.content ?? "{}";
    return JSON.parse(raw);
  } catch (err) {
    console.error("[OX-Generate] OpenAI \uD30C\uC2F1 \uC624\uB958:", err.message);
    return null;
  }
}
function registerOxRoutes(app2) {
  app2.get("/api/ox/state/:userId", async (req, res) => {
    const userId = String(req.params.userId || "");
    if (!userId)
      return res.status(400).json({ error: "userId required" });
    try {
      const { rows } = await db_default.query(
        "SELECT snapshot, updated_at FROM weld_ox_state WHERE user_id = $1",
        [userId]
      );
      if (rows.length === 0)
        return res.json({ snapshot: null });
      res.json({ snapshot: rows[0].snapshot, updatedAt: rows[0].updated_at });
    } catch (err) {
      console.error("ox state get:", err);
      res.status(500).json({ error: "\uC11C\uBC84 \uC624\uB958" });
    }
  });
  app2.post("/api/ox/state", async (req, res) => {
    const { userId, snapshot } = req.body ?? {};
    if (!userId || !snapshot)
      return res.status(400).json({ error: "\uC798\uBABB\uB41C \uC694\uCCAD" });
    try {
      await db_default.query(
        `INSERT INTO weld_ox_state (user_id, snapshot, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (user_id) DO UPDATE SET snapshot = EXCLUDED.snapshot, updated_at = NOW()`,
        [String(userId), snapshot]
      );
      res.json({ success: true });
    } catch (err) {
      console.error("ox state save:", err);
      res.status(500).json({ error: "\uC800\uC7A5 \uC2E4\uD328" });
    }
  });
  app2.delete("/api/ox/state/:userId", async (req, res) => {
    const userId = String(req.params.userId || "");
    if (!userId)
      return res.status(400).json({ error: "userId required" });
    try {
      await db_default.query("DELETE FROM weld_ox_state WHERE user_id = $1", [userId]);
      res.json({ success: true });
    } catch (err) {
      console.error("ox state delete:", err);
      res.status(500).json({ error: "\uC0AD\uC81C \uC2E4\uD328" });
    }
  });
  app2.post("/api/ox/scores", async (req, res) => {
    const { userId, userName, finalWave, quizCorrect, quizTotal } = req.body ?? {};
    if (!userId || !userName || typeof finalWave !== "number") {
      return res.status(400).json({ error: "\uC798\uBABB\uB41C \uC694\uCCAD" });
    }
    const correct = Math.max(0, Number(quizCorrect) || 0);
    const total = Math.max(0, Number(quizTotal) || 0);
    const accuracy = total > 0 ? Math.round(correct / total * 100) : 0;
    try {
      const { rows } = await db_default.query(
        `INSERT INTO weld_ox_scores (user_id, user_name, final_wave, quiz_correct, quiz_total, accuracy)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [String(userId), String(userName), Math.max(0, Math.floor(finalWave)), correct, total, accuracy]
      );
      await db_default.query("DELETE FROM weld_ox_state WHERE user_id = $1", [String(userId)]).catch(() => {
      });
      res.json({ success: true, id: rows[0].id, accuracy });
    } catch (err) {
      console.error("ox score save:", err);
      res.status(500).json({ error: "\uC800\uC7A5 \uC2E4\uD328" });
    }
  });
  app2.get("/api/ox/leaderboard", async (_req, res) => {
    try {
      const { rows } = await db_default.query(`
        SELECT user_id, user_name, final_wave, quiz_correct, quiz_total, accuracy, played_at
        FROM weld_ox_scores
        ORDER BY final_wave DESC, accuracy DESC, played_at ASC
        LIMIT 10
      `);
      const top = rows.map((r, i) => ({
        rank: i + 1,
        userId: r.user_id,
        userName: r.user_name,
        finalWave: r.final_wave,
        quizCorrect: r.quiz_correct,
        quizTotal: r.quiz_total,
        accuracy: r.accuracy,
        playedAt: r.played_at
      }));
      res.json({ leaderboard: top });
    } catch (err) {
      console.error("ox leaderboard:", err);
      res.status(500).json({ error: "\uC870\uD68C \uC2E4\uD328" });
    }
  });
  app2.post("/api/ox/generate", async (req, res) => {
    const category = String(req.body?.category || "\uC77C\uBC18\uC6A9\uC811").trim();
    const difficulty = String(req.body?.difficulty || "medium").trim();
    if (!["easy", "medium", "hard"].includes(difficulty)) {
      return res.status(400).json({ error: "difficulty\uB294 easy|medium|hard \uC911 \uD558\uB098" });
    }
    const locked = await isLocked(category, difficulty);
    if (locked) {
      console.log(
        `[OX-Lock] \u{1F512} \uC7A0\uAE08 \uC0C1\uD0DC \u2192 DB \uBB34\uC791\uC704 \uBC18\uD658 | category="${category}" difficulty="${difficulty}"`
      );
      const dbQ = await getRandomFromBank(category, difficulty);
      if (dbQ) {
        return res.json({ ...dbQ, source: "db", fromLock: true });
      }
      return res.status(404).json({
        error: "LOCKED_NO_DATA",
        message: "\uC7A0\uAE08 \uC0C1\uD0DC\uC774\uC9C0\uB9CC DB\uC5D0 \uBB38\uC81C\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4. \uAD00\uB9AC\uC790\uC5D0\uAC8C \uBB38\uC758\uD558\uC138\uC694."
      });
    }
    const existing = await getExistingQuestions(category, difficulty, 20);
    console.log(
      `[OX-Generate] AI \uD638\uCD9C \uC2DC\uC791 | category="${category}" difficulty="${difficulty}" | \uAE30\uC874 \uBB38\uC81C \uC218=${existing.length}`
    );
    const aiResult = await callOpenAiForOx(category, difficulty, existing);
    if (!aiResult) {
      console.warn("[OX-Generate] AI \uC624\uB958 \u2192 DB \uD3F4\uBC31");
      const dbQ = await getRandomFromBank(category, difficulty);
      if (dbQ)
        return res.json({ ...dbQ, source: "db", fromLock: false, aiError: true });
      return res.status(503).json({ error: "AI \uC624\uB958 \uBC0F DB \uBB38\uC81C \uC5C6\uC74C" });
    }
    if (aiResult.is_exhausted) {
      await setLock(category, difficulty, "AI\uAC00 is_exhausted \uBC18\uD658 \u2014 \uC8FC\uC81C \uC18C\uC9C4");
      console.log(`[OX-Lock] \uC8FC\uC81C \uC18C\uC9C4\uC73C\uB85C \uC7A0\uAE08 | category="${category}" difficulty="${difficulty}"`);
      const dbQ = await getRandomFromBank(category, difficulty);
      if (dbQ) {
        return res.json({ ...dbQ, source: "db", fromLock: true, lockedNow: true });
      }
      return res.json({
        locked: true,
        lockedNow: true,
        message: "\uD574\uB2F9 \uCE74\uD14C\uACE0\uB9AC/\uB09C\uC774\uB3C4\uC758 \uBB38\uC81C\uAC00 \uC18C\uC9C4\uB418\uC5C8\uC2B5\uB2C8\uB2E4."
      });
    }
    const { question, answer, explanation } = aiResult;
    if (isTooSimilar(question, existing)) {
      await setLock(
        category,
        difficulty,
        `\uC2E0\uADDC \uBB38\uC81C\uAC00 \uAE30\uC874 \uBB38\uC81C\uC640 \uC720\uC0AC\uB3C4 \uAE30\uC900 \uCD08\uACFC (edit\u22650.75 \uB610\uB294 jaccard\u22650.65)`
      );
      console.log(`[OX-Lock] \uC720\uC0AC\uB3C4 \uCD08\uACFC\uB85C \uC7A0\uAE08 | category="${category}" difficulty="${difficulty}"`);
      const dbQ = await getRandomFromBank(category, difficulty);
      if (dbQ) {
        return res.json({ ...dbQ, source: "db", fromLock: true, lockedNow: true });
      }
      return res.json({
        locked: true,
        lockedNow: true,
        message: "\uC2E0\uADDC \uBB38\uC81C\uAC00 \uAE30\uC874 \uBB38\uC81C\uC640 \uB108\uBB34 \uC720\uC0AC\uD569\uB2C8\uB2E4. \uC7A0\uAE08 \uC124\uC815\uB428."
      });
    }
    await saveToBank(category, difficulty, question, answer, explanation);
    console.log(
      `[OX-Generate] \u2705 \uC2E0\uADDC \uBB38\uC81C \uC800\uC7A5 | category="${category}" difficulty="${difficulty}" | \uBB38\uC81C: "${question.slice(0, 40)}..."`
    );
    return res.json({
      ncs_category: category,
      difficulty,
      question,
      answer,
      explanation,
      source: "ai",
      fromLock: false
    });
  });
  app2.get("/api/ox/lock-status", async (req, res) => {
    const { category, difficulty } = req.query;
    try {
      if (category && difficulty) {
        const { rows: rows2 } = await db_default.query(
          `SELECT * FROM weld_ox_category_lock
           WHERE ncs_category=$1 AND difficulty=$2`,
          [String(category), String(difficulty)]
        );
        const cnt = await db_default.query(
          "SELECT COUNT(*)::int AS c FROM weld_ox_bank WHERE ncs_category=$1 AND difficulty=$2",
          [String(category), String(difficulty)]
        );
        return res.json({
          status: rows2[0] ?? { ncs_category: category, difficulty, is_locked: false, question_count: 0 },
          bankCount: cnt.rows[0]?.c ?? 0
        });
      }
      const { rows } = await db_default.query(
        "SELECT * FROM weld_ox_category_lock ORDER BY ncs_category, difficulty"
      );
      const bankCounts = await db_default.query(
        "SELECT ncs_category, difficulty, COUNT(*)::int AS c FROM weld_ox_bank GROUP BY ncs_category, difficulty"
      );
      const countMap = {};
      for (const r of bankCounts.rows) {
        countMap[`${r.ncs_category}__${r.difficulty}`] = r.c;
      }
      return res.json({
        locks: rows.map((r) => ({
          ...r,
          bankCount: countMap[`${r.ncs_category}__${r.difficulty}`] ?? 0
        }))
      });
    } catch (err) {
      console.error("lock-status:", err);
      res.status(500).json({ error: "\uC870\uD68C \uC2E4\uD328" });
    }
  });
  app2.delete(
    "/api/ox/lock/:category/:difficulty",
    async (req, res) => {
      const { category, difficulty } = req.params;
      try {
        await releaseLock(category, difficulty);
        res.json({ success: true, message: `"${category}/${difficulty}" \uC7A0\uAE08 \uD574\uC81C` });
      } catch (err) {
        console.error("lock release:", err);
        res.status(500).json({ error: "\uD574\uC81C \uC2E4\uD328" });
      }
    }
  );
  app2.get("/api/ox/bank", async (req, res) => {
    const { category, difficulty, limit = "20" } = req.query;
    try {
      let query = `SELECT id, ncs_category, difficulty, question, answer, source, created_at
                   FROM weld_ox_bank`;
      const params = [];
      const wheres = [];
      if (category) {
        params.push(String(category));
        wheres.push(`ncs_category=$${params.length}`);
      }
      if (difficulty) {
        params.push(String(difficulty));
        wheres.push(`difficulty=$${params.length}`);
      }
      if (wheres.length > 0)
        query += ` WHERE ${wheres.join(" AND ")}`;
      params.push(Math.min(Number(limit) || 20, 100));
      query += ` ORDER BY created_at DESC LIMIT $${params.length}`;
      const { rows } = await db_default.query(query, params);
      res.json({ count: rows.length, questions: rows });
    } catch (err) {
      console.error("bank query:", err);
      res.status(500).json({ error: "\uC870\uD68C \uC2E4\uD328" });
    }
  });
  app2.post("/api/ox/test-force-lock", async (req, res) => {
    const { category, difficulty, reason = "\uD14C\uC2A4\uD2B8 \uAC15\uC81C \uC7A0\uAE08" } = req.body ?? {};
    if (!category || !difficulty) {
      return res.status(400).json({ error: "category, difficulty \uD544\uC694" });
    }
    try {
      await setLock(String(category), String(difficulty), String(reason));
      res.json({ success: true, locked: true, category, difficulty, reason });
    } catch (err) {
      console.error("force-lock:", err);
      res.status(500).json({ error: "\uAC15\uC81C \uC7A0\uAE08 \uC2E4\uD328" });
    }
  });
  app2.post("/api/ox/test-seed", async (req, res) => {
    const { category, difficulty, questions } = req.body ?? {};
    if (!category || !difficulty || !Array.isArray(questions)) {
      return res.status(400).json({ error: "category, difficulty, questions[] \uD544\uC694" });
    }
    try {
      let saved = 0;
      for (const q of questions) {
        await saveToBank(
          String(category),
          String(difficulty),
          String(q.question),
          Boolean(q.answer),
          String(q.explanation ?? "")
        );
        saved++;
      }
      res.json({ success: true, saved, category, difficulty });
    } catch (err) {
      console.error("test-seed:", err);
      res.status(500).json({ error: "\uC2DC\uB4DC \uC0BD\uC785 \uC2E4\uD328" });
    }
  });
}

// server/coaching-routes.ts
import path from "path";
import fs from "fs";

// server/replit_integrations/audio/client.ts
import OpenAI, { toFile } from "openai";
import { Buffer as Buffer2 } from "node:buffer";
import { spawn } from "child_process";
import { writeFile, unlink, readFile } from "fs/promises";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
var openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL
});
async function textToSpeech(text, voice = "alloy", format = "wav") {
  const response = await openai.chat.completions.create({
    model: "gpt-audio",
    modalities: ["text", "audio"],
    audio: { voice, format },
    messages: [
      { role: "system", content: "You are an assistant that performs text-to-speech." },
      { role: "user", content: `Repeat the following text verbatim: ${text}` }
    ]
  });
  const audioData = response.choices[0]?.message?.audio?.data ?? "";
  return Buffer2.from(audioData, "base64");
}

// server/coaching-routes.ts
var MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
var API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
var SYSTEM_PROMPT = `[Role]
You are an expert Welding Instructor providing real-time coaching to a Korean trainee.
You are analyzing a single freshly captured frame from an Endoscope Camera attached to the Welding Torch (GTAW / TIG welding).

[Visual Tasks]
On EACH frame, evaluate the following:
1. Arc Length (too long / too short / OK)
2. Travel Speed inferred from bead width and ripple spacing (too fast / too slow / OK)
3. Torch Angle (work angle, travel angle)
4. Melt Pool size, shape and stability
5. Defects: spatter, undercut, overlap, porosity, lack of fusion

[Output Rules]
- ALWAYS respond as a SINGLE JSON object: { "severity": "ok"|"warn"|"danger", "message": "..." }
- The very first character of your reply MUST be "{" and the last MUST be "}". No preamble. No explanations. No markdown. No code fences. No "Here is".
- "message" MUST be Korean. MUST be a SHORT corrective command (5~12 \uB2E8\uC5B4, \uB9C8\uCE68\uD45C 1\uAC1C).
- "severity":
  * "danger" \u2014 \uC989\uC2DC \uBA48\uCD94\uAC70\uB098 \uC2EC\uAC01\uD55C \uACB0\uD568\uC774 \uBCF4\uC774\uB294 \uACBD\uC6B0 (\uC608: \uD070 \uAE30\uACF5, \uC2EC\uD55C \uC5B8\uB354\uCEF7, \uC544\uD06C\uAC00 \uB04A\uAE40, \uC704\uD5D8)
  * "warn"   \u2014 \uAD50\uC815\uC774 \uD544\uC694\uD55C \uACBD\uC6B0 (\uC608: \uC18D\uB3C4 \uBE60\uB984, \uC544\uD06C \uAE40, \uD1A0\uCE58 \uAC01\uB3C4 \uC5B4\uAE0B\uB0A8, \uBE44\uC6A9\uC811 \uD654\uBA74)
  * "ok"     \u2014 \uC815\uC0C1 \uC6A9\uC811 \uC0C1\uD0DC
- Provide commands (\uC9C0\uC2DC) or short observations (\uAD00\uCC30). \uC608: "\uC6A9\uC811 \uC18D\uB3C4\uB97C \uC904\uC774\uC138\uC694." / "\uC544\uD06C \uAE38\uC774\uB97C \uC9E7\uAC8C." / "\uD1A0\uCE58 \uAC01\uB3C4 75\uB3C4 \uC720\uC9C0." / "\uC815\uC0C1, \uD604\uC7AC \uC18D\uB3C4 \uC720\uC9C0."

[Scene-Based Response When No Welding Visible]
If you do NOT see an active weld (no arc, no melt pool), do NOT keep repeating the same canned message. Instead, BRIEFLY DESCRIBE what you actually see and tell the user what to do. Examples (vary the wording each frame):
- \uC190\uC774 \uBCF4\uC774\uBA74: "\uC190\uC774 \uBCF4\uC785\uB2C8\uB2E4. \uC6A9\uC811 \uD1A0\uCE58\uB97C \uD654\uBA74\uC5D0 \uBE44\uCD94\uC138\uC694."
- \uC5BC\uAD74\uC774 \uBCF4\uC774\uBA74: "\uC5BC\uAD74\uC774 \uAC10\uC9C0\uB429\uB2C8\uB2E4. \uCE74\uBA54\uB77C\uB97C \uC6A9\uC811\uBD80\uB85C \uD5A5\uD558\uC138\uC694."
- \uC5B4\uB450\uC6B0\uBA74: "\uD654\uBA74\uC774 \uC5B4\uB461\uC2B5\uB2C8\uB2E4. \uC870\uBA85\uC744 \uCF1C\uAC70\uB098 \uB178\uCD9C\uC744 \uC62C\uB9AC\uC138\uC694."
- \uD750\uB9BF\uD558\uBA74: "\uCD08\uC810\uC774 \uB9DE\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. \uCE74\uBA54\uB77C\uB97C \uC548\uC815\uC2DC\uD0A4\uC138\uC694."
- \uCC9C\uC7A5/\uBCBD\uC774 \uBCF4\uC774\uBA74: "\uC6A9\uC811 \uC791\uC5C5\uBA74\uC774 \uBCF4\uC774\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. \uCE74\uBA54\uB77C \uAC01\uB3C4\uB97C \uC870\uC808\uD558\uC138\uC694."
- \uBAA8\uC7AC\uB9CC \uBCF4\uC774\uACE0 \uC544\uD06C \uC5C6\uC74C: "\uBAA8\uC7AC\uAC00 \uBCF4\uC785\uB2C8\uB2E4. \uC544\uD06C\uB97C \uC810\uD654\uD558\uC138\uC694."
- \uB108\uBB34 \uAC00\uAE4C\uC6C0: "\uB108\uBB34 \uAC00\uAE5D\uC2B5\uB2C8\uB2E4. \uAC70\uB9AC\uB97C \uB450\uC138\uC694."
- \uB108\uBB34 \uBA48: "\uC6A9\uC811 \uBD80\uC704\uAC00 \uC791\uAC8C \uBCF4\uC785\uB2C8\uB2E4. \uAC00\uAE4C\uC774 \uB2E4\uAC00\uAC00\uC138\uC694."
- \uC77C\uBC18 \uC0AC\uBB3C(\uD0A4\uBCF4\uB4DC, \uCC45\uC0C1 \uB4F1): \uADF8 \uC0AC\uBB3C \uC774\uB984\uC744 \uC9E7\uAC8C \uC5B8\uAE09\uD558\uACE0 \uCE74\uBA54\uB77C\uB97C \uC6A9\uC811 \uC791\uC5C5\uBA74\uC73C\uB85C \uC62E\uAE30\uB77C\uACE0 \uD558\uC138\uC694.
Always tailor the message to what is genuinely visible in THIS frame. NEVER output the exact same sentence two frames in a row unless the scene is identical.

- DO NOT include any text outside of the JSON object.`;
function registerCoachingRoutes(app2) {
  app2.get("/coaching-live.html", (_req, res) => {
    try {
      const p = path.resolve(
        process.cwd(),
        "server",
        "templates",
        "coaching-live.html"
      );
      const html = fs.readFileSync(p, "utf-8");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Permissions-Policy", "camera=(self), microphone=(self)");
      res.status(200).send(html);
    } catch (e) {
      res.status(500).send("template load failed: " + (e?.message || e));
    }
  });
  app2.get("/api/coaching/tts", async (req, res) => {
    const text = String(req.query.text || "").trim();
    const voice = String(req.query.voice || "nova");
    if (!text) {
      return res.status(400).send("text query required");
    }
    if (text.length > 200) {
      return res.status(400).send("text too long");
    }
    try {
      const buf = await textToSpeech(text, voice, "mp3");
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.setHeader("Content-Length", String(buf.length));
      res.status(200).send(buf);
    } catch (e) {
      console.error("[coaching] tts error:", e?.message || e);
      res.status(502).send("tts failed: " + (e?.message || "unknown"));
    }
  });
  app2.post("/api/coaching/analyze", async (req, res) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        severity: "warn",
        message: "GEMINI_API_KEY \uBBF8\uC124\uC815"
      });
    }
    const { imageBase64, mimeType } = req.body ?? {};
    if (!imageBase64 || typeof imageBase64 !== "string") {
      return res.status(400).json({ error: "imageBase64 (string) is required" });
    }
    const cleanBase64 = imageBase64.replace(/^data:image\/[a-z]+;base64,/, "");
    const mt = typeof mimeType === "string" && mimeType ? mimeType : "image/jpeg";
    const url = `${API_BASE}/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const body = {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [
        {
          role: "user",
          parts: [
            { text: "\uC774 \uD504\uB808\uC784\uC744 \uBD84\uC11D\uD558\uACE0 \uD55C\uAD6D\uC5B4 \uCF54\uCE6D \uBA58\uD2B8\uB97C JSON\uC73C\uB85C\uB9CC \uC751\uB2F5\uD558\uC138\uC694." },
            { inline_data: { mime_type: mt, data: cleanBase64 } }
          ]
        }
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            severity: { type: "STRING", enum: ["ok", "warn", "danger"] },
            message: { type: "STRING" }
          },
          required: ["severity", "message"]
        },
        // gemini-2.5-flash 는 기본적으로 내부 thinking 토큰을 소비하는데, 이 토큰이
        // maxOutputTokens 에 합산돼서 실제 응답이 잘립니다. thinkingBudget=0 으로
        // thinking 을 비활성화하면 모든 토큰이 실제 출력으로 사용됩니다.
        thinkingConfig: { thinkingBudget: 0 },
        maxOutputTokens: 256,
        temperature: 0.2
      }
    };
    try {
      const t0 = Date.now();
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const elapsed = Date.now() - t0;
      const data = await r.json();
      if (!r.ok || data.error) {
        const msg = data.error?.message || `Gemini API ${r.status}`;
        console.warn("[coaching] gemini error:", msg);
        return res.status(502).json({
          severity: "warn",
          message: "AI \uC751\uB2F5 \uC624\uB958",
          error: msg
        });
      }
      if (data.promptFeedback?.blockReason) {
        return res.json({
          severity: "warn",
          message: "\uD504\uB808\uC784 \uBD84\uC11D \uCC28\uB2E8\uB428"
        });
      }
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!text) {
        return res.json({ severity: "warn", message: "\uBD84\uC11D \uACB0\uACFC \uC5C6\uC74C" });
      }
      let parsed = null;
      const tryParse = (s) => {
        try {
          const v = JSON.parse(s);
          if (v && typeof v === "object") {
            parsed = v;
            return true;
          }
        } catch {
        }
        return false;
      };
      if (!tryParse(text)) {
        const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
        if (fenced && tryParse(fenced[1].trim())) {
        } else {
          const start = text.indexOf("{");
          const end = text.lastIndexOf("}");
          if (start >= 0 && end > start) {
            tryParse(text.slice(start, end + 1));
          }
        }
      }
      if (!parsed) {
        console.error(
          "[coaching] PARSE FAIL. finishReason=",
          data.candidates?.[0]?.finishReason,
          "rawText=",
          JSON.stringify(text)
        );
        return res.json({
          severity: "warn",
          message: "\uC751\uB2F5 \uD615\uC2DD \uC624\uB958, \uC7AC\uC2DC\uB3C4 \uC911",
          raw: text.slice(0, 200),
          finishReason: data.candidates?.[0]?.finishReason
        });
      }
      const severity = ["ok", "warn", "danger"].includes(parsed.severity ?? "") ? parsed.severity : "warn";
      const message = (parsed.message || "").trim().slice(0, 80) || "\uBD84\uC11D\uC911";
      return res.json({ severity, message, elapsedMs: elapsed, model: MODEL });
    } catch (e) {
      const err = e;
      console.warn("[coaching] fetch error:", err.message);
      return res.status(502).json({
        severity: "warn",
        message: "\uB124\uD2B8\uC6CC\uD06C \uC624\uB958",
        error: err.message
      });
    }
  });
}

// server/exam-routes.ts
async function ensureExamTable() {
  await db_default.query(`
    CREATE TABLE IF NOT EXISTS exam_records (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      course_name TEXT,
      exam_date TEXT NOT NULL,
      weld_type TEXT NOT NULL,
      material TEXT NOT NULL,
      posture TEXT NOT NULL,
      result TEXT NOT NULL,
      issuer TEXT,
      cert_number TEXT,
      memo TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}
ensureExamTable().catch(console.error);
function rowToExam(r) {
  return {
    id: r.id,
    userId: r.user_id,
    userName: r.user_name,
    courseName: r.course_name ?? void 0,
    examDate: r.exam_date,
    weldType: r.weld_type,
    material: r.material,
    posture: r.posture,
    result: r.result,
    issuer: r.issuer ?? void 0,
    certNumber: r.cert_number ?? void 0,
    memo: r.memo ?? void 0,
    createdAt: r.created_at
  };
}
function registerExamRoutes(app2) {
  app2.get("/api/exam-records", async (req, res) => {
    const { userId } = req.query;
    try {
      let result;
      if (userId) {
        result = await db_default.query(
          `SELECT * FROM exam_records WHERE user_id = $1 ORDER BY exam_date DESC, created_at DESC`,
          [userId]
        );
      } else {
        result = await db_default.query(
          `SELECT * FROM exam_records ORDER BY exam_date DESC, created_at DESC`
        );
      }
      res.json(result.rows.map(rowToExam));
    } catch (err) {
      console.error("exam-records get error:", err);
      res.status(500).json({ error: "\uC11C\uBC84 \uC624\uB958" });
    }
  });
  app2.post("/api/exam-records", async (req, res) => {
    const { userId, userName, courseName, examDate, weldType, material, posture, result, issuer, certNumber, memo } = req.body;
    const missing = [];
    if (!userId)
      missing.push("userId");
    if (!examDate)
      missing.push("examDate");
    if (!weldType)
      missing.push("weldType");
    if (missing.length > 0) {
      return res.status(400).json({ error: `\uB204\uB77D\uB41C \uD544\uB4DC: ${missing.join(", ")}` });
    }
    try {
      await ensureExamTable();
      const id = Date.now().toString() + Math.random().toString(36).substr(2, 6);
      await db_default.query(
        `INSERT INTO exam_records
         (id, user_id, user_name, course_name, exam_date, weld_type, material, posture, result, issuer, cert_number, memo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id, userId, userName || "\uBBF8\uC785\uB825", courseName || null, examDate, weldType, material, posture, result, issuer || null, certNumber || null, memo || null]
      );
      const row = await db_default.query(`SELECT * FROM exam_records WHERE id = $1`, [id]);
      res.json(rowToExam(row.rows[0]));
    } catch (err) {
      console.error("exam-records post error:", err);
      res.status(500).json({ error: "\uC11C\uBC84 \uC624\uB958" });
    }
  });
  app2.delete("/api/exam-records/:id", async (req, res) => {
    try {
      await db_default.query(`DELETE FROM exam_records WHERE id = $1`, [req.params.id]);
      res.json({ success: true });
    } catch (err) {
      console.error("exam-records delete error:", err);
      res.status(500).json({ error: "\uC11C\uBC84 \uC624\uB958" });
    }
  });
}

// server/field-routes.ts
import multer from "multer";
var upload = multer({ storage: multer.memoryStorage() });
var _rawFastapiUrl2 = process.env.FASTAPI_URL ?? "http://127.0.0.1:8080";
var FASTAPI_BASE2 = _rawFastapiUrl2.startsWith("http") ? _rawFastapiUrl2 : `https://${_rawFastapiUrl2}`;
var ANALYSIS_TIMEOUT_MS = 9e4;
var IS_RENDER_WITHOUT_FASTAPI = !process.env.FASTAPI_URL && !!process.env.RENDER;
console.log(
  `[field-routes] FastAPI \uC8FC\uC18C: ${FASTAPI_BASE2}` + (IS_RENDER_WITHOUT_FASTAPI ? " \u26A0 Render \uD658\uACBD \u2014 FastAPI \uBBF8\uBC30\uD3EC, \uBE44\uC804 \uBD84\uC11D \uBE44\uD65C\uC131" : "")
);
(async () => {
  try {
    const r = await fetch(`${FASTAPI_BASE2}/docs`, {
      signal: AbortSignal.timeout(5e3)
    });
    console.log(`[field-routes] \u2705 FastAPI \uC751\uB2F5 \uD655\uC778 (${r.status}) \u2014 ${FASTAPI_BASE2}`);
  } catch (e) {
    const cause = e.cause?.message ?? e.message ?? "\uC54C \uC218 \uC5C6\uB294 \uC624\uB958";
    console.warn(`[field-routes] \u26A0 FastAPI \uBBF8\uC751\uB2F5: ${FASTAPI_BASE2}`);
    console.warn(`[field-routes]   \uC6D0\uC778: ${cause}`);
    console.warn(`[field-routes]   \uBE44\uC804 \uBD84\uC11D \uAE30\uB2A5\uC774 \uB3D9\uC791\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.`);
    console.warn(`[field-routes]   \uD574\uACB0: npm run dev:all \uB85C FastAPI\uC640 Node.js\uB97C \uD568\uAED8 \uC2DC\uC791\uD558\uC138\uC694.`);
  }
})();
async function _fieldFetch(url, options, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}
ensureFieldTables().catch(console.error);
var DUMMY_WELDERS = [
  { name: "\uAE40\uCCA0\uC218", role: "field_worker" },
  { name: "\uC774\uC601\uD76C", role: "field_worker" },
  { name: "\uBC15\uBBFC\uC900", role: "field_worker" },
  { name: "\uCD5C\uD604\uC6B0", role: "field_worker" },
  { name: "\uC815\uC218\uC9C4", role: "field_manager" }
];
var DUMMY_PROJECTS = ["\uAD50\uB7C9 \uBCF4\uC218\uACF5\uC0AC", "\uD50C\uB79C\uD2B8 \uBC30\uAD00", "\uC870\uC120\uC18C \uC120\uCCB4", "\uAC74\uCD95 \uCCA0\uACE8", "\uD574\uC591 \uAD6C\uC870\uBB3C"];
var DUMMY_DEFECT_TYPES = ["\uC5B8\uB354\uCEF7", "\uAE30\uACF5", "\uC2A4\uD328\uD130", "\uD06C\uB799", "\uC624\uBC84\uB7A9", "\uC6A9\uCC29\uBD88\uB7C9", "\uC544\uD06C\uC2A4\uD2B8\uB77C\uC774\uD06C"];
function rand(min, max) {
  return Math.random() * (max - min) + min;
}
function randInt(min, max) {
  return Math.floor(rand(min, max + 1));
}
function randPick(arr) {
  return arr[randInt(0, arr.length - 1)];
}
function registerFieldRoutes(app2) {
  console.log("[field-routes] \uB77C\uC6B0\uD2B8 \uB4F1\uB85D \uC2DC\uC791");
  app2.get("/api/field/users", async (_req, res) => {
    try {
      const { rows } = await db_default.query(
        `SELECT * FROM field_users ORDER BY created_at DESC`
      );
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app2.post("/api/field/users", async (req, res) => {
    const { name, role } = req.body;
    if (!name || !role) {
      return res.status(400).json({ error: "name, role \uD544\uC218" });
    }
    try {
      const { rows } = await db_default.query(
        `INSERT INTO field_users (name, role) VALUES ($1, $2) RETURNING *`,
        [name, role]
      );
      res.status(201).json(rows[0]);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app2.get("/api/field/records", async (req, res) => {
    const welder_id = req.query.welder_id ? Number(req.query.welder_id) : void 0;
    try {
      const { rows } = welder_id ? await db_default.query(
        `SELECT * FROM field_weld_records WHERE welder_id = $1 ORDER BY created_at DESC`,
        [welder_id]
      ) : await db_default.query(
        `SELECT * FROM field_weld_records ORDER BY created_at DESC LIMIT 100`
      );
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app2.post("/api/field/records", async (req, res) => {
    const { welder_id, project_name, current_amp, voltage_volt } = req.body;
    if (!welder_id)
      return res.status(400).json({ error: "welder_id \uD544\uC218" });
    try {
      const { rows } = await db_default.query(
        `INSERT INTO field_weld_records (welder_id, project_name, current_amp, voltage_volt)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [welder_id, project_name ?? "", current_amp ?? null, voltage_volt ?? null]
      );
      res.status(201).json(rows[0]);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app2.get("/api/field/inspections", async (req, res) => {
    const record_id = req.query.record_id ? Number(req.query.record_id) : void 0;
    try {
      const { rows } = record_id ? await db_default.query(
        `SELECT * FROM field_inspections WHERE record_id = $1 ORDER BY created_at DESC`,
        [record_id]
      ) : await db_default.query(
        `SELECT * FROM field_inspections ORDER BY created_at DESC LIMIT 100`
      );
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app2.post("/api/field/inspections", async (req, res) => {
    const {
      record_id,
      original_image_url,
      ppm_scale,
      avg_bead_width,
      straightness_error,
      final_status
    } = req.body;
    if (!record_id || !final_status) {
      return res.status(400).json({ error: "record_id, final_status \uD544\uC218" });
    }
    try {
      const { rows } = await db_default.query(
        `INSERT INTO field_inspections
           (record_id, original_image_url, ppm_scale, avg_bead_width, straightness_error, final_status)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [
          record_id,
          original_image_url ?? null,
          ppm_scale ?? null,
          avg_bead_width ?? null,
          straightness_error ?? null,
          final_status
        ]
      );
      res.status(201).json(rows[0]);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app2.get("/api/field/defects", async (req, res) => {
    const inspection_id = req.query.inspection_id ? Number(req.query.inspection_id) : void 0;
    if (!inspection_id)
      return res.status(400).json({ error: "inspection_id \uD544\uC218" });
    try {
      const { rows } = await db_default.query(
        `SELECT * FROM field_defects WHERE inspection_id = $1 ORDER BY confidence DESC`,
        [inspection_id]
      );
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app2.post("/api/field/defects", async (req, res) => {
    const { inspection_id, defect_type, confidence, size_mm } = req.body;
    if (!inspection_id || !defect_type) {
      return res.status(400).json({ error: "inspection_id, defect_type \uD544\uC218" });
    }
    try {
      const { rows } = await db_default.query(
        `INSERT INTO field_defects (inspection_id, defect_type, confidence, size_mm)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [inspection_id, defect_type, confidence ?? null, size_mm ?? null]
      );
      res.status(201).json(rows[0]);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app2.get("/api/field/dashboard/summary", async (_req, res) => {
    try {
      const [totals, defectSummary, topWelders] = await Promise.all([
        db_default.query(`
          SELECT
            COUNT(*)                                         AS total_inspections,
            COUNT(*) FILTER (WHERE final_status = 'PASS')   AS pass_count,
            COUNT(*) FILTER (WHERE final_status = 'FAIL')   AS fail_count,
            ROUND(
              COUNT(*) FILTER (WHERE final_status = 'PASS')
              * 100.0 / NULLIF(COUNT(*), 0), 1
            )                                               AS pass_rate
          FROM field_inspections
        `),
        db_default.query(`
          SELECT defect_type, COUNT(*) AS cnt
          FROM field_defects
          GROUP BY defect_type
          ORDER BY cnt DESC
          LIMIT 5
        `),
        db_default.query(`
          SELECT
            u.id, u.name,
            COUNT(i.id)                                          AS total,
            COUNT(i.id) FILTER (WHERE i.final_status = 'PASS')  AS passed,
            ROUND(
              COUNT(i.id) FILTER (WHERE i.final_status = 'PASS')
              * 100.0 / NULLIF(COUNT(i.id), 0), 1
            )                                                    AS pass_rate
          FROM field_users u
          JOIN field_weld_records r ON r.welder_id = u.id
          JOIN field_inspections i  ON i.record_id = r.id
          WHERE u.role = 'field_worker'
          GROUP BY u.id, u.name
          ORDER BY pass_rate DESC
          LIMIT 10
        `)
      ]);
      res.json({
        totals: totals.rows[0],
        top_defects: defectSummary.rows,
        top_welders: topWelders.rows
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app2.delete("/api/field/clear", async (_req, res) => {
    try {
      await db_default.query("DELETE FROM field_defects");
      await db_default.query("DELETE FROM field_inspections");
      await db_default.query("DELETE FROM field_weld_records");
      console.log("[field/clear] \uAC80\uC0AC \uB370\uC774\uD130 \uC804\uCCB4 \uC0AD\uC81C \uC644\uB8CC");
      res.json({ ok: true, message: "\uBAA8\uB4E0 \uAC80\uC0AC \uB370\uC774\uD130\uAC00 \uC0AD\uC81C\uB418\uC5C8\uC2B5\uB2C8\uB2E4." });
    } catch (e) {
      console.error("[field/clear] \uC0AD\uC81C \uC2E4\uD328:", e.message);
      res.status(500).json({ error: e.message });
    }
  });
  app2.post("/api/field/seed", async (req, res) => {
    const recordsPerUser = Number(req.query.records ?? 5);
    const client = await db_default.connect();
    try {
      await client.query("BEGIN");
      const insertedUsers = [];
      for (const w of DUMMY_WELDERS) {
        const existing = await client.query(
          `SELECT id FROM field_users WHERE name = $1`,
          [w.name]
        );
        if (existing.rows.length > 0) {
          insertedUsers.push(existing.rows[0].id);
        } else {
          const { rows } = await client.query(
            `INSERT INTO field_users (name, role) VALUES ($1, $2) RETURNING id`,
            [w.name, w.role]
          );
          insertedUsers.push(rows[0].id);
        }
      }
      let totalRecords = 0;
      let totalInspections = 0;
      let totalDefects = 0;
      for (const userId of insertedUsers) {
        for (let i = 0; i < recordsPerUser; i++) {
          const daysAgo = randInt(0, 30);
          const createdAt = new Date(Date.now() - daysAgo * 864e5).toISOString();
          const { rows: recRows } = await client.query(
            `INSERT INTO field_weld_records
               (welder_id, project_name, current_amp, voltage_volt, created_at)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [
              userId,
              randPick(DUMMY_PROJECTS),
              parseFloat(rand(120, 300).toFixed(1)),
              // 전류 120~300 A
              parseFloat(rand(18, 40).toFixed(1)),
              // 전압 18~40 V
              createdAt
            ]
          );
          const recordId = recRows[0].id;
          totalRecords++;
          const inspectionCount = randInt(1, 2);
          for (let j = 0; j < inspectionCount; j++) {
            const beadWidth = parseFloat(rand(6, 18).toFixed(2));
            const straightErr = parseFloat(rand(0.1, 3.5).toFixed(2));
            const status = Math.random() < 0.72 ? "PASS" : "FAIL";
            const { rows: insRows } = await client.query(
              `INSERT INTO field_inspections
                 (record_id, ppm_scale, avg_bead_width, straightness_error, final_status, created_at)
               VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
              [
                recordId,
                parseFloat(rand(28, 45).toFixed(4)),
                // ppm_scale
                beadWidth,
                straightErr,
                status,
                createdAt
              ]
            );
            const inspectionId = insRows[0].id;
            totalInspections++;
            const defectCount = status === "FAIL" ? randInt(1, 4) : randInt(0, 1);
            for (let k = 0; k < defectCount; k++) {
              await client.query(
                `INSERT INTO field_defects (inspection_id, defect_type, confidence, size_mm)
                 VALUES ($1, $2, $3, $4)`,
                [
                  inspectionId,
                  randPick(DUMMY_DEFECT_TYPES),
                  parseFloat(rand(40, 99).toFixed(2)),
                  parseFloat(rand(0.3, 5).toFixed(2))
                ]
              );
              totalDefects++;
            }
          }
        }
      }
      await client.query("COMMIT");
      res.json({
        message: "\uB354\uBBF8 \uB370\uC774\uD130 \uC0DD\uC131 \uC644\uB8CC",
        users: insertedUsers.length,
        records: totalRecords,
        inspections: totalInspections,
        defects: totalDefects
      });
    } catch (e) {
      await client.query("ROLLBACK");
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });
  console.log("[field-routes] POST /api/field/analysis \uB77C\uC6B0\uD2B8 \uB4F1\uB85D \uC911 (multer \uD3EC\uD568)");
  app2.post(
    "/api/field/analysis",
    upload.single("image"),
    async (req, res) => {
      const file = req.file;
      console.log(
        `[field/analysis] \uC694\uCCAD \uC218\uC2E0 | file=${file ? `${file.originalname}(${file.size}B)` : "\uC5C6\uC74C"} | body=${JSON.stringify(Object.keys(req.body))}`
      );
      if (!file) {
        console.warn("[field/analysis] multer: \uD30C\uC77C \uB204\uB77D \u2014 FormData \uD544\uB4DC\uBA85 \uB610\uB294 Content-Type \uD655\uC778 \uD544\uC694");
        return res.status(400).json({ error: "image \uD30C\uC77C\uC774 \uD544\uC694\uD569\uB2C8\uB2E4" });
      }
      if (IS_RENDER_WITHOUT_FASTAPI) {
        return res.status(503).json({
          error: "FASTAPI_NOT_DEPLOYED",
          message: "\uBE44\uC804 \uBD84\uC11D \uAE30\uB2A5\uC740 \uB85C\uCEEC \uAC1C\uBC1C \uD658\uACBD\uC5D0\uC11C\uB9CC \uC0AC\uC6A9 \uAC00\uB2A5\uD569\uB2C8\uB2E4. PC\uC5D0\uC11C npm run dev:all \uBA85\uB839\uC73C\uB85C FastAPI\uC640 Node.js\uB97C \uD568\uAED8 \uC2DC\uC791\uD558\uACE0, Expo\uB97C EXPO_PUBLIC_DOMAIN=http://<\uCEF4\uD4E8\uD130_IP>:5001 \uB85C \uC2E4\uD589\uD558\uC138\uC694."
        });
      }
      const {
        project_name,
        current_amp,
        voltage_volt,
        worker_name
      } = req.body;
      const client = await db_default.connect();
      try {
        const wName = worker_name?.trim() || "\uD604\uC7A5 \uC791\uC5C5\uC790";
        let userId;
        const existing = await client.query(
          `SELECT id FROM field_users WHERE name = $1 AND role = 'field_worker' LIMIT 1`,
          [wName]
        );
        if (existing.rows.length > 0) {
          userId = existing.rows[0].id;
        } else {
          const created = await client.query(
            `INSERT INTO field_users (name, role) VALUES ($1, 'field_worker') RETURNING id`,
            [wName]
          );
          userId = created.rows[0].id;
        }
        const recRes = await client.query(
          `INSERT INTO field_weld_records (welder_id, project_name, current_amp, voltage_volt)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [
            userId,
            project_name ?? "",
            current_amp ? parseFloat(current_amp) : null,
            voltage_volt ? parseFloat(voltage_volt) : null
          ]
        );
        const recordId = recRes.rows[0].id;
        const fileBlob = new Blob(
          [file.buffer.buffer.slice(
            file.buffer.byteOffset,
            file.buffer.byteOffset + file.buffer.byteLength
          )],
          { type: file.mimetype || "image/jpeg" }
        );
        const formData = new FormData();
        formData.append("file", fileBlob, file.originalname || "weld.jpg");
        formData.append("process", "FCAW");
        formData.append("posture", "1G");
        formData.append("material", "\uD0C4\uC18C\uAC15 \uD3C9\uD310");
        formData.append("bead_type", "\uC704\uBE59 \uBE44\uB4DC");
        formData.append("pass_type", "");
        formData.append("ai_model", "gpt");
        formData.append("admin_feedback", "");
        formData.append("user_history", "");
        formData.append("measurement_context", "");
        formData.append("plate_thickness", "");
        formData.append("pipe_outer_diameter_mm", "");
        formData.append("language", "ko");
        formData.append("analysis_mode", "quick");
        formData.append("is_fillet", "false");
        formData.append("has_laser", "true");
        formData.append("laser_angle_deg", "45");
        formData.append("shooting_angle_deg", "45");
        const faUrl = `${FASTAPI_BASE2}/analyze-welding`;
        console.log(`[field/analysis] FastAPI \uD638\uCD9C: POST ${faUrl} | \uD30C\uC77C: ${file.size}B | \uBAA8\uB4DC: quick`);
        const faResp = await _fieldFetch(
          faUrl,
          { method: "POST", body: formData },
          ANALYSIS_TIMEOUT_MS
        );
        if (!faResp.ok) {
          const errText = await faResp.text().catch(() => "");
          let userMsg = "\uC0AC\uC9C4 \uBD84\uC11D\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4. \uC6A9\uC811\uBD80\uAC00 \uBA85\uD655\uD55C \uC0AC\uC9C4\uC744 \uC0AC\uC6A9\uD574 \uC8FC\uC138\uC694.";
          try {
            userMsg = JSON.parse(errText)?.message ?? userMsg;
          } catch {
          }
          const err = new Error(userMsg);
          err.status = faResp.status;
          throw err;
        }
        const fa = await faResp.json();
        const _cleanLen = (fa.visionMeasurement?.clean_image_base64 ?? "").length;
        console.log(`[field/cleanImage] FastAPI \uC218\uC2E0: visionMeasurement.clean_image_base64 \uAE38\uC774=${_cleanLen}`);
        const finalStatus = fa.overallVerdict === "PASS" ? "PASS" : "FAIL";
        const aiScore = fa.aiScore ?? null;
        const vm = fa.visionMeasurement ?? {};
        const avgBeadWidth = vm.bead_width_max != null && vm.bead_width_min != null ? parseFloat(
          ((Number(vm.bead_width_max) + Number(vm.bead_width_min)) / 2).toFixed(2)
        ) : null;
        const straightnessError = vm.straightness_variance != null ? parseFloat(Number(vm.straightness_variance).toFixed(2)) : null;
        const detectedDefects = (fa.defects ?? []).filter((d) => d.detected === true).map((d) => ({
          name: d.name ?? "\uC54C \uC218 \uC5C6\uB294 \uACB0\uD568",
          severity: d.severity ?? "\uBCF4\uD1B5",
          confidence: d.confidence ?? 0
        }));
        const detectedIsFillet = fa.filletAnalysis != null;
        const detectedWeldType = detectedIsFillet ? "fillet" : "butt";
        const insRes = await client.query(
          `INSERT INTO field_inspections
             (record_id, ppm_scale, avg_bead_width, straightness_error, final_status, weld_type)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [
            recordId,
            vm.ppm ?? null,
            avgBeadWidth,
            straightnessError,
            finalStatus,
            detectedWeldType
          ]
        );
        const inspectionId = insRes.rows[0].id;
        for (const d of detectedDefects) {
          await client.query(
            `INSERT INTO field_defects (inspection_id, defect_type, confidence)
             VALUES ($1, $2, $3)`,
            [inspectionId, d.name, d.confidence]
          );
        }
        res.json({
          inspection_id: inspectionId,
          record_id: recordId,
          final_status: finalStatus,
          ai_score: aiScore,
          avg_bead_width: avgBeadWidth,
          straightness_error: straightnessError,
          defect_count: detectedDefects.length,
          defects: detectedDefects,
          // 교육원 모드 진단 페이지(diagnosis/[id])에 필요한 전체 비전 분석 데이터
          full_analysis: {
            ...fa,
            laserAnalysis: fa.visionMeasurement?.laser_analysis ?? null,
            filletAnalysis: fa.filletAnalysis ?? null,
            isFillet: detectedIsFillet,
            weld_type: detectedWeldType,
            // 레이저 제거 이미지: DB 비저장, 분석 직후 히트맵 배경으로만 사용
            cleanImageBase64: fa.visionMeasurement?.clean_image_base64 ?? "",
            debugMetrics: fa.visionMeasurement?.debug_metrics ?? null,
            // 진단: full_analysis 반환 직전 로그
            ...(console.log(`[field/cleanImage] full_analysis \uBC18\uD658: cleanImageBase64 \uAE38\uC774=${(fa.visionMeasurement?.clean_image_base64 ?? "").length}`), {})
          }
        });
      } catch (e) {
        const isFetch = e.message?.includes("fetch failed") || e.message?.includes("ECONNREFUSED");
        const isTimeout = e.name === "AbortError";
        const status = e.status ?? (isFetch || isTimeout ? 503 : 500);
        console.error("\u2500\u2500\u2500 [field/analysis] \uC624\uB958 \uBC1C\uC0DD \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
        console.error("  message   :", e.message?.slice(0, 300));
        console.error("  cause     :", e.cause?.message ?? "N/A");
        console.error("  causeCode :", e.cause?.code ?? "N/A");
        console.error("  status    :", e.status ?? "N/A");
        console.error("  isFetch   :", isFetch);
        console.error("  timeout   :", isTimeout);
        console.error("  faUrl     :", `${FASTAPI_BASE2}/analyze-welding`);
        console.error("  stack     :", e.stack?.split("\n").slice(0, 4).join(" | "));
        console.error("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
        res.status(status).json({
          error: "ANALYSIS_FAILED",
          message: isFetch ? `\uBE44\uC804 \uBD84\uC11D Python \uC11C\uBC84(${FASTAPI_BASE2})\uC5D0 \uC5F0\uACB0\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. npm run dev:all \uBA85\uB839\uC73C\uB85C FastAPI\uC640 Node.js\uB97C \uD568\uAED8 \uC2DC\uC791\uD588\uB294\uC9C0 \uD655\uC778\uD558\uC138\uC694.` : isTimeout ? `\uBE44\uC804 \uBD84\uC11D \uC2DC\uAC04 \uCD08\uACFC (90\uCD08). ${FASTAPI_BASE2} \uC11C\uBC84 \uC751\uB2F5\uC744 \uAE30\uB2E4\uB9AC\uB2E4 \uC911\uB2E8\uB410\uC2B5\uB2C8\uB2E4.` : e.message ?? "\uBD84\uC11D \uC2E4\uD328"
        });
      } finally {
        client.release();
      }
    }
  );
  console.log("[field-routes] \uB77C\uC6B0\uD2B8 \uB4F1\uB85D \uC644\uB8CC: /api/field/* (analysis, seed, dashboard, users, records, inspections, defects)");
}

// server/routes.ts
async function registerRoutes(app2) {
  registerAuthRoutes(app2);
  registerResultsRoutes(app2);
  registerTheoryRoutes(app2);
  registerOxRoutes(app2);
  registerCoachingRoutes(app2);
  registerWeldAnalysisRoute(app2);
  registerExamRoutes(app2);
  registerFieldRoutes(app2);
  return createServer(app2);
}

// server/index.ts
import * as fs2 from "fs";
import * as path2 from "path";
var app = express3();
var log = console.log;
function setupCors(app2) {
  app2.use((req, res, next) => {
    const origins = /* @__PURE__ */ new Set();
    if (process.env.REPLIT_DEV_DOMAIN) {
      origins.add(`https://${process.env.REPLIT_DEV_DOMAIN}`);
    }
    if (process.env.REPLIT_DOMAINS) {
      process.env.REPLIT_DOMAINS.split(",").forEach((d) => {
        origins.add(`https://${d.trim()}`);
      });
    }
    const origin = req.header("origin");
    const isLocalhost = origin?.startsWith("http://localhost:") || origin?.startsWith("http://127.0.0.1:");
    if (origin && (origins.has(origin) || isLocalhost)) {
      res.header("Access-Control-Allow-Origin", origin);
      res.header(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS"
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
function setupBodyParsing(app2) {
  app2.use(
    express3.json({
      limit: "50mb",
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      }
    })
  );
  app2.use(express3.urlencoded({ extended: false, limit: "50mb" }));
}
function setupRequestLogging(app2) {
  app2.use((req, res, next) => {
    const start = Date.now();
    const path3 = req.path;
    let capturedJsonResponse = void 0;
    const originalResJson = res.json;
    res.json = function(bodyJson, ...args) {
      capturedJsonResponse = bodyJson;
      return originalResJson.apply(res, [bodyJson, ...args]);
    };
    res.on("finish", () => {
      if (!path3.startsWith("/api"))
        return;
      const duration = Date.now() - start;
      let logLine = `${req.method} ${path3} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }
      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "\u2026";
      }
      log(logLine);
    });
    next();
  });
}
function getAppName() {
  try {
    const appJsonPath = path2.resolve(process.cwd(), "app.json");
    const appJsonContent = fs2.readFileSync(appJsonPath, "utf-8");
    const appJson = JSON.parse(appJsonContent);
    return appJson.expo?.name || "App Landing Page";
  } catch {
    return "App Landing Page";
  }
}
function serveExpoManifest(platform, res) {
  const manifestPath = path2.resolve(
    process.cwd(),
    "static-build",
    platform,
    "manifest.json"
  );
  if (!fs2.existsSync(manifestPath)) {
    return res.status(404).json({ error: `Manifest not found for platform: ${platform}` });
  }
  res.setHeader("expo-protocol-version", "1");
  res.setHeader("expo-sfv-version", "0");
  res.setHeader("content-type", "application/json");
  const manifest = fs2.readFileSync(manifestPath, "utf-8");
  res.send(manifest);
}
function serveLandingPage({
  req,
  res,
  landingPageTemplate,
  appName
}) {
  const forwardedProto = req.header("x-forwarded-proto");
  const protocol = forwardedProto || req.protocol || "https";
  const forwardedHost = req.header("x-forwarded-host");
  const host = forwardedHost || req.get("host");
  const baseUrl = `${protocol}://${host}`;
  const expsUrl = `${host}`;
  log(`baseUrl`, baseUrl);
  log(`expsUrl`, expsUrl);
  const html = landingPageTemplate.replace(/BASE_URL_PLACEHOLDER/g, baseUrl).replace(/EXPS_URL_PLACEHOLDER/g, expsUrl).replace(/APP_NAME_PLACEHOLDER/g, appName);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(html);
}
function configureExpoAndLanding(app2) {
  const templatePath = path2.resolve(
    process.cwd(),
    "server",
    "templates",
    "landing-page.html"
  );
  const landingPageTemplate = fs2.readFileSync(templatePath, "utf-8");
  const appName = getAppName();
  log("Serving static Expo files with dynamic manifest routing");
  app2.use((req, res, next) => {
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
        appName
      });
    }
    next();
  });
  app2.use("/assets", express3.static(path2.resolve(process.cwd(), "assets")));
  app2.use(express3.static(path2.resolve(process.cwd(), "static-build")));
  log("Expo routing: Checking expo-platform header on / and /manifest");
}
function setupErrorHandler(app2) {
  app2.use((err, _req, res, next) => {
    const error = err;
    const status = error.status || error.statusCode || 500;
    const message = error.message || "Internal Server Error";
    console.error("Internal Server Error:", err);
    if (res.headersSent) {
      return next(err);
    }
    return res.status(status).json({ message });
  });
}
(async () => {
  setupCors(app);
  setupBodyParsing(app);
  setupRequestLogging(app);
  configureExpoAndLanding(app);
  const server = await registerRoutes(app);
  setupErrorHandler(app);
  const basePort = parseInt(process.env.PORT || "5001", 10);
  function tryListen(port, remaining) {
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE" && remaining > 0) {
        const next = port + 1;
        log(`\u26A0 \uD3EC\uD2B8 ${port} \uC0AC\uC6A9 \uC911 \u2192 \uD3EC\uD2B8 ${next} \uC790\uB3D9 \uC804\uD658 (\uB0A8\uC740 \uC2DC\uB3C4: ${remaining - 1}\uD68C)`);
        tryListen(next, remaining - 1);
      } else {
        log(`\uC11C\uBC84 \uC2DC\uC791 \uC2E4\uD328 (${err.code ?? err.message})`);
        process.exit(1);
      }
    });
    server.listen({ port }, () => {
      log(`express server serving on port ${port}`);
    });
  }
  tryListen(basePort, 5);
})();
