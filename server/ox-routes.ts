import type { Express, Request, Response } from "express";
import pool from "./db";

async function ensureOxTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS weld_ox_state (
      user_id TEXT PRIMARY KEY,
      snapshot JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS weld_ox_scores (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      final_wave INT NOT NULL,
      quiz_correct INT NOT NULL DEFAULT 0,
      quiz_total INT NOT NULL DEFAULT 0,
      accuracy INT NOT NULL DEFAULT 0,
      played_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_weld_ox_scores_rank
     ON weld_ox_scores (final_wave DESC, accuracy DESC, played_at ASC);`
  );
}
ensureOxTables().catch(console.error);

export function registerOxRoutes(app: Express): void {
  // ── 진행 상태 (이어하기) ─────────────────────────────────────────────
  app.get("/api/ox/state/:userId", async (req: Request, res: Response) => {
    const userId = String(req.params.userId || "");
    if (!userId) return res.status(400).json({ error: "userId required" });
    try {
      const { rows } = await pool.query(
        "SELECT snapshot, updated_at FROM weld_ox_state WHERE user_id = $1",
        [userId]
      );
      if (rows.length === 0) return res.json({ snapshot: null });
      res.json({ snapshot: rows[0].snapshot, updatedAt: rows[0].updated_at });
    } catch (err) {
      console.error("ox state get:", err);
      res.status(500).json({ error: "서버 오류" });
    }
  });

  app.post("/api/ox/state", async (req: Request, res: Response) => {
    const { userId, snapshot } = req.body ?? {};
    if (!userId || !snapshot) return res.status(400).json({ error: "잘못된 요청" });
    try {
      await pool.query(
        `INSERT INTO weld_ox_state (user_id, snapshot, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (user_id) DO UPDATE SET snapshot = EXCLUDED.snapshot, updated_at = NOW()`,
        [String(userId), snapshot]
      );
      res.json({ success: true });
    } catch (err) {
      console.error("ox state save:", err);
      res.status(500).json({ error: "저장 실패" });
    }
  });

  app.delete("/api/ox/state/:userId", async (req: Request, res: Response) => {
    const userId = String(req.params.userId || "");
    if (!userId) return res.status(400).json({ error: "userId required" });
    try {
      await pool.query("DELETE FROM weld_ox_state WHERE user_id = $1", [userId]);
      res.json({ success: true });
    } catch (err) {
      console.error("ox state delete:", err);
      res.status(500).json({ error: "삭제 실패" });
    }
  });

  // ── 점수 / 랭킹 ─────────────────────────────────────────────────────
  app.post("/api/ox/scores", async (req: Request, res: Response) => {
    const { userId, userName, finalWave, quizCorrect, quizTotal } = req.body ?? {};
    if (!userId || !userName || typeof finalWave !== "number") {
      return res.status(400).json({ error: "잘못된 요청" });
    }
    const correct = Math.max(0, Number(quizCorrect) || 0);
    const total = Math.max(0, Number(quizTotal) || 0);
    const accuracy = total > 0 ? Math.round((correct / total) * 100) : 0;
    try {
      const { rows } = await pool.query(
        `INSERT INTO weld_ox_scores (user_id, user_name, final_wave, quiz_correct, quiz_total, accuracy)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [String(userId), String(userName), Math.max(0, Math.floor(finalWave)), correct, total, accuracy]
      );
      // 게임 종료 후엔 진행 상태도 비움
      await pool.query("DELETE FROM weld_ox_state WHERE user_id = $1", [String(userId)]).catch(() => {});
      res.json({ success: true, id: rows[0].id, accuracy });
    } catch (err) {
      console.error("ox score save:", err);
      res.status(500).json({ error: "저장 실패" });
    }
  });

  // 모든 게임 기록 중 Top 10 (한 사람이 여러 랭크를 차지할 수 있음)
  app.get("/api/ox/leaderboard", async (_req: Request, res: Response) => {
    try {
      const { rows } = await pool.query(`
        SELECT user_id, user_name, final_wave, quiz_correct, quiz_total, accuracy, played_at
        FROM weld_ox_scores
        ORDER BY final_wave DESC, accuracy DESC, played_at ASC
        LIMIT 10
      `);
      const top = rows
        .map((r: any, i: number) => ({
          rank: i + 1,
          userId: r.user_id,
          userName: r.user_name,
          finalWave: r.final_wave,
          quizCorrect: r.quiz_correct,
          quizTotal: r.quiz_total,
          accuracy: r.accuracy,
          playedAt: r.played_at,
        }));
      res.json({ leaderboard: top });
    } catch (err) {
      console.error("ox leaderboard:", err);
      res.status(500).json({ error: "조회 실패" });
    }
  });
}
