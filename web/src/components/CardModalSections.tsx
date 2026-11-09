/**
 * Card modal body sections. Every section shares one grid: a 28px icon
 * gutter on the left, heading + body in the text column, so headings and
 * their content line up down the page.
 */
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { useBoard } from "../stores/board";
import type { Attachment, Checklist } from "../lib/types";
import { Avatar } from "./Chrome";
import { FieldValueInline, fmtDue } from "./CardChip";
import { ActionPop, AttachButton, ChecklistPanel, Pop, iconBtnClass, menuRowClass } from "./CardModalActions";
import {
  AlignLeftIcon, ArrowRightIcon, BlockIcon, CheckSquareIcon, DownloadIcon, FileIcon, ImageIcon,
  LinkIcon, MoreIcon, PaperclipIcon, PlusIcon, TrashIcon, XIcon,
} from "./icons";

/* ------------------------------------------------------------- section */

export function Section({
  icon, title, action, children, className = "",
}: { icon: ReactNode; title: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`grid grid-cols-[28px_1fr] gap-x-1 ${className}`}>
      <span className="mt-1 flex h-6 items-center justify-center text-ink/70 dark:text-paper/70">{icon}</span>
      <div className="flex min-h-8 items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-[15px] font-semibold leading-tight">{title}</h3>
        {action && <div className="flex shrink-0 items-center gap-1">{action}</div>}
      </div>
      <div />
      <div className="min-w-0">{children}</div>
    </section>
  );
}

export const sectionLabel = "mb-1.5 text-xs font-semibold text-ink/60 dark:text-paper/60";

/* --------------------------------------------------------------- title */

