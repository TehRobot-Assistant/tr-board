import { useEffect, useState, type ReactNode } from "react";
import { describeRecurrence } from "../lib/recurrence";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { getSocket } from "../lib/socket";
import { useBoard } from "../stores/board";
import type { Card, CardDetail } from "../lib/types";
import { Avatar } from "./Chrome";

export function dueTone(card: Card): string {
  if (!card.dueAt) return "";
  if (card.dueComplete) return "bg-[#519839] text-white";
  const t = new Date(card.dueAt).getTime();
  if (t < Date.now()) return "bg-[#b03a37] text-white";
  if (t < Date.now() + 24 * 3600_000) return "bg-[#d9a21b] text-ink";
  return "bg-ink/10 dark:bg-paper/15";
}

export function fmtDue(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export default function CardChip({
  card, overlay = false, expandable = false,
}: { card: Card; overlay?: boolean; expandable?: boolean }) {
  const labels = useBoard((s) => s.labels);
  const members = useBoard((s) => s.members);
  const defs = useBoard((s) => s.customFieldDefs);
  const links = useBoard((s) => s.links);
  const cards = useBoard((s) => s.cards);
  const [expanded, setExpanded] = useState(false);

  // mirrors render the SOURCE card's face and link to the source
  if (card.mirrorOfCardId) return <MirrorChip card={card} overlay={overlay} />;

  const cardLabels = labels.filter((l) => card.labelIds.includes(l.id));
  const cardMembers = members.filter((m) => card.memberIds.includes(m.id));
  const frontFields = defs.filter((d) => d.showOnFront && card.fieldValues[d.id] !== undefined);
  const b = card.badges;
  // blocked = some blocker card is still open (not archived / not due-complete)
  const openBlockers = links
    .filter((l) => l.blocksCardId === card.id)
    .map((l) => cards.find((c) => c.id === l.cardId))
    .filter((c) => c && !c.archived && !c.dueComplete);

  // is there anything worth expanding in-place?
  const hasMore = !!card.description.trim() || b.comments > 0 || b.attachments > 0;

  const inner = (
    <>
      {card.coverColor && (
        <div className="-mx-2.5 -mt-2.5 mb-2 h-8 rounded-t-card" style={{ background: card.coverColor }} />
      )}
      {card.coverAttachmentId && !card.coverColor && (
        <img
          src={`/api/attachments/${card.coverAttachmentId}/file`}
          alt=""
          className="-mx-2.5 -mt-2.5 mb-2 h-32 w-[calc(100%+1.25rem)] max-w-none rounded-t-card object-cover"
          loading="lazy"
        />
      )}
      {cardLabels.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {cardLabels.map((l) => (
            <span
              key={l.id}
              title={l.name}
              className="h-2 min-w-8 rounded-full px-1.5 text-[10px] font-medium leading-none text-white"
              style={{ background: l.color }}
            >
              {l.name ? <span className="relative -top-0.5">{l.name}</span> : null}
            </span>
          ))}
        </div>
      )}
      <p className="leading-snug">{card.title}</p>

      {frontFields.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {frontFields.map((d) => (
            <span key={d.id} className="rounded bg-ink/8 px-1.5 py-0.5 text-[11px] dark:bg-paper/15">
              {d.name}: <FieldValueInline def={d} value={card.fieldValues[d.id]} />
            </span>
          ))}
        </div>
      )}

      {(card.dueAt || card.recurrence || b.comments > 0 || b.attachments > 0 || b.checklist || cardMembers.length > 0 || openBlockers.length > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] opacity-90">
          {openBlockers.length > 0 && (
            <span
              className="rounded bg-[#b03a37] px-1.5 py-0.5 font-medium text-white"
              title={`Blocked by: ${openBlockers.map((c) => c!.title).join(", ")}`}
            >
              ⛔ blocked
            </span>
          )}
          {card.dueAt && (
            <span className={`rounded px-1.5 py-0.5 font-medium ${dueTone(card)}`}>
              ⏱ {fmtDue(card.dueAt)}
            </span>
          )}
          {card.recurrence && (
            <span title={describeRecurrence(card.recurrence)} aria-label={describeRecurrence(card.recurrence)}>
              ↻
            </span>
          )}
          {b.checklist && (
            <span
              className={`rounded px-1.5 py-0.5 ${
                b.checklist.done === b.checklist.total ? "bg-[#519839] text-white" : "bg-ink/10 dark:bg-paper/15"
              }`}
            >
              ☑ {b.checklist.done}/{b.checklist.total}
            </span>
          )}
          {b.comments > 0 && <span>💬 {b.comments}</span>}
          {b.attachments > 0 && <span>📎 {b.attachments}</span>}
          {cardMembers.length > 0 && (
            <span className="ml-auto flex -space-x-1">
              {cardMembers.map((m) => (
                <Avatar key={m.id} name={m.name} color={m.avatarColor} size={20} />
              ))}
            </span>
          )}
        </div>
      )}
    </>
  );

  const shell = "rounded-card bg-white text-sm shadow-card transition-shadow dark:bg-ink-3";

  if (overlay) return <div className={`${shell} rotate-2 p-2.5 shadow-drag`}>{inner}</div>;

  return (
    <div className={`${shell} ${expanded ? "ring-2 ring-accent" : "hover:ring-2 hover:ring-accent"}`}>
      <Link to={`/b/${card.boardId}/c/${card.id}`} draggable={false} className="block p-2.5">
        {inner}
      </Link>
      {expandable && hasMore && (
        <button
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setExpanded((v) => !v); }}
          onPointerDown={(e) => e.stopPropagation()}
          className="flex w-full items-center justify-center gap-1 border-t border-ink/5 py-1 text-[11px] opacity-50 transition-opacity hover:opacity-100 dark:border-paper/10"
          title={expanded ? "Collapse" : "Preview description, comments & attachments"}
        >
          {expanded ? "▲ Less" : "▼ Preview"}
        </button>
      )}
      {expanded && <ExpandedCard card={card} onClose={() => setExpanded(false)} />}
    </div>
  );
}

