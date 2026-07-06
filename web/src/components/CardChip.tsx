import { Link } from "react-router-dom";
import { useBoard } from "../stores/board";
import type { Card } from "../lib/types";
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

export default function CardChip({ card, overlay = false }: { card: Card; overlay?: boolean }) {
  const labels = useBoard((s) => s.labels);
  const members = useBoard((s) => s.members);
  const defs = useBoard((s) => s.customFieldDefs);

  // mirrors render the SOURCE card's face and link to the source
  if (card.mirrorOfCardId) return <MirrorChip card={card} overlay={overlay} />;

  const cardLabels = labels.filter((l) => card.labelIds.includes(l.id));
  const cardMembers = members.filter((m) => card.memberIds.includes(m.id));
  const frontFields = defs.filter((d) => d.showOnFront && card.fieldValues[d.id] !== undefined);
  const b = card.badges;
  // blocked = some blocker card is still open (not archived / not due-complete)
  const links = useBoard((s) => s.links);
  const cards = useBoard((s) => s.cards);
  const openBlockers = links
    .filter((l) => l.blocksCardId === card.id)
    .map((l) => cards.find((c) => c.id === l.cardId))
    .filter((c) => c && !c.archived && !c.dueComplete);

  const body = (
    <div
      className={`rounded-card bg-white p-2.5 text-sm shadow-card transition-shadow dark:bg-ink-3 ${
        overlay ? "rotate-2 shadow-drag" : "hover:ring-2 hover:ring-accent"
      }`}
    >
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

      {(card.dueAt || b.comments > 0 || b.attachments > 0 || b.checklist || cardMembers.length > 0 || openBlockers.length > 0) && (
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
    </div>
  );

  if (overlay) return body;
  return (
    <Link to={`/b/${card.boardId}/c/${card.id}`} draggable={false} className="block">
      {body}
    </Link>
  );
}

function MirrorChip({ card, overlay }: { card: Card; overlay: boolean }) {
  const m = card.mirror ?? null;
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
