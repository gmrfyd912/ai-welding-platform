import type { Express, Request, Response } from "express";
import pool from "./db";
import { ensureOxBankTables } from "./schema";

// ── 초기화: 기존 OX 게임 테이블 + 문제은행/잠금 테이블 ──────────
async function ensureOxTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS weld_ox_state (
      user_id TEXT PRIMARY KEY,
      snapshot JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    )
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
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_weld_ox_scores_rank
    ON weld_ox_scores (final_wave DESC, accuracy DESC, played_at ASC)
  `);
  await ensureOxBankTables();
}
ensureOxTables().catch(console.error);

// ══════════════════════════════════════════════════════════════════
// 유사도 계산 (외부 패키지 없음 — 순수 TypeScript)
// ══════════════════════════════════════════════════════════════════

/**
 * Levenshtein 편집 거리 (O(m×n) 공간 최적화 버전)
 * 두 문자열 간의 최소 편집 횟수를 반환.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  const curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    [prev] = [[...curr]];
  }
  return curr[n];
}

/** 정규화된 편집 유사도 (0=완전히 다름, 1=동일) */
function editSimilarity(a: string, b: string): number {
  const na = a.toLowerCase().replace(/\s+/g, " ").trim();
  const nb = b.toLowerCase().replace(/\s+/g, " ").trim();
  const dist = levenshtein(na, nb);
  return 1 - dist / Math.max(na.length, nb.length, 1);
}

/** Jaccard 단어 집합 유사도 (짧은 단어 제외) */
function jaccardSimilarity(a: string, b: string): number {
  const words = (s: string) =>
    new Set(s.toLowerCase().split(/[\s,.?!()]+/).filter((w) => w.length > 1));
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 && wb.size === 0) return 1;
  let inter = 0;
  wa.forEach((w) => { if (wb.has(w)) inter++; });
  return inter / Math.max(wa.size + wb.size - inter, 1);
}

/**
 * 신규 문제가 기존 문제 목록과 너무 유사한지 판단.
 * 편집 유사도 ≥ 0.75 또는 Jaccard ≥ 0.65 이면 중복 판정.
 */
function isTooSimilar(
  newQ: string,
  existingList: string[],
  editThresh = 0.75,
  jaccardThresh = 0.65,
): boolean {
  for (const q of existingList) {
    if (editSimilarity(newQ, q) >= editThresh) return true;
    if (jaccardSimilarity(newQ, q) >= jaccardThresh) return true;
  }
  return false;
}

// ══════════════════════════════════════════════════════════════════
// DB 헬퍼 함수
// ══════════════════════════════════════════════════════════════════

/** 해당 카테고리/난이도가 잠금 상태인지 확인 */
async function isLocked(category: string, difficulty: string): Promise<boolean> {
  try {
    const { rows } = await pool.query(
      "SELECT is_locked FROM weld_ox_category_lock WHERE ncs_category=$1 AND difficulty=$2",
      [category, difficulty],
    );
    return rows[0]?.is_locked ?? false;
  } catch {
    return false;
  }
}

/** 카테고리/난이도를 잠금 — 이후 AI 호출 없이 DB만 사용 */
async function setLock(
  category: string,
  difficulty: string,
  reason: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO weld_ox_category_lock
       (ncs_category, difficulty, is_locked, locked_at, lock_reason, updated_at)
     VALUES ($1, $2, TRUE, NOW(), $3, NOW())
     ON CONFLICT (ncs_category, difficulty) DO UPDATE
       SET is_locked=TRUE, locked_at=NOW(), lock_reason=EXCLUDED.lock_reason, updated_at=NOW()`,
    [category, difficulty, reason],
  );
  console.log(
    `[OX-Lock] 🔒 잠금 설정 | category="${category}" difficulty="${difficulty}" | 사유: ${reason}`,
  );
}

