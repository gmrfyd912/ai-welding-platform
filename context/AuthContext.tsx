import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useMemo,
  ReactNode,
} from "react";
import { getApiUrl } from "@/lib/query-client";

export type UserRole = "교육생" | "교사" | "관리자";
export type UserPermission = "can_delete_posts" | "can_give_feedback";

export interface User {
  id: string;
  username: string;
  name: string;
  role: UserRole;
  courseName?: string;
  profilePhotoUri?: string;
  permissions?: UserPermission[];
  enrollDate?: string;   // "YYYY-MM-DD"
  graduateDate?: string; // "YYYY-MM-DD"
}

interface RegisterData {
  username: string;
  password: string;
  name: string;
  role: UserRole;
  courseName?: string;
  profilePhotoUri?: string;
  enrollDate?: string;
  graduateDate?: string;
}

interface AuthContextValue {
  user: User | null;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  register: (data: RegisterData) => Promise<{ success: boolean; error?: string }>;
  updateProfile: (updates: Partial<User & { password?: string }>) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const SESSION_KEY = "weld_session_v2";
const BUILD_TOKEN_KEY = "weld_build_token";

function apiUrl(path: string): string {
  return new URL(path, getApiUrl()).toString();
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    restoreSession();
  }, []);

  const restoreSession = async () => {
    try {
      let sessionInvalidated = false;
      try {
        const versionRes = await fetch(apiUrl("/api/app-version"));
        if (versionRes.ok) {
          const { buildToken } = await versionRes.json();
          const storedToken = await AsyncStorage.getItem(BUILD_TOKEN_KEY);
          if (storedToken && storedToken !== buildToken) {
            await AsyncStorage.removeItem(SESSION_KEY);
            sessionInvalidated = true;
          }
          await AsyncStorage.setItem(BUILD_TOKEN_KEY, buildToken);
        }
      } catch {}

      if (!sessionInvalidated) {
        const sessionId = await AsyncStorage.getItem(SESSION_KEY);
        if (sessionId) {
          const res = await fetch(apiUrl(`/api/auth/user/${sessionId}`));
          if (res.ok) {
            const u = await res.json();
            setUser(u);
          } else {
            await AsyncStorage.removeItem(SESSION_KEY);
          }
        }
      }
    } catch {
    } finally {
      setIsLoading(false);
    }
  };

  const login = async (username: string, password: string): Promise<boolean> => {
    try {
      const res = await fetch(apiUrl("/api/auth/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) return false;
      const u = await res.json();
      setUser(u);
      await AsyncStorage.setItem(SESSION_KEY, u.id);
      return true;
    } catch {
      return false;
    }
  };

  const logout = async () => {
    setUser(null);
    await AsyncStorage.removeItem(SESSION_KEY);
  };

  const register = async (data: RegisterData): Promise<{ success: boolean; error?: string }> => {
    try {
      const res = await fetch(apiUrl("/api/auth/register"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const body = await res.json();
        return { success: false, error: body.error || "회원가입 실패" };
      }
      return { success: true };
    } catch {
      return { success: false, error: "네트워크 오류" };
    }
  };

  const updateProfile = async (updates: Partial<User & { password?: string }>) => {
    if (!user) return;
    try {
      const res = await fetch(apiUrl("/api/auth/profile"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: user.id, ...updates }),
      });
      if (res.ok) {
        const u = await res.json();
        setUser(u);
        if (updates.profilePhotoUri !== undefined || updates.name !== undefined) {
          await fetch(apiUrl(`/api/results/${user.id}/profile`), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userName: u.name, userProfileUri: u.profilePhotoUri }),
          });
        }
      }
    } catch (err) {
      console.error("updateProfile error:", err);
    }
  };

  const value = useMemo(
    () => ({ user, isLoading, login, logout, register, updateProfile }),
    [user, isLoading]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
