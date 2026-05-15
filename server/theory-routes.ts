import type { Express, Request, Response } from "express";
import pool from "./db";
import { THEORY_QUESTIONS, type TheoryQuestion } from "../shared/theory-questions";

async function ensureTheoryTable() {
  await pool.query(`
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
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_theory_attempts_user_day ON weld_theory_attempts(user_id, day_key)`
  );
}
ensureTheoryTable().catch(console.error);

function getDayKey(date = new Date()): string {
  // Korean local day (Asia/Seoul) — gives consistent rollover for KR users
  // even when the server is in UTC.
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return fmt.format(date); // "YYYY-MM-DD"
  } catch {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
}

// Deterministic hash for stable daily picks per user+day
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function pickDailyForUser(userId: string, dayKey: string, attemptedIds: Set<string>): TheoryQuestion[] {
  const easy = THEORY_QUESTIONS.filter((q) => q.difficulty === "easy");
  const medium = THEORY_QUESTIONS.filter((q) => q.difficulty === "medium");
  const hard = THEORY_QUESTIONS.filter((q) => q.difficulty === "hard");

  const pickFrom = (pool: TheoryQuestion[], salt: string): TheoryQuestion => {
    const unattempted = pool.filter((q) => !attemptedIds.has(q.id));
    const source = unattempted.length > 0 ? unattempted : pool;
    const seed = hashStr(`${userId}|${dayKey}|${salt}`);
    return source[seed % source.length];
  };

  return [pickFrom(easy, "easy"), pickFrom(medium, "medium"), pickFrom(hard, "hard")];
}

