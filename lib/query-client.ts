import { fetch } from "expo/fetch";
import { QueryClient, QueryFunction } from "@tanstack/react-query";

/**
 * Gets the base URL for the Express API server.
 * EXPO_PUBLIC_DOMAIN may include an explicit port (e.g. "domain:5000").
 * On Replit, the dev domain already proxies to the correct port via port 443,
 * so we strip the explicit port to ensure phones connect correctly.
 */
export function getApiUrl(): string {
  let host = process.env.EXPO_PUBLIC_DOMAIN;
  if (!host) {
    throw new Error("EXPO_PUBLIC_DOMAIN is not set");
  }
  // 이미 http:// 또는 https://가 포함된 경우 그대로 사용
  if (host.startsWith("http://") || host.startsWith("https://")) {
    return host.endsWith("/") ? host : `${host}/`;
  }
  return `http://${host}/`;
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
