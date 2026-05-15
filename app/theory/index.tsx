import React from "react";
import { View, Text, StyleSheet, Pressable, Platform, ActivityIndicator } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { Ionicons, MaterialCommunityIcons, FontAwesome5 } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/AuthContext";
import { useLanguage } from "@/context/LanguageContext";
import { getApiUrl } from "@/lib/query-client";

interface TodayStatus {
  dayKey: string;
  attempted: number;
  completed: boolean;
}

export default function TheoryHome() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { t } = useLanguage();

  const isWeb = Platform.OS === "web";
  const topPad = isWeb ? 67 : insets.top;
  const bottomPad = isWeb ? 34 : insets.bottom;

  const { data: status, isLoading } = useQuery<TodayStatus>({
    queryKey: [`/api/theory/today-status/${user?.id}`],
    enabled: !!user?.id,
    refetchOnMount: "always",
  });

  const completed = !!status?.completed;

  const goToday = () => {
    Haptics.selectionAsync();
    if (completed) {
      router.push(`/theory/today?mode=review&dayKey=${status?.dayKey}`);
    } else {
      router.push("/theory/today");
    }
  };

  const goOX = () => {
    Haptics.selectionAsync();
    router.push("/theory/ox");
  };

  return (
    <View style={[styles.container, { paddingTop: topPad + 8, paddingBottom: bottomPad + 16 }]}>
      <View style={styles.header}>
        <Pressable
          onPress={() => {
            Haptics.selectionAsync();
            router.back();
          }}
          style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.7 }]}
        >
          <Ionicons name="chevron-back" size={24} color={Colors.text} />
        </Pressable>
        <Text style={styles.headerTitle}>{t("home_theory")}</Text>
        <View style={{ width: 40 }} />
      </View>

      <Text style={styles.subtitle}>{t("theory_subtitle")}</Text>

      <View style={styles.cards}>
        <Pressable
          onPress={goToday}
          style={({ pressed }) => [styles.card, { backgroundColor: "#0F2A4A" }, pressed && { opacity: 0.85 }]}
        >
          <View style={[styles.cardIconWrap, { backgroundColor: "rgba(0,180,255,0.18)" }]}>
            <FontAwesome5 name="lightbulb" size={42} color={Colors.primary} solid />
          </View>
          <Text style={styles.cardTitle}>{t("theory_today")}</Text>
          {isLoading ? (
            <ActivityIndicator color={Colors.textSecondary} style={{ marginTop: 6 }} />
          ) : completed ? (
            <View style={styles.subRow}>
              <Ionicons name="checkmark-circle" size={14} color={Colors.success} />
              <Text style={[styles.cardDesc, { color: Colors.success }]}>
                {t("theory_review")}
              </Text>
            </View>
          ) : (
            <Text style={styles.cardDesc}>{t("theory_today_desc")}</Text>
          )}
        </Pressable>

        <Pressable
          onPress={goOX}
          style={({ pressed }) => [styles.card, { backgroundColor: "#3A1E5C" }, pressed && { opacity: 0.85 }]}
        >
          <View style={[styles.cardIconWrap, { backgroundColor: "rgba(186,85,255,0.18)" }]}>
            <MaterialCommunityIcons name="gamepad-variant" size={48} color="#BA55FF" />
          </View>
          <Text style={styles.cardTitle}>{t("theory_ox")}</Text>
          <Text style={styles.cardDesc}>{t("theory_ox_desc")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg, paddingHorizontal: 20 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: "center", justifyContent: "center",
    backgroundColor: Colors.card,
  },
  headerTitle: {
    color: Colors.text, fontFamily: "Inter_700Bold", fontSize: 18,
  },
  subtitle: { color: Colors.textSecondary, fontFamily: "Inter_400Regular", fontSize: 14, marginBottom: 24 },
  cards: { flex: 1, gap: 16 },
  card: {
    flex: 1,
    borderRadius: 24,
    padding: 24,
    justifyContent: "space-between",
    minHeight: 170,
  },
  cardIconWrap: {
    alignSelf: "flex-start",
    width: 80, height: 80, borderRadius: 22,
    alignItems: "center", justifyContent: "center",
  },
  cardTitle: {
    color: "#fff", fontFamily: "Inter_700Bold", fontSize: 26, marginTop: 14,
  },
  cardDesc: {
    color: "rgba(255,255,255,0.7)", fontFamily: "Inter_400Regular", fontSize: 14, marginTop: 4,
  },
  subRow: {
    flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6,
  },
});
