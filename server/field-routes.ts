import type { Express, Request, Response } from "express";
import pool from "./db";
import { ensureFieldTables } from "./schema";

// 서버 기동 시 테이블 자동 생성
ensureFieldTables().catch(console.error);

// ─── 더미 데이터 상수 ────────────────────────────────────────────────────────
const DUMMY_WELDERS = [
  { name: "김철수", role: "field_worker" },
  { name: "이영희", role: "field_worker" },
  { name: "박민준", role: "field_worker" },
  { name: "최현우", role: "field_worker" },
  { name: "정수진", role: "field_manager" },
];

const DUMMY_PROJECTS = ["교량 보수공사", "플랜트 배관", "조선소 선체", "건축 철골", "해양 구조물"];

const DUMMY_DEFECT_TYPES = ["언더컷", "기공", "스패터", "크랙", "오버랩", "용착불량", "아크스트라이크"];

function rand(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function randInt(min: number, max: number): number {
  return Math.floor(rand(min, max + 1));
}

function randPick<T>(arr: T[]): T {
  return arr[randInt(0, arr.length - 1)];
}

// ─── 라우트 등록 ─────────────────────────────────────────────────────────────
export function registerFieldRoutes(app: Express): void {

  // ── 사용자 ────────────────────────────────────────────────────────────────

  // 사용자 목록 조회
  app.get("/api/field/users", async (_req: Request, res: Response) => {
    try {
      const { rows } = await pool.query(
        `SELECT * FROM field_users ORDER BY created_at DESC`
      );
      res.json(rows);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // 사용자 생성
  app.post("/api/field/users", async (req: Request, res: Response) => {
    const { name, role } = req.body as { name: string; role: string };
    if (!name || !role) {
      return res.status(400).json({ error: "name, role 필수" });
    }
    try {
      const { rows } = await pool.query(
        `INSERT INTO field_users (name, role) VALUES ($1, $2) RETURNING *`,
        [name, role]
      );
      res.status(201).json(rows[0]);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── 작업 환경 이력 ────────────────────────────────────────────────────────

  // 특정 용접사의 작업 이력 조회
  app.get("/api/field/records", async (req: Request, res: Response) => {
    const welder_id = req.query.welder_id ? Number(req.query.welder_id) : undefined;
    try {
      const { rows } = welder_id
        ? await pool.query(
            `SELECT * FROM field_weld_records WHERE welder_id = $1 ORDER BY created_at DESC`,
            [welder_id]
          )
        : await pool.query(
            `SELECT * FROM field_weld_records ORDER BY created_at DESC LIMIT 100`
          );
      res.json(rows);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // 작업 이력 생성
  app.post("/api/field/records", async (req: Request, res: Response) => {
    const { welder_id, project_name, current_amp, voltage_volt } = req.body as {
      welder_id: number;
      project_name?: string;
      current_amp?: number;
      voltage_volt?: number;
    };
    if (!welder_id) return res.status(400).json({ error: "welder_id 필수" });
    try {
      const { rows } = await pool.query(
        `INSERT INTO field_weld_records (welder_id, project_name, current_amp, voltage_volt)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [welder_id, project_name ?? "", current_amp ?? null, voltage_volt ?? null]
      );
      res.status(201).json(rows[0]);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── 검사 결과 ─────────────────────────────────────────────────────────────

  // 검사 결과 목록 조회 (record_id 필터 또는 전체)
  app.get("/api/field/inspections", async (req: Request, res: Response) => {
    const record_id = req.query.record_id ? Number(req.query.record_id) : undefined;
    try {
      const { rows } = record_id
        ? await pool.query(
            `SELECT * FROM field_inspections WHERE record_id = $1 ORDER BY created_at DESC`,
            [record_id]
          )
        : await pool.query(
            `SELECT * FROM field_inspections ORDER BY created_at DESC LIMIT 100`
          );
      res.json(rows);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // 검사 결과 생성
  app.post("/api/field/inspections", async (req: Request, res: Response) => {
    const {
      record_id, original_image_url, ppm_scale,
      avg_bead_width, straightness_error, final_status,
    } = req.body as {
      record_id: number;
      original_image_url?: string;
      ppm_scale?: number;
      avg_bead_width?: number;
      straightness_error?: number;
      final_status: "PASS" | "FAIL";
    };
    if (!record_id || !final_status) {
      return res.status(400).json({ error: "record_id, final_status 필수" });
    }
    try {
      const { rows } = await pool.query(
        `INSERT INTO field_inspections
           (record_id, original_image_url, ppm_scale, avg_bead_width, straightness_error, final_status)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [record_id, original_image_url ?? null, ppm_scale ?? null,
         avg_bead_width ?? null, straightness_error ?? null, final_status]
      );
      res.status(201).json(rows[0]);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── 결함 상세 ─────────────────────────────────────────────────────────────

  // 결함 목록 조회 (inspection_id 필터)
  app.get("/api/field/defects", async (req: Request, res: Response) => {
    const inspection_id = req.query.inspection_id ? Number(req.query.inspection_id) : undefined;
    if (!inspection_id) return res.status(400).json({ error: "inspection_id 필수" });
    try {
      const { rows } = await pool.query(
        `SELECT * FROM field_defects WHERE inspection_id = $1 ORDER BY confidence DESC`,
        [inspection_id]
      );
      res.json(rows);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // 결함 생성
  app.post("/api/field/defects", async (req: Request, res: Response) => {
    const { inspection_id, defect_type, confidence, size_mm } = req.body as {
      inspection_id: number;
      defect_type: string;
      confidence?: number;
      size_mm?: number;
    };
    if (!inspection_id || !defect_type) {
      return res.status(400).json({ error: "inspection_id, defect_type 필수" });
    }
    try {
      const { rows } = await pool.query(
        `INSERT INTO field_defects (inspection_id, defect_type, confidence, size_mm)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [inspection_id, defect_type, confidence ?? null, size_mm ?? null]
      );
      res.status(201).json(rows[0]);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── 대시보드 요약 ──────────────────────────────────────────────────────────

  // 전체 현황 요약 — 탭 대시보드 상단 stat card용
  app.get("/api/field/dashboard/summary", async (_req: Request, res: Response) => {
    try {
      const [totals, defectSummary, topWelders] = await Promise.all([
        pool.query(`
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
        pool.query(`
          SELECT defect_type, COUNT(*) AS cnt
          FROM field_defects
          GROUP BY defect_type
          ORDER BY cnt DESC
          LIMIT 5
        `),
        pool.query(`
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
        `),
      ]);

      res.json({
        totals: totals.rows[0],
        top_defects: defectSummary.rows,
        top_welders: topWelders.rows,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── 더미 데이터 시드 ──────────────────────────────────────────────────────
  // POST /api/field/seed?records=20
  // 실제 배포 전 제거하거나 관리자 토큰 가드를 추가할 것
  app.post("/api/field/seed", async (req: Request, res: Response) => {
    const recordsPerUser = Number(req.query.records ?? 5);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const insertedUsers: number[] = [];

      // 1. 용접사 삽입 (없으면 이름 기준 재사용)
      for (const w of DUMMY_WELDERS) {
        const existing = await client.query(
          `SELECT id FROM field_users WHERE name = $1`, [w.name]
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

      // 2. 작업 이력 → 검사 → 결함 삽입
      for (const userId of insertedUsers) {
        for (let i = 0; i < recordsPerUser; i++) {
          // 작업 환경
          const daysAgo = randInt(0, 30);
          const createdAt = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
          const { rows: recRows } = await client.query(
            `INSERT INTO field_weld_records
               (welder_id, project_name, current_amp, voltage_volt, created_at)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [
              userId,
              randPick(DUMMY_PROJECTS),
              parseFloat(rand(120, 300).toFixed(1)),   // 전류 120~300 A
              parseFloat(rand(18, 40).toFixed(1)),      // 전압 18~40 V
              createdAt,
            ]
          );
          const recordId = recRows[0].id;
          totalRecords++;

          // 검사 결과 (record당 1~2건)
          const inspectionCount = randInt(1, 2);
          for (let j = 0; j < inspectionCount; j++) {
            const beadWidth   = parseFloat(rand(6, 18).toFixed(2));
            const straightErr = parseFloat(rand(0.1, 3.5).toFixed(2));
            const status: "PASS" | "FAIL" = Math.random() < 0.72 ? "PASS" : "FAIL";

            const { rows: insRows } = await client.query(
              `INSERT INTO field_inspections
                 (record_id, ppm_scale, avg_bead_width, straightness_error, final_status, created_at)
               VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
              [
                recordId,
                parseFloat(rand(28, 45).toFixed(4)),  // ppm_scale
                beadWidth,
                straightErr,
                status,
                createdAt,
              ]
            );
            const inspectionId = insRows[0].id;
            totalInspections++;

            // 결함 (FAIL이면 1~4개, PASS면 0~1개)
            const defectCount = status === "FAIL" ? randInt(1, 4) : randInt(0, 1);
            for (let k = 0; k < defectCount; k++) {
              await client.query(
                `INSERT INTO field_defects (inspection_id, defect_type, confidence, size_mm)
                 VALUES ($1, $2, $3, $4)`,
                [
                  inspectionId,
                  randPick(DUMMY_DEFECT_TYPES),
                  parseFloat(rand(40, 99).toFixed(2)),
                  parseFloat(rand(0.3, 5.0).toFixed(2)),
                ]
              );
              totalDefects++;
            }
          }
        }
      }

      await client.query("COMMIT");
      res.json({
        message: "더미 데이터 생성 완료",
        users: insertedUsers.length,
        records: totalRecords,
        inspections: totalInspections,
        defects: totalDefects,
      });
    } catch (e: any) {
      await client.query("ROLLBACK");
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });
}
