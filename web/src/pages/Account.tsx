import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { absoluteUrl } from "../lib/recurrence";
import { TopBar } from "../components/Chrome";
import { Logo } from "./Login";

const panel = "mt-6 rounded-card border border-rule bg-white p-4 dark:border-ink-3 dark:bg-ink-2";
const heading = "text-xs font-medium uppercase tracking-wide opacity-50";

type TwoFactorStatus = { enabled: boolean; recoveryCodesLeft: number; required: boolean; hasPassword: boolean };

export default function AccountPage() {
  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <main className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto p-6">
        <h1 className="font-display text-xl font-bold">Account settings</h1>
        <TwoFactorPanel />
        <CalendarFeeds />
      </main>
    </div>
  );
}

/** shown instead of the app when the instance requires 2FA and this account has none */
export function EnrolRequired() {
  const { logout } = useAuth();
  const nav = useNavigate();
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center gap-3">
          <Logo />
          <h1 className="font-display text-2xl font-bold tracking-tight">TR Board</h1>
        </div>
        <p className="text-sm opacity-70">
          This TR Board requires two-factor authentication. Set it up to continue.
        </p>
        <TwoFactorPanel />
        <button className="mt-4 text-sm underline opacity-70 hover:opacity-100" onClick={async () => { await logout(); nav("/login"); }}>
          Log out
        </button>
      </div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn-ghost !py-1 text-xs"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          prompt("Copy this:", text); // clipboard API needs https or localhost
        }
      }}
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <div className="mt-3 rounded-md bg-ink/5 p-3 dark:bg-paper/10">
      <p className="text-sm font-medium">Recovery codes</p>
      <p className="mt-1 text-xs opacity-70">
        Each one signs you in once if you lose your phone. Store them somewhere safe; they won't be shown again.
      </p>
      <pre className="mt-2 grid grid-cols-2 gap-1 font-mono text-sm">
        {codes.map((c) => <span key={c}>{c}</span>)}
      </pre>
      <div className="mt-2 flex gap-2">
        <CopyButton text={codes.join("\n")} />
        <button className="btn-accent !py-1 text-xs" onClick={onDone}>I've saved them</button>
      </div>
    </div>
  );
}

