import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Image,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Modal,
  Pressable,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import * as FileSystem from "expo-file-system";
import Colors from "@/constants/colors";
import { apiUrl } from "@/lib/query-client";

// ── 결과 타입 ────────────────────────────────────────────────────────────────
interface AnalysisResult {
  inspection_id: number;
  final_status: "PASS" | "FAIL";
  ai_score: number | null;
  avg_bead_width: number | null;
  straightness_error: number | null;
  defect_count: number;
  defects: Array<{ name: string; severity: string; confidence: number }>;
}

// ── 결과 모달 ────────────────────────────────────────────────────────────────
function ResultModal({
  result,
  onClose,
}: {
  result: AnalysisResult;
  onClose: () => void;
}) {
  const isPass = result.final_status === "PASS";

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={modal.overlay}>
        <View style={modal.card}>
          {/* 판정 배지 */}
          <View style={[modal.badge, isPass ? modal.badgePass : modal.badgeFail]}>
            <Text style={modal.badgeIcon}>{isPass ? "✅" : "❌"}</Text>
            <Text style={[modal.badgeText, { color: isPass ? Colors.success : Colors.danger }]}>
              {isPass ? "합격 (PASS)" : "불합격 (FAIL)"}
            </Text>
          </View>

          {/* 수치 행 */}
          <View style={modal.statsRow}>
            <View style={modal.statItem}>
              <Text style={modal.statVal}>
                {result.ai_score != null ? `${result.ai_score}점` : "—"}
              </Text>
              <Text style={modal.statKey}>AI 점수</Text>
            </View>
            <View style={modal.divider} />
            <View style={modal.statItem}>
              <Text style={modal.statVal}>
                {result.avg_bead_width != null ? `${result.avg_bead_width}mm` : "—"}
              </Text>
              <Text style={modal.statKey}>평균 비드폭</Text>
            </View>
            <View style={modal.divider} />
            <View style={modal.statItem}>
              <Text style={modal.statVal}>
                {result.straightness_error != null ? `${result.straightness_error}mm` : "—"}
              </Text>
              <Text style={modal.statKey}>직진도 오차</Text>
            </View>
          </View>

          {/* 결함 목록 */}
          {result.defect_count > 0 ? (
            <View style={modal.defectBox}>
              <Text style={modal.defectTitle}>
                탐지된 결함 {result.defect_count}건
              </Text>
              {result.defects.map((d, i) => (
                <View key={i} style={modal.defectRow}>
                  <View
                    style={[
                      modal.severityDot,
                      {
                        backgroundColor:
                          d.severity === "심각"
                            ? Colors.danger
                            : d.severity === "보통"
                            ? Colors.warning
                            : Colors.textMuted,
                      },
                    ]}
                  />
                  <Text style={modal.defectName}>{d.name}</Text>
                  <Text style={modal.defectConf}>{d.confidence}%</Text>
                </View>
              ))}
            </View>
          ) : (
            <View style={modal.noDefectBox}>
              <Text style={modal.noDefectText}>결함 미탐지 ✓</Text>
            </View>
          )}

          {/* 확인 버튼 */}
          <Pressable style={modal.closeBtn} onPress={onClose}>
            <Text style={modal.closeBtnText}>확인 — 다음 작업 계속</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

// ── 검사 화면 ────────────────────────────────────────────────────────────────
export default function InspectionScreen() {
  const insets = useSafeAreaInsets();
  const [projectName, setProjectName] = useState("");
  const [current, setCurrent] = useState("");
  const [voltage, setVoltage] = useState("");
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);

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
      // ① 이미지 → base64
      const imageBase64 = await FileSystem.readAsStringAsync(imageUri, {
        encoding: "base64" as any,
      });

      // ② POST /api/field/analysis (작업자 조회/생성 + FastAPI + DB 저장 통합 처리)
      const res = await fetch(apiUrl("api/field/analysis"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBase64,
          project_name:  projectName.trim() || undefined,
          current_amp:   current  ? parseFloat(current)  : undefined,
          voltage_volt:  voltage  ? parseFloat(voltage)  : undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message ?? data.error ?? `서버 오류 ${res.status}`);
      }

      // ③ 성공 — 폼 초기화 후 결과 모달 표시
      setProjectName("");
      setCurrent("");
      setVoltage("");
      setImageUri(null);
      setResult(data as AnalysisResult);
    } catch (e: any) {
      Alert.alert(
        "분석 실패",
        e.message ?? "알 수 없는 오류가 발생했습니다.",
        [{ text: "확인" }],
      );
    } finally {
      setAnalyzing(false);
    }
  };

  const canAnalyze = !!imageUri && !analyzing;

  return (
    <>
      <KeyboardAvoidingView
        style={{ flex: 1, backgroundColor: Colors.bg }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={88}
      >
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[
            styles.container,
            { paddingTop: insets.top + 16, paddingBottom: 120 },
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
                <Text style={styles.analyzeBtnText}>분석 중... (최대 90초)</Text>
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
      </KeyboardAvoidingView>

      {/* 결과 모달 */}
      {result && (
        <ResultModal result={result} onClose={() => setResult(null)} />
      )}
    </>
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
  analyzeBtnText: { fontSize: 18, fontFamily: "Inter_700Bold", color: "#fff" },
  analyzeBtnTextOff: { color: Colors.textMuted },
  analyzeHint: {
    fontSize: 12, fontFamily: "Inter_400Regular",
    color: Colors.textMuted, textAlign: "center", marginTop: -8,
  },
});

const modal = StyleSheet.create({
  overlay: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.75)",
    alignItems: "center", justifyContent: "center", padding: 24,
  },
  card: {
    width: "100%", backgroundColor: Colors.card,
    borderRadius: 20, borderWidth: 1, borderColor: Colors.border,
    padding: 24, gap: 18,
  },
  badge: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 10, borderRadius: 14, paddingVertical: 14,
  },
  badgePass: { backgroundColor: "rgba(0,214,143,0.12)" },
  badgeFail: { backgroundColor: "rgba(255,59,85,0.12)" },
  badgeIcon: { fontSize: 24 },
  badgeText: { fontSize: 20, fontFamily: "Inter_700Bold" },

  statsRow: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: Colors.surface,
    borderRadius: 12, borderWidth: 1, borderColor: Colors.border,
    paddingVertical: 14,
  },
  statItem: { flex: 1, alignItems: "center", gap: 4 },
  statVal: { fontSize: 17, fontFamily: "Inter_700Bold", color: Colors.text },
  statKey: { fontSize: 11, fontFamily: "Inter_400Regular", color: Colors.textSecondary },
  divider: { width: 1, height: 36, backgroundColor: Colors.border },

  defectBox: {
    backgroundColor: Colors.surface,
    borderRadius: 12, borderWidth: 1, borderColor: Colors.border,
    padding: 14, gap: 8,
  },
  defectTitle: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.danger },
  defectRow: {
    flexDirection: "row", alignItems: "center", gap: 8,
  },
  severityDot: { width: 8, height: 8, borderRadius: 4 },
  defectName: { flex: 1, fontSize: 14, fontFamily: "Inter_500Medium", color: Colors.text },
  defectConf: { fontSize: 13, fontFamily: "Inter_700Bold", color: Colors.textSecondary },

  noDefectBox: {
    backgroundColor: "rgba(0,214,143,0.08)",
    borderRadius: 12, padding: 14,
    alignItems: "center",
  },
  noDefectText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.success },

  closeBtn: {
    backgroundColor: Colors.primary,
    borderRadius: 14, paddingVertical: 16,
    alignItems: "center",
  },
  closeBtnText: { fontSize: 16, fontFamily: "Inter_700Bold", color: "#fff" },
});
