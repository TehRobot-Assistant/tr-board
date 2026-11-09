import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Logo } from "./Login";

type PublicBoard = {
  board: { name: string; background: string };
  lists: Array<{ id: string; name: string; rank: string }>;
  cards: Array<{
    id: string; listId: string; title: string; description: string; rank: string;
    dueAt: string | null; dueComplete: boolean; coverColor: string | null; labelIds: string[];
  }>;
  labels: Array<{ id: string; name: string; color: string }>;
};

const BG: Record<string, string> = {
  navy: "bg-board-navy", sky: "bg-board-sky", teal: "bg-board-teal",
  forest: "bg-board-forest", amber: "bg-board-amber", crimson: "bg-board-crimson",
  plum: "bg-board-plum", slate: "bg-board-slate", ink: "bg-board-ink",
};

/** unauthenticated read-only board view behind a share token */
export default function SharedBoard() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<PublicBoard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/public/boards/${token}`)
      .then(async (r) => {
        if (!r.ok) throw new Error("This share link is invalid or has been revoked.");
        setData(await r.json());
      })
      .catch((e) => setError(e.message));
  }, [token]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
        <Logo />
        <p className="text-sm opacity-70">{error}</p>
      </div>
    );
  }
  if (!data) return <div className="flex h-full items-center justify-center text-sm opacity-60">Loading…</div>;

  // id breaks rank ties, same as the board store (M9)
  const sorted = <T extends { rank: string; id: string }>(xs: T[]) =>
    [...xs].sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return (
    <div className={`flex h-full flex-col ${BG[data.board.background] ?? "bg-board-navy"}`}>
      <header className="flex h-12 shrink-0 items-center gap-2 bg-black/25 px-3 text-white backdrop-blur-sm">
        <Logo size={22} />
        <span className="font-display text-sm font-bold">{data.board.name}</span>
        <span className="ml-2 rounded bg-white/15 px-2 py-0.5 text-[11px] uppercase tracking-wide">
          read-only
        </span>
        <span className="ml-auto text-xs text-white/60">Shared from TR Board</span>
      </header>
      <div className="board-scroll min-h-0 flex-1 overflow-auto">
        <div className="flex h-full items-start gap-3 p-3">
          {sorted(data.lists).map((list) => {
            const cards = sorted(data.cards.filter((c) => c.listId === list.id));
            return (
              <div key={list.id} className="flex max-h-full w-72 shrink-0 flex-col rounded-card bg-paper-2/95 shadow-card dark:bg-ink-2/95">
                <p className="px-3.5 py-2 text-sm font-semibold">
                  {list.name} <span className="ml-1 text-xs font-normal opacity-50">{cards.length}</span>
                </p>
                <div className="board-scroll flex-1 space-y-2 overflow-y-auto px-2 pb-2">
                  {cards.map((c) => (
                    <div key={c.id} className="rounded-card bg-white p-2.5 text-sm shadow-card dark:bg-ink-3">
                      {c.coverColor && (
                        <div className="-mx-2.5 -mt-2.5 mb-2 h-8 rounded-t-card" style={{ background: c.coverColor }} />
                      )}
                      {c.labelIds.length > 0 && (
                        <div className="mb-1.5 flex flex-wrap gap-1">
                          {c.labelIds.map((lid) => {
                            const l = data.labels.find((x) => x.id === lid);
                            return l ? (
                              <span key={lid} title={l.name} className="h-2 min-w-8 rounded-full" style={{ background: l.color }} />
                            ) : null;
                          })}
                        </div>
                      )}
                      <p className="leading-snug">{c.title}</p>
                      {c.dueAt && (
                        <p className={`mt-1.5 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${
                          c.dueComplete ? "bg-[#519839] text-white"
                          : Date.parse(c.dueAt) < Date.now() ? "bg-[#b03a37] text-white"
                          : "bg-ink/10 dark:bg-paper/15"
                        }`}>
                          ⏱ {new Date(c.dueAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
                        </p>
                      )}
                    </div>
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
