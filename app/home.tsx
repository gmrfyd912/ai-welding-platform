import React from "react";
import { View, Text, StyleSheet, Pressable, Platform } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/AuthContext";
import { useLanguage } from "@/context/LanguageContext";

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuth();
  const { t } = useLanguage();

  const isWeb = Platform.OS === "web";
  const topPad = isWeb ? 67 : insets.top;
  const bottomPad = isWeb ? 34 : insets.bottom;

  const goTheory = () => {
    Haptics.selectionAsync();
    router.push("/theory");
  };
  const goSkill = () => {
    Haptics.selectionAsync();
    router.push("/(tabs)");
  };

  return (
    <View style={[styles.container, { paddingTop: topPad + 8, paddingBottom: bottomPad + 16 }]}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.greeting}>{t("home_hello")}</Text>
          <Text style={styles.userName} numberOfLines={1}>{user?.name ?? user?.username}</Text>
        </View>
        <Pressable
          onPress={async () => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            await logout();
            router.replace("/login");
          }}
          style={({ pressed }) => [styles.logoutBtn, pressed && { opacity: 0.7 }]}
        >
          <Ionicons name="log-out-outline" size={20} color={Colors.textSecondary} />
        </Pressable>
      </View>

      <Text style={styles.title}>{t("home_title")}</Text>
      <Text style={styles.subtitle}>{t("home_subtitle")}</Text>

      <View style={styles.cards}>
        <Pressable
          onPress={goTheory}
          style={({ pressed }) => [styles.card, pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] }]}
        >
          <LinearGradient
            colors={["#1A4D8C", "#0E2D54"]}
            style={StyleSheet.absoluteFill}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
          />
          <View style={styles.cardIconWrap}>
            <MaterialCommunityIcons name="book-open-page-variant" size={56} color="#fff" />
          </View>
          <Text style={styles.cardTitle}>{t("home_theory")}</Text>
          <Text style={styles.cardDesc}>{t("home_theoryDesc")}</Text>
        </Pressable>

        <Pressable
          onPress={goSkill}
          style={({ pressed }) => [styles.card, pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] }]}
        >
          <LinearGradient
            colors={["#FF6A1A", "#C83A00"]}
            style={StyleSheet.absoluteFill}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
          />
          <View style={styles.cardIconWrap}>
            <MaterialCommunityIcons name="fire" size={56} color="#fff" />
          </View>
          <Text style={styles.cardTitle}>{t("home_skill")}</Text>
          <Text style={styles.cardDesc}>{t("home_skillDesc")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.bg,
    paddingHorizontal: 20,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 28,
  },
  greeting: { color: Colors.textSecondary, fontFamily: "Inter_400Regular", fontSize: 13 },
  userName: { color: Colors.text, fontFamily: "Inter_700Bold", fontSize: 18, marginTop: 2 },
  logoutBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: Colors.card, alignItems: "center", justifyContent: "center",
  },
  title: {
    color: Colors.text,
    fontFamily: "Inter_700Bold",
    fontSize: 26,
    marginBottom: 4,
  },
  subtitle: {
    color: Colors.textSecondary,
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    marginBottom: 28,
  },
  cards: {
    flex: 1,
    gap: 16,
    paddingBottom: 8,
  },
  card: {
    flex: 1,
    borderRadius: 24,
    padding: 28,
    overflow: "hidden",
    justifyContent: "space-between",
    minHeight: 180,
  },
  cardIconWrap: {
    alignSelf: "flex-start",
    backgroundColor: "rgba(255,255,255,0.12)",
    width: 88,
    height: 88,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  cardTitle: {
    color: "#fff",
    fontFamily: "Inter_700Bold",
    fontSize: 28,
    marginTop: 16,
  },
  cardDesc: {
    color: "rgba(255,255,255,0.85)",
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    marginTop: 4,
  },
});
