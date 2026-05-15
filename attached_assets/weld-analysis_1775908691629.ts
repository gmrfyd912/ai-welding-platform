import Anthropic from "@anthropic-ai/sdk";
import type { Express, Request, Response } from "express";
import express from "express";
import pool from "./db";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const largeBodyParser = express.json({ limit: "30mb" });

// ── Roboflow (API키 없으면 자동 건너뜀) ─────────────────────
const ROBOFLOW_API_KEY = process.env.ROBOFLOW_API_KEY ?? "";
const ROBOFLOW_MODEL_ID = process.env.ROBOFLOW_MODEL_ID ?? "weld-defect/3";
const ROBOFLOW_CLASS_MAP: Record<string, string> = {
  crack: "균열 (Crack)", porosity: "기공 (Porosity)",
  undercut: "언더컷 (Undercut)", overlap: "오버랩 (Overlap)",
  spatter: "스패터 (Spatter)", arc_strike: "아크 스트라이크 (Arc Strike)",
};

async function detectWithRoboflow(base64: string, label: string): Promise<{ name: string; x: number; y: number }[]> {
  if (!ROBOFLOW_API_KEY) return [];
  try {
    const res = await fetch(
      `https://detect.roboflow.com/${ROBOFLOW_MODEL_ID}?api_key=${ROBOFLOW_API_KEY}&confidence=30`,
      { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: base64 }
    );
    if (!res.ok) return [];
    const data: any = await res.json();
    const W = data.image?.width || 1, H = data.image?.height || 1;
    console.log(`[Roboflow ${label}] 탐지: ${data.predictions?.length ?? 0}개`);
    return (data.predictions ?? []).filter((p: any) => p.confidence >= 0.3).map((p: any) => ({
      name: ROBOFLOW_CLASS_MAP[p.class?.toLowerCase()] ?? p.class,
      x: Math.round((p.x / W) * 100),
      y: Math.round((p.y / H) * 100),
    }));
  } catch (e) { console.error(`Roboflow 오류[${label}]:`, e); return []; }
}

