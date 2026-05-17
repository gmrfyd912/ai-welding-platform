import type { Express, Request, Response } from "express";
import pool from "./db";

async function ensureExamTable() {
  await pool.query(`
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

function rowToExam(r: any) {
  return {
    id: r.id,
    userId: r.user_id,
    userName: r.user_name,
    courseName: r.course_name ?? undefined,
    examDate: r.exam_date,
    weldType: r.weld_type,
    material: r.material,
    posture: r.posture,
    result: r.result,
    issuer: r.issuer ?? undefined,
    certNumber: r.cert_number ?? undefined,
    memo: r.memo ?? undefined,
    createdAt: r.created_at,
  };
}

export function registerExamRoutes(app: Express): void {

  // 전체 조회 (교사/관리자) or 본인 조회 (교육생)
  app.get("/api/exam-records", async (req: Request, res: Response) => {
    const { userId } = req.query;
    try {
      let result;
      if (userId) {
        result = await pool.query(
          `SELECT * FROM exam_records WHERE user_id = $1 ORDER BY exam_date DESC, created_at DESC`,
          [userId]
        );
      } else {
        result = await pool.query(
          `SELECT * FROM exam_records ORDER BY exam_date DESC, created_at DESC`
        );
      }
      res.json(result.rows.map(rowToExam));
    } catch (err) {
      console.error("exam-records get error:", err);
      res.status(500).json({ error: "서버 오류" });
    }
  });

  // 등록
  app.post("/api/exam-records", async (req: Request, res: Response) => {
    const { userId, userName, courseName, examDate, weldType, material, posture, result, issuer, certNumber, memo } = req.body;
    const missing: string[] = [];
    if (!userId) missing.push("userId");
    if (!examDate) missing.push("examDate");
    if (!weldType) missing.push("weldType");
    if (missing.length > 0) {
      return res.status(400).json({ error: `누락된 필드: ${missing.join(", ")}` });
    }
    try {
      await ensureExamTable();
      const id = Date.now().toString() + Math.random().toString(36).substr(2, 6);
      await pool.query(
        `INSERT INTO exam_records
         (id, user_id, user_name, course_name, exam_date, weld_type, material, posture, result, issuer, cert_number, memo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id, userId, userName, courseName || null, examDate, weldType, material, posture, result, issuer || null, certNumber || null, memo || null]
      );
      const row = await pool.query(`SELECT * FROM exam_records WHERE id = $1`, [id]);
      res.json(rowToExam(row.rows[0]));
    } catch (err) {
      console.error("exam-records post error:", err);
      res.status(500).json({ error: "서버 오류" });
    }
  });

  // 삭제
  app.delete("/api/exam-records/:id", async (req: Request, res: Response) => {
    try {
      await pool.query(`DELETE FROM exam_records WHERE id = $1`, [req.params.id]);
      res.json({ success: true });
    } catch (err) {
      console.error("exam-records delete error:", err);
      res.status(500).json({ error: "서버 오류" });
    }
  });
}
