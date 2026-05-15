import AsyncStorage from "@react-native-async-storage/async-storage";
import { User } from "@/context/AuthContext";

const SEEDED_KEY = "weld_reset_v1";
const USERS_KEY = "weld_users";
const RESULTS_KEY = "weld_results";

export async function seedDemoData() {
  try {
    const seeded = await AsyncStorage.getItem(SEEDED_KEY);
    if (seeded) return;

    const existingUsersRaw = await AsyncStorage.getItem(USERS_KEY);
    const existingUsers: User[] = existingUsersRaw ? JSON.parse(existingUsersRaw) : [];

    const adminUser = existingUsers.find((u) => u.username === "admin");

    const freshUsers: User[] = adminUser ? [adminUser] : [];
    await AsyncStorage.setItem(USERS_KEY, JSON.stringify(freshUsers));

    await AsyncStorage.setItem(RESULTS_KEY, JSON.stringify([]));

    await AsyncStorage.setItem(SEEDED_KEY, "true");

    console.log("Data reset: kept admin account, cleared all welding results and other users.");
  } catch (e) {
    console.warn("Reset failed:", e);
  }
}
