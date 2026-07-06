import { filterActive, useBoard } from "../stores/board";
import { Avatar, usePopover } from "./Chrome";

const DUE_OPTIONS: Array<[string, string]> = [
  ["any", "Any due date"],
  ["overdue", "Overdue"],
  ["today", "Due today"],
  ["week", "Due this week"],
  ["none", "No due date"],
  ["done", "Marked complete"],
];

export default function FilterButton() {
  const s = useBoard();
  const { open, setOpen, ref } = usePopover();
  const n = filterActive(s.filter);

  return (
    <div className="relative" ref={ref}>
      <button
        className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
          n ? "bg-accent text-ink" : "bg-black/20 text-white/80 hover:bg-white/15"
        }`}
        onClick={() => setOpen(!open)}
      >
        ⌕ Filter{n ? ` · ${n}` : ""}
      </button>
      {open && (
        <div className="menu-panel absolute right-0 top-full z-40 mt-1 w-72 text-ink dark:text-paper">
          <input
            className="input !py-1.5 text-sm"
            placeholder="Search card titles…"
            value={s.filter.text}
            onChange={(e) => s.setFilter({ text: e.target.value })}
            autoFocus
          />

          <p className="mt-3 text-[11px] font-medium uppercase tracking-wide opacity-50">Due</p>
          <select
            className="input mt-1 !py-1 text-sm"
            value={s.filter.due}
            onChange={(e) => s.setFilter({ due: e.target.value as any })}
          >
            {DUE_OPTIONS.map(([v, label]) => (
              <option key={v} value={v}>{label}</option>
            ))}
          </select>

          {s.labels.length > 0 && (
            <>
              <p className="mt-3 text-[11px] font-medium uppercase tracking-wide opacity-50">Labels</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {s.labels.map((l) => {
                  const onSel = s.filter.labelIds.includes(l.id);
                  return (
                    <button
                      key={l.id}
                      className={`rounded px-2 py-1 text-xs font-medium text-white transition-opacity ${onSel ? "" : "opacity-40 hover:opacity-70"}`}
                      style={{ background: l.color }}
                      onClick={() =>
                        s.setFilter({
                          labelIds: onSel
                            ? s.filter.labelIds.filter((x) => x !== l.id)
                            : [...s.filter.labelIds, l.id],
                        })
                      }
                    >
                      {l.name || l.color} {onSel && "✓"}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {s.members.length > 0 && (
            <>
              <p className="mt-3 text-[11px] font-medium uppercase tracking-wide opacity-50">Members</p>
              <div className="mt-1 space-y-0.5">
                {s.members.map((m) => {
                  const onSel = s.filter.memberIds.includes(m.id);
                  return (
                    <button
                      key={m.id}
                      className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm hover:bg-ink/5 dark:hover:bg-paper/10 ${onSel ? "bg-ink/8 dark:bg-paper/15" : ""}`}
                      onClick={() =>
                        s.setFilter({
                          memberIds: onSel
                            ? s.filter.memberIds.filter((x) => x !== m.id)
                            : [...s.filter.memberIds, m.id],
                        })
                      }
                    >
                      <Avatar name={m.name} color={m.avatarColor} size={22} />
                      <span className="flex-1">{m.name}</span>
                      {onSel && "✓"}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {n > 0 && (
            <button className="btn-ghost mt-3 w-full !py-1 text-xs" onClick={() => s.clearFilter()}>
              Clear all filters
            </button>
          )}
        </div>
      )}
    </div>
  );
}
