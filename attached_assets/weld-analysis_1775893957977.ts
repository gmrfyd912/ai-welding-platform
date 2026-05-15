// ============================================================
// server/weld-analysis.ts
// GPT-4o → Claude API 교체 + Roboflow 결함 위치 탐지 연동
// ============================================================

import Anthropic from "@anthropic-ai/sdk";
import type { Express, Request, Response } from "express";
import express from "express";
import pool from "./db";

// ── Claude 클라이언트 초기화 ──────────────────────────────────
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY, // Replit Secrets에 추가 필요
});

const largeBodyParser = express.json({ limit: "30mb" });

// ============================================================
// ROBOFLOW 설정
// Universe 공개 용접 결함 모델 사용 (무료)
// 모델: "weld-defect-detection" 또는 직접 학습한 모델
// ============================================================
const ROBOFLOW_API_KEY = process.env.ROBOFLOW_API_KEY ?? ""; // Replit Secrets에 추가
const ROBOFLOW_MODEL_ID = process.env.ROBOFLOW_MODEL_ID ?? "weld-defect/3"; // 공개 모델 ID
const ROBOFLOW_API_URL = `https://detect.roboflow.com/${ROBOFLOW_MODEL_ID}`;

// ── Roboflow 결함 위치 탐지 ──────────────────────────────────
interface RoboflowPrediction {
  x: number;       // 중심 x (픽셀)
  y: number;       // 중심 y (픽셀)
  width: number;   // 바운딩박스 너비 (픽셀)
  height: number;  // 바운딩박스 높이 (픽셀)
  confidence: number; // 0~1
  class: string;   // 결함 클래스명
}

interface RoboflowResponse {
  predictions: RoboflowPrediction[];
  image: { width: number; height: number };
}

// Roboflow 결함명 → 한글 매핑
const ROBOFLOW_CLASS_MAP: Record<string, string> = {
  "crack": "균열 (Crack)",
  "porosity": "기공 (Porosity)",
  "undercut": "언더컷 (Undercut)",
  "overlap": "오버랩 (Overlap)",
  "spatter": "스패터 (Spatter)",
  "arc_strike": "아크 스트라이크 (Arc Strike)",
  "incomplete_fusion": "용착불량",
  "incomplete_penetration": "용입불량",
  "burn_through": "용락",
  // 모델에 따라 추가
};

async function detectDefectsWithRoboflow(
  base64Image: string,
  photoLabel: string
): Promise<{ locations: { name: string; x: number; y: number }[]; rawPredictions: RoboflowPrediction[] }> {
  if (!ROBOFLOW_API_KEY) {
    console.warn("ROBOFLOW_API_KEY 없음 → Roboflow 탐지 건너뜀");
    return { locations: [], rawPredictions: [] };
  }

  try {
    const response = await fetch(
      `${ROBOFLOW_API_URL}?api_key=${ROBOFLOW_API_KEY}&confidence=30&overlap=50`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: base64Image,
      }
    );

    if (!response.ok) {
      console.error(`Roboflow API 오류 [${photoLabel}]:`, response.status);
      return { locations: [], rawPredictions: [] };
    }

    const data: RoboflowResponse = await response.json();
    const imgW = data.image?.width || 1;
    const imgH = data.image?.height || 1;

    console.log(`[Roboflow ${photoLabel}] 탐지 결함 수: ${data.predictions?.length ?? 0}`);

    // 픽셀 좌표 → 퍼센트 좌표 변환 (앱 히트맵 표시용)
    const locations = (data.predictions ?? [])
      .filter((p) => p.confidence >= 0.3)
      .map((p) => ({
        name: ROBOFLOW_CLASS_MAP[p.class?.toLowerCase()] ?? p.class,
        x: Math.round((p.x / imgW) * 100),
        y: Math.round((p.y / imgH) * 100),
        confidence: Math.round(p.confidence * 100),
      }));

    return { locations, rawPredictions: data.predictions ?? [] };
  } catch (err) {
    console.error(`Roboflow 호출 실패 [${photoLabel}]:`, err);
    return { locations: [], rawPredictions: [] };
  }
}