// ── 메인 분석 프롬프트 ───────────────────────────────────────
const SYSTEM_PROMPT = `당신은 20년 경력의 국제공인 용접검사관(CWI)입니다.
제공된 용접 비드 사진을 면밀히 분석하여 결함 유무와 위치, 비드 형상을 정확히 평가하십시오.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【비드 형상 평가 기준】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
비드 폭 편차 : 1mm 미만 → 양호 / 1~2mm → 주의 / 2mm 이상 → 불량
비드 높이    : 2mm 미만 → 양호 / 2~3mm → 주의 / 3mm 이상 → 불량
직진도       : 1mm 미만 → 양호 / 1~2mm → 주의 / 2mm 이상 → 불량
피치 균일도  : 일정 → 양호 / 2회 불규칙 → 주의 / 3회 이상 → 불량

측정자(자)가 사진에 있으면 mm 눈금 기준으로 정확히 측정하십시오.
측정자가 없으면 비드 폭·직진도·피치 수치 뒤에 반드시 "(추정)" 을 붙이십시오.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【6대 결함 판단 기준 (선급 규정)】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. 균열 (Crack)            - 비드 또는 모재 경계선의 선형 갈라짐 → 불허 (발견 즉시 불합격)
2. 기공 (Porosity)         - 비드 표면의 원형/타원형 구멍, 바늘자국 → 불허
3. 언더컷 (Undercut)       - 비드 가장자리(토우) 모재가 파인 홈 → 0.5mm 이하 허용
4. 오버랩 (Overlap)        - 용접금속이 모재 위로 흘러넘쳐 덮인 상태 → 불허
5. 스패터 (Spatter)        - 비드 주변 모재에 흩뿌려진 금속 방울 → 경미 허용
6. 아크 스트라이크(ArcStrike)- 비드 밖 모재의 불규칙한 긁힘/녹은 자국 → 불허

★ 결함 심각도 기준:
  없음: 해당 결함 없음
  경미: 기준치 50% 이하 또는 극소량
  보통: 기준치 50~100%
  심각: 기준치 초과 또는 불허 결함 존재

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【defectLocations 좌표 작성 규칙 - 매우 중요】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- 이미지를 100×100 격자로 가정합니다
- x=0: 이미지 왼쪽 끝, x=100: 오른쪽 끝
- y=0: 이미지 위쪽 끝, y=100: 아래쪽 끝
- detected가 true인 결함은 반드시 좌표를 기재하십시오
- 결함이 여러 곳이면 각각 별도 항목으로 기재하십시오
- 좌표를 모르겠으면 이미지 중앙(x:50, y:50)으로 기재하십시오
- 절대로 빈 배열([])로 두지 마십시오 (detected:true 결함이 있는 경우)

예시: 언더컷이 이미지 왼쪽 상단에 있으면 → {"name":"언더컷 (Undercut)","x":20,"y":25}
예시: 스패터가 오른쪽 하단에 있으면 → {"name":"스패터 (Spatter)","x":75,"y":80}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【채점 기준】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
90~100점: 결함 없음, 비드 형상 우수
80~89점 : 경미한 결함 1~2개 또는 비드 형상 주의 1~2개
70~79점 : 보통 결함 존재 또는 비드 형상 불량 1개
60~69점 : 심각 결함 존재
60점 미만: 불허 결함(균열·기공 등) 존재
PASS 기준: 70점 이상, FAIL: 70점 미만

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【출력 형식 - 반드시 아래 JSON만 출력, 다른 텍스트 금지】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{
  "aiScore": <0-100 정수>,
  "overallVerdict": "PASS 또는 FAIL",
  "beadAnalysis": {
    "totalScore": <0-100>,
    "width":          {"value":"최대Xmm/최소Xmm(추정)","score":<0-100>,"result":"양호 또는 주의 또는 불량"},
    "height":         {"value":"Xmm(추정)","score":<0-100>,"result":"양호 또는 주의 또는 불량"},
    "straightness":   {"value":"±Xmm(추정)","score":<0-100>,"result":"양호 또는 주의 또는 불량"},
    "pitchUniformity":{"value":"Xmm(추정)","score":<0-100>,"result":"양호 또는 주의 또는 불량"}
  },
  "defects": [
    {"name":"균열 (Crack)",               "detected":<true/false>,"severity":"없음 또는 경미 또는 보통 또는 심각","confidence":<0-100>,"standard":"선급","measured":"<측정값 또는 없음>","limit":"불허","result":"합격 또는 불합격 또는 경고"},
    {"name":"기공 (Porosity)",             "detected":<true/false>,"severity":"없음 또는 경미 또는 보통 또는 심각","confidence":<0-100>,"standard":"선급","measured":"<측정값 또는 없음>","limit":"불허","result":"합격 또는 불합격 또는 경고"},
    {"name":"언더컷 (Undercut)",           "detected":<true/false>,"severity":"없음 또는 경미 또는 보통 또는 심각","confidence":<0-100>,"standard":"선급","measured":"<측정값 또는 없음>","limit":"0.5mm","result":"합격 또는 불합격 또는 경고"},
    {"name":"오버랩 (Overlap)",            "detected":<true/false>,"severity":"없음 또는 경미 또는 보통 또는 심각","confidence":<0-100>,"standard":"선급","measured":"<측정값 또는 없음>","limit":"불허","result":"합격 또는 불합격 또는 경고"},
    {"name":"스패터 (Spatter)",            "detected":<true/false>,"severity":"없음 또는 경미 또는 보통 또는 심각","confidence":<0-100>,"standard":"선급","measured":"<측정값 또는 없음>","limit":"경미허용","result":"합격 또는 불합격 또는 경고"},
    {"name":"아크 스트라이크 (Arc Strike)","detected":<true/false>,"severity":"없음 또는 경미 또는 보통 또는 심각","confidence":<0-100>,"standard":"선급","measured":"<측정값 또는 없음>","limit":"불허","result":"합격 또는 불합격 또는 경고"}
  ],
  "defectLocations": [
    {"name":"<결함명>","x":<0-100>,"y":<0-100>}
  ],
  "improvements": ["<핵심 개선사항>","<훈련 가이드>","<추가 조언>"],
  "comprehensiveReport": "<강점·약점·기량추이 종합분석 200자 이상>",
  "top3Defects": ["<가장심각한결함명>"]
}`;