/** 잠금 해제 (관리자/테스트용) */
async function releaseLock(category: string, difficulty: string): Promise<void> {
  await pool.query(
    `INSERT INTO weld_ox_category_lock
       (ncs_category, difficulty, is_locked, updated_at)
     VALUES ($1, $2, FALSE, NOW())
     ON CONFLICT (ncs_category, difficulty) DO UPDATE
       SET is_locked=FALSE, locked_at=NULL, lock_reason=NULL, updated_at=NOW()`,
    [category, difficulty],
  );
  console.log(`[OX-Lock] 🔓 잠금 해제 | category="${category}" difficulty="${difficulty}"`);
}

/** 문제 은행에서 무작위 문제 1개 반환 */
async function getRandomFromBank(
  category: string,
  difficulty: string,
): Promise<Record<string, unknown> | null> {
  const { rows } = await pool.query(
    `SELECT id, ncs_category, difficulty, question, answer, explanation, source, created_at
     FROM weld_ox_bank
     WHERE ncs_category=$1 AND difficulty=$2
     ORDER BY RANDOM() LIMIT 1`,
    [category, difficulty],
  );
  return rows[0] ?? null;
}

/** 중복 방지용 기존 문제 텍스트 목록 (최신 N개) */
async function getExistingQuestions(
  category: string,
  difficulty: string,
  limit = 20,
): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT question FROM weld_ox_bank
     WHERE ncs_category=$1 AND difficulty=$2
     ORDER BY created_at DESC LIMIT $3`,
    [category, difficulty, limit],
  );
  return rows.map((r: Record<string, unknown>) => r.question as string);
}

/** 신규 문제를 은행에 저장 + 카운터 증가 */
async function saveToBank(
  category: string,
  difficulty: string,
  question: string,
  answer: boolean,
  explanation: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO weld_ox_bank (ncs_category, difficulty, question, answer, explanation)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (ncs_category, difficulty, LEFT(question, 80)) DO NOTHING`,
    [category, difficulty, question, answer, explanation],
  );
  await pool.query(
    `INSERT INTO weld_ox_category_lock (ncs_category, difficulty, question_count, updated_at)
     VALUES ($1, $2, 1, NOW())
     ON CONFLICT (ncs_category, difficulty) DO UPDATE
       SET question_count = weld_ox_category_lock.question_count + 1, updated_at=NOW()`,
    [category, difficulty],
  );
}

// ══════════════════════════════════════════════════════════════════
// OpenAI 호출 (fetch 기반 — SDK 버전 무관)
// ══════════════════════════════════════════════════════════════════

interface OxAiResult {
  question: string;
  answer: boolean;
  explanation: string;
  is_exhausted?: boolean;
}

