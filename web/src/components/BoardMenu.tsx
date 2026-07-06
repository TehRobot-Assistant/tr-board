import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useBoard } from "../stores/board";
import { useAuth } from "../lib/auth";
import type { AutomationRule, FieldType, FormDef } from "../lib/types";
import { Avatar } from "./Chrome";

type Tab = "about" | "share" | "fields" | "automation" | "forms" | "archive" | "activity";

export default function BoardMenu({ onClose }: { onClose: () => void }) {
  const s = useBoard();
  const canAdmin = !!s.myAccess?.canAdmin;
  const [tab, setTab] = useState<Tab>("about");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const tabs: Array<[Tab, string]> = [
    ["about", "Board"],
    ["share", "Sharing"],
    ...(canAdmin ? ([["fields", "Fields"], ["automation", "Automation"], ["forms", "Forms"]] as Array<[Tab, string]>) : []),
    ["archive", "Archive"],
    ["activity", "Activity"],
  ];

  return (
    <div className="fixed inset-0 z-40" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="absolute bottom-0 right-0 top-0 flex w-full max-w-sm flex-col bg-paper text-ink shadow-drag dark:bg-ink-2 dark:text-paper">
        <div className="flex items-center gap-1 border-b border-rule p-2 dark:border-ink-3">
          {tabs.map(([t, label]) => (
            <button
              key={t}
              className={`btn-ghost !px-2 !py-1 text-xs ${tab === t ? "bg-ink/10 dark:bg-paper/15" : ""}`}
              onClick={() => setTab(t)}
            >
              {label}
            </button>
          ))}
          <button className="btn-ghost ml-auto !px-2 !py-1" onClick={onClose}>×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          {tab === "about" && <AboutTab canAdmin={canAdmin} />}
          {tab === "share" && <ShareTab canAdmin={canAdmin} />}
          {tab === "fields" && canAdmin && <FieldsTab />}
          {tab === "automation" && canAdmin && <AutomationTab />}
          {tab === "forms" && canAdmin && <FormsTab />}
          {tab === "archive" && <ArchiveTab />}
          {tab === "activity" && <ActivityTab />}
        </div>
      </aside>
    </div>
  );
}

/* -------------------------------------------------------------- about */

const BG_KEYS = ["navy", "sky", "teal", "forest", "amber", "crimson", "plum", "slate", "ink"];

function AboutTab({ canAdmin }: { canAdmin: boolean }) {
  const s = useBoard();
  const board = s.board!;
  return (
    <div className="space-y-4">
      {canAdmin && (
        <div>
          <h3 className="text-xs font-medium uppercase tracking-wide opacity-50">Background</h3>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {BG_KEYS.map((k) => (
              <button
                key={k}
                className={`bg-board-${k} h-9 w-12 rounded ${board.background === k ? "ring-2 ring-accent ring-offset-1" : ""}`}
                onClick={async () => {
                  await api.patch(`/api/boards/${board.id}`, { background: k });
                  useBoard.setState((st) => ({ board: st.board ? { ...st.board, background: k } : st.board }));
                }}
                title={k}
              />
            ))}
          </div>
        </div>
      )}
      <div>
        <h3 className="text-xs font-medium uppercase tracking-wide opacity-50">Tools</h3>
        <div className="mt-2 space-y-2">
          {canAdmin && (
            <a
              className="btn-ghost w-full justify-start bg-ink/5 text-sm dark:bg-paper/10"
              href={`/api/boards/${board.id}/export`}
              download
            >
              ⤓ Export board as JSON
            </a>
          )}
          <CopyBoardTool />
        </div>
      </div>
      {canAdmin && (
        <div>
          <h3 className="text-xs font-medium uppercase tracking-wide opacity-50">Danger zone</h3>
          <div className="mt-2 flex gap-2">
            <button
              className="btn-ghost text-sm"
              onClick={async () => {
                await api.patch(`/api/boards/${board.id}`, { archived: !board.archived });
                useBoard.setState((st) => ({ board: st.board ? { ...st.board, archived: !board.archived } : st.board }));
              }}
            >
              {board.archived ? "↩ Restore board" : "🗄 Archive board"}
            </button>
            <button
              className="btn-danger text-sm"
              onClick={async () => {
                if (!confirm(`Delete board "${board.name}" and everything on it?`)) return;
                await api.del(`/api/boards/${board.id}`);
                location.href = `/w/${board.workspaceId}`;
              }}
            >
              Delete board
            </button>
          </div>
        </div>
      )}
      {!canAdmin && <p className="text-sm opacity-60">Board settings are managed by board admins.</p>}
    </div>
  );
}

