import pool from "./db";

/**
 * weld_ox_bank           — AI 생성 OX 문제 은행 (카테고리/난이도별 누적)
 * weld_ox_category_lock  — 카테고리/난이도별 AI 생성 잠금 상태 관리
 */
export async function ensureOxBankTables(): Promise<void> {
  // 문제 은행: AI가 생성하거나 관리자가 등록한 OX 문제를 축적
  await pool.query(`
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
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ox_bank_cat_diff
    ON weld_ox_bank (ncs_category, difficulty)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ox_bank_question_dedup
    ON weld_ox_bank (ncs_category, difficulty, LEFT(question, 80))
  `);

  // 잠금 상태: 포화된 카테고리/난이도 조합의 AI 생성을 영구 차단
  await pool.query(`
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
