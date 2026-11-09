/**
 * Right-hand pane of the card modal: "Comments and activity". One feed,
 * newest first; the per-card activity log (already returned by
 * GET /api/cards/:id) is interleaved when "Show details" is on.
 */
import { useState } from "react";
import { api } from "../lib/api";
import type { CardDetail, Comment } from "../lib/types";
import { Avatar } from "./Chrome";
import { BotIcon, MessageIcon } from "./icons";

type Activity = CardDetail["activity"][number];
type FeedItem =
  | { kind: "comment"; at: number; id: string; c: Comment }
  | { kind: "activity"; at: number; id: string; a: Activity };

const AUTOMATION_COLOR = "#838c91";

export default function CardActivity({
  cardId, comments, activity, canWrite, onPosted,
}: {
  cardId: string;
  comments: Comment[];
  activity: Activity[];
  canWrite: boolean;
  onPosted: () => void;
}) {
  const [details, setDetails] = useState(false);

  const feed: FeedItem[] = [
    ...comments.map((c): FeedItem => ({ kind: "comment", at: +new Date(c.createdAt), id: `c-${c.id}`, c })),
    // "commented" entries duplicate the comment itself, so they are dropped
    ...(details
      ? activity.filter((a) => a.type !== "card.commented").map((a): FeedItem => ({ kind: "activity", at: +new Date(a.createdAt), id: `a-${a.id}`, a }))
      : []),
  ].sort((x, y) => y.at - x.at);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-[28px_1fr] items-center gap-x-1">
        <span className="flex h-6 items-center justify-center text-ink/70 dark:text-paper/70"><MessageIcon size={18} /></span>
        <div className="flex min-h-8 items-center gap-2">
          <h3 className="flex-1 text-[15px] font-semibold leading-tight">Comments and activity</h3>
          {activity.length > 0 && (
            <button className="btn-ghost !px-2.5 !py-1 text-xs bg-ink/6 dark:bg-paper/10" onClick={() => setDetails(!details)}>
              {details ? "Hide details" : "Show details"}
            </button>
          )}
        </div>
      </div>

      {canWrite && <CommentBox cardId={cardId} onPosted={onPosted} />}

      {feed.length === 0 && (
        <p className="pl-[32px] text-sm opacity-50">{canWrite ? "No comments yet." : "No comments."}</p>
      )}

      <ul className="space-y-3">
        {feed.map((item) =>
          item.kind === "comment" ? <CommentRow key={item.id} c={item.c} /> : <ActivityRow key={item.id} a={item.a} />,
        )}
      </ul>
    </div>
  );
}

function Who({ name, color }: { name: string | null; color: string | null }) {
  if (!name) {
    return (
      <span
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white"
        style={{ background: AUTOMATION_COLOR }}
        title="Automation"
      >
        <BotIcon size={15} />
      </span>
    );
  }
  return <Avatar name={name} color={color ?? AUTOMATION_COLOR} size={28} />;
}

function Stamp({ iso }: { iso: string }) {
  const d = new Date(iso);
  return (
    <time dateTime={iso} title={d.toLocaleString()} className="text-xs text-ink/50 hover:underline dark:text-paper/50">
      {relative(d)}
    </time>
  );
}

function CommentRow({ c }: { c: Comment }) {
  return (
    <li className="flex gap-2">
      <Who name={c.userName} color={c.avatarColor} />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-7"><span className="font-semibold">{c.userName ?? "Automation"}</span></p>
        <div className="whitespace-pre-wrap rounded-lg border border-rule bg-white px-3 py-2 text-sm shadow-[0_1px_1px_rgb(0_0_0/0.04)] dark:border-ink-3 dark:bg-ink-2">
          {c.body}
        </div>
        <p className="mt-1"><Stamp iso={c.createdAt} /></p>
      </div>
    </li>
  );
}

function ActivityRow({ a }: { a: Activity }) {
  return (
    <li className="flex gap-2">
      <Who name={a.userName} color={null} />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-7">
          <span className="font-semibold">{a.userName ?? "Automation"}</span> {describeActivity(a.type, a.data)}
        </p>
        <p className="-mt-1"><Stamp iso={a.createdAt} /></p>
      </div>
    </li>
  );
}

function CommentBox({ cardId, onPosted }: { cardId: string; onPosted: () => void }) {
  const [v, setV] = useState("");
  const [focus, setFocus] = useState(false);
  return (
    <form
      className="pl-[32px]"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!v.trim()) return;
        await api.post(`/api/cards/${cardId}/comments`, { body: v.trim() });
        setV("");
        onPosted();
      }}
    >
      <textarea
        className="input resize-none rounded-lg text-sm shadow-[0_1px_1px_rgb(0_0_0/0.04)]"
        rows={focus || v ? 3 : 1}
        placeholder="Write a comment…"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.currentTarget.form as HTMLFormElement).requestSubmit();
        }}
      />
      {(focus || v.trim()) && (
        <div className="mt-1.5 flex items-center gap-2">
          <button className="btn-accent !py-1 text-xs" disabled={!v.trim()}>Save</button>
          <span className="text-[11px] opacity-40">Ctrl/⌘+Enter to post</span>
        </div>
      )}
    </form>
  );
}

function relative(d: Date): string {
  const diff = Date.now() - d.getTime();
  const m = Math.round(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const days = Math.round(h / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" })
    + ", " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function describeActivity(type: string, data: Record<string, unknown>): string {
  switch (type) {
    case "card.created": return `added this card to ${data.list}`;
    case "card.moved": return `moved this card from ${data.from} to ${data.to}`;
    case "card.commented": return "commented";
    case "card.attached": return `attached ${data.filename}`;
    case "card.dueSet": return "set the due date";
    case "card.dueCleared": return "removed the due date";
    case "card.archived": return "archived this card";
    case "card.restored": return "restored this card";
    case "card.blockedBy": return `linked a dependency with "${data.title}"`;
    case "card.mirrored": return "mirrored this card to another board";
    case "automation.moved": return `automation "${data.rule}" moved this card to ${data.to}`;
    default: return type.replace(/[._]/g, " ");
  }
}