// ── 개별 사진 프롬프트 ───────────────────────────────────────
const PER_PHOTO_PROMPT = `당신은 용접검사관 AI입니다. 이 사진의 비드 형상과 결함을 정밀 평가하십시오.

비드폭편차: 1mm미만→양호 / 1~2mm→주의 / 2mm이상→불량
비드높이: 2mm미만→양호 / 2~3mm→주의 / 3mm이상→불량
직진도: 1mm미만→양호 / 1~2mm→주의 / 2mm이상→불량

결함이 발견되면 defectLocations에 반드시 좌표를 기재하십시오.
(x=0:왼쪽, x=100:오른쪽, y=0:위쪽, y=100:아래쪽)
detected:true 결함이 있으면 절대 빈 배열로 두지 마십시오.

반드시 JSON만 출력:
{
  "beadAnalysis": {
    "totalScore":<0-100>,
    "width":{"value":"값","score":<0-100>,"result":"양호 또는 주의 또는 불량"},
    "height":{"value":"값","score":<0-100>,"result":"양호 또는 주의 또는 불량"},
    "straightness":{"value":"값","score":<0-100>,"result":"양호 또는 주의 또는 불량"},
    "pitchUniformity":{"value":"값","score":<0-100>,"result":"양호 또는 주의 또는 불량"}
  },
  "defects":[
    {"name":"균열 (Crack)","detected":<true/false>,"severity":"없음 또는 경미 또는 보통 또는 심각","confidence":<0-100>,"standard":"선급","measured":"없음","limit":"불허","result":"합격 또는 불합격 또는 경고"},
    {"name":"기공 (Porosity)","detected":<true/false>,"severity":"없음 또는 경미 또는 보통 또는 심각","confidence":<0-100>,"standard":"선급","measured":"없음","limit":"불허","result":"합격 또는 불합격 또는 경고"},
    {"name":"언더컷 (Undercut)","detected":<true/false>,"severity":"없음 또는 경미 또는 보통 또는 심각","confidence":<0-100>,"standard":"선급","measured":"없음","limit":"0.5mm","result":"합격 또는 불합격 또는 경고"},
    {"name":"오버랩 (Overlap)","detected":<true/false>,"severity":"없음 또는 경미 또는 보통 또는 심각","confidence":<0-100>,"standard":"선급","measured":"없음","limit":"불허","result":"합격 또는 불합격 또는 경고"},
    {"name":"스패터 (Spatter)","detected":<true/false>,"severity":"없음 또는 경미 또는 보통 또는 심각","confidence":<0-100>,"standard":"선급","measured":"없음","limit":"경미허용","result":"합격 또는 불합격 또는 경고"},
    {"name":"아크 스트라이크 (Arc Strike)","detected":<true/false>,"severity":"없음 또는 경미 또는 보통 또는 심각","confidence":<0-100>,"standard":"선급","measured":"없음","limit":"불허","result":"합격 또는 불합격 또는 경고"}
  ],
  "defectLocations":[
    {"name":"<결함명>","x":<0-100>,"y":<0-100>}
  ]
}`;

// ── 유틸 ────────────────────────────────────────────────────
function parseJSON(text: string): any | null {
  const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    console.error("JSON 블록 없음. 원문:", text.slice(0, 150));
    return null;
  }
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (e) {
    console.error("JSON 파싱 오류:", String(e), "\n원문:", cleaned.slice(start, start + 300));
    return null;
  }
}

function applyBeadThresholds(ba: any): any {
  if (!ba) return ba;
  const fw = (v: string) => {
    const max = v.match(/최대\s*([\d.]+)/), min = v.match(/최소\s*([\d.]+)/);
    if (max && min) { const d = parseFloat(max[1]) - parseFloat(min[1]); return d < 1 ? "양호" : d < 2 ? "주의" : "불량"; }
    const m = v.match(/([\d.]+)/); if (m) { const n = parseFloat(m[1]); return n < 1 ? "양호" : n < 2 ? "주의" : "불량"; }
    return "주의";
  };
  const fs = (v: string) => { const m = v.match(/([\d.]+)/); if (m) { const n = parseFloat(m[1]); return n < 1 ? "양호" : n < 2 ? "주의" : "불량"; } return "주의"; };
  if (ba.width?.value) ba.width.result = fw(ba.width.value);
  if (ba.straightness?.value) ba.straightness.result = fs(ba.straightness.value);
  return ba;
}

