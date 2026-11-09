import { useState } from "react";
import { Navigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Avatar, TopBar } from "../components/Chrome";

type AdminUser = {
  id: string; email: string; name: string;
  avatarColor: string; isAdmin: boolean; createdAt: string;
  totpEnabled: boolean; ssoLinked: boolean;
};

export default function AdminPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [form, setForm] = useState({ email: "", name: "", password: "", isAdmin: false });
  const [error, setError] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => api.get<{ users: AdminUser[] }>("/api/admin/users"),
    enabled: !!user?.isAdmin,
  });

  if (user && !user.isAdmin) return <Navigate to="/" replace />;

  const refetch = () => qc.invalidateQueries({ queryKey: ["admin-users"] });

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <main className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto p-6">
        <h1 className="font-display text-xl font-bold">Instance admin</h1>
        <p className="mt-1 text-sm opacity-60">
          Users on this TR Board install. Instance admins see and manage every workspace.
        </p>

        <form
          className="mt-6 grid gap-2 rounded-card border border-rule bg-white p-4 dark:border-ink-3 dark:bg-ink-2 sm:grid-cols-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              await api.post("/api/admin/users", form);
              setForm({ email: "", name: "", password: "", isAdmin: false });
              refetch();
            } catch (err: any) {
              setError(err.message);
            }
          }}
        >
          <h2 className="col-span-full text-xs font-medium uppercase tracking-wide opacity-50">Create user</h2>
          <input className="input" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={80} />
          <input className="input" type="email" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
          <input className="input" type="password" placeholder="Password (8+)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={8} />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.isAdmin} onChange={(e) => setForm({ ...form, isAdmin: e.target.checked })} />
            Instance admin
          </label>
          {error && <p className="col-span-full text-sm text-[#b03a37]">{error}</p>}
          <button className="btn-accent col-span-full sm:w-40">Create</button>
        </form>

        <ul className="mt-6 divide-y divide-rule dark:divide-ink-3">
          {(data?.users ?? []).map((u) => (
            <li key={u.id} className="flex items-center gap-3 py-3">
              <Avatar name={u.name} color={u.avatarColor} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {u.name} {u.id === user?.id && <span className="opacity-50">(you)</span>}
                </p>
                <p className="truncate text-xs opacity-60">{u.email}</p>
              </div>
              {u.totpEnabled && <span className="rounded bg-ink/10 px-2 py-0.5 text-[11px] font-semibold dark:bg-paper/15" title="Two-factor on">2FA</span>}
              {u.ssoLinked && <span className="rounded bg-ink/10 px-2 py-0.5 text-[11px] font-semibold dark:bg-paper/15" title="Linked to single sign-on">SSO</span>}
              {u.isAdmin && <span className="rounded bg-accent px-2 py-0.5 text-[11px] font-semibold text-ink">ADMIN</span>}
              {u.id !== user?.id && (
                <>
                  <button
                    className="btn-ghost !py-1 text-xs"
                    onClick={async () => { await api.patch(`/api/admin/users/${u.id}`, { isAdmin: !u.isAdmin }); refetch(); }}
                  >
                    {u.isAdmin ? "Demote" : "Make admin"}
                  </button>
                  <button
                    className="btn-ghost !py-1 text-xs"
                    onClick={async () => {
                      const pw = prompt(`New password for ${u.name} (8+ chars):`);
                      if (!pw) return;
                      try {
                        await api.patch(`/api/admin/users/${u.id}`, { password: pw });
                        alert("Password reset — their sessions were logged out.");
                      } catch (err: any) { alert(err.message); }
                    }}
                  >
                    Reset pw
                  </button>
                  {u.totpEnabled && (
                    <button
                      className="btn-ghost !py-1 text-xs"
                      onClick={async () => {
                        if (!confirm(`Reset two-factor for ${u.name}? They'll sign in with just their password and can set it up again.`)) return;
                        await api.post(`/api/admin/users/${u.id}/2fa/reset`);
                        refetch();
                      }}
                    >
                      Reset 2FA
                    </button>
                  )}
                  <button
                    className="btn-ghost !py-1 text-xs text-[#b03a37]"
                    onClick={async () => {
                      if (!confirm(`Delete ${u.name}? Their comments/cards remain but lose the author.`)) return;
                      await api.del(`/api/admin/users/${u.id}`);
                      refetch();
                    }}
                  >
                    Delete
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>

        <SecuritySettings />
        <BackupRestore />
      </main>
    </div>
  );
}

const panel = "mt-6 rounded-card border border-rule bg-white p-4 dark:border-ink-3 dark:bg-ink-2";
const heading = "text-xs font-medium uppercase tracking-wide opacity-50";

function SecuritySettings() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const { data } = useQuery({
    queryKey: ["admin-settings"],
    queryFn: () =>
      api.get<{
        settings: { require2fa: boolean };
        oidc: { enabled: boolean; issuer: string | null; autoProvision: boolean };
        registrationOpen: boolean;
      }>("/api/admin/settings"),
  });
  if (!data) return null;
  return (
    <section className={panel}>
      <h2 className={heading}>Sign-in security</h2>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={data.settings.require2fa}
          onChange={async (e) => {
            setError(null);
            try {
              await api.patch("/api/admin/settings", { require2fa: e.target.checked });
              qc.invalidateQueries({ queryKey: ["admin-settings"] });
            } catch (err: any) {
              setError(err.message);
            }
          }}
        />
        Require two-factor for every account
      </label>
      <p className="mt-1 text-xs opacity-60">
        Accounts without it can still sign in, but can only set it up until they do.
      </p>
      {error && <p className="mt-1 text-sm text-[#b03a37]">{error}</p>}
      <p className="mt-3 text-sm">
        Single sign-on:{" "}
        {data.oidc.enabled ? (
          <>on ({data.oidc.issuer}); new accounts from SSO {data.oidc.autoProvision && data.registrationOpen ? "allowed" : "off"}</>
        ) : (
          <span className="opacity-60">off (set OIDC_* env vars)</span>
        )}
      </p>
      <p className="mt-1 text-sm">
        Self-registration: <span className="opacity-60">{data.registrationOpen ? "open" : "invite-only"}</span>
      </p>
    </section>
  );
}

type RestoreSummary = {
  id: string; createdAt: string; appVersion: string;
  counts: Record<string, number>; current: Record<string, number>;
  uploads: { files: number; bytes: number };
};

const fmtBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;

function BackupRestore() {
  const qc = useQueryClient();
  const { logout } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<RestoreSummary | null>(null);
  const [typed, setTyped] = useState("");
  const { data } = useQuery({
    queryKey: ["admin-backup"],
    queryFn: () =>
      api.get<{
        schedule: { dir: string; intervalHours: number; keep: number } | null;
        files: Array<{ name: string; size: number; createdAt: string }>;
      }>("/api/admin/backup"),
  });
  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try {
      await fn();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className={panel}>
      <h2 className={heading}>Backup &amp; restore</h2>
      <p className="mt-2 text-sm opacity-70">
        One file with every board, user and setting plus all attachments. It contains password hashes and two-factor
        secrets: keep it private.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {/* a plain link: the browser streams the download itself */}
        <a className="btn-accent text-sm" href="/api/admin/backup/download">Download backup</a>
        {data?.schedule && (
          <button
            className="btn-ghost text-sm"
            disabled={!!busy}
            onClick={() => run("run", async () => {
              await api.post("/api/admin/backup/run");
              qc.invalidateQueries({ queryKey: ["admin-backup"] });
            })}
          >
            {busy === "run" ? "Backing up…" : "Back up to folder now"}
          </button>
        )}
      </div>

      <p className="mt-4 text-sm">
        Scheduled backups:{" "}
        {data?.schedule ? (
          <>
            {data.schedule.intervalHours ? `every ${data.schedule.intervalHours} h` : "manual only"} to{" "}
            <span className="font-mono text-xs">{data.schedule.dir}</span>, keeping {data.schedule.keep}
          </>
        ) : (
          <span className="opacity-60">off (set BACKUP_DIR)</span>
        )}
      </p>
      {!!data?.files.length && (
        <ul className="mt-2 divide-y divide-rule text-sm dark:divide-ink-3">
          {data.files.map((f) => (
            <li key={f.name} className="flex items-center gap-3 py-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{f.name}</span>
              <span className="text-xs opacity-60">{fmtBytes(f.size)}</span>
              <button
                className="btn-ghost !py-1 text-xs"
                disabled={!!busy}
                onClick={() => run("prepare", async () => {
                  setSummary((await api.post<{ restore: RestoreSummary }>("/api/admin/restore/from-backup", { name: f.name })).restore);
                })}
              >
                Restore…
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 border-t border-rule pt-3 dark:border-ink-3">
        <p className="text-sm font-medium">Restore from a file</p>
        <input
          type="file"
          accept=".gz,.tgz,application/gzip"
          className="mt-2 text-sm"
          disabled={!!busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            run("prepare", async () => {
              setSummary((await api.upload<{ restore: RestoreSummary }>("/api/admin/restore/upload", file)).restore);
            });
          }}
        />
        {busy === "prepare" && <p className="mt-2 text-sm opacity-60">Checking the backup…</p>}
      </div>

      {summary && (
        <div className="mt-4 rounded-md border border-[#b03a37] p-3">
          <p className="text-sm font-medium">This replaces everything on this instance</p>
          <p className="mt-1 text-xs opacity-70">
            Backup from {new Date(summary.createdAt).toLocaleString()} (TR Board {summary.appVersion}). It checked out: same
            database version, every file intact. Everyone, you included, will be signed out.
          </p>
          <table className="mt-2 text-xs">
            <thead>
              <tr className="opacity-60"><th className="pr-4 text-left font-normal"></th><th className="pr-4 text-right font-normal">now</th><th className="text-right font-normal">after</th></tr>
            </thead>
            <tbody>
              {Object.keys(summary.counts).map((k) => (
                <tr key={k}>
                  <td className="pr-4 capitalize">{k}</td>
                  <td className="pr-4 text-right">{summary.current[k]}</td>
                  <td className="text-right font-medium">{summary.counts[k]}</td>
                </tr>
              ))}
              <tr><td className="pr-4">Upload files</td><td></td><td className="text-right font-medium">{summary.uploads.files} ({fmtBytes(summary.uploads.bytes)})</td></tr>
            </tbody>
          </table>
          <p className="mt-3 text-xs">Type <span className="font-mono font-semibold">RESTORE</span> to confirm.</p>
          <div className="mt-1 flex flex-wrap gap-2">
            <input className="input !w-40 !py-1 text-sm" value={typed} onChange={(e) => setTyped(e.target.value)} />
            <button
              className="btn-accent text-sm"
              disabled={typed !== "RESTORE" || !!busy}
              onClick={() => run("restore", async () => {
                await api.post(`/api/admin/restore/${summary.id}/confirm`, { confirm: "RESTORE" });
                alert("Restore complete. Sign in again with an account from the backup.");
                await logout().catch(() => {});
                window.location.href = "/login";
              })}
            >
              {busy === "restore" ? "Restoring…" : "Restore"}
            </button>
            <button
              className="btn-ghost text-sm"
              disabled={!!busy}
              onClick={async () => {
                await api.del(`/api/admin/restore/${summary.id}`).catch(() => {});
                setSummary(null);
                setTyped("");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-[#b03a37]">{error}</p>}
    </section>
  );
}
