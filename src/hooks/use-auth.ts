import { useCallback, useEffect, useState } from "react";
import { api, clearSession, getStoredUser, getToken, refreshSession, setSession, type User } from "@/lib/api";

export function useAuth() {
  const [user, setUser] = useState<User | null>(() => getStoredUser());
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const sync = () => setUser(getStoredUser());
    const bootstrap = async () => {
      try {
        const existing = getToken();
        const stored = getStoredUser();
        if (existing && stored) {
          if (active) setUser(stored);
          return;
        }
        const result = await refreshSession();
        if (active) { setSession(result.access_token, result.user); setUser(result.user); }
      } catch {
        if (active) { clearSession(); setUser(null); }
      } finally {
        if (active) setIsLoading(false);
      }
    };
    window.addEventListener("contexttrace-auth", sync);
    window.addEventListener("storage", sync);
    void bootstrap();
    return () => { active = false; window.removeEventListener("contexttrace-auth", sync); window.removeEventListener("storage", sync); };
  }, []);

  const signIn = useCallback(async (email: string, password: string, register = false) => {
    setIsLoading(true);
    try {
      const result = register ? await api.auth.register(email, password) : await api.auth.login(email, password);
      setSession(result.access_token, result.user);
      setUser(result.user);
      return result.user;
    } finally { setIsLoading(false); }
  }, []);

  const tryFree = useCallback(async () => {
    setIsLoading(true);
    try {
      const result = await api.auth.guest();
      setSession(result.access_token, result.user);
      setUser(result.user);
      return result.user;
    } finally { setIsLoading(false); }
  }, []);

  const signOut = useCallback(async () => { try { await api.auth.logout(); } finally { clearSession(); setUser(null); } }, []);

  return { user, isLoading, isAuthenticated: Boolean(getToken() && user), signIn, tryFree, signOut };
}
