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
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import Colors from "@/constants/colors";

export default function InspectionScreen() {
  const insets = useSafeAreaInsets();
  const [projectName, setProjectName] = useState("");
  const [current, setCurrent] = useState("");
  const [voltage, setVoltage] = useState("");
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  const pickFromCamera = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("권한 필요", "카메라 접근 권한이 필요합니다.\n설정에서 허용해 주세요.");
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      allowsEditing: false,
      quality: 0.92,
    });
    if (!result.canceled) setImageUri(result.assets[0].uri);
  };

  const pickFromGallery = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("권한 필요", "사진 라이브러리 접근 권한이 필요합니다.\n설정에서 허용해 주세요.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: false,
      quality: 0.92,
    });
    if (!result.canceled) setImageUri(result.assets[0].uri);
  };

  const handleAnalyze = async () => {
    if (!imageUri) return;
    setAnalyzing(true);
    try {
      // TODO: API 연동 (다음 단계)
      // 1. POST /api/field/records
      //    body: { welder_id, project_name, current_amp, voltage_volt }
      //    → response: { id: record_id }
      // 2. FormData 구성 후 POST /api/field/analysis
      //    - field "image": imageUri의 바이너리
      //    - field "record_id": record_id
      //    → response: { final_status, avg_bead_width, straightness_error, defects[] }
      // 3. 결과 모달 또는 결과 화면으로 이동
      await new Promise<void>((resolve) => setTimeout(resolve, 1500));
      Alert.alert("준비 완료", "API 연동 후 분석이 시작됩니다.\n(현재는 UI 확인용 더미 동작입니다)");
    } catch (e: any) {
      Alert.alert("오류", e.message ?? "분석 요청 실패");
    } finally {
      setAnalyzing(false);
    }
  };

  const canAnalyze = !!imageUri && !analyzing;

  return (
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
        {/* ── 헤더 ── */}
        <Text style={styles.title}>실시간 현장 검사</Text>
        <Text style={styles.subtitle}>환경 입력 → 사진 등록 → AI 결함 분석</Text>

        {/* ── 작업 환경 입력 폼 ── */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="settings-outline" size={18} color={Colors.primary} />
            <Text style={styles.cardTitle}>작업 환경 입력</Text>
          </View>

          {/* 프로젝트명 */}
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

          {/* 전류 / 전압 (나란히) */}
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

        {/* ── 이미지 프리뷰 ── */}
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

        {/* ── 사진 등록 버튼 2개 ── */}
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

        {/* ── 분석 시작 버튼 ── */}
        <TouchableOpacity
          style={[styles.analyzeBtn, !canAnalyze && styles.analyzeBtnDisabled]}
          onPress={handleAnalyze}
          disabled={!canAnalyze}
          activeOpacity={0.82}
        >
          {analyzing ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Ionicons
              name="rocket-outline"
              size={24}
              color={canAnalyze ? "#fff" : Colors.textMuted}
            />
          )}
          <Text style={[styles.analyzeBtnText, !canAnalyze && styles.analyzeBtnTextOff]}>
            {analyzing ? "분석 중..." : "용접 결과 분석하기"}
          </Text>
        </TouchableOpacity>

        {!imageUri && (
          <Text style={styles.analyzeHint}>
            📌 사진을 등록하면 분석 버튼이 활성화됩니다
          </Text>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  container: {
    paddingHorizontal: 20,
    gap: 16,
  },

  // 헤더
  title: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: Colors.text,
  },
  subtitle: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: Colors.textSecondary,
    marginTop: -8,
  },

  // 카드
  card: {
    backgroundColor: Colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 18,
    gap: 14,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 2,
  },
  cardTitle: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: Colors.text,
  },

  // 폼 필드
  fieldGroup: {
    gap: 6,
  },
  rowFields: {
    flexDirection: "row",
    gap: 12,
  },
  halfField: {
    flex: 1,
    gap: 6,
  },
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  fieldLabel: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: Colors.textSecondary,
  },
  input: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    fontFamily: "Inter_500Medium",
    color: Colors.text,
    minHeight: 54,
  },

  // 이미지 프리뷰
  previewBox: {
    height: 240,
    backgroundColor: Colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: "hidden",
  },
  previewImage: {
    width: "100%",
    height: "100%",
  },
  previewEmpty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderStyle: "dashed",
  },
  previewEmptyTitle: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: Colors.textMuted,
  },
  previewEmptyHint: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.textMuted,
    textAlign: "center",
    paddingHorizontal: 32,
  },
  removeBtn: {
    position: "absolute",
    top: 10,
    right: 10,
    backgroundColor: "rgba(0,0,0,0.55)",
    borderRadius: 15,
  },

  // 사진 버튼
  photoRow: {
    flexDirection: "row",
    gap: 12,
  },
  photoBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingVertical: 16,
  },
  photoBtnOutline: {
    backgroundColor: "transparent",
    borderColor: Colors.primary,
  },
  photoBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: Colors.text,
  },

  // 분석 버튼
  analyzeBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    backgroundColor: Colors.success,
    borderRadius: 16,
    paddingVertical: 20,
    marginTop: 4,
  },
  analyzeBtnDisabled: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  analyzeBtnText: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
  analyzeBtnTextOff: {
    color: Colors.textMuted,
  },
  analyzeHint: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.textMuted,
    textAlign: "center",
    marginTop: -8,
  },
});