// ============================================================
// Claude 분석 프롬프트
// ============================================================

const DEFECT_CRITERIA = `【6대 결함 판단 기준 - 선급 검사 기준 적용】
1. 균열 (Crack): 비드 표면/모재 경계선(Toe)의 선형 갈라짐 → 불허
2. 기공 (Porosity): 비드 표면의 둥근 구멍(바늘자국, 기포) → 불허
3. 언더컷 (Undercut): 비드 가장자리(Toe) 모재가 파인 홈 → 0.5mm 이하 허용
4. 오버랩 (Overlap): 용접금속이 모재 위로 흘러넘침 → 불허
5. 스패터 (Spatter): 비드 주변 금속 방울 → 경미 허용
6. 아크 스트라이크 (Arc Strike): 비드 밖 모재의 긁힘/녹은 자국 → 불허`;

const BEAD_CRITERIA = `【비드 형상 평가 기준】
- 비드 폭 편차: <1mm → 양호 / 1~2mm → 주의 / >2mm → 불량
- 비드 높이: <2mm → 양호 / 2~3mm → 주의 / >3mm → 불량
- 직진도: <1mm → 양호 / 1~2mm → 주의 / >2mm → 불량
- 피치 균일도: 일정 → 양호 / 2회 불일정 → 주의 / 3회+ → 불량`;

const SYSTEM_PROMPT = `당신은 20년 경력의 국제공인 용접검사관(CWI) 수준의 AI 비전 분석 전문가입니다.
제공된 용접 비드 사진을 정밀 육안 검사하여 결함을 찾아내고, 비드 형상을 정량적으로 평가하십시오.

【중요 지시사항】
- Roboflow AI가 이미 결함 위치(x,y 좌표)를 탐지했습니다
- 당신은 탐지된 결함의 종류 확정, 심각도 평가, 점수 산출, 개선사항 작성에 집중하십시오
- 측정자(자)가 있으면 mm 눈금으로 정확히 측정, 없으면 "(추정)" 표기

${BEAD_CRITERIA}

${DEFECT_CRITERIA}

【응답 형식 - 반드시 유효한 JSON만 출력, 다른 텍스트 금지】
{
  "aiScore": <0-100 정수, 70이상=PASS>,
  "overallVerdict": "PASS" | "FAIL",
  "beadAnalysis": {
    "totalScore": <0-100>,
    "width":          {"value":"<최대Xmm/최소Xmm(추정)>","score":<0-100>,"result":"양호|주의|불량"},
    "height":         {"value":"<Xmm(추정)>",            "score":<0-100>,"result":"양호|주의|불량"},
    "straightness":   {"value":"<±Xmm(추정)>",           "score":<0-100>,"result":"양호|주의|불량"},
    "pitchUniformity":{"value":"<Xmm(추정)>",            "score":<0-100>,"result":"양호|주의|불량"}
  },
  "defects": [
    {"name":"균열 (Crack)",            "detected":<bool>,"severity":"없음|경미|보통|심각","confidence":<0-100>,"standard":"선급","measured":"<관찰값>","limit":"불허",       "result":"합격|불합격|경고"},
    {"name":"기공 (Porosity)",          "detected":<bool>,"severity":"없음|경미|보통|심각","confidence":<0-100>,"standard":"선급","measured":"<관찰값>","limit":"불허",       "result":"합격|불합격|경고"},
    {"name":"언더컷 (Undercut)",        "detected":<bool>,"severity":"없음|경미|보통|심각","confidence":<0-100>,"standard":"선급","measured":"<관찰값>","limit":"0.5mm",      "result":"합격|불합격|경고"},
    {"name":"오버랩 (Overlap)",         "detected":<bool>,"severity":"없음|경미|보통|심각","confidence":<0-100>,"standard":"선급","measured":"<관찰값>","limit":"불허",       "result":"합격|불합격|경고"},
    {"name":"스패터 (Spatter)",         "detected":<bool>,"severity":"없음|경미|보통|심각","confidence":<0-100>,"standard":"선급","measured":"<관찰값>","limit":"경미허용",   "result":"합격|불합격|경고"},
    {"name":"아크 스트라이크 (Arc Strike)","detected":<bool>,"severity":"없음|경미|보통|심각","confidence":<0-100>,"standard":"선급","measured":"<관찰값>","limit":"불허",   "result":"합격|불합격|경고"}
  ],
  "improvements": ["<핵심 개선사항>","<훈련 가이드>","<추가 조언>"],
  "comprehensiveReport": "<강점/약점/기량추이 종합 분석, 200자 이상>",
  "top3Defects": ["<가장심각한결함명>"]
}`;

