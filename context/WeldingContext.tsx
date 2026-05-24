import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useMemo,
  ReactNode,
  useCallback,
} from "react";
import { Platform } from "react-native";
import { getGrade } from "@/constants/colors";
import { getApiUrl } from "@/lib/query-client";

function apiUrl(path: string): string {
  return new URL(path, getApiUrl()).toString();
}

export type WeldProcess =
  | "FCAW"
  | "GTAW"
  | "SAW"
  | "EGW"
  | "오토캐리지용접"
  | "협동로봇 용접"
  | "기타";

export type WeldPosture =
  | "1G" | "2G" | "3G" | "4G" | "5G" | "6G"
  | "1F" | "2F" | "3F" | "4F" | "5F"
  | "기타";

export type WeldMaterial =
  | "탄소강 평판"
  | "탄소강 배관"
  | "스테인리스 평판"
  | "스테인리스강 배관"
  | "기타";

export type WeldBeadType = "위빙 비드" | "스트레이트 비드";
export type WeldPassType = "싱글 패스" | "멀티 패스";

export interface DefectItem {
  name: string;
  detected: boolean;
  severity: "없음" | "경미" | "보통" | "심각";
  confidence: number;
  standard: "선급" | "AWS" | "ASME";
  measured: string;
  limit: string;
  result: "합격" | "불합격" | "경고";
}

export interface BeadMetric {
  value: string;
  score: number;
}

export interface BeadAnalysis {
  totalScore: number;
  width: BeadMetric;
  straightness: BeadMetric;
  height?: BeadMetric | null;
}

export interface FilletConvexity {
  type: string;
  value_mm: number;
}

export interface FilletUnequalLeg {
  z1: number | null;
  z2: number | null;
  isUnequal: boolean;
  difference?: number;
}

export interface FilletAnalysis {
  beadWidth: number;
  equalLeg: number;
  theoreticalThroat: number;
  actualThroat: number;
  unequalLeg: FilletUnequalLeg;
  convexity: FilletConvexity;
  note?: string;
}

export interface DefectLocation {
  name: string;
  x: number;
  y: number;
}

export interface StraightnessLine {
  start_x_pct: number;
  start_y_pct: number;
  end_x_pct: number;
  end_y_pct: number;
  worst_x_pct: number;
  worst_y_pct: number;
  deviation_mm: number;
  is_curve?: boolean;
  curve_points_pct?: Array<{ x_pct: number; y_pct: number }>;
}

export interface PerPhotoAnalysis {
  beadAnalysis: BeadAnalysis | null;
  defects: DefectItem[];
  defectLocations: DefectLocation[];
  straightnessLines?: StraightnessLine[];
  /**
   * 사진은 업로드됐지만 비드/결함을 식별 못 했을 때 "no_bead_detected".
   * 정상 분석 시 undefined.
   */
  analysisStatus?: "no_bead_detected";
}

export interface WeldingResult {
  id: string;
  userId: string;
  userName: string;
  userProfileUri?: string;
  userCourseName?: string;
  photoUri: string;
  photos?: { front: string; side?: string; back?: string };
  process: WeldProcess;
  processCustom?: string;
  posture: WeldPosture;
  postureCustom?: string;
  material: WeldMaterial;
  materialCustom?: string;
  beadType?: WeldBeadType;
  passType?: WeldPassType;
  selfScore: number;
  aiScore: number;
  grade: string;
  timestamp: number;
  beadAnalysis: BeadAnalysis;
  defects: DefectItem[];
  defectLocations?: DefectLocation[];
  photoAnalyses?: {
    front?: PerPhotoAnalysis;
    side?: PerPhotoAnalysis;
    back?: PerPhotoAnalysis;
  };
  improvements: string[];
  comprehensiveReport?: string;
  overallVerdict: "PASS" | "FAIL";
  top3Defects: string[];
  trendScores: number[];
  filletAnalysis?: FilletAnalysis | null;
}

interface WeldingContextValue {
  results: WeldingResult[];
  isLoading: boolean;
  addResult: (result: WeldingResult) => Promise<void>;
  updatePhotos: (id: string, photoUri: string, photos: WeldingResult["photos"]) => Promise<void>;
  deleteResult: (id: string) => Promise<void>;
  getResultById: (id: string) => WeldingResult | undefined;
  getUserResults: (userId: string) => WeldingResult[];
  refreshResults: () => Promise<void>;
  migrateLocalFileUris: (userId: string) => Promise<void>;
}

