import Anthropic from "@anthropic-ai/sdk";
import type { Express, Request, Response } from "express";
import express from "express";
import pool from "./db";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const largeBodyParser = express.json({ limit: "30mb" });

// ── Roboflow 설정 ────────────────────────────────────────────
const ROBOFLOW_API_KEY = process.env.ROBOFLOW_API_KEY ?? "";
const ROBOFLOW_MODEL_ID = process.env.ROBOFLOW_MODEL_ID ?? "weld-defect/3";

const ROBOFLOW_CLASS_MAP: Record<string, string> = {
  crack: "균열 (Crack)",
  porosity: "기공 (Porosity)",
  undercut: "언더컷 (Undercut)",
  overlap: "오버랩 (Overlap)",
  spatter: "스패터 (Spatter)",
  arc_strike: "아크 스트라이크 (Arc Strike)",
};

async function detectWithRoboflow(
  base64: string,
  label: string
): Promise<{ name: string; x: number; y: number }[]> {
  if (!ROBOFLOW_API_KEY) return [];
  try {
    const res = await fetch(
      `https://detect.roboflow.com/${ROBOFLOW_MODEL_ID}?api_key=${ROBOFLOW_API_KEY}&confidence=30`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: base64,
      }
    );
    if (!res.ok) return [];
    const data: any = await res.json();
    const W = data.image?.width || 1;
    const H = data.image?.height || 1;
    console.log(`[Roboflow ${label}] 탐지 수: ${data.predictions?.length ?? 0}`);
    return (data.predictions ?? [])
      .filter((p: any) => p.confidence >= 0.3)
      .map((p: any) => ({
        name: ROBOFLOW_CLASS_MAP[p.class?.toLowerCase()] ?? p.class,
        x: Math.round((p.x / W) * 100),
        y: Math.round((p.y / H) * 100),
      }));
  } catch (e) {
    console.error(`Roboflow 오류 [${label}]:`, e);
    return [];
  }
}

// ── 프롬프트 ────────────────────────────────────────────────
const SYSTEM_PROMPT = `당신은 20년 경력의 국제공인 용접검사관(CWI) AI입니다.
용접 비드 사진을 정밀 분석하여 결함과 비드 형상을 평가하십시오.

【비드 형상 평가 기준】
- 비드 폭 편차: 1mm미만→양호 / 1~2mm→주의 / 2mm이상→불량
- 비드 높이: 2mm미만→양호 / 2~3mm→주의 / 3mm이상→불량
- 직진도: 1mm미만→양호 / 1~2mm→주의 / 2mm이상→불량
- 피치 균일도: 일정→양호 / 2회불일정→주의 / 3회이상→불량

【6대 결함 기준 (선급)】
균열·기공·오버랩·아크스트라이크: 불허 / 언더컷: 0.5mm이하 / 스패터: 경미허용

【defectLocations 좌표 규칙】
x=0:왼쪽끝, x=100:오른쪽끝, y=0:위쪽끝, y=100:아래쪽끝
detected:true 결함만 포함. 확실한 위치만 기재.

반드시 아래 JSON 형식만 출력하고 다른 텍스트는 절대 포함하지 마십시오:
{
  "aiScore": <0-100 정수>,
  "overallVerdict": "PASS",
  "beadAnalysis": {
    "totalScore": <0-100>,
    "width":          {"value":"최대Xmm/최소Xmm","score":<0-100>,"result":"양호"},
    "height":         {"value":"Xmm","score":<0-100>,"result":"양호"},
    "straightness":   {"value":"±Xmm","score":<0-100>,"result":"양호"},
    "pitchUniformity":{"value":"Xmm","score":<0-100>,"result":"양호"}
  },
  "defects": [
    {"name":"균열 (Crack)",               "detected":false,"severity":"없음","confidence":85,"standard":"선급","measured":"없음","limit":"불허","result":"합격"},
    {"name":"기공 (Porosity)",             "detected":false,"severity":"없음","confidence":85,"standard":"선급","measured":"없음","limit":"불허","result":"합격"},
    {"name":"언더컷 (Undercut)",           "detected":false,"severity":"없음","confidence":85,"standard":"선급","measured":"없음","limit":"0.5mm","result":"합격"},
    {"name":"오버랩 (Overlap)",            "detected":false,"severity":"없음","confidence":85,"standard":"선급","measured":"없음","limit":"불허","result":"합격"},
    {"name":"스패터 (Spatter)",            "detected":false,"severity":"없음","confidence":85,"standard":"선급","measured":"없음","limit":"경미허용","result":"합격"},
    {"name":"아크 스트라이크 (Arc Strike)","detected":false,"severity":"없음","confidence":85,"standard":"선급","measured":"없음","limit":"불허","result":"합격"}
  ],
  "defectLocations": [],
  "improvements": ["개선사항1","개선사항2","개선사항3"],
  "comprehensiveReport": "200자 이상의 종합 분석 내용",
  "top3Defects": []
}`;

