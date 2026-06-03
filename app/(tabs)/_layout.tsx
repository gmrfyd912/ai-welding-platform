import { isLiquidGlassAvailable } from "expo-glass-effect";
import { Tabs } from "expo-router";
import { BlurView } from "expo-blur";
import { Alert, Platform, StyleSheet, View } from "react-native";
import React, { useEffect } from "react";
import * as Updates from "expo-updates";
import { Ionicons } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import { useLanguage } from "@/context/LanguageContext";
import { useAuth } from "@/context/AuthContext";

/**
 * OTA 업데이트 자동 감지 훅.
 * 앱 구동 시 백그라운드에서 새 업데이트를 확인하고,
 * 다운로드 완료 후 사용자에게 재시작 여부를 물어본다.
 * __DEV__ 환경(로컬 개발)에서는 동작하지 않는다.
 */
function useAppUpdater(): void {
  useEffect(() => {
    if (__DEV__) return;

    async function checkAndApply() {
      try {
        const result = await Updates.checkForUpdateAsync();
        if (!result.isAvailable) return;

        await Updates.fetchUpdateAsync();

        Alert.alert(
          "업데이트 완료",
          "새로운 기능이 추가되었습니다. 앱을 재시작하여 적용하시겠습니까?",
          [
            { text: "나중에", style: "cancel" },
            {
              text: "재시작",
              onPress: () => Updates.reloadAsync().catch((e) =>
                console.warn("[OTA] reloadAsync 오류:", e)
              ),
            },
          ],
          { cancelable: false },
        );
      } catch (e) {
        // 네트워크 오류 등은 조용히 무시
        console.warn("[OTA] 업데이트 확인 중 오류:", e);
      }
    }

    checkAndApply();
  }, []);
}

function NativeTabLayout() {
  const { t } = useLanguage();
  const { user } = useAuth();
  const isAdmin = user?.username === "admin";
  const { NativeTabs, Icon, Label } = require("expo-router/unstable-native-tabs");
  return (
    <NativeTabs>
      <NativeTabs.Trigger name="index">
        <Icon sf={{ default: "photo.on.rectangle", selected: "photo.on.rectangle.fill" }} />
        <Label>{t("nav_gallery")}</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="ranking">
        <Icon sf={{ default: "chart.bar", selected: "chart.bar.fill" }} />
        <Label>{t("nav_diagnosis")}</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="coaching">
        <Icon sf={{ default: "sparkles", selected: "sparkles" }} />
        <Label>{t("nav_coaching")}</Label>
      </NativeTabs.Trigger>
      {isAdmin && (
        <NativeTabs.Trigger name="members">
          <Icon sf={{ default: "person.3", selected: "person.3.fill" }} />
          <Label>{t("nav_members")}</Label>
        </NativeTabs.Trigger>
      )}
    </NativeTabs>
  );
}

function ClassicTabLayout() {
  const isIOS = Platform.OS === "ios";
  const isWeb = Platform.OS === "web";
  const { t } = useLanguage();
  const { user } = useAuth();
  const isAdmin = user?.username === "admin";

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: Colors.primary,
        tabBarInactiveTintColor: Colors.tabInactive,
        tabBarStyle: {
          position: "absolute",
          backgroundColor: isIOS ? "transparent" : Colors.card,
          borderTopWidth: isWeb ? 1 : 0,
          borderTopColor: Colors.border,
          elevation: 0,
          ...(isWeb ? { height: 84 } : {}),
        },
        tabBarLabelStyle: {
          fontFamily: "Inter_500Medium",
          fontSize: 11,
        },
        tabBarBackground: () =>
          isIOS ? (
            <BlurView intensity={90} tint="dark" style={StyleSheet.absoluteFill} />
          ) : isWeb ? (
            <View style={[StyleSheet.absoluteFill, { backgroundColor: Colors.card }]} />
          ) : null,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t("nav_gallery"),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="images-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="ranking"
        options={{
          title: t("nav_diagnosis"),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="bar-chart-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="coaching"
        options={{
          title: t("nav_coaching"),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="sparkles-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="members"
        options={{
          title: t("nav_members"),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="people-outline" size={size} color={color} />
          ),
          href: isAdmin ? undefined : null,
        }}
      />
    </Tabs>
  );
}

export default function TabLayout() {
  useAppUpdater(); // OTA 업데이트 자동 감지 (배포 환경 전용)
  if (isLiquidGlassAvailable()) {
    return <NativeTabLayout />;
  }
  return <ClassicTabLayout />;
}
