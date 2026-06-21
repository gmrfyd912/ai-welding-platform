import type { Express, Request, Response } from "express";
import multer from "multer";
import pool from "./db";
import { ensureFieldTables } from "./schema";

const upload = multer({ storage: multer.memoryStorage() });

const FASTAPI_BASE = process.env.FASTAPI_URL ?? "http://127.0.0.1:8080";
const ANALYSIS_TIMEOUT_MS = 90_000;

// Render 프로덕션 환경(= FastAPI 없음) 여부 감지
// FASTAPI_URL 미설정 + RENDER 환경변수 존재 → FastAPI 미배포 상태
const IS_RENDER_WITHOUT_FASTAPI =
  !process.env.FASTAPI_URL && !!process.env.RENDER;

console.log(
  `[field-routes] FastAPI 주소: ${FASTAPI_BASE}` +
  (IS_RENDER_WITHOUT_FASTAPI ? " ⚠ Render 환경 — FastAPI 미배포, 비전 분석 비활성" : "")
);

// FastAPI 가용성 확인 (비동기, 서버 시작을 막지 않음)
(async () => {
  try {
    const r = await fetch(`${FASTAPI_BASE}/docs`, {
      signal: AbortSignal.timeout(5_000),
    });
    console.log(`[field-routes] ✅ FastAPI 응답 확인 (${r.status}) — ${FASTAPI_BASE}`);
  } catch (e: any) {
    const cause = (e.cause as any)?.message ?? e.message ?? "알 수 없는 오류";
    console.warn(`[field-routes] ⚠ FastAPI 미응답: ${FASTAPI_BASE}`);
    console.warn(`[field-routes]   원인: ${cause}`);
    console.warn(`[field-routes]   비전 분석 기능이 동작하지 않습니다.`);
    console.warn(`[field-routes]   해결: npm run dev:all 로 FastAPI와 Node.js를 함께 시작하세요.`);
  }
})();

