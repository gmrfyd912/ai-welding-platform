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

// ─────────────────────────────────────────────────────────────────────────────
// 현장 품질 관리 대시보드 스키마
//
// 테이블 관계:
//   field_users (1) ──< field_weld_records (1) ──< field_inspections (1) ──< field_defects
//
//   field_users        : 현장 사용자 (작업자 / 관리자)
//   field_weld_records : 용접 작업 환경 이력 (전류·전압·프로젝트)
//   field_inspections  : 비전 AI 검사 결과 1건 (비드 폭·직진도·합격 여부)
//   field_defects      : 검사 1건에서 탐지된 결함 상세 (다중)
// ─────────────────────────────────────────────────────────────────────────────

export async function ensureFieldTables(): Promise<void> {
  // ── 1. 현장 사용자 ────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS field_users (
      id         SERIAL  PRIMARY KEY,
      name       TEXT    NOT NULL,
      role       TEXT    NOT NULL
                   CHECK (role IN ('education', 'field_worker', 'field_manager')),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // ── 2. 용접 작업 환경 이력 (field_users 1:N) ─────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS field_weld_records (
      id           SERIAL  PRIMARY KEY,
      welder_id    INT     NOT NULL
                     REFERENCES field_users(id) ON DELETE CASCADE,
      project_name TEXT    NOT NULL DEFAULT '',
      current_amp  NUMERIC(7,2),   -- 전류 (A)
      voltage_volt NUMERIC(6,2),   -- 전압 (V)
      created_at   TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_field_records_welder
    ON field_weld_records (welder_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_field_records_created
    ON field_weld_records (created_at DESC)
  `);

  // ── 3. 비전 AI 검사 결과 (field_weld_records 1:N) ────────────────────────
  //    record 1건에 재검사 등을 허용하기 위해 1:N으로 모델링
  await pool.query(`
    CREATE TABLE IF NOT EXISTS field_inspections (
      id                 SERIAL  PRIMARY KEY,
      record_id          INT     NOT NULL
                           REFERENCES field_weld_records(id) ON DELETE CASCADE,
      original_image_url TEXT,
      ppm_scale          NUMERIC(10,4),  -- pixels per mm (ArUco 기반 환산 계수)
      avg_bead_width     NUMERIC(7,2),   -- 평균 비드 폭 (mm)
      straightness_error NUMERIC(7,2),   -- 직진도 오차 (mm)
      final_status       TEXT    NOT NULL
                           CHECK (final_status IN ('PASS', 'FAIL')),
      created_at         TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_field_inspections_record
    ON field_inspections (record_id)
  `);
  await pool.query(`
    -- 대시보드 쿼리: 기간별 합격/불합격 집계
    CREATE INDEX IF NOT EXISTS idx_field_inspections_status_created
    ON field_inspections (final_status, created_at DESC)
  `);

  // ── 4. 결함 상세 (field_inspections 1:N) ─────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS field_defects (
      id            SERIAL  PRIMARY KEY,
      inspection_id INT     NOT NULL
                      REFERENCES field_inspections(id) ON DELETE CASCADE,
      defect_type   TEXT    NOT NULL,    -- 언더컷, 기공, 스패터, 크랙 등
      confidence    NUMERIC(5,2),        -- 신뢰도 0.00~100.00 (%)
      size_mm       NUMERIC(7,2),        -- 결함 크기 추정 (mm)
      created_at    TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_field_defects_inspection
    ON field_defects (inspection_id)
  `);
  await pool.query(`
    -- 결함 유형별 집계용
    CREATE INDEX IF NOT EXISTS idx_field_defects_type
    ON field_defects (defect_type)
  `);
}
