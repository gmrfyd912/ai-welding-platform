import React, { useState, useMemo, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Image,
  Dimensions,
  Platform,
  Alert,
  Modal,
  TextInput,
  ActivityIndicator,
} from "react-native";
import { KeyboardAwareScrollView, KeyboardAvoidingView } from "react-native-keyboard-controller";
import { Image as ExpoImage } from "expo-image";
import { GestureDetector, Gesture } from "react-native-gesture-handler";
import Animated, { useSharedValue, useAnimatedStyle, withSpring, runOnJS } from "react-native-reanimated";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import Svg, { Polyline, Line, Circle, Text as SvgText } from "react-native-svg";
import Colors, { getGrade, getGradeColor } from "@/constants/colors";
import { useWelding, DefectItem, PerPhotoAnalysis } from "@/context/WeldingContext";
import { useAuth } from "@/context/AuthContext";
import { useLanguage } from "@/context/LanguageContext";
import CommentsSection from "@/components/CommentsSection";

const { width: SCREEN_W } = Dimensions.get("window");
const CHART_W = SCREEN_W - 64;
const CHART_H = 140;

const CHART_PAD_X = 22;
const CHART_PAD_Y = 20;

function TrendChart({ scores }: { scores: number[] }) {
  if (scores.length < 2) return null;

  const min = Math.max(0, Math.min(...scores) - 10);
  const max = Math.min(100, Math.max(...scores) + 10);
  const range = max - min || 1;

  const plotW = CHART_W - CHART_PAD_X * 2;

  const points = scores.map((s, i) => {
    const x = CHART_PAD_X + (i / (scores.length - 1)) * plotW;
    const y = CHART_PAD_Y + CHART_H - ((s - min) / range) * CHART_H;
    return { x, y, score: s };
  });

  const polylinePoints = points.map((p) => `${p.x},${p.y}`).join(" ");
  const svgH = CHART_H + CHART_PAD_Y + 20;
  const baselineY = CHART_PAD_Y + CHART_H;

  return (
    <View style={chartStyles.container}>
      <Svg width={CHART_W} height={svgH}>
        <Line x1={CHART_PAD_X} y1={baselineY} x2={CHART_W - CHART_PAD_X} y2={baselineY} stroke={Colors.border} strokeWidth="1" />
        <Polyline
          points={polylinePoints}
          fill="none"
          stroke={Colors.primary}
          strokeWidth="2.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {points.map((p, i) => (
          <React.Fragment key={i}>
            <Circle cx={p.x} cy={p.y} r={i === points.length - 1 ? 6 : 4} fill={i === points.length - 1 ? Colors.primary : Colors.card} stroke={Colors.primary} strokeWidth="2" />
          </React.Fragment>
        ))}
        {points.map((p, i) => (
          i % Math.max(1, Math.floor(scores.length / 5)) === 0 || i === points.length - 1 ? (
            <SvgText key={`lbl-${i}`} x={p.x} y={p.y - 10} fontSize="10" fill={Colors.textSecondary} textAnchor="middle">
              {p.score}
            </SvgText>
          ) : null
        ))}
      </Svg>
    </View>
  );
}

const chartStyles = StyleSheet.create({
  container: { marginTop: 8 },
});

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={statStyles.card}>
      <Text style={[statStyles.value, color ? { color } : {}]}>{value}</Text>
      <Text style={statStyles.label}>{label}</Text>
    </View>
  );
}

const statStyles = StyleSheet.create({
  card: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: 12,
    padding: 12,
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  value: { color: Colors.text, fontFamily: "Inter_700Bold", fontSize: 18 },
  label: { color: Colors.textMuted, fontFamily: "Inter_400Regular", fontSize: 11, textAlign: "center" },
});

function getDefectDeduction(defect: DefectItem): number | null {
  if (!defect.detected) return 0;
  const name = defect.name.toLowerCase();
  if (name.includes("균열") || name.includes("crack")) return -100;
  if (name.includes("용착") || name.includes("lack of fusion")) return -20;
  if (name.includes("용입") || name.includes("incomplete penetration")) return -20;
  if (name.includes("여고") || name.includes("excessive")) return -10;
  if (name.includes("기공") || name.includes("porosity")) return -10;
  if (name.includes("오버랩") || name.includes("overlap")) return -10;
  if (name.includes("언더컷") || name.includes("undercut")) return -10;
  if (name.includes("아크") || name.includes("arc strike")) return -10;
  if (name.includes("스패터") || name.includes("spatter")) return -5;
  return null;
}

function DefectRow({ defect, t }: { defect: DefectItem; t: (key: string) => string }) {
  const deduction = getDefectDeduction(defect);
  const deductionText = deduction === null ? "-" : `${deduction}${t("points_suffix")}`;
  const deductionColor = !defect.detected ? Colors.textMuted : deduction === 0 ? Colors.success : Colors.danger;
  const severityColors: Record<string, string> = { "없음": Colors.textMuted, "경미": Colors.warning, "보통": Colors.warning, "심각": Colors.danger };

  return (
    <View style={defectStyles.row}>
      <View style={defectStyles.nameCol}>
        <View style={[defectStyles.dot, { backgroundColor: defect.detected ? severityColors[defect.severity] : Colors.textMuted }]} />
        <Text style={[defectStyles.name, !defect.detected && { color: Colors.textMuted }]}>{defect.name}</Text>
      </View>
      <Text style={defectStyles.cell}>{defect.measured}</Text>
      <Text style={[defectStyles.cell, { fontSize: 10 }]}>{defect.limit}</Text>
      <View style={[defectStyles.resultBadge, { backgroundColor: deductionColor + "22" }]}>
        <Text style={[defectStyles.resultText, { color: deductionColor }]}>{deductionText}</Text>
      </View>
    </View>
  );
}

const defectStyles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    gap: 4,
  },
  nameCol: { flex: 1.5, flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
  name: { color: Colors.text, fontFamily: "Inter_500Medium", fontSize: 12 },
  cell: { flex: 1, color: Colors.textSecondary, fontFamily: "Inter_400Regular", fontSize: 11, textAlign: "center" },
  resultBadge: { width: 52, paddingVertical: 2, borderRadius: 6, alignItems: "center" },
  resultText: { fontFamily: "Inter_600SemiBold", fontSize: 10 },
});

function SectionCard({ title, icon, badge, children }: { title: string; icon: string; badge?: React.ReactNode; children: React.ReactNode }) {
  return (
    <View style={sectionStyles.card}>
      <View style={sectionStyles.titleRow}>
        <MaterialCommunityIcons name={icon as any} size={18} color={Colors.primary} />
        <Text style={sectionStyles.title}>{title}</Text>
        {badge != null && <View style={{ flex: 1, alignItems: "flex-end" }}>{badge}</View>}
      </View>
      {children}
    </View>
  );
}

function computeTotalDeduction(defects: DefectItem[]): number {
  let total = 0;
  for (const defect of defects) {
    if (!defect.detected) continue;
    const name = defect.name.toLowerCase();
    if (name.includes("균열") || name.includes("crack")) { total += 100; continue; }
    if (name.includes("용착") || name.includes("lack of fusion")) { total += 20; continue; }
    if (name.includes("용입") || name.includes("incomplete penetration")) { total += 20; continue; }
    if (name.includes("여고") || name.includes("excessive")) { total += 10; continue; }
    if (name.includes("기공") || name.includes("porosity")) { total += 10; continue; }
    if (name.includes("오버랩") || name.includes("overlap")) { total += 10; continue; }
    if (name.includes("언더컷") || name.includes("undercut")) { total += 10; continue; }
    if (name.includes("아크") || name.includes("arc strike")) { total += 10; continue; }
    if (name.includes("스패터") || name.includes("spatter")) { total += 5; continue; }
  }
  return total;
}

const sectionStyles = StyleSheet.create({
  card: {
    backgroundColor: Colors.card,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 12,
  },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { color: Colors.text, fontFamily: "Inter_700Bold", fontSize: 16 },
});

