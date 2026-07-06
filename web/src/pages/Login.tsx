import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";

export default function Login() {
  const { user, refresh } = useAuth();
  const nav = useNavigate();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") {
        await api.post("/api/auth/login", { email, password });
      } else {
        await api.post("/api/auth/register", { email, name, password });
      }
      await refresh();
      nav("/", { replace: true });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <Logo />
          <h1 className="font-display text-2xl font-bold tracking-tight">TR Board</h1>
        </div>
        <form onSubmit={submit} className="space-y-3">
          {mode === "register" && (
            <input
              className="input"
              placeholder="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={80}
            />
          )}
          <input
            className="input"
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
          <input
            className="input"
            type="password"
            placeholder="Password (8+ characters)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
          {error && <p className="text-sm text-[#b03a37]">{error}</p>}
          <button className="btn-accent w-full" disabled={busy}>
            {busy ? "…" : mode === "login" ? "Log in" : "Create account"}
          </button>
        </form>
        <button
          className="mt-4 text-sm underline opacity-70 hover:opacity-100"
          onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(null); }}
        >
          {mode === "login" ? "First time? Create an account" : "Have an account? Log in"}
        </button>
        <p className="mt-8 text-xs opacity-40">
          Self-hosted · TR Studios · the first account becomes the instance admin
        </p>
      </div>
    </div>
  );
}

export function Logo({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="7" fill="#FFE600" />
      <rect x="6" y="7" width="6" height="18" rx="1.5" fill="#16181d" />
      <rect x="14" y="7" width="6" height="12" rx="1.5" fill="#16181d" />
      <rect x="22" y="7" width="6" height="15" rx="1.5" fill="#16181d" />
    </svg>
  );
}
