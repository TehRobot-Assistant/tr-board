import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { usePopover } from "./Chrome";

type Results = {
  boards: Array<{ id: string; name: string; background: string }>;
  cards: Array<{
    id: string; title: string; boardId: string; boardName: string; listName: string;
    dueAt: string | null; dueComplete: boolean;
  }>;
};

/** cross-board search — permission-scoped server-side */
export default function GlobalSearch({ transparent }: { transparent?: boolean }) {
  const { open, setOpen, ref } = usePopover();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Results | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);

  // debounce
  useEffect(() => {
    clearTimeout(timer.current);
    if (q.trim().length < 2) {
      setResults(null);
      return;
    }
    timer.current = setTimeout(async () => {
      try {
        setResults(await api.get<Results>(`/api/search?q=${encodeURIComponent(q.trim())}`));
      } catch {
        setResults(null);
      }
    }, 200);
    return () => clearTimeout(timer.current);
  }, [q]);

  // "/" focuses search from anywhere
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA") {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [setOpen]);

  const hasResults = !!results && (results.boards.length > 0 || results.cards.length > 0);

  return (
    <div className="relative hidden sm:block" ref={ref}>
      <input
        ref={inputRef}
        className={`w-44 rounded-md px-2.5 py-1 text-sm outline-none transition-all focus:w-64 ${
          transparent
            ? "bg-white/15 text-white placeholder:text-white/50 focus:bg-white/25"
            : "border border-rule bg-white text-ink dark:border-ink-3 dark:bg-ink-2 dark:text-paper"
        }`}
        placeholder="Search  /"
        value={q}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onKeyDown={(e) => e.key === "Escape" && ((e.target as HTMLInputElement).blur(), setOpen(false))}
      />
      {open && q.trim().length >= 2 && (
        <div className="menu-panel absolute right-0 top-full z-50 mt-1 max-h-[70vh] w-80 overflow-y-auto text-ink dark:text-paper">
          {!hasResults && <p className="p-2 text-sm opacity-60">No matches.</p>}
          {results && results.boards.length > 0 && (
            <>
              <p className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide opacity-50">Boards</p>
              {results.boards.map((b) => (
                <Link
                  key={b.id}
                  to={`/b/${b.id}`}
                  onClick={() => { setOpen(false); setQ(""); }}
                  className="flex items-center gap-2 rounded-md p-2 text-sm hover:bg-ink/5 dark:hover:bg-paper/10"
                >
                  <span className={`bg-board-${b.background} h-5 w-7 rounded`} />
                  <span className="font-medium">{b.name}</span>
                </Link>
              ))}
            </>
          )}
          {results && results.cards.length > 0 && (
            <>
              <p className="px-1 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide opacity-50">Cards</p>
              {results.cards.map((c) => (
                <Link
                  key={c.id}
                  to={`/b/${c.boardId}/c/${c.id}`}
                  onClick={() => { setOpen(false); setQ(""); }}
                  className="block rounded-md p-2 text-sm hover:bg-ink/5 dark:hover:bg-paper/10"
                >
                  <p className="leading-snug">{c.title}</p>
                  <p className="text-xs opacity-50">
                    {c.boardName} · {c.listName}
                    {c.dueAt && ` · due ${new Date(c.dueAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`}
                  </p>
                </Link>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