export function TwoFactorPanel() {
  const qc = useQueryClient();
  const { refresh } = useAuth();
  const { data } = useQuery({ queryKey: ["2fa"], queryFn: () => api.get<TwoFactorStatus>("/api/auth/2fa") });
  const [setup, setSetup] = useState<{ secret: string; qrSvg: string } | null>(null);
  const [code, setCode] = useState("");
  const [secret, setSecret] = useState(""); // password, or a code for SSO-only accounts
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () => qc.invalidateQueries({ queryKey: ["2fa"] });
  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (err: any) {
      setError(err.message);
    }
  };
  const reauth = data?.hasPassword ? { password: secret } : { code: secret };

  return (
    <section className={panel}>
      <h2 className={heading}>Two-factor authentication</h2>
      {!data ? (
        <p className="mt-2 text-sm opacity-60">Loading…</p>
      ) : codes ? (
        <RecoveryCodes codes={codes} onDone={async () => { setCodes(null); reload(); await refresh(); }} />
      ) : data.enabled ? (
        <>
          <p className="mt-2 text-sm">
            On. {data.recoveryCodesLeft} of 10 recovery codes left.
            {data.required && <span className="opacity-60"> Required on this instance.</span>}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              className="input !w-56"
              type={data.hasPassword ? "password" : "text"}
              placeholder={data.hasPassword ? "Your password" : "Current 6-digit code"}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
            <button
              className="btn-ghost text-sm"
              onClick={() => run(async () => {
                const r = await api.post<{ recoveryCodes: string[] }>("/api/auth/2fa/recovery-codes", reauth);
                setSecret("");
                setCodes(r.recoveryCodes);
              })}
            >
              New recovery codes
            </button>
            {!data.required && (
              <button
                className="btn-ghost text-sm text-[#b03a37]"
                onClick={() => run(async () => {
                  await api.post("/api/auth/2fa/disable", reauth);
                  setSecret("");
                  reload();
                  await refresh();
                })}
              >
                Turn off
              </button>
            )}
          </div>
        </>
      ) : setup ? (
        <>
          <p className="mt-2 text-sm">Scan this with an authenticator app (1Password, Aegis, Google Authenticator…), then enter the code it shows.</p>
          <div className="mt-3 flex flex-wrap items-start gap-4">
            <img
              src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(setup.qrSvg)}`}
              alt="QR code for your authenticator app"
              className="h-40 w-40 rounded bg-white p-1"
            />
            <div className="min-w-0 flex-1 space-y-2">
              <p className="text-xs opacity-60">Can't scan? Enter this key:</p>
              <p className="break-all font-mono text-sm">{setup.secret.match(/.{1,4}/g)!.join(" ")}</p>
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  run(async () => {
                    const r = await api.post<{ recoveryCodes: string[] }>("/api/auth/2fa/enable", { code: code.replace(/\s/g, "") });
                    setSetup(null);
                    setCode("");
                    setCodes(r.recoveryCodes);
                  });
                }}
              >
                <input
                  className="input !w-32" inputMode="numeric" autoComplete="one-time-code" placeholder="123456"
                  value={code} onChange={(e) => setCode(e.target.value)} required maxLength={8}
                />
                <button className="btn-accent text-sm">Turn on</button>
              </form>
            </div>
          </div>
        </>
      ) : (
        <>
          <p className="mt-2 text-sm opacity-70">Off. With it on, signing in also needs a code from your phone.</p>
          <button
            className="btn-accent mt-3 text-sm"
            onClick={() => run(async () => setSetup(await api.post<{ secret: string; qrSvg: string }>("/api/auth/2fa/setup")))}
          >
            Set up
          </button>
        </>
      )}
      {error && <p className="mt-2 text-sm text-[#b03a37]">{error}</p>}
    </section>
  );
}

type Feeds = {
  enabled: boolean;
  myUrl: string | null;
  boards: Array<{ id: string; name: string; workspaceName: string; url: string | null }>;
};

function CalendarFeeds() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["feeds"], queryFn: () => api.get<Feeds>("/api/me/feeds") });
  const reload = () => qc.invalidateQueries({ queryKey: ["feeds"] });

  return (
    <section className={panel}>
      <h2 className={heading}>Calendar feeds</h2>
      <p className="mt-2 text-sm opacity-70">
        Subscribe in Google Calendar, Apple Calendar or Outlook to see due dates there. Read-only; your calendar app
        refreshes it on its own schedule. Anyone with a link can read it, so treat it like a password.
      </p>
      {!data ? null : !data.enabled ? (
        <button className="btn-accent mt-3 text-sm" onClick={async () => { await api.post("/api/me/feeds/token"); reload(); }}>
          Create feed links
        </button>
      ) : (
        <>
          <FeedRow label="My cards" hint="Cards and checklist items assigned to me, on every board" url={absoluteUrl(data.myUrl!)} />
          <details className="mt-3">
            <summary className="cursor-pointer text-sm opacity-80">One board ({data.boards.length})</summary>
            <ul className="mt-1 divide-y divide-rule dark:divide-ink-3">
              {data.boards.map((b) => (
                <li key={b.id}>
                  <FeedRow label={b.name} hint={b.workspaceName} url={absoluteUrl(b.url!)} />
                </li>
              ))}
            </ul>
          </details>
          <div className="mt-4 flex gap-2 border-t border-rule pt-3 dark:border-ink-3">
            <button
              className="btn-ghost text-sm"
              onClick={async () => {
                if (!confirm("Make new links? Every calendar subscribed to the old ones stops updating.")) return;
                await api.post("/api/me/feeds/token");
                reload();
              }}
            >
              Regenerate links
            </button>
            <button
              className="btn-ghost text-sm text-[#b03a37]"
              onClick={async () => {
                if (!confirm("Turn calendar feeds off? Subscribed calendars stop updating.")) return;
                await api.del("/api/me/feeds/token");
                reload();
              }}
            >
              Turn off
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function FeedRow({ label, hint, url }: { label: string; hint: string; url: string }) {
  return (
    <div className="flex items-center gap-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{label}</p>
        <p className="truncate text-xs opacity-60">{hint}</p>
      </div>
      <CopyButton text={url} />
    </div>
  );
}
