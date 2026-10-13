import { useEffect, useRef, useState } from "react";
export const TOKEN_KEY = "study-cafe-session";
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public details?: any,
  ) {
    super(message);
  }
}
export async function api<T = any>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch("/api" + path, {
      method,
      signal,
      headers: {
        Authorization: "Bearer " + (sessionStorage.getItem(TOKEN_KEY) ?? ""),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(
      "OFFLINE",
      "서버에 연결할 수 없어요. 로컬 서버 실행 상태를 확인해 주세요.",
      0,
    );
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401)
      window.dispatchEvent(new Event("study-cafe:unauthorized"));
    throw new ApiError(
      data?.error?.code ?? "HTTP",
      data?.error?.message ?? "요청을 처리하지 못했어요.",
      res.status,
      data?.error?.details,
    );
  }
  return data;
}
export function useQuery<T = any>(path: string | null, interval = 0) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const serial = useRef(0);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    const seq = ++serial.current;
    setData(undefined);
    setError("");
    setLoading(!!path);
    const load = async () => {
      if (!path) return;
      try {
        const value = await api<T>(path, "GET", undefined, controller.signal);
        if (live && seq === serial.current) {
          setData(value);
          setError("");
        }
      } catch (e) {
        if (live && (e as Error).name !== "AbortError")
          setError((e as Error).message);
      } finally {
        if (live) setLoading(false);
      }
    };
    void load();
    const timer = interval
      ? setInterval(() => void load(), interval)
      : undefined;
    return () => {
      live = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [path, tick, interval]);
  return { data, error, loading, reload: () => setTick((t) => t + 1), setData };
}
export function go(path: string) {
  location.hash = path;
}
export function useRoute() {
  const [route, set] = useState(location.hash.slice(1) || "/");
  useEffect(() => {
    const fn = () => set(location.hash.slice(1) || "/");
    addEventListener("hashchange", fn);
    return () => removeEventListener("hashchange", fn);
  }, []);
  return route;
}
export const message = (e: unknown) =>
  e instanceof Error ? e.message : "처리 중 오류가 발생했어요.";
