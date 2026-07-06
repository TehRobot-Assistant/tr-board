import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useBoard } from "../stores/board";
import { TopBar, Avatar, usePopover } from "../components/Chrome";
import KanbanView from "../components/KanbanView";
import TableView from "../components/TableView";
import CalendarView from "../components/CalendarView";
import TimelineView from "../components/TimelineView";
import BoardMenu from "../components/BoardMenu";
import CardModal from "../components/CardModal";

const BG: Record<string, string> = {
  navy: "bg-board-navy", sky: "bg-board-sky", teal: "bg-board-teal",
  forest: "bg-board-forest", amber: "bg-board-amber", crimson: "bg-board-crimson",
  plum: "bg-board-plum", slate: "bg-board-slate", ink: "bg-board-ink",
};

type ViewKind = "board" | "table" | "calendar" | "timeline";

export default function BoardPage() {
  const { boardId, cardId } = useParams<{ boardId: string; cardId?: string }>();
  const nav = useNavigate();
  const { user } = useAuth();
  const s = useBoard();
  const [view, setView] = useState<ViewKind>("board");
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (boardId) s.load(boardId);
    return () => useBoard.getState().clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId]);

  if (s.error) {
    return (
      <div className="flex h-full flex-col">
        <TopBar />
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <p className="text-sm opacity-70">{s.error}</p>
          <Link to="/" className="btn-ink">Back to workspaces</Link>
        </div>
      </div>
    );
  }
  if (!s.board) {
    return (
      <div className="flex h-full flex-col">
        <TopBar />
        <p className="p-6 text-sm opacity-60">Loading board…</p>
      </div>
    );
  }

  const board = s.board;
  const canWrite = !!s.myAccess?.canWrite;
  const mine = s.members.find((m) => m.id === user?.id);

  return (
    <div className={`flex h-full flex-col ${BG[board.background] ?? "bg-board-navy"}`}>
      <TopBar transparent />
      <div className="flex h-11 shrink-0 items-center gap-2 bg-black/20 px-3 text-white backdrop-blur-sm">
        <BoardName board={board} canRename={canWrite} />
        <button
          title={mine?.starred ? "Unstar" : "Star"}
          className="btn-ghost !px-1.5 !py-1 !text-white/80 hover:!bg-white/15"
          onClick={async () => {
            await api.put(`/api/boards/${board.id}/star`, { starred: !mine?.starred });
            s.load(board.id);
          }}
        >
          {mine?.starred ? "★" : "☆"}
        </button>
        <span className="rounded bg-white/15 px-2 py-0.5 text-[11px] uppercase tracking-wide">
          {board.visibility}
        </span>

        <nav className="ml-3 flex gap-0.5 rounded-md bg-black/20 p-0.5">
          {(["board", "table", "calendar", "timeline"] as const).map((v) => (
            <button
              key={v}
              className={`rounded px-2.5 py-1 text-xs font-medium capitalize transition-colors ${
                view === v ? "bg-white text-ink" : "text-white/80 hover:bg-white/15"
              }`}
              onClick={() => setView(v)}
            >
              {v}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex items-center -space-x-1.5">
          {s.members.slice(0, 6).map((m) => (
            <Avatar key={m.id} name={m.name} color={m.avatarColor} size={26} title={`${m.name} (${m.role})`} />
          ))}
          {s.members.length > 6 && (
            <span className="flex h-[26px] items-center rounded-full bg-white/20 px-2 text-xs">+{s.members.length - 6}</span>
          )}
        </div>
        {!s.myAccess?.role && s.board.visibility === "workspace" && (
          <button
            className="btn-accent !py-1 text-xs"
            onClick={async () => { await api.post(`/api/boards/${board.id}/join`); s.load(board.id); }}
          >
            Join board
          </button>
        )}
        <button className="btn-ghost !py-1 !text-white/85 hover:!bg-white/15 text-xs" onClick={() => setMenuOpen(true)}>
          ⋯ Menu
        </button>
      </div>

      <div className="board-scroll min-h-0 flex-1 overflow-auto">
        {view === "board" && <KanbanView />}
        {view === "table" && <TableView />}
        {view === "calendar" && <CalendarView />}
        {view === "timeline" && <TimelineView />}
      </div>

      {menuOpen && <BoardMenu onClose={() => setMenuOpen(false)} />}
      {cardId && (
        <CardModal cardId={cardId} onClose={() => nav(`/b/${board.id}`)} />
      )}
    </div>
  );
}

function BoardName({ board, canRename }: { board: { id: string; name: string }; canRename: boolean }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(board.name);
  useEffect(() => setName(board.name), [board.name]);

  if (!editing) {
    return (
      <button
        className="font-display text-base font-bold"
        onClick={() => canRename && setEditing(true)}
        title={canRename ? "Rename board" : undefined}
      >
        {board.name}
      </button>
    );
  }
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (name.trim() && name !== board.name) {
          await api.patch(`/api/boards/${board.id}`, { name: name.trim() });
          useBoard.setState((s) => ({ board: s.board ? { ...s.board, name: name.trim() } : s.board }));
        }
        setEditing(false);
      }}
    >
      <input
        className="rounded bg-white/90 px-2 py-0.5 font-display text-base font-bold text-ink outline-none"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={(e) => (e.target.form as HTMLFormElement)?.requestSubmit()}
        autoFocus
        maxLength={120}
      />
    </form>
  );
}