const WeldingContext = createContext<WeldingContextValue | null>(null);


function simulateAiAnalysis(selfScore: number, photoUri: string): Omit<WeldingResult, "id" | "userId" | "userName" | "photoUri" | "process" | "processCustom" | "posture" | "postureCustom" | "material" | "materialCustom" | "selfScore" | "timestamp" | "userProfileUri"> {
  const seed = photoUri.length + selfScore;
  const rand = (min: number, max: number, offset = 0) => {
    const x = Math.sin(seed + offset) * 10000;
    return Math.floor((x - Math.floor(x)) * (max - min + 1)) + min;
  };

  const aiScore = Math.max(30, Math.min(100, selfScore + rand(-15, 15, 1)));

  const beadTotal = rand(50, 95, 2);
  const beadAnalysis: BeadAnalysis = {
    totalScore: beadTotal,
    width: {
      value: `${(rand(5, 25, 3) * 0.1).toFixed(1)}mm 편차`,
      score: rand(60, 100, 4),
    },
    straightness: {
      value: `${(rand(2, 20, 9) * 0.1).toFixed(1)}mm 이탈`,
      score: rand(55, 100, 10),
    },
    height: null,
  };

  const standards: ("선급" | "AWS" | "ASME")[] = ["선급", "AWS", "ASME"];
  const defectNames = [
    "언더컷", "오버랩", "기공", "크랙", "스패터",
    "아크스트라이크", "용착불량", "용입불량", "용락",
  ];

  const defects: DefectItem[] = defectNames.map((name, i) => {
    const detected = rand(0, 3, 20 + i) === 0;
    const severity = detected
      ? (["경미", "보통", "심각"] as const)[rand(0, 2, 30 + i)]
      : "없음";
    const result = !detected
      ? "합격"
      : severity === "심각"
      ? "불합격"
      : severity === "보통"
      ? "경고"
      : "합격";

    return {
      name,
      detected,
      severity,
      confidence: rand(70, 99, 40 + i),
      standard: standards[rand(0, 2, 50 + i)],
      measured: detected ? `${rand(1, 5, 60 + i) * 0.1}mm` : "0mm",
      limit: `${rand(1, 3, 70 + i) * 0.1}mm`,
      result,
    };
  });

  const top3Defects = defects
    .filter((d) => d.detected)
    .sort((a, b) => {
      const sev = { 없음: 0, 경미: 1, 보통: 2, 심각: 3 };
      return sev[b.severity] - sev[a.severity];
    })
    .slice(0, 3)
    .map((d) => d.name);

  const hasFailure = defects.some((d) => d.result === "불합격") || aiScore < 60;
  const overallVerdict: "PASS" | "FAIL" = hasFailure ? "FAIL" : "PASS";

  const improvements = [
    aiScore < 70 ? "용접 속도를 일정하게 유지하여 비드 균일성을 개선하세요." : null,
    defects.find((d) => d.name === "언더컷" && d.detected) ? "전류를 낮추거나 용접 속도를 줄여 언더컷 발생을 방지하세요." : null,
    defects.find((d) => d.name === "기공" && d.detected) ? "용접봉 건조 상태 및 모재 청결도를 확인하세요." : null,
    defects.find((d) => d.name === "스패터" && d.detected) ? "아크 길이와 전류 설정을 최적화하세요." : null,
    beadAnalysis.straightness.score < 70 ? "가이드 레일 또는 자동화 장치 활용으로 직진도를 개선하세요." : null,
    beadAnalysis.width.score < 70 ? "위빙 폭을 일정하게 유지하는 연습이 필요합니다." : null,
    "정기적인 기량 인증 시험을 통해 기술 수준을 객관적으로 평가하세요.",
  ].filter(Boolean) as string[];

  const trendCount = rand(3, 8, 99);
  const trendScores = Array.from({ length: trendCount }, (_, i) =>
    Math.max(30, Math.min(100, aiScore + rand(-20, 20, 100 + i)))
  );
  trendScores.push(aiScore);

  return {
    aiScore,
    grade: getGrade(aiScore),
    beadAnalysis,
    defects,
    improvements,
    overallVerdict,
    top3Defects,
    trendScores,
  };
}

