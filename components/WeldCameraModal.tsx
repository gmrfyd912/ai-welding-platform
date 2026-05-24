import React, { useRef, useState, useCallback, useEffect } from "react";
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
import { DeviceMotion } from "expo-sensors";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Colors from "@/constants/colors";
import { useLanguage } from "@/context/LanguageContext";

interface Props {
  visible: boolean;
  onClose: () => void;
  onCapture: (uri: string, laserAngleDeg?: number) => void;
  hasLaser: boolean;
}

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");

const GAUGE_H = SCREEN_H * 0.42;
const GAUGE_W = 28;
const GAUGE_MIN = 0;
const GAUGE_MAX = 90;
const ANGLE_OPTIONS = [30, 45, 60] as const;
type AngleOption = typeof ANGLE_OPTIONS[number];

export default function WeldCameraModal({ visible, onClose, onCapture, hasLaser }: Props) {
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();
  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [isTaking, setIsTaking] = useState(false);
  const [currentAngle, setCurrentAngle] = useState(45);
  const [selectedAngle, setSelectedAngle] = useState<AngleOption>(45);

  useEffect(() => {
    if (!visible || !hasLaser || Platform.OS === "web") return;
    DeviceMotion.setUpdateInterval(150);
    const sub = DeviceMotion.addListener((data) => {
      const { beta = 0, gamma = 0 } = data.rotation ?? {};
      const betaDeg = Math.abs((beta * 180) / Math.PI);
      const gammaDeg = Math.abs((gamma * 180) / Math.PI);
      setCurrentAngle(Math.round(Math.max(betaDeg, gammaDeg)));
    });
    return () => sub.remove();
  }, [visible, hasLaser]);

  const handleCapture = useCallback(async () => {
    if (!cameraRef.current || isTaking) return;
    setIsTaking(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.85,
        skipProcessing: false,
      });
      if (photo?.uri) onCapture(photo.uri, hasLaser ? selectedAngle : undefined);
    } catch (e) {
      console.warn("촬영 실패:", e);
    } finally {
      setIsTaking(false);
    }
  }, [isTaking, onCapture, hasLaser, selectedAngle]);

  const angleOk = hasLaser && Math.abs(currentAngle - selectedAngle) <= 3;
  const badgeColor = angleOk ? Colors.success : Colors.warning;

  const angleToY = (deg: number) =>
    GAUGE_H - ((Math.max(GAUGE_MIN, Math.min(GAUGE_MAX, deg)) - GAUGE_MIN) / (GAUGE_MAX - GAUGE_MIN)) * GAUGE_H;
  const needleY = angleToY(currentAngle);
  const targetY = angleToY(selectedAngle);
  const tolerancePx = (3 / (GAUGE_MAX - GAUGE_MIN)) * GAUGE_H;

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
        <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" />

        {/* ── 상단 안내 텍스트 ── */}
        <View style={[styles.instructionBox, { top: insets.top + 12 }]}>
          <Text style={styles.instructionText}>
            비드와 아루코마커가 프레임 안에 들어오도록 촬영하세요
          </Text>
        </View>

        {/* ── 레이저 있을 때만: 각도 뱃지 + 게이지 ── */}
        {hasLaser && (
          <>
            {/* 각도 상태 뱃지 */}
            <View
              style={[
                styles.angleBadge,
                {
                  top: insets.top + 56,
                  borderColor: badgeColor + "88",
                  backgroundColor: badgeColor + "22",
                },
              ]}
            >
              <Ionicons
                name={angleOk ? "checkmark-circle" : "alert-circle-outline"}
                size={14}
                color={badgeColor}
              />
              <Text style={[styles.angleBadgeText, { color: badgeColor }]}>
                {angleOk
                  ? `✓ ${currentAngle}° 각도 맞음`
                  : `현재 ${currentAngle}° → 목표 ${selectedAngle}°`}
              </Text>
            </View>

            {/* 우측 세로 각도 게이지 */}
            <View style={[styles.gaugeContainer, { top: (SCREEN_H - GAUGE_H) / 2, right: 14 }]}>
              <View style={styles.gaugeTrack} />
              <View
                style={[
                  styles.gaugeOkZone,
                  { top: Math.max(0, targetY - tolerancePx), height: tolerancePx * 2 },
                ]}
              />
              <View style={[styles.gaugeTargetLine, { top: targetY }]} />
              <Text style={[styles.gaugeTargetLabel, { top: targetY - 16 }]}>
                {selectedAngle}°
              </Text>
              <View
                style={[
                  styles.gaugeNeedle,
                  { top: needleY - 8, backgroundColor: badgeColor, borderColor: badgeColor },
                ]}
              />
              {[0, 45, 90].map((deg) => (
                <Text key={deg} style={[styles.gaugeTick, { top: angleToY(deg) - 7 }]}>
                  {deg}°
                </Text>
              ))}
            </View>
          </>
        )}

        {/* ── 하단: 각도 선택(레이저 시) + 닫기 + 촬영 버튼 ── */}
        <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 20 }]}>
          {/* 레이저 각도 선택 탭 */}
          {hasLaser && (
            <View style={styles.angleTabRow}>
              {ANGLE_OPTIONS.map((deg) => {
                const active = selectedAngle === deg;
                const thisOk = active && angleOk;
                return (
                  <Pressable
                    key={deg}
                    style={[
                      styles.angleTab,
                      active && styles.angleTabActive,
                      thisOk && styles.angleTabOk,
                    ]}
                    onPress={() => setSelectedAngle(deg)}
                  >
                    <Text
                      style={[
                        styles.angleTabText,
                        active && styles.angleTabTextActive,
                        thisOk && styles.angleTabTextOk,
                      ]}
                    >
                      {deg}°
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          )}

          {/* 닫기 + 촬영 */}
          <View style={styles.captureRow}>
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
        </View>
      </>
    );
  };

  return (
    <Modal visible={visible} animationType="slide" statusBarTranslucent onRequestClose={onClose}>
      <View style={styles.container}>{renderContent()}</View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#000",
    padding: 32,
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
  angleBadge: {
    position: "absolute",
    alignSelf: "center",
    left: 0,
    right: 0,
    marginHorizontal: 50,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    zIndex: 10,
  },
  angleBadgeText: {
    fontSize: 14,
    fontWeight: "700",
  },
  gaugeContainer: {
    position: "absolute",
    width: GAUGE_W,
    height: GAUGE_H,
    zIndex: 10,
  },
  gaugeTrack: {
    position: "absolute",
    left: GAUGE_W / 2 - 2,
    top: 0,
    width: 4,
    height: GAUGE_H,
    backgroundColor: "rgba(255,255,255,0.25)",
    borderRadius: 2,
  },
  gaugeOkZone: {
    position: "absolute",
    left: GAUGE_W / 2 - 4,
    width: 8,
    backgroundColor: Colors.success + "55",
    borderRadius: 4,
  },
  gaugeTargetLine: {
    position: "absolute",
    left: 2,
    width: GAUGE_W - 4,
    height: 2,
    backgroundColor: Colors.success,
    borderRadius: 1,
  },
  gaugeTargetLabel: {
    position: "absolute",
    right: GAUGE_W + 2,
    color: Colors.success,
    fontSize: 10,
    fontWeight: "700",
  },
  gaugeNeedle: {
    position: "absolute",
    left: GAUGE_W / 2 - 8,
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
  },
  gaugeTick: {
    position: "absolute",
    right: GAUGE_W + 2,
    color: "rgba(255,255,255,0.5)",
    fontSize: 9,
    fontWeight: "600",
  },
  bottomBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 40,
    paddingTop: 12,
    gap: 16,
    alignItems: "center",
  },
  angleTabRow: {
    flexDirection: "row",
    gap: 12,
    backgroundColor: "rgba(0,0,0,0.55)",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  angleTab: {
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.3)",
    backgroundColor: "rgba(255,255,255,0.1)",
    minWidth: 60,
    alignItems: "center",
  },
  angleTabActive: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primary + "33",
  },
  angleTabOk: {
    borderColor: Colors.success,
    backgroundColor: Colors.success + "33",
  },
  angleTabText: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 15,
    fontWeight: "700",
  },
  angleTabTextActive: {
    color: Colors.primary,
  },
  angleTabTextOk: {
    color: Colors.success,
  },
  captureRow: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
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
  permBtnText: { color: "#fff", fontSize: 15, fontWeight: "700" },
  webMsg: { color: "#fff", fontSize: 16, marginBottom: 20, textAlign: "center" },
  closeWebBtn: {
    backgroundColor: "#fff",
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 8,
  },
});
