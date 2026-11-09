/**
 * Card modal actions: the popover panels (members, labels, dates, repeat,
 * checklist, cover, mirror, list move) plus the trigger styles they can be
 * mounted on (chip row, section "+" square, header icon, menu row).
 *
 * The panels are plain components taking `close` so the same panel can live
 * under a chip, under a section's "+" button, or inside the "⋯" menu.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { sortRank, useBoard } from "../stores/board";
import type { Card } from "../lib/types";
import { Avatar, usePopover } from "./Chrome";
import { WEEKDAYS, isoWeekday, recurrenceRequest, type Recurrence } from "../lib/recurrence";
import { CheckIcon, PaperclipIcon, PlusIcon } from "./icons";

/* ------------------------------------------------------------ triggers */

export type TriggerVariant = "chip" | "square" | "icon" | "text" | "menu";

export const chipClass =
  "inline-flex h-8 items-center gap-1.5 rounded-lg border border-rule bg-transparent px-2.5 text-[13px] font-medium text-ink/85 " +
  "hover:bg-ink/5 disabled:opacity-50 dark:border-ink-3 dark:text-paper/85 dark:hover:bg-paper/10";
export const squareClass =
  "flex h-8 w-8 items-center justify-center rounded-md bg-ink/6 text-ink/80 hover:bg-ink/12 dark:bg-paper/10 dark:text-paper/80 dark:hover:bg-paper/15";
export const iconBtnClass =
  "flex h-8 w-8 items-center justify-center rounded-md text-ink/70 hover:bg-ink/8 hover:text-ink dark:text-paper/70 dark:hover:bg-paper/10 dark:hover:text-paper";
export const menuRowClass =
  "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-ink/6 dark:hover:bg-paper/10";

export function Trigger({
  variant, icon, label, onClick, title, disabled,
}: {
  variant: TriggerVariant;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  title?: string;
  disabled?: boolean;
}) {
  switch (variant) {
    case "square":
      return (
        <button type="button" className={squareClass} onClick={onClick} title={title ?? label} disabled={disabled}>
          <PlusIcon size={16} />
        </button>
      );
    case "icon":
      return (
        <button type="button" className={iconBtnClass} onClick={onClick} title={title ?? label} disabled={disabled}>
          {icon}
        </button>
      );
    case "text":
      return (
        <button type="button" className="btn-ghost !px-2 !py-1 text-xs" onClick={onClick} title={title} disabled={disabled}>
          {label}
        </button>
      );
    case "menu":
      return (
        <button type="button" className={menuRowClass} onClick={onClick} title={title} disabled={disabled}>
          <span className="opacity-70">{icon}</span>
          {label}
        </button>
      );
    default:
      return (
        <button type="button" className={chipClass} onClick={onClick} title={title} disabled={disabled}>
          <span className="opacity-75">{icon}</span>
          {label}
        </button>
      );
  }
}

/* ------------------------------------------------------------- popover */

/**
 * Popover anchored to its trigger but positioned `fixed`, so it is never
 * clipped by the modal's scrolling panes. Stays a DOM child of the wrapper so
 * usePopover's outside-click test still works. Closes on scroll outside the
 * panel because its coordinates would otherwise drift from the trigger.
 */