export function WeldingProvider({ children }: { children: ReactNode }) {
  const [results, setResults] = useState<WeldingResult[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadResults();
  }, []);

  const loadResults = async () => {
    try {
      const res = await fetch(apiUrl("/api/results"));
      if (res.ok) {
        const data: WeldingResult[] = await res.json();
        setResults(data.sort((a, b) => b.timestamp - a.timestamp));
      }
    } catch (err) {
      console.error("loadResults error:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const addResult = useCallback(async (result: WeldingResult) => {
    // 로컬 상태 즉시 반영 (UX용)
    setResults(prev => [result, ...prev].sort((a, b) => b.timestamp - a.timestamp));
    try {
      const res = await fetch(apiUrl("/api/results"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        console.warn(`[addResult] DB 저장 실패 ${res.status}: ${errText.slice(0, 100)}`);
      }
    } catch (err) {
      console.warn("[addResult] 네트워크 오류 (로컬만 저장됨):", err);
    }
  }, []);

  const updatePhotos = useCallback(async (id: string, photoUri: string, photos: WeldingResult["photos"]) => {
    try {
      await fetch(apiUrl(`/api/results/${id}/photos`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ photoUri, photos }),
      });
      setResults(prev => prev.map(r => r.id === id ? { ...r, photoUri, photos } : r));
    } catch (err) {
      console.error("updatePhotos error:", err);
    }
  }, []);

  const deleteResult = useCallback(async (id: string) => {
    try {
      await fetch(apiUrl(`/api/results/${id}`), { method: "DELETE" });
      setResults(prev => prev.filter(r => r.id !== id));
    } catch (err) {
      console.error("deleteResult error:", err);
    }
  }, []);

  const getResultById = useCallback(
    (id: string) => results.find((r) => r.id === id),
    [results]
  );

  const getUserResults = useCallback(
    (userId: string) => results.filter((r) => r.userId === userId),
    [results]
  );

  const migrateLocalFileUris = useCallback(async (userId: string) => {
    if (Platform.OS === "web") return;
    const userResults = results.filter(
      (r) => r.userId === userId &&
        ((r.photoUri && r.photoUri.startsWith("file://")) ||
         (r.photos?.front && r.photos.front.startsWith("file://")))
    );
    if (userResults.length === 0) return;

    const FileSystem = require("expo-file-system/legacy");

    for (const result of userResults) {
      try {
        const uploadSlot = async (uri: string | undefined, label: string): Promise<string | undefined> => {
          if (!uri?.startsWith("file://")) return uri;
          const info = await FileSystem.getInfoAsync(uri);
          if (!info.exists) return undefined;
          const base64 = await FileSystem.readAsStringAsync(uri, {
            encoding: FileSystem.EncodingType.Base64,
          });
          const ts = Date.now();
          const uploadRes = await fetch(apiUrl("/api/upload-photo"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ base64, fileName: `${userId}_${ts}_${label}.jpg` }),
          });
          if (!uploadRes.ok) return undefined;
          const { url } = await uploadRes.json();
          return url as string;
        };

        const newFront = await uploadSlot(result.photos?.front ?? result.photoUri, "front");
        const newSide = await uploadSlot(result.photos?.side, "side");
        const newBack = await uploadSlot(result.photos?.back, "back");

        if (!newFront) continue;

        const newPhotos = {
          front: newFront,
          side: newSide ?? result.photos?.side,
          back: newBack ?? result.photos?.back,
        };

        const updateRes = await fetch(apiUrl(`/api/results/${result.id}/photos`), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ photoUri: newFront, photos: newPhotos }),
        });

        if (updateRes.ok) {
          setResults((prev) =>
            prev.map((r) =>
              r.id === result.id
                ? { ...r, photoUri: newFront, photos: newPhotos }
                : r
            )
          );
          console.log(`사진 마이그레이션 완료: ${result.id}`);
        }
      } catch (e) {
        console.warn("사진 마이그레이션 실패:", result.id, e);
      }
    }
  }, [results]);

  const value = useMemo(
    () => ({ results, isLoading, addResult, updatePhotos, deleteResult, getResultById, getUserResults, refreshResults: loadResults, migrateLocalFileUris }),
    [results, isLoading, addResult, updatePhotos, deleteResult, getResultById, getUserResults, migrateLocalFileUris]
  );

  return (
    <WeldingContext.Provider value={value}>{children}</WeldingContext.Provider>
  );
}

export function useWelding() {
  const ctx = useContext(WeldingContext);
  if (!ctx) throw new Error("useWelding must be used within WeldingProvider");
  return ctx;
}

export { simulateAiAnalysis };
