import React from "react";
import { Stack } from "expo-router";
import Colors from "@/constants/colors";

export default function TheoryLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: Colors.bg },
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="today" />
      <Stack.Screen name="ox" />
      <Stack.Screen name="ox-game" options={{ orientation: "all" }} />
    </Stack>
  );
}