function CopyBoardTool() {
  const s = useBoard();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(`${s.board?.name ?? "Board"} (copy)`);
  const [includeCards, setIncludeCards] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button className="btn-ghost w-full justify-start bg-ink/5 text-sm dark:bg-paper/10" onClick={() => setOpen(true)}>
        ⧉ Copy board / save as template
      </button>
    );
  }
  return (
    <div className="rounded-md border border-rule p-2 dark:border-ink-3">
      <input className="input !py-1 text-sm" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
      <label className="mt-2 flex items-center gap-2 text-xs">
        <input type="checkbox" checked={includeCards} onChange={(e) => setIncludeCards(e.target.checked)} />
        Include cards (off = structure only: lists, labels, fields, automation)
      </label>
      <div className="mt-2 flex gap-1">
        <button
          className="btn-accent !py-1 text-xs"
          disabled={busy || !name.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              const { board } = await api.post<{ board: { id: string } }>(`/api/boards/${s.boardId}/copy`, {
                name: name.trim(), includeCards,
              });
              location.href = `/b/${board.id}`;
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Copying…" : "Copy"}
        </button>
        <button className="btn-ghost !py-1 text-xs" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      <p className="mt-1.5 text-[11px] leading-snug opacity-50">
        Copies start private — open them up from Sharing when ready.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------- share */

function ShareTab({ canAdmin }: { canAdmin: boolean }) {
  const s = useBoard();
  const { user } = useAuth();
  const qc = useQueryClient();
  const board = s.board!;
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [error, setError] = useState<string | null>(null);

  const { data: wsData } = useQuery({
    queryKey: ["workspace", board.workspaceId],
    queryFn: () => api.get<{ teams: Array<{ id: string; name: string; color: string; memberIds: string[] }> ; members: Array<{ id: string; name: string; email: string; avatarColor: string }> }>(`/api/workspaces/${board.workspaceId}`),
    enabled: canAdmin,
  });

  return (
    <div className="space-y-5">
      {canAdmin && (
        <div>
          <h3 className="text-xs font-medium uppercase tracking-wide opacity-50">Visibility</h3>
          <select
            className="input mt-1.5"
            value={board.visibility}
            onChange={async (e) => {
              await api.patch(`/api/boards/${board.id}`, { visibility: e.target.value });
              s.load(board.id);
            }}
          >
            <option value="private">Private — invited members only</option>
            <option value="team">Team — granted teams can view</option>
            <option value="workspace">Workspace — all workspace members can view & join</option>
          </select>
        </div>
      )}

      {canAdmin && board.visibility === "team" && (
        <div>
          <h3 className="text-xs font-medium uppercase tracking-wide opacity-50">Teams with access</h3>
          <div className="mt-1.5 space-y-1">
            {(wsData?.teams ?? []).map((t) => {
              const granted = s.teamIds.includes(t.id);
              return (
                <label key={t.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-ink/5 dark:hover:bg-paper/10">
                  <input
                    type="checkbox"
                    checked={granted}
                    onChange={async (e) => {
                      const next = e.target.checked
                        ? [...s.teamIds, t.id]
                        : s.teamIds.filter((x) => x !== t.id);
                      await api.patch(`/api/boards/${board.id}`, { teamIds: next });
                      useBoard.setState({ teamIds: next });
                    }}
                  />
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: t.color }} />
                  {t.name}
                  <span className="text-xs opacity-40">{t.memberIds.length}</span>
                </label>
              );
            })}
            {(wsData?.teams ?? []).length === 0 && (
              <p className="text-xs opacity-60">No teams in this workspace yet — create them from the workspace page.</p>
            )}
          </div>
        </div>
      )}

      {canAdmin && (
        <div>
          <h3 className="text-xs font-medium uppercase tracking-wide opacity-50">Public link</h3>
          <label className="mt-1.5 flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={!!board.shareToken}
              onChange={async (e) => {
                const { shareToken } = await api.post<{ shareToken: string | null }>(
                  `/api/boards/${board.id}/share-link`,
                  { enabled: e.target.checked },
                );
                useBoard.setState((st) => ({ board: st.board ? { ...st.board, shareToken } : st.board }));
              }}
            />
            Anyone with the link can view (read-only)
          </label>
          {board.shareToken && (
            <div className="mt-1.5 flex gap-1">
              <input
                className="input !py-1 text-xs"
                readOnly
                value={`${location.origin}/share/${board.shareToken}`}
                onFocus={(e) => e.target.select()}
              />
              <button
                className="btn-ghost shrink-0 !py-1 text-xs"
                onClick={() => navigator.clipboard.writeText(`${location.origin}/share/${board.shareToken}`)}
              >
                Copy
              </button>
            </div>
          )}
          <p className="mt-1 text-[11px] leading-snug opacity-50">
            Snapshot view: titles, lists, labels and due dates — no members, comments
            or attachments. Untick to revoke (the old link dies instantly).
          </p>
        </div>
      )}

      <div>
        <h3 className="text-xs font-medium uppercase tracking-wide opacity-50">Board members</h3>
        {canAdmin && (
          <form
            className="mt-1.5 flex gap-1"
            onSubmit={async (e) => {
              e.preventDefault();
              setError(null);
              const match = (wsData?.members ?? []).find((m) => m.email === email.toLowerCase().trim());
              try {
                if (!match) throw new Error("Not a workspace member — add them to the workspace first (or they can be added as guest by user id).");
                await api.put(`/api/boards/${board.id}/members/${match.id}`, { role });
                setEmail("");
                s.load(board.id);
                qc.invalidateQueries({ queryKey: ["workspace", board.workspaceId] });
              } catch (err: any) {
                setError(err.message);
              }
            }}
          >
            <input className="input !py-1 text-sm" type="email" placeholder="member@email" value={email} onChange={(e) => setEmail(e.target.value)} />
            <select className="input !w-auto !py-1 text-sm" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
              <option value="observer">Observer</option>
            </select>
            <button className="btn-accent shrink-0 !py-1 text-xs" disabled={!email}>Add</button>
          </form>
        )}
        {error && <p className="mt-1 text-xs text-[#b03a37]">{error}</p>}
        <ul className="mt-2 space-y-1.5">
          {s.members.map((m) => (
            <li key={m.id} className="flex items-center gap-2 text-sm">
              <Avatar name={m.name} color={m.avatarColor} size={24} />
              <span className="min-w-0 flex-1 truncate">{m.name}</span>
              {canAdmin && m.id !== user?.id ? (
                <select
                  className="rounded border border-rule bg-transparent px-1 py-0.5 text-xs dark:border-ink-3"
                  value={m.role}
                  onChange={async (e) => {
                    await api.put(`/api/boards/${board.id}/members/${m.id}`, { role: e.target.value });
                    s.load(board.id);
                  }}
                >
                  <option value="admin">admin</option>
                  <option value="member">member</option>
                  <option value="observer">observer</option>
                  <option value="guest">guest</option>
                </select>
              ) : (
                <span className="rounded bg-ink/10 px-1.5 py-0.5 text-[11px] uppercase dark:bg-paper/15">{m.role}</span>
              )}
              {(canAdmin || m.id === user?.id) && (
                <button
                  className="btn-ghost !px-1.5 !py-0.5 text-xs"
                  title={m.id === user?.id ? "Leave board" : "Remove"}
                  onClick={async () => {
                    await api.del(`/api/boards/${board.id}/members/${m.id}`);
                    if (m.id === user?.id) location.href = `/w/${board.workspaceId}`;
                    else s.load(board.id);
                  }}
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] leading-snug opacity-50">
          Roles: <strong>admin</strong> manages the board · <strong>member</strong> edits ·{" "}
          <strong>observer</strong> read-only · <strong>guest</strong> single-board access for
          people outside the workspace.
        </p>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- fields */

const FIELD_TYPES: Array<[FieldType, string]> = [
  ["text", "Text"], ["number", "Number"], ["date", "Date"], ["checkbox", "Checkbox"],
  ["select", "Dropdown"], ["multiselect", "Multi-select"], ["member", "Member"], ["url", "URL"],
];
const OPTION_COLORS = ["#61bd4f", "#f2d600", "#ff9f1a", "#eb5a46", "#c377e0", "#0079bf"];

function FieldsTab() {
  const s = useBoard();
  const [name, setName] = useState("");
  const [type, setType] = useState<FieldType>("text");
  const [optionsText, setOptionsText] = useState("");

  return (
    <div className="space-y-4">
      <p className="text-xs opacity-60">
        Custom fields appear on every card of this board; “on front” shows the value on the card face.
        Dropdown fields drive Table columns; date fields plot on Calendar/Timeline.
      </p>
      <ul className="space-y-1.5">
        {s.customFieldDefs.map((f) => (
          <li key={f.id} className="flex items-center gap-2 rounded-md border border-rule p-2 text-sm dark:border-ink-3">
            <span className="flex-1 font-medium">{f.name}</span>
            <span className="text-xs opacity-50">{f.type}</span>
            <label className="flex items-center gap-1 text-[11px] opacity-70">
              <input
                type="checkbox"
                checked={f.showOnFront}
                onChange={async (e) => {
                  await api.patch(`/api/fields/${f.id}`, { showOnFront: e.target.checked });
                }}
              />
              on front
            </label>
            <button
              className="btn-ghost !px-1.5 !py-0.5 text-xs text-[#b03a37]"
              onClick={async () => {
                if (!confirm(`Delete field "${f.name}" and all its values?`)) return;
                await api.del(`/api/fields/${f.id}`);
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <form
        className="space-y-2 rounded-md border border-rule p-2 dark:border-ink-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          const options =
            type === "select" || type === "multiselect"
              ? optionsText
                  .split(",")
                  .map((x) => x.trim())
                  .filter(Boolean)
                  .map((label, i) => ({ id: `o${i}-${label.toLowerCase().replace(/\W+/g, "-")}`, label, color: OPTION_COLORS[i % OPTION_COLORS.length] }))
              : [];
          await api.post(`/api/boards/${s.boardId}/fields`, { name: name.trim(), type, options });
          setName("");
          setOptionsText("");
        }}
      >
        <div className="flex gap-1">
          <input className="input !py-1 text-sm" placeholder="Field name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          <select className="input !w-auto !py-1 text-sm" value={type} onChange={(e) => setType(e.target.value as FieldType)}>
            {FIELD_TYPES.map(([t, label]) => (
              <option key={t} value={t}>{label}</option>
            ))}
          </select>
        </div>
        {(type === "select" || type === "multiselect") && (
          <input className="input !py-1 text-sm" placeholder="Options, comma-separated" value={optionsText} onChange={(e) => setOptionsText(e.target.value)} />
        )}
        <button className="btn-accent !py-1 text-xs" disabled={!name.trim()}>Add field</button>
      </form>
    </div>
  );
}

/* ---------------------------------------------------------- automation */

const TRIGGERS: Array<[string, string]> = [
  ["card_created", "a card is created"],
  ["card_moved", "a card is moved to a list"],
  ["label_added", "a label is added"],
  ["member_assigned", "a member is assigned"],
  ["due_approaching", "a due date approaches"],
  ["due_completed", "a due date is marked complete"],
  ["checklist_completed", "a checklist is completed"],
];

const ACTIONS: Array<[string, string]> = [
  ["move_to_list", "move the card to a list"],
  ["add_label", "add a label"],
  ["remove_label", "remove a label"],
  ["assign_member", "assign a member"],
  ["set_due", "set due in N days"],
  ["clear_due", "clear the due date"],
  ["mark_due_complete", "mark due complete"],
  ["add_checklist", "add a checklist"],
  ["comment", "post a comment"],
  ["notify", "notify card members"],
  ["archive", "archive the card"],
];

function AutomationTab() {
  const s = useBoard();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["automation", s.boardId],
    queryFn: () => api.get<{ rules: AutomationRule[]; runs: Array<{ id: string; ruleId: string; ok: boolean; detail: string; createdAt: string }> }>(`/api/boards/${s.boardId}/automation`),
  });
  const refetch = () => qc.invalidateQueries({ queryKey: ["automation", s.boardId] });
  const [building, setBuilding] = useState(false);

  return (
    <div className="space-y-3">
      <p className="text-xs opacity-60">
        Rules run server-side — Trello's Butler, unmetered. When the trigger fires and conditions
        hold, every action runs in order.
      </p>
      {(data?.rules ?? []).map((r) => (
        <div key={r.id} className="rounded-md border border-rule p-2 text-sm dark:border-ink-3">
          <div className="flex items-center gap-2">
            <button
              title={r.enabled ? "Disable" : "Enable"}
              className={`h-4 w-7 rounded-full transition-colors ${r.enabled ? "bg-[#519839]" : "bg-ink/20 dark:bg-paper/20"}`}
              onClick={async () => { await api.patch(`/api/automation/${r.id}`, { enabled: !r.enabled }); refetch(); }}
            >
              <span className={`block h-3 w-3 rounded-full bg-white transition-transform ${r.enabled ? "translate-x-3.5" : "translate-x-0.5"}`} />
            </button>
            <span className="flex-1 font-medium">{r.name}</span>
            <button
              className="btn-ghost !px-1.5 !py-0.5 text-xs text-[#b03a37]"
              onClick={async () => { await api.del(`/api/automation/${r.id}`); refetch(); }}
            >
              ×
            </button>
          </div>
          <p className="mt-1 text-xs opacity-60">
            When {TRIGGERS.find(([t]) => t === r.trigger.type)?.[1] ?? r.trigger.type}
            {r.trigger.listId && ` (${s.lists.find((l) => l.id === r.trigger.listId)?.name ?? "?"})`}
            {" → "}
            {r.actions.map((a) => ACTIONS.find(([t]) => t === a.type)?.[1] ?? a.type).join(", ")}
          </p>
        </div>
      ))}
      {building ? (
        <RuleBuilder onDone={() => { setBuilding(false); refetch(); }} onCancel={() => setBuilding(false)} />
      ) : (
        <button className="btn-accent !py-1 text-xs" onClick={() => setBuilding(true)}>+ New rule</button>
      )}
      {(data?.runs ?? []).length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs font-medium uppercase tracking-wide opacity-50">
            Recent runs ({data!.runs.length})
          </summary>
          <ul className="mt-1 space-y-0.5 text-xs opacity-70">
            {data!.runs.map((run) => (
              <li key={run.id}>
                {run.ok ? "✓" : "✗"} {data!.rules.find((r) => r.id === run.ruleId)?.name ?? "?"} — {run.detail}{" "}
                <span className="opacity-50">{new Date(run.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function RuleBuilder({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const s = useBoard();
  const [name, setName] = useState("");
  const [triggerType, setTriggerType] = useState("card_moved");
  const [triggerListId, setTriggerListId] = useState("");
  const [triggerLabelId, setTriggerLabelId] = useState("");
  const [hoursBefore, setHoursBefore] = useState(24);
  const [actions, setActions] = useState<Array<Record<string, any>>>([]);
  const [newAction, setNewAction] = useState("add_label");
  const [actionParam, setActionParam] = useState("");

  const addAction = () => {
    const a: Record<string, any> = { type: newAction };
    if (["move_to_list"].includes(newAction)) a.listId = actionParam;
    if (["add_label", "remove_label"].includes(newAction)) a.labelId = actionParam;
    if (["assign_member"].includes(newAction)) a.userId = actionParam;
    if (newAction === "set_due") a.inDays = Number(actionParam) || 1;
    if (["comment", "notify"].includes(newAction)) a.text = actionParam;
    if (newAction === "add_checklist") a.name = actionParam || "Checklist";
    setActions([...actions, a]);
    setActionParam("");
  };

  const paramInput = () => {
    if (newAction === "move_to_list") {
      return (
        <select className="input !py-1 text-xs" value={actionParam} onChange={(e) => setActionParam(e.target.value)}>
          <option value="">list…</option>
          {s.lists.filter((l) => !l.archived).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      );
    }
    if (newAction === "add_label" || newAction === "remove_label") {
      return (
        <select className="input !py-1 text-xs" value={actionParam} onChange={(e) => setActionParam(e.target.value)}>
          <option value="">label…</option>
          {s.labels.map((l) => <option key={l.id} value={l.id}>{l.name || l.color}</option>)}
        </select>
      );
    }
    if (newAction === "assign_member") {
      return (
        <select className="input !py-1 text-xs" value={actionParam} onChange={(e) => setActionParam(e.target.value)}>
          <option value="">member…</option>
          {s.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      );
    }
    if (newAction === "set_due") {
      return <input type="number" min={0} className="input !w-20 !py-1 text-xs" placeholder="days" value={actionParam} onChange={(e) => setActionParam(e.target.value)} />;
    }
    if (["comment", "notify", "add_checklist"].includes(newAction)) {
      return <input className="input !py-1 text-xs" placeholder={newAction === "add_checklist" ? "checklist name" : "text"} value={actionParam} onChange={(e) => setActionParam(e.target.value)} />;
    }
    return null;
  };

  const needsParam = !["clear_due", "mark_due_complete", "archive"].includes(newAction);

  return (
    <div className="space-y-2 rounded-md border border-accent/60 p-2">
      <input className="input !py-1 text-sm" placeholder="Rule name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
      <div className="flex flex-wrap items-center gap-1 text-xs">
        <span className="opacity-60">When</span>
        <select className="input !w-auto !py-1 text-xs" value={triggerType} onChange={(e) => setTriggerType(e.target.value)}>
          {TRIGGERS.map(([t, label]) => <option key={t} value={t}>{label}</option>)}
        </select>
        {(triggerType === "card_moved" || triggerType === "card_created") && (
          <select className="input !w-auto !py-1 text-xs" value={triggerListId} onChange={(e) => setTriggerListId(e.target.value)}>
            <option value="">any list</option>
            {s.lists.filter((l) => !l.archived).map((l) => <option key={l.id} value={l.id}>→ {l.name}</option>)}
          </select>
        )}
        {triggerType === "label_added" && (
          <select className="input !w-auto !py-1 text-xs" value={triggerLabelId} onChange={(e) => setTriggerLabelId(e.target.value)}>
            <option value="">any label</option>
            {s.labels.map((l) => <option key={l.id} value={l.id}>{l.name || l.color}</option>)}
          </select>
        )}
        {triggerType === "due_approaching" && (
          <>
            <input type="number" min={1} max={168} className="input !w-16 !py-1 text-xs" value={hoursBefore} onChange={(e) => setHoursBefore(Number(e.target.value))} />
            <span className="opacity-60">hours before</span>
          </>
        )}
      </div>
      <div className="space-y-1">
        {actions.map((a, i) => (
          <div key={i} className="flex items-center gap-1 text-xs">
            <span className="opacity-60">{i === 0 ? "then" : "and"}</span>
            <span className="rounded bg-ink/8 px-1.5 py-0.5 dark:bg-paper/15">
              {ACTIONS.find(([t]) => t === a.type)?.[1]}
              {a.listId && ` (${s.lists.find((l) => l.id === a.listId)?.name})`}
              {a.labelId && ` (${s.labels.find((l) => l.id === a.labelId)?.name || "label"})`}
              {a.userId && ` (${s.members.find((m) => m.id === a.userId)?.name})`}
              {a.inDays !== undefined && ` (${a.inDays}d)`}
              {a.text && ` ("${String(a.text).slice(0, 24)}")`}
            </span>
            <button className="btn-ghost !px-1 !py-0 text-xs" onClick={() => setActions(actions.filter((_, j) => j !== i))}>×</button>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-1">
          <select className="input !w-auto !py-1 text-xs" value={newAction} onChange={(e) => { setNewAction(e.target.value); setActionParam(""); }}>
            {ACTIONS.map(([t, label]) => <option key={t} value={t}>{label}</option>)}
          </select>
          {paramInput()}
          <button className="btn-ghost !py-1 text-xs" onClick={addAction} disabled={needsParam && !actionParam}>+ add action</button>
        </div>
      </div>
      <div className="flex gap-1">
        <button
          className="btn-accent !py-1 text-xs"
          disabled={!name.trim() || actions.length === 0}
          onClick={async () => {
            const trigger: Record<string, any> = { type: triggerType };
            if (triggerListId) trigger.listId = triggerListId;
            if (triggerLabelId) trigger.labelId = triggerLabelId;
            if (triggerType === "due_approaching") trigger.hoursBefore = hoursBefore;
            await api.post(`/api/boards/${s.boardId}/automation`, { name: name.trim(), trigger, actions });
            onDone();
          }}
        >
          Save rule
        </button>
        <button className="btn-ghost !py-1 text-xs" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- forms */

const FORM_FIELD_TYPES = ["text", "textarea", "email", "number", "date", "select"] as const;

function FormsTab() {
  const s = useBoard();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["forms", s.boardId],
    queryFn: () => api.get<{ forms: FormDef[] }>(`/api/boards/${s.boardId}/forms`),
  });
  const refetch = () => qc.invalidateQueries({ queryKey: ["forms", s.boardId] });
  const [building, setBuilding] = useState(false);

  return (
    <div className="space-y-3">
      <p className="text-xs opacity-60">
        Public forms — anyone with the link can submit, and each submission lands as a
        card. Perfect for enquiries and intake. Answers go into the card description.
      </p>
      {(data?.forms ?? []).map((f) => (
        <div key={f.id} className="rounded-md border border-rule p-2 text-sm dark:border-ink-3">
          <div className="flex items-center gap-2">
            <span className="flex-1 font-medium">{f.title}</span>
            <span className="text-xs opacity-50">→ {s.lists.find((l) => l.id === f.listId)?.name ?? "?"}</span>
            <button
              title={f.enabled ? "Close form" : "Open form"}
              className={`h-4 w-7 rounded-full transition-colors ${f.enabled ? "bg-[#519839]" : "bg-ink/20 dark:bg-paper/20"}`}
              onClick={async () => { await api.patch(`/api/forms/${f.id}`, { enabled: !f.enabled }); refetch(); }}
            >
              <span className={`block h-3 w-3 rounded-full bg-white transition-transform ${f.enabled ? "translate-x-3.5" : "translate-x-0.5"}`} />
            </button>
            <button
              className="btn-ghost !px-1.5 !py-0.5 text-xs text-[#b03a37]"
              onClick={async () => {
                if (!confirm(`Delete form "${f.title}"?`)) return;
                await api.del(`/api/forms/${f.id}`);
                refetch();
              }}
            >
              ×
            </button>
          </div>
          <div className="mt-1.5 flex gap-1">
            <input
              className="input !py-1 text-xs"
              readOnly
              value={`${location.origin}/form/${f.token}`}
              onFocus={(e) => e.target.select()}
            />
            <button
              className="btn-ghost shrink-0 !py-1 text-xs"
              onClick={() => navigator.clipboard.writeText(`${location.origin}/form/${f.token}`)}
            >
              Copy
            </button>
          </div>
          <p className="mt-1 text-xs opacity-50">{f.fields.map((x) => x.label).join(" · ")}</p>
        </div>
      ))}
      {building ? (
        <FormBuilder onDone={() => { setBuilding(false); refetch(); }} onCancel={() => setBuilding(false)} />
      ) : (
        <button className="btn-accent !py-1 text-xs" onClick={() => setBuilding(true)}>+ New form</button>
      )}
    </div>
  );
}

function FormBuilder({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const s = useBoard();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [listId, setListId] = useState(s.lists.find((l) => !l.archived)?.id ?? "");
  const [fields, setFields] = useState<Array<{ id: string; label: string; type: string; required: boolean; options?: string[] }>>([
    { id: "f1", label: "Name", type: "text", required: true },
  ]);

  const setField = (i: number, patch: Partial<(typeof fields)[number]>) =>
    setFields(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));

  return (
    <div className="space-y-2 rounded-md border border-accent/60 p-2">
      <input className="input !py-1 text-sm" placeholder="Form title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
      <textarea className="input !py-1 text-xs" rows={2} placeholder="Intro text (optional)" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
      <div className="flex items-center gap-1 text-xs">
        <span className="opacity-60">Submissions land in</span>
        <select className="input !w-auto !py-1 text-xs" value={listId} onChange={(e) => setListId(e.target.value)}>
          {s.lists.filter((l) => !l.archived).map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
      </div>

      <p className="text-[11px] font-medium uppercase tracking-wide opacity-50">
        Fields <span className="normal-case">(first answer becomes the card title)</span>
      </p>
      {fields.map((f, i) => (
        <div key={f.id} className="space-y-1 rounded border border-rule p-1.5 dark:border-ink-3">
          <div className="flex gap-1">
            <input className="input !py-0.5 text-xs" placeholder="Question" value={f.label} onChange={(e) => setField(i, { label: e.target.value })} maxLength={120} />
            <select className="input !w-auto !py-0.5 text-xs" value={f.type} onChange={(e) => setField(i, { type: e.target.value })}>
              {FORM_FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <label className="flex items-center gap-1 text-[11px]">
              <input type="checkbox" checked={f.required} onChange={(e) => setField(i, { required: e.target.checked })} />
              req
            </label>
            <button className="btn-ghost !px-1 !py-0 text-xs" onClick={() => setFields(fields.filter((_, j) => j !== i))} disabled={fields.length === 1}>×</button>
          </div>
          {f.type === "select" && (
            <input
              className="input !py-0.5 text-xs"
              placeholder="Options, comma-separated"
              value={(f.options ?? []).join(", ")}
              onChange={(e) => setField(i, { options: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })}
            />
          )}
        </div>
      ))}
      <button
        className="btn-ghost !py-1 text-xs"
        onClick={() => setFields([...fields, { id: `f${fields.length + 1}-${fields.length}`, label: "", type: "text", required: false }])}
        disabled={fields.length >= 20}
      >
        + add field
      </button>

      <div className="flex gap-1">
        <button
          className="btn-accent !py-1 text-xs"
          disabled={!title.trim() || !listId || fields.some((f) => !f.label.trim())}
          onClick={async () => {
            await api.post(`/api/boards/${s.boardId}/forms`, {
              listId, title: title.trim(), description, fields,
            });
            onDone();
          }}
        >
          Create form
        </button>
        <button className="btn-ghost !py-1 text-xs" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- archive */

function ArchiveTab() {
  const s = useBoard();
  const archivedCards = s.cards.filter((c) => c.archived);
  const archivedLists = s.lists.filter((l) => l.archived);
  const canWrite = !!s.myAccess?.canWrite;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xs font-medium uppercase tracking-wide opacity-50">Archived cards</h3>
        <ul className="mt-1.5 space-y-1">
          {archivedCards.map((c) => (
            <li key={c.id} className="flex items-center gap-2 rounded-md border border-rule p-2 text-sm dark:border-ink-3">
              <span className="min-w-0 flex-1 truncate">{c.title}</span>
              {canWrite && (
                <>
                  <button
                    className="btn-ghost !py-0.5 text-xs"
                    onClick={async () => { await api.patch(`/api/cards/${c.id}`, { archived: false }); s.patchCard(c.id, { archived: false }); }}
                  >
                    Restore
                  </button>
                  <button
                    className="btn-ghost !py-0.5 text-xs text-[#b03a37]"
                    onClick={async () => {
                      if (!confirm("Delete forever?")) return;
                      await api.del(`/api/cards/${c.id}`);
                    }}
                  >
                    Delete
                  </button>
                </>
              )}
            </li>
          ))}
          {archivedCards.length === 0 && <p className="text-xs opacity-50">None.</p>}
        </ul>
      </div>
      <div>
        <h3 className="text-xs font-medium uppercase tracking-wide opacity-50">Archived lists</h3>
        <ul className="mt-1.5 space-y-1">
          {archivedLists.map((l) => (
            <li key={l.id} className="flex items-center gap-2 rounded-md border border-rule p-2 text-sm dark:border-ink-3">
              <span className="flex-1">{l.name}</span>
              {canWrite && (
                <button className="btn-ghost !py-0.5 text-xs" onClick={() => s.archiveList(l.id, false)}>
                  Restore
                </button>
              )}
            </li>
          ))}
          {archivedLists.length === 0 && <p className="text-xs opacity-50">None.</p>}
        </ul>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- activity */

function ActivityTab() {
  const s = useBoard();
  const { data } = useQuery({
    queryKey: ["activity", s.boardId],
    queryFn: () => api.get<{ activity: Array<{ id: string; type: string; data: Record<string, unknown>; createdAt: string; userName: string | null; avatarColor: string | null }> }>(`/api/boards/${s.boardId}/activity`),
  });
  return (
    <ul className="space-y-2">
      {(data?.activity ?? []).map((a) => (
        <li key={a.id} className="flex gap-2 text-sm">
          <Avatar name={a.userName ?? "⚙ Automation"} color={a.avatarColor ?? "#838c91"} size={24} />
          <div className="min-w-0">
            <p className="leading-snug">
              <span className="font-semibold">{a.userName ?? "⚙ Automation"}</span>{" "}
              <span className="opacity-80">{describe(a.type, a.data)}</span>
            </p>
            <p className="text-xs opacity-40">{new Date(a.createdAt).toLocaleString()}</p>
          </div>
        </li>
      ))}
      {(data?.activity ?? []).length === 0 && <p className="text-xs opacity-50">Nothing yet.</p>}
    </ul>
  );
}

function describe(type: string, d: Record<string, unknown>): string {
  switch (type) {
    case "board.created": return `created this board`;
    case "board.updated": return `updated the board`;
    case "board.memberAdded": return `added ${d.member} (${d.role})`;
    case "list.created": return `added list "${d.name}"`;
    case "list.archived": return `archived list "${d.name}"`;
    case "list.restored": return `restored list "${d.name}"`;
    case "list.deleted": return `deleted list "${d.name}"`;
    case "card.created": return `added "${d.title}" to ${d.list}`;
    case "card.moved": return `moved "${d.title}" from ${d.from} to ${d.to}`;
    case "card.commented": return `commented on "${d.title}"`;
    case "card.attached": return `attached ${d.filename}`;
    case "card.dueSet": return `set a due date on "${d.title}"`;
    case "card.dueCleared": return `cleared the due date on "${d.title}"`;
    case "card.archived": return `archived "${d.title}"`;
    case "card.restored": return `restored "${d.title}"`;
    case "card.deleted": return `deleted "${d.title}"`;
    case "automation.moved": return `rule "${d.rule}" moved a card to ${d.to}`;
    default: return type.replace(/[._]/g, " ");
  }
}