const PER_PHOTO_SYSTEM_PROMPT = `당신은 용접검사관 AI입니다. 단일 용접 사진을 분석하여 비드 형상을 정밀 평가하십시오.
Roboflow가 결함 위치를 이미 탐지했으므로, 당신은 비드 품질 평가에 집중하십시오.

${BEAD_CRITERIA}
${DEFECT_CRITERIA}

【응답 형식 - 반드시 유효한 JSON만 출력】
{
  "beadAnalysis": {
    "totalScore": <0-100>,
    "width":          {"value":"...","score":<0-100>,"result":"양호|주의|불량"},
    "height":         {"value":"...","score":<0-100>,"result":"양호|주의|불량"},
    "straightness":   {"value":"...","score":<0-100>,"result":"양호|주의|불량"},
    "pitchUniformity":{"value":"...","score":<0-100>,"result":"양호|주의|불량"}
  },
  "defects": [
    {"name":"균열 (Crack)",            "detected":<bool>,"severity":"없음|경미|보통|심각","confidence":<0-100>,"standard":"선급","measured":"<관찰값>","limit":"불허",     "result":"합격|불합격|경고"},
    {"name":"기공 (Porosity)",          "detected":<bool>,"severity":"없음|경미|보통|심각","confidence":<0-100>,"standard":"선급","measured":"<관찰값>","limit":"불허",     "result":"합격|불합격|경고"},
    {"name":"언더컷 (Undercut)",        "detected":<bool>,"severity":"없음|경미|보통|심각","confidence":<0-100>,"standard":"선급","measured":"<관찰값>","limit":"0.5mm",    "result":"합격|불합격|경고"},
    {"name":"오버랩 (Overlap)",         "detected":<bool>,"severity":"없음|경미|보통|심각","confidence":<0-100>,"standard":"선급","measured":"<관찰값>","limit":"불허",     "result":"합격|불합격|경고"},
    {"name":"스패터 (Spatter)",         "detected":<bool>,"severity":"없음|경미|보통|심각","confidence":<0-100>,"standard":"선급","measured":"<관찰값>","limit":"경미허용", "result":"합격|불합격|경고"},
    {"name":"아크 스트라이크 (Arc Strike)","detected":<bool>,"severity":"없음|경미|보통|심각","confidence":<0-100>,"standard":"선급","measured":"<관찰값>","limit":"불허", "result":"합격|불합격|경고"}
  ]
}`;

// ── 유틸 함수들 ──────────────────────────────────────────────

function applyBeadWidthThreshold(value: string): "양호" | "주의" | "불량" {
  const maxMatch = value.match(/최대\s*([\d.]+)/);
  const minMatch = value.match(/최소\s*([\d.]+)/);
  if (maxMatch && minMatch) {
    const diff = parseFloat(maxMatch[1]) - parseFloat(minMatch[1]);
    if (diff < 1) return "양호";
    if (diff < 2) return "주의";
    return "불량";
  }
  const m = value.match(/([\d.]+)\s*mm/);
  if (m) {
    const v = parseFloat(m[1]);
    if (v < 1) return "양호";
    if (v < 2) return "주의";
    return "불량";
  }
  return "주의";
}

function applyStraightnessThreshold(value: string): "양호" | "주의" | "불량" {
  const m = value.match(/[±+]?\s*([\d.]+)/);
  if (m) {
    const d = parseFloat(m[1]);
    if (d < 1) return "양호";
    if (d < 2) return "주의";
    return "불량";
  }
  return "주의";
}

