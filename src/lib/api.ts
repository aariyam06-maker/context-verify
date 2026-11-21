import { useCallback, useEffect, useState } from "react";

export type User = { id: string; email: string; role: string };

const API_BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") || "http://localhost:8000/api";
const TOKEN_KEY = "contexttrace.access_token";
const USER_KEY = "contexttrace.user";
let memoryToken: string | null = null;

export function getToken() {
  return memoryToken;
}

export function getStoredUser(): User | null {
  try {
    const raw = sessionStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}

export function setSession(token: string, user: User) {
  memoryToken = token;
  sessionStorage.setItem(USER_KEY, JSON.stringify(user));
  window.dispatchEvent(new Event("contexttrace-auth"));
}

export function clearSession() {
  memoryToken = null;
  sessionStorage.removeItem(USER_KEY);
  window.dispatchEvent(new Event("contexttrace-auth"));
}

async function request<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const headers = new Headers(init.headers);
  if (!(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers, credentials: "include" });
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (res.status === 401 && !retried && !path.startsWith("/auth/refresh") && !path.startsWith("/auth/login") && !path.startsWith("/auth/register") && !path.startsWith("/auth/guest")) {
    try {
      const refreshed = await request<{ access_token: string; user: User }>("/auth/refresh", { method: "POST" }, true);
      setSession(refreshed.access_token, refreshed.user);
      return request<T>(path, init, true);
    } catch {
      clearSession();
    }
  }
  if (res.status === 401) clearSession();
  if (!res.ok) {
    const rawDetail = typeof body === "object" && body && "detail" in body ? (body as { detail: unknown }).detail : null;
    const detail = formatApiDetail(rawDetail) || `Request failed (${res.status})`;
    throw new Error(detail);
  }
  return body as T;
}

function formatApiDetail(detail: unknown): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const messages = detail.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && "msg" in item) return String((item as { msg: unknown }).msg);
      return null;
    }).filter((message): message is string => Boolean(message));
    if (messages.length) return messages.join(" ");
  }
  return "";
}

let refreshPromise: Promise<{ access_token: string; user: User }> | null = null;

export function refreshSession() {
  if (!refreshPromise) {
    refreshPromise = request<{ access_token: string; user: User }>("/auth/refresh", { method: "POST" })
      .finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

export type JobSummary = {
  _id: string;
  mode: "detect" | "tamper";
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
  currentStage: string | null;
  progress: number;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  errorMessage: string | null;
  videoA: string | null;
  videoB: string | null;
  videoAId: string | null;
  videoBId: string | null;
  headline: Record<string, any> | null;
};

export const api = {
  auth: {
    register: (email: string, password: string) => request<{ access_token: string; user: User }>("/auth/register", { method: "POST", body: JSON.stringify({ email, password }) }),
    guest: () => request<{ access_token: string; user: User }>("/auth/guest", { method: "POST" }),
    login: (email: string, password: string) => request<{ access_token: string; user: User }>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
    refresh: () => request<{ access_token: string; user: User }>("/auth/refresh", { method: "POST" }),
    logout: () => request<{ ok: boolean }>("/auth/logout", { method: "POST" }),
    demo: () => request<{ enabled: boolean; accounts: Array<{ email: string; password: string; label: string; role: string }> }>("/auth/demo"),
  },
  health: () => request<{ ok: boolean; models: { aiDetector: boolean; tamper: boolean }; gemini: boolean }>("/health"),
  videos: {
    upload: (file: File, type: "detect" | "a" | "b") => {
      const form = new FormData(); form.append("file", file); form.append("type", type);
      return request<{ ok: boolean; videoId: string; filename: string; durationSeconds: number; width: number; height: number; hasAudio: boolean }>("/videos/upload", { method: "POST", body: form });
    },
    stream: async (id: string) => {
      const token = getToken();
      const res = await fetch(`${API_BASE}/videos/${encodeURIComponent(id)}/stream`, { credentials: "include", headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!res.ok) throw new Error(`Unable to load video (${res.status})`);
      return URL.createObjectURL(await res.blob());
    },
  },
  jobs: {
    list: () => request<JobSummary[]>("/jobs"),
    get: (id: string) => request<JobSummary>(`/jobs/${id}`),
    report: (id: string) => request<JobSummary & { interpretation: string; result: any }>(`/jobs/${id}/report`),
    remove: (id: string) => request<{ ok: boolean }>(`/jobs/${id}`, { method: "DELETE" }),
    detect: (videoId: string, inferenceMode: "full" | "light" = "full") => request<{ jobId: string }>(`/jobs/detect?videoId=${encodeURIComponent(videoId)}&inferenceMode=${inferenceMode}`, { method: "POST" }),
    tamper: (a: string, b: string) => request<{ jobId: string }>(`/jobs/tamper?videoAId=${encodeURIComponent(a)}&videoBId=${encodeURIComponent(b)}`, { method: "POST" }),
    reportDownload: async (id: string, format: "pdf" | "json" = "pdf") => {
      const token = getToken();
      const res = await fetch(`${API_BASE}/jobs/${encodeURIComponent(id)}/report/download?format=${format}`, { credentials: "include", headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!res.ok) throw new Error(`Unable to download report (${res.status})`);
      return res.blob();
    },
  },
  admin: { overview: () => request<any>("/admin/overview"), models: () => request<any>("/admin/models"), updateRole: (id: string, role: "user" | "admin") => request<any>(`/admin/users/${encodeURIComponent(id)}/role`, { method: "PATCH", body: JSON.stringify({ role }) }) },
};

export function useApiQuery<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let active = true;
    setError(null);
    loader().then((value) => { if (active) setData(value); }).catch((err) => { if (active) setError(err instanceof Error ? err : new Error(String(err))); });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, isLoading: data === undefined && error === null, refetch: loader };
}

export function usePollingQuery<T>(loader: () => Promise<T>, intervalMs = 1200) {
  const query = useApiQuery(loader, [loader]);
  useEffect(() => {
    const id = window.setInterval(() => { void loader().then((v) => queryRefSet(query, v)).catch(() => undefined); }, intervalMs);
    return () => window.clearInterval(id);
  }, [loader, intervalMs]);
  return query;
}

function queryRefSet<T>(query: { refetch: () => Promise<T> }, _value: T) {
  // Kept intentionally side-effect free; consumers that need polling use the
  // dedicated hook below. This helper exists only to keep the callback typed.
  void query;
}

export function useJobPolling<T>(id: string | undefined, loader: (id: string) => Promise<T>, terminal?: (v: T) => boolean) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    if (!id) return;
    let active = true;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const value = await loader(id);
        if (!active) return;
        setData(value);
        if (!terminal?.(value)) timer = window.setTimeout(tick, 1200);
      } catch (e) {
        if (active) { setError(e instanceof Error ? e : new Error(String(e))); timer = window.setTimeout(tick, 1800); }
      }
    };
    void tick();
    return () => { active = false; if (timer) window.clearTimeout(timer); };
  }, [id, loader, terminal]);
  return { data, error, isLoading: data === undefined && error === null };
}