function sanitizeLocations(locs: any[]): { name: string; x: number; y: number }[] {
  if (!Array.isArray(locs)) return [];
  return locs
    .map((l: any) => ({
      name: String(l.name ?? ""),
      x: Math.min(100, Math.max(0, parseFloat(String(l.x)) || 50)),
      y: Math.min(100, Math.max(0, parseFloat(String(l.y)) || 50)),
    }))
    .filter(l => l.name.length > 0);
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
    beadAnalysis: { totalScore: s, width: { value: "측정불가", score: s, result: "주의" }, height: { value: "측정불가", score: s, result: "주의" }, straightness: { value: "±1.0mm", score: s, result: "주의" }, pitchUniformity: { value: "측정불가", score: s, result: "주의" } },
    defects: FALLBACK_DEFECTS, defectLocations: [],
    improvements: ["사진을 다시 업로드하여 정확한 분석을 받아보세요."],
    comprehensiveReport: "분석 오류. 사진을 다시 업로드해주세요.",
    top3Defects: [], photoAnalyses: null,
  };
}

// ── 개별 사진 Claude 분석 ────────────────────────────────────
async function analyzePhotoWithClaude(params: {
  base64: string; label: string; process: string; posture: string;
  plateThickness?: string; roboflowLocs: { name: string; x: number; y: number }[];
}): Promise<{ beadAnalysis: any; defects: any[]; defectLocations: { name: string; x: number; y: number }[] }> {
  const rfNote = params.roboflowLocs.length > 0
    ? `\nRoboflow 탐지 결함(참고): ${params.roboflowLocs.map(l => `${l.name}(x:${l.x}%,y:${l.y}%)`).join(", ")}`
    : "";
  const res = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514", max_tokens: 2000, system: PER_PHOTO_PROMPT,
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: params.base64 } },
      { type: "text", text: `${params.label} 사진\n공정:${params.process} / 자세:${params.posture}${params.plateThickness ? ` / 두께:${params.plateThickness}mm` : ""}${rfNote}\n\nJSON만 출력.` },
    ]}],
  });
  const text = res.content[0]?.type === "text" ? res.content[0].text : "";
  const parsed = parseJSON(text);
  if (!parsed) throw new Error("JSON 파싱 실패");
  return {
    beadAnalysis: applyBeadThresholds(parsed.beadAnalysis),
    defects: parsed.defects ?? FALLBACK_DEFECTS,
    defectLocations: params.roboflowLocs.length > 0 ? params.roboflowLocs : sanitizeLocations(parsed.defectLocations ?? []),
  };
}

