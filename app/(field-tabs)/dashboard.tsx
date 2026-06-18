import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  Dimensions,
  Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { PieChart } from "react-native-chart-kit";
import Colors from "@/constants/colors";
import { apiUrl } from "@/lib/query-client";

const SCREEN_W = Dimensions.get("window").width;
const CHART_W = SCREEN_W - 40;

interface DashboardSummary {
  totals: {
    total_inspections: string;
    pass_count: string;
    fail_count: string;
    pass_rate: string | null;
  };
  top_defects: Array<{ defect_type: string; cnt: string }>;
  top_welders: Array<{
    id: number;
    name: string;
    total: string;
    passed: string;
    pass_rate: string | null;
  }>;
}

const PIE_COLORS = ["#FF6384", "#36A2EB", "#FFCE56", "#4BC0C0", "#9966FF"];
const RANK_ICONS = ["🥇", "🥈", "🥉"];

export default function DashboardScreen() {
  const insets = useSafeAreaInsets();
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);

  const fetchSummary = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(apiUrl("api/field/dashboard/summary"));
      if (!res.ok) throw new Error(`서버 오류 ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (e: any) {
      setError(e.message ?? "데이터를 불러오지 못했습니다");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  const handleSeed = async () => {
    try {
      setSeeding(true);
      const res = await fetch(apiUrl("api/field/seed?records=5"), { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "시드 실패");
      Alert.alert(
        "생성 완료",
        `검사 ${json.inspections}건 · 결함 ${json.defects}건이 추가됐습니다`,
        [{ text: "확인" }],
      );
      await fetchSummary();
    } catch (e: any) {
      Alert.alert("오류", e.message);
    } finally {
      setSeeding(false);
    }
  };

  const totals = data?.totals;
  const topDefects = data?.top_defects ?? [];
  const topWelders = data?.top_welders ?? [];

  const pieData = topDefects.map((d, i) => ({
    name: d.defect_type,
    population: Number(d.cnt),
    color: PIE_COLORS[i % PIE_COLORS.length],
    legendFontColor: Colors.textSecondary,
    legendFontSize: 12,
  }));

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={[
        styles.container,
        { paddingTop: insets.top + 16, paddingBottom: 100 },
      ]}
      showsVerticalScrollIndicator={false}
    >
      {/* 헤더 */}
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>작업 통계 대시보드</Text>
          <Text style={styles.subtitle}>용접사별 불량률 및 합격률 현황</Text>
        </View>
        <TouchableOpacity
          style={styles.seedBtn}
          onPress={handleSeed}
          disabled={seeding || loading}
        >
          {seeding ? (
            <ActivityIndicator size="small" color={Colors.warning} />
          ) : (
            <>
              <Text style={styles.seedIcon}>🧪</Text>
              <Text style={styles.seedText}>더미 생성</Text>
            </>
          )}
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.centerBox}>
          <ActivityIndicator size="large" color={Colors.primary} />
          <Text style={styles.loadingText}>데이터 불러오는 중...</Text>
        </View>
      ) : error ? (
        <View style={styles.centerBox}>
          <Ionicons name="cloud-offline-outline" size={48} color={Colors.danger} />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={fetchSummary}>
            <Text style={styles.retryText}>다시 시도</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          {/* 요약 카드 4개 */}
          <View style={styles.statsGrid}>
            <View style={styles.statCard}>
              <Ionicons name="clipboard-outline" size={22} color={Colors.primary} />
              <Text style={styles.statValue}>{totals?.total_inspections ?? "0"}</Text>
              <Text style={styles.statLabel}>총 검사 건수</Text>
            </View>
            <View style={styles.statCard}>
              <Ionicons name="checkmark-circle-outline" size={22} color={Colors.success} />
              <Text style={[styles.statValue, { color: Colors.success }]}>
                {totals?.pass_rate != null ? `${totals.pass_rate}%` : "—"}
              </Text>
              <Text style={styles.statLabel}>합격률</Text>
            </View>
            <View style={styles.statCard}>
              <Ionicons name="close-circle-outline" size={22} color={Colors.danger} />
              <Text style={[styles.statValue, { color: Colors.danger }]}>
                {totals?.fail_count ?? "0"}
              </Text>
              <Text style={styles.statLabel}>불합격 건수</Text>
            </View>
            <View style={styles.statCard}>
              <Ionicons name="alert-circle-outline" size={22} color={Colors.warning} />
              <Text
                style={[styles.statValue, { color: Colors.warning, fontSize: 15 }]}
                numberOfLines={1}
              >
                {topDefects[0]?.defect_type ?? "—"}
              </Text>
              <Text style={styles.statLabel}>최다 결함</Text>
            </View>
          </View>

          {/* 결함 파이 차트 */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>결함 유형 TOP 5</Text>
            {pieData.length === 0 ? (
              <View style={styles.emptyBox}>
                <Ionicons name="pie-chart-outline" size={40} color={Colors.textMuted} />
                <Text style={styles.emptyText}>결함 데이터가 없습니다</Text>
                <Text style={styles.emptyHint}>더미 생성 버튼으로 데이터를 추가하세요</Text>
              </View>
            ) : (
              <View style={styles.chartCard}>
                <PieChart
                  data={pieData}
                  width={CHART_W - 32}
                  height={190}
                  chartConfig={{
                    color: (opacity = 1) => `rgba(255,255,255,${opacity})`,
                    labelColor: (opacity = 1) => `rgba(255,255,255,${opacity})`,
                  }}
                  accessor="population"
                  backgroundColor="transparent"
                  paddingLeft="8"
                  absolute
                />
              </View>
            )}
          </View>

          {/* 용접사 합격률 순위 */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>용접사 합격률 순위</Text>
            {topWelders.length === 0 ? (
              <View style={styles.emptyBox}>
                <Ionicons name="people-outline" size={40} color={Colors.textMuted} />
                <Text style={styles.emptyText}>용접사 데이터가 없습니다</Text>
              </View>
            ) : (
              topWelders.map((w, idx) => (
                <View key={w.id} style={styles.rankerCard}>
                  <Text style={styles.rankBadge}>
                    {RANK_ICONS[idx] ?? `#${idx + 1}`}
                  </Text>
                  <View style={styles.rankerInfo}>
                    <Text style={styles.rankerName}>{w.name}</Text>
                    <Text style={styles.rankerSub}>
                      {w.total}건 검사 · 합격 {w.passed}건
                    </Text>
                  </View>
                  <Text
                    style={[
                      styles.passRateText,
                      {
                        color:
                          Number(w.pass_rate) >= 70
                            ? Colors.success
                            : Colors.danger,
                      },
                    ]}
                  >
                    {w.pass_rate != null ? `${w.pass_rate}%` : "—"}
                  </Text>
                </View>
              ))
            )}
          </View>
        </>
      )}
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
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
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
    marginTop: 2,
  },
  seedBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minWidth: 72,
    justifyContent: "center",
  },
  seedIcon: {
    fontSize: 14,
  },
  seedText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: Colors.warning,
  },
  centerBox: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 60,
    gap: 12,
  },
  loadingText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.textSecondary,
  },
  errorText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.danger,
    textAlign: "center",
  },
  retryBtn: {
    marginTop: 4,
    backgroundColor: Colors.surface,
    borderRadius: 8,
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  retryText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: Colors.primary,
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
  section: {
    gap: 10,
  },
  sectionTitle: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: Colors.text,
  },
  chartCard: {
    backgroundColor: Colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 16,
    alignItems: "center",
  },
  emptyBox: {
    backgroundColor: Colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 32,
    gap: 8,
  },
  emptyText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: Colors.textMuted,
  },
  emptyHint: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.textMuted,
    textAlign: "center",
    paddingHorizontal: 24,
  },
  rankerCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 14,
    gap: 12,
  },
  rankBadge: {
    fontSize: 22,
    width: 32,
    textAlign: "center",
  },
  rankerInfo: {
    flex: 1,
    gap: 2,
  },
  rankerName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: Colors.text,
  },
  rankerSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.textSecondary,
  },
  passRateText: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
  },
});
