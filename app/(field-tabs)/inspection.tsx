import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Image,
  ActivityIndicator,
  Alert,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import Colors from "@/constants/colors";
import { apiUrl } from "@/lib/query-client";
import { useWelding, WeldingResult } from "@/context/WeldingContext";
import { useAuth } from "@/context/AuthContext";

const LOADING_STEPS = [
  "이미지 서버 전송 중...",
  "AI 결함 탐지 중 (Roboflow)...",
  "비드 치수 정밀 측정 중...",
  "진단 리포트 생성 중...",
] as const;

// ── 검사 화면 ────────────────────────────────────────────────────────────────
export default function InspectionScreen() {
  const insets = useSafeAreaInsets();
  const { addResult } = useWelding();
  const { user } = useAuth();
  const [projectName, setProjectName] = useState("");
  const [current, setCurrent] = useState("");
  const [voltage, setVoltage] = useState("");
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [loadingStepIdx, setLoadingStepIdx] = useState(0);

  // 분석 중 단계별 메시지를 2.5초 간격으로 순환
  useEffect(() => {
    if (!analyzing) {
      setLoadingStepIdx(0);
      return;
    }
    const id = setInterval(() => {
      setLoadingStepIdx((prev) => (prev + 1) % LOADING_STEPS.length);
    }, 2500);
    return () => clearInterval(id);
  }, [analyzing]);

  const pickFromCamera = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("권한 필요", "카메라 접근 권한이 필요합니다.\n설정에서 허용해 주세요.");
      return;
    }
    const res = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      allowsEditing: false,
      quality: 0.88,
    });
    if (!res.canceled) setImageUri(res.assets[0].uri);
  };

  const pickFromGallery = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("권한 필요", "사진 라이브러리 접근 권한이 필요합니다.\n설정에서 허용해 주세요.");
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: false,
      quality: 0.88,
    });
    if (!res.canceled) setImageUri(res.assets[0].uri);
  };

  const handleAnalyze = async () => {
    if (!imageUri) return;
    setAnalyzing(true);
    try {
      // ① URI 보정
      const normalizedUri =
        imageUri.startsWith("file://") ||
        imageUri.startsWith("content://") ||
        imageUri.startsWith("ph://")
          ? imageUri
          : `file://${imageUri}`;

      // ② FormData 구성
      const formData = new FormData();
      formData.append("image", {
        uri:  normalizedUri,
        name: "weld.jpg",
        type: "image/jpeg",
      } as any);
      if (projectName.trim()) formData.append("project_name", projectName.trim());
      if (current.trim())     formData.append("current_amp",  current.trim());
      if (voltage.trim())     formData.append("voltage_volt", voltage.trim());

      // ③ XMLHttpRequest — RN 네이티브 파일 I/O (content:// + file:// 모두 지원)
      const uploadUrl = apiUrl("api/field/analysis");
      console.log("[inspection] 분석 API 요청 URL:", uploadUrl);
      const raw = await new Promise<any>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", uploadUrl);
        xhr.timeout = 90_000;

        xhr.onload = () => {
          console.log("[inspection] XHR 응답:", xhr.status, xhr.responseText.slice(0, 300));
          let parsed: any = null;
          try { parsed = JSON.parse(xhr.responseText); } catch { /* 빈 응답 */ }
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(parsed);
          } else {
            const msg =
              parsed?.message ??
              parsed?.error   ??
              `서버 오류 ${xhr.status} (${xhr.statusText})`;
            reject(new Error(String(msg)));
          }
        };
        xhr.onerror   = () => reject(new Error("네트워크 오류 — 서버에 연결할 수 없습니다"));
        xhr.ontimeout = () => reject(new Error("요청 시간 초과 (90초) — 다시 시도해 주세요"));
        xhr.send(formData);
      });

      // ④ 응답 검증
      if (!raw || typeof raw !== "object") {
        throw new Error("서버 응답 형식이 올바르지 않습니다. 다시 시도해 주세요.");
      }
      if (!raw.inspection_id && (raw.error || raw.message)) {
        throw new Error(String(raw.message ?? raw.error ?? "분석 실패"));
      }

      // ⑤ FastAPI full_analysis 에서 WeldingResult 구성
      const fa = (raw.full_analysis ?? {}) as Record<string, any>;
      const aiScore = typeof fa.aiScore === "number" ? fa.aiScore : Number(raw.ai_score ?? 0);
      const grade =
        aiScore >= 90 ? "S" :
        aiScore >= 80 ? "A" :
        aiScore >= 70 ? "B" :
        aiScore >= 60 ? "C" : "D";

      // 용접 타입: FastAPI가 filletAnalysis를 반환하면 필릿, 없으면 맞대기
      const detectedIsFillet: boolean = fa.isFillet ?? (fa.filletAnalysis != null);

      const avgBeadWidth: number | null = raw.avg_bead_width != null ? Number(raw.avg_bead_width) : null;
      const straightnessError: number | null = raw.straightness_error != null ? Number(raw.straightness_error) : null;

      // 결함 배열 — FastAPI 전체(detected/not detected 포함) 우선
      const defectsArr = Array.isArray(fa.defects) ? fa.defects : (
        Array.isArray(raw.defects) ? raw.defects.map((d: any) => ({
          name:       String(d.name ?? "알 수 없는 결함"),
          detected:   true,
          severity:   (d.severity ?? "보통") as "없음" | "경미" | "보통" | "심각",
          confidence: Number(d.confidence ?? 0),
          standard:   "선급" as const,
          measured:   "",
          limit:      "",
          result:     "불합격" as const,
        })) : []
      );

      const weldingResult: WeldingResult = {
        id: `field_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        userId: user?.id ?? "field",
        userName: user?.name ?? "현장 작업자",
        userProfileUri: user?.profilePhotoUri,
        userCourseName: user?.courseName,
        photoUri: normalizedUri,
        photos: { front: normalizedUri },
        process: "FCAW",
        posture: "1G",
        material: "탄소강 평판",
        selfScore: 0,   // 현장 모드: 자체평가 없음 → diagnosis 페이지에서 해당 섹션 자동 숨김
        aiScore,
        grade,
        timestamp: Date.now(),
        beadAnalysis: fa.beadAnalysis ?? {
          totalScore: aiScore,
          width: {
            value: avgBeadWidth != null ? `${avgBeadWidth}mm` : "—",
            score: 70,
          },
          straightness: {
            value: straightnessError != null ? `${straightnessError}mm 이탈` : "—",
            score: 70,
          },
          height: null,
        },
        defects: defectsArr,
        defectLocations: fa.defectLocations ?? [],
        // 히트맵 오버레이(straightnessLines, defectLocations)를 front 사진에 연결
        photoAnalyses: {
          front: {
            beadAnalysis: fa.beadAnalysis ?? null,
            defects:      defectsArr,
            defectLocations: fa.defectLocations ?? [],
            straightnessLines: fa.straightnessLines ?? [],
          },
        },
        improvements:   fa.improvements ?? [],
        comprehensiveReport: fa.comprehensiveReport ?? undefined,
        overallVerdict: raw.final_status === "PASS" ? "PASS" : "FAIL",
        top3Defects:    fa.top3Defects ?? [],
        trendScores:    [],
        isFillet:         detectedIsFillet,
        filletAnalysis:   fa.filletAnalysis ?? null,
        laserAnalysis:    fa.laserAnalysis ?? null,
        cleanImageBase64: fa.cleanImageBase64 ?? "",
      };

      // ⑥ 폼 초기화 후 진단 리포트 화면으로 이동
      setProjectName("");
      setCurrent("");
      setVoltage("");
      setImageUri(null);

      await addResult(weldingResult);
      router.push(`/diagnosis/${weldingResult.id}`);
    } catch (e: any) {
      Alert.alert(
        "분석 실패",
        e?.message ?? "알 수 없는 오류가 발생했습니다.",
        [{ text: "확인" }],
      );
    } finally {
      setAnalyzing(false);
    }
  };

  const canAnalyze = !!imageUri && !analyzing;

  return (
    <View style={{ flex: 1, backgroundColor: Colors.bg }}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.container,
          { paddingTop: 16, paddingBottom: insets.bottom + 80 },
        ]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* 헤더 */}
        <Text style={styles.title}>실시간 현장 검사</Text>
        <Text style={styles.subtitle}>환경 입력 → 사진 등록 → AI 결함 분석</Text>

        {/* 작업 환경 입력 폼 */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="settings-outline" size={18} color={Colors.primary} />
            <Text style={styles.cardTitle}>작업 환경 입력</Text>
          </View>

          <View style={styles.fieldGroup}>
            <View style={styles.labelRow}>
              <Ionicons name="location-outline" size={15} color={Colors.textSecondary} />
              <Text style={styles.fieldLabel}>프로젝트명 / 구역</Text>
            </View>
            <TextInput
              style={styles.input}
              placeholder="예: 교량 보수공사 A구역"
              placeholderTextColor={Colors.textMuted}
              value={projectName}
              onChangeText={setProjectName}
              returnKeyType="next"
            />
          </View>

          <View style={styles.rowFields}>
            <View style={styles.halfField}>
              <View style={styles.labelRow}>
                <Ionicons name="flash-outline" size={15} color={Colors.warning} />
                <Text style={styles.fieldLabel}>전류 (A)</Text>
              </View>
              <TextInput
                style={styles.input}
                placeholder="예: 180"
                placeholderTextColor={Colors.textMuted}
                value={current}
                onChangeText={setCurrent}
                keyboardType="decimal-pad"
                returnKeyType="next"
              />
            </View>
            <View style={styles.halfField}>
              <View style={styles.labelRow}>
                <Ionicons name="thunderstorm-outline" size={15} color={Colors.primary} />
                <Text style={styles.fieldLabel}>전압 (V)</Text>
              </View>
              <TextInput
                style={styles.input}
                placeholder="예: 24"
                placeholderTextColor={Colors.textMuted}
                value={voltage}
                onChangeText={setVoltage}
                keyboardType="decimal-pad"
                returnKeyType="done"
              />
            </View>
          </View>
        </View>

        {/* 이미지 프리뷰 */}
        <View style={styles.previewBox}>
          {imageUri ? (
            <>
              <Image
                source={{ uri: imageUri }}
                style={styles.previewImage}
                resizeMode="contain"
              />
              <TouchableOpacity
                style={styles.removeBtn}
                onPress={() => setImageUri(null)}
                hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
              >
                <Ionicons name="close-circle" size={30} color={Colors.danger} />
              </TouchableOpacity>
            </>
          ) : (
            <View style={styles.previewEmpty}>
              <Ionicons name="image-outline" size={64} color={Colors.textMuted} />
              <Text style={styles.previewEmptyTitle}>사진이 없습니다</Text>
              <Text style={styles.previewEmptyHint}>
                아래 버튼으로 용접부 사진을 등록하세요
              </Text>
            </View>
          )}
        </View>

        {/* 사진 등록 버튼 */}
        <View style={styles.photoRow}>
          <TouchableOpacity
            style={styles.photoBtn}
            onPress={pickFromCamera}
            activeOpacity={0.75}
          >
            <Ionicons name="camera-outline" size={24} color={Colors.text} />
            <Text style={styles.photoBtnText}>카메라 촬영</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.photoBtn, styles.photoBtnOutline]}
            onPress={pickFromGallery}
            activeOpacity={0.75}
          >
            <Ionicons name="images-outline" size={24} color={Colors.primary} />
            <Text style={[styles.photoBtnText, { color: Colors.primary }]}>갤러리 선택</Text>
          </TouchableOpacity>
        </View>

        {/* 분석 버튼 */}
        <TouchableOpacity
          style={[styles.analyzeBtn, !canAnalyze && styles.analyzeBtnDisabled]}
          onPress={handleAnalyze}
          disabled={!canAnalyze}
          activeOpacity={0.82}
        >
          {analyzing ? (
            <>
              <ActivityIndicator size="small" color="#fff" />
              <Text style={styles.analyzeBtnText}>{LOADING_STEPS[loadingStepIdx]}</Text>
            </>
          ) : (
            <>
              <Ionicons
                name="rocket-outline"
                size={24}
                color={canAnalyze ? "#fff" : Colors.textMuted}
              />
              <Text
                style={[styles.analyzeBtnText, !canAnalyze && styles.analyzeBtnTextOff]}
              >
                용접 결과 분석하기
              </Text>
            </>
          )}
        </TouchableOpacity>

        {!imageUri && (
          <Text style={styles.analyzeHint}>
            📌 사진을 등록하면 분석 버튼이 활성화됩니다
          </Text>
        )}
      </ScrollView>
    </View>
  );
}

// ── 스타일 ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: Colors.bg },
  container: { paddingHorizontal: 20, gap: 16 },

  title: { fontSize: 22, fontFamily: "Inter_700Bold", color: Colors.text },
  subtitle: {
    fontSize: 13, fontFamily: "Inter_400Regular",
    color: Colors.textSecondary, marginTop: -8,
  },

  card: {
    backgroundColor: Colors.card,
    borderRadius: 16, borderWidth: 1, borderColor: Colors.border,
    padding: 18, gap: 14,
  },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 2 },
  cardTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.text },

  fieldGroup: { gap: 6 },
  rowFields: { flexDirection: "row", gap: 12 },
  halfField: { flex: 1, gap: 6 },
  labelRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  fieldLabel: { fontSize: 13, fontFamily: "Inter_500Medium", color: Colors.textSecondary },
  input: {
    backgroundColor: Colors.surface,
    borderRadius: 12, borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: 16, paddingVertical: 14,
    fontSize: 16, fontFamily: "Inter_500Medium", color: Colors.text,
    minHeight: 54,
  },

  previewBox: {
    height: 240,
    backgroundColor: Colors.card,
    borderRadius: 16, borderWidth: 1, borderColor: Colors.border,
    overflow: "hidden",
  },
  previewImage: { width: "100%", height: "100%" },
  previewEmpty: {
    flex: 1, alignItems: "center", justifyContent: "center", gap: 8,
  },
  previewEmptyTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.textMuted },
  previewEmptyHint: {
    fontSize: 12, fontFamily: "Inter_400Regular",
    color: Colors.textMuted, textAlign: "center", paddingHorizontal: 32,
  },
  removeBtn: {
    position: "absolute", top: 10, right: 10,
    backgroundColor: "rgba(0,0,0,0.55)", borderRadius: 15,
  },

  photoRow: { flexDirection: "row", gap: 12 },
  photoBtn: {
    flex: 1, flexDirection: "row", alignItems: "center",
    justifyContent: "center", gap: 8,
    backgroundColor: Colors.surface,
    borderRadius: 14, borderWidth: 1, borderColor: Colors.border,
    paddingVertical: 16,
  },
  photoBtnOutline: { backgroundColor: "transparent", borderColor: Colors.primary },
  photoBtnText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.text },

  analyzeBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 10, backgroundColor: Colors.success,
    borderRadius: 16, paddingVertical: 20, marginTop: 4,
  },
  analyzeBtnDisabled: {
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border,
  },
  analyzeBtnText: { fontSize: 17, fontFamily: "Inter_700Bold", color: "#fff" },
  analyzeBtnTextOff: { color: Colors.textMuted },
  analyzeHint: {
    fontSize: 12, fontFamily: "Inter_400Regular",
    color: Colors.textMuted, textAlign: "center", marginTop: -8,
  },
});
