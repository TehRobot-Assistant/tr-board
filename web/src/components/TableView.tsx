import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useBoard } from "../stores/board";
import type { Card } from "../lib/types";
import { Avatar } from "./Chrome";
import { FieldValueInline, dueTone, fmtDue } from "./CardChip";

type SortKey = "title" | "list" | "due" | "created";

export default function TableView() {
  const s = useBoard();
  const nav = useNavigate();
  const canWrite = !!s.myAccess?.canWrite;
  const [sortKey, setSortKey] = useState<SortKey>("list");
  const [asc, setAsc] = useState(true);
  const [filter, setFilter] = useState("");

  const listName = (id: string) => s.lists.find((l) => l.id === id)?.name ?? "?";

  const rows = useMemo(() => {
    let cards = s.cards.filter((c) => !c.archived);
    if (filter.trim()) {
      const q = filter.toLowerCase();
      cards = cards.filter((c) => c.title.toLowerCase().includes(q));
    }
    const cmp: Record<SortKey, (a: Card, b: Card) => number> = {
      title: (a, b) => a.title.localeCompare(b.title),
      list: (a, b) => listName(a.listId).localeCompare(listName(b.listId)) || (a.rank < b.rank ? -1 : 1),
      due: (a, b) => (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity),
      created: (a, b) => a.id.localeCompare(b.id),
    };
    const sorted = [...cards].sort(cmp[sortKey]);
    return asc ? sorted : sorted.reverse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.cards, s.lists, sortKey, asc, filter]);

  const TH = ({ label, k }: { label: string; k?: SortKey }) => (
    <th
      className={`whitespace-nowrap px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide ${k ? "cursor-pointer select-none hover:underline" : ""}`}
      onClick={() => k && (k === sortKey ? setAsc(!asc) : (setSortKey(k), setAsc(true)))}
    >
      {label} {k === sortKey ? (asc ? "↑" : "↓") : ""}
    </th>
  );

  return (
    <div className="p-3">
      <div className="overflow-x-auto rounded-card bg-paper/97 shadow-card dark:bg-ink-2/97">
        <div className="flex items-center gap-2 border-b border-rule p-2 dark:border-ink-3">
          <input
            className="input !w-64 !py-1 text-sm"
            placeholder="Filter cards…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <span className="text-xs opacity-50">{rows.length} cards</span>
        </div>
        <table className="w-full min-w-[720px] text-sm">
          <thead className="border-b border-rule dark:border-ink-3">
            <tr>
              <TH label="Card" k="title" />
              <TH label="List" k="list" />
              <TH label="Labels" />
              <TH label="Members" />
              <TH label="Due" k="due" />
              {s.customFieldDefs.map((d) => (
                <TH key={d.id} label={d.name} />
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr
                key={c.id}
                className="cursor-pointer border-b border-rule/60 hover:bg-ink/4 dark:border-ink-3/60 dark:hover:bg-paper/8"
                onClick={() => nav(`/b/${c.boardId}/c/${c.id}`)}
              >
                <td className="max-w-72 px-3 py-2">
                  <InlineTitle card={c} canWrite={canWrite} />
                </td>
                <td className="px-3 py-2">
                  <ListSelect card={c} canWrite={canWrite} />
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {c.labelIds.map((lid) => {
                      const l = s.labels.find((x) => x.id === lid);
                      return l ? (
                        <span key={lid} title={l.name} className="h-3 w-8 rounded-full" style={{ background: l.color }} />
                      ) : null;
                    })}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <div className="flex -space-x-1">
                    {c.memberIds.map((uid) => {
                      const m = s.members.find((x) => x.id === uid);
                      return m ? <Avatar key={uid} name={m.name} color={m.avatarColor} size={22} /> : null;
                    })}
                  </div>
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {c.dueAt ? (
                    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${dueTone(c)}`}>{fmtDue(c.dueAt)}</span>
                  ) : (
                    <span className="opacity-30">—</span>
                  )}
                </td>
                {s.customFieldDefs.map((d) => (
                  <td key={d.id} className="whitespace-nowrap px-3 py-2 text-xs">
                    <FieldValueInline def={d} value={c.fieldValues[d.id]} />
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5 + s.customFieldDefs.length} className="p-6 text-center text-sm opacity-50">
                  No cards match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function InlineTitle({ card, canWrite }: { card: Card; canWrite: boolean }) {
  const s = useBoard();
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(card.title);
  if (!editing) {
    return (
      <span
        className="block truncate font-medium"
        onDoubleClick={(e) => {
          if (!canWrite) return;
          e.stopPropagation();
          setV(card.title);
          setEditing(true);
        }}
        title="Double-click to edit inline"
      >
        {card.title}
      </span>
    );
  }
  return (
    <input
      className="input !py-0.5 text-sm"
      value={v}
      autoFocus
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setV(e.target.value)}
      onBlur={async () => {
        if (v.trim() && v !== card.title) {
          s.patchCard(card.id, { title: v.trim() });
          await api.patch(`/api/cards/${card.id}`, { title: v.trim() });
        }
        setEditing(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setEditing(false);
      }}
    />
  );
}

function ListSelect({ card, canWrite }: { card: Card; canWrite: boolean }) {
  const s = useBoard();
  if (!canWrite) return <>{s.lists.find((l) => l.id === card.listId)?.name ?? "?"}</>;
  return (
    <select
      className="rounded border border-transparent bg-transparent py-0.5 text-sm outline-none hover:border-rule dark:hover:border-ink-3"
      value={card.listId}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => s.moveCard(card.id, e.target.value, null, null)}
    >
      {s.lists.filter((l) => !l.archived).map((l) => (
        <option key={l.id} value={l.id}>{l.name}</option>
      ))}
    </select>
  );
}