function ScoreCompareBar({ selfScore, aiScore, t }: { selfScore: number; aiScore: number; t: (key: string) => string }) {
  const diff = aiScore - selfScore;
  const evaluation =
    Math.abs(diff) <= 5
      ? { text: t("compare_accurate"), color: Colors.success }
      : diff > 5
      ? { text: t("compare_under"), color: Colors.primary }
      : { text: t("compare_over"), color: Colors.warning };
  const ptsSuffix = t("points_suffix");

  return (
    <View style={compareStyles.container}>
      <View style={compareStyles.barRow}>
        <View style={{ flex: 1 }}>
          <Text style={compareStyles.label}>{t("diag_selfScore")}</Text>
          <View style={compareStyles.bar}>
            <View style={[compareStyles.fill, { width: `${selfScore}%`, backgroundColor: Colors.textSecondary }]} />
          </View>
          <Text style={compareStyles.score}>{selfScore}{ptsSuffix}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={compareStyles.label}>{t("diag_aiScore")}</Text>
          <View style={compareStyles.bar}>
            <View style={[compareStyles.fill, { width: `${aiScore}%`, backgroundColor: getGradeColor(aiScore) }]} />
          </View>
          <Text style={[compareStyles.score, { color: getGradeColor(aiScore) }]}>{aiScore}{ptsSuffix}</Text>
        </View>
      </View>
      <View style={[compareStyles.evalBadge, { backgroundColor: evaluation.color + "22", borderColor: evaluation.color + "55" }]}>
        <Ionicons name={Math.abs(diff) <= 5 ? "checkmark-circle" : "information-circle"} size={14} color={evaluation.color} />
        <Text style={[compareStyles.evalText, { color: evaluation.color }]}>{evaluation.text}</Text>
        {diff !== 0 && (
          <Text style={[compareStyles.evalDiff, { color: evaluation.color }]}>
            ({diff > 0 ? "+" : ""}{diff}{ptsSuffix})
          </Text>
        )}
      </View>
    </View>
  );
}

const compareStyles = StyleSheet.create({
  container: { gap: 12 },
  barRow: { flexDirection: "row", gap: 16 },
  label: { color: Colors.textMuted, fontFamily: "Inter_400Regular", fontSize: 12, marginBottom: 4 },
  bar: { height: 8, backgroundColor: Colors.surface, borderRadius: 4, overflow: "hidden" },
  fill: { height: "100%", borderRadius: 4 },
  score: { color: Colors.text, fontFamily: "Inter_700Bold", fontSize: 16, marginTop: 4 },
  evalBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  evalText: { fontFamily: "Inter_500Medium", fontSize: 13, flex: 1 },
  evalDiff: { fontFamily: "Inter_700Bold", fontSize: 13 },
});

type PhotoView = "front" | "side" | "back";

function PhotoTabBar({
  tabs,
  selected,
  onSelect,
}: {
  tabs: Array<{ key: PhotoView; label: string }>;
  selected: PhotoView;
  onSelect: (k: PhotoView) => void;
}) {
  if (tabs.length <= 1) return null;
  return (
    <View style={photoTabStyles.bar}>
      {tabs.map((t) => (
        <Pressable
          key={t.key}
          style={[photoTabStyles.item, selected === t.key && photoTabStyles.itemActive]}
          onPress={() => { Haptics.selectionAsync(); onSelect(t.key); }}
        >
          <Text style={[photoTabStyles.text, selected === t.key && photoTabStyles.textActive]}>
            {t.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const photoTabStyles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    backgroundColor: Colors.surface,
    borderRadius: 10,
    padding: 3,
    gap: 3,
    marginBottom: 8,
  },
  item: {
    flex: 1,
    paddingVertical: 6,
    borderRadius: 8,
    alignItems: "center",
  },
  itemActive: {
    backgroundColor: Colors.primary,
  },
  text: {
    color: Colors.textMuted,
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
  textActive: {
    color: "#fff",
  },
});

// ── AI 종합 분석 보고서 섹션별 컬러/아이콘 테마 ──
// 보고서는 "## 1. 이번 용접 진단" 형식의 5개 섹션으로 구성됨 (gpt_advisor.py 참고)
const REPORT_SECTION_THEMES: Record<number, { color: string; icon: string }> = {
  1: { color: "#3B82F6", icon: "stethoscope" },           // 이번 용접 진단
  2: { color: "#8B5CF6", icon: "chart-line-variant" },    // 학습 추세 분석
  3: { color: "#EF4444", icon: "alert-circle-outline" },  // 반복 결함 근본 원인
  4: { color: "#F59E0B", icon: "format-list-numbered" },  // 우선순위 개선 액션
  5: { color: "#10B981", icon: "lightbulb-on-outline" },  // 다음 연습 가이드
};

// 마크다운 헤더(## N. 제목) 단위로 섹션 분리
function parseReportSections(report: string): Array<{ num: number; title: string; body: string }> {
  if (!report) return [];
  const lines = report.split("\n");
  const out: Array<{ num: number; title: string; body: string }> = [];
  let cur: { num: number; title: string; bodyLines: string[] } | null = null;
  for (const line of lines) {
    const m = line.match(/^##\s+(\d+)\.\s*(.+)$/);
    if (m) {
      if (cur) out.push({ num: cur.num, title: cur.title, body: cur.bodyLines.join("\n").trim() });
      cur = { num: parseInt(m[1], 10), title: m[2].trim(), bodyLines: [] };
    } else if (cur) {
      cur.bodyLines.push(line);
    }
  }
  if (cur) out.push({ num: cur.num, title: cur.title, body: cur.bodyLines.join("\n").trim() });
  return out;
}

// 인라인 **bold** 처리
function renderInline(text: string, baseColor: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    const m = part.match(/^\*\*([^*]+)\*\*$/);
    if (m) {
      return (
        <Text key={i} style={{ fontFamily: "Inter_700Bold", color: baseColor }}>
          {m[1]}
        </Text>
      );
    }
    return (
      <Text key={i} style={{ color: baseColor }}>
        {part}
      </Text>
    );
  });
}

// 섹션 본문(여러 줄 텍스트, 불릿 리스트, 번호 리스트) 렌더링
function ReportSectionBody({ body, accentColor }: { body: string; accentColor: string }) {
  const lines = body.split("\n").map((l) => l.replace(/\s+$/g, ""));
  const blocks: React.ReactNode[] = [];
  let para: string[] = [];
  const flushPara = (key: string) => {
    if (para.length === 0) return;
    const txt = para.join(" ").trim();
    if (txt) {
      blocks.push(
        <Text key={key} style={reportStyles.bodyText}>
          {renderInline(txt, "#FFFFFF")}
        </Text>
      );
    }
    para = [];
  };
  lines.forEach((raw, idx) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      flushPara(`p-${idx}`);
      return;
    }
    const bullet = trimmed.match(/^[-*•]\s+(.+)$/);
    const numbered = trimmed.match(/^(\d+)[.)]\s+(.+)$/);
    if (bullet) {
      flushPara(`p-${idx}`);
      blocks.push(
        <View key={`b-${idx}`} style={reportStyles.bulletRow}>
          <View style={[reportStyles.bulletDot, { backgroundColor: accentColor }]} />
          <Text style={[reportStyles.bodyText, { flex: 1 }]}>
            {renderInline(bullet[1], "#FFFFFF")}
          </Text>
        </View>
      );
      return;
    }
    if (numbered) {
      flushPara(`p-${idx}`);
      blocks.push(
        <View key={`n-${idx}`} style={reportStyles.bulletRow}>
          <Text style={[reportStyles.bodyText, { fontFamily: "Inter_700Bold", color: accentColor, minWidth: 18 }]}>
            {numbered[1]}.
          </Text>
          <Text style={[reportStyles.bodyText, { flex: 1 }]}>
            {renderInline(numbered[2], "#FFFFFF")}
          </Text>
        </View>
      );
      return;
    }
    para.push(trimmed);
  });
  flushPara("p-end");
  return <View style={{ gap: 6 }}>{blocks}</View>;
}

const reportStyles = StyleSheet.create({
  bodyText: {
    color: "#FFFFFF",
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    lineHeight: 21,
  },
  bulletRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingLeft: 2,
  },
  bulletDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginTop: 8,
  },
});