const PER_PHOTO_PROMPT = `당신은 용접검사관 AI입니다. 사진을 분석하여 비드 형상과 결함을 평가하십시오.
비드폭편차: 1mm미만→양호/1~2mm→주의/2mm이상→불량
비드높이: 2mm미만→양호/2~3mm→주의/3mm이상→불량
직진도: 1mm미만→양호/1~2mm→주의/2mm이상→불량

반드시 JSON만 출력:
{
  "beadAnalysis": {
    "totalScore":<0-100>,
    "width":{"value":"값","score":<0-100>,"result":"양호"},
    "height":{"value":"값","score":<0-100>,"result":"양호"},
    "straightness":{"value":"값","score":<0-100>,"result":"양호"},
    "pitchUniformity":{"value":"값","score":<0-100>,"result":"양호"}
  },
  "defects":[
    {"name":"균열 (Crack)","detected":false,"severity":"없음","confidence":80,"standard":"선급","measured":"없음","limit":"불허","result":"합격"},
    {"name":"기공 (Porosity)","detected":false,"severity":"없음","confidence":80,"standard":"선급","measured":"없음","limit":"불허","result":"합격"},
    {"name":"언더컷 (Undercut)","detected":false,"severity":"없음","confidence":80,"standard":"선급","measured":"없음","limit":"0.5mm","result":"합격"},
    {"name":"오버랩 (Overlap)","detected":false,"severity":"없음","confidence":80,"standard":"선급","measured":"없음","limit":"불허","result":"합격"},
    {"name":"스패터 (Spatter)","detected":false,"severity":"없음","confidence":80,"standard":"선급","measured":"없음","limit":"경미허용","result":"합격"},
    {"name":"아크 스트라이크 (Arc Strike)","detected":false,"severity":"없음","confidence":80,"standard":"선급","measured":"없음","limit":"불허","result":"합격"}
  ]
}`;

// ── 유틸 ────────────────────────────────────────────────────
function applyBeadThresholds(ba: any): any {
  if (!ba) return ba;
  const w = (v: string) => {
    const max = v.match(/최대\s*([\d.]+)/);
    const min = v.match(/최소\s*([\d.]+)/);
    if (max && min) {
      const d = parseFloat(max[1]) - parseFloat(min[1]);
      return d < 1 ? "양호" : d < 2 ? "주의" : "불량";
    }
    const m = v.match(/([\d.]+)/);
    if (m) { const n = parseFloat(m[1]); return n < 1 ? "양호" : n < 2 ? "주의" : "불량"; }
    return "주의";
  };
  const s = (v: string) => {
    const m = v.match(/([\d.]+)/);
    if (m) { const n = parseFloat(m[1]); return n < 1 ? "양호" : n < 2 ? "주의" : "불량"; }
    return "주의";
  };
  if (ba.width?.value)       ba.width.result       = w(ba.width.value);
  if (ba.straightness?.value) ba.straightness.result = s(ba.straightness.value);
  return ba;
}

const FALLBACK_DEFECTS = [
  { name: "균열 (Crack)",               detected: false, severity: "없음", confidence: 70, standard: "선급", measured: "없음", limit: "불허",     result: "합격" },
  { name: "기공 (Porosity)",             detected: false, severity: "없음", confidence: 70, standard: "선급", measured: "없음", limit: "불허",     result: "합격" },
  { name: "언더컷 (Undercut)",           detected: false, severity: "없음", confidence: 70, standard: "선급", measured: "없음", limit: "0.5mm",    result: "합격" },
  { name: "오버랩 (Overlap)",            detected: false, severity: "없음", confidence: 70, standard: "선급", measured: "없음", limit: "불허",     result: "합격" },
  { name: "스패터 (Spatter)",            detected: false, severity: "없음", confidence: 70, standard: "선급", measured: "없음", limit: "경미허용", result: "합격" },
  { name: "아크 스트라이크 (Arc Strike)", detected: false, severity: "없음", confidence: 70, standard: "선급", measured: "없음", limit: "불허",     result: "합격" },
];