export function Pop({
  trigger, width = 280, children,
}: {
  trigger: (toggle: () => void, open: boolean) => ReactNode;
  width?: number;
  children: (close: () => void) => ReactNode;
}) {
  const { open, setOpen, ref } = usePopover();
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; maxH: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const place = () => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      const vw = window.innerWidth, vh = window.innerHeight, gap = 6, margin = 8;
      const w = Math.min(width, vw - margin * 2);
      const left = Math.max(margin, Math.min(r.left, vw - w - margin));
      const below = vh - r.bottom - gap - margin;
      const above = r.top - gap - margin;
      if (below >= 280 || below >= above) setPos({ top: r.bottom + gap, left, maxH: Math.max(160, below) });
      else setPos({ bottom: vh - r.top + gap, left, maxH: Math.max(160, above) });
    };
    place();
    // ignore the scroll a browser may make to reveal an autoFocus'd input right after opening
    const openedAt = Date.now();
    const onScroll = (e: Event) => {
      if (Date.now() - openedAt < 250) return;
      if (panelRef.current && e.target instanceof Node && panelRef.current.contains(e.target)) return;
      setOpen(false);
    };
    window.addEventListener("resize", place);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [open, width, ref, setOpen]);

  return (
    <div className="relative inline-flex" ref={ref}>
      {trigger(() => setOpen(!open), open)}
      {open && pos && (
        <div
          ref={panelRef}
          data-popover=""
          className="menu-panel fixed z-[60] overflow-y-auto"
          style={{ top: pos.top, bottom: pos.bottom, left: pos.left, width: Math.min(width, window.innerWidth - 16), maxHeight: pos.maxH }}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/** convenience: a Trigger + Pop pair */
export function ActionPop({
  variant, icon, label, title, width, children,
}: {
  variant: TriggerVariant;
  icon: ReactNode;
  label: string;
  title?: string;
  width?: number;
  children: (close: () => void) => ReactNode;
}) {
  return (
    <Pop width={width} trigger={(toggle) => <Trigger variant={variant} icon={icon} label={label} title={title} onClick={toggle} />}>
      {children}
    </Pop>
  );
}

export const PanelTitle = ({ children }: { children: ReactNode }) => (
  <p className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide opacity-50">{children}</p>
);

/* -------------------------------------------------------------- panels */

export function ListPanel({ card, close }: { card: Pick<Card, "id" | "listId">; close: () => void }) {
  const s = useBoard();
  const lists = s.lists.filter((l) => !l.archived);
  return (
    <>
      <PanelTitle>Move to list</PanelTitle>
      {lists.map((l) => {
        const current = l.id === card.listId;
        return (
          <button
            key={l.id}
            className={`${menuRowClass} ${current ? "font-semibold" : ""}`}
            onClick={() => {
              if (!current) {
                // drop at the bottom of the target list: after its last card, before nothing
                const inList = sortRank(s.cards.filter((c) => c.listId === l.id && c.id !== card.id));
                s.moveCard(card.id, l.id, null, inList.length ? inList[inList.length - 1].id : null);
              }
              close();
            }}
          >
            <span className="flex-1 truncate">{l.name}</span>
            {current && <CheckIcon size={14} />}
          </button>
        );
      })}
    </>
  );
}

export function MembersPanel({ cardId, memberIds, onChange }: { cardId: string; memberIds: string[]; onChange: () => void }) {
  const members = useBoard((s) => s.members);
  return (
    <>
      <PanelTitle>Members</PanelTitle>
      {members.length === 0 && <p className="px-2 py-1 text-xs opacity-60">No board members.</p>}
      {members.map((m) => (
        <button
          key={m.id}
          className={menuRowClass}
          onClick={async () => {
            if (memberIds.includes(m.id)) await api.del(`/api/cards/${cardId}/members/${m.id}`);
            else await api.put(`/api/cards/${cardId}/members/${m.id}`);
            onChange();
          }}
        >
          <Avatar name={m.name} color={m.avatarColor} size={24} />
          <span className="flex-1 truncate">{m.name}</span>
          {memberIds.includes(m.id) && <CheckIcon size={14} />}
        </button>
      ))}
    </>
  );
}

const LABEL_PALETTE = [
  "#61bd4f", "#f2d600", "#ff9f1a", "#eb5a46", "#c377e0",
  "#0079bf", "#00c2e0", "#51e898", "#ff78cb", "#344563",
];

export function LabelsPanel({ cardId, labelIds, onChange }: { cardId: string; labelIds: string[]; onChange: () => void }) {
  const s = useBoard();
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(LABEL_PALETTE[0]);
  return (
    <>
      <PanelTitle>Labels</PanelTitle>
      {s.labels.map((l) => (
        <button
          key={l.id}
          className="mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium text-white hover:brightness-95"
          style={{ background: l.color }}
          onClick={async () => {
            if (labelIds.includes(l.id)) await api.del(`/api/cards/${cardId}/labels/${l.id}`);
            else await api.put(`/api/cards/${cardId}/labels/${l.id}`);
            onChange();
          }}
        >
          <span className="flex-1 text-left">{l.name || " "}</span>
          {labelIds.includes(l.id) && <CheckIcon size={14} />}
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
              title={c}
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
  );
}

export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function DuePanel({
  card, onSave, close,
}: { card: { startAt: string | null; dueAt: string | null }; onSave: (p: Record<string, unknown>) => void; close: () => void }) {
  return (
    <>
      <PanelTitle>Start</PanelTitle>
      <input
        type="date"
        className="input !py-1 text-xs"
        defaultValue={card.startAt ? card.startAt.slice(0, 10) : ""}
        onChange={(e) => onSave({ startAt: e.target.value ? new Date(e.target.value + "T09:00:00").toISOString() : null })}
      />
      <p className="mt-2 px-1 pb-1 text-[11px] font-medium uppercase tracking-wide opacity-50">Due</p>
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
  );
}

/**
 * "Repeat": the next copy is made when the due date is ticked complete
 * (server/src/lib/recurrence.ts explains why completion, not a timer).
 */
export function RepeatPanel({
  card, onSave, close,
}: {
  card: { dueAt: string | null; recurrence?: Recurrence | null; listId: string };
  onSave: (p: Record<string, unknown>) => Promise<void> | void;
  close: () => void;
}) {
  const lists = useBoard((s) => s.lists).filter((l) => !l.archived);
  const r = card.recurrence;
  const [freq, setFreq] = useState<Recurrence["freq"]>(r?.freq ?? "weekly");
  const [interval, setEvery] = useState(r?.interval ?? 1);
  const [days, setDays] = useState<number[]>(r?.weekdays ?? (card.dueAt ? [isoWeekday(new Date(card.dueAt))] : [1]));
  const [listId, setListId] = useState(r?.listId ?? "");
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setError(null);
    try {
      await onSave({ recurrence: { ...recurrenceRequest(freq, interval, days), ...(listId ? { listId } : {}) } });
      close();
    } catch (err: any) {
      setError(err.message);
    }
  };
  if (!card.dueAt) {
    return (
      <>
        <PanelTitle>Repeat</PanelTitle>
        <p className="p-1 text-xs opacity-70">Set a due date first. When it's ticked complete, the next copy is created.</p>
      </>
    );
  }
  return (
    <>
      <PanelTitle>Every</PanelTitle>
      <div className="flex gap-1">
        <input
          type="number" min={1} max={365} className="input !w-16 !py-1 text-xs"
          value={interval} onChange={(e) => setEvery(Number(e.target.value))}
        />
        <select className="input !py-1 text-xs" value={freq} onChange={(e) => setFreq(e.target.value as Recurrence["freq"])}>
          <option value="daily">{interval === 1 ? "day" : "days"}</option>
          <option value="weekly">{interval === 1 ? "week" : "weeks"}</option>
          <option value="monthly">{interval === 1 ? "month" : "months"}</option>
          <option value="yearly">{interval === 1 ? "year" : "years"}</option>
        </select>
      </div>
      {freq === "weekly" && (
        <div className="mt-2 flex flex-wrap gap-1">
          {WEEKDAYS.map((d, i) => {
            const on = days.includes(i + 1);
            return (
              <button
                key={d}
                className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${on ? "bg-accent text-ink" : "bg-ink/5 dark:bg-paper/10"}`}
                onClick={() => setDays(on ? days.filter((x) => x !== i + 1) : [...days, i + 1])}
              >
                {d}
              </button>
            );
          })}
        </div>
      )}
      <p className="mt-2 px-1 pb-1 text-[11px] font-medium uppercase tracking-wide opacity-50">Next copy goes to</p>
      <select className="input !py-1 text-xs" value={listId} onChange={(e) => setListId(e.target.value)}>
        <option value="">the card's current list</option>
        {lists.map((l) => (
          <option key={l.id} value={l.id}>{l.name}</option>
        ))}
      </select>
      <p className="mt-2 px-1 text-[11px] opacity-60">
        When the due date is ticked complete, a copy is made with the next due date. Checklists reset; labels, members and fields carry over.
      </p>
      {error && <p className="px-1 text-xs text-[#b03a37]">{error}</p>}
      <button className="btn-accent mt-2 w-full !py-1 text-xs" onClick={save}>Save</button>
      {r && (
        <button className="btn-ghost mt-1 w-full !py-1 text-xs" onClick={async () => { await onSave({ recurrence: null }); close(); }}>
          Stop repeating
        </button>
      )}
    </>
  );
}

export function ChecklistPanel({ cardId, onAdded, close }: { cardId: string; onAdded: () => void; close: () => void }) {
  const [name, setName] = useState("Checklist");
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        await api.post(`/api/cards/${cardId}/checklists`, { name: name.trim() || "Checklist" });
        close();
        onAdded();
      }}
    >
      <PanelTitle>Add checklist</PanelTitle>
      <input className="input !py-1 text-sm" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={120} />
      <button className="btn-accent mt-2 w-full !py-1 text-xs">Add checklist</button>
    </form>
  );
}

export function AttachButton({
  cardId, onUploaded, variant, label = "Attachment",
}: { cardId: string; onUploaded: () => void; variant: TriggerVariant; label?: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Trigger
        variant={variant}
        icon={<PaperclipIcon size={15} />}
        label={busy ? "Uploading…" : label}
        onClick={() => inputRef.current?.click()}
        disabled={busy}
      />
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

export function CoverPanel({
  card, onSave, close,
}: { card: { coverColor: string | null }; onSave: (p: Record<string, unknown>) => void; close: () => void }) {
  return (
    <>
      <PanelTitle>Cover</PanelTitle>
      <div className="flex flex-wrap gap-1">
        {COVER_COLORS.map((c) => (
          <button
            key={c}
            className={`h-8 w-12 rounded ${card.coverColor === c ? "ring-2 ring-ink ring-offset-1 dark:ring-paper" : ""}`}
            style={{ background: c }}
            onClick={() => onSave({ coverColor: c, coverAttachmentId: null })}
            title={c}
          />
        ))}
      </div>
      <p className="mt-2 px-1 text-[11px] opacity-60">To use an image, pick "Cover" on an image attachment.</p>
      <button className="btn-ghost mt-2 w-full !py-1 text-xs" onClick={() => { onSave({ coverColor: null, coverAttachmentId: null }); close(); }}>
        Remove cover
      </button>
    </>
  );
}

/** mirror this card onto another board (Trello Standard+, free here) */
export function MirrorPanel({ cardId, close }: { cardId: string; close: () => void }) {
  const s = useBoard();
  const [boards, setBoards] = useState<Array<{ id: string; name: string }>>([]);
  const [lists, setLists] = useState<Array<{ id: string; name: string }>>([]);
  const [boardId, setBoardId] = useState("");
  const [listId, setListId] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  return (
    <>
      <PanelTitle>Mirror</PanelTitle>
      <p className="mb-2 px-1 text-[11px] leading-snug opacity-60">
        Put a live read-only copy of this card on another board. It follows the
        source's title, due date and labels.
      </p>
      <select
        className="input !py-1 text-sm"
        value={boardId}
        onFocus={async () => {
          if (boards.length || !s.board) return;
          const ws = await api.get<{ boards: Array<{ id: string; name: string; archived: boolean }> }>(
            `/api/workspaces/${s.board.workspaceId}`,
          );
          setBoards(ws.boards.filter((b) => !b.archived && b.id !== s.boardId));
        }}
        onChange={async (e) => {
          setBoardId(e.target.value);
          setListId("");
          setLists([]);
          setMsg(null);
          if (!e.target.value) return;
          try {
            const full = await api.get<{ lists: Array<{ id: string; name: string; archived: boolean }> }>(
              `/api/boards/${e.target.value}/full`,
            );
            setLists(full.lists.filter((l) => !l.archived));
          } catch {
            setMsg("You can't access that board.");
          }
        }}
      >
        <option value="">Target board…</option>
        {boards.map((b) => (
          <option key={b.id} value={b.id}>{b.name}</option>
        ))}
      </select>
      {lists.length > 0 && (
        <select className="input mt-1.5 !py-1 text-sm" value={listId} onChange={(e) => setListId(e.target.value)}>
          <option value="">Target list…</option>
          {lists.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
      )}
      {msg && <p className="mt-1 text-xs text-[#b03a37]">{msg}</p>}
      <button
        className="btn-accent mt-2 w-full !py-1 text-xs"
        disabled={!listId}
        onClick={async () => {
          try {
            await api.post(`/api/cards/${cardId}/mirror`, { listId });
            close();
          } catch (err: any) {
            setMsg(err.message);
          }
        }}
      >
        Create mirror
      </button>
    </>
  );
}