export default function DiagnosisScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { getResultById, getUserResults, deleteResult, results: allResults } = useWelding();
  const { user } = useAuth();
  const { t } = useLanguage();
  const isAdmin = user?.username === "admin";
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [heatmapContainerW, setHeatmapContainerW] = useState(0);
  const [imgNaturalSize, setImgNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [imgRenderedSize, setImgRenderedSize] = useState<{ width: number; height: number } | null>(null);
  const [isZoomed, setIsZoomed] = useState(false);
  const [showFeedbackModal, setShowFeedbackModal] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);
  const [selectedPhotoView, setSelectedPhotoView] = useState<PhotoView>("front");

  const zoomScale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const zoomTransX = useSharedValue(0);
  const zoomTransY = useSharedValue(0);
  const savedTransX = useSharedValue(0);
  const savedTransY = useSharedValue(0);

  const pinchGesture = Gesture.Pinch()
    .onUpdate((e) => {
      zoomScale.value = Math.max(1, Math.min(5, savedScale.value * e.scale));
    })
    .onEnd(() => {
      savedScale.value = zoomScale.value;
      runOnJS(setIsZoomed)(zoomScale.value > 1.05);
    });

  const panGesture = Gesture.Pan()
    .enabled(isZoomed)
    .onUpdate((e) => {
      zoomTransX.value = savedTransX.value + e.translationX;
      zoomTransY.value = savedTransY.value + e.translationY;
    })
    .onEnd(() => {
      savedTransX.value = zoomTransX.value;
      savedTransY.value = zoomTransY.value;
    });

  const doubleTapGesture = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      zoomScale.value = withSpring(1);
      savedScale.value = 1;
      zoomTransX.value = withSpring(0);
      zoomTransY.value = withSpring(0);
      savedTransX.value = 0;
      savedTransY.value = 0;
      runOnJS(setIsZoomed)(false);
    });

  const heatmapGesture = Gesture.Simultaneous(pinchGesture, panGesture, doubleTapGesture);

  const zoomAnimStyle = useAnimatedStyle(() => ({
    transform: [
      { scale: zoomScale.value },
      { translateX: zoomTransX.value },
      { translateY: zoomTransY.value },
    ],
  }));

  const result = getResultById(id);

  const currentPhotoAnalysis = useMemo((): PerPhotoAnalysis | null => {
    if (!result) return null;
    const pa = result.photoAnalyses?.[selectedPhotoView as "front" | "side" | "back"];
    if (pa) return pa;
    if (selectedPhotoView === "front") {
      return {
        beadAnalysis: result.beadAnalysis,
        defects: result.defects,
        defectLocations: result.defectLocations ?? [],
      };
    }
    return null;
  }, [result, selectedPhotoView]);

  const imgAspectRatio = imgNaturalSize
    ? imgNaturalSize.width / imgNaturalSize.height
    : 4 / 3;

  const heatmapDisplayW = heatmapContainerW > 0 ? heatmapContainerW : SCREEN_W - 66;
  const heatmapDisplayH = Math.round(heatmapDisplayW / imgAspectRatio);

  const MARKER = 44;

  function getDefectTypeKey(name: string): string {
    const n = name.toLowerCase();
    if (n.includes("균열") || n.includes("crack")) return "균열";
    if (n.includes("용착") || n.includes("lack of fusion")) return "용착";
    if (n.includes("용입") || n.includes("incomplete penetration")) return "용입";
    if (n.includes("여고") || n.includes("excessive")) return "여고";
    if (n.includes("기공") || n.includes("porosity")) return "기공";
    if (n.includes("언더컷") || n.includes("undercut")) return "언더컷";
    if (n.includes("오버랩") || n.includes("overlap")) return "오버랩";
    if (n.includes("스패터") || n.includes("spatter")) return "스패터";
    if (n.includes("아크") || n.includes("arc strike")) return "아크";
    return name.split(" ")[0];
  }

  function getDefectShortName(name: string): string {
    return getDefectTypeKey(name);
  }

  /**
   * 실제 이미지가 컨테이너 안에서 렌더링되는 영역을 계산합니다.
   * contentFit="contain" 사용 시 이미지가 컨테이너 비율과 다르면
   * 레터박스(여백)가 생기므로, AI 좌표를 컨테이너 전체가 아닌
   * 실제 이미지 픽셀 영역에 매핑해야 정확한 위치에 마커가 표시됩니다.
   */
  const imageRenderedBounds = useMemo(() => {
    if (!imgRenderedSize || !imgNaturalSize) return null;
    const containerW = imgRenderedSize.width;
    const containerH = imgRenderedSize.height;
    if (containerW <= 0 || containerH <= 0) return null;
    const naturalAspect = imgNaturalSize.width / imgNaturalSize.height;
    const containerAspect = containerW / containerH;
    let imgW: number, imgH: number, offsetX: number, offsetY: number;
    if (naturalAspect > containerAspect) {
      imgW = containerW;
      imgH = containerW / naturalAspect;
      offsetX = 0;
      offsetY = (containerH - imgH) / 2;
    } else {
      imgH = containerH;
      imgW = containerH * naturalAspect;
      offsetX = (containerW - imgW) / 2;
      offsetY = 0;
    }
    return { imgW, imgH, offsetX, offsetY, containerW, containerH };
  }, [imgRenderedSize, imgNaturalSize]);

  const defectMarkers = useMemo(() => {
    if (!imageRenderedBounds || !currentPhotoAnalysis || heatmapContainerW <= 0) return [];
    const { imgW, imgH, offsetX, offsetY, containerW, containerH } = imageRenderedBounds;
    const locations = currentPhotoAnalysis.defectLocations ?? [];

    // 모든 인스턴스를 표시 (한 종류가 N개면 N개 모두) — dedup 없음
    const rawPositions = locations.map((loc) => ({
      loc,
      cx: offsetX + (loc.x / 100) * imgW,
      cy: offsetY + (loc.y / 100) * imgH,
    }));

    // 겹침 방지: 가까운 마커를 방사형으로 분산
    const spreadPositions = rawPositions.map(({ loc, cx, cy }, i) => {
      let finalCx = cx;
      let finalCy = cy;
      const overlapGroup: number[] = [];
      rawPositions.forEach(({ cx: ox, cy: oy }, j) => {
        if (i !== j) {
          const dist = Math.sqrt((cx - ox) ** 2 + (cy - oy) ** 2);
          if (dist < MARKER + 4) overlapGroup.push(j);
        }
      });
      if (overlapGroup.length > 0) {
        const groupMembers = [i, ...overlapGroup].sort((a, b) => a - b);
        const posInGroup = groupMembers.indexOf(i);
        const total = groupMembers.length;
        const angle = (posInGroup / total) * 2 * Math.PI;
        const radius = (MARKER + 4) * Math.ceil(total / 2);
        finalCx = cx + Math.cos(angle) * radius;
        finalCy = cy + Math.sin(angle) * radius;
      }
      return { loc, finalCx, finalCy };
    });

    return spreadPositions.map(({ loc, finalCx, finalCy }, idx) => {
      const typeKey = getDefectTypeKey(loc.name);
      const defect = currentPhotoAnalysis.defects.find((d) => getDefectTypeKey(d.name) === typeKey);
      const rawLeft = finalCx - MARKER / 2;
      const rawTop  = finalCy - MARKER / 2;
      const severity = defect?.severity ?? "";
      const color = severity === "심각" ? Colors.danger
        : (defect?.detected ? Colors.warning : Colors.textMuted);
      return {
        key: `${typeKey}-${idx}`,
        shortName: getDefectShortName(loc.name),
        color,
        left: Math.max(0, Math.min(rawLeft, containerW - MARKER)),
        top:  Math.max(0, Math.min(rawTop,  containerH - MARKER)),
      };
    });
  }, [imageRenderedBounds, heatmapContainerW, currentPhotoAnalysis]);

  // 비드 검출 시각화 (4개 레이어):
  //  ① bead_polygon_pct      → Roboflow 검출 비드 폴리곤 (반투명 하늘색 면)
  //  ② reference_curve_pct   → 강건 polyfit 기준 곡선 (노란 실선) — "이상적 평균 비드 경로"
  //  ③ centerline_points_pct → 실제 raw 중심선 (시안 점선) — 실제 측정값 (평활화 없음)
  //  ④ worst_x/y_pct         → 직진도 최대 이탈점 (빨간 동그라미)
  const straightnessOverlay = useMemo(() => {
    if (!imageRenderedBounds || !currentPhotoAnalysis || heatmapContainerW <= 0) return [];
    const lines = (currentPhotoAnalysis as any).straightnessLines as
      | Array<{
          start_x_pct:number; start_y_pct:number; end_x_pct:number; end_y_pct:number;
          worst_x_pct:number; worst_y_pct:number; deviation_mm:number; is_curve?:boolean;
          worst_width_x_pct?:number|null; worst_width_y_pct?:number|null; worst_width_dev_mm?:number;
          curve_points_pct?: Array<{x_pct:number; y_pct:number}>;
          reference_curve_pct?: Array<{x_pct:number; y_pct:number}>;
          centerline_points_pct?: Array<{x_pct:number; y_pct:number}>;
          bead_polygon_pct?: Array<{x_pct:number; y_pct:number}>;
        }>
      | undefined;
    if (!lines || lines.length === 0) return [];
    const { imgW, imgH, offsetX, offsetY } = imageRenderedBounds;
    const toXY = (p: {x_pct:number; y_pct:number}) =>
      `${offsetX + (p.x_pct / 100) * imgW},${offsetY + (p.y_pct / 100) * imgH}`;
    return lines.map((ln, i) => {
      // 실제 비드 중심선 (구불구불) — 시안 점선
      const centerPts = (ln.centerline_points_pct && ln.centerline_points_pct.length >= 2)
        ? ln.centerline_points_pct.map(toXY).join(" ")
        : null;
      // 기준 곡선 (이상적 평균) — 노란 실선
      // 우선순위: reference_curve_pct → curve_points_pct(구버전 호환)
      const refCurvePts =
        (ln.reference_curve_pct && ln.reference_curve_pct.length >= 2)
          ? ln.reference_curve_pct.map(toXY).join(" ")
          : (ln.curve_points_pct && ln.curve_points_pct.length >= 2)
            ? ln.curve_points_pct.map(toXY).join(" ")
            : null;
      const polyPts = (ln.bead_polygon_pct && ln.bead_polygon_pct.length >= 3)
        ? ln.bead_polygon_pct.map(toXY).join(" ")
        : null;
      // 폭 최대 편차점 (보라색 마커) — 백엔드가 제공하지 않으면 null
      const hasWidthMarker =
        ln.worst_width_x_pct != null && ln.worst_width_y_pct != null && (ln.worst_width_dev_mm ?? 0) > 0;
      return {
        key: `sline-${i}`,
        x1: offsetX + (ln.start_x_pct / 100) * imgW,
        y1: offsetY + (ln.start_y_pct / 100) * imgH,
        x2: offsetX + (ln.end_x_pct   / 100) * imgW,
        y2: offsetY + (ln.end_y_pct   / 100) * imgH,
        wx: offsetX + (ln.worst_x_pct / 100) * imgW,
        wy: offsetY + (ln.worst_y_pct / 100) * imgH,
        deviation: ln.deviation_mm,
        centerPoints: centerPts,
        refCurvePoints: refCurvePts,
        polygonPoints: polyPts,
        hasWidthMarker,
        wwx: hasWidthMarker ? offsetX + ((ln.worst_width_x_pct as number) / 100) * imgW : 0,
        wwy: hasWidthMarker ? offsetY + ((ln.worst_width_y_pct as number) / 100) * imgH : 0,
        widthDev: ln.worst_width_dev_mm ?? 0,
      };
    });
  }, [imageRenderedBounds, heatmapContainerW, currentPhotoAnalysis]);

  const rank = useMemo(() => {
    if (!result) return 1;
    const userIds = Array.from(new Set(allResults.map((r) => r.userId)));
    const avgScores = userIds.map((uid) => {
      const userR = allResults.filter((r) => r.userId === uid);
      const avg = userR.reduce((a, b) => a + b.aiScore, 0) / userR.length;
      return { userId: uid, avg };
    });
    avgScores.sort((a, b) => b.avg - a.avg);
    const idx = avgScores.findIndex((s) => s.userId === result.userId);
    return idx >= 0 ? idx + 1 : 1;
  }, [allResults, result]);

  if (!result) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <Text style={{ color: Colors.text, textAlign: "center", marginTop: 100 }}>
          {t("result_notFound")}
        </Text>
      </View>
    );
  }

  const userResults = getUserResults(result.userId);
  const avgScore = userResults.length > 0
    ? Math.round(userResults.reduce((a, b) => a + b.aiScore, 0) / userResults.length * 10) / 10
    : result.aiScore;

  const allUserScores = userResults.map((r) => r.aiScore);
  const bestScore = allUserScores.length > 0 ? Math.max(...allUserScores) : result.aiScore;
  const totalAiEvals = userResults.length;

  const photoTabs: Array<{ key: PhotoView; label: string }> = [
    { key: "front", label: t("photo_front") },
    ...(result.photos?.side ? [{ key: "side" as PhotoView, label: t("photo_side") }] : []),
    ...(result.photos?.back ? [{ key: "back" as PhotoView, label: t("photo_back") }] : []),
  ];
  const hasMultiplePhotos = photoTabs.length > 1;
  const selectedPhotoUri =
    selectedPhotoView === "side" && result.photos?.side
      ? result.photos.side
      : selectedPhotoView === "back" && result.photos?.back
      ? result.photos.back
      : result.photos?.front ?? result.photoUri;

  useEffect(() => {
    if (!selectedPhotoUri) return;
    setImgNaturalSize(null);
    setImgRenderedSize(null);
    Image.getSize(
      selectedPhotoUri,
      (w, h) => { if (w > 0 && h > 0) setImgNaturalSize({ width: w, height: h }); },
      () => {}
    );
  }, [selectedPhotoUri]);

  const topPad = Platform.OS === "web" ? 67 : insets.top;

  const handleAdminDelete = () => {
    Alert.alert(
      t("adm_deleteTitle"),
      t("adm_deleteConfirm").replace("{name}", result.userName),
      [
        { text: t("cancel"), style: "cancel" },
        {
          text: t("adm_delete"),
          style: "destructive",
          onPress: async () => {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            await deleteResult(result.id);
            if (router.canGoBack()) router.back();
            else router.replace("/(tabs)/");
          },
        },
      ]
    );
  };

  const submitFeedback = async () => {
    if (!feedbackText.trim()) return;
    setFeedbackSubmitting(true);
    try {
      const { getApiUrl } = await import("@/lib/query-client");
      const apiUrl = new URL("/api/admin-feedback", getApiUrl()).toString();
      const resp = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resultId: result.id, userName: result.userName, feedbackText: feedbackText.trim() }),
      });
      if (resp.ok) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        Alert.alert(t("adm_savedTitle"), t("adm_savedMsg"));
        setFeedbackText("");
        setShowFeedbackModal(false);
      } else {
        Alert.alert(t("error"), t("adm_saveFailed"));
      }
    } catch {
      Alert.alert(t("error"), t("adm_networkErr"));
    } finally {
      setFeedbackSubmitting(false);
    }
  };

  return (
    <View style={[styles.container]}>
      <LinearGradient colors={[Colors.bg, "#0D1528", Colors.bg]} style={StyleSheet.absoluteFill} />

      <View style={[styles.navBar, { paddingTop: topPad + 8 }]}>
        <Pressable
          onPress={() => {
            if (router.canGoBack()) router.back();
            else router.replace("/(tabs)/");
          }}
          style={styles.backBtn}
        >
          <Ionicons name="chevron-back" size={24} color={Colors.text} />
        </Pressable>
        <Text style={styles.navTitle}>{result.userName}</Text>
        {isAdmin ? (
          <View style={{ flexDirection: "row", gap: 6 }}>
            <Pressable
              onPress={() => { Haptics.selectionAsync(); setShowFeedbackModal(true); }}
              style={[styles.adminDeleteNavBtn, { backgroundColor: Colors.primary + "22", borderColor: Colors.primary + "66" }]}
            >
              <Ionicons name="chatbubble-ellipses-outline" size={16} color={Colors.primary} />
            </Pressable>
            <Pressable
              onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); handleAdminDelete(); }}
              style={styles.adminDeleteNavBtn}
            >
              <Ionicons name="trash-outline" size={18} color={Colors.danger} />
            </Pressable>
          </View>
        ) : (
          <View style={{ width: 40 }} />
        )}
      </View>

      <KeyboardAwareScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 40 }]}
        showsVerticalScrollIndicator={false}
        scrollEnabled={!isZoomed}
        bottomOffset={20}
      >
        <View style={styles.profileSection}>
          {result.userProfileUri && (result.userProfileUri.startsWith("data:") || result.userProfileUri.startsWith("http")) ? (
            <Image source={{ uri: result.userProfileUri }} style={styles.profileAvatar} />
          ) : (
            <View style={[styles.profileAvatar, styles.profileAvatarPlaceholder]}>
              <Ionicons name="person" size={36} color={Colors.textMuted} />
            </View>
          )}

          <View style={styles.profileInfo}>
            <Text style={styles.profileName}>{result.userName}</Text>
            <View style={styles.profileBadgeRow}>
              <View style={styles.rankBadge}>
                <MaterialCommunityIcons name="trophy" size={12} color={Colors.gold} />
                <Text style={styles.rankBadgeText}>#{rank}</Text>
              </View>
              {result.userCourseName && (
                <View style={styles.courseNameBadge}>
                  <MaterialCommunityIcons name="book-education-outline" size={11} color={Colors.primary} />
                  <Text style={styles.courseNameBadgeText}>{result.userCourseName}</Text>
                </View>
              )}
            </View>
          </View>

          <View style={styles.bigScore}>
            <Text style={[styles.bigScoreNum, { color: getGradeColor(result.aiScore) }]}>
              {result.aiScore}
            </Text>
            <Text style={styles.bigScoreLabel}>{t("diag_aiScore")}</Text>
          </View>
        </View>

        <View style={styles.statsRow}>
          <StatCard label={t("diag_totalEvals")} value={`${totalAiEvals}`} />
          <StatCard label={t("diag_recentGrade")} value={result.grade || getGrade(result.aiScore)} color={getGradeColor(result.aiScore)} />
        </View>
        <View style={styles.statsRow}>
          <StatCard label={t("diag_avgScore")} value={`${avgScore}`} color={getGradeColor(avgScore)} />
          <StatCard label={t("diag_bestScore")} value={`${bestScore}${t("points_suffix")}`} color={Colors.gold} />
        </View>

        <SectionCard
          title={t("diag_beadAnalysis")}
          icon="ruler-square"
          badge={currentPhotoAnalysis?.beadAnalysis ? (
            <Text style={{ color: getGradeColor(currentPhotoAnalysis.beadAnalysis.totalScore), fontFamily: "Inter_700Bold", fontSize: 15 }}>
              {currentPhotoAnalysis.beadAnalysis.totalScore}{t("points_suffix")}
            </Text>
          ) : undefined}
        >
          {hasMultiplePhotos && (
            <>
              <PhotoTabBar tabs={photoTabs} selected={selectedPhotoView} onSelect={(k) => { setSelectedPhotoView(k); setImgNaturalSize(null); setImgRenderedSize(null); }} />
              <ExpoImage
                source={{ uri: selectedPhotoUri }}
                style={styles.sectionPhotoThumb}
                contentFit="cover"
              />
            </>
          )}
          {currentPhotoAnalysis?.beadAnalysis ? (
            <>
              {(() => {
                const ba = currentPhotoAnalysis.beadAnalysis!;
                const beadItems: Array<{ label: string; data: { value: string; score: number } }> = [
                  { label: t("bead_width"),        data: ba.width },
                  { label: t("bead_straightness"), data: ba.straightness },
                ];
                if (ba.height) {
                  beadItems.push({ label: t("bead_height"), data: ba.height });
                }
                const scoreColor = (s: number) =>
                  s >= 90 ? Colors.primary
                  : s >= 80 ? Colors.success
                  : s >= 65 ? Colors.warning
                  : Colors.danger;
                return (
                  <>
                    {beadItems.map(({ label, data }) => {
                      const color = scoreColor(data.score);
                      return (
                        <View key={label} style={styles.beadRow}>
                          <View style={styles.beadRowTop}>
                            <Text style={styles.beadLabel}>{label}</Text>
                            <Text style={[styles.beadResult, { color }]}>
                              {data.score}{t("points_suffix")}
                            </Text>
                          </View>
                          <Text style={styles.beadMeasure} numberOfLines={2}>{data.value}</Text>
                          <View style={styles.beadProgressTrack}>
                            <View style={[styles.beadProgressFill, { width: `${Math.max(0, Math.min(100, data.score))}%`, backgroundColor: color }]} />
                          </View>
                        </View>
                      );
                    })}
                  </>
                );
              })()}
            </>
          ) : (
            <Text style={{ color: Colors.textMuted, fontFamily: "Inter_400Regular", fontSize: 13, textAlign: "center", paddingVertical: 12, paddingHorizontal: 8, lineHeight: 19 }}>
              {currentPhotoAnalysis?.analysisStatus === "no_bead_detected"
                ? (selectedPhotoView === "side" ? t("diag_sideNotDetected") : t("diag_backNotDetected"))
                : (selectedPhotoView === "side" ? t("diag_sideAnalyzing") : t("diag_backAnalyzing"))}
            </Text>
          )}
        </SectionCard>

        <SectionCard
          title={t("diag_defectEval")}
          icon="magnify-scan"
          badge={currentPhotoAnalysis ? (() => {
            const totalDed = computeTotalDeduction(currentPhotoAnalysis.defects);
            return (
              <Text style={{ color: totalDed > 0 ? Colors.danger : Colors.success, fontFamily: "Inter_700Bold", fontSize: 15 }}>
                {totalDed > 0 ? `-${totalDed}${t("points_suffix")}` : `0${t("points_suffix")}`}
              </Text>
            );
          })() : undefined}
        >
          {hasMultiplePhotos && (
            <>
              <PhotoTabBar tabs={photoTabs} selected={selectedPhotoView} onSelect={(k) => { setSelectedPhotoView(k); setImgNaturalSize(null); setImgRenderedSize(null); }} />
              <ExpoImage
                source={{ uri: selectedPhotoUri }}
                style={styles.sectionPhotoThumb}
                contentFit="cover"
              />
            </>
          )}
          {currentPhotoAnalysis && currentPhotoAnalysis.defects.length > 0 ? (
            <>
              <View style={styles.defectTableHeader}>
                <Text style={[styles.defectHeaderText, { flex: 1.5 }]}>{t("diag_defectName")}</Text>
                <Text style={styles.defectHeaderText}>{t("diag_measured")}</Text>
                <Text style={styles.defectHeaderText}>{t("diag_standard")}</Text>
                <Text style={[styles.defectHeaderText, { width: 52 }]}>{t("diag_deduction")}</Text>
              </View>
              {currentPhotoAnalysis.defects.map((d) => (
                <DefectRow key={d.name} defect={d} t={t} />
              ))}
            </>
          ) : (
            <Text style={{ color: Colors.textMuted, fontFamily: "Inter_400Regular", fontSize: 13, textAlign: "center", paddingVertical: 12, paddingHorizontal: 8, lineHeight: 19 }}>
              {currentPhotoAnalysis?.analysisStatus === "no_bead_detected"
                ? (selectedPhotoView === "side" ? t("diag_sideNotDetected") : t("diag_backNotDetected"))
                : currentPhotoAnalysis
                ? t("diag_noDefectsDetected")
                : (selectedPhotoView === "side" ? t("diag_sideNoData") : t("diag_backNoData"))}
            </Text>
          )}
        </SectionCard>

        <SectionCard title={t("diag_aiReport")} icon="robot">
          <View style={[styles.verdictBanner, {
            backgroundColor: result.overallVerdict === "PASS" ? Colors.success + "22" : Colors.danger + "22",
            borderColor: result.overallVerdict === "PASS" ? Colors.success + "55" : Colors.danger + "55",
          }]}>
            <Ionicons
              name={result.overallVerdict === "PASS" ? "checkmark-circle" : "close-circle"}
              size={32}
              color={result.overallVerdict === "PASS" ? Colors.success : Colors.danger}
            />
            <View>
              <Text style={[styles.verdictText, {
                color: result.overallVerdict === "PASS" ? Colors.success : Colors.danger,
              }]}>
                {result.overallVerdict}
              </Text>
              <Text style={styles.verdictSub}>{t("diag_overallVerdict")}</Text>
            </View>
            <View style={styles.verdictScoreSection}>
              <Text style={[styles.verdictScore, { color: getGradeColor(result.aiScore) }]}>
                {result.aiScore}
              </Text>
              <Text style={styles.verdictScoreLabel}>{t("diag_outOf100")}</Text>
            </View>
          </View>

          <View>
            <Text style={styles.subLabel}>{t("diag_top3")}</Text>
            {result.top3Defects.length === 0 ? (
              <Text style={styles.noDefect}>{t("diag_noDefect")}</Text>
            ) : (
              result.top3Defects.map((d, i) => (
                <View key={d} style={styles.top3Row}>
                  <Text style={[styles.top3Rank, { color: [Colors.danger, Colors.warning, Colors.warning][i] }]}>
                    {i + 1}
                  </Text>
                  <Text style={styles.top3Name}>{d}</Text>
                </View>
              ))
            )}
          </View>

          {result.comprehensiveReport ? (
            <View style={styles.comprehensiveBox}>
              <View style={styles.comprehensiveHeader}>
                <MaterialCommunityIcons name="brain" size={15} color={Colors.primary} />
                <Text style={styles.comprehensiveTitle}>
                  {t("diag_aiSummary")} {userResults.length > 1 ? t("diag_historyReflected").replace("{n}", String(userResults.length)) : ""}
                </Text>
              </View>
              {(() => {
                const sections = parseReportSections(result.comprehensiveReport);
                if (sections.length === 0) {
                  // 헤더가 없는 단일 보고서는 폴백으로 그냥 텍스트 출력
                  return <Text style={styles.comprehensiveText}>{result.comprehensiveReport}</Text>;
                }
                return (
                  <View style={{ gap: 10 }}>
                    {sections.map((s) => {
                      const theme = REPORT_SECTION_THEMES[s.num] ?? {
                        color: Colors.primary,
                        icon: "circle-outline",
                      };
                      return (
                        <View
                          key={`sec-${s.num}`}
                          style={[
                            styles.reportSectionCard,
                            { borderLeftColor: theme.color, backgroundColor: theme.color + "0E" },
                          ]}
                        >
                          <View style={styles.reportSectionHeader}>
                            <View style={[styles.reportSectionBadge, { backgroundColor: theme.color }]}>
                              <Text style={styles.reportSectionBadgeText}>{s.num}</Text>
                            </View>
                            <MaterialCommunityIcons
                              name={theme.icon as any}
                              size={16}
                              color={theme.color}
                            />
                            <Text style={[styles.reportSectionTitle, { color: theme.color }]}>
                              {s.title}
                            </Text>
                          </View>
                          <ReportSectionBody body={s.body} accentColor={theme.color} />
                        </View>
                      );
                    })}
                  </View>
                );
              })()}
            </View>
          ) : null}
        </SectionCard>

        <SectionCard title={t("diag_heatmap")} icon="eye-outline">
          {result.photoUri ? (
            <View>
              {hasMultiplePhotos && (
                <PhotoTabBar tabs={photoTabs} selected={selectedPhotoView} onSelect={(k) => { setSelectedPhotoView(k); setImgNaturalSize(null); setImgRenderedSize(null); }} />
              )}
              <View
                style={styles.heatmapContainer}
                onLayout={(e) => setHeatmapContainerW(e.nativeEvent.layout.width)}
              >
                <GestureDetector gesture={heatmapGesture}>
                  <Animated.View style={zoomAnimStyle}>
                    <ExpoImage
                      source={{ uri: selectedPhotoUri }}
                      style={{ width: heatmapDisplayW, height: heatmapDisplayH }}
                      contentFit="contain"
                      onLayout={(e) => {
                        const { width, height } = e.nativeEvent.layout;
                        if (width > 0 && height > 0) setImgRenderedSize({ width, height });
                      }}
                    />
                    {showHeatmap && currentPhotoAnalysis && imgRenderedSize && imgNaturalSize && (
                      <View
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: imgRenderedSize.width,
                          height: imgRenderedSize.height,
                        }}
                        pointerEvents="none"
                      >
                        {/* 직진도 시각화: 시점-끝점 기준선 + 최대 이탈점 */}
                        {straightnessOverlay.length > 0 && (
                          <Svg
                            width={imgRenderedSize.width}
                            height={imgRenderedSize.height}
                            style={{ position: "absolute", top: 0, left: 0 }}
                            pointerEvents="none"
                          >
                            {straightnessOverlay.map((s) => (
                              <React.Fragment key={s.key}>
                                {/* ① Roboflow 검출 비드 폴리곤 — 반투명 하늘색 면 */}
                                {s.polygonPoints && (
                                  <Polyline
                                    points={s.polygonPoints + " " + s.polygonPoints.split(" ")[0]}
                                    stroke="#38BDF8"
                                    strokeWidth="1.5"
                                    fill="rgba(56,189,248,0.22)"
                                  />
                                )}
                                {/* ② 기준 곡선 (이상적 평균 비드 경로) — 노란 실선 */}
                                {s.refCurvePoints && (
                                  <Polyline
                                    points={s.refCurvePoints}
                                    stroke="#FBBF24"
                                    strokeWidth="2.5"
                                    fill="none"
                                  />
                                )}
                                {/* ③ 실제 raw 중심선 — 시안 점선 (구불구불, 평활화 없음) */}
                                {s.centerPoints ? (
                                  <Polyline
                                    points={s.centerPoints}
                                    stroke="#22D3EE"
                                    strokeWidth="2"
                                    strokeDasharray="5,4"
                                    fill="none"
                                  />
                                ) : (
                                  <Line
                                    x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
                                    stroke="#22D3EE" strokeWidth="2" strokeDasharray="5,4"
                                  />
                                )}
                                {/* 시점/끝점 작은 원 (기준선 양 끝) */}
                                <Circle cx={s.x1} cy={s.y1} r={4} fill="#FBBF24" />
                                <Circle cx={s.x2} cy={s.y2} r={4} fill="#FBBF24" />
                                {/* ④ 최대 이탈점 강조 (직진도) */}
                                <Circle cx={s.wx} cy={s.wy} r={7} fill="rgba(239,68,68,0.85)" stroke="#fff" strokeWidth="1.5" />
                                <SvgText
                                  x={s.wx + 10} y={s.wy - 6}
                                  fontSize="11" fontWeight="bold" fill="#FCA5A5"
                                  stroke="#000" strokeWidth="0.5"
                                >
                                  {`${t("diag_straightnessLabel")} ${s.deviation.toFixed(1)}mm ${t("diag_deviation")}`}
                                </SvgText>
                                {/* ⑤ 폭 최대 편차점 (보라색) — 비드형상 그래프의 가장 불균일한 슬라이스 위치 */}
                                {s.hasWidthMarker && (
                                  <>
                                    <Circle cx={s.wwx} cy={s.wwy} r={7} fill="rgba(168,85,247,0.85)" stroke="#fff" strokeWidth="1.5" />
                                    <SvgText
                                      x={s.wwx + 10} y={s.wwy + 14}
                                      fontSize="11" fontWeight="bold" fill="#D8B4FE"
                                      stroke="#000" strokeWidth="0.5"
                                    >
                                      {`${t("diag_widthLabel")} ${s.widthDev.toFixed(1)}mm ${t("diag_deviation")}`}
                                    </SvgText>
                                  </>
                                )}
                              </React.Fragment>
                            ))}
                          </Svg>
                        )}
                        {defectMarkers.map((marker) => (
                          <View key={marker.key} style={{
                            position: "absolute",
                            left: marker.left,
                            top: marker.top,
                            width: MARKER,
                            height: MARKER,
                            borderRadius: MARKER / 2,
                            borderWidth: 2.5,
                            borderColor: marker.color,
                            backgroundColor: "rgba(0,0,0,0.6)",
                            alignItems: "center",
                            justifyContent: "center",
                          }} pointerEvents="none">
                            <Text style={{ color: marker.color, fontSize: 9, fontFamily: "Inter_700Bold", textAlign: "center", textShadowColor: "rgba(0,0,0,1)", textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3, lineHeight: 11 }} numberOfLines={2}>
                              {marker.shortName}
                            </Text>
                          </View>
                        ))}
                        {defectMarkers.length === 0 && imgRenderedSize !== null && (
                          currentPhotoAnalysis.defects?.some((d: any) => d.detected) ? (
                            <View style={styles.heatmapNoDefect}>
                              <MaterialCommunityIcons name="map-marker-question-outline" size={28} color={Colors.warning} />
                              <Text style={[styles.heatmapNoDefectText, { color: Colors.warning }]}>{t("diag_coordsLoading")}</Text>
                            </View>
                          ) : (
                            <View style={styles.heatmapNoDefect}>
                              <Ionicons name="checkmark-circle" size={28} color={Colors.success} />
                              <Text style={styles.heatmapNoDefectText}>{t("diag_noDefectAi")}</Text>
                            </View>
                          )
                        )}
                      </View>
                    )}
                  </Animated.View>
                </GestureDetector>
              </View>
              <View style={styles.heatmapControls}>
                <Pressable
                  style={[styles.heatmapToggle, !currentPhotoAnalysis && { opacity: 0.4 }]}
                  onPress={() => {
                    if (result?.beadType === "비드 쌓기") {
                      Alert.alert(t("diag_beadStackTitle"), t("diag_beadStackMsg"));
                      return;
                    }
                    currentPhotoAnalysis && setShowHeatmap(!showHeatmap);
                  }}
                >
                  <LinearGradient colors={["rgba(0,0,0,0.7)", "rgba(0,0,0,0.5)"]} style={styles.heatmapToggleGrad}>
                    <MaterialCommunityIcons name={showHeatmap ? "eye-off" : "eye"} size={16} color="#fff" />
                    <Text style={styles.heatmapToggleText}>{showHeatmap ? t("diag_hideMarkers") : t("diag_showMarkers")}</Text>
                  </LinearGradient>
                </Pressable>
                <Text style={styles.zoomHint}>{t("diag_zoomHint")}</Text>
              </View>
            </View>
          ) : (
            <Text style={{ color: Colors.textMuted }}>{t("diag_noPhoto")}</Text>
          )}
        </SectionCard>

        <SectionCard title={t("diag_selfCompare")} icon="scale-balance">
          <ScoreCompareBar selfScore={result.selfScore} aiScore={result.aiScore} t={t} />
        </SectionCard>

        <SectionCard title={t("diag_improvements")} icon="lightbulb-on-outline">
          <Text style={styles.improvementSubtitle}>
            {userResults.length > 1 ? t("diag_improvementMulti").replace("{n}", String(userResults.length)) : t("diag_improvementSingle")}
          </Text>
          {result.improvements.map((tip, i) => (
            <View key={i} style={styles.improvementRow}>
              <View style={[styles.improvementDot, { backgroundColor: i === 0 ? Colors.danger : i === 1 ? Colors.warning : Colors.primary }]} />
              <Text style={styles.improvementText}>{tip}</Text>
            </View>
          ))}
        </SectionCard>

        <SectionCard title={t("diag_trend")} icon="chart-line">
          {(() => {
            const sortedScores = [...userResults]
              .sort((a, b) => a.timestamp - b.timestamp)
              .map((r) => r.aiScore);
            return (
              <>
                {sortedScores.length < 2 ? (
                  <Text style={{ color: Colors.textMuted, fontFamily: "Inter_400Regular", fontSize: 13 }}>
                    {t("diag_atLeast2")}
                  </Text>
                ) : (
                  <TrendChart scores={sortedScores} />
                )}
                <View style={styles.trendSummary}>
                  {sortedScores.length >= 2 && (
                    <>
                      <Text style={styles.trendText}>
                        {t("trend_totalAvg").replace("{n}", String(sortedScores.length))}:{" "}
                        <Text style={{ color: Colors.primary }}>
                          {Math.round(sortedScores.reduce((a, b) => a + b, 0) / sortedScores.length)}{t("points_suffix")}
                        </Text>
                      </Text>
                      <Text style={styles.trendText}>
                        {t("trend_skill")}:{" "}
                        <Text style={{
                          color: sortedScores[sortedScores.length - 1] >= sortedScores[0]
                            ? Colors.success
                            : Colors.danger,
                        }}>
                          {sortedScores[sortedScores.length - 1] >= sortedScores[0]
                            ? t("trend_improved").replace("{n}", String(sortedScores[sortedScores.length - 1] - sortedScores[0]))
                            : t("trend_declined").replace("{n}", String(sortedScores[sortedScores.length - 1] - sortedScores[0]))}
                        </Text>
                      </Text>
                      {sortedScores.length >= 3 && (() => {
                        const prevDiff = sortedScores[sortedScores.length - 1] - sortedScores[sortedScores.length - 2];
                        return (
                          <Text style={styles.trendText}>
                            {t("trend_vsPrev")}:{" "}
                            <Text style={{ color: prevDiff >= 0 ? Colors.success : Colors.danger }}>
                              {prevDiff >= 0 ? `▲ +${prevDiff}${t("points_suffix")}` : `▼ ${prevDiff}${t("points_suffix")}`}
                            </Text>
                          </Text>
                        );
                      })()}
                    </>
                  )}
                </View>
              </>
            );
          })()}
        </SectionCard>

        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>{t("label_process")}</Text>
          <Text style={styles.infoValue}>{result.process === "기타" ? result.processCustom || "기타" : result.process}</Text>
        </View>
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>{t("label_posture")}</Text>
          <Text style={styles.infoValue}>{result.posture === "기타" ? result.postureCustom || "기타" : result.posture}</Text>
        </View>
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>{t("label_material")}</Text>
          <Text style={styles.infoValue}>{result.material === "기타" ? result.materialCustom || "기타" : result.material}</Text>
        </View>
        {!!result.beadType && (
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>{t("diag_beadType")}</Text>
            <Text style={styles.infoValue}>
              {result.beadType}{(result as any).passType ? ` · ${(result as any).passType}` : ""}
            </Text>
          </View>
        )}
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>{t("diag_selfScore")}</Text>
          <Text style={[styles.infoValue, { color: getGradeColor(result.selfScore) }]}>
            {result.selfScore}{t("points_suffix")} ({getGrade(result.selfScore)})
          </Text>
        </View>

        <SectionCard title={t("diag_history")} icon="history">
          {[...userResults]
            .sort((a, b) => b.timestamp - a.timestamp)
            .map((r, i) => {
              const isCurrentResult = r.id === result.id;
              const date = new Date(r.timestamp).toLocaleDateString("ko-KR", { month: "short", day: "numeric" });
              const time = new Date(r.timestamp).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
              const thumbUri = r.photos?.front ?? r.photoUri;
              return (
                <Pressable
                  key={r.id}
                  style={[styles.historyRow, isCurrentResult && styles.historyRowActive]}
                  onPress={() => {
                    if (!isCurrentResult) {
                      router.push({ pathname: "/diagnosis/[id]", params: { id: r.id } });
                    }
                  }}
                >
                  {thumbUri ? (
                    <Image source={{ uri: thumbUri }} style={styles.historyThumb} />
                  ) : (
                    <View style={[styles.historyThumb, styles.historyThumbPlaceholder]}>
                      <Ionicons name="image-outline" size={18} color={Colors.textMuted} />
                    </View>
                  )}
                  <View style={styles.historyInfo}>
                    <Text style={styles.historyDate}>{date} {time}</Text>
                    <Text style={styles.historyProcess}>{r.process} · {r.posture}</Text>
                    {isCurrentResult && (
                      <Text style={styles.historyCurrentBadge}>{t("trend_currentResult")}</Text>
                    )}
                  </View>
                  <View style={styles.historyScore}>
                    <Text style={[styles.historyScoreNum, { color: getGradeColor(r.aiScore) }]}>{r.aiScore}</Text>
                    <Text style={styles.historyGrade}>{r.grade || getGrade(r.aiScore)}</Text>
                  </View>
                  {!isCurrentResult && (
                    <Ionicons name="chevron-forward" size={16} color={Colors.textMuted} />
                  )}
                </Pressable>
              );
            })}
        </SectionCard>

        <CommentsSection resultId={result.id} />
      </KeyboardAwareScrollView>

      <Modal visible={showFeedbackModal} transparent animationType="slide" onRequestClose={() => setShowFeedbackModal(false)}>
        <KeyboardAvoidingView style={styles.fbOverlay} behavior="padding">
          <View style={styles.fbModal}>
            <View style={styles.fbHeader}>
              <Ionicons name="chatbubble-ellipses" size={20} color={Colors.primary} />
              <Text style={styles.fbTitle}>{t("adm_feedbackTitle")}</Text>
              <Pressable onPress={() => setShowFeedbackModal(false)}>
                <Ionicons name="close" size={22} color={Colors.textMuted} />
              </Pressable>
            </View>
            <Text style={styles.fbDesc}>
              {t("adm_feedbackDesc")}
            </Text>
            <Text style={styles.fbDesc} numberOfLines={2}>
              <Text style={{ color: Colors.textMuted }}>{t("adm_target")}: </Text>
              <Text style={{ color: Colors.textSecondary }}>{result.userName} · {t("diag_aiScore")} {result.aiScore}{t("points_suffix")}</Text>
            </Text>
            <TextInput
              style={styles.fbInput}
              placeholder={t("adm_feedbackPlaceholder")}
              placeholderTextColor={Colors.textMuted}
              multiline
              numberOfLines={5}
              textAlignVertical="top"
              value={feedbackText}
              onChangeText={setFeedbackText}
            />
            <View style={styles.fbBtnRow}>
              <Pressable style={styles.fbCancelBtn} onPress={() => { setShowFeedbackModal(false); setFeedbackText(""); }}>
                <Text style={styles.fbCancelBtnText}>{t("cancel")}</Text>
              </Pressable>
              <Pressable
                style={[styles.fbSubmitBtn, (!feedbackText.trim() || feedbackSubmitting) && { opacity: 0.5 }]}
                onPress={submitFeedback}
                disabled={!feedbackText.trim() || feedbackSubmitting}
              >
                {feedbackSubmitting ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.fbSubmitBtnText}>{t("adm_saveSubmit")}</Text>
                )}
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  navBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  backBtn: { padding: 8 },
  adminDeleteNavBtn: {
    width: 40,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.danger + "22",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.danger + "44",
  },
  navTitle: { color: Colors.text, fontFamily: "Inter_700Bold", fontSize: 18 },
  content: { paddingHorizontal: 16, paddingTop: 20, gap: 16 },
  profileSection: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    backgroundColor: Colors.card,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  profileAvatar: { width: 64, height: 64, borderRadius: 32, borderWidth: 2, borderColor: Colors.primary },
  profileAvatarPlaceholder: {
    backgroundColor: Colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  profileInfo: { flex: 1, gap: 6 },
  profileName: { color: Colors.text, fontFamily: "Inter_700Bold", fontSize: 18 },
  profileBadgeRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  rankBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: Colors.gold + "22",
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: Colors.gold + "44",
  },
  rankBadgeText: { color: Colors.gold, fontFamily: "Inter_700Bold", fontSize: 12 },
  uploadCount: { color: Colors.textMuted, fontFamily: "Inter_400Regular", fontSize: 12 },
  bigScore: { alignItems: "center" },
  bigScoreNum: { fontFamily: "Inter_700Bold", fontSize: 36 },
  bigScoreLabel: { color: Colors.textMuted, fontFamily: "Inter_400Regular", fontSize: 11 },
  statsRow: { flexDirection: "row", gap: 10 },
  beadRow: {
    flexDirection: "column",
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    gap: 3,
  },
  beadRowTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  beadLabel: { color: Colors.textSecondary, fontFamily: "Inter_500Medium", fontSize: 13, flex: 1 },
  beadMeasure: { color: Colors.text, fontFamily: "Inter_400Regular", fontSize: 12, lineHeight: 18 },
  beadValue: { fontFamily: "Inter_700Bold", fontSize: 15 },
  beadResult: { fontFamily: "Inter_700Bold", fontSize: 14 },
  beadProgressTrack: {
    height: 6,
    backgroundColor: Colors.surface,
    borderRadius: 3,
    overflow: "hidden",
    marginTop: 4,
  },
  beadProgressFill: {
    height: "100%",
    borderRadius: 3,
  },
  defectTableHeader: {
    flexDirection: "row",
    paddingHorizontal: 4,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    gap: 4,
  },
  defectHeaderText: {
    color: Colors.textMuted,
    fontFamily: "Inter_500Medium",
    fontSize: 10,
    flex: 1,
    textAlign: "center",
  },
  confidenceNote: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 4,
  },
  confidenceNoteText: {
    color: Colors.textMuted,
    fontFamily: "Inter_400Regular",
    fontSize: 11,
  },
  confidenceBlock: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 7,
    marginTop: 10,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  confidenceBlockText: {
    flex: 1,
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    lineHeight: 18,
  },
  courseNameBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: Colors.primary + "20",
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: Colors.primary + "44",
  },
  courseNameBadgeText: {
    color: Colors.primary,
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
  },
  verdictBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
  },
  verdictText: { fontFamily: "Inter_700Bold", fontSize: 24, letterSpacing: 1 },
  verdictSub: { color: Colors.textMuted, fontFamily: "Inter_400Regular", fontSize: 11 },
  verdictScoreSection: { marginLeft: "auto", alignItems: "flex-end" },
  verdictScore: { fontFamily: "Inter_700Bold", fontSize: 32 },
  verdictScoreLabel: { color: Colors.textMuted, fontFamily: "Inter_400Regular", fontSize: 12 },
  subLabel: {
    color: Colors.textSecondary,
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
    marginBottom: 8,
  },
  noDefect: { color: Colors.success, fontFamily: "Inter_500Medium", fontSize: 14 },
  top3Row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 4,
  },
  top3Rank: { fontFamily: "Inter_700Bold", fontSize: 18, width: 24, textAlign: "center" },
  top3Name: { color: Colors.text, fontFamily: "Inter_500Medium", fontSize: 14 },
  heatmapContainer: { borderRadius: 12, overflow: "hidden" },
  heatmapImage: { width: "100%", height: 280 },
  heatmapDot: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  heatmapDotInner: { width: 8, height: 8, borderRadius: 4 },
  heatmapChip: {
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 5,
    paddingVertical: 2,
    marginTop: 2,
  },
  heatmapLabel: { fontFamily: "Inter_600SemiBold", fontSize: 9, textAlign: "center" },
  heatmapNoDefect: {
    position: "absolute",
    top: 90,
    left: 0,
    right: 0,
    alignItems: "center",
    gap: 6,
  },
  heatmapNoDefectText: { color: Colors.success, fontFamily: "Inter_600SemiBold", fontSize: 13 },
  heatmapControls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 8,
    paddingHorizontal: 2,
  },
  heatmapToggle: {
    borderRadius: 20,
    overflow: "hidden",
  },
  heatmapToggleGrad: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  heatmapToggleText: { color: "#fff", fontFamily: "Inter_500Medium", fontSize: 12 },
  zoomHint: { color: Colors.textMuted, fontFamily: "Inter_400Regular", fontSize: 11 },
  improvementRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  improvementDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Colors.primary,
    marginTop: 6,
  },
  improvementText: {
    flex: 1,
    color: Colors.textSecondary,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    lineHeight: 20,
  },
  trendSummary: { gap: 4, marginTop: 4 },
  trendText: { color: Colors.textSecondary, fontFamily: "Inter_400Regular", fontSize: 13 },
  infoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border + "88",
  },
  infoLabel: { color: Colors.textMuted, fontFamily: "Inter_400Regular", fontSize: 13 },
  infoValue: { color: Colors.text, fontFamily: "Inter_500Medium", fontSize: 13 },
  improvementSubtitle: {
    color: Colors.textMuted,
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    marginBottom: 4,
    fontStyle: "italic",
  },
  comprehensiveBox: {
    backgroundColor: Colors.primary + "11",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.primary + "33",
    padding: 12,
    gap: 8,
  },
  comprehensiveHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
  comprehensiveTitle: {
    color: Colors.primary,
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
  comprehensiveText: {
    color: Colors.text,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    lineHeight: 21,
  },
  reportSectionCard: {
    backgroundColor: "#fff",
    borderRadius: 10,
    borderLeftWidth: 4,
    borderLeftColor: Colors.primary,
    paddingVertical: 12,
    paddingHorizontal: 12,
    gap: 10,
    shadowColor: "#000",
    shadowOpacity: 0.04,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  reportSectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  reportSectionBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  reportSectionBadgeText: {
    color: "#fff",
    fontFamily: "Inter_700Bold",
    fontSize: 12,
    lineHeight: 14,
  },
  reportSectionTitle: {
    flex: 1,
    fontFamily: "Inter_700Bold",
    fontSize: 13.5,
  },
  historyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  historyRowActive: {
    backgroundColor: Colors.primary + "11",
    borderRadius: 10,
    paddingHorizontal: 8,
    borderBottomWidth: 0,
    marginBottom: 2,
  },
  historyThumb: {
    width: 52,
    height: 52,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  historyThumbPlaceholder: {
    backgroundColor: Colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  historyInfo: { flex: 1, gap: 3 },
  historyDate: { color: Colors.text, fontFamily: "Inter_500Medium", fontSize: 13 },
  historyProcess: { color: Colors.textMuted, fontFamily: "Inter_400Regular", fontSize: 11 },
  historyCurrentBadge: {
    color: Colors.primary,
    fontFamily: "Inter_600SemiBold",
    fontSize: 10,
    marginTop: 2,
  },
  historyScore: { alignItems: "flex-end" },
  historyScoreNum: { fontFamily: "Inter_700Bold", fontSize: 20 },
  historyGrade: { color: Colors.textMuted, fontFamily: "Inter_400Regular", fontSize: 11 },
  sectionPhotoThumb: {
    width: "100%",
    height: 140,
    borderRadius: 10,
    overflow: "hidden",
    backgroundColor: Colors.surface,
  },
  fbOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.65)",
    justifyContent: "flex-end",
  },
  fbModal: {
    backgroundColor: Colors.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    gap: 12,
    borderTopWidth: 1,
    borderColor: Colors.border,
  },
  fbHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  fbTitle: {
    flex: 1,
    color: Colors.text,
    fontFamily: "Inter_700Bold",
    fontSize: 16,
  },
  fbDesc: {
    color: Colors.textSecondary,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    lineHeight: 19,
  },
  fbInput: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 12,
    padding: 12,
    color: Colors.text,
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    minHeight: 110,
  },
  fbBtnRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
    marginBottom: 8,
  },
  fbCancelBtn: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    backgroundColor: Colors.surface,
    alignItems: "center",
    borderWidth: 1,
    borderColor: Colors.border,
  },
  fbCancelBtnText: {
    color: Colors.textSecondary,
    fontFamily: "Inter_600SemiBold",
    fontSize: 15,
  },
  fbSubmitBtn: {
    flex: 2,
    paddingVertical: 13,
    borderRadius: 12,
    backgroundColor: Colors.primary,
    alignItems: "center",
  },
  fbSubmitBtnText: {
    color: "#fff",
    fontFamily: "Inter_700Bold",
    fontSize: 15,
  },
});