/* ---------------------------------------------------------- inline expand */

/**
 * The "card back" without leaving the board: description, attachment previews
 * (images inline, files as links), and comments with a quick reply. Fetched
 * on demand and kept live via the same board socket events.
 */
function ExpandedCard({ card, onClose }: { card: Card; onClose: () => void }) {
  const qc = useQueryClient();
  const canWrite = !!useBoard((s) => s.myAccess?.canWrite);
  const { data } = useQuery({
    queryKey: ["card", card.id],
    queryFn: () => api.get<CardDetail>(`/api/cards/${card.id}`),
    staleTime: 5_000,
  });

  // live-refresh while open when this card changes on the board
  useEffect(() => {
    const socket = getSocket();
    // card.updated carries { card }, the others { cardId } (L6: this only
    // looked at cardId, so edits to the card itself never refreshed the panel)
    const refresh = (p: { cardId?: string; card?: { id?: string } }) => {
      if ((p?.cardId ?? p?.card?.id) === card.id) qc.invalidateQueries({ queryKey: ["card", card.id] });
    };
    for (const ev of ["comment.created", "comment.deleted", "attachment.created", "attachment.deleted", "card.updated"]) {
      socket.on(ev, refresh);
    }
    return () => {
      for (const ev of ["comment.created", "comment.deleted", "attachment.created", "attachment.deleted", "card.updated"]) {
        socket.off(ev, refresh);
      }
    };
  }, [card.id, qc]);

  const [reply, setReply] = useState("");
  // stop drag/nav starting from inside the panel
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  const images = (data?.attachments ?? []).filter((a) => a.mime.startsWith("image/"));
  const files = (data?.attachments ?? []).filter((a) => !a.mime.startsWith("image/"));

  return (
    <div className="space-y-3 border-t border-ink/8 p-2.5 dark:border-paper/10" onPointerDown={stop} onClick={stop}>
      {card.description.trim() && (
        <div className="text-[13px] leading-snug opacity-90">
          <RichText text={card.description} />
        </div>
      )}

      {images.length > 0 && (
        <div className="grid grid-cols-2 gap-1.5">
          {images.map((a) => (
            <a key={a.id} href={`/api/attachments/${a.id}/file`} target="_blank" rel="noreferrer" title={a.filename}>
              <img
                src={`/api/attachments/${a.id}/file`}
                alt={a.filename}
                loading="lazy"
                className="h-24 w-full rounded-md object-cover ring-1 ring-ink/10 dark:ring-paper/15"
              />
            </a>
          ))}
        </div>
      )}

      {files.map((a) => (
        <a
          key={a.id}
          href={`/api/attachments/${a.id}/file`}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 rounded-md border border-rule px-2 py-1.5 text-[13px] hover:bg-ink/5 dark:border-ink-3 dark:hover:bg-paper/10"
        >
          <span>{fileIcon(a.mime)}</span>
          <span className="min-w-0 flex-1 truncate">{a.filename}</span>
          <span className="shrink-0 text-[11px] opacity-50">{fmtBytes(a.size)}</span>
        </a>
      ))}

      {(data?.comments ?? []).length > 0 && (
        <ul className="space-y-2">
          {data!.comments.slice(0, 4).map((c) => (
            <li key={c.id} className="flex gap-1.5">
              <Avatar name={c.userName ?? "⚙"} color={c.avatarColor ?? "#838c91"} size={20} />
              <div className="min-w-0 flex-1">
                <p className="text-[11px] opacity-60">
                  <span className="font-semibold opacity-90">{c.userName ?? "⚙ Automation"}</span>{" "}
                  {new Date(c.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
                </p>
                <div className="text-[13px] leading-snug"><RichText text={c.body} /></div>
              </div>
            </li>
          ))}
          {data!.comments.length > 4 && (
            <li>
              <Link to={`/b/${card.boardId}/c/${card.id}`} className="text-[11px] underline opacity-60" onClick={stop}>
                View all {data!.comments.length} comments
              </Link>
            </li>
          )}
        </ul>
      )}

      {canWrite && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!reply.trim()) return;
            await api.post(`/api/cards/${card.id}/comments`, { body: reply.trim() });
            setReply("");
            qc.invalidateQueries({ queryKey: ["card", card.id] });
          }}
        >
          <input
            className="input !py-1 text-[13px]"
            placeholder="Write a comment…"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
          />
        </form>
      )}

      <div className="flex justify-between">
        <Link to={`/b/${card.boardId}/c/${card.id}`} className="text-[11px] underline opacity-60" onClick={stop}>
          Open full card
        </Link>
        <button className="text-[11px] opacity-60 hover:opacity-100" onClick={onClose}>Collapse ▲</button>
      </div>
    </div>
  );
}

