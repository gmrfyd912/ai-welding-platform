import { Tabs, useRouter } from "expo-router";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { BlurView } from "expo-blur";
import { Ionicons } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/AuthContext";

export default function FieldTabLayout() {
  const isIOS = Platform.OS === "ios";
  const { logout } = useAuth();
  const router = useRouter();

  const handleLogout = async () => {
    await logout();
    router.replace("/login");
  };

  return (
    <Tabs
      screenOptions={{
        headerShown: true,
        headerTitle: () => null,
        headerStyle: { backgroundColor: Colors.bg },
        headerShadowVisible: false,
        headerLeft: () => null,
        headerRight: () => (
          <Pressable
            onPress={handleLogout}
            style={{ marginRight: 14, padding: 6 }}
            hitSlop={10}
          >
            <Ionicons name="log-out-outline" size={22} color={Colors.textSecondary} />
          </Pressable>
        ),
        tabBarActiveTintColor: Colors.success,
        tabBarInactiveTintColor: Colors.tabInactive,
        tabBarStyle: {
          position: "absolute",
          backgroundColor: isIOS ? "transparent" : Colors.card,
          borderTopWidth: 0,
          elevation: 0,
        },
        tabBarLabelStyle: {
          fontFamily: "Inter_500Medium",
          fontSize: 11,
        },
        tabBarBackground: () =>
          isIOS ? (
            <BlurView intensity={90} tint="dark" style={StyleSheet.absoluteFill} />
          ) : (
            <View style={[StyleSheet.absoluteFill, { backgroundColor: Colors.card }]} />
          ),
      }}
    >
      <Tabs.Screen
        name="inspection"
        options={{
          title: "현장 검사",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="camera-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="dashboard"
        options={{
          title: "통계 대시보드",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="stats-chart-outline" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