const FALLBACK_DEFECTS = [
  { name: "균열 (Crack)",             detected: false, severity: "없음", confidence: 70, standard: "선급", measured: "없음", limit: "불허",     result: "합격" },
  { name: "기공 (Porosity)",           detected: false, severity: "없음", confidence: 70, standard: "선급", measured: "없음", limit: "불허",     result: "합격" },
  { name: "언더컷 (Undercut)",         detected: false, severity: "없음", confidence: 70, standard: "선급", measured: "없음", limit: "0.5mm",    result: "합격" },
  { name: "오버랩 (Overlap)",          detected: false, severity: "없음", confidence: 70, standard: "선급", measured: "없음", limit: "불허",     result: "합격" },
  { name: "스패터 (Spatter)",          detected: false, severity: "없음", confidence: 70, standard: "선급", measured: "없음", limit: "경미허용", result: "합격" },
  { name: "아크 스트라이크 (Arc Strike)", detected: false, severity: "없음", confidence: 70, standard: "선급", measured: "없음", limit: "불허",  result: "합격" },
];

function buildFallbackResult(selfScore: number) {
  const base = Math.min(100, Math.max(0, Math.round(selfScore * 0.85 + 10)));
  return {
    aiScore: base,
    overallVerdict: base >= 70 ? "PASS" : "FAIL",
    beadAnalysis: {
      totalScore: base,
      width:          { value: "측정 불가(추정)", score: base, result: "주의" },
      height:         { value: "측정 불가(추정)", score: base, result: "주의" },
      straightness:   { value: "±1.0mm(추정)",   score: base, result: "주의" },
      pitchUniformity:{ value: "측정 불가(추정)", score: base, result: "주의" },
    },
    defects: FALLBACK_DEFECTS,
    defectLocations: [],
    improvements: ["사진을 다시 업로드하여 더 정확한 AI 분석을 받아보세요."],
    comprehensiveReport: "분석 중 오류가 발생했습니다. 사진을 다시 업로드하여 분석을 받아보세요.",
    top3Defects: [],
    photoAnalyses: null,
  };
}

// ── Claude API 호출: 사진 1장 분석 ──────────────────────────

interface PerPhotoAnalysis {
  beadAnalysis: {
    totalScore: number;
    width:          { value: string; score: number; result: string };
    height:         { value: string; score: number; result: string };
    straightness:   { value: string; score: number; result: string };
    pitchUniformity:{ value: string; score: number; result: string };
  };
  defects: any[];
  defectLocations: { name: string; x: number; y: number }[];
}

async function analyzePhotoWithClaude(params: {
  photoBase64: string;
  photoLabel: string;
  process: string;
  posture: string;
  plateThickness?: string;
  roboflowLocations: { name: string; x: number; y: number }[];
}): Promise<PerPhotoAnalysis> {
  const roboflowInfo =
    params.roboflowLocations.length > 0
      ? `\n【Roboflow 탐지 결과 - 아래 결함들이 이미지에서 탐지됨】\n` +
        params.roboflowLocations.map((l) => `- ${l.name} (위치: x=${l.x}%, y=${l.y}%)`).join("\n")
      : "\n【Roboflow 탐지 결과】 결함 미탐지 (또는 API 미연결)";

  const userText =
    `【분석 대상】${params.photoLabel} 사진\n` +
    `【용접 정보】공정:${params.process} / 자세:${params.posture}` +
    (params.plateThickness ? ` / 부재두께:${params.plateThickness}mm` : "") +
    roboflowInfo +
    `\n\n이 사진의 비드 형상과 결함을 정밀 평가하십시오. 반드시 JSON만 응답하십시오.`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    system: PER_PHOTO_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: params.photoBase64,
            },
          },
          { type: "text", text: userText },
        ],
      },
    ],
  });

  const content = response.content[0]?.type === "text" ? response.content[0].text : "";
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("JSON 추출 실패");

  const parsed = JSON.parse(jsonMatch[0]);

  const widthRaw       = parsed.beadAnalysis?.width          ?? { value: "측정불가(추정)", score: 50, result: "주의" };
  const straightnessRaw= parsed.beadAnalysis?.straightness   ?? { value: "±1.0mm(추정)",   score: 50, result: "주의" };
  widthRaw.result        = applyBeadWidthThreshold(widthRaw.value);
  straightnessRaw.result = applyStraightnessThreshold(straightnessRaw.value);

  return {
    beadAnalysis: {
      totalScore:      Math.min(100, Math.max(0, Math.round(parsed.beadAnalysis?.totalScore ?? 50))),
      width:           widthRaw,
      height:          parsed.beadAnalysis?.height          ?? { value: "측정불가(추정)", score: 50, result: "주의" },
      straightness:    straightnessRaw,
      pitchUniformity: parsed.beadAnalysis?.pitchUniformity ?? { value: "측정불가(추정)", score: 50, result: "주의" },
    },
    defects: parsed.defects ?? FALLBACK_DEFECTS,
    // Roboflow 좌표 우선 사용 (더 정확), 없으면 빈 배열
    defectLocations: params.roboflowLocations,
  };
}

