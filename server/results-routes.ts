import type { Express, Request, Response } from "express";
import pool from "./db";
import { uploadBase64ToGoogleDrive } from "./google-drive";
import express from "express";

const largeBodyParser = express.json({ limit: "30mb" });

async function ensureColumns() {
  await pool.query(`ALTER TABLE weld_results ADD COLUMN IF NOT EXISTS user_course_name TEXT`);
  await pool.query(`ALTER TABLE weld_results ADD COLUMN IF NOT EXISTS bead_type TEXT`);
}
ensureColumns().catch(console.error);

// 과거 데이터 보정: 측면/이면 사진 URL은 있는데 분석 데이터가 누락된 행에
// 빈 분석 엔트리를 채워서 프론트엔드가 "분석중/미업로드" 대신 정확한 메시지를 보여주게 함.
// 예전 버전 백엔드에서 vision 분석 실패 시 photoAnalyses[view]를 통째로 빠뜨린 버그의 잔재 보정.
async function backfillMissingPhotoAnalyses() {
  try {
    const fallback = `jsonb_build_object(
      'beadAnalysis', NULL::jsonb,
      'defects', '[]'::jsonb,
      'defectLocations', '[]'::jsonb,
      'straightnessLines', '[]'::jsonb,
      'analysisStatus', 'no_bead_detected'
    )`;
    const sideResult = await pool.query(`
      UPDATE weld_results
      SET photo_analyses = COALESCE(photo_analyses, '{}'::jsonb) || jsonb_build_object('side', ${fallback})
      WHERE photos->>'side' IS NOT NULL AND (photo_analyses IS NULL OR (photo_analyses->'side') IS NULL)
    `);
    const backResult = await pool.query(`
      UPDATE weld_results
      SET photo_analyses = COALESCE(photo_analyses, '{}'::jsonb) || jsonb_build_object('back', ${fallback})
      WHERE photos->>'back' IS NOT NULL AND (photo_analyses IS NULL OR (photo_analyses->'back') IS NULL)
    `);
    const total = (sideResult.rowCount ?? 0) + (backResult.rowCount ?? 0);
    if (total > 0) {
      console.log(
        `[Migration] photo_analyses 보정 완료 — 측면 ${sideResult.rowCount ?? 0}행, 이면 ${backResult.rowCount ?? 0}행`
      );
    }
  } catch (err) {
    console.error("[Migration] photo_analyses 보정 실패:", err);
  }
}
backfillMissingPhotoAnalyses().catch(console.error);

async function ensureAdminFeedbackTable() {
  await pool.query(`
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS weld_comments (
      id SERIAL PRIMARY KEY,
      result_id VARCHAR(255) NOT NULL,
      parent_id INT REFERENCES weld_comments(id) ON DELETE CASCADE,
      user_id VARCHAR(255) NOT NULL,
      user_name VARCHAR(255) NOT NULL,
      user_role VARCHAR(50) NOT NULL DEFAULT '교육생',
      content TEXT NOT NULL,
      created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_weld_comments_result_id ON weld_comments(result_id)`);
}
ensureCommentsTable().catch(console.error);

function isValidDisplayUrl(val: any): boolean {
  return typeof val === "string" && (
    val.startsWith("http://") ||
    val.startsWith("https://") ||
    val.startsWith("data:") ||
    val.startsWith("file://")
  );
}

function rowToResult(row: any) {
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    userProfileUri: row.user_profile_uri,
    userCourseName: row.user_course_name ?? undefined,
    photoUri: row.photo_uri,
    photos: row.photos,
    process: row.process,
    processCustom: row.process_custom,
    posture: row.posture,
    postureCustom: row.posture_custom,
    material: row.material,
    materialCustom: row.material_custom,
    beadType: row.bead_type ?? undefined,
    selfScore: row.self_score,
    aiScore: row.ai_score,
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
  };
}

function rowToResultLite(row: any) {
  const r = rowToResult(row);
  const stripPhoto = (v: any) => (isValidDisplayUrl(v) ? v : undefined);
  const photos = r.photos as any;
  const litePhotos = photos
    ? {
        front: stripPhoto(photos.front),
        side: stripPhoto(photos.side),
        back: stripPhoto(photos.back),
      }
    : undefined;
  return {
    ...r,
    photoUri: stripPhoto(r.photoUri),
    photos: litePhotos,
  };
}

