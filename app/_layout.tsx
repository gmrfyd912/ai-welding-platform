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
import Colors from "@/constants/colors";
import { seedDemoData } from "@/context/SeedData";

SplashScreen.preventAutoHideAsync();
seedDemoData();

function RootLayoutNav() {
  const { user, isLoading } = useAuth();

  useEffect(() => {
    if (!isLoading) {
      if (user) {
        router.replace("/home");
      } else {
        router.replace("/login");
      }
    }
  }, [user, isLoading]);

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
      <Stack.Screen name="home" />
      <Stack.Screen name="theory" />
      <Stack.Screen name="(tabs)" />
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
                <WeldingProvider>
                  <RootLayoutNav />
                </WeldingProvider>
              </AuthProvider>
            </LanguageProvider>
          </KeyboardProvider>
        </GestureHandlerRootView>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
