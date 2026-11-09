import { useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";

export default function Login() {
  const { user, refresh } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [mode, setMode] = useState<"login" | "register">("login");
  // second step: after a password (or SSO, which lands here with ?mfa=1)
  const [mfa, setMfa] = useState(params.get("mfa") === "1");
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState("");
  const { data: config } = useQuery({
    queryKey: ["auth-config"],
    queryFn: () => api.get<{ registrationOpen: boolean; oidc: { enabled: boolean; label?: string } }>("/api/auth/config"),
  });
  const ssoError = params.get("sso_error");
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
        const r = await api.post<{ twoFactorRequired?: boolean }>("/api/auth/login", { email, password });
        if (r.twoFactorRequired) {
          setMfa(true);
          return;
        }
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

  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ recoveryCodesLeft?: number }>(
        "/api/auth/login/2fa",
        useRecovery ? { recoveryCode: code } : { code: code.replace(/\s/g, "") },
      );
      if (r.recoveryCodesLeft !== undefined && r.recoveryCodesLeft <= 3) {
        alert(`${r.recoveryCodesLeft} recovery codes left. Make new ones in Account settings.`);
      }
      await refresh();
      nav("/", { replace: true });
    } catch (err: any) {
      if (err.status === 401 && /expired/.test(err.message)) setMfa(false);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const header = (
    <div className="mb-8 flex items-center gap-3">
      <Logo />
      <h1 className="font-display text-2xl font-bold tracking-tight">TR Board</h1>
    </div>
  );

  if (mfa) {
    return (
      <div className="flex min-h-full items-center justify-center p-6">
        <div className="w-full max-w-sm">
          {header}
          <form onSubmit={submitCode} className="space-y-3">
            <p className="text-sm opacity-70">
              {useRecovery ? "Enter one of your recovery codes." : "Enter the 6-digit code from your authenticator app."}
            </p>
            <input
              className="input"
              inputMode={useRecovery ? "text" : "numeric"}
              autoComplete="one-time-code"
              placeholder={useRecovery ? "xxxx-xxxx-xxxx-xxxx" : "123456"}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              autoFocus
              maxLength={useRecovery ? 40 : 8}
            />
            {error && <p className="text-sm text-[#b03a37]">{error}</p>}
            <button className="btn-accent w-full" disabled={busy}>{busy ? "…" : "Verify"}</button>
          </form>
          <button
            className="mt-4 text-sm underline opacity-70 hover:opacity-100"
            onClick={() => { setUseRecovery(!useRecovery); setCode(""); setError(null); }}
          >
            {useRecovery ? "Use the authenticator app" : "Lost your phone? Use a recovery code"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm">
        {header}
        {ssoError && mode === "login" && <p className="mb-3 text-sm text-[#b03a37]">{SSO_ERRORS[ssoError] ?? "Single sign-on failed."}</p>}
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
        {config?.oidc.enabled && mode === "login" && (
          // a full navigation, not fetch: the IdP redirect has to happen in the browser
          <a href="/api/auth/oidc/start" className="btn-ghost mt-3 w-full justify-center border border-rule text-sm dark:border-ink-3">
            {config.oidc.label}
          </a>
        )}
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

const SSO_ERRORS: Record<string, string> = {
  email_unverified: "Your identity provider didn't confirm your email address, so it can't be matched to an account.",
  no_account: "There's no TR Board account for that email. Ask an admin to create one.",
  identity_mismatch: "That account is already linked to a different single sign-on identity.",
  expired: "The sign-in took too long or was opened in another browser. Try again.",
  unavailable: "The identity provider couldn't be reached. Try again, or log in with your password.",
  rate_limited: "Too many sign-in attempts. Wait a few minutes.",
  failed: "Single sign-on failed. Try again.",
};

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