export function registerTheoryRoutes(app: Express): void {
  // GET /api/theory/daily/:userId — returns 3 questions for today
  app.get("/api/theory/daily/:userId", async (req: Request, res: Response) => {
    const userId = String(req.params.userId || "");
    if (!userId) return res.status(400).json({ error: "userId required" });
    const dayKey = getDayKey();
    try {
      // Determine which questions the user has attempted in the past (any day)
      const { rows: allRows } = await pool.query(
        "SELECT question_id, day_key, selected_index FROM weld_theory_attempts WHERE user_id = $1",
        [userId]
      );
      const attemptedAllIds = new Set<string>(allRows.map((r: any) => r.question_id));

      // Today's existing attempts — these must be included in today's set so the
      // user can resume an in-progress session after relogin.
      const todayRows = allRows.filter((r: any) => r.day_key === dayKey);
      const todayMap = new Map<string, number>();
      todayRows.forEach((r: any) => todayMap.set(r.question_id, r.selected_index));

      // Exclude previously attempted (other days) when freshly picking.
      const previousIds = new Set<string>();
      for (const id of attemptedAllIds) {
        if (!todayMap.has(id)) previousIds.add(id);
      }
      // Deterministic per-user-per-day picks for 하/중/상.
      const picked = pickDailyForUser(userId, dayKey, previousIds);

      // Ensure today's already-attempted questions are part of the set per-difficulty.
      const finalByDiff: Record<string, TheoryQuestion> = {};
      for (const q of picked) finalByDiff[q.difficulty] = q;
      for (const aRow of todayRows) {
        const q = THEORY_QUESTIONS.find((x) => x.id === aRow.question_id);
        if (q) finalByDiff[q.difficulty] = q;
      }
      const ordered: TheoryQuestion[] = [];
      for (const diff of ["easy", "medium", "hard"] as const) {
        if (finalByDiff[diff]) ordered.push(finalByDiff[diff]);
      }

      res.json({
        dayKey,
        questions: ordered.map((q) => ({
          id: q.id,
          difficulty: q.difficulty,
          category: q.category,
          question: q.question,
          options: q.options,
        })),
        // Pre-existing selections so the UI can resume mid-session.
        selections: Object.fromEntries(todayMap),
      });
    } catch (err) {
      console.error("theory daily error:", err);
      res.status(500).json({ error: "서버 오류" });
    }
  });

  // POST /api/theory/attempts — record one attempt
  app.post("/api/theory/attempts", async (req: Request, res: Response) => {
    const { userId, questionId, selectedIndex, dayKey } = req.body;
    if (!userId || !questionId || selectedIndex === undefined) {
      return res.status(400).json({ error: "필수 항목이 없습니다." });
    }
    const qid = String(questionId);
    const q = THEORY_QUESTIONS.find((x) => x.id === qid);
    if (!q) return res.status(404).json({ error: "문제를 찾을 수 없습니다." });
    const isCorrect = q.correctIndex === selectedIndex;
    const dk = dayKey || getDayKey();
    try {
      await pool.query(
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
      res.status(500).json({ error: "서버 오류" });
    }
  });

  // GET /api/theory/results/:userId/:dayKey — full results for review
  app.get("/api/theory/results/:userId/:dayKey", async (req: Request, res: Response) => {
    const userId = String(req.params.userId || "");
    const dayKey = String(req.params.dayKey || "");
    try {
      const { rows } = await pool.query(
        "SELECT * FROM weld_theory_attempts WHERE user_id = $1 AND day_key = $2",
        [userId, dayKey]
      );
      const attempts = rows.map((r: any) => ({
        questionId: r.question_id,
        selectedIndex: r.selected_index,
        correctIndex: r.correct_index,
        isCorrect: r.is_correct,
        attemptedAt: Number(r.attempted_at),
      }));
      // Attach question content for the UI
      const enriched = attempts
        .map((a: any) => {
          const q = THEORY_QUESTIONS.find((x) => x.id === a.questionId);
          return q ? { ...a, question: q } : null;
        })
        .filter((x: any) => x !== null);
      // Sort by difficulty 하/중/상
      const order: Record<string, number> = { easy: 0, medium: 1, hard: 2 };
      enriched.sort((a: any, b: any) => order[a.question.difficulty] - order[b.question.difficulty]);

      const score = enriched.filter((e: any) => e.isCorrect).length;
      res.json({ dayKey, score, total: enriched.length, attempts: enriched });
    } catch (err) {
      console.error("theory results error:", err);
      res.status(500).json({ error: "서버 오류" });
    }
  });

  // GET /api/theory/history/:userId — full history for PDF + tracking
  app.get("/api/theory/history/:userId", async (req: Request, res: Response) => {
    const userId = String(req.params.userId || "");
    try {
      const { rows } = await pool.query(
        "SELECT * FROM weld_theory_attempts WHERE user_id = $1 ORDER BY attempted_at DESC",
        [userId]
      );
      const attempts = rows.map((r: any) => {
        const q = THEORY_QUESTIONS.find((x) => x.id === r.question_id);
        return {
          questionId: r.question_id,
          dayKey: r.day_key,
          difficulty: r.difficulty,
          selectedIndex: r.selected_index,
          correctIndex: r.correct_index,
          isCorrect: r.is_correct,
          attemptedAt: Number(r.attempted_at),
          question: q || null,
        };
      });

      // Group by dayKey
      const byDay: Record<string, any[]> = {};
      for (const a of attempts) {
        if (!byDay[a.dayKey]) byDay[a.dayKey] = [];
        byDay[a.dayKey].push(a);
      }
      // Stats
      const totalAttempted = attempts.length;
      const totalCorrect = attempts.filter((a: any) => a.isCorrect).length;
      res.json({ totalAttempted, totalCorrect, byDay });
    } catch (err) {
      console.error("theory history error:", err);
      res.status(500).json({ error: "서버 오류" });
    }
  });

  // GET /api/theory/today-status/:userId — has the user finished today's quiz?
  app.get("/api/theory/today-status/:userId", async (req: Request, res: Response) => {
    const userId = String(req.params.userId || "");
    const dayKey = getDayKey();
    try {
      const { rows } = await pool.query(
        "SELECT COUNT(*)::int AS c FROM weld_theory_attempts WHERE user_id = $1 AND day_key = $2",
        [userId, dayKey]
      );
      const attempted = rows[0]?.c || 0;
      res.json({ dayKey, attempted, completed: attempted >= 3 });
    } catch (err) {
      console.error("theory status error:", err);
      res.status(500).json({ error: "서버 오류" });
    }
  });
}