// ── 메인 분석 라우트 등록 ────────────────────────────────────

export function registerWeldAnalysisRoute(app: Express): void {
  app.post("/api/analyze-weld", largeBodyParser, async (req: Request, res: Response) => {
    const { photos, imageBase64, process, posture, material, selfScore, previousResultsSummary, plateThickness } = req.body;

    const frontPhoto = photos?.front || imageBase64;
    if (!frontPhoto) return res.status(400).json({ error: "정면 사진(front)이 필요합니다." });

    try {
      // 1) 관리자 피드백 로드
      let adminFeedback: string | undefined;
      try {
        const fbRows = await pool.query(
          "SELECT feedback_text FROM admin_feedback ORDER BY created_at DESC LIMIT 30"
        );
        if (fbRows.rows.length > 0) {
          adminFeedback = fbRows.rows
            .map((r: any, i: number) => `${i + 1}. ${r.feedback_text}`)
            .join("\n");
        }
      } catch {}

      const procStr = process || "FCAW";
      const postStr = posture  || "1G";
      const matStr  = material || "탄소강 평판";
      const thick   = plateThickness || undefined;

      // 2) Roboflow + Claude 병렬 실행
      const [
        frontRoboflow,
        sideRoboflow,
        backRoboflow,
      ] = await Promise.all([
        detectDefectsWithRoboflow(frontPhoto,      "정면"),
        photos?.side ? detectDefectsWithRoboflow(photos.side, "측면") : Promise.resolve({ locations: [], rawPredictions: [] }),
        photos?.back ? detectDefectsWithRoboflow(photos.back, "이면") : Promise.resolve({ locations: [], rawPredictions: [] }),
      ]);

      // 3) Roboflow 결과를 Claude 프롬프트에 주입해서 분석
      const roboflowSummary =
        frontRoboflow.locations.length > 0
          ? `\n【Roboflow 자동탐지 결함 목록】\n` +
            frontRoboflow.locations.map((l) => `- ${l.name} (x:${l.x}%, y:${l.y}%)`).join("\n")
          : "\n【Roboflow 탐지 결과】결함 미탐지 또는 API 미연결";

      const adminNote = adminFeedback
        ? `\n\n【관리자 추가 검사기준 - 반드시 적용】\n${adminFeedback}`
        : "";

      const prevNote = previousResultsSummary
        ? `\n\n【이전 이력 (comprehensiveReport에 반영)】\n${previousResultsSummary}`
        : "\n\n【이전 이력】첫 번째 업로드입니다.";

      const userText =
        `【용접 정보】공정:${procStr} / 자세:${postStr} / 소재:${matStr} / 자체점수:${selfScore ?? 50}점` +
        (thick ? ` / 부재두께:${thick}mm` : "") +
        roboflowSummary +
        adminNote +
        prevNote +
        `\n\n위 용접 사진을 정밀 분석하십시오. 반드시 JSON만 응답하십시오.`;

      // 이미지 콘텐츠 구성 (정면 1장만, Claude는 고해상도 1장으로 충분)
      const imageContents: any[] = [
        {
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: frontPhoto },
        },
      ];
      if (photos?.side) {
        imageContents.push({
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: photos.side },
        });
      }
      if (photos?.back) {
        imageContents.push({
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: photos.back },
        });
      }
      imageContents.push({ type: "text", text: userText });

      // 4) Claude 메인 분석 + 개별 사진 분석 병렬
      const [mainResponse, sideAnalysis, backAnalysis] = await Promise.all([
        anthropic.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4000,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: imageContents }],
        }),
        photos?.side
          ? analyzePhotoWithClaude({
              photoBase64: photos.side,
              photoLabel: "측면",
              process: procStr, posture: postStr, plateThickness: thick,
              roboflowLocations: sideRoboflow.locations,
            }).catch((e) => { console.error("측면 분석 오류:", e); return null; })
          : null,
        photos?.back
          ? analyzePhotoWithClaude({
              photoBase64: photos.back,
              photoLabel: "이면",
              process: procStr, posture: postStr,
              roboflowLocations: backRoboflow.locations,
            }).catch((e) => { console.error("이면 분석 오류:", e); return null; })
          : null,
      ]);

      // 5) 메인 응답 파싱
      const content = mainResponse.content[0]?.type === "text" ? mainResponse.content[0].text : "";
      console.log("Claude 응답 (앞 500자):", content.slice(0, 500));

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.error("Claude 응답 JSON 추출 실패:", content.slice(0, 200));
        return res.json(buildFallbackResult(selfScore ?? 50));
      }

      const parsed = JSON.parse(jsonMatch[0]);

      const widthRaw        = parsed.beadAnalysis?.width          ?? { value: "측정불가(추정)", score: 50, result: "주의" };
      const straightnessRaw = parsed.beadAnalysis?.straightness   ?? { value: "±1.0mm(추정)",   score: 50, result: "주의" };
      widthRaw.result        = applyBeadWidthThreshold(widthRaw.value);
      straightnessRaw.result = applyStraightnessThreshold(straightnessRaw.value);

      // 6) 정면 분석 결과 구성 (Roboflow 좌표 우선 적용)
      const frontAnalysis: PerPhotoAnalysis = {
        beadAnalysis: {
          totalScore:      Math.min(100, Math.max(0, Math.round(parsed.beadAnalysis?.totalScore ?? 50))),
          width:           widthRaw,
          height:          parsed.beadAnalysis?.height          ?? { value: "측정불가(추정)", score: 50, result: "주의" },
          straightness:    straightnessRaw,
          pitchUniformity: parsed.beadAnalysis?.pitchUniformity ?? { value: "측정불가(추정)", score: 50, result: "주의" },
        },
        defects: parsed.defects ?? FALLBACK_DEFECTS,
        // ★ Roboflow 좌표 사용 (기존 GPT 추정 좌표보다 훨씬 정확)
        defectLocations: frontRoboflow.locations,
      };

      const photoAnalyses: Record<string, PerPhotoAnalysis> = { front: frontAnalysis };
      if (sideAnalysis) photoAnalyses.side = sideAnalysis;
      if (backAnalysis)  photoAnalyses.back = backAnalysis;

      const result = {
        aiScore:         Math.min(100, Math.max(0, Math.round(parsed.aiScore ?? 50))),
        overallVerdict:  parsed.overallVerdict === "PASS" ? "PASS" : "FAIL",
        beadAnalysis:    frontAnalysis.beadAnalysis,
        defects:         frontAnalysis.defects,
        defectLocations: frontRoboflow.locations,   // ★ Roboflow 정확 좌표
        photoAnalyses,
        improvements:    Array.isArray(parsed.improvements) ? parsed.improvements : ["분석 데이터를 확인해주세요."],
        comprehensiveReport: parsed.comprehensiveReport ?? "",
        top3Defects:     Array.isArray(parsed.top3Defects) ? parsed.top3Defects : [],
      };

      console.log("✅ 분석 완료 | 점수:", result.aiScore, "| 결함위치수:", frontRoboflow.locations.length);
      res.json(result);

    } catch (err) {
      console.error("용접 AI 분석 오류:", err);
      res.json(buildFallbackResult(selfScore ?? 50));
    }
  });
}
