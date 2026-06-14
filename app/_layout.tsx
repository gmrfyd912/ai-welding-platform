import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { QueryClientProvider } from "@tanstack/react-query";
import { Stack, router } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect } from "react";
import { View, ActivityIndicator } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { queryClient } from "@/lib/query-client";
import { AuthProvider, useAuth } from "@/context/AuthContext";
import { WeldingProvider } from "@/context/WeldingContext";
import { LanguageProvider } from "@/context/LanguageContext";
import { RoleProvider, useRole } from "@/context/RoleContext";
import Colors from "@/constants/colors";
import { seedDemoData } from "@/context/SeedData";

SplashScreen.preventAutoHideAsync();
seedDemoData();

function RootLayoutNav() {
  const { user, isLoading } = useAuth();
  const { userRole, clearRole } = useRole();

  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      // 로그아웃 시 역할 초기화 — 다음 로그인에서 역할 선택 화면 재노출
      clearRole();
      router.replace("/login");
    } else if (!userRole) {
      // 로그인됐지만 역할 미선택 → 역할 선택 화면
      router.replace("/role-selection");
    }
    // 역할 선택 후 라우팅은 role-selection.tsx에서 직접 처리
  }, [user, isLoading, userRole]);

  if (isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: Colors.bg, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={Colors.primary} size="large" />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: Colors.bg }, orientation: "portrait" }}>
      <Stack.Screen name="login" />
      <Stack.Screen name="register" />
      <Stack.Screen name="role-selection" />
      {/* 교육원 탭 네비게이터 */}
      <Stack.Screen name="(tabs)" />
      {/* 현장 탭 네비게이터 */}
      <Stack.Screen name="(field-tabs)" />
      {/* 교육원 공용 스크린 */}
      <Stack.Screen name="home" />
      <Stack.Screen name="theory" />
      <Stack.Screen name="coaching-test" />
      <Stack.Screen name="coaching-live" options={{ orientation: "all" }} />
      <Stack.Screen name="register-photo" options={{ presentation: "modal" }} />
      <Stack.Screen name="diagnosis/[id]" />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <KeyboardProvider>
            <LanguageProvider>
              <AuthProvider>
                <RoleProvider>
                  <WeldingProvider>
                    <RootLayoutNav />
                  </WeldingProvider>
                </RoleProvider>
              </AuthProvider>
            </LanguageProvider>
          </KeyboardProvider>
        </GestureHandlerRootView>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
