import { createContext, useContext, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./api";
import { resetSocket } from "./socket";
import type { User } from "./types";

type AuthCtx = {
  user: User | null;
  loading: boolean;
  refresh(): Promise<void>;
  logout(): Promise<void>;
};

const Ctx = createContext<AuthCtx>({ user: null, loading: true, refresh: async () => {}, logout: async () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        return (await api.get<{ user: User }>("/api/auth/me")).user;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
  });

  const refresh = async () => {
    resetSocket();
    await qc.invalidateQueries({ queryKey: ["me"] });
  };
  const logout = async () => {
    await api.post("/api/auth/logout");
    resetSocket();
    qc.setQueryData(["me"], null);
    qc.clear();
  };

  return (
    <Ctx.Provider value={{ user: data ?? null, loading: isLoading, refresh, logout }}>
      {children}
    </Ctx.Provider>
  );
}

export const useAuth = () => useContext(Ctx);

export function applyTheme(theme: string) {
  localStorage.setItem("trboard-theme", theme);
  const dark =
    theme === "dark" ||
    (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}
