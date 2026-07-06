import { useMemo } from "react";
import { matchesFilter, useBoard } from "../stores/board";
import { Avatar } from "./Chrome";

/** Trello Premium's Dashboard view — counts, bar charts, due-health donut */
export default function DashboardView() {
  const s = useBoard();
  const cards = useMemo(
    () => s.cards.filter((c) => !c.archived && matchesFilter(c, s.filter)),
    [s.cards, s.filter],
  );

  const perList = s.lists
    .filter((l) => !l.archived)
    .map((l) => ({ key: l.id, label: l.name, color: "#2c5a8f", n: cards.filter((c) => c.listId === l.id).length }));

  const perLabel = s.labels
    .map((l) => ({ key: l.id, label: l.name || l.color, color: l.color, n: cards.filter((c) => c.labelIds.includes(l.id)).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);

  const perMember = s.members
    .map((m) => ({ key: m.id, label: m.name, avatar: m, n: cards.filter((c) => c.memberIds.includes(m.id)).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);
  const unassigned = cards.filter((c) => c.memberIds.length === 0).length;

  const now = Date.now();
  const due = {
    done: cards.filter((c) => c.dueAt && c.dueComplete).length,
    overdue: cards.filter((c) => c.dueAt && !c.dueComplete && Date.parse(c.dueAt) < now).length,
    upcoming: cards.filter((c) => c.dueAt && !c.dueComplete && Date.parse(c.dueAt) >= now).length,
    none: cards.filter((c) => !c.dueAt).length,
  };

  return (
    <div className="grid gap-3 p-3 lg:grid-cols-2">
      <Panel title={`Cards per list · ${cards.length} total`}>
        <Bars data={perList} />
      </Panel>

      <Panel title="Due date health">
        <div className="flex items-center gap-6">
          <Donut
            segments={[
              { n: due.done, color: "#519839", label: "Complete" },
              { n: due.overdue, color: "#b03a37", label: "Overdue" },
              { n: due.upcoming, color: "#d9a21b", label: "Upcoming" },
              { n: due.none, color: "#9aa0ad", label: "No due date" },
            ]}
          />
          <ul className="space-y-1.5 text-sm">
            {[
              ["Complete", due.done, "#519839"],
              ["Overdue", due.overdue, "#b03a37"],
              ["Upcoming", due.upcoming, "#d9a21b"],
              ["No due date", due.none, "#9aa0ad"],
            ].map(([label, n, color]) => (
              <li key={String(label)} className="flex items-center gap-2">
                <span className="h-3 w-3 rounded-sm" style={{ background: String(color) }} />
                {label}
                <span className="font-semibold">{Number(n)}</span>
              </li>
            ))}
          </ul>
        </div>
      </Panel>

      <Panel title="Cards per label">
        {perLabel.length ? <Bars data={perLabel} /> : <Empty text="No labelled cards yet." />}
      </Panel>

      <Panel title="Cards per member">
        {perMember.length || unassigned ? (
          <div className="space-y-2">
            {perMember.map((m) => (
              <div key={m.key} className="flex items-center gap-2">
                <Avatar name={m.avatar.name} color={m.avatar.avatarColor} size={22} />
                <span className="w-28 truncate text-sm">{m.label}</span>
                <div className="h-4 flex-1 overflow-hidden rounded bg-ink/8 dark:bg-paper/10">
                  <div
                    className="h-full rounded"
                    style={{
                      background: m.avatar.avatarColor,
                      width: `${(m.n / Math.max(...perMember.map((x) => x.n))) * 100}%`,
                    }}
                  />
                </div>
                <span className="w-6 text-right text-sm font-semibold">{m.n}</span>
              </div>
            ))}
            {unassigned > 0 && (
              <p className="text-xs opacity-60">+ {unassigned} unassigned card{unassigned === 1 ? "" : "s"}</p>
            )}
          </div>
        ) : (
          <Empty text="No cards assigned yet." />
        )}
      </Panel>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-card bg-paper/97 p-4 shadow-card dark:bg-ink-2/97">
      <h2 className="mb-3 text-xs font-medium uppercase tracking-wide opacity-50">{title}</h2>
      {children}
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="py-6 text-center text-sm opacity-50">{text}</p>;
}

function Bars({ data }: { data: Array<{ key: string; label: string; color: string; n: number }> }) {
  const max = Math.max(1, ...data.map((d) => d.n));
  return (
    <div className="space-y-2">
      {data.map((d) => (
        <div key={d.key} className="flex items-center gap-2">
          <span className="w-28 truncate text-sm" title={d.label}>{d.label}</span>
          <div className="h-4 flex-1 overflow-hidden rounded bg-ink/8 dark:bg-paper/10">
            <div className="h-full rounded transition-all" style={{ background: d.color, width: `${(d.n / max) * 100}%` }} />
          </div>
          <span className="w-6 text-right text-sm font-semibold">{d.n}</span>
        </div>
      ))}
    </div>
  );
}

function Donut({ segments }: { segments: Array<{ n: number; color: string; label: string }> }) {
  const total = Math.max(1, segments.reduce((a, s) => a + s.n, 0));
  const R = 42;
  const C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <svg width="120" height="120" viewBox="0 0 120 120" className="-rotate-90">
      <circle cx="60" cy="60" r={R} fill="none" stroke="currentColor" strokeOpacity="0.08" strokeWidth="16" />
      {segments.map((seg, i) => {
        const frac = seg.n / total;
        const dash = `${frac * C} ${C}`;
        const el = (
          <circle
            key={i}
            cx="60" cy="60" r={R} fill="none"
            stroke={seg.color} strokeWidth="16"
            strokeDasharray={dash}
            strokeDashoffset={-offset * C}
          >
            <title>{`${seg.label}: ${seg.n}`}</title>
          </circle>
        );
        offset += frac;
        return el;
      })}
    </svg>
  );
}
