import React from "react";
import { View, Text, StyleSheet, ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import Colors from "@/constants/colors";

// 뼈대 UI — 작업 통계 대시보드
// TODO: 용접사별 불량률/합격률 그래프, 기간별 추이, 공정별 통계 연동
export default function DashboardScreen() {
  const insets = useSafeAreaInsets();

  const STAT_CARDS = [
    { label: "오늘 검사 건수", value: "—", icon: "clipboard-outline" as const, color: Colors.primary },
    { label: "합격률", value: "— %", icon: "checkmark-circle-outline" as const, color: Colors.success },
    { label: "불량 건수", value: "—", icon: "warning-outline" as const, color: Colors.danger },
    { label: "이번 주 검사", value: "—", icon: "calendar-outline" as const, color: Colors.warning },
  ];

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={[styles.container, { paddingTop: insets.top + 16, paddingBottom: 100 }]}
      showsVerticalScrollIndicator={false}
    >
      <Text style={styles.title}>작업 통계 대시보드</Text>
      <Text style={styles.subtitle}>용접사별 불량률 및 합격률 현황</Text>

      {/* 요약 카드 */}
      <View style={styles.statsGrid}>
        {STAT_CARDS.map((card) => (
          <View key={card.label} style={styles.statCard}>
            <Ionicons name={card.icon} size={24} color={card.color} />
            <Text style={styles.statValue}>{card.value}</Text>
            <Text style={styles.statLabel}>{card.label}</Text>
          </View>
        ))}
      </View>

      {/* 그래프 영역 */}
      <View style={styles.chartPlaceholder}>
        <Ionicons name="stats-chart-outline" size={56} color={Colors.textMuted} />
        <Text style={styles.placeholderText}>불량률 추이 그래프</Text>
        <Text style={styles.placeholderSub}>기간 선택 후 통계를 조회하세요</Text>
      </View>

      {/* 용접사별 순위 */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>용접사별 합격률 순위</Text>
        <View style={styles.rankPlaceholder}>
          <Ionicons name="people-outline" size={40} color={Colors.textMuted} />
          <Text style={styles.placeholderSub}>데이터를 불러오는 중...</Text>
        </View>
      </View>
    </ScrollView>
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
  statsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  statCard: {
    flex: 1,
    minWidth: "44%",
    backgroundColor: Colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 16,
    alignItems: "center",
    gap: 6,
  },
  statValue: {
    fontSize: 24,
    fontFamily: "Inter_700Bold",
    color: Colors.text,
  },
  statLabel: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: Colors.textSecondary,
    textAlign: "center",
  },
  chartPlaceholder: {
    height: 200,
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
    fontSize: 15,
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
  section: {
    gap: 10,
  },
  sectionTitle: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: Colors.text,
  },
  rankPlaceholder: {
    height: 120,
    backgroundColor: Colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
});
