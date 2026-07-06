import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { TopBar } from "../components/Chrome";
import type { Workspace } from "../lib/types";

export default function Home() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => api.get<{ workspaces: Workspace[] }>("/api/workspaces"),
  });
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    try {
      await api.post("/api/workspaces", { name: name.trim() });
      setName("");
      qc.invalidateQueries({ queryKey: ["workspaces"] });
    } finally {
      setCreating(false);
    }
  };

  const workspaces = data?.workspaces ?? [];

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <main className="mx-auto w-full max-w-3xl flex-1 p-6">
        <h1 className="font-display text-xl font-bold">Workspaces</h1>
        {isLoading && <p className="mt-4 text-sm opacity-60">Loading…</p>}
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {workspaces.map((ws) => (
            <Link
              key={ws.id}
              to={`/w/${ws.id}`}
              className="rounded-card border border-rule bg-white p-4 shadow-card transition-colors hover:border-ink/40 dark:border-ink-3 dark:bg-ink-2 dark:hover:border-paper/40"
            >
              <span className="font-display text-base font-semibold">{ws.name}</span>
              <p className="mt-1 text-xs uppercase tracking-wide opacity-50">{ws.role}</p>
            </Link>
          ))}
        </div>
        {!isLoading && workspaces.length === 0 && (
          <p className="mt-4 text-sm opacity-70">
            No workspaces yet — create your first one below.
          </p>
        )}
        <form onSubmit={create} className="mt-8 flex max-w-md gap-2">
          <input
            className="input"
            placeholder="New workspace name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
          />
          <button className="btn-accent shrink-0" disabled={creating || !name.trim()}>
            Create
          </button>
        </form>
      </main>
    </div>
  );
}
