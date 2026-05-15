import React, { useRef, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  Modal,
  Pressable,
  Dimensions,
  Platform,
  ActivityIndicator,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Colors from "@/constants/colors";
import { useLanguage } from "@/context/LanguageContext";

interface Props {
  visible: boolean;
  onClose: () => void;
  onCapture: (uri: string) => void;
}

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");

// 가이드 영역 좌표 계산 (Flutter 코드 기준)
const CENTER_W = SCREEN_W * 0.75;
const CENTER_H = SCREEN_H * 0.48;
const CENTER_X = (SCREEN_W - CENTER_W) / 2;
const CENTER_Y = (SCREEN_H - CENTER_H) / 2 - 20;

// ArUco 마커 가이드 (용접 비드 영역 우측 상단)
const MARKER_SIZE = 70;
const MARKER_X = CENTER_X + CENTER_W - MARKER_SIZE - 10;
const MARKER_Y = CENTER_Y + 14;

// 꺾쇠 길이
const CORNER_LEN = 18;
const CORNER_THICK = 3;

export default function WeldCameraModal({ visible, onClose, onCapture }: Props) {
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();
  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [isTaking, setIsTaking] = useState(false);

  const handleCapture = useCallback(async () => {
    if (!cameraRef.current || isTaking) return;
    setIsTaking(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.85,
        skipProcessing: false,
      });
      if (photo?.uri) {
        onCapture(photo.uri);
      }
    } catch (e) {
      console.warn("촬영 실패:", e);
    } finally {
      setIsTaking(false);
    }
  }, [isTaking, onCapture]);

  const renderContent = () => {
    if (Platform.OS === "web") {
      return (
        <View style={styles.center}>
          <Text style={styles.webMsg}>{t("camera_webMsg")}</Text>
          <Pressable onPress={onClose} style={styles.closeWebBtn}>
            <Text style={{ color: Colors.primary }}>{t("close")}</Text>
          </Pressable>
        </View>
      );
    }

    if (!permission) {
      return <View style={styles.center}><ActivityIndicator color="#fff" /></View>;
    }

    if (!permission.granted) {
      return (
        <View style={styles.center}>
          <Ionicons name="camera-outline" size={48} color="#fff" style={{ marginBottom: 16 }} />
          <Text style={styles.permText}>{t("camera_permNeeded")}</Text>
          <Pressable onPress={requestPermission} style={styles.permBtn}>
            <Text style={styles.permBtnText}>{t("camera_permAllow")}</Text>
          </Pressable>
          <Pressable onPress={onClose} style={{ marginTop: 12 }}>
            <Text style={{ color: "rgba(255,255,255,0.6)", fontSize: 14 }}>{t("cancel")}</Text>
          </Pressable>
        </View>
      );
    }

    return (
      <>
        {/* 카메라 프리뷰 */}
        <CameraView
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          facing="back"
        />

        {/* ── 가이드 오버레이 (4방향 어두운 마스크) ── */}
        {/* 상단 */}
        <View style={[styles.mask, { top: 0, left: 0, right: 0, height: CENTER_Y }]} />
        {/* 하단 */}
        <View style={[styles.mask, { top: CENTER_Y + CENTER_H, left: 0, right: 0, bottom: 0 }]} />
        {/* 좌측 */}
        <View style={[styles.mask, { top: CENTER_Y, left: 0, width: CENTER_X, height: CENTER_H }]} />
        {/* 우측 */}
        <View style={[styles.mask, { top: CENTER_Y, left: CENTER_X + CENTER_W, right: 0, height: CENTER_H }]} />

        {/* ── 용접 비드 영역 테두리 (초록색 꺾쇠) ── */}
        <CornerBrackets
          x={CENTER_X} y={CENTER_Y} w={CENTER_W} h={CENTER_H}
          color="#00FF88" thick={CORNER_THICK} len={CORNER_LEN * 1.8}
        />

        {/* ── ArUco 마커 가이드 (노란색 꺾쇠 + 라벨) ── */}
        <CornerBrackets
          x={MARKER_X} y={MARKER_Y} w={MARKER_SIZE} h={MARKER_SIZE}
          color="#FFD700" thick={CORNER_THICK} len={CORNER_LEN}
        />
        <View style={[styles.markerLabel, { left: MARKER_X, top: MARKER_Y + MARKER_SIZE + 4 }]}>
          <Text style={styles.markerLabelText}>ArUco 30mm</Text>
        </View>

        {/* ── 안내 텍스트 ── */}
        <View style={[styles.instructionBox, { top: insets.top + 16 }]}>
          <Text style={styles.instructionText}>
            {t("camera_arucoInstr")}
          </Text>
        </View>

        {/* ── 하단: 닫기 + 촬영 버튼 ── */}
        <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 20 }]}>
          <Pressable onPress={onClose} style={styles.sideBtn} hitSlop={12}>
            <Ionicons name="close" size={30} color="#fff" />
          </Pressable>

          <Pressable
            onPress={handleCapture}
            disabled={isTaking}
            style={({ pressed }) => [styles.captureBtn, pressed && { opacity: 0.8 }]}
          >
            {isTaking
              ? <ActivityIndicator color="#000" size="small" />
              : <View style={styles.captureBtnInner} />
            }
          </Pressable>

          <View style={styles.sideBtn} />
        </View>
      </>
    );
  };

  return (
    <Modal visible={visible} animationType="slide" statusBarTranslucent onRequestClose={onClose}>
      <View style={styles.container}>
        {renderContent()}
      </View>
    </Modal>
  );
}

