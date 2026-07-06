import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useBoard } from "../stores/board";
import type { CardDetail, Checklist } from "../lib/types";
import { Avatar, usePopover } from "./Chrome";
import { FieldValueInline, dueTone, fmtDue } from "./CardChip";

export default function CardModal({ cardId, onClose }: { cardId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const s = useBoard();
  const canWrite = !!s.myAccess?.canWrite;

  const { data, error } = useQuery({
    queryKey: ["card", cardId],
    queryFn: () => api.get<CardDetail>(`/api/cards/${cardId}`),
  });
  const refetch = () => qc.invalidateQueries({ queryKey: ["card", cardId] });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && (e.target as HTMLElement).tagName !== "TEXTAREA" && (e.target as HTMLElement).tagName !== "INPUT") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (error) {
    return (
      <Backdrop onClose={onClose}>
        <p className="p-6 text-sm">Card not found.</p>
      </Backdrop>
    );
  }
  if (!data) return <Backdrop onClose={onClose}><p className="p-6 text-sm opacity-60">Loading…</p></Backdrop>;

  const { card, checklists, comments, attachments, activity } = data;
  const list = s.lists.find((l) => l.id === card.listId);

  const patchCard = async (patch: Record<string, unknown>) => {
    await api.patch(`/api/cards/${cardId}`, patch);
    s.patchCard(cardId, patch as any);
    refetch();
  };

  return (
    <Backdrop onClose={onClose}>
      {(card.coverColor || card.coverAttachmentId) && (
        <div
          className="h-24 rounded-t-lg bg-cover bg-center"
          style={
            card.coverAttachmentId
              ? { backgroundImage: `url(/api/attachments/${card.coverAttachmentId}/file)` }
              : { background: card.coverColor! }
          }
        />
      )}
      <div className="flex flex-col gap-5 p-5 sm:flex-row">
        {/* ------------------------------------------------- main column */}
        <div className="min-w-0 flex-1">
          <TitleEditor title={card.title} canWrite={canWrite} onSave={(title) => patchCard({ title })} />
          <p className="mt-0.5 text-xs opacity-60">
            in list <span className="font-medium">{list?.name ?? "?"}</span>
            {card.archived && <span className="ml-2 rounded bg-[#d9a21b] px-1.5 py-0.5 font-medium text-ink">Archived</span>}
          </p>

          {/* chips row: members, labels, due */}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {card.memberIds.length > 0 && (
              <div>
                <p className="mb-1 text-[11px] font-medium uppercase tracking-wide opacity-50">Members</p>
                <div className="flex -space-x-1">
                  {card.memberIds.map((uid) => {
                    const m = s.members.find((x) => x.id === uid);
                    return m ? <Avatar key={uid} name={m.name} color={m.avatarColor} /> : null;
                  })}
                </div>
              </div>
            )}
            {card.labelIds.length > 0 && (
              <div>
                <p className="mb-1 text-[11px] font-medium uppercase tracking-wide opacity-50">Labels</p>
                <div className="flex flex-wrap gap-1">
                  {card.labelIds.map((lid) => {
                    const l = s.labels.find((x) => x.id === lid);
                    return l ? (
                      <span key={lid} className="rounded px-2 py-0.5 text-xs font-medium text-white" style={{ background: l.color }}>
                        {l.name || "  "}
                      </span>
                    ) : null;
                  })}
                </div>
              </div>
            )}
            {card.dueAt && (
              <div>
                <p className="mb-1 text-[11px] font-medium uppercase tracking-wide opacity-50">Due</p>
                <button
                  className={`rounded px-2 py-0.5 text-xs font-medium ${dueTone(card)}`}
                  onClick={() => canWrite && patchCard({ dueComplete: !card.dueComplete })}
                  title="Toggle complete"
                >
                  {card.dueComplete ? "✓ " : ""}{fmtDue(card.dueAt)}
                  {card.startAt ? ` (from ${fmtDue(card.startAt)})` : ""}
                </button>
              </div>
            )}
          </div>

          {/* custom fields */}
          {s.customFieldDefs.length > 0 && (
            <section className="mt-5">
              <h3 className="text-xs font-medium uppercase tracking-wide opacity-50">Fields</h3>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {s.customFieldDefs.map((def) => (
                  <FieldEditor
                    key={def.id}
                    def={def}
                    value={card.fieldValues[def.id]}
                    canWrite={canWrite}
                    onSave={async (value) => {
                      await api.put(`/api/cards/${cardId}/fields/${def.id}`, { value });
                      refetch();
                    }}
                  />
                ))}
              </div>
            </section>
          )}

          {/* description */}
          <section className="mt-5">
            <h3 className="text-xs font-medium uppercase tracking-wide opacity-50">Description</h3>
            <DescriptionEditor
              value={card.description}
              canWrite={canWrite}
              onSave={(description) => patchCard({ description })}
            />
          </section>

          {/* checklists */}
          {checklists.map((cl) => (
            <ChecklistBlock key={cl.id} checklist={cl} cardId={cardId} canWrite={canWrite} onChange={refetch} />
          ))}

          {/* attachments */}
          {attachments.length > 0 && (
            <section className="mt-5">
              <h3 className="text-xs font-medium uppercase tracking-wide opacity-50">Attachments</h3>
              <ul className="mt-2 space-y-1.5">
                {attachments.map((a) => (
                  <li key={a.id} className="flex items-center gap-2 rounded-md border border-rule p-2 text-sm dark:border-ink-3">
                    {a.mime.startsWith("image/") ? (
                      <img src={`/api/attachments/${a.id}/file`} alt="" className="h-10 w-14 rounded object-cover" loading="lazy" />
                    ) : (
                      <span className="flex h-10 w-14 items-center justify-center rounded bg-ink/10 text-lg dark:bg-paper/15">📄</span>
                    )}
                    <div className="min-w-0 flex-1">
                      <a href={`/api/attachments/${a.id}/file`} target="_blank" rel="noreferrer" className="block truncate font-medium hover:underline">
                        {a.filename}
                      </a>
                      <p className="text-xs opacity-50">{(a.size / 1024).toFixed(0)} KB</p>
                    </div>
                    {canWrite && a.mime.startsWith("image/") && (
                      <button
                        className="btn-ghost !py-1 text-xs"
                        title="Set as cover"
                        onClick={() => patchCard({ coverAttachmentId: card.coverAttachmentId === a.id ? null : a.id, coverColor: null })}
                      >
                        {card.coverAttachmentId === a.id ? "Uncover" : "Cover"}
                      </button>
                    )}
                    <a className="btn-ghost !py-1 text-xs" href={`/api/attachments/${a.id}/file?download=1`}>↓</a>
                    {canWrite && (
                      <button
                        className="btn-ghost !py-1 text-xs text-[#b03a37]"
                        onClick={async () => { await api.del(`/api/attachments/${a.id}`); refetch(); }}
                      >
                        ×
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* comments + activity */}
          <section className="mt-5">
            <h3 className="text-xs font-medium uppercase tracking-wide opacity-50">Comments</h3>
            {canWrite && <CommentBox cardId={cardId} onPosted={refetch} />}
            <ul className="mt-3 space-y-3">
              {comments.map((c) => (
                <li key={c.id} className="flex gap-2">
                  <Avatar name={c.userName ?? "⚙ Automation"} color={c.avatarColor ?? "#838c91"} size={26} />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs">
                      <span className="font-semibold">{c.userName ?? "⚙ Automation"}</span>{" "}
                      <span className="opacity-50">{new Date(c.createdAt).toLocaleString()}</span>
                    </p>
                    <p className="mt-0.5 whitespace-pre-wrap rounded-md bg-ink/5 p-2 text-sm dark:bg-paper/10">{c.body}</p>
                  </div>
                </li>
              ))}
            </ul>
            {activity.length > 0 && (
              <details className="mt-4">
                <summary className="cursor-pointer text-xs font-medium uppercase tracking-wide opacity-50">
                  Activity ({activity.length})
                </summary>
                <ul className="mt-2 space-y-1.5 text-xs opacity-80">
                  {activity.map((a) => (
                    <li key={a.id}>
                      <span className="font-medium">{a.userName ?? "⚙"}</span> {describeActivity(a.type, a.data)}
                      <span className="ml-1 opacity-50">{new Date(a.createdAt).toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        </div>

        {/* ---------------------------------------------------- sidebar */}
        {canWrite && (
          <aside className="flex w-full shrink-0 flex-col gap-1.5 sm:w-44">
            <MembersButton cardId={cardId} memberIds={card.memberIds} onChange={refetch} />
            <LabelsButton cardId={cardId} labelIds={card.labelIds} onChange={refetch} />
            <DueButton card={card} onSave={patchCard} />
            <AddChecklistButton cardId={cardId} onAdded={refetch} />
            <AttachButton cardId={cardId} onUploaded={refetch} />
            <CoverButton card={card} onSave={patchCard} />
            <div className="mt-3 border-t border-rule pt-3 dark:border-ink-3">
              <button
                className="btn-ghost w-full justify-start text-sm"
                onClick={() => patchCard({ archived: !card.archived })}
              >
                {card.archived ? "↩ Restore" : "🗄 Archive"}
              </button>
              {card.archived && (
                <button
                  className="btn-ghost w-full justify-start text-sm text-[#b03a37]"
                  onClick={async () => {
                    if (!confirm("Delete this card forever?")) return;
                    await api.del(`/api/cards/${cardId}`);
                    onClose();
                  }}
                >
                  ✕ Delete forever
                </button>
              )}
            </div>
          </aside>
        )}
      </div>
    </Backdrop>
  );
}

/* ------------------------------------------------------------ scaffolding */

function Backdrop({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-black/60 p-4 sm:py-12"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="mx-auto max-w-3xl rounded-lg bg-paper text-ink shadow-drag dark:bg-ink-2 dark:text-paper">
        <div className="relative">
          <button
            className="absolute right-2 top-2 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/10 hover:bg-black/20 dark:bg-white/10 dark:hover:bg-white/20"
            onClick={onClose}
            title="Close"
          >
            ×
          </button>
          {children}
        </div>
      </div>
    </div>
  );
}

function TitleEditor({ title, canWrite, onSave }: { title: string; canWrite: boolean; onSave: (t: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(title);
  useEffect(() => setV(title), [title]);
  if (!editing) {
    return (
      <h2
        className={`pr-8 font-display text-xl font-bold leading-tight ${canWrite ? "cursor-pointer" : ""}`}
        onClick={() => canWrite && setEditing(true)}
      >
        {title}
      </h2>
    );
  }
  return (
    <textarea
      className="input pr-8 font-display text-xl font-bold"
      value={v}
      rows={2}
      autoFocus
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { if (v.trim() && v !== title) onSave(v.trim()); setEditing(false); }}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); }
        if (e.key === "Escape") { setV(title); setEditing(false); }
      }}
    />
  );
}

function DescriptionEditor({ value, canWrite, onSave }: { value: string; canWrite: boolean; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  if (!editing) {
    return (
      <div
        className={`mt-2 min-h-12 whitespace-pre-wrap rounded-md bg-ink/5 p-3 text-sm dark:bg-paper/10 ${canWrite ? "cursor-pointer" : ""}`}
        onClick={() => canWrite && setEditing(true)}
      >
        {value || <span className="opacity-40">Add a description…</span>}
      </div>
    );
  }
  return (
    <div className="mt-2">
      <textarea className="input min-h-32 text-sm" value={v} onChange={(e) => setV(e.target.value)} autoFocus />
      <div className="mt-1 flex gap-1">
        <button className="btn-accent !py-1 text-xs" onClick={() => { onSave(v); setEditing(false); }}>Save</button>
        <button className="btn-ghost !py-1 text-xs" onClick={() => { setV(value); setEditing(false); }}>Cancel</button>
      </div>
    </div>
  );
}

function ChecklistBlock({
  checklist, cardId, canWrite, onChange,
}: { checklist: Checklist; cardId: string; canWrite: boolean; onChange: () => void }) {
  const s = useBoard();
  const [newItem, setNewItem] = useState("");
  const done = checklist.items.filter((i) => i.done).length;
  const pct = checklist.items.length ? Math.round((done / checklist.items.length) * 100) : 0;

  return (
    <section className="mt-5">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">☑ {checklist.name}</h3>
        {canWrite && (
          <button
            className="btn-ghost ml-auto !py-0.5 text-xs"
            onClick={async () => { await api.del(`/api/checklists/${checklist.id}`); onChange(); }}
          >
            Delete
          </button>
        )}
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <span className="w-8 text-right text-xs opacity-50">{pct}%</span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink/10 dark:bg-paper/15">
          <div className="h-full rounded-full bg-[#519839] transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <ul className="mt-2 space-y-1">
        {checklist.items.map((item) => (
          <li key={item.id} className="group flex items-start gap-2 rounded px-1 py-0.5 hover:bg-ink/5 dark:hover:bg-paper/10">
            <input
              type="checkbox"
              className="mt-1"
              checked={item.done}
              disabled={!canWrite}
              onChange={async (e) => {
                await api.patch(`/api/checklist-items/${item.id}`, { done: e.target.checked });
                onChange();
              }}
            />
            <span className={`flex-1 text-sm ${item.done ? "line-through opacity-50" : ""}`}>
              {item.text}
              {item.dueAt && (
                <span className="ml-2 rounded bg-ink/10 px-1 text-[11px] dark:bg-paper/15">
                  {fmtDue(item.dueAt)}
                </span>
              )}
            </span>
            {item.assigneeId && (() => {
              const m = s.members.find((x) => x.id === item.assigneeId);
              return m ? <Avatar name={m.name} color={m.avatarColor} size={20} /> : null;
            })()}
            {canWrite && (
              <ItemMenu item={item} members={s.members} onChange={onChange} />
            )}
          </li>
        ))}
      </ul>
      {canWrite && (
        <form
          className="mt-2 flex gap-1"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!newItem.trim()) return;
            await api.post(`/api/checklists/${checklist.id}/items`, { text: newItem.trim() });
            setNewItem("");
            onChange();
          }}
        >
          <input className="input !py-1 text-sm" placeholder="Add an item…" value={newItem} onChange={(e) => setNewItem(e.target.value)} maxLength={400} />
          <button className="btn-ghost shrink-0 !py-1 text-xs" disabled={!newItem.trim()}>Add</button>
        </form>
      )}
    </section>
  );
}

/** advanced-checklist per-item controls: assignee + due (Trello Premium, free here) */
function ItemMenu({
  item, members, onChange,
}: {
  item: Checklist["items"][number];
  members: Array<{ id: string; name: string; avatarColor: string }>;
  onChange: () => void;
}) {
  const { open, setOpen, ref } = usePopover();
  return (
    <div className="relative" ref={ref}>
      <button className="btn-ghost !px-1.5 !py-0.5 text-xs opacity-0 group-hover:opacity-100" onClick={() => setOpen(!open)}>
        ⋯
      </button>
      {open && (
        <div className="menu-panel absolute right-0 z-20 w-56">
          <p className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide opacity-50">Assign</p>
          {members.map((m) => (
            <button
              key={m.id}
              className="btn-ghost w-full justify-start gap-2 !py-1 text-xs"
              onClick={async () => {
                await api.patch(`/api/checklist-items/${item.id}`, {
                  assigneeId: item.assigneeId === m.id ? null : m.id,
                });
                setOpen(false);
                onChange();
              }}
            >
              <Avatar name={m.name} color={m.avatarColor} size={18} />
              {m.name} {item.assigneeId === m.id && "✓"}
            </button>
          ))}
          <p className="px-1 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide opacity-50">Due</p>
          <input
            type="date"
            className="input !py-1 text-xs"
            defaultValue={item.dueAt ? item.dueAt.slice(0, 10) : ""}
            onChange={async (e) => {
              await api.patch(`/api/checklist-items/${item.id}`, {
                dueAt: e.target.value ? new Date(e.target.value + "T12:00:00").toISOString() : null,
              });
              onChange();
            }}
          />
          <button
            className="btn-ghost mt-1 w-full justify-start !py-1 text-xs text-[#b03a37]"
            onClick={async () => { await api.del(`/api/checklist-items/${item.id}`); onChange(); }}
          >
            Delete item
          </button>
        </div>
      )}
    </div>
  );
}

function CommentBox({ cardId, onPosted }: { cardId: string; onPosted: () => void }) {
  const [v, setV] = useState("");
  return (
    <form
      className="mt-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!v.trim()) return;
        await api.post(`/api/cards/${cardId}/comments`, { body: v.trim() });
        setV("");
        onPosted();
      }}
    >
      <textarea
        className="input resize-none text-sm"
        rows={2}
        placeholder="Write a comment…"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.currentTarget.form as HTMLFormElement).requestSubmit();
        }}
      />
      {v.trim() && <button className="btn-accent mt-1 !py-1 text-xs">Comment</button>}
    </form>
  );
}

/* ------------------------------------------------------- sidebar buttons */

function SidebarPop({
  label, children,
}: { label: string; children: (close: () => void) => React.ReactNode }) {
  const { open, setOpen, ref } = usePopover();
  return (
    <div className="relative" ref={ref}>
      <button className="btn-ghost w-full justify-start bg-ink/5 text-sm dark:bg-paper/10" onClick={() => setOpen(!open)}>
        {label}
      </button>
      {open && (
        <div className="menu-panel absolute right-0 z-30 mt-1 w-64 sm:left-0">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MembersButton({ cardId, memberIds, onChange }: { cardId: string; memberIds: string[]; onChange: () => void }) {
  const members = useBoard((s) => s.members);
  return (
    <SidebarPop label="👤 Members">
      {() => (
        <>
          {members.map((m) => (
            <button
              key={m.id}
              className="btn-ghost w-full justify-start gap-2 !py-1 text-sm"
              onClick={async () => {
                if (memberIds.includes(m.id)) await api.del(`/api/cards/${cardId}/members/${m.id}`);
                else await api.put(`/api/cards/${cardId}/members/${m.id}`);
                onChange();
              }}
            >
              <Avatar name={m.name} color={m.avatarColor} size={22} />
              <span className="flex-1 text-left">{m.name}</span>
              {memberIds.includes(m.id) && "✓"}
            </button>
          ))}
        </>
      )}
    </SidebarPop>
  );
}

const LABEL_PALETTE = [
  "#61bd4f", "#f2d600", "#ff9f1a", "#eb5a46", "#c377e0",
  "#0079bf", "#00c2e0", "#51e898", "#ff78cb", "#344563",
];

function LabelsButton({ cardId, labelIds, onChange }: { cardId: string; labelIds: string[]; onChange: () => void }) {
  const s = useBoard();
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(LABEL_PALETTE[0]);
  return (
    <SidebarPop label="🏷 Labels">
      {() => (
        <>
          {s.labels.map((l) => (
            <button
              key={l.id}
              className="mb-1 flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs font-medium text-white"
              style={{ background: l.color }}
              onClick={async () => {
                if (labelIds.includes(l.id)) await api.del(`/api/cards/${cardId}/labels/${l.id}`);
                else await api.put(`/api/cards/${cardId}/labels/${l.id}`);
                onChange();
              }}
            >
              <span className="flex-1 text-left">{l.name || " "}</span>
              {labelIds.includes(l.id) && "✓"}
            </button>
          ))}
          <div className="mt-2 border-t border-rule pt-2 dark:border-ink-3">
            <input className="input !py-1 text-xs" placeholder="New label name" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={60} />
            <div className="mt-1.5 flex flex-wrap gap-1">
              {LABEL_PALETTE.map((c) => (
                <button
                  key={c}
                  className={`h-6 w-8 rounded ${newColor === c ? "ring-2 ring-ink ring-offset-1 dark:ring-paper" : ""}`}
                  style={{ background: c }}
                  onClick={() => setNewColor(c)}
                />
              ))}
            </div>
            <button
              className="btn-accent mt-2 w-full !py-1 text-xs"
              onClick={async () => {
                const { label } = await api.post<{ label: { id: string } }>(`/api/boards/${s.boardId}/labels`, { name: newName.trim(), color: newColor });
                await api.put(`/api/cards/${cardId}/labels/${label.id}`);
                setNewName("");
                onChange();
              }}
            >
              Create & add
            </button>
          </div>
        </>
      )}
    </SidebarPop>
  );
}

function DueButton({ card, onSave }: { card: { startAt: string | null; dueAt: string | null }; onSave: (p: Record<string, unknown>) => void }) {
  return (
    <SidebarPop label="⏱ Dates">
      {(close) => (
        <>
          <p className="px-1 text-[11px] font-medium uppercase tracking-wide opacity-50">Start</p>
          <input
            type="date"
            className="input !py-1 text-xs"
            defaultValue={card.startAt ? card.startAt.slice(0, 10) : ""}
            onChange={(e) => onSave({ startAt: e.target.value ? new Date(e.target.value + "T09:00:00").toISOString() : null })}
          />
          <p className="mt-2 px-1 text-[11px] font-medium uppercase tracking-wide opacity-50">Due</p>
          <input
            type="datetime-local"
            className="input !py-1 text-xs"
            defaultValue={card.dueAt ? toLocalInput(card.dueAt) : ""}
            onChange={(e) => onSave({ dueAt: e.target.value ? new Date(e.target.value).toISOString() : null })}
          />
          <button className="btn-ghost mt-2 w-full !py-1 text-xs" onClick={() => { onSave({ dueAt: null, startAt: null }); close(); }}>
            Clear dates
          </button>
        </>
      )}
    </SidebarPop>
  );
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function AddChecklistButton({ cardId, onAdded }: { cardId: string; onAdded: () => void }) {
  const [name, setName] = useState("Checklist");
  return (
    <SidebarPop label="☑ Checklist">
      {(close) => (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            await api.post(`/api/cards/${cardId}/checklists`, { name: name.trim() || "Checklist" });
            close();
            onAdded();
          }}
        >
          <input className="input !py-1 text-sm" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={120} />
          <button className="btn-accent mt-2 w-full !py-1 text-xs">Add checklist</button>
        </form>
      )}
    </SidebarPop>
  );
}

function AttachButton({ cardId, onUploaded }: { cardId: string; onUploaded: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button className="btn-ghost w-full justify-start bg-ink/5 text-sm dark:bg-paper/10" onClick={() => inputRef.current?.click()} disabled={busy}>
        📎 {busy ? "Uploading…" : "Attach"}
      </button>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          setBusy(true);
          try {
            await api.upload(`/api/cards/${cardId}/attachments`, file);
            onUploaded();
          } finally {
            setBusy(false);
            e.target.value = "";
          }
        }}
      />
    </>
  );
}

const COVER_COLORS = ["#0079bf", "#519839", "#d29034", "#b04632", "#89609e", "#cd5a91", "#344563", "#00aecc"];

function CoverButton({ card, onSave }: { card: { coverColor: string | null }; onSave: (p: Record<string, unknown>) => void }) {
  return (
    <SidebarPop label="🎨 Cover">
      {(close) => (
        <>
          <div className="flex flex-wrap gap-1">
            {COVER_COLORS.map((c) => (
              <button
                key={c}
                className={`h-8 w-12 rounded ${card.coverColor === c ? "ring-2 ring-ink ring-offset-1 dark:ring-paper" : ""}`}
                style={{ background: c }}
                onClick={() => onSave({ coverColor: c, coverAttachmentId: null })}
              />
            ))}
          </div>
          <button className="btn-ghost mt-2 w-full !py-1 text-xs" onClick={() => { onSave({ coverColor: null, coverAttachmentId: null }); close(); }}>
            Remove cover
          </button>
        </>
      )}
    </SidebarPop>
  );
}

/* ---------------------------------------------------------- field editor */

function FieldEditor({
  def, value, canWrite, onSave,
}: {
  def: { id: string; name: string; type: string; options: Array<{ id: string; label: string; color: string }> };
  value: unknown;
  canWrite: boolean;
  onSave: (v: unknown) => void;
}) {
  const members = useBoard((s) => s.members);
  const base = "flex items-center gap-2 rounded-md border border-rule px-2 py-1.5 text-sm dark:border-ink-3";

  if (!canWrite) {
    return (
      <div className={base}>
        <span className="text-xs opacity-50">{def.name}</span>
        <FieldValueInline def={def as any} value={value} />
      </div>
    );
  }

  switch (def.type) {
    case "checkbox":
      return (
        <label className={`${base} cursor-pointer`}>
          <input type="checkbox" checked={!!value} onChange={(e) => onSave(e.target.checked)} />
          <span className="text-xs opacity-70">{def.name}</span>
        </label>
      );
    case "select":
      return (
        <div className={base}>
          <span className="shrink-0 text-xs opacity-50">{def.name}</span>
          <select className="w-full bg-transparent text-sm outline-none" value={String(value ?? "")} onChange={(e) => onSave(e.target.value || null)}>
            <option value="">—</option>
            {def.options.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
        </div>
      );
    case "multiselect":
      return (
        <div className={base}>
          <span className="shrink-0 text-xs opacity-50">{def.name}</span>
          <div className="flex flex-wrap gap-1">
            {def.options.map((o) => {
              const selected = Array.isArray(value) && (value as string[]).includes(o.id);
              return (
                <button
                  key={o.id}
                  className={`rounded px-1.5 py-0.5 text-xs text-white ${selected ? "" : "opacity-35"}`}
                  style={{ background: o.color }}
                  onClick={() => {
                    const cur = Array.isArray(value) ? (value as string[]) : [];
                    onSave(selected ? cur.filter((x) => x !== o.id) : [...cur, o.id]);
                  }}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
        </div>
      );
    case "member":
      return (
        <div className={base}>
          <span className="shrink-0 text-xs opacity-50">{def.name}</span>
          <select className="w-full bg-transparent text-sm outline-none" value={String(value ?? "")} onChange={(e) => onSave(e.target.value || null)}>
            <option value="">—</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </div>
      );
    case "date":
      return (
        <div className={base}>
          <span className="shrink-0 text-xs opacity-50">{def.name}</span>
          <input
            type="date"
            className="w-full bg-transparent text-sm outline-none"
            value={value ? String(value).slice(0, 10) : ""}
            onChange={(e) => onSave(e.target.value ? new Date(e.target.value + "T12:00:00").toISOString() : null)}
          />
        </div>
      );
    case "number":
      return (
        <div className={base}>
          <span className="shrink-0 text-xs opacity-50">{def.name}</span>
          <input
            type="number"
            className="w-full bg-transparent text-sm outline-none"
            defaultValue={value === null || value === undefined ? "" : Number(value)}
            onBlur={(e) => onSave(e.target.value === "" ? null : Number(e.target.value))}
          />
        </div>
      );
    default: // text, url
      return (
        <div className={base}>
          <span className="shrink-0 text-xs opacity-50">{def.name}</span>
          <input
            className="w-full bg-transparent text-sm outline-none"
            defaultValue={value === null || value === undefined ? "" : String(value)}
            placeholder={def.type === "url" ? "https://…" : ""}
            onBlur={(e) => onSave(e.target.value || null)}
          />
        </div>
      );
  }
}

function describeActivity(type: string, data: Record<string, unknown>): string {
  switch (type) {
    case "card.created": return `added this card to ${data.list}`;
    case "card.moved": return `moved this card from ${data.from} to ${data.to}`;
    case "card.commented": return "commented";
    case "card.attached": return `attached ${data.filename}`;
    case "card.dueSet": return "set the due date";
    case "card.dueCleared": return "removed the due date";
    case "card.archived": return "archived this card";
    case "card.restored": return "restored this card";
    case "automation.moved": return `automation "${data.rule}" moved this card to ${data.to}`;
    default: return type.replace(/[._]/g, " ");
  }
}
