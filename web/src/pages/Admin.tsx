import { useState } from "react";
import { Navigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Avatar, TopBar } from "../components/Chrome";

type AdminUser = {
  id: string; email: string; name: string;
  avatarColor: string; isAdmin: boolean; createdAt: string;
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
      </main>
    </div>
  );
}