export function TitleEditor({ title, canWrite, onSave }: { title: string; canWrite: boolean; onSave: (t: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(title);
  useEffect(() => setV(title), [title]);
  if (!editing) {
    return (
      <h2
        className={`min-w-0 flex-1 font-display text-[22px] font-bold leading-tight ${canWrite ? "cursor-text rounded-md -mx-1.5 px-1.5 py-0.5 hover:bg-ink/5 dark:hover:bg-paper/10" : ""}`}
        onClick={() => canWrite && setEditing(true)}
        title={canWrite ? "Click to rename" : undefined}
      >
        {title}
      </h2>
    );
  }
  return (
    <textarea
      className="input flex-1 font-display text-[22px] font-bold leading-tight"
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

/* --------------------------------------------------------- description */

export function DescriptionSection({
  value, canWrite, onSave,
}: { value: string; canWrite: boolean; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);

  return (
    <Section
      icon={<AlignLeftIcon size={18} />}
      title="Description"
      action={canWrite && !editing && value ? (
        <button className="btn-ghost !px-2.5 !py-1 text-xs bg-ink/6 dark:bg-paper/10" onClick={() => setEditing(true)}>Edit</button>
      ) : null}
    >
      {editing ? (
        <div className="mt-1">
          <textarea className="input min-h-32 text-sm" value={v} onChange={(e) => setV(e.target.value)} autoFocus />
          <div className="mt-1.5 flex gap-1">
            <button className="btn-accent !py-1 text-xs" onClick={() => { onSave(v); setEditing(false); }}>Save</button>
            <button className="btn-ghost !py-1 text-xs" onClick={() => { setV(value); setEditing(false); }}>Cancel</button>
          </div>
        </div>
      ) : value ? (
        <div
          className={`mt-1 whitespace-pre-wrap text-sm leading-relaxed ${canWrite ? "cursor-text" : ""}`}
          onClick={() => canWrite && setEditing(true)}
        >
          {value}
        </div>
      ) : (
        <button
          className="mt-1 w-full rounded-md bg-ink/5 px-3 py-3 text-left text-sm text-ink/55 hover:bg-ink/8 dark:bg-paper/8 dark:text-paper/55 dark:hover:bg-paper/12"
          onClick={() => setEditing(true)}
        >
          Add a more detailed description…
        </button>
      )}
    </Section>
  );
}

/* ---------------------------------------------------------- checklists */

export function ChecklistBlock({
  checklist, canWrite, onChange,
}: { checklist: Checklist; canWrite: boolean; onChange: () => void }) {
  const s = useBoard();
  const [newItem, setNewItem] = useState("");
  const done = checklist.items.filter((i) => i.done).length;
  const pct = checklist.items.length ? Math.round((done / checklist.items.length) * 100) : 0;

  return (
    <Section
      icon={<CheckSquareIcon size={18} />}
      title={checklist.name}
      action={canWrite ? (
        <button
          className="btn-ghost !px-2.5 !py-1 text-xs bg-ink/6 dark:bg-paper/10"
          onClick={async () => { await api.del(`/api/checklists/${checklist.id}`); onChange(); }}
        >
          Delete
        </button>
      ) : null}
    >
      <div className="mt-1 flex items-center gap-2">
        <span className="w-8 text-right text-[11px] tabular-nums opacity-50">{pct}%</span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink/10 dark:bg-paper/15">
          <div className={`h-full rounded-full transition-all ${pct === 100 ? "bg-[#519839]" : "bg-[#5b8def]"}`} style={{ width: `${pct}%` }} />
        </div>
      </div>
      <ul className="mt-1.5 space-y-0.5">
        {checklist.items.map((item) => (
          <li key={item.id} className="group flex items-start gap-2.5 rounded-md px-1 py-1 hover:bg-ink/5 dark:hover:bg-paper/10">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 accent-[#5b8def]"
              checked={item.done}
              disabled={!canWrite}
              onChange={async (e) => {
                await api.patch(`/api/checklist-items/${item.id}`, { done: e.target.checked });
                onChange();
              }}
            />
            <span className={`flex-1 text-sm leading-6 ${item.done ? "line-through opacity-50" : ""}`}>
              {item.text}
              {item.dueAt && (
                <span className="ml-2 rounded bg-ink/10 px-1.5 py-0.5 text-[11px] dark:bg-paper/15">
                  {fmtDue(item.dueAt)}
                </span>
              )}
            </span>
            {item.assigneeId && (() => {
              const m = s.members.find((x) => x.id === item.assigneeId);
              return m ? <span className="mt-0.5"><Avatar name={m.name} color={m.avatarColor} size={22} /></span> : null;
            })()}
            {canWrite && <ItemMenu item={item} members={s.members} onChange={onChange} />}
          </li>
        ))}
      </ul>
      {canWrite && (
        <form
          className="mt-1.5 flex gap-1 pl-1"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!newItem.trim()) return;
            await api.post(`/api/checklists/${checklist.id}/items`, { text: newItem.trim() });
            setNewItem("");
            onChange();
          }}
        >
          <input className="input !py-1.5 text-sm" placeholder="Add an item…" value={newItem} onChange={(e) => setNewItem(e.target.value)} maxLength={400} />
          <button className="btn-ghost shrink-0 !py-1 text-xs" disabled={!newItem.trim()}>Add</button>
        </form>
      )}
    </Section>
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
  return (
    <span className="mt-0.5">
      {/* the fade lives on the button, not the wrapper: the panel is a DOM child and would inherit opacity 0 */}
      <Pop
        width={240}
        trigger={(toggle, open) => (
          <button
            type="button"
            className={`${iconBtnClass} !h-7 !w-7 ${open ? "" : "opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"}`}
            onClick={toggle}
            title="Item options"
          >
            <MoreIcon size={16} />
          </button>
        )}
      >
        {() => (
          <>
            <p className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide opacity-50">Assign</p>
            {members.map((m) => (
              <button
                key={m.id}
                className={`${menuRowClass} !py-1 text-xs`}
                onClick={async () => {
                  await api.patch(`/api/checklist-items/${item.id}`, {
                    assigneeId: item.assigneeId === m.id ? null : m.id,
                  });
                  onChange();
                }}
              >
                <Avatar name={m.name} color={m.avatarColor} size={18} />
                <span className="flex-1 truncate">{m.name}</span>
                {item.assigneeId === m.id && "✓"}
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
              className={`${menuRowClass} mt-1 !py-1 text-xs text-[#b03a37]`}
              onClick={async () => { await api.del(`/api/checklist-items/${item.id}`); onChange(); }}
            >
              <TrashIcon size={14} /> Delete item
            </button>
          </>
        )}
      </Pop>
    </span>
  );
}

/** the "Checklist" chip: adds a new checklist */
export function AddChecklistChip({ cardId, onAdded }: { cardId: string; onAdded: () => void }) {
  return (
    <ActionPop variant="chip" icon={<CheckSquareIcon size={15} />} label="Checklist" width={260}>
      {(close) => <ChecklistPanel cardId={cardId} onAdded={onAdded} close={close} />}
    </ActionPop>
  );
}

/* --------------------------------------------------------- attachments */

export function AttachmentsSection({
  cardId, attachments, coverAttachmentId, canWrite, onChange, onSetCover,
}: {
  cardId: string;
  attachments: Attachment[];
  coverAttachmentId: string | null;
  canWrite: boolean;
  onChange: () => void;
  onSetCover: (id: string | null) => void;
}) {
  const images = attachments.filter((a) => a.mime.startsWith("image/"));
  const files = attachments.filter((a) => !a.mime.startsWith("image/"));
  const fileUrl = (a: Attachment) => `/api/attachments/${a.id}/file`;
  const when = (a: Attachment) => new Date(a.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const size = (a: Attachment) => (a.size >= 1024 * 1024 ? `${(a.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(a.size / 1024))} KB`);

  const RowActions = ({ a }: { a: Attachment }) => (
    <div className="flex shrink-0 items-center gap-0.5 opacity-70">
      {canWrite && a.mime.startsWith("image/") && (
        <button
          className="btn-ghost !px-2 !py-1 text-xs"
          title={coverAttachmentId === a.id ? "Remove cover" : "Make cover"}
          onClick={() => onSetCover(coverAttachmentId === a.id ? null : a.id)}
        >
          <ImageIcon size={14} /> {coverAttachmentId === a.id ? "Uncover" : "Cover"}
        </button>
      )}
      <a className="btn-ghost !px-1.5 !py-1 text-xs" href={`${fileUrl(a)}?download=1`} title="Download"><DownloadIcon size={14} /></a>
      {canWrite && (
        <button
          className="btn-ghost !px-1.5 !py-1 text-xs hover:text-[#b03a37]"
          title="Delete attachment"
          onClick={async () => { await api.del(`/api/attachments/${a.id}`); onChange(); }}
        >
          <XIcon size={14} />
        </button>
      )}
    </div>
  );

  return (
    <Section
      icon={<PaperclipIcon size={18} />}
      title="Attachments"
      action={canWrite ? (
        <span className="rounded-md bg-ink/6 dark:bg-paper/10"><AttachButton cardId={cardId} onUploaded={onChange} variant="text" label="Add" /></span>
      ) : null}
    >
      {images.length > 0 && (
        <ul className="mt-1 space-y-1.5">
          {images.map((a) => (
            <li key={a.id} className="flex items-center gap-3 rounded-md p-1 hover:bg-ink/5 dark:hover:bg-paper/8">
              <a href={fileUrl(a)} target="_blank" rel="noreferrer" className="shrink-0">
                <img src={fileUrl(a)} alt="" className="h-16 w-24 rounded-md border border-rule object-cover dark:border-ink-3" loading="lazy" />
              </a>
              <div className="min-w-0 flex-1">
                <a href={fileUrl(a)} target="_blank" rel="noreferrer" className="block truncate text-sm font-medium hover:underline">{a.filename}</a>
                <p className="text-xs opacity-50">
                  {when(a)} · {size(a)}{coverAttachmentId === a.id ? " · cover" : ""}
                </p>
              </div>
              <RowActions a={a} />
            </li>
          ))}
        </ul>
      )}
      {files.length > 0 && (
        <ul className={`${images.length ? "mt-2" : "mt-1"} space-y-1`}>
          {files.map((a) => (
            <li key={a.id} className="flex items-center gap-3 rounded-md border border-rule px-2 py-1.5 dark:border-ink-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-ink/6 text-ink/70 dark:bg-paper/10 dark:text-paper/70">
                <FileIcon size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <a href={fileUrl(a)} target="_blank" rel="noreferrer" className="block truncate text-sm font-medium hover:underline">{a.filename}</a>
                <p className="text-xs opacity-50">{when(a)} · {size(a)}</p>
              </div>
              <RowActions a={a} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/* -------------------------------------------------------- dependencies */

/** Monday-style dependencies: blocked-by / blocks, same board */
export function DependenciesSection({
  cardId, canWrite, forceShow, onDismiss,
}: { cardId: string; canWrite: boolean; forceShow: boolean; onDismiss: () => void }) {
  const s = useBoard();
  const [adding, setAdding] = useState<null | "blocks" | "blockedBy">(null);
  const [pick, setPick] = useState("");

  const blockers = s.links.filter((l) => l.blocksCardId === cardId).map((l) => l.cardId);
  const blocking = s.links.filter((l) => l.cardId === cardId).map((l) => l.blocksCardId);
  const hasLinks = blockers.length > 0 || blocking.length > 0;
  if (!hasLinks && !(canWrite && forceShow)) return null;

  const cardOf = (id: string) => s.cards.find((c) => c.id === id);
  const linked = new Set([...blockers, ...blocking, cardId]);
  const candidates = s.cards.filter((c) => !c.archived && !linked.has(c.id) && !c.mirrorOfCardId);

  const Row = ({ id }: { id: string }) => {
    const c = cardOf(id);
    if (!c) return null;
    const open = !c.archived && !c.dueComplete;
    return (
      <li className="flex items-center gap-2 rounded-md border border-rule px-2 py-1.5 text-sm dark:border-ink-3">
        <span className={`h-2 w-2 shrink-0 rounded-full ${open ? "bg-[#b03a37]" : "bg-[#519839]"}`} title={open ? "open" : "done"} />
        <a href={`/b/${c.boardId}/c/${c.id}`} className="min-w-0 flex-1 truncate hover:underline">
          {c.title}
        </a>
        <span className="truncate text-xs opacity-40">{s.lists.find((l) => l.id === c.listId)?.name}</span>
        {canWrite && (
          <button
            className="btn-ghost !px-1.5 !py-0.5 text-xs"
            onClick={() => api.del(`/api/cards/${cardId}/links/${id}`)}
            title="Remove dependency"
          >
            <XIcon size={13} />
          </button>
        )}
      </li>
    );
  };

  return (
    <Section
      icon={<LinkIcon size={18} />}
      title="Dependencies"
      action={canWrite && !hasLinks && !adding ? (
        <button className="btn-ghost !px-2 !py-1 text-xs" onClick={onDismiss} title="Hide">
          <XIcon size={14} />
        </button>
      ) : null}
    >
      {blockers.length > 0 && (
        <>
          <p className="mt-1 flex items-center gap-1 text-xs font-medium text-[#b03a37]"><BlockIcon size={13} /> Blocked by</p>
          <ul className="mt-1 space-y-1">{blockers.map((id) => <Row key={id} id={id} />)}</ul>
        </>
      )}
      {blocking.length > 0 && (
        <>
          <p className="mt-2 flex items-center gap-1 text-xs font-medium opacity-70"><ArrowRightIcon size={13} /> Blocks</p>
          <ul className="mt-1 space-y-1">{blocking.map((id) => <Row key={id} id={id} />)}</ul>
        </>
      )}
      {canWrite && (
        adding ? (
          <div className="mt-2 flex gap-1">
            <select className="input !py-1 text-sm" value={pick} onChange={(e) => setPick(e.target.value)} autoFocus>
              <option value="">{adding === "blockedBy" ? "This card is blocked by…" : "This card blocks…"}</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>{c.title}</option>
              ))}
            </select>
            <button
              className="btn-accent shrink-0 !py-1 text-xs"
              disabled={!pick}
              onClick={async () => {
                await api.put(`/api/cards/${cardId}/links/${pick}`, { direction: adding });
                setAdding(null);
                setPick("");
              }}
            >
              Link
            </button>
            <button className="btn-ghost shrink-0 !py-1 text-xs" onClick={() => setAdding(null)}>Cancel</button>
          </div>
        ) : (
          <div className="mt-2 flex gap-1">
            <button className="btn-ghost !px-2 !py-1 text-xs bg-ink/6 dark:bg-paper/10" onClick={() => setAdding("blockedBy")}><PlusIcon size={13} /> Blocked by</button>
            <button className="btn-ghost !px-2 !py-1 text-xs bg-ink/6 dark:bg-paper/10" onClick={() => setAdding("blocks")}><PlusIcon size={13} /> Blocks</button>
          </div>
        )
      )}
    </Section>
  );
}

/* -------------------------------------------------------- field editor */

export function FieldEditor({
  def, value, canWrite, onSave,
}: {
  def: { id: string; name: string; type: string; options: Array<{ id: string; label: string; color: string }> };
  value: unknown;
  canWrite: boolean;
  onSave: (v: unknown) => void;
}) {
  const members = useBoard((s) => s.members);
  const base = "flex min-h-9 items-center gap-2 rounded-md border border-rule px-2 py-1.5 text-sm dark:border-ink-3";
  const name = <span className="shrink-0 text-xs opacity-50">{def.name}</span>;

  if (!canWrite) {
    return (
      <div className={base}>
        {name}
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
          {name}
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
          {name}
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
          {name}
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
          {name}
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
          {name}
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
          {name}
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