function makeFallback(selfScore: number) {
  const s = Math.min(100, Math.max(0, Math.round(selfScore * 0.85 + 10)));
  return {
    aiScore: s, overallVerdict: s >= 70 ? "PASS" : "FAIL",
    beadAnalysis: {
      totalScore: s,
      width:          { value: "측정불가(추정)", score: s, result: "주의" },
      height:         { value: "측정불가(추정)", score: s, result: "주의" },
      straightness:   { value: "±1.0mm(추정)",   score: s, result: "주의" },
      pitchUniformity:{ value: "측정불가(추정)", score: s, result: "주의" },
    },
    defects: FALLBACK_DEFECTS, defectLocations: [],
    improvements: ["사진을 다시 업로드하여 정확한 분석을 받아보세요."],
    comprehensiveReport: "분석 오류. 사진을 다시 업로드해주세요.",
    top3Defects: [], photoAnalyses: null,
  };
}

function parseJSON(text: string): any | null {
  const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

// ── Claude 개별 사진 분석 ────────────────────────────────────
async function analyzePhotoWithClaude(params: {
  base64: string; label: string; process: string; posture: string;
  plateThickness?: string; roboflowLocs: { name: string; x: number; y: number }[];
}): Promise<{ beadAnalysis: any; defects: any[]; defectLocations: { name: string; x: number; y: number }[] }> {
  const rfNote = params.roboflowLocs.length > 0
    ? `\nRoboflow 탐지: ${params.roboflowLocs.map(l => `${l.name}(x:${l.x}%,y:${l.y}%)`).join(", ")}`
    : "";

  const res = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    system: PER_PHOTO_PROMPT,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: params.base64 } },
        { type: "text", text: `${params.label} 사진\n공정:${params.process} / 자세:${params.posture}${params.plateThickness ? ` / 두께:${params.plateThickness}mm` : ""}${rfNote}\n\nJSON만 출력.` },
      ],
    }],
  });

  const text = res.content[0]?.type === "text" ? res.content[0].text : "";
  const parsed = parseJSON(text);
  if (!parsed) throw new Error("JSON 파싱 실패");

  return {
    beadAnalysis: applyBeadThresholds(parsed.beadAnalysis),
    defects: parsed.defects ?? FALLBACK_DEFECTS,
    defectLocations: params.roboflowLocs, // Roboflow 좌표 우선
  };
}

