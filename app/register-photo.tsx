import React, { useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  TextInput,
  ActivityIndicator,
  Alert,
  Platform,
  Dimensions,
  Modal,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { Image } from "expo-image";

import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import * as FileSystem from "expo-file-system/legacy";
import * as ImageManipulator from "expo-image-manipulator";
import Colors, { getGrade, getGradeColor } from "@/constants/colors";
import { useAuth } from "@/context/AuthContext";
import { useWelding, WeldProcess, WeldPosture, WeldMaterial } from "@/context/WeldingContext";
import { getApiUrl } from "@/lib/query-client";
import { useLanguage } from "@/context/LanguageContext";
import WeldCameraModal from "@/components/WeldCameraModal";

const SCREEN_W = Dimensions.get("window").width;
const PHOTO_W = SCREEN_W - 40;
const PHOTO_H = 180;

const PROCESSES: WeldProcess[] = ["FCAW", "GTAW", "SAW", "EGW", "오토캐리지용접", "협동로봇 용접", "기타"];
const POSTURES: WeldPosture[] = ["1G", "2G", "3G", "4G", "5G", "6G", "1F", "2F", "3F", "4F", "5F", "기타"];
const MATERIALS: WeldMaterial[] = ["탄소강 평판", "탄소강 배관", "스테인리스 평판", "스테인리스강 배관", "기타"];

function ChipSelect<T extends string>({
  options,
  selected,
  onSelect,
  wrapCount = 4,
}: {
  options: T[];
  selected: T;
  onSelect: (v: T) => void;
  wrapCount?: number;
}) {
  return (
    <View style={chipStyles.container}>
      {options.map((opt) => (
        <Pressable
          key={opt}
          style={[chipStyles.chip, selected === opt && chipStyles.chipActive]}
          onPress={() => { onSelect(opt); Haptics.selectionAsync(); }}
        >
          <Text style={[chipStyles.chipText, selected === opt && chipStyles.chipTextActive]}>
            {opt}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const chipStyles = StyleSheet.create({
  container: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  chipActive: {
    backgroundColor: Colors.primary + "22",
    borderColor: Colors.primary,
  },
  chipText: {
    color: Colors.textSecondary,
    fontFamily: "Inter_500Medium",
    fontSize: 13,
  },
  chipTextActive: { color: Colors.primary },
});

type PhotoSlot = "front" | "side" | "back";

export default function RegisterPhotoScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { addResult, updatePhotos, getUserResults } = useWelding();
  const { t, lang } = useLanguage();

  const PHOTO_SLOT_INFO: Record<PhotoSlot, { label: string; subtitle: string; required: boolean }> = {
    front: { label: t("photo_front"), subtitle: t("photo_frontDesc"), required: true },
    side: { label: t("photo_side"), subtitle: t("photo_sideDesc"), required: false },
    back: { label: t("photo_back"), subtitle: t("photo_backDesc"), required: false },
  };

  const [photos, setPhotos] = useState<Record<PhotoSlot, string | null>>({ front: null, side: null, back: null });
  const [process, setProcess] = useState<WeldProcess>("FCAW");
  const [processCustom, setProcessCustom] = useState("");
  const [posture, setPosture] = useState<WeldPosture>("1G");
  const [postureCustom, setPostureCustom] = useState("");
  const [material, setMaterial] = useState<WeldMaterial>("탄소강 평판");
  const [materialCustom, setMaterialCustom] = useState("");
  const [selfScore, setSelfScore] = useState("");
  const [pipeOuterDiameter, setPipeOuterDiameter] = useState("");
  const [showPipeGuide, setShowPipeGuide] = useState(false);
  const [showPhotoGuide, setShowPhotoGuide] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisStage, setAnalysisStage] = useState<string>("");
  const [selectedAI, setSelectedAI] = useState<"gpt-4o" | "claude-sonnet">("gpt-4o");
  const [cameraSlot, setCameraSlot] = useState<PhotoSlot | null>(null);
  const [isFillet, setIsFillet] = useState(false);
  const [hasLaser, setHasLaser] = useState(false);
  const [analysisMode, setAnalysisMode] = useState<"quick" | "ai">("ai");

  const selfScoreNum = parseInt(selfScore) || 0;

  const handlePostureSelect = (p: WeldPosture) => {
    setPosture(p);
    if (["1F", "2F", "3F", "4F", "5F"].includes(p)) setIsFillet(true);
    else if (["1G", "2G", "3G", "4G", "5G", "6G"].includes(p)) setIsFillet(false);
    Haptics.selectionAsync();
  };

  const pickPhoto = async (slot: PhotoSlot, source: "gallery" | "camera") => {
    if (source === "camera") {
      // ArUco 가이드 오버레이가 있는 커스텀 카메라 사용
      setCameraSlot(slot);
      return;
    }
    const opts = { mediaTypes: ["images"] as any, quality: 0.8 as const, exif: false };
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert(t("error"), t("photo_gallery")); return; }
    const result = await ImagePicker.launchImageLibraryAsync(opts);
    if (!result.canceled) {
      const asset = result.assets[0];
      setPhotos(prev => ({ ...prev, [slot]: asset.uri }));
    }
  };

  const handleCameraCapture = useCallback((uri: string, _laserAngleDeg?: number) => {
    if (cameraSlot) {
      setPhotos(prev => ({ ...prev, [cameraSlot]: uri }));
    }
    setCameraSlot(null);
  }, [cameraSlot]);

  const showPickerAlert = (slot: PhotoSlot) => {
    Alert.alert(t("select"), PHOTO_SLOT_INFO[slot].label, [
      { text: t("photo_camera"), onPress: () => pickPhoto(slot, "camera") },
      { text: t("photo_gallery"), onPress: () => pickPhoto(slot, "gallery") },
      { text: t("cancel"), style: "cancel" },
    ]);
  };

  const getBase64FromUri = async (uri: string): Promise<string> => {
    if (!uri) return "";
    if (uri.startsWith("data:")) return uri.split(",")[1] ?? "";
    if (Platform.OS === "web") {
      const response = await fetch(uri);
      const blob = await response.blob();
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve((reader.result as string).split(",")[1] ?? "");
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }
    // ★ EXIF 회전 정규화: 스마트폰 사진은 EXIF 회전 태그를 포함하는 경우가 많음.
    // GPT-4o는 EXIF를 무시하고 픽셀 데이터 그대로 분석하므로
    // ImageManipulator로 재인코딩하여 EXIF 회전을 픽셀에 구워넣음.
    // 이렇게 하면 AI가 보는 이미지 방향 = 앱에서 보이는 이미지 방향이 일치함.
    try {
      const manipResult = await ImageManipulator.manipulateAsync(
        uri,
        [],
        { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG }
      );
      // 정규화된 URI에서 base64 읽기 (base64 옵션 없이 더 호환성 높음)
      return FileSystem.readAsStringAsync(manipResult.uri, { encoding: FileSystem.EncodingType.Base64 });
    } catch {
      // 실패 시 원본 파일 그대로 사용
    }
    return FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
  };

  const handleSubmit = async () => {
    if (!photos.front) {
      Alert.alert(t("error"), t("photo_required"));
      return;
    }
    if (!selfScore || selfScoreNum < 0 || selfScoreNum > 100) {
      Alert.alert(t("error"), t("photo_scoreError"));
      return;
    }

    setIsAnalyzing(true);
    setAnalysisStage(t("stage_preparing"));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);

    const stageTimers: ReturnType<typeof setTimeout>[] = [];

    try {
      const frontBase64 = await getBase64FromUri(photos.front!);
      const sideBase64 = photos.side ? await getBase64FromUri(photos.side) : undefined;
      const backBase64 = photos.back ? await getBase64FromUri(photos.back) : undefined;

      setAnalysisStage(t("stage_uploading"));

      const prevResults = getUserResults(user!.id);
      const previousResultsSummary = prevResults.length > 0
        ? prevResults
            .sort((a, b) => a.timestamp - b.timestamp)
            .map((r, i) => {
              const date = new Date(r.timestamp).toLocaleDateString("ko-KR");
              const defects = r.top3Defects.length > 0 ? r.top3Defects.join(", ") : "없음";
              return `[${i + 1}회차] ${date} - AI점수: ${r.aiScore}점(${r.grade || getGrade(r.aiScore)}) 판정:${r.overallVerdict} 주요결함:${defects} 비드형상:${r.beadAnalysis.totalScore}점`;
            })
            .join("\n")
        : undefined;

      const apiUrl = new URL("/api/analyze-weld", getApiUrl()).toString();

      // 서버 처리 중에는 streaming progress가 없으므로 단계별 텍스트만 시간차로 갱신
      stageTimers.push(setTimeout(() => setAnalysisStage(t("stage_detecting")), 1500));
      stageTimers.push(setTimeout(() => setAnalysisStage(t("stage_measuring")), 6000));
      stageTimers.push(setTimeout(() => setAnalysisStage(t("stage_aiAnalyzing").replace("{model}", selectedAI === "claude-sonnet" ? "Claude" : "GPT-4o")), 10000));
      stageTimers.push(setTimeout(() => setAnalysisStage(t("stage_writingReport")), 22000));

      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          photos: { front: frontBase64, side: sideBase64, back: backBase64 },
          process: process === "기타" ? processCustom || process : process,
          posture: posture === "기타" ? postureCustom || posture : posture,
          material: material === "기타" ? materialCustom || material : material,
          selfScore: selfScoreNum,
          previousResultsSummary,
          pipeOuterDiameterMm: material.includes("배관") ? (pipeOuterDiameter.trim() || undefined) : undefined,
          language: lang,
          aiModel: selectedAI,
          isFillet,
          hasLaser,
          analysisMode,
        }),
      });

      if (!response.ok) {
        let errMsg = `서버 오류: ${response.status}`;
        try {
          const errBody = await response.json();
          if (errBody?.message) errMsg = errBody.message;
        } catch {}
        throw new Error(errMsg);
      }
      const aiData = await response.json();

      stageTimers.forEach(clearTimeout);
      setAnalysisStage(t("stage_finalizing"));

      // ── 썸네일 즉시 생성 (로컬, 빠름) ───────────────────────
      const makeThumbnail = async (uri: string): Promise<string | undefined> => {
        try {
          const result = await ImageManipulator.manipulateAsync(
            uri,
            [{ resize: { width: 400 } }],
            { compress: 0.55, format: ImageManipulator.SaveFormat.JPEG, base64: true }
          );
          return result.base64 ? `data:image/jpeg;base64,${result.base64}` : undefined;
        } catch (e) {
          console.warn("썸네일 생성 실패:", e);
          return undefined;
        }
      };

      const [thumbFront, thumbSide, thumbBack] = await Promise.all([
        photos.front ? makeThumbnail(photos.front) : Promise.resolve(undefined),
        photos.side  ? makeThumbnail(photos.side)  : Promise.resolve(undefined),
        photos.back  ? makeThumbnail(photos.back)  : Promise.resolve(undefined),
      ]);

      // ── 결과 즉시 저장 + 화면 전환 (썸네일로 우선 표시) ─────
      const resultId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
      const newResult = {
        id: resultId,
        userId: user!.id,
        userName: user!.name,
        userProfileUri: user!.profilePhotoUri,
        userCourseName: user!.courseName ?? undefined,
        photoUri: thumbFront,
        photos: { front: thumbFront, side: thumbSide, back: thumbBack },
        process,
        processCustom: process === "기타" ? processCustom : undefined,
        posture,
        postureCustom: posture === "기타" ? postureCustom : undefined,
        material,
        materialCustom: material === "기타" ? materialCustom : undefined,
        selfScore: selfScoreNum,
        timestamp: Date.now(),
        trendScores: [aiData.aiScore],
        ...aiData,
        grade: getGrade(aiData.aiScore),
      };
      await addResult(newResult);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      // ── 즉시 결과 화면으로 이동 ───────────────────────────────
      router.dismissAll();
      router.push({ pathname: "/diagnosis/[id]", params: { id: resultId } });

      // ── 구글 드라이브 업로드 백그라운드 처리 (화면 전환 후) ──
      const uploadPhoto = async (base64: string, label: string): Promise<string | undefined> => {
        try {
          const ts = Date.now();
          const fileName = `${user!.id}_${ts}_${label}.jpg`;
          const uploadUrl = new URL("/api/upload-photo", getApiUrl()).toString();
          const uploadRes = await fetch(uploadUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ base64, fileName }),
          });
          if (uploadRes.ok) {
            const { url } = await uploadRes.json();
            return url;
          }
        } catch (e) {
          console.warn(`드라이브 업로드 실패(${label}):`, e);
        }
        return undefined;
      };

      // fire-and-forget: Drive 업로드 완료 시 DB 사진 URL만 교체
      Promise.all([
        uploadPhoto(frontBase64, "front"),
        sideBase64 ? uploadPhoto(sideBase64, "side") : Promise.resolve(undefined),
        backBase64 ? uploadPhoto(backBase64, "back") : Promise.resolve(undefined),
      ]).then(([driveFront, driveSide, driveBack]) => {
        const hasAny = driveFront || driveSide || driveBack;
        if (!hasAny) return;
        const updatedPhotos = {
          front: driveFront ?? thumbFront,
          side:  driveSide  ?? thumbSide,
          back:  driveBack  ?? thumbBack,
        };
        updatePhotos(resultId, driveFront ?? thumbFront ?? "", updatedPhotos);
      }).catch(() => {});
    } catch (err: any) {
      stageTimers.forEach(clearTimeout);
      console.error("AI 분석 오류:", err);
      // FastAPI/서버에서 받은 사용자 친화 메시지가 있으면 그대로 표시
      const msg = (err?.message && typeof err.message === "string" && err.message.length < 300)
        ? err.message
        : t("ai_analysisError");
      const looksLikePhotoIssue = /비드|마커|사진|선명|업로드|bead|marker|photo|upload/i.test(msg);
      Alert.alert(looksLikePhotoIssue ? t("photo_reuploadTitle") : t("analysis_errorTitle"), msg);
    } finally {
      stageTimers.forEach(clearTimeout);
      setAnalysisStage("");
      setIsAnalyzing(false);
    }
  };

  const topPad = Platform.OS === "web" ? 67 : insets.top;

  return (
    <View style={[styles.container, { paddingTop: topPad }]}>
      <LinearGradient colors={["#0A0E1A", "#0D1528", "#0A0E1A"]} style={StyleSheet.absoluteFill} />

      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="close" size={24} color={Colors.text} />
        </Pressable>
        <Text style={styles.headerTitle}>{t("photo_title")}</Text>
        <View style={{ width: 40 }} />
      </View>

      <KeyboardAwareScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 100 }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        bottomOffset={20}
      >
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("reg_registrant")}</Text>
          <View style={styles.userRow}>
            {user?.profilePhotoUri && (user.profilePhotoUri.startsWith("data:") || user.profilePhotoUri.startsWith("http")) ? (
              <Image source={{ uri: user.profilePhotoUri }} style={styles.userAvatar} />
            ) : (
              <View style={[styles.userAvatar, styles.userAvatarPlaceholder]}>
                <Ionicons name="person" size={18} color={Colors.textMuted} />
              </View>
            )}
            <View>
              <Text style={styles.userName}>{user?.name}</Text>
              <Text style={styles.userRole}>{user?.role} · {user?.courseName || t("reg_courseUnset")}</Text>
            </View>
          </View>
        </View>

        {/* 레이저 모드 */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>레이저 보조</Text>
          <View style={styles.laserToggleRow}>
            {([false, true] as const).map((val) => (
              <Pressable
                key={String(val)}
                style={[styles.laserOption, hasLaser === val && styles.laserOptionActive]}
                onPress={() => { setHasLaser(val); Haptics.selectionAsync(); }}
              >
                <Ionicons
                  name={val ? "flashlight" : "flashlight-outline"}
                  size={15}
                  color={hasLaser === val ? Colors.primary : Colors.textMuted}
                />
                <Text style={[styles.laserOptionText, hasLaser === val && styles.laserOptionTextActive]}>
                  {val ? "레이저 있음" : "레이저 없음"}
                </Text>
              </Pressable>
            ))}
          </View>
          {hasLaser && (
            <Text style={styles.laserAngleHint}>각도는 카메라 촬영 화면에서 선택하세요</Text>
          )}
        </View>

        <View style={styles.section}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Text style={styles.sectionTitle}>{t("reg_photoSection")}</Text>
            <Pressable
              onPress={() => setShowPhotoGuide(true)}
              style={styles.guideBtn}
            >
              <Ionicons name="help-circle-outline" size={15} color={Colors.primary} />
              <Text style={styles.guideBtnText}>{t("reg_photoGuideTitle")}</Text>
            </Pressable>
          </View>
          <Text style={styles.photoHintText}>{t("reg_photoHint")}</Text>
          {(["front", "side", "back"] as PhotoSlot[]).map((slot) => {
            const info = PHOTO_SLOT_INFO[slot];
            const uri = photos[slot];
            return (
              <View key={slot} style={styles.photoSlotWrapper}>
                <View style={styles.photoSlotHeader}>
                  <View>
                    <Text style={styles.photoSlotLabel}>
                      {info.label}
                      {info.required && <Text style={styles.required}> *</Text>}
                    </Text>
                    <Text style={styles.photoSlotSub}>{info.subtitle}</Text>
                  </View>
                  {uri && (
                    <Pressable onPress={() => setPhotos(prev => ({ ...prev, [slot]: null }))} style={styles.removeBtn}>
                      <Ionicons name="close-circle" size={20} color={Colors.danger} />
                    </Pressable>
                  )}
                </View>
                {uri ? (
                  <View style={styles.photoPreview}>
                    <Image
                      source={{ uri }}
                      style={StyleSheet.absoluteFill}
                      contentFit="cover"
                    />
                    <Pressable
                      style={StyleSheet.absoluteFill}
                      onPress={() => showPickerAlert(slot)}
                    />
                    <View style={styles.photoOverlay} pointerEvents="none">
                      <Ionicons name="pencil" size={16} color="#fff" />
                      <Text style={styles.photoOverlayText}>{t("reg_change")}</Text>
                    </View>
                  </View>
                ) : (
                  <Pressable
                    style={[styles.photoAddBtn, !info.required && { opacity: 0.65, borderColor: Colors.textMuted }]}
                    onPress={() => showPickerAlert(slot)}
                  >
                    <Ionicons name="add-circle-outline" size={28} color={info.required ? Colors.primary : Colors.textMuted} />
                    <Text style={[styles.photoAddBtnText, { color: info.required ? Colors.primary : Colors.textMuted }]}>
                      {info.required ? `${t("photo_addPhoto")} (${t("required")})` : `${t("photo_addPhoto")} (${t("optional")})`}
                    </Text>
                  </Pressable>
                )}
              </View>
            );
          })}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("photo_weldProcess")}</Text>
          <ChipSelect options={PROCESSES} selected={process} onSelect={setProcess} />
          {process === "기타" && (
            <TextInput
              style={styles.customInput}
              placeholder={t("photo_weldProcess")}
              placeholderTextColor={Colors.textMuted}
              value={processCustom}
              onChangeText={setProcessCustom}
            />
          )}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("photo_weldPosture")}</Text>
          <ChipSelect options={POSTURES} selected={posture} onSelect={handlePostureSelect} />
          {posture === "기타" && (
            <TextInput
              style={styles.customInput}
              placeholder={t("photo_weldPosture")}
              placeholderTextColor={Colors.textMuted}
              value={postureCustom}
              onChangeText={setPostureCustom}
            />
          )}
          <Pressable
            style={styles.filletRow}
            onPress={() => { setIsFillet(v => !v); Haptics.selectionAsync(); }}
          >
            <Ionicons
              name={isFillet ? "checkbox" : "square-outline"}
              size={20}
              color={isFillet ? Colors.primary : Colors.textMuted}
            />
            <Text style={[styles.filletLabel, isFillet && { color: Colors.primary }]}>
              필렛(Fillet) 용접
            </Text>
          </Pressable>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("photo_weldMaterial")}</Text>
          <ChipSelect options={MATERIALS} selected={material} onSelect={setMaterial} />
          {material === "기타" && (
            <TextInput
              style={styles.customInput}
              placeholder={t("photo_weldMaterial")}
              placeholderTextColor={Colors.textMuted}
              value={materialCustom}
              onChangeText={setMaterialCustom}
            />
          )}
          {material.includes("배관") && (
            <View style={[styles.thicknessRow, { marginTop: 10 }]}>
              <Ionicons name="ellipse-outline" size={15} color={Colors.textMuted} />
              <Text style={styles.thicknessLabel}>{t("reg_pipeOuterDiameter")}</Text>
              <Pressable
                onPress={() => setShowPipeGuide(true)}
                style={({ pressed }) => [styles.pipeGuideBtn, pressed && { opacity: 0.7 }]}
                hitSlop={6}
              >
                <Ionicons name="information-circle-outline" size={14} color={Colors.primary} />
                <Text style={styles.pipeGuideBtnText}>{t("reg_pipeSpec")}</Text>
              </Pressable>
              <TextInput
                style={styles.thicknessInput}
                placeholder="예: 100"
                placeholderTextColor={Colors.textMuted}
                keyboardType="decimal-pad"
                value={pipeOuterDiameter}
                onChangeText={setPipeOuterDiameter}
                maxLength={6}
                numberOfLines={1}
              />
              <Text style={styles.thicknessUnit}>mm</Text>
            </View>
          )}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("photo_selfScore")} (0~100) <Text style={styles.required}>*</Text></Text>
          <View style={styles.scoreInputRow}>
            <View style={styles.scoreInputWrapper}>
              <TextInput
                style={styles.scoreInput}
                placeholder="0~100"
                placeholderTextColor={Colors.textMuted}
                keyboardType="number-pad"
                value={selfScore}
                onChangeText={(v) => {
                  const n = parseInt(v);
                  if (!v) setSelfScore("");
                  else if (!isNaN(n) && n >= 0 && n <= 100) setSelfScore(v);
                }}
                maxLength={3}
                numberOfLines={1}
              />
              <Text style={styles.scoreUnit}>점</Text>
            </View>
            {selfScoreNum > 0 && (
              <View style={[styles.scoreBadge, { backgroundColor: getGradeColor(selfScoreNum) + "33", borderColor: getGradeColor(selfScoreNum) }]}>
                <Text style={[styles.scoreBadgeText, { color: getGradeColor(selfScoreNum) }]}>
                  자체 {getGrade(selfScoreNum)}
                </Text>
              </View>
            )}
          </View>
          <Text style={styles.scoreHint}>
            AI 분석 결과와 비교하여 자기 평가 정확도를 확인할 수 있습니다
          </Text>
        </View>
      </KeyboardAwareScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
        {/* 1단계: 분석 모드 선택 */}
        <View style={styles.modeSelector}>
          <Pressable
            style={[styles.modeOption, analysisMode === "quick" && styles.modeOptionActive]}
            onPress={() => { setAnalysisMode("quick"); Haptics.selectionAsync(); }}
          >
            <Ionicons name="flash-outline" size={14} color={analysisMode === "quick" ? Colors.primary : Colors.textMuted} />
            <Text style={[styles.modeOptionText, analysisMode === "quick" && styles.modeOptionTextActive]}>빠른 측정</Text>
          </Pressable>
          <Pressable
            style={[styles.modeOption, analysisMode === "ai" && styles.modeOptionActive]}
            onPress={() => { setAnalysisMode("ai"); Haptics.selectionAsync(); }}
          >
            <MaterialCommunityIcons name="robot-outline" size={14} color={analysisMode === "ai" ? Colors.primary : Colors.textMuted} />
            <Text style={[styles.modeOptionText, analysisMode === "ai" && styles.modeOptionTextActive]}>AI 종합 분석</Text>
          </Pressable>
        </View>

        {/* 2단계: AI 모델 선택 (AI 종합 분석 선택 시에만 표시) */}
        {analysisMode === "ai" && (
          <View style={styles.aiSelector}>
            <Pressable
              style={[styles.aiOption, selectedAI === "gpt-4o" && styles.aiOptionActive]}
              onPress={() => setSelectedAI("gpt-4o")}
            >
              <Text style={[styles.aiOptionText, selectedAI === "gpt-4o" && styles.aiOptionTextActive]}>GPT-4o</Text>
              <Text style={[styles.aiOptionSub, selectedAI === "gpt-4o" && styles.aiOptionSubActive]}>OpenAI</Text>
            </Pressable>
            <Pressable
              style={[styles.aiOption, selectedAI === "claude-sonnet" && styles.aiOptionActive]}
              onPress={() => setSelectedAI("claude-sonnet")}
            >
              <Text style={[styles.aiOptionText, selectedAI === "claude-sonnet" && styles.aiOptionTextActive]}>Claude Sonnet</Text>
              <Text style={[styles.aiOptionSub, selectedAI === "claude-sonnet" && styles.aiOptionSubActive]}>Anthropic</Text>
            </Pressable>
          </View>
        )}

        <Pressable
          style={({ pressed }) => [styles.submitBtn, pressed && { opacity: 0.85 }, isAnalyzing && { opacity: 0.6 }]}
          onPress={handleSubmit}
          disabled={isAnalyzing}
        >
          <LinearGradient
            colors={isAnalyzing ? [Colors.textMuted, Colors.textMuted] : [Colors.primary, Colors.primaryDark]}
            style={styles.submitBtnGrad}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
          >
            {isAnalyzing ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 8 }}>
                <ActivityIndicator color="#fff" />
                <Text style={[styles.submitBtnText, { flexShrink: 1 }]} numberOfLines={1}>
                  {analysisStage || t("reg_aiAnalyzingDefault")}
                </Text>
              </View>
            ) : (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <MaterialCommunityIcons name="robot-outline" size={20} color="#fff" />
                <Text style={styles.submitBtnText}>{t("reg_submitBtn")}</Text>
              </View>
            )}
          </LinearGradient>
        </Pressable>
      </View>

      <Modal visible={showPhotoGuide} transparent animationType="slide" onRequestClose={() => setShowPhotoGuide(false)}>
        <View style={styles.guideOverlay}>
          <View style={styles.guideModal}>
            <View style={styles.guideModalHeader}>
              <Ionicons name="images-outline" size={20} color={Colors.primary} />
              <Text style={styles.guideModalTitle}>{t("reg_photoGuideTitle")}</Text>
              <Pressable onPress={() => setShowPhotoGuide(false)}>
                <Ionicons name="close" size={22} color={Colors.textMuted} />
              </Pressable>
            </View>
            <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: 520 }} contentContainerStyle={{ padding: 12, gap: 14 }}>
              <View style={styles.exampleCard}>
                <Image
                  source={require("@/assets/images/example_pipe.jpg")}
                  style={styles.exampleImage}
                  contentFit="cover"
                />
              </View>
              <View style={styles.exampleCard}>
                <Image
                  source={require("@/assets/images/example_plate.jpg")}
                  style={styles.exampleImage}
                  contentFit="cover"
                />
              </View>
            </ScrollView>
            <Pressable style={styles.guideCloseBtn} onPress={() => setShowPhotoGuide(false)}>
              <Text style={styles.guideCloseBtnText}>{t("close")}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal visible={showPipeGuide} transparent animationType="slide" onRequestClose={() => setShowPipeGuide(false)}>
        <View style={styles.guideOverlay}>
          <View style={styles.guideModal}>
            <View style={styles.guideModalHeader}>
              <Ionicons name="ellipse-outline" size={20} color={Colors.primary} />
              <Text style={styles.guideModalTitle}>{t("reg_pipeGuideTitle")}</Text>
              <Pressable onPress={() => setShowPipeGuide(false)}>
                <Ionicons name="close" size={22} color={Colors.textMuted} />
              </Pressable>
            </View>
            <Text style={styles.pipeGuideHelp}>{t("reg_pipeHelp")}</Text>
            <View style={styles.pipeTableHeader}>
              <Text style={[styles.pipeColNom, styles.pipeHeaderText, styles.pipeColNomRed]}>호칭(A)</Text>
              <Text style={[styles.pipeColNomB, styles.pipeHeaderText, styles.pipeColNomRed]}>호칭(B)</Text>
              <Text style={[styles.pipeColOd, styles.pipeHeaderText]}>일반(mm)</Text>
              <Text style={[styles.pipeColOd, styles.pipeHeaderText]}>STS(mm)</Text>
            </View>
            <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: 380 }}>
              {[
                { a: "25A",  b: '1"',      od: 34.0,  ods: 34.0  },
                { a: "32A",  b: '1 1/4"',  od: 42.7,  ods: 42.7  },
                { a: "40A",  b: '1 1/2"',  od: 48.6,  ods: 48.6  },
                { a: "50A",  b: '2"',      od: 60.5,  ods: 60.5  },
                { a: "65A",  b: '2 1/2"',  od: 76.3,  ods: 76.3  },
                { a: "80A",  b: '3"',      od: 89.1,  ods: 89.1  },
                { a: "90A",  b: '3 1/2"',  od: 101.6, ods: 101.6 },
                { a: "100A", b: '4"',      od: 114.3, ods: 114.3 },
                { a: "125A", b: '5"',      od: 139.8, ods: 139.8 },
                { a: "150A", b: '6"',      od: 165.2, ods: 165.2 },
                { a: "200A", b: '8"',      od: 216.3, ods: 216.3 },
                { a: "250A", b: '10"',     od: 267.4, ods: 273.0 },
                { a: "300A", b: '12"',     od: 318.5, ods: 323.9 },
              ].map((row) => {
                const isStainless = material.includes("스테인리스");
                const useOd = isStainless ? row.ods : row.od;
                return (
                  <Pressable
                    key={row.a}
                    style={({ pressed }) => [styles.pipeRow, pressed && { backgroundColor: Colors.primary + "18" }]}
                    onPress={() => {
                      setPipeOuterDiameter(String(useOd));
                      setShowPipeGuide(false);
                    }}
                  >
                    <Text style={[styles.pipeColNom, styles.pipeRowText, styles.pipeColNomRed]}>{row.a}</Text>
                    <Text style={[styles.pipeColNomB, styles.pipeRowText, styles.pipeColNomRed]}>{row.b}</Text>
                    <Text style={[styles.pipeColOd, styles.pipeRowText, !isStainless && styles.pipeColOdActive]}>{row.od.toFixed(1)}</Text>
                    <Text style={[styles.pipeColOd, styles.pipeRowText, isStainless && styles.pipeColOdActive]}>{row.ods.toFixed(1)}</Text>
                  </Pressable>
                );
              })}
              <Text style={styles.pipeFootnote}>{t("reg_pipeFootnote")}</Text>
            </ScrollView>
            <Pressable style={styles.guideCloseBtn} onPress={() => setShowPipeGuide(false)}>
              <Text style={styles.guideCloseBtnText}>{t("close")}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* ArUco 가이드 카메라 모달 */}
      <WeldCameraModal
        visible={cameraSlot !== null}
        onClose={() => setCameraSlot(null)}
        onCapture={handleCameraCapture}
        hasLaser={hasLaser}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  backBtn: { padding: 8 },
  headerTitle: { color: Colors.text, fontFamily: "Inter_700Bold", fontSize: 18 },
  content: { paddingHorizontal: 20, paddingTop: 20, gap: 24 },
  section: { gap: 12 },
  sectionTitle: {
    color: Colors.text,
    fontFamily: "Inter_600SemiBold",
    fontSize: 15,
  },
  required: { color: Colors.danger, fontSize: 12 },
  userRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  userAvatar: { width: 44, height: 44, borderRadius: 22 },
  userAvatarPlaceholder: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  userName: { color: Colors.text, fontFamily: "Inter_600SemiBold", fontSize: 15 },
  userRole: { color: Colors.textSecondary, fontFamily: "Inter_400Regular", fontSize: 12, marginTop: 2 },
  photoHintText: { color: Colors.danger, fontFamily: "Inter_700Bold", fontSize: 13, lineHeight: 18 },
  photoSlotWrapper: { gap: 8 },
  photoSlotHeader: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" },
  photoSlotLabel: { color: Colors.text, fontFamily: "Inter_600SemiBold", fontSize: 14 },
  photoSlotSub: { color: Colors.textMuted, fontFamily: "Inter_400Regular", fontSize: 11, marginTop: 2 },
  removeBtn: { padding: 4 },
  photoAddBtn: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 22,
    gap: 8,
    flexDirection: "row",
  },
  photoAddBtnText: { fontFamily: "Inter_500Medium", fontSize: 14 },
  photoPreview: {
    borderRadius: 12,
    overflow: "hidden",
    height: PHOTO_H,
    backgroundColor: Colors.surface,
  },
  photoOverlay: {
    position: "absolute",
    bottom: 10,
    right: 10,
    backgroundColor: "rgba(0,0,0,0.6)",
    borderRadius: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  photoOverlayText: { color: "#fff", fontFamily: "Inter_500Medium", fontSize: 12 },
  customInput: {
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: Colors.text,
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    marginTop: 4,
  },
  scoreInputRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  scoreInputWrapper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 16,
    height: 52,
    gap: 8,
    overflow: "hidden",
  },
  scoreInput: {
    width: 80,
    height: 52,
    color: Colors.text,
    fontFamily: "Inter_700Bold",
    fontSize: 22,
    textAlign: "center",
  },
  scoreUnit: { color: Colors.textSecondary, fontFamily: "Inter_500Medium", fontSize: 15 },
  scoreBadge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  scoreBadgeText: { fontFamily: "Inter_700Bold", fontSize: 14 },
  scoreHint: {
    color: Colors.textMuted,
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    lineHeight: 18,
  },
  aiSelector: {
    flexDirection: "row",
    gap: 10,
  },
  aiOption: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: Colors.border,
    alignItems: "center",
    backgroundColor: Colors.card,
  },
  aiOptionActive: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primary + "15",
  },
  aiOptionText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
    color: Colors.textMuted,
  },
  aiOptionTextActive: {
    color: Colors.primary,
  },
  aiOptionSub: {
    fontFamily: "Inter_400Regular",
    fontSize: 10,
    color: Colors.textMuted,
    marginTop: 1,
  },
  aiOptionSubActive: {
    color: Colors.primary + "CC",
  },
  modeSelector: { flexDirection: "row", gap: 8 },
  modeOption: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 6, paddingVertical: 9, borderRadius: 10,
    borderWidth: 1.5, borderColor: Colors.border, backgroundColor: Colors.card,
  },
  modeOptionActive: { borderColor: Colors.primary, backgroundColor: Colors.primary + "15" },
  modeOptionText: { color: Colors.textMuted, fontFamily: "Inter_600SemiBold", fontSize: 13 },
  modeOptionTextActive: { color: Colors.primary },
  footer: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 20,
    paddingTop: 12,
    gap: 8,
    backgroundColor: Colors.bg + "EE",
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  submitBtn: { borderRadius: 14, overflow: "hidden" },
  submitBtnGrad: { height: 56, alignItems: "center", justifyContent: "center" },
  submitBtnText: { color: "#fff", fontFamily: "Inter_700Bold", fontSize: 16 },
  guideBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: Colors.primary + "18",
    borderWidth: 1,
    borderColor: Colors.primary + "44",
  },
  guideBtnText: {
    color: Colors.primary,
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
  },
  pipeGuideBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: Colors.primary + "18",
    borderWidth: 1,
    borderColor: Colors.primary + "44",
  },
  pipeGuideBtnText: { color: Colors.primary, fontFamily: "Inter_600SemiBold", fontSize: 11 },
  pipeGuideHelp: {
    color: Colors.danger, fontFamily: "Inter_600SemiBold", fontSize: 12,
    paddingHorizontal: 16, paddingVertical: 8,
  },
  pipeColNomRed: { color: Colors.danger },
  exampleCard: {
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  exampleImage: {
    width: "100%",
    aspectRatio: 3 / 4,
  },
  pipeTableHeader: {
    flexDirection: "row", alignItems: "center",
    paddingVertical: 8, paddingHorizontal: 12,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  pipeHeaderText: { color: Colors.textMuted, fontFamily: "Inter_600SemiBold", fontSize: 12 },
  pipeRow: {
    flexDirection: "row", alignItems: "center",
    paddingVertical: 11, paddingHorizontal: 12,
    borderBottomWidth: 1, borderBottomColor: Colors.border + "60",
  },
  pipeRowText: { color: Colors.text, fontFamily: "Inter_500Medium", fontSize: 13 },
  pipeColNom:  { width: 56, textAlign: "left" },
  pipeColNomB: { width: 64, textAlign: "left" },
  pipeColOd:   { flex: 1, textAlign: "right" },
  pipeColOdActive: { color: Colors.primary, fontFamily: "Inter_700Bold" },
  pipeFootnote: {
    color: Colors.textMuted, fontFamily: "Inter_400Regular", fontSize: 11,
    paddingHorizontal: 12, paddingVertical: 10,
  },
  thicknessRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 10,
    paddingHorizontal: 4,
  },
  thicknessLabel: {
    color: Colors.textMuted,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    flex: 1,
  },
  thicknessInput: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 0,
    color: Colors.text,
    fontFamily: "Inter_500Medium",
    fontSize: 14,
    lineHeight: 20,
    width: 80,
    minHeight: 40,
    textAlign: "right",
    textAlignVertical: "center",
    includeFontPadding: false,
  },
  thicknessUnit: {
    color: Colors.textMuted,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    width: 24,
  },
  guideOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.65)",
    justifyContent: "flex-end",
  },
  guideModal: {
    backgroundColor: Colors.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    gap: 14,
    borderTopWidth: 1,
    borderColor: Colors.border,
  },
  guideModalHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  guideModalTitle: {
    flex: 1,
    color: Colors.text,
    fontFamily: "Inter_700Bold",
    fontSize: 16,
  },
  guideSectionBlock: {
    gap: 6,
    marginBottom: 10,
  },
  guideSectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 2,
  },
  guideSectionTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 14,
  },
  guideItem: {
    flexDirection: "row",
    gap: 6,
    paddingLeft: 4,
  },
  guideBullet: {
    color: Colors.textMuted,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    lineHeight: 20,
  },
  guideItemText: {
    flex: 1,
    color: Colors.textSecondary,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    lineHeight: 20,
  },
  guideCloseBtn: {
    backgroundColor: Colors.primary,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: "center",
    marginTop: 4,
    marginBottom: 6,
  },
  guideCloseBtnText: {
    color: "#fff",
    fontFamily: "Inter_700Bold",
    fontSize: 15,
  },

  // 필렛
  filletRow: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingVertical: 8, paddingHorizontal: 4,
  },
  filletLabel: {
    color: Colors.textSecondary,
    fontFamily: "Inter_500Medium",
    fontSize: 14,
  },

  // 레이저
  laserToggleRow: { flexDirection: "row", gap: 10 },
  laserOption: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 6, paddingVertical: 10, borderRadius: 10,
    borderWidth: 1, borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  laserOptionActive: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primary + "18",
  },
  laserOptionText: { color: Colors.textMuted, fontFamily: "Inter_500Medium", fontSize: 13 },
  laserOptionTextActive: { color: Colors.primary },
  laserAngleHint: {
    color: Colors.textMuted,
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    fontStyle: "italic",
    paddingLeft: 2,
  },
});
