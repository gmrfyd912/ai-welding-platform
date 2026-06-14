import React from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  SafeAreaView,
} from "react-native";
import { router } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import * as Haptics from "expo-haptics";
import { Ionicons } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import { useRole, AppRole } from "@/context/RoleContext";

const ROLES: {
  id: AppRole;
  icon: keyof typeof Ionicons.glyphMap;
  emoji: string;
  title: string;
  subtitle: string;
  gradient: [string, string];
}[] = [
  {
    id: "education",
    icon: "school-outline",
    emoji: "🎓",
    title: "교육원 사용자",
    subtitle: "학습 및 실습",
    gradient: ["#0082BB", "#00B4FF"],
  },
  {
    id: "field",
    icon: "construct-outline",
    emoji: "🏗️",
    title: "현장 사용자",
    subtitle: "품질 검사 및 대시보드",
    gradient: ["#00996A", "#00D68F"],
  },
];

export default function RoleSelectionScreen() {
  const { setUserRole } = useRole();

  const handleSelect = (role: AppRole) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setUserRole(role);
    router.replace(role === "education" ? "/(tabs)" : "/(field-tabs)");
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>사용 목적을 선택하세요</Text>
          <Text style={styles.subtitle}>
            선택한 권한에 맞는 화면이 제공됩니다
          </Text>
        </View>

        <View style={styles.cards}>
          {ROLES.map((role) => (
            <Pressable
              key={role.id}
              onPress={() => handleSelect(role.id)}
              style={({ pressed }) => [
                styles.cardWrapper,
                pressed && { opacity: 0.85, transform: [{ scale: 0.97 }] },
              ]}
            >
              <LinearGradient
                colors={role.gradient}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.card}
              >
                <Text style={styles.emoji}>{role.emoji}</Text>
                <Text style={styles.roleTitle}>{role.title}</Text>
                <Text style={styles.roleSubtitle}>{role.subtitle}</Text>
                <View style={styles.arrow}>
                  <Ionicons name="arrow-forward" size={20} color="#fff" />
                </View>
              </LinearGradient>
            </Pressable>
          ))}
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  container: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 24,
    gap: 48,
  },
  header: {
    alignItems: "center",
    gap: 8,
  },
  title: {
    fontSize: 24,
    fontFamily: "Inter_700Bold",
    color: Colors.text,
    textAlign: "center",
  },
  subtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.textSecondary,
    textAlign: "center",
  },
  cards: {
    gap: 16,
  },
  cardWrapper: {
    borderRadius: 20,
    overflow: "hidden",
  },
  card: {
    padding: 28,
    borderRadius: 20,
    gap: 6,
  },
  emoji: {
    fontSize: 40,
    marginBottom: 4,
  },
  roleTitle: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
  roleSubtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.8)",
  },
  arrow: {
    position: "absolute",
    right: 24,
    top: "50%",
    marginTop: -10,
  },
});