async function _fieldFetch(url: string, options: RequestInit, ms: number) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

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
  console.log("[field-routes] 라우트 등록 시작");

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

  // ── 전체 데이터 초기화 ────────────────────────────────────────────────────
  // DELETE /api/field/clear
  // field_defects → field_inspections → field_weld_records 순으로 전부 삭제
  // (field_users는 보존)
  app.delete("/api/field/clear", async (_req: Request, res: Response) => {
    try {
      await pool.query("DELETE FROM field_defects");
      await pool.query("DELETE FROM field_inspections");
      await pool.query("DELETE FROM field_weld_records");
      console.log("[field/clear] 검사 데이터 전체 삭제 완료");
      res.json({ ok: true, message: "모든 검사 데이터가 삭제되었습니다." });
    } catch (e: any) {
      console.error("[field/clear] 삭제 실패:", e.message);
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

  console.log("[field-routes] POST /api/field/analysis 라우트 등록 중 (multer 포함)");
  // ── 통합 비전 분석 ──────────────────────────────────────────────────────────
  // POST /api/field/analysis  (multipart/form-data)
  // fields: image(file), project_name?, current_amp?, voltage_volt?, worker_name?
  // 내부 흐름:
  //   1. 작업자 조회(없으면 생성) → record 생성
  //   2. FastAPI /analyze-welding 호출 (quick 모드)
  //   3. field_inspections + field_defects 저장
  //   4. 결과 반환
  app.post(
    "/api/field/analysis",
    upload.single("image"),
    async (req: Request, res: Response) => {
      const file = req.file;

      // ── 수신 진단 로그 (파일·필드 수신 여부 확인) ──────────────────────────
      console.log(
        `[field/analysis] 요청 수신 | file=${file ? `${file.originalname}(${file.size}B)` : "없음"} | body=${JSON.stringify(Object.keys(req.body))}`
      );

      if (!file) {
        console.warn("[field/analysis] multer: 파일 누락 — FormData 필드명 또는 Content-Type 확인 필요");
        return res.status(400).json({ error: "image 파일이 필요합니다" });
      }

      // Render 프로덕션 환경에서 FastAPI 미배포 시 즉시 503 반환
      if (IS_RENDER_WITHOUT_FASTAPI) {
        return res.status(503).json({
          error: "FASTAPI_NOT_DEPLOYED",
          message:
            "비전 분석 기능은 로컬 개발 환경에서만 사용 가능합니다. " +
            "PC에서 npm run dev:all 명령으로 FastAPI와 Node.js를 함께 시작하고, " +
            "Expo를 EXPO_PUBLIC_DOMAIN=http://<컴퓨터_IP>:5001 로 실행하세요.",
        });
      }

      const {
        project_name,
        current_amp,
        voltage_volt,
        worker_name,
      } = req.body as {
        project_name?: string;
        current_amp?: string;
        voltage_volt?: string;
        worker_name?: string;
      };

      const client = await pool.connect();
      try {
        // ── 1. 작업자 조회 / 자동 생성 ────────────────────────────────────
        const wName = worker_name?.trim() || "현장 작업자";
        let userId: number;
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

        // ── 2. 작업 이력 생성 ──────────────────────────────────────────────
        const recRes = await client.query(
          `INSERT INTO field_weld_records (welder_id, project_name, current_amp, voltage_volt)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [
            userId,
            project_name ?? "",
            current_amp ? parseFloat(current_amp) : null,
            voltage_volt ? parseFloat(voltage_volt) : null,
          ]
        );
        const recordId: number = recRes.rows[0].id;

        // ── 3. FastAPI /analyze-welding 호출 (quick 모드) ──────────────────
        // 클라이언트가 보낸 파일 버퍼를 그대로 FastAPI에 전달 (재인코딩 없음)
        // Buffer(Uint8Array 서브클래스)를 그대로 전달 — Blob이 byteOffset/byteLength를 참조해
        // multer 메모리 풀 공유 슬라이스 문제 없이 정확한 바이트 범위만 캡처한다.
        const fileBlob = new Blob(
          [(file.buffer.buffer as ArrayBuffer).slice(
            file.buffer.byteOffset,
            file.buffer.byteOffset + file.buffer.byteLength
          )],
          { type: file.mimetype || "image/jpeg" }
        );
        const formData = new FormData();
        formData.append("file", fileBlob, file.originalname || "weld.jpg");
        formData.append("process",               "FCAW");
        formData.append("posture",               "1G");
        formData.append("material",              "탄소강 평판");
        formData.append("bead_type",             "위빙 비드");
        formData.append("pass_type",             "");
        formData.append("ai_model",              "gpt");
        formData.append("admin_feedback",        "");
        formData.append("user_history",          "");
        formData.append("measurement_context",   "");
        formData.append("plate_thickness",       "");
        formData.append("pipe_outer_diameter_mm","");
        formData.append("language",              "ko");
        formData.append("analysis_mode",         "quick");
        formData.append("is_fillet",             "false");
        formData.append("has_laser",             "false");
        formData.append("laser_angle_deg",       "45");
        formData.append("shooting_angle_deg",    "90");

        const faUrl = `${FASTAPI_BASE}/analyze-welding`;
        console.log(`[field/analysis] FastAPI 호출: POST ${faUrl} | 파일: ${file.size}B | 모드: quick`);
        const faResp = await _fieldFetch(
          faUrl,
          { method: "POST", body: formData },
          ANALYSIS_TIMEOUT_MS
        );

        if (!faResp.ok) {
          const errText = await faResp.text().catch(() => "");
          let userMsg = "사진 분석에 실패했습니다. 용접부가 명확한 사진을 사용해 주세요.";
          try { userMsg = JSON.parse(errText)?.message ?? userMsg; } catch {}
          const err: any = new Error(userMsg);
          err.status = faResp.status;
          throw err;
        }

        const fa = await faResp.json();

        // ── 4. 결과 파싱 ────────────────────────────────────────────────────
        const finalStatus: "PASS" | "FAIL" =
          fa.overallVerdict === "PASS" ? "PASS" : "FAIL";
        const aiScore: number | null = fa.aiScore ?? null;

        const vm = fa.visionMeasurement ?? {};
        const avgBeadWidth: number | null =
          vm.bead_width_max != null && vm.bead_width_min != null
            ? parseFloat(
                ((Number(vm.bead_width_max) + Number(vm.bead_width_min)) / 2).toFixed(2)
              )
            : null;
        const straightnessError: number | null =
          vm.straightness_variance != null
            ? parseFloat(Number(vm.straightness_variance).toFixed(2))
            : null;

        const detectedDefects: Array<{
          name: string; severity: string; confidence: number;
        }> = ((fa.defects ?? []) as any[])
          .filter((d) => d.detected === true)
          .map((d) => ({
            name:       d.name       ?? "알 수 없는 결함",
            severity:   d.severity   ?? "보통",
            confidence: d.confidence ?? 0,
          }));

        // ── 5. field_inspections 저장 ──────────────────────────────────────
        const insRes = await client.query(
          `INSERT INTO field_inspections
             (record_id, ppm_scale, avg_bead_width, straightness_error, final_status)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [
            recordId,
            vm.ppm ?? null,
            avgBeadWidth,
            straightnessError,
            finalStatus,
          ]
        );
        const inspectionId: number = insRes.rows[0].id;

        // ── 6. field_defects 저장 ──────────────────────────────────────────
        for (const d of detectedDefects) {
          await client.query(
            `INSERT INTO field_defects (inspection_id, defect_type, confidence)
             VALUES ($1, $2, $3)`,
            [inspectionId, d.name, d.confidence]
          );
        }

        res.json({
          inspection_id:      inspectionId,
          final_status:       finalStatus,
          ai_score:           aiScore,
          avg_bead_width:     avgBeadWidth,
          straightness_error: straightnessError,
          defect_count:       detectedDefects.length,
          defects:            detectedDefects,
        });
      } catch (e: any) {
        const isFetch =
          e.message?.includes("fetch failed") ||
          e.message?.includes("ECONNREFUSED");
        const isTimeout = e.name === "AbortError";
        const status = e.status ?? (isFetch || isTimeout ? 503 : 500);

        // 전체 진단 로그 출력
        console.error("─── [field/analysis] 오류 발생 ───────────────");
        console.error("  message   :", e.message?.slice(0, 300));
        console.error("  cause     :", (e.cause as any)?.message ?? "N/A");
        console.error("  causeCode :", (e.cause as any)?.code ?? "N/A");
        console.error("  status    :", e.status ?? "N/A");
        console.error("  isFetch   :", isFetch);
        console.error("  timeout   :", isTimeout);
        console.error("  faUrl     :", `${FASTAPI_BASE}/analyze-welding`);
        console.error("  stack     :", e.stack?.split("\n").slice(0, 4).join(" | "));
        console.error("──────────────────────────────────────────────");

        res.status(status).json({
          error: "ANALYSIS_FAILED",
          message: isFetch
            ? `비전 분석 Python 서버(${FASTAPI_BASE})에 연결할 수 없습니다. ` +
              "npm run dev:all 명령으로 FastAPI와 Node.js를 함께 시작했는지 확인하세요."
            : isTimeout
            ? `비전 분석 시간 초과 (90초). ${FASTAPI_BASE} 서버 응답을 기다리다 중단됐습니다.`
            : e.message ?? "분석 실패",
        });
      } finally {
        client.release();
      }
    }
  );

  console.log("[field-routes] 라우트 등록 완료: /api/field/* (analysis, seed, dashboard, users, records, inspections, defects)");
}
