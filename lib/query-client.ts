import { fetch } from "expo/fetch";
import { QueryClient, QueryFunction } from "@tanstack/react-query";

const PRODUCTION_URL = "https://ai-welding-platform.onrender.com";

/**
 * Gets the base URL for the Express API server.
 *
 * 우선순위:
 * 1. EXPO_PUBLIC_DOMAIN 환경 변수 (명시적 설정)
 * 2. 개발(DEV) 모드 + Expo 호스트 → PC 로컬 IP:5001 자동 감지
 *    (같은 Wi-Fi의 모바일 기기가 PC 서버에 자동 연결)
 * 3. 기본값: Render 프로덕션 서버
 */
export function getApiUrl(): string {
  const configured = process.env.EXPO_PUBLIC_DOMAIN;

  // 명시 설정이 있고 프로덕션 URL이 아닌 경우 그대로 사용
  if (configured && !configured.includes("onrender.com")) {
    const url = configured.startsWith("http") ? configured : `http://${configured}`;
    return url.endsWith("/") ? url : `${url}/`;
  }

  // DEV 모드: Expo Constants.expoConfig.hostUri에서 PC 로컬 IP를 자동 감지
  if (__DEV__) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Constants = require("expo-constants").default;
      const hostUri: string | undefined = Constants?.expoConfig?.hostUri;
      if (hostUri) {
        // hostUri 예: "192.168.0.11:8081" (Expo Metro 포트)
        // Express 서버는 5001번 포트에서 실행
        const ip = hostUri.split(":")[0];
        if (ip && ip !== "localhost" && ip !== "127.0.0.1") {
          const devUrl = `http://${ip}:5001/`;
          console.log(`[API] DEV 모드 — 로컬 서버 자동 감지: ${devUrl}`);
          return devUrl;
        }
      }
    } catch {
      // expo-constants 미사용 환경에서는 폴백
    }
  }

  // 프로덕션 또는 감지 실패 → Render 서버
  const fallback = configured || PRODUCTION_URL;
  if (__DEV__) {
    console.warn(
      "[API] ⚠ DEV 모드이지만 로컬 IP 감지 실패 → 프로덕션 서버 사용: " + fallback + "\n" +
      "      비전 분석이 동작하지 않을 수 있습니다.\n" +
      "      해결: EXPO_PUBLIC_DOMAIN=http://<컴퓨터IP>:5001 환경 변수를 설정하여 Expo를 시작하세요."
    );
  }
  return fallback.endsWith("/") ? fallback : `${fallback}/`;
}

export function apiUrl(path: string): string {
  const base = getApiUrl();
  return new URL(path, base).toString();
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  route: string,
  data?: unknown | undefined,
): Promise<Response> {
  const url = apiUrl(route);

  const res = await fetch(url, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const base = getApiUrl();
    const url = new URL(queryKey.join("/") as string, base);

    const res = await fetch(url.toString(), {
      credentials: "include",
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
