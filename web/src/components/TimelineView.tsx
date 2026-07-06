import { useMemo } from "react";
import { Link } from "react-router-dom";
import { matchesFilter, useBoard } from "../stores/board";

const DAY = 86400_000;
const PX_PER_DAY = 34;

/** Gantt-style lane per list; bars span startAt→dueAt (due-only cards get a 1-day bar) */
export default function TimelineView() {
  const s = useBoard();

  const dated = s.cards.filter(
    (c) => !c.archived && (c.dueAt || c.startAt) && matchesFilter(c, s.filter),
  );

  const range = useMemo(() => {
    if (!dated.length) return null;
    let min = Infinity;
    let max = -Infinity;
    for (const c of dated) {
      const start = Date.parse(c.startAt ?? c.dueAt!);
      const end = Date.parse(c.dueAt ?? c.startAt!);
      min = Math.min(min, start, end);
      max = Math.max(max, start, end);
    }
    const from = startOfDay(new Date(min - 2 * DAY));
    const to = startOfDay(new Date(max + 3 * DAY));
    return { from, days: Math.max(7, Math.round((to.getTime() - from.getTime()) / DAY)) };
  }, [dated]);

  if (!range) {
    return (
      <div className="p-6">
        <div className="rounded-card bg-paper/97 p-8 text-center text-sm opacity-70 shadow-card dark:bg-ink-2/97">
          Timeline plots cards with a start or due date — none yet.
        </div>
      </div>
    );
  }

  const days = Array.from({ length: range.days }, (_, i) => new Date(range.from.getTime() + i * DAY));
  const todayX = ((startOfDay(new Date()).getTime() - range.from.getTime()) / DAY) * PX_PER_DAY;
  const lanes = s.lists.filter((l) => !l.archived);

  return (
    <div className="p-3">
      <div className="board-scroll overflow-x-auto rounded-card bg-paper/97 shadow-card dark:bg-ink-2/97">
        <div className="relative" style={{ minWidth: 176 + range.days * PX_PER_DAY }}>
          {/* header */}
          <div className="sticky top-0 z-10 flex border-b border-rule bg-paper dark:border-ink-3 dark:bg-ink-2">
            <div className="w-44 shrink-0 border-r border-rule px-3 py-2 text-xs font-semibold uppercase tracking-wide opacity-60 dark:border-ink-3">
              List
            </div>
            {days.map((d, i) => (
              <div
                key={i}
                className={`shrink-0 border-r border-rule/40 py-2 text-center text-[10px] dark:border-ink-3/40 ${
                  d.getDay() === 0 || d.getDay() === 6 ? "opacity-40" : "opacity-70"
                }`}
                style={{ width: PX_PER_DAY }}
              >
                {d.getDate() === 1 || i === 0
                  ? d.toLocaleDateString(undefined, { month: "short" })
                  : d.getDate()}
              </div>
            ))}
          </div>

          {/* today marker */}
          {todayX >= 0 && todayX <= range.days * PX_PER_DAY && (
            <div className="absolute bottom-0 top-9 z-10 w-px bg-accent" style={{ left: 176 + todayX }} />
          )}

          {/* lanes */}
          {lanes.map((list) => {
            const cards = dated
              .filter((c) => c.listId === list.id)
              .sort((a, b) => Date.parse(a.startAt ?? a.dueAt!) - Date.parse(b.startAt ?? b.dueAt!));
            return (
              <div key={list.id} className="flex border-b border-rule/60 dark:border-ink-3/60">
                <div className="w-44 shrink-0 border-r border-rule px-3 py-2 text-sm font-medium dark:border-ink-3">
                  {list.name}
                  <span className="ml-1.5 text-xs opacity-40">{cards.length}</span>
                </div>
                <div className="relative flex-1 py-1.5" style={{ minHeight: cards.length ? cards.length * 30 + 8 : 38 }}>
                  {cards.map((c, row) => {
                    const start = startOfDay(new Date(c.startAt ?? c.dueAt!)).getTime();
                    const end = startOfDay(new Date(c.dueAt ?? c.startAt!)).getTime();
                    const x = ((start - range.from.getTime()) / DAY) * PX_PER_DAY;
                    const w = Math.max(PX_PER_DAY, ((end - start) / DAY + 1) * PX_PER_DAY - 4);
                    const overdue = !c.dueComplete && c.dueAt && Date.parse(c.dueAt) < Date.now();
                    return (
                      <Link
                        key={c.id}
                        to={`/b/${c.boardId}/c/${c.id}`}
                        className={`absolute block h-6 truncate rounded-full px-2.5 text-xs font-medium leading-6 text-white shadow-sm transition-transform hover:scale-[1.02] ${
                          c.dueComplete ? "bg-[#519839]" : overdue ? "bg-[#b03a37]" : "bg-[#2c5a8f] dark:bg-[#3a72b0]"
                        }`}
                        style={{ left: x, width: w, top: 6 + row * 30 }}
                        title={c.title}
                      >
                        {c.title}
                      </Link>
                    );
                  })}
                  {cards.length === 0 && <div className="h-6" />}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <p className="mt-2 px-1 text-xs text-white/70">
        Bars span start → due. Cards with only a due date show as single-day bars. Green = done, red = overdue.
      </p>
    </div>
  );
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
