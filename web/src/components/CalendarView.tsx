import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useBoard } from "../stores/board";
import { dueTone } from "./CardChip";

/** month calendar keyed on card due dates; drag a card to a day to re-due it */
export default function CalendarView() {
  const s = useBoard();
  const canWrite = !!s.myAccess?.canWrite;
  const [anchor, setAnchor] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [dragId, setDragId] = useState<string | null>(null);

  const weeks = useMemo(() => {
    const first = new Date(anchor);
    const start = new Date(first);
    start.setDate(1 - ((first.getDay() + 6) % 7)); // Monday-start grid
    const out: Date[][] = [];
    const cur = new Date(start);
    do {
      const week: Date[] = [];
      for (let i = 0; i < 7; i++) {
        week.push(new Date(cur));
        cur.setDate(cur.getDate() + 1);
      }
      out.push(week);
    } while (cur.getMonth() === anchor.getMonth());
    return out;
  }, [anchor]);

  const byDay = useMemo(() => {
    const m = new Map<string, typeof s.cards>();
    for (const c of s.cards) {
      if (c.archived || !c.dueAt) continue;
      const key = dayKey(new Date(c.dueAt));
      const arr = m.get(key) ?? [];
      arr.push(c);
      m.set(key, arr);
    }
    return m;
  }, [s.cards]);

  const today = dayKey(new Date());

  return (
    <div className="p-3">
      <div className="rounded-card bg-paper/97 p-3 shadow-card dark:bg-ink-2/97">
        <div className="mb-2 flex items-center gap-2">
          <button className="btn-ghost !py-1" onClick={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1))}>←</button>
          <h2 className="font-display text-base font-bold">
            {anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
          </h2>
          <button className="btn-ghost !py-1" onClick={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1))}>→</button>
          <button className="btn-ghost ml-auto !py-1 text-xs" onClick={() => setAnchor(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>
            Today
          </button>
          <span className="text-xs opacity-50">cards without due dates don't appear — drag to reschedule</span>
        </div>
        <div className="grid grid-cols-7 gap-px overflow-hidden rounded-md bg-rule text-xs dark:bg-ink-3">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
            <div key={d} className="bg-paper px-2 py-1 font-semibold uppercase tracking-wide opacity-60 dark:bg-ink-2">
              {d}
            </div>
          ))}
          {weeks.flat().map((day) => {
            const key = dayKey(day);
            const inMonth = day.getMonth() === anchor.getMonth();
            const cards = byDay.get(key) ?? [];
            return (
              <div
                key={key}
                className={`min-h-24 bg-paper p-1.5 dark:bg-ink-2 ${inMonth ? "" : "opacity-40"} ${dragId ? "outline-dashed outline-1 -outline-offset-2 outline-ink/20 dark:outline-paper/20" : ""}`}
                onDragOver={(e) => canWrite && e.preventDefault()}
                onDrop={async (e) => {
                  e.preventDefault();
                  if (!dragId || !canWrite) return;
                  const card = s.cards.find((c) => c.id === dragId);
                  const prev = card?.dueAt ? new Date(card.dueAt) : null;
                  const due = new Date(day);
                  due.setHours(prev?.getHours() ?? 17, prev?.getMinutes() ?? 0, 0, 0);
                  s.patchCard(dragId, { dueAt: due.toISOString() });
                  await api.patch(`/api/cards/${dragId}`, { dueAt: due.toISOString() });
                  setDragId(null);
                }}
              >
                <span className={`inline-block rounded px-1 font-semibold ${key === today ? "bg-accent text-ink" : ""}`}>
                  {day.getDate()}
                </span>
                <div className="mt-1 space-y-1">
                  {cards.map((c) => (
                    <Link
                      key={c.id}
                      to={`/b/${c.boardId}/c/${c.id}`}
                      draggable={canWrite}
                      onDragStart={() => setDragId(c.id)}
                      onDragEnd={() => setDragId(null)}
                      className={`block truncate rounded px-1.5 py-1 leading-tight shadow-sm ${dueTone(c) || "bg-white dark:bg-ink-3"}`}
                      title={c.title}
                    >
                      {c.title}
                    </Link>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