// ── 메인 라우트 ──────────────────────────────────────────────
export function registerWeldAnalysisRoute(app: Express): void {
  app.post("/api/analyze-weld", largeBodyParser, async (req: Request, res: Response) => {
    const { photos, imageBase64, process, posture, material, selfScore, previousResultsSummary, plateThickness } = req.body;
    const frontPhoto = photos?.front || imageBase64;
    if (!frontPhoto) return res.status(400).json({ error: "정면 사진이 필요합니다." });

    try {
      // 1) 관리자 피드백 로드
      let adminFeedback = "";
      try {
        const fb = await pool.query("SELECT feedback_text FROM admin_feedback ORDER BY created_at DESC LIMIT 20");
        if (fb.rows.length > 0) adminFeedback = `\n【관리자 검사기준】\n${fb.rows.map((r: any, i: number) => `${i+1}. ${r.feedback_text}`).join("\n")}`;
      } catch {}

      const proc  = process  || "FCAW";
      const post  = posture  || "1G";
      const mat   = material || "탄소강 평판";
      const thick = plateThickness || undefined;

      // 2) Roboflow 결함 위치 탐지 (병렬)
      const [frontRF, sideRF, backRF] = await Promise.all([
        detectWithRoboflow(frontPhoto,   "정면"),
        photos?.side ? detectWithRoboflow(photos.side, "측면") : Promise.resolve([]),
        photos?.back ? detectWithRoboflow(photos.back, "이면") : Promise.resolve([]),
      ]);

      const rfSummary = frontRF.length > 0
        ? `\n【Roboflow 탐지 결함】${frontRF.map((l: any) => `${l.name}(x:${l.x}%,y:${l.y}%)`).join(", ")}`
        : "\n【Roboflow】결함 미탐지";

      const prevNote = previousResultsSummary
        ? `\n【이전 이력】\n${previousResultsSummary}`
        : "\n【이전 이력】첫 번째 업로드";

      const userText = `공정:${proc} / 자세:${post} / 소재:${mat} / 자체점수:${selfScore ?? 50}점${thick ? ` / 두께:${thick}mm` : ""}${rfSummary}${adminFeedback}${prevNote}\n\nJSON만 출력하십시오.`;

      // 이미지 구성
      const imgContents: any[] = [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: frontPhoto } },
      ];
      if (photos?.side) imgContents.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: photos.side } });
      if (photos?.back) imgContents.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: photos.back } });
      imgContents.push({ type: "text", text: userText });

      // 3) Claude 메인 + 사진별 분석 병렬
      const [mainRes, sideAnalysis, backAnalysis] = await Promise.all([
        anthropic.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4000,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: imgContents }],
        }),
        photos?.side
          ? analyzePhotoWithClaude({ base64: photos.side, label: "측면", process: proc, posture: post, plateThickness: thick, roboflowLocs: sideRF })
              .catch(e => { console.error("측면 오류:", e); return null; })
          : Promise.resolve(null),
        photos?.back
          ? analyzePhotoWithClaude({ base64: photos.back, label: "이면", process: proc, posture: post, roboflowLocs: backRF })
              .catch(e => { console.error("이면 오류:", e); return null; })
          : Promise.resolve(null),
      ]);

      const mainText = mainRes.content[0]?.type === "text" ? mainRes.content[0].text : "";
      console.log("Claude 응답 (앞 300자):", mainText.slice(0, 300));

      const parsed = parseJSON(mainText);
      if (!parsed) {
        console.error("JSON 파싱 실패. 원문:", mainText.slice(0, 300));
        return res.json(makeFallback(selfScore ?? 50));
      }

      // 4) 비드 분석 임계값 적용
      const beadAnalysis = applyBeadThresholds(parsed.beadAnalysis) ?? {
        totalScore: 50,
        width:          { value: "측정불가(추정)", score: 50, result: "주의" },
        height:         { value: "측정불가(추정)", score: 50, result: "주의" },
        straightness:   { value: "±1.0mm(추정)",   score: 50, result: "주의" },
        pitchUniformity:{ value: "측정불가(추정)", score: 50, result: "주의" },
      };

      // 5) ★ 결함 위치: Roboflow 우선 → Claude 좌표 → 빈 배열
      let defectLocations: { name: string; x: number; y: number }[] = [];
      if (frontRF.length > 0) {
        defectLocations = frontRF;
        console.log("✅ Roboflow 좌표 적용:", JSON.stringify(defectLocations));
      } else if (Array.isArray(parsed.defectLocations) && parsed.defectLocations.length > 0) {
        defectLocations = parsed.defectLocations
          .map((l: any) => ({
            name: String(l.name ?? ""),
            x: Math.min(100, Math.max(0, parseFloat(String(l.x)) || 50)),
            y: Math.min(100, Math.max(0, parseFloat(String(l.y)) || 50)),
          }))
          .filter((l: any) => l.name.length > 0);
        console.log("ℹ️ Claude 좌표 적용:", JSON.stringify(defectLocations));
      } else {
        console.log("⚠️ 결함 위치 좌표 없음");
      }

      // 6) photoAnalyses 구성
      const frontAnalysis = { beadAnalysis, defects: parsed.defects ?? FALLBACK_DEFECTS, defectLocations };
      const photoAnalyses: Record<string, any> = { front: frontAnalysis };
      if (sideAnalysis) photoAnalyses.side = sideAnalysis;
      if (backAnalysis)  photoAnalyses.back = backAnalysis;

      const result = {
        aiScore:         Math.min(100, Math.max(0, Math.round(parsed.aiScore ?? 50))),
        overallVerdict:  parsed.overallVerdict === "PASS" ? "PASS" : "FAIL",
        beadAnalysis,
        defects:         parsed.defects ?? FALLBACK_DEFECTS,
        defectLocations,
        photoAnalyses,
        improvements:    Array.isArray(parsed.improvements) ? parsed.improvements : ["분석 데이터를 확인해주세요."],
        comprehensiveReport: parsed.comprehensiveReport ?? "",
        top3Defects:     Array.isArray(parsed.top3Defects) ? parsed.top3Defects : [],
      };

      console.log(`✅ 완료 | 점수:${result.aiScore} | 결함위치:${defectLocations.length}개 | 판정:${result.overallVerdict}`);
      res.json(result);

    } catch (err) {
      console.error("분석 오류:", err);
      res.json(makeFallback(selfScore ?? 50));
    }
  });
}