// 꺾쇠(L자) 코너 가이드 컴포넌트
function CornerBrackets({
  x, y, w, h, color, thick, len,
}: {
  x: number; y: number; w: number; h: number;
  color: string; thick: number; len: number;
}) {
  const corners = [
    { top: y, left: x },
    { top: y, left: x + w - len },
    { top: y + h - thick, left: x },
    { top: y + h - thick, left: x + w - len },
  ];

  return (
    <>
      {/* 수평 바 4개 */}
      {corners.map((c, i) => (
        <View key={`h${i}`} style={{
          position: "absolute", top: c.top, left: c.left,
          width: len, height: thick, backgroundColor: color,
        }} />
      ))}

      {/* 수직 바 4개 */}
      {[
        { top: y, left: x },
        { top: y, left: x + w - thick },
        { top: y + h - len, left: x },
        { top: y + h - len, left: x + w - thick },
      ].map((c, i) => (
        <View key={`v${i}`} style={{
          position: "absolute", top: c.top, left: c.left,
          width: thick, height: len, backgroundColor: color,
        }} />
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#000",
    padding: 32,
  },
  mask: {
    position: "absolute",
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  instructionBox: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 10,
  },
  instructionText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
    textAlign: "center",
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: "rgba(0,0,0,0.65)",
    borderRadius: 10,
    overflow: "hidden",
    lineHeight: 22,
  },
  markerLabel: {
    position: "absolute",
    backgroundColor: "rgba(0,0,0,0.7)",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  markerLabelText: {
    color: "#FFD700",
    fontSize: 10,
    fontWeight: "700",
  },
  bottomBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 40,
    paddingTop: 20,
  },
  sideBtn: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  captureBtn: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 4,
    borderColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.15)",
  },
  captureBtnInner: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "#fff",
  },
  permText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 20,
    textAlign: "center",
  },
  permBtn: {
    backgroundColor: Colors.primary,
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 10,
  },
  permBtnText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "700",
  },
  webMsg: {
    color: "#fff",
    fontSize: 16,
    marginBottom: 20,
    textAlign: "center",
  },
  closeWebBtn: {
    backgroundColor: "#fff",
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 8,
  },
});
