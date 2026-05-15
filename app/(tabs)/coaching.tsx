import React from "react";
import { View, Text, StyleSheet, ScrollView, Platform, Pressable } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MaterialCommunityIcons, Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import Colors from "@/constants/colors";

const DESCRIPTION =
  "AI 실시간 코칭은 용접면에 장착된 카메라를 통해 인터렉티브형 AI가 용접되고 있는 용융지를 실시간으로 확인함으로서 용접사에게 아크의 길이, 용접 및 위빙 속도, 용가재 공급, 용융풀의 상태 등 문제가 되고 있는 부분을 실시간으로 코칭해주는 것 입니다.";

export default function CoachingScreen() {
  const insets = useSafeAreaInsets();
  const isWeb = Platform.OS === "web";
  const topPad = (isWeb ? 67 : insets.top) + 16;
  const bottomPad = (isWeb ? 84 : 50 + insets.bottom) + 24;

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: topPad, paddingBottom: bottomPad },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.iconWrap}>
          <LinearGradient
            colors={[Colors.primary, "#7B2FF7"]}
            style={styles.iconBg}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
          >
            <MaterialCommunityIcons name="robot-happy-outline" size={56} color="#fff" />
          </LinearGradient>
        </View>

        <Text style={styles.title}>AI 실시간 코칭</Text>

        <View style={styles.devBadge}>
          <Ionicons name="construct" size={16} color={Colors.gold} />
          <Text style={styles.devText}>열심히 개발중 입니다.</Text>
        </View>

        <View style={styles.descCard}>
          <View style={styles.descHeader}>
            <MaterialCommunityIcons name="information-outline" size={20} color={Colors.primary} />
            <Text style={styles.descTitle}>이런 기능이 들어옵니다</Text>
          </View>
          <Text style={styles.descBody}>{DESCRIPTION}</Text>
        </View>

        <View style={styles.featureList}>
          <FeatureRow icon="camera-outline" label="용접면 카메라로 용융지 실시간 분석" />
          <FeatureRow icon="resize-outline" label="아크의 길이 가이드" />
          <FeatureRow icon="speedometer-outline" label="용접 및 위빙 속도 코칭" />
          <FeatureRow icon="git-network-outline" label="용가재 공급 타이밍 안내" />
          <FeatureRow icon="water-outline" label="용융풀 상태 모니터링" />
        </View>

        {/* 실시간 코칭 시작 */}
        <Pressable
          onPress={() => router.push("/coaching-live")}
          style={({ pressed }) => [styles.liveBtn, pressed && { opacity: 0.9 }]}
        >
          <Ionicons name="play-circle" size={22} color="#fff" />
          <Text style={styles.liveBtnText}>AI 실시간 코칭 시작</Text>
        </Pressable>

        {/* 개발용 테스트 진입 */}
        <Pressable
          onPress={() => router.push("/coaching-test")}
          style={({ pressed }) => [styles.testBtn, pressed && { opacity: 0.85 }]}
        >
          <Ionicons name="flask-outline" size={16} color={Colors.text} />
          <Text style={styles.testBtnText}>내시경 카메라 인식 테스트 (개발용)</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

function FeatureRow({ icon, label }: { icon: keyof typeof Ionicons.glyphMap; label: string }) {
  return (
    <View style={styles.featureRow}>
      <View style={styles.featureIcon}>
        <Ionicons name={icon} size={18} color={Colors.primary} />
      </View>
      <Text style={styles.featureLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  scroll: { paddingHorizontal: 22, alignItems: "stretch" },
  iconWrap: { alignItems: "center", marginBottom: 18 },
  iconBg: {
    width: 110,
    height: 110,
    borderRadius: 55,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 16,
    elevation: 10,
  },
  title: {
    color: Colors.text,
    fontFamily: "Inter_700Bold",
    fontSize: 26,
    textAlign: "center",
    marginBottom: 10,
  },
  devBadge: {
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 16,
    backgroundColor: "rgba(241,196,15,0.12)",
    borderWidth: 1,
    borderColor: "rgba(241,196,15,0.4)",
    marginBottom: 22,
  },
  devText: {
    color: Colors.gold,
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
  },
  descCard: {
    backgroundColor: Colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 18,
    marginBottom: 18,
  },
  descHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 10,
  },
  descTitle: {
    color: Colors.text,
    fontFamily: "Inter_700Bold",
    fontSize: 15,
  },
  descBody: {
    color: Colors.textSecondary,
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    lineHeight: 22,
  },
  featureList: {
    backgroundColor: Colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingVertical: 6,
  },
  featureRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  featureIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "rgba(108,99,255,0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  featureLabel: {
    flex: 1,
    color: Colors.text,
    fontFamily: "Inter_500Medium",
    fontSize: 14,
  },
  liveBtn: {
    marginTop: 22,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 16,
    borderRadius: 14,
    backgroundColor: Colors.primary,
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.45,
    shadowRadius: 12,
    elevation: 8,
  },
  liveBtnText: {
    color: "#fff",
    fontFamily: "Inter_700Bold",
    fontSize: 16,
  },
  testBtn: {
    marginTop: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: Colors.border,
  },
  testBtnText: {
    color: Colors.textSecondary,
    fontFamily: "Inter_500Medium",
    fontSize: 12,
  },
});
