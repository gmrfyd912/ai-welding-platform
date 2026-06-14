import React from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import Colors from "@/constants/colors";

// 뼈대 UI — 실시간 현장 검사 화면
// TODO: 카메라 촬영, 전류/전압 입력, 실시간 결함 분석 연동
export default function InspectionScreen() {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.container, { paddingTop: insets.top + 16 }]}>
      <Text style={styles.title}>실시간 현장 검사</Text>
      <Text style={styles.subtitle}>용접부 촬영 및 전류·전압 입력</Text>

      {/* 카메라 촬영 영역 */}
      <View style={styles.cameraPlaceholder}>
        <Ionicons name="camera-outline" size={64} color={Colors.textMuted} />
        <Text style={styles.placeholderText}>카메라 촬영 영역</Text>
        <Text style={styles.placeholderSub}>촬영 버튼을 눌러 용접부를 스캔하세요</Text>
      </View>

      {/* 전류/전압 입력 영역 */}
      <View style={styles.inputRow}>
        <View style={styles.inputCard}>
          <Ionicons name="flash-outline" size={24} color={Colors.warning} />
          <Text style={styles.inputLabel}>전류 (A)</Text>
          <Text style={styles.inputValue}>— —</Text>
        </View>
        <View style={styles.inputCard}>
          <Ionicons name="thunderstorm-outline" size={24} color={Colors.primary} />
          <Text style={styles.inputLabel}>전압 (V)</Text>
          <Text style={styles.inputValue}>— —</Text>
        </View>
      </View>

      <Pressable style={styles.shootBtn}>
        <Ionicons name="camera" size={22} color="#fff" />
        <Text style={styles.shootBtnText}>촬영 및 검사 시작</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.bg,
    paddingHorizontal: 20,
    paddingBottom: 100,
    gap: 16,
  },
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
  cameraPlaceholder: {
    flex: 1,
    backgroundColor: Colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.border,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  placeholderText: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: Colors.textMuted,
  },
  placeholderSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.textMuted,
    textAlign: "center",
    paddingHorizontal: 32,
  },
  inputRow: {
    flexDirection: "row",
    gap: 12,
  },
  inputCard: {
    flex: 1,
    backgroundColor: Colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 16,
    alignItems: "center",
    gap: 4,
  },
  inputLabel: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: Colors.textSecondary,
  },
  inputValue: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: Colors.text,
  },
  shootBtn: {
    backgroundColor: Colors.success,
    borderRadius: 14,
    paddingVertical: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  shootBtnText: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: "#fff",
  },
});