// ── 메인 라우트 ──────────────────────────────────────────────
export function registerWeldAnalysisRoute(app: Express): void {
  app.post("/api/analyze-weld", largeBodyParser, async (req: Request, res: Response) => {
    const { photos, imageBase64, process, posture, material, selfScore, previousResultsSummary, plateThickness } = req.body;
    const frontPhoto = photos?.front || imageBase64;
    if (!frontPhoto) return res.status(400).json({ error: "정면 사진이 필요합니다." });

    try {
      // 1) 관리자 피드백
      let adminFeedback = "";
      try {
        const fb = await pool.query("SELECT feedback_text FROM admin_feedback ORDER BY created_at DESC LIMIT 20");
        if (fb.rows.length > 0) adminFeedback = `\n\n【관리자 추가 검사기준 - 반드시 적용】\n${fb.rows.map((r: any, i: number) => `${i+1}. ${r.feedback_text}`).join("\n")}`;
      } catch {}

      const proc = process || "FCAW", post = posture || "1G", mat = material || "탄소강 평판";
      const thick = plateThickness || undefined;

      // 2) Roboflow 병렬 탐지
      const [frontRF, sideRF, backRF] = await Promise.all([
        detectWithRoboflow(frontPhoto, "정면"),
        photos?.side ? detectWithRoboflow(photos.side, "측면") : Promise.resolve([]),
        photos?.back ? detectWithRoboflow(photos.back, "이면") : Promise.resolve([]),
      ]);

      const rfSummary = frontRF.length > 0
        ? `\n\n【Roboflow AI 탐지 결함 (참고)】\n${frontRF.map((l: any) => `- ${l.name}: x=${l.x}%, y=${l.y}%`).join("\n")}`
        : "";
      const prevNote = previousResultsSummary
        ? `\n\n【이전 평가 이력 - comprehensiveReport에 반영】\n${previousResultsSummary}`
        : "\n\n【이전 이력】첫 번째 업로드입니다.";

      const userText = `공정:${proc} / 자세:${post} / 소재:${mat} / 자체점수:${selfScore ?? 50}점${thick ? ` / 판재두께:${thick}mm` : ""}${rfSummary}${adminFeedback}${prevNote}\n\n위 용접 사진을 정밀 분석하십시오. 반드시 JSON만 출력하십시오.`;

      const imgContents: any[] = [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: frontPhoto } },
      ];
      if (photos?.side) imgContents.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: photos.side } });
      if (photos?.back)  imgContents.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: photos.back } });
      imgContents.push({ type: "text", text: userText });

      // 3) Claude 메인 + 사진별 분석 병렬
      const [mainRes, sideAnalysis, backAnalysis] = await Promise.all([
        anthropic.messages.create({
          model: "claude-sonnet-4-20250514", max_tokens: 4000, system: SYSTEM_PROMPT,
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
      console.log("━━ Claude 응답 원문 (앞 500자) ━━\n", mainText.slice(0, 500));

      const parsed = parseJSON(mainText);
      if (!parsed) {
        console.error("JSON 파싱 실패. 폴백 반환.");
        return res.json(makeFallback(selfScore ?? 50));
      }

      const beadAnalysis = applyBeadThresholds(parsed.beadAnalysis) ?? {
        totalScore: 50,
        width: { value: "측정불가(추정)", score: 50, result: "주의" },
        height: { value: "측정불가(추정)", score: 50, result: "주의" },
        straightness: { value: "±1.0mm(추정)", score: 50, result: "주의" },
        pitchUniformity: { value: "측정불가(추정)", score: 50, result: "주의" },
      };

      // 4) ★ 결함 위치: Roboflow 우선 → Claude 좌표
      let defectLocations: { name: string; x: number; y: number }[] = [];
      if (frontRF.length > 0) {
        defectLocations = frontRF;
        console.log("✅ Roboflow 좌표 사용:", JSON.stringify(defectLocations));
      } else {
        defectLocations = sanitizeLocations(parsed.defectLocations ?? []);
        if (defectLocations.length > 0) {
          console.log("ℹ️ Claude 좌표 사용:", JSON.stringify(defectLocations));
        } else {
          // Claude가 빈 배열로 줬지만 detected:true 결함이 있으면 경고
          const detectedDefects = (parsed.defects ?? []).filter((d: any) => d.detected);
          if (detectedDefects.length > 0) {
            console.log("⚠️ 결함 탐지됐으나 좌표 없음. 결함 수:", detectedDefects.length);
            // 결함이 있는데 좌표가 없으면 중앙에 표시
            defectLocations = detectedDefects.slice(0, 3).map((d: any, i: number) => ({
              name: d.name, x: 30 + i * 20, y: 50,
            }));
            console.log("📍 중앙 근처에 임시 좌표 배치:", JSON.stringify(defectLocations));
          } else {
            console.log("✅ 결함 없음 - defectLocations 빈 배열 정상");
          }
        }
      }

      const frontAnalysis = { beadAnalysis, defects: parsed.defects ?? FALLBACK_DEFECTS, defectLocations };
      const photoAnalyses: Record<string, any> = { front: frontAnalysis };
      if (sideAnalysis) photoAnalyses.side = sideAnalysis;
      if (backAnalysis)  photoAnalyses.back = backAnalysis;

      const result = {
        aiScore:         Math.min(100, Math.max(0, Math.round(parsed.aiScore ?? 50))),
        overallVerdict:  parsed.overallVerdict === "PASS" ? "PASS" : "FAIL",
        beadAnalysis, defects: parsed.defects ?? FALLBACK_DEFECTS, defectLocations,
        photoAnalyses,
        improvements:    Array.isArray(parsed.improvements) ? parsed.improvements : ["분석 데이터를 확인해주세요."],
        comprehensiveReport: parsed.comprehensiveReport ?? "",
        top3Defects:     Array.isArray(parsed.top3Defects) ? parsed.top3Defects : [],
      };

      console.log(`━━ 분석완료 | 점수:${result.aiScore} | 결함위치:${defectLocations.length}개 | 판정:${result.overallVerdict} ━━`);
      res.json(result);

    } catch (err) {
      console.error("분석 오류:", err);
      res.json(makeFallback(selfScore ?? 50));
    }
  });
}