async function callOpenAiForOx(
  category: string,
  difficulty: string,
  existingQuestions: string[],
): Promise<OxAiResult | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("[OX-Generate] OPENAI_API_KEY 없음");
    return null;
  }

  const diffLabel: Record<string, string> = {
    easy: "쉬움(초급 — 용접 기초 개념)",
    medium: "보통(중급 — 실무 적용)",
    hard: "어려움(고급 — NCS 심화/계산)",
  };

  const existingBlock =
    existingQuestions.length > 0
      ? `\n\n[이미 문제은행에 존재하는 문제 — 반드시 피할 것]\n` +
        existingQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")
      : "";

  const systemPrompt =
    `당신은 용접 NCS(국가직무능력표준) 전문 출제자입니다. ` +
    `OX 퀴즈(맞으면 true, 틀리면 false) 문제를 생성합니다.\n` +
    `카테고리: ${category}\n난이도: ${diffLabel[difficulty] ?? difficulty}` +
    existingBlock +
    `\n\n[생성 지침]\n` +
    `- 위 기존 문제들과 개념·문장 구조·묻는 방식이 완전히 달라야 합니다.\n` +
    `- 실무적이고 구체적이며 교육적 가치가 있는 새로운 문제를 생성하세요.\n` +
    `- 주어진 카테고리에서 더 이상 완전히 새롭고 실무적인 문제를 도출할 수 없다면 ` +
    `is_exhausted: true를 반환하세요.\n\n` +
    `다음 JSON 형식으로만 응답하세요:\n` +
    `{"question":"문제 텍스트","answer":true,"explanation":"해설 1~2문장","is_exhausted":false}`;

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: systemPrompt }],
        temperature: 0.92,
        max_tokens: 350,
        response_format: { type: "json_object" },
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error(`[OX-Generate] OpenAI ${resp.status}: ${errText.slice(0, 200)}`);
      return null;
    }
    const data = (await resp.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const raw = data.choices?.[0]?.message?.content ?? "{}";
    return JSON.parse(raw) as OxAiResult;
  } catch (err: unknown) {
    console.error("[OX-Generate] OpenAI 파싱 오류:", (err as Error).message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════
// Express 라우트 등록
// ══════════════════════════════════════════════════════════════════

export function registerOxRoutes(app: Express): void {

  // ── 진행 상태 (이어하기) ──────────────────────────────────────
  app.get("/api/ox/state/:userId", async (req: Request, res: Response) => {
    const userId = String(req.params.userId || "");
    if (!userId) return res.status(400).json({ error: "userId required" });
    try {
      const { rows } = await pool.query(
        "SELECT snapshot, updated_at FROM weld_ox_state WHERE user_id = $1",
        [userId],
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
        [String(userId), snapshot],
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

  // ── 점수 / 랭킹 ───────────────────────────────────────────────
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
        [String(userId), String(userName), Math.max(0, Math.floor(finalWave)), correct, total, accuracy],
      );
      await pool.query("DELETE FROM weld_ox_state WHERE user_id = $1", [String(userId)]).catch(() => {});
      res.json({ success: true, id: rows[0].id, accuracy });
    } catch (err) {
      console.error("ox score save:", err);
      res.status(500).json({ error: "저장 실패" });
    }
  });

  app.get("/api/ox/leaderboard", async (_req: Request, res: Response) => {
    try {
      const { rows } = await pool.query(`
        SELECT user_id, user_name, final_wave, quiz_correct, quiz_total, accuracy, played_at
        FROM weld_ox_scores
        ORDER BY final_wave DESC, accuracy DESC, played_at ASC
        LIMIT 10
      `);
      const top = rows.map((r: Record<string, unknown>, i: number) => ({
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

  // ══════════════════════════════════════════════════════════════
  // 🆕 AI 문제 생성 (Auto-Lock 시스템)
  // POST /api/ox/generate
  // Body: { category: string, difficulty: "easy"|"medium"|"hard" }
  // ══════════════════════════════════════════════════════════════
  app.post("/api/ox/generate", async (req: Request, res: Response) => {
    const category  = String(req.body?.category  || "일반용접").trim();
    const difficulty = String(req.body?.difficulty || "medium").trim();

    if (!["easy", "medium", "hard"].includes(difficulty)) {
      return res.status(400).json({ error: "difficulty는 easy|medium|hard 중 하나" });
    }

    // ── [1단계] 잠금 확인 (최우선) ─────────────────────────────
    const locked = await isLocked(category, difficulty);
    if (locked) {
      console.log(
        `[OX-Lock] 🔒 잠금 상태 → DB 무작위 반환 | category="${category}" difficulty="${difficulty}"`,
      );
      const dbQ = await getRandomFromBank(category, difficulty);
      if (dbQ) {
        return res.json({ ...dbQ, source: "db", fromLock: true });
      }
      return res.status(404).json({
        error: "LOCKED_NO_DATA",
        message: "잠금 상태이지만 DB에 문제가 없습니다. 관리자에게 문의하세요.",
      });
    }

    // ── [2단계] 기존 문제 목록 조회 (중복 방지 프롬프트 주입용) ─
    const existing = await getExistingQuestions(category, difficulty, 20);
    console.log(
      `[OX-Generate] AI 호출 시작 | category="${category}" difficulty="${difficulty}" | 기존 문제 수=${existing.length}`,
    );

    // ── [3단계] OpenAI 호출 ────────────────────────────────────
    const aiResult = await callOpenAiForOx(category, difficulty, existing);

    if (!aiResult) {
      // AI 오류 → DB 폴백 (잠금 설정 안 함)
      console.warn("[OX-Generate] AI 오류 → DB 폴백");
      const dbQ = await getRandomFromBank(category, difficulty);
      if (dbQ) return res.json({ ...dbQ, source: "db", fromLock: false, aiError: true });
      return res.status(503).json({ error: "AI 오류 및 DB 문제 없음" });
    }

    // ── [4단계] is_exhausted 확인 ─────────────────────────────
    if (aiResult.is_exhausted) {
      await setLock(category, difficulty, "AI가 is_exhausted 반환 — 주제 소진");
      console.log(`[OX-Lock] 주제 소진으로 잠금 | category="${category}" difficulty="${difficulty}"`);
      const dbQ = await getRandomFromBank(category, difficulty);
      if (dbQ) {
        return res.json({ ...dbQ, source: "db", fromLock: true, lockedNow: true });
      }
      return res.json({
        locked: true,
        lockedNow: true,
        message: "해당 카테고리/난이도의 문제가 소진되었습니다.",
      });
    }

    const { question, answer, explanation } = aiResult;

    // ── [5단계] 유사도 중복 검사 ──────────────────────────────
    if (isTooSimilar(question, existing)) {
      await setLock(
        category,
        difficulty,
        `신규 문제가 기존 문제와 유사도 기준 초과 (edit≥0.75 또는 jaccard≥0.65)`,
      );
      console.log(`[OX-Lock] 유사도 초과로 잠금 | category="${category}" difficulty="${difficulty}"`);
      const dbQ = await getRandomFromBank(category, difficulty);
      if (dbQ) {
        return res.json({ ...dbQ, source: "db", fromLock: true, lockedNow: true });
      }
      return res.json({
        locked: true,
        lockedNow: true,
        message: "신규 문제가 기존 문제와 너무 유사합니다. 잠금 설정됨.",
      });
    }

    // ── [6단계] 유효 문제 → DB 저장 후 반환 ──────────────────
    await saveToBank(category, difficulty, question, answer, explanation);
    console.log(
      `[OX-Generate] ✅ 신규 문제 저장 | category="${category}" difficulty="${difficulty}" | 문제: "${question.slice(0, 40)}..."`,
    );

    return res.json({
      ncs_category: category,
      difficulty,
      question,
      answer,
      explanation,
      source: "ai",
      fromLock: false,
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 🆕 잠금 상태 조회 (관리자/테스트용)
  // GET /api/ox/lock-status?category=xxx&difficulty=yyy
  // GET /api/ox/lock-status  (전체 목록)
  // ══════════════════════════════════════════════════════════════
  app.get("/api/ox/lock-status", async (req: Request, res: Response) => {
    const { category, difficulty } = req.query;
    try {
      if (category && difficulty) {
        const { rows } = await pool.query(
          `SELECT * FROM weld_ox_category_lock
           WHERE ncs_category=$1 AND difficulty=$2`,
          [String(category), String(difficulty)],
        );
        const cnt = await pool.query(
          "SELECT COUNT(*)::int AS c FROM weld_ox_bank WHERE ncs_category=$1 AND difficulty=$2",
          [String(category), String(difficulty)],
        );
        return res.json({
          status: rows[0] ?? { ncs_category: category, difficulty, is_locked: false, question_count: 0 },
          bankCount: cnt.rows[0]?.c ?? 0,
        });
      }
      const { rows } = await pool.query(
        "SELECT * FROM weld_ox_category_lock ORDER BY ncs_category, difficulty",
      );
      const bankCounts = await pool.query(
        "SELECT ncs_category, difficulty, COUNT(*)::int AS c FROM weld_ox_bank GROUP BY ncs_category, difficulty",
      );
      const countMap: Record<string, number> = {};
      for (const r of bankCounts.rows as Array<Record<string, unknown>>) {
        countMap[`${r.ncs_category}__${r.difficulty}`] = r.c as number;
      }
      return res.json({
        locks: rows.map((r: Record<string, unknown>) => ({
          ...r,
          bankCount: countMap[`${r.ncs_category}__${r.difficulty}`] ?? 0,
        })),
      });
    } catch (err) {
      console.error("lock-status:", err);
      res.status(500).json({ error: "조회 실패" });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // 🆕 잠금 해제 (관리자/테스트용)
  // DELETE /api/ox/lock/:category/:difficulty
  // ══════════════════════════════════════════════════════════════
  app.delete(
    "/api/ox/lock/:category/:difficulty",
    async (req: Request, res: Response) => {
      const { category, difficulty } = req.params;
      try {
        await releaseLock(category, difficulty);
        res.json({ success: true, message: `"${category}/${difficulty}" 잠금 해제` });
      } catch (err) {
        console.error("lock release:", err);
        res.status(500).json({ error: "해제 실패" });
      }
    },
  );

  // ══════════════════════════════════════════════════════════════
  // 🆕 문제 은행 조회 (관리자/테스트용)
  // GET /api/ox/bank?category=xxx&difficulty=yyy&limit=20
  // ══════════════════════════════════════════════════════════════
  app.get("/api/ox/bank", async (req: Request, res: Response) => {
    const { category, difficulty, limit = "20" } = req.query;
    try {
      let query = `SELECT id, ncs_category, difficulty, question, answer, source, created_at
                   FROM weld_ox_bank`;
      const params: unknown[] = [];
      const wheres: string[] = [];
      if (category)   { params.push(String(category));   wheres.push(`ncs_category=$${params.length}`); }
      if (difficulty) { params.push(String(difficulty));  wheres.push(`difficulty=$${params.length}`); }
      if (wheres.length > 0) query += ` WHERE ${wheres.join(" AND ")}`;
      params.push(Math.min(Number(limit) || 20, 100));
      query += ` ORDER BY created_at DESC LIMIT $${params.length}`;
      const { rows } = await pool.query(query, params);
      res.json({ count: rows.length, questions: rows });
    } catch (err) {
      console.error("bank query:", err);
      res.status(500).json({ error: "조회 실패" });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // 🆕 테스트용: 강제 잠금 트리거 (테스트 전용 엔드포인트)
  // POST /api/ox/test-force-lock
  // Body: { category, difficulty, reason }
  // ══════════════════════════════════════════════════════════════
  app.post("/api/ox/test-force-lock", async (req: Request, res: Response) => {
    const { category, difficulty, reason = "테스트 강제 잠금" } = req.body ?? {};
    if (!category || !difficulty) {
      return res.status(400).json({ error: "category, difficulty 필요" });
    }
    try {
      await setLock(String(category), String(difficulty), String(reason));
      res.json({ success: true, locked: true, category, difficulty, reason });
    } catch (err) {
      console.error("force-lock:", err);
      res.status(500).json({ error: "강제 잠금 실패" });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // 🆕 테스트용: 문제 은행에 시드 데이터 삽입
  // POST /api/ox/test-seed
  // Body: { category, difficulty, questions: [{question, answer, explanation}] }
  // ══════════════════════════════════════════════════════════════
  app.post("/api/ox/test-seed", async (req: Request, res: Response) => {
    const { category, difficulty, questions } = req.body ?? {};
    if (!category || !difficulty || !Array.isArray(questions)) {
      return res.status(400).json({ error: "category, difficulty, questions[] 필요" });
    }
    try {
      let saved = 0;
      for (const q of questions as Array<{ question: string; answer: boolean; explanation: string }>) {
        await saveToBank(
          String(category), String(difficulty),
          String(q.question), Boolean(q.answer), String(q.explanation ?? ""),
        );
        saved++;
      }
      res.json({ success: true, saved, category, difficulty });
    } catch (err) {
      console.error("test-seed:", err);
      res.status(500).json({ error: "시드 삽입 실패" });
    }
  });
}
