import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Avatar, TopBar } from "../components/Chrome";
import type { Board, Team, Workspace, WsMember } from "../lib/types";

type WsPayload = {
  workspace: Workspace;
  boards: Board[];
  members: WsMember[];
  teams: Team[];
};

const BG_TILES: Record<string, string> = {
  navy: "bg-board-navy", sky: "bg-board-sky", teal: "bg-board-teal",
  forest: "bg-board-forest", amber: "bg-board-amber", crimson: "bg-board-crimson",
  plum: "bg-board-plum", slate: "bg-board-slate", ink: "bg-board-ink",
};

export default function WorkspacePage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const qc = useQueryClient();
  const { user } = useAuth();
  const [tab, setTab] = useState<"boards" | "members" | "teams" | "settings">("boards");

  const { data, error } = useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => api.get<WsPayload>(`/api/workspaces/${workspaceId}`),
    enabled: !!workspaceId,
  });

  if (error) {
    return (
      <div className="flex h-full flex-col">
        <TopBar />
        <p className="p-6 text-sm opacity-70">Workspace not found (or you don't have access).</p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex h-full flex-col">
        <TopBar />
        <p className="p-6 text-sm opacity-60">Loading…</p>
      </div>
    );
  }

  const { workspace, boards, members, teams } = data;
  const isWsAdmin = workspace.role === "admin" || !!user?.isAdmin;
  const invalidate = () => qc.invalidateQueries({ queryKey: ["workspace", workspaceId] });

  const starred = boards.filter((b) => b.starred && !b.archived);
  const active = boards.filter((b) => !b.archived);
  const archived = boards.filter((b) => b.archived);

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <main className="mx-auto w-full max-w-5xl flex-1 overflow-y-auto p-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-display text-xl font-bold">{workspace.name}</h1>
          <nav className="ml-auto flex gap-1">
            {(["boards", "members", "teams", ...(isWsAdmin ? ["settings"] : [])] as const).map((t) => (
              <button
                key={t}
                className={`btn-ghost !py-1 text-sm capitalize ${tab === t ? "bg-ink/10 dark:bg-paper/15" : ""}`}
                onClick={() => setTab(t as typeof tab)}
              >
                {t}
              </button>
            ))}
          </nav>
        </div>

        {tab === "boards" && (
          <>
            {starred.length > 0 && (
              <>
                <h2 className="mt-6 text-xs font-medium uppercase tracking-wide opacity-50">★ Starred</h2>
                <BoardGrid boards={starred} />
              </>
            )}
            <h2 className="mt-6 text-xs font-medium uppercase tracking-wide opacity-50">Boards</h2>
            <BoardGrid boards={active}>
              <CreateBoardTile workspaceId={workspace.id} onCreated={invalidate} />
            </BoardGrid>
            {archived.length > 0 && (
              <>
                <h2 className="mt-6 text-xs font-medium uppercase tracking-wide opacity-50">Archived</h2>
                <BoardGrid boards={archived} dim />
              </>
            )}
          </>
        )}

        {tab === "members" && (
          <MembersTab workspaceId={workspace.id} members={members} isAdmin={isWsAdmin} meId={user!.id} onChange={invalidate} />
        )}
        {tab === "teams" && (
          <TeamsTab workspaceId={workspace.id} teams={teams} members={members} isAdmin={isWsAdmin} onChange={invalidate} />
        )}
        {tab === "settings" && isWsAdmin && (
          <SettingsTab workspace={workspace} onChange={invalidate} />
        )}
      </main>
    </div>
  );
}

function BoardGrid({ boards, children, dim }: { boards: Board[]; children?: React.ReactNode; dim?: boolean }) {
  return (
    <div className={`mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 ${dim ? "opacity-60" : ""}`}>
      {boards.map((b) => (
        <Link
          key={b.id}
          to={`/b/${b.id}`}
          className={`${BG_TILES[b.background] ?? "bg-board-navy"} flex h-24 flex-col justify-between rounded-card p-3 text-white shadow-card transition-transform hover:scale-[1.02]`}
        >
          <span className="font-display font-semibold leading-tight">{b.name}</span>
          <span className="text-[11px] uppercase tracking-wide opacity-70">{b.visibility}</span>
        </Link>
      ))}
      {children}
    </div>
  );
}

