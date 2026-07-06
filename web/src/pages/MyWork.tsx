import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { TopBar } from "../components/Chrome";

type WorkCard = {
  id: string; title: string; boardId: string; boardName: string; listName: string;
  dueAt: string | null; dueComplete: boolean; background: string;
};
type WorkItem = {
  id: string; text: string; done: boolean; dueAt: string | null;
  cardId: string; cardTitle: string; boardId: string; boardName: string;
};
type Row =
  | { kind: "card"; due: number | null; card: WorkCard }
  | { kind: "item"; due: number | null; item: WorkItem };

const DAY = 86400_000;

/** Monday.com's "My Work" — everything assigned to me, across every board */
export default function MyWork() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["my-work"],
    queryFn: () => api.get<{ cards: WorkCard[]; checklistItems: WorkItem[] }>("/api/my-work"),
  });

  const groups = useMemo(() => {
    const rows: Row[] = [
      ...(data?.cards ?? []).map<Row>((card) => ({
        kind: "card", card, due: card.dueAt ? Date.parse(card.dueAt) : null,
      })),
      ...(data?.checklistItems ?? []).map<Row>((item) => ({
        kind: "item", item, due: item.dueAt ? Date.parse(item.dueAt) : null,
      })),
    ].sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity));

    const now = Date.now();
    const endToday = new Date();
    endToday.setHours(23, 59, 59, 999);
    const buckets: Array<{ title: string; test: (r: Row) => boolean }> = [
      { title: "Overdue", test: (r) => r.due !== null && r.due < now && !isDone(r) },
      { title: "Today", test: (r) => r.due !== null && r.due >= now && r.due <= endToday.getTime() },
      { title: "This week", test: (r) => r.due !== null && r.due > endToday.getTime() && r.due <= now + 7 * DAY },
      { title: "Later", test: (r) => r.due !== null && r.due > now + 7 * DAY },
      { title: "No due date", test: (r) => r.due === null },
      { title: "Done", test: () => true }, // catches completed overdue leftovers
    ];
    const used = new Set<Row>();
    return buckets
      .map(({ title }) => ({
        title,
        rows: rows.filter((r) => {
          if (used.has(r)) return false;
          const bucket = buckets.find((b) => b.test(r))!;
          if (bucket.title !== title) return false;
          used.add(r);
          return true;
        }),
      }))
      .filter((g) => g.rows.length > 0);
  }, [data]);

  const total = (data?.cards.length ?? 0) + (data?.checklistItems.length ?? 0);

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <main className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto p-6">
        <h1 className="font-display text-xl font-bold">My work</h1>
        <p className="mt-1 text-sm opacity-60">
          Every card and checklist item assigned to you, across all boards.
        </p>
        {isLoading && <p className="mt-4 text-sm opacity-60">Loading…</p>}
        {!isLoading && total === 0 && (
          <p className="mt-6 text-sm opacity-70">Nothing assigned to you. Enjoy it while it lasts.</p>
        )}

        {groups.map((g) => (
          <section key={g.title} className="mt-6">
            <h2 className={`text-xs font-medium uppercase tracking-wide ${g.title === "Overdue" ? "text-[#b03a37]" : "opacity-50"}`}>
              {g.title} · {g.rows.length}
            </h2>
            <ul className="mt-2 space-y-1.5">
              {g.rows.map((r) =>
                r.kind === "card" ? (
                  <CardRow key={`c${r.card.id}`} card={r.card} onToggled={() => qc.invalidateQueries({ queryKey: ["my-work"] })} />
                ) : (
                  <ItemRow key={`i${r.item.id}`} item={r.item} onToggled={() => qc.invalidateQueries({ queryKey: ["my-work"] })} />
                ),
              )}
            </ul>
          </section>
        ))}
      </main>
    </div>
  );
}

function isDone(r: Row): boolean {
  return r.kind === "card" ? r.card.dueComplete : r.item.done;
}

function DueChip({ dueAt, done }: { dueAt: string | null; done: boolean }) {
  if (!dueAt) return null;
  const t = Date.parse(dueAt);
  const cls = done
    ? "bg-[#519839] text-white"
    : t < Date.now()
      ? "bg-[#b03a37] text-white"
      : "bg-ink/10 dark:bg-paper/15";
  return (
    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${cls}`}>
      {new Date(dueAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
    </span>
  );
}

function CardRow({ card, onToggled }: { card: WorkCard; onToggled: () => void }) {
  return (
    <li className="flex items-center gap-2.5 rounded-card border border-rule bg-white p-2.5 dark:border-ink-3 dark:bg-ink-2">
      {card.dueAt && (
        <input
          type="checkbox"
          checked={card.dueComplete}
          title="Toggle due complete"
          onChange={async (e) => {
            await api.patch(`/api/cards/${card.id}`, { dueComplete: e.target.checked });
            onToggled();
          }}
        />
      )}
      <Link to={`/b/${card.boardId}/c/${card.id}`} className="min-w-0 flex-1">
        <p className={`truncate text-sm font-medium ${card.dueComplete ? "line-through opacity-50" : ""}`}>{card.title}</p>
        <p className="truncate text-xs opacity-50">{card.boardName} · {card.listName}</p>
      </Link>
      <DueChip dueAt={card.dueAt} done={card.dueComplete} />
    </li>
  );
}

function ItemRow({ item, onToggled }: { item: WorkItem; onToggled: () => void }) {
  return (
    <li className="flex items-center gap-2.5 rounded-card border border-rule bg-white p-2.5 dark:border-ink-3 dark:bg-ink-2">
      <input
        type="checkbox"
        checked={item.done}
        title="Mark done"
        onChange={async (e) => {
          await api.patch(`/api/checklist-items/${item.id}`, { done: e.target.checked });
          onToggled();
        }}
      />
      <Link to={`/b/${item.boardId}/c/${item.cardId}`} className="min-w-0 flex-1">
        <p className="truncate text-sm">☑ {item.text}</p>
        <p className="truncate text-xs opacity-50">{item.boardName} · {item.cardTitle}</p>
      </Link>
      <DueChip dueAt={item.dueAt} done={item.done} />
    </li>
  );
}