const IMG_URL_RE = /\.(png|jpe?g|gif|webp|avif|svg)(\?[^\s]*)?$/i;
const URL_RE = /(https?:\/\/[^\s<]+)/g;

/**
 * minimal rich text: linkify URLs, keep newlines, **bold**. Image URLs get a
 * thumbnail only on click (L4): auto-loading any https image let anyone who
 * can write a description or comment, including anonymous public-form
 * submitters, plant a tracking pixel that logs every viewer's IP. Same-origin
 * images (our own attachments) still load straight away.
 */
function RichText({ text }: { text: string }) {
  const [showImages, setShowImages] = useState(false);
  const imageUrls: string[] = [];
  const nodes: ReactNode[] = text.split(URL_RE).map((part, i) => {
    if (/^https?:\/\//.test(part)) {
      if (IMG_URL_RE.test(part)) imageUrls.push(part);
      return (
        <a key={i} href={part} target="_blank" rel="noreferrer" className="break-all text-[#2c5a8f] underline dark:text-[#5ba4cf]">
          {part.replace(/^https?:\/\//, "").slice(0, 48)}
        </a>
      );
    }
    // lightweight **bold**
    return part.split(/(\*\*[^*]+\*\*)/).map((seg, j) =>
      /^\*\*[^*]+\*\*$/.test(seg) ? <strong key={`${i}-${j}`}>{seg.slice(2, -2)}</strong> : <span key={`${i}-${j}`}>{seg}</span>,
    );
  });
  return (
    <>
      <p className="whitespace-pre-wrap break-words">{nodes}</p>
      {imageUrls.length > 0 && !showImages && !imageUrls.slice(0, 4).every(sameOrigin) && (
        <button
          type="button"
          className="mt-1.5 text-[11px] underline opacity-60 hover:opacity-100"
          title="Loading them contacts the sites they're hosted on"
          onClick={(e) => {
            e.stopPropagation();
            setShowImages(true);
          }}
        >
          Show {Math.min(imageUrls.length, 4)} linked image{imageUrls.length > 1 ? "s" : ""}
        </button>
      )}
      {imageUrls.length > 0 && (showImages || imageUrls.slice(0, 4).every(sameOrigin)) && (
        <div className="mt-1.5 grid grid-cols-2 gap-1.5">
          {imageUrls.slice(0, 4).map((u, i) => (
            <a key={i} href={u} target="_blank" rel="noreferrer">
              <img src={u} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-20 w-full rounded-md object-cover ring-1 ring-ink/10 dark:ring-paper/15" />
            </a>
          ))}
        </div>
      )}
    </>
  );
}

function sameOrigin(url: string): boolean {
  try {
    return new URL(url).origin === location.origin;
  } catch {
    return false;
  }
}

function fileIcon(mime: string): string {
  if (mime.startsWith("video/")) return "🎬";
  if (mime.startsWith("audio/")) return "🎵";
  if (mime === "application/pdf") return "📕";
  if (/zip|compressed|tar|rar|7z/.test(mime)) return "🗜";
  if (/sheet|excel|csv/.test(mime)) return "📊";
  if (/word|document/.test(mime)) return "📝";
  return "📄";
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function MirrorChip({ card, overlay }: { card: Card; overlay: boolean }) {
  const snap = card.mirror ?? null;
  // M2: the server withholds the face when you can't read the source board
  if (snap && "restricted" in snap) return <RestrictedMirrorChip overlay={overlay} />;
  const m = snap;
  const face = m ?? {
    title: card.title, dueAt: null, dueComplete: false, archived: false,
    labels: [], boardName: "deleted board", sourceBoardId: "", sourceCardId: "",
  };
  const dueChip = face.dueAt
    ? dueTone({ dueAt: face.dueAt, dueComplete: face.dueComplete } as Card)
    : "";

  const body = (
    <div
      className={`rounded-card border-l-4 border-[#89609e] bg-white p-2.5 text-sm shadow-card dark:bg-ink-3 ${
        overlay ? "rotate-2 shadow-drag" : "hover:ring-2 hover:ring-accent"
      } ${m?.archived || !m ? "opacity-60" : ""}`}
    >
      {face.labels.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {face.labels.map((l, i) => (
            <span key={i} title={l.name} className="h-2 min-w-8 rounded-full" style={{ background: l.color }} />
          ))}
        </div>
      )}
      <p className="leading-snug">{face.title}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] opacity-90">
        <span className="rounded bg-[#89609e]/15 px-1.5 py-0.5 font-medium text-[#89609e] dark:bg-[#89609e]/30 dark:text-[#c9a6e0]">
          ⇄ {m ? m.boardName : "source deleted"}
        </span>
        {face.dueAt && (
          <span className={`rounded px-1.5 py-0.5 font-medium ${dueChip}`}>⏱ {fmtDue(face.dueAt)}</span>
        )}
        {m?.archived && <span className="rounded bg-ink/10 px-1.5 py-0.5 dark:bg-paper/15">archived</span>}
      </div>
    </div>
  );

  if (overlay) return body;
  return (
    <Link
      to={m ? `/b/${m.sourceBoardId}/c/${m.sourceCardId}` : `/b/${card.boardId}/c/${card.id}`}
      draggable={false}
      className="block"
      title={m ? `Mirror of a card on "${m.boardName}" — opens the source` : "Source card was deleted"}
    >
      {body}
    </Link>
  );
}

function RestrictedMirrorChip({ overlay }: { overlay: boolean }) {
  return (
    <div
      title="Mirror of a card on a board you can't open"
      className={`rounded-card border-l-4 border-[#89609e] bg-white p-2.5 text-sm opacity-70 shadow-card dark:bg-ink-3 ${
        overlay ? "rotate-2 shadow-drag" : ""
      }`}
    >
      <p className="leading-snug opacity-80">Mirrored card</p>
      <div className="mt-2 text-[11px]">
        <span className="rounded bg-[#89609e]/15 px-1.5 py-0.5 font-medium text-[#89609e] dark:bg-[#89609e]/30 dark:text-[#c9a6e0]">
          ⇄ on a board you can't open
        </span>
      </div>
    </div>
  );
}

export function FieldValueInline({
  def, value,
}: { def: { type: string; options: Array<{ id: string; label: string; color: string }> }; value: unknown }) {
  const members = useBoard((s) => s.members);
  if (value === undefined || value === null) return <span className="opacity-40">—</span>;
  switch (def.type) {
    case "checkbox":
      return <>{value ? "✓" : "✗"}</>;
    case "date":
      return <>{new Date(String(value)).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</>;
    case "select": {
      const o = def.options.find((o) => o.id === value);
      return o ? (
        <span className="rounded px-1 text-white" style={{ background: o.color }}>{o.label}</span>
      ) : <>{String(value)}</>;
    }
    case "multiselect": {
      const ids = Array.isArray(value) ? value : [];
      return (
        <>
          {ids.map((id) => {
            const o = def.options.find((o) => o.id === id);
            return o ? (
              <span key={id} className="mr-0.5 rounded px-1 text-white" style={{ background: o.color }}>
                {o.label}
              </span>
            ) : null;
          })}
        </>
      );
    }
    case "member": {
      const m = members.find((m) => m.id === value);
      return <>{m?.name ?? "?"}</>;
    }
    case "url":
      return <span className="underline">{String(value).replace(/^https?:\/\//, "").slice(0, 30)}</span>;
    default:
      return <>{String(value)}</>;
  }
}
