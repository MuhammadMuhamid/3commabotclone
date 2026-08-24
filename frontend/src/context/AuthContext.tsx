import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { api, type AuthUser } from "../api";

type AuthCtx = {
  user: AuthUser | null;
  loading: boolean;
  setUser: (u: AuthUser | null) => void;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthCtx>({
  user: null,
  loading: true,
  setUser: () => {},
  logout: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  // On mount: verify session via GET /api/auth/me
  useEffect(() => {
    api.auth
      .me()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  // Listen for the "auth:expired" event emitted by api.ts when refresh fails.
  // This clears the user state which causes ProtectedRoute to redirect to /login.
  useEffect(() => {
    const handler = () => setUser(null);
    window.addEventListener("auth:expired", handler);
    return () => window.removeEventListener("auth:expired", handler);
  }, []);

  // Proactively rotate the session every 10 min while logged in, so the 15-min
  // access token never lapses under an active user. Purely a top-up: a failure
  // here changes nothing, the normal 401 -> refresh path still covers it.
  useEffect(() => {
    if (!user) return;
    const id = setInterval(() => { void api.auth.refresh(); }, 10 * 60 * 1000);
    return () => clearInterval(id);
  }, [user]);

  const logout = useCallback(async () => {
    await api.auth.logout().catch(() => {});
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, setUser, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