function CreateBoardTile({ workspaceId, onCreated }: { workspaceId: string; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [background, setBackground] = useState("navy");
  const [visibility, setVisibility] = useState<"private" | "team" | "workspace">("workspace");

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex h-24 items-center justify-center rounded-card border-2 border-dashed border-rule text-sm opacity-70 transition-colors hover:border-ink/40 hover:opacity-100 dark:border-ink-3 dark:hover:border-paper/40"
      >
        + New board
      </button>
    );
  }
  return (
    <form
      className="col-span-2 rounded-card border border-rule bg-white p-3 shadow-card dark:border-ink-3 dark:bg-ink-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        await api.post("/api/boards", { workspaceId, name: name.trim(), background, visibility });
        setOpen(false);
        setName("");
        onCreated();
      }}
    >
      <input className="input" placeholder="Board name" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={120} />
      <div className="mt-2 flex gap-1">
        {Object.entries(BG_TILES).map(([key, cls]) => (
          <button
            key={key}
            type="button"
            title={key}
            className={`${cls} h-7 w-9 rounded ${background === key ? "ring-2 ring-accent ring-offset-1" : ""}`}
            onClick={() => setBackground(key)}
          />
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <select className="input !w-auto" value={visibility} onChange={(e) => setVisibility(e.target.value as any)}>
          <option value="workspace">Workspace — all members see it</option>
          <option value="team">Team — granted teams see it</option>
          <option value="private">Private — invited members only</option>
        </select>
        <button className="btn-accent ml-auto" disabled={!name.trim()}>Create</button>
        <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}

function MembersTab({
  workspaceId, members, isAdmin, meId, onChange,
}: { workspaceId: string; members: WsMember[]; isAdmin: boolean; meId: string; onChange: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="mt-6 max-w-xl">
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            await api.post(`/api/workspaces/${workspaceId}/members`, { email, role });
            setEmail("");
            onChange();
          } catch (err: any) {
            setError(err.message);
          }
        }}
      >
        <input className="input" type="email" placeholder="user@email — must already have an account" value={email} onChange={(e) => setEmail(e.target.value)} />
        {isAdmin && (
          <select className="input !w-auto" value={role} onChange={(e) => setRole(e.target.value as any)}>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        )}
        <button className="btn-accent shrink-0" disabled={!email}>Add</button>
      </form>
      {error && <p className="mt-2 text-sm text-[#b03a37]">{error}</p>}
      <ul className="mt-4 divide-y divide-rule dark:divide-ink-3">
        {members.map((m) => (
          <li key={m.id} className="flex items-center gap-3 py-2.5">
            <Avatar name={m.name} color={m.avatarColor} />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{m.name}</p>
              <p className="truncate text-xs opacity-60">{m.email}</p>
            </div>
            <span className="ml-auto rounded bg-ink/10 px-2 py-0.5 text-xs uppercase tracking-wide dark:bg-paper/15">{m.role}</span>
            {(isAdmin || m.id === meId) && (
              <button
                className="btn-ghost !py-1 text-xs"
                onClick={async () => {
                  try {
                    await api.del(`/api/workspaces/${workspaceId}/members/${m.id}`);
                    onChange();
                  } catch (err: any) {
                    setError(err.message);
                  }
                }}
              >
                {m.id === meId ? "Leave" : "Remove"}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function TeamsTab({
  workspaceId, teams, members, isAdmin, onChange,
}: { workspaceId: string; teams: Team[]; members: WsMember[]; isAdmin: boolean; onChange: () => void }) {
  const [name, setName] = useState("");

  return (
    <div className="mt-6 max-w-xl">
      <p className="text-sm opacity-70">
        Teams gate <strong>team-visible boards</strong> — a board set to “Team” is only seen by members of its granted teams.
      </p>
      {isAdmin && (
        <form
          className="mt-3 flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!name.trim()) return;
            await api.post(`/api/workspaces/${workspaceId}/teams`, { name: name.trim() });
            setName("");
            onChange();
          }}
        >
          <input className="input" placeholder="New team name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          <button className="btn-accent shrink-0" disabled={!name.trim()}>Create team</button>
        </form>
      )}
      <div className="mt-4 space-y-3">
        {teams.map((t) => (
          <TeamRow key={t.id} team={t} members={members} isAdmin={isAdmin} onChange={onChange} />
        ))}
        {teams.length === 0 && <p className="mt-3 text-sm opacity-60">No teams yet.</p>}
      </div>
    </div>
  );
}

function TeamRow({ team, members, isAdmin, onChange }: { team: Team; members: WsMember[]; isAdmin: boolean; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set(team.memberIds));

  return (
    <div className="rounded-card border border-rule bg-white p-3 dark:border-ink-3 dark:bg-ink-2">
      <div className="flex items-center gap-2">
        <span className="h-3 w-3 rounded-full" style={{ background: team.color }} />
        <span className="font-medium">{team.name}</span>
        <span className="text-xs opacity-50">{team.memberIds.length} member{team.memberIds.length === 1 ? "" : "s"}</span>
        {isAdmin && (
          <div className="ml-auto flex gap-1">
            <button className="btn-ghost !py-1 text-xs" onClick={() => { setSelected(new Set(team.memberIds)); setEditing(!editing); }}>
              {editing ? "Close" : "Edit"}
            </button>
            <button
              className="btn-ghost !py-1 text-xs text-[#b03a37]"
              onClick={async () => { await api.del(`/api/teams/${team.id}`); onChange(); }}
            >
              Delete
            </button>
          </div>
        )}
      </div>
      {!editing && team.memberIds.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {team.memberIds.map((uid) => {
            const m = members.find((x) => x.id === uid);
            return m ? <Avatar key={uid} name={m.name} color={m.avatarColor} size={24} /> : null;
          })}
        </div>
      )}
      {editing && (
        <div className="mt-2">
          {members.map((m) => (
            <label key={m.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-ink/5 dark:hover:bg-paper/10">
              <input
                type="checkbox"
                checked={selected.has(m.id)}
                onChange={(e) => {
                  const next = new Set(selected);
                  e.target.checked ? next.add(m.id) : next.delete(m.id);
                  setSelected(next);
                }}
              />
              <Avatar name={m.name} color={m.avatarColor} size={22} />
              {m.name}
            </label>
          ))}
          <button
            className="btn-accent mt-2 !py-1 text-xs"
            onClick={async () => {
              await api.patch(`/api/teams/${team.id}`, { memberIds: [...selected] });
              setEditing(false);
              onChange();
            }}
          >
            Save members
          </button>
        </div>
      )}
    </div>
  );
}

function SettingsTab({ workspace, onChange }: { workspace: Workspace; onChange: () => void }) {
  const [name, setName] = useState(workspace.name);
  const s = workspace.settings;
  const setSetting = async (key: string, value: string) => {
    await api.patch(`/api/workspaces/${workspace.id}`, { settings: { ...s, [key]: value } });
    onChange();
  };

  return (
    <div className="mt-6 max-w-xl space-y-6">
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          await api.patch(`/api/workspaces/${workspace.id}`, { name });
          onChange();
        }}
      >
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        <button className="btn-ink shrink-0">Rename</button>
      </form>

      <div className="space-y-3">
        <h3 className="text-xs font-medium uppercase tracking-wide opacity-50">Governance</h3>
        {(
          [
            ["boardCreation", "Who can create boards"],
            ["inviting", "Who can invite members"],
            ["visibilityChanges", "Who can change board visibility"],
          ] as const
        ).map(([key, label]) => (
          <div key={key} className="flex items-center gap-3">
            <span className="w-64 text-sm">{label}</span>
            <select
              className="input !w-auto"
              value={(s as any)[key] ?? "members"}
              onChange={(e) => setSetting(key, e.target.value)}
            >
              <option value="members">All members</option>
              <option value="admins">Admins only</option>
            </select>
          </div>
        ))}
      </div>

      <div>
        <h3 className="text-xs font-medium uppercase tracking-wide opacity-50">Danger zone</h3>
        <button
          className="btn-danger mt-2"
          onClick={async () => {
            if (!confirm(`Delete workspace "${workspace.name}" and ALL its boards? This cannot be undone.`)) return;
            await api.del(`/api/workspaces/${workspace.id}`);
            location.href = "/";
          }}
        >
          Delete workspace
        </button>
      </div>
    </div>
  );
}