export function registerResultsRoutes(app: Express): void {
  // 사진 base64 → 구글 드라이브 업로드 후 URL 반환
  app.post("/api/upload-photo", largeBodyParser, async (req: Request, res: Response) => {
    const { base64, fileName } = req.body;
    if (!base64 || !fileName) return res.status(400).json({ error: "base64, fileName 필요" });
    try {
      const url = await uploadBase64ToGoogleDrive(base64, fileName);
      res.json({ url });
    } catch (err) {
      console.error("드라이브 업로드 오류:", err);
      res.status(500).json({ error: "사진 업로드 실패" });
    }
  });

  app.get("/api/results", async (_req: Request, res: Response) => {
    try {
      const result = await pool.query(
        "SELECT r.*, COALESCE(r.user_course_name, u.course_name) as user_course_name FROM weld_results r LEFT JOIN weld_users u ON r.user_id = u.id ORDER BY r.timestamp DESC"
      );
      res.json(result.rows.map(rowToResultLite));
    } catch (err) {
      console.error("get results error:", err);
      res.status(500).json({ error: "서버 오류" });
    }
  });

  app.get("/api/results/user/:userId", async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        "SELECT r.*, COALESCE(r.user_course_name, u.course_name) as user_course_name FROM weld_results r LEFT JOIN weld_users u ON r.user_id = u.id WHERE r.user_id = $1 ORDER BY r.timestamp DESC",
        [req.params.userId]
      );
      res.json(result.rows.map(rowToResultLite));
    } catch (err) {
      console.error("get user results error:", err);
      res.status(500).json({ error: "서버 오류" });
    }
  });

  app.get("/api/results/:id", async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        "SELECT r.*, COALESCE(r.user_course_name, u.course_name) as user_course_name FROM weld_results r LEFT JOIN weld_users u ON r.user_id = u.id WHERE r.id = $1",
        [req.params.id]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: "결과를 찾을 수 없습니다." });
      res.json(rowToResult(result.rows[0]));
    } catch (err) {
      console.error("get result error:", err);
      res.status(500).json({ error: "서버 오류" });
    }
  });

  app.post("/api/results", async (req: Request, res: Response) => {
    const r = req.body;
    if (!r.id || !r.userId) return res.status(400).json({ error: "필수 항목이 없습니다." });
    try {
      await pool.query(
        `INSERT INTO weld_results (
          id, user_id, user_name, user_profile_uri, user_course_name, photo_uri, photos,
          process, process_custom, posture, posture_custom, material, material_custom,
          bead_type, self_score, ai_score, grade, overall_verdict,
          bead_analysis, defects, defect_locations, photo_analyses, improvements,
          comprehensive_report, top3_defects, trend_scores, timestamp
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
          $13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27
        ) ON CONFLICT (id) DO NOTHING`,
        [
          r.id, r.userId, r.userName, r.userProfileUri ?? null, r.userCourseName ?? null,
          r.photoUri ?? null, JSON.stringify(r.photos ?? null),
          r.process, r.processCustom ?? null, r.posture, r.postureCustom ?? null,
          r.material, r.materialCustom ?? null,
          r.beadType ?? null,
          r.selfScore, r.aiScore, r.grade, r.overallVerdict,
          JSON.stringify(r.beadAnalysis), JSON.stringify(r.defects),
          JSON.stringify(r.defectLocations ?? []),
          r.photoAnalyses ? JSON.stringify(r.photoAnalyses) : null,
          JSON.stringify(r.improvements ?? []),
          r.comprehensiveReport ?? null, JSON.stringify(r.top3Defects ?? []),
          JSON.stringify(r.trendScores ?? []), r.timestamp,
        ]
      );
      res.json({ success: true });
    } catch (err) {
      console.error("add result error:", err);
      res.status(500).json({ error: "서버 오류" });
    }
  });

  app.delete("/api/results/:id", async (req: Request, res: Response) => {
    try {
      await pool.query("DELETE FROM weld_results WHERE id = $1", [req.params.id]);
      res.json({ success: true });
    } catch (err) {
      console.error("delete result error:", err);
      res.status(500).json({ error: "서버 오류" });
    }
  });

  app.put("/api/results/:id/photos", async (req: Request, res: Response) => {
    const { photoUri, photos } = req.body;
    try {
      await pool.query(
        `UPDATE weld_results SET
          photo_uri = COALESCE($1, photo_uri),
          photos = COALESCE($2::jsonb, photos)
        WHERE id = $3`,
        [photoUri ?? null, photos ? JSON.stringify(photos) : null, req.params.id]
      );
      res.json({ success: true });
    } catch (err) {
      console.error("update photos error:", err);
      res.status(500).json({ error: "서버 오류" });
    }
  });

  app.put("/api/results/:id/profile", async (req: Request, res: Response) => {
    const { userName, userProfileUri } = req.body;
    try {
      await pool.query(
        "UPDATE weld_results SET user_name = COALESCE($1, user_name), user_profile_uri = COALESCE($2, user_profile_uri) WHERE user_id = $3",
        [userName ?? null, userProfileUri ?? null, req.params.id]
      );
      res.json({ success: true });
    } catch (err) {
      console.error("update result profile error:", err);
      res.status(500).json({ error: "서버 오류" });
    }
  });

  app.post("/api/admin-feedback", async (req: Request, res: Response) => {
    const { resultId, userName, feedbackText } = req.body;
    if (!feedbackText?.trim()) return res.status(400).json({ error: "피드백 내용이 없습니다." });
    try {
      await pool.query(
        "INSERT INTO admin_feedback (result_id, user_name, feedback_text) VALUES ($1, $2, $3)",
        [resultId ?? null, userName ?? null, feedbackText.trim()]
      );
      res.json({ success: true });
    } catch (err) {
      console.error("admin feedback error:", err);
      res.status(500).json({ error: "서버 오류" });
    }
  });

  app.get("/api/admin-feedback", async (_req: Request, res: Response) => {
    try {
      const result = await pool.query(
        "SELECT id, result_id, user_name, feedback_text, created_at FROM admin_feedback ORDER BY created_at DESC"
      );
      res.json(result.rows);
    } catch (err) {
      console.error("get admin feedback error:", err);
      res.status(500).json({ error: "서버 오류" });
    }
  });

  app.delete("/api/admin-feedback/:id", async (req: Request, res: Response) => {
    try {
      await pool.query("DELETE FROM admin_feedback WHERE id = $1", [req.params.id]);
      res.json({ success: true });
    } catch (err) {
      console.error("delete admin feedback error:", err);
      res.status(500).json({ error: "서버 오류" });
    }
  });

  app.get("/api/comments/:resultId", async (req: Request, res: Response) => {
    try {
      const { rows } = await pool.query(
        "SELECT * FROM weld_comments WHERE result_id = $1 ORDER BY created_at ASC",
        [req.params.resultId]
      );
      const topLevel = rows.filter((r: any) => !r.parent_id);
      const replies = rows.filter((r: any) => r.parent_id);
      const structured = topLevel.map((c: any) => ({
        id: c.id,
        resultId: c.result_id,
        parentId: null,
        userId: c.user_id,
        userName: c.user_name,
        userRole: c.user_role,
        content: c.content,
        createdAt: Number(c.created_at),
        replies: replies
          .filter((r: any) => r.parent_id === c.id)
          .map((r: any) => ({
            id: r.id,
            resultId: r.result_id,
            parentId: r.parent_id,
            userId: r.user_id,
            userName: r.user_name,
            userRole: r.user_role,
            content: r.content,
            createdAt: Number(r.created_at),
            replies: [],
          })),
      }));
      res.json(structured);
    } catch (err) {
      console.error("get comments error:", err);
      res.status(500).json({ error: "서버 오류" });
    }
  });

  app.get("/api/comments-count", async (req: Request, res: Response) => {
    try {
      const { rows } = await pool.query(
        "SELECT result_id, COUNT(*) as count FROM weld_comments GROUP BY result_id"
      );
      const map: Record<string, number> = {};
      rows.forEach((r: any) => { map[r.result_id] = Number(r.count); });
      res.json(map);
    } catch (err) {
      console.error("get comments count error:", err);
      res.status(500).json({ error: "서버 오류" });
    }
  });

  app.post("/api/comments", async (req: Request, res: Response) => {
    const { resultId, parentId, userId, userName, userRole, content } = req.body;
    if (!resultId || !userId || !content?.trim()) {
      return res.status(400).json({ error: "필수 항목이 없습니다." });
    }
    try {
      const { rows } = await pool.query(
        `INSERT INTO weld_comments (result_id, parent_id, user_id, user_name, user_role, content)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [resultId, parentId ?? null, userId, userName, userRole ?? "교육생", content.trim()]
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
        replies: [],
      });
    } catch (err) {
      console.error("post comment error:", err);
      res.status(500).json({ error: "서버 오류" });
    }
  });

  app.delete("/api/comments/:id", async (req: Request, res: Response) => {
    const { userId, isAdmin } = req.query;
    try {
      if (isAdmin === "true") {
        await pool.query("DELETE FROM weld_comments WHERE id = $1", [req.params.id]);
      } else {
        await pool.query("DELETE FROM weld_comments WHERE id = $1 AND user_id = $2", [req.params.id, userId]);
      }
      res.json({ success: true });
    } catch (err) {
      console.error("delete comment error:", err);
      res.status(500).json({ error: "서버 오류" });
    }
  });

}
