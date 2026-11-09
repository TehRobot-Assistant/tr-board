import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { applyTheme, useAuth } from "../lib/auth";
import { getSocket } from "../lib/socket";
import { Logo } from "../pages/Login";
import GlobalSearch from "./GlobalSearch";

export function Avatar({
  name, color, size = 28, title,
}: { name: string; color: string; size?: number; title?: string }) {
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <span
      title={title ?? name}
      className="inline-flex shrink-0 select-none items-center justify-center rounded-full font-medium text-white"
      style={{ width: size, height: size, background: color, fontSize: size * 0.4 }}
    >
      {initials}
    </span>
  );
}

export function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return { open, setOpen, ref };
}

function NotificationsBell() {
  const qc = useQueryClient();
  const { open, setOpen, ref } = usePopover();
  const { data } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => api.get<{ notifications: Array<{ id: string; type: string; read: boolean; createdAt: string; data: any }> }>("/api/notifications"),
    refetchInterval: 60_000,
  });
  useEffect(() => {
    const s = getSocket();
    const fn = () => qc.invalidateQueries({ queryKey: ["notifications"] });
    s.on("notification", fn);
    s.on("connect", fn); // H4: catch up on notifications missed while disconnected
    return () => { s.off("notification", fn); s.off("connect", fn); };
  }, [qc]);

  const items = data?.notifications ?? [];
  const unread = items.filter((n) => !n.read).length;

  return (
    <div className="relative" ref={ref}>
      <button
        className="btn-ghost relative !px-2"
        onClick={async () => {
          setOpen(!open);
          if (!open && unread) {
            await api.post("/api/notifications/read", {});
            qc.invalidateQueries({ queryKey: ["notifications"] });
          }
        }}
        title="Notifications"
      >
        <BellIcon />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-ink">
            {unread}
          </span>
        )}
      </button>
      {open && (
        <div className="menu-panel absolute right-0 top-full z-50 mt-1 max-h-96 w-80 overflow-y-auto">
          {items.length === 0 && <p className="p-2 text-sm opacity-60">Nothing yet.</p>}
          {items.map((n) => (
            <Link
              key={n.id}
              to={n.data.boardId ? `/b/${n.data.boardId}${n.data.cardId ? `/c/${n.data.cardId}` : ""}` : "#"}
              onClick={() => setOpen(false)}
              className="block rounded-md p-2 text-sm hover:bg-ink/5 dark:hover:bg-paper/10"
            >
              <span className="font-medium">{n.data.rule ? `⚙ ${n.data.rule}` : n.type}</span>
              {n.data.cardTitle && <span className="opacity-70"> — {n.data.cardTitle}</span>}
              {n.data.text ? <p className="opacity-70">{String(n.data.text)}</p> : null}
              <p className="mt-0.5 text-xs opacity-40">{new Date(n.createdAt).toLocaleString()}</p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function TopBar({ transparent = false }: { transparent?: boolean }) {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const { open, setOpen, ref } = usePopover();
  if (!user) return null;

  return (
    <header
      className={`flex h-12 shrink-0 items-center gap-2 px-3 ${
        transparent
          ? "bg-black/25 text-white backdrop-blur-sm"
          : "border-b border-rule bg-paper dark:border-ink-3 dark:bg-ink"
      }`}
    >
      <Link to="/" className="flex items-center gap-2 font-display text-sm font-bold tracking-tight">
        <Logo size={24} />
        TR Board
      </Link>
      <div className="ml-auto flex items-center gap-1">
        <GlobalSearch transparent={transparent} />
        <Link
          to="/my-work"
          className={`btn-ghost !py-1 text-xs ${transparent ? "!text-white/85 hover:!bg-white/15" : ""}`}
        >
          My work
        </Link>
        {user.isAdmin && (
          <Link to="/admin" className={`btn-ghost !py-1 text-xs ${transparent ? "!text-white/85 hover:!bg-white/15" : ""}`}>
            Admin
          </Link>
        )}
        <NotificationsBell />
        <div className="relative" ref={ref}>
          <button onClick={() => setOpen(!open)} className="flex items-center">
            <Avatar name={user.name} color={user.avatarColor} size={30} />
          </button>
          {open && (
            <div className="menu-panel absolute right-0 top-full z-50 mt-1 w-64">
              <p className="px-2 pt-1 text-sm font-semibold">{user.name}</p>
              <p className="px-2 pb-2 text-xs opacity-60">{user.email}</p>
              <div className="border-t border-rule py-1 dark:border-ink-3">
                <p className="px-2 py-1 text-xs font-medium uppercase tracking-wide opacity-50">Theme</p>
                <div className="flex gap-1 px-2 pb-1">
                  {(["light", "dark", "system"] as const).map((t) => (
                    <button
                      key={t}
                      className="btn-ghost flex-1 !py-1 text-xs capitalize"
                      onClick={async () => {
                        applyTheme(t);
                        await api.patch("/api/auth/me", { theme: t });
                      }}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              <div className="border-t border-rule pt-1 dark:border-ink-3">
                <Link to="/account" className="btn-ghost w-full justify-start text-sm" onClick={() => setOpen(false)}>
                  Account settings
                </Link>
                <button
                  className="btn-ghost w-full justify-start text-sm"
                  onClick={async () => { await logout(); nav("/login"); }}
                >
                  Log out
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function BellIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}
