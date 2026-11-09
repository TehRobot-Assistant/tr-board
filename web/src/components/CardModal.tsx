/**
 * Card detail modal. Layout: a thin header (list selector · cover · ⋯ · ✕),
 * then two panes from the `split` breakpoint up — content on the left,
 * "Comments and activity" on the right, each scrolling on its own. Below
 * `split` the panes stack and the whole modal scrolls.
 *
 * Panels/popovers live in CardModalActions.tsx, body sections in
 * CardModalSections.tsx, the comment feed in CardActivity.tsx.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { getSocket } from "../lib/socket";
import { useBoard } from "../stores/board";
import type { CardDetail } from "../lib/types";
import { Avatar } from "./Chrome";
import { dueTone, fmtDue } from "./CardChip";
import { describeRecurrence } from "../lib/recurrence";
import {
  ActionPop, AttachButton, CoverPanel, DuePanel, LabelsPanel, ListPanel, MembersPanel, MirrorPanel, Pop,
  RepeatPanel, Trigger, chipClass, iconBtnClass, menuRowClass,
} from "./CardModalActions";
import {
  AddChecklistChip, AttachmentsSection, ChecklistBlock, DependenciesSection, DescriptionSection, FieldEditor,
  Section, TitleEditor, sectionLabel,
} from "./CardModalSections";
import CardActivity from "./CardActivity";
import {
  ArchiveIcon, CheckCircleIcon, ChevronDownIcon, CircleIcon, ClockIcon, ImageIcon, LinkIcon, MirrorIcon,
  MoreIcon, PlusIcon, RepeatIcon, SlidersIcon, TagIcon, TrashIcon, UndoIcon, UserIcon, UsersIcon, XIcon,
} from "./icons";

/** board socket events that change what this modal shows; `card.updated` carries { card }, the rest { cardId } */
const LIVE_EVENTS = [
  "card.updated", "comment.created", "comment.updated", "comment.deleted", "attachment.created", "attachment.deleted",
  "checklist.created", "checklist.updated", "checklist.deleted", "checklistItem.created", "checklistItem.updated",
  "checklistItem.deleted", "card.labelAdded", "card.labelRemoved", "card.memberAdded", "card.memberRemoved", "card.fieldChanged",
];

export default function CardModal({ cardId, onClose }: { cardId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const s = useBoard();
  const canWrite = !!s.myAccess?.canWrite;
  const [showDeps, setShowDeps] = useState(false);

  const { data, error } = useQuery({
    queryKey: ["card", cardId],
    queryFn: () => api.get<CardDetail>(`/api/cards/${cardId}`),
  });
  const refetch = () => qc.invalidateQueries({ queryKey: ["card", cardId] });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      // an open popover takes the first Esc (usePopover closes it); the modal takes the next
      if (document.querySelector("[data-popover]")) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // live refresh while open: other users' edits to this card
  useEffect(() => {
    const socket = getSocket();
    const refresh = (p: { cardId?: string; card?: { id?: string } }) => {
      if ((p?.cardId ?? p?.card?.id) === cardId) qc.invalidateQueries({ queryKey: ["card", cardId] });
    };
    for (const ev of LIVE_EVENTS) socket.on(ev, refresh);
    return () => { for (const ev of LIVE_EVENTS) socket.off(ev, refresh); };
  }, [cardId, qc]);

  if (error) {
    return (
      <Shell onClose={onClose}>
        <div className="flex items-center justify-between border-b border-rule px-3 py-2 dark:border-ink-3">
          <span className="text-sm opacity-60">Card</span>
          <button className={iconBtnClass} onClick={onClose} title="Close"><XIcon size={18} /></button>
        </div>
        <p className="p-6 text-sm">Card not found.</p>
      </Shell>
    );
  }
  if (!data) {
    return (
      <Shell onClose={onClose}>
        <p className="p-6 text-sm opacity-60">Loading…</p>
      </Shell>
    );
  }

  const { card, checklists, comments, attachments, activity } = data;
  // the store copy is kept live by board socket events, so it is the freshest listId after a move
  const listId = s.cards.find((c) => c.id === cardId)?.listId ?? card.listId;
  const list = s.lists.find((l) => l.id === listId);
  const isMirror = !!card.mirrorOfCardId;
  const hasDates = !!(card.dueAt || card.startAt);

  const patchCard = async (patch: Record<string, unknown>) => {
    await api.patch(`/api/cards/${cardId}`, patch);
    s.patchCard(cardId, patch as any);
    refetch();
  };

  const hasCover = !!(card.coverColor || card.coverAttachmentId);

  return (
    <Shell onClose={onClose}>
      {hasCover && (
        <div
          className="h-28 shrink-0 rounded-t-xl bg-cover bg-center"
          style={
            card.coverAttachmentId
              ? { backgroundImage: `url(/api/attachments/${card.coverAttachmentId}/file)` }
              : { background: card.coverColor! }
          }
        />
      )}

      {/* ---------------------------------------------------------- header */}
      <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-rule px-3 dark:border-ink-3">
        {canWrite ? (
          <Pop width={240} trigger={(toggle, open) => <ListChip name={list?.name} onClick={toggle} open={open} />}>
            {(close) => <ListPanel card={{ id: cardId, listId }} close={close} />}
          </Pop>
        ) : (
          <ListChip name={list?.name} />
        )}
        {card.archived && (
          <span className="rounded-md bg-[#d9a21b] px-1.5 py-0.5 text-[11px] font-semibold text-ink">Archived</span>
        )}
        {isMirror && (
          <span className="inline-flex items-center gap-1 rounded-md bg-ink/8 px-1.5 py-0.5 text-[11px] font-medium dark:bg-paper/12" title="Read-only mirror of a card on another board">
            <MirrorIcon size={12} /> Mirror
          </span>
        )}

        <div className="ml-auto flex items-center gap-0.5">
          {canWrite && (
            <ActionPop variant="icon" icon={<ImageIcon size={18} />} label="Cover" width={240}>
              {(close) => <CoverPanel card={card} onSave={patchCard} close={close} />}
            </ActionPop>
          )}
          {canWrite && (
            <Pop width={240} trigger={(toggle) => <Trigger variant="icon" icon={<MoreIcon size={18} />} label="More actions" onClick={toggle} />}>
              {(close) => (
                <MenuBody
                  close={close}
                  items={[
                    ...(!isMirror ? [
                      { key: "repeat", icon: <RepeatIcon size={15} />, label: "Repeat", panel: (c: () => void) => <RepeatPanel card={{ ...card, listId }} onSave={patchCard} close={c} /> },
                      { key: "mirror", icon: <MirrorIcon size={15} />, label: "Mirror", panel: (c: () => void) => <MirrorPanel cardId={cardId} close={c} /> },
                      { key: "div1", divider: true as const },
                    ] : []),
                    card.archived
                      ? { key: "restore", icon: <UndoIcon size={15} />, label: "Restore", onClick: () => patchCard({ archived: false }) }
                      : { key: "archive", icon: <ArchiveIcon size={15} />, label: "Archive", onClick: () => patchCard({ archived: true }) },
                    ...(card.archived ? [{
                      key: "delete", icon: <TrashIcon size={15} />, label: "Delete forever", danger: true,
                      onClick: async () => {
                        if (!confirm("Delete this card forever?")) return;
                        await api.del(`/api/cards/${cardId}`);
                        onClose();
                      },
                    }] : []),
                  ]}
                />
              )}
            </Pop>
          )}
          <button className={iconBtnClass} onClick={onClose} title="Close (Esc)"><XIcon size={18} /></button>
        </div>
      </div>

      {/* ----------------------------------------------------------- panes */}
      <div className="flex min-h-0 flex-1 flex-col split:flex-row">
        {/* main pane */}
        <div className="min-w-0 flex-1 px-4 py-5 sm:px-6 split:basis-[58%] split:overflow-y-auto">
          {/* title row */}
          <div className="flex items-start gap-2">
            <button
              type="button"
              className={`mt-[3px] flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
                card.dueComplete ? "text-[#519839]" : "text-ink/35 hover:text-ink/70 dark:text-paper/35 dark:hover:text-paper/70"
              } disabled:cursor-default`}
              disabled={!canWrite}
              onClick={() => patchCard({ dueComplete: !card.dueComplete })}
              title={card.dueComplete ? "Mark incomplete" : "Mark complete"}
              aria-pressed={card.dueComplete}
            >
              {card.dueComplete ? <CheckCircleIcon size={22} /> : <CircleIcon size={22} />}
            </button>
            <TitleEditor title={card.title} canWrite={canWrite} onSave={(title) => patchCard({ title })} />
          </div>

          {/* action chips */}
          {canWrite && (
            <div className="mt-3 flex flex-wrap gap-1.5 pl-8">
              <Pop width={240} trigger={(toggle) => <Trigger variant="chip" icon={<PlusIcon size={15} />} label="Add" onClick={toggle} />}>
                {(close) => (
                  <MenuBody
                    close={close}
                    items={[
                      { key: "dep", icon: <LinkIcon size={15} />, label: "Dependency", onClick: () => setShowDeps(true) },
                      { key: "cover", icon: <ImageIcon size={15} />, label: "Cover", panel: (c: () => void) => <CoverPanel card={card} onSave={patchCard} close={c} /> },
                      ...(!isMirror ? [
                        { key: "repeat", icon: <RepeatIcon size={15} />, label: "Repeat", panel: (c: () => void) => <RepeatPanel card={{ ...card, listId }} onSave={patchCard} close={c} /> },
                        { key: "mirror", icon: <MirrorIcon size={15} />, label: "Mirror", panel: (c: () => void) => <MirrorPanel cardId={cardId} close={c} /> },
                      ] : []),
                    ]}
                  />
                )}
              </Pop>
              {card.labelIds.length === 0 && (
                <ActionPop variant="chip" icon={<TagIcon size={15} />} label="Labels">
                  {() => <LabelsPanel cardId={cardId} labelIds={card.labelIds} onChange={refetch} />}
                </ActionPop>
              )}
              {!hasDates && (
                <ActionPop variant="chip" icon={<ClockIcon size={15} />} label="Dates" width={260}>
                  {(close) => <DuePanel card={card} onSave={patchCard} close={close} />}
                </ActionPop>
              )}
              <AddChecklistChip cardId={cardId} onAdded={refetch} />
              {card.memberIds.length === 0 && (
                <ActionPop variant="chip" icon={<UserIcon size={15} />} label="Members">
                  {() => <MembersPanel cardId={cardId} memberIds={card.memberIds} onChange={refetch} />}
                </ActionPop>
              )}
              {attachments.length === 0 && <AttachButton cardId={cardId} onUploaded={refetch} variant="chip" />}
            </div>
          )}

          <div className="mt-6 space-y-7">
            {/* labels · members · dates: small-heading blocks on one row */}
            {(card.labelIds.length > 0 || card.memberIds.length > 0 || hasDates) && (
              <div className="flex flex-wrap gap-x-8 gap-y-4 pl-8">
                {card.labelIds.length > 0 && (
                  <div>
                    <p className={sectionLabel}>Labels</p>
                    <div className="flex flex-wrap items-center gap-1">
                      {card.labelIds.map((lid) => {
                        const l = s.labels.find((x) => x.id === lid);
                        return l ? (
                          <span key={lid} className="inline-flex h-8 min-w-12 items-center rounded-md px-3 text-xs font-semibold text-white" style={{ background: l.color }}>
                            {l.name}
                          </span>
                        ) : null;
                      })}
                      {canWrite && (
                        <ActionPop variant="square" icon={<TagIcon size={15} />} label="Add label">
                          {() => <LabelsPanel cardId={cardId} labelIds={card.labelIds} onChange={refetch} />}
                        </ActionPop>
                      )}
                    </div>
                  </div>
                )}
                {card.memberIds.length > 0 && (
                  <div>
                    <p className={sectionLabel}>Members</p>
                    <div className="flex items-center gap-1">
                      {card.memberIds.map((uid) => {
                        const m = s.members.find((x) => x.id === uid);
                        return m ? <Avatar key={uid} name={m.name} color={m.avatarColor} size={32} /> : null;
                      })}
                      {canWrite && (
                        <ActionPop variant="square" icon={<UsersIcon size={15} />} label="Add member">
                          {() => <MembersPanel cardId={cardId} memberIds={card.memberIds} onChange={refetch} />}
                        </ActionPop>
                      )}
                    </div>
                  </div>
                )}
                {hasDates && (
                  <div>
                    <p className={sectionLabel}>{card.startAt && card.dueAt ? "Dates" : card.dueAt ? "Due date" : "Start date"}</p>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <DatesChip
                        card={card}
                        canWrite={canWrite}
                        onSave={patchCard}
                      />
                      {card.recurrence && !isMirror && (
                        canWrite ? (
                          <ActionPop variant="chip" icon={<RepeatIcon size={14} />} label={describeRecurrence(card.recurrence)} title="Repeat settings" width={280}>
                            {(close) => <RepeatPanel card={{ ...card, listId }} onSave={patchCard} close={close} />}
                          </ActionPop>
                        ) : (
                          <span className={chipClass}><RepeatIcon size={14} /> {describeRecurrence(card.recurrence)}</span>
                        )
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* custom fields */}
            {s.customFieldDefs.length > 0 && (
              <Section icon={<SlidersIcon size={18} />} title="Custom fields">
                <div className="mt-1 grid gap-2 sm:grid-cols-2">
                  {s.customFieldDefs.map((def) => (
                    <FieldEditor
                      key={def.id}
                      def={def}
                      value={card.fieldValues[def.id]}
                      canWrite={canWrite}
                      onSave={async (value) => {
                        await api.put(`/api/cards/${cardId}/fields/${def.id}`, { value });
                        refetch();
                      }}
                    />
                  ))}
                </div>
              </Section>
            )}

            {(card.description || canWrite) && (
              <DescriptionSection value={card.description} canWrite={canWrite} onSave={(description) => patchCard({ description })} />
            )}

            {checklists.map((cl) => (
              <ChecklistBlock key={cl.id} checklist={cl} canWrite={canWrite} onChange={refetch} />
            ))}

            {attachments.length > 0 && (
              <AttachmentsSection
                cardId={cardId}
                attachments={attachments}
                coverAttachmentId={card.coverAttachmentId}
                canWrite={canWrite}
                onChange={refetch}
                onSetCover={(id) => patchCard({ coverAttachmentId: id, coverColor: null })}
              />
            )}

            <DependenciesSection cardId={cardId} canWrite={canWrite} forceShow={showDeps} onDismiss={() => setShowDeps(false)} />
          </div>
        </div>

        {/* comments + activity pane */}
        <aside className="min-w-0 rounded-b-xl border-t border-rule bg-paper-2/70 px-4 py-5 dark:border-ink-3 dark:bg-ink/60 split:basis-[42%] split:overflow-y-auto split:rounded-bl-none split:border-l split:border-t-0">
          <CardActivity cardId={cardId} comments={comments} activity={activity} canWrite={canWrite} onPosted={refetch} />
        </aside>
      </div>
    </Shell>
  );
}

/* ------------------------------------------------------------ scaffolding */

function Shell({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-2 sm:p-6"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="flex w-full max-w-[1120px] flex-col rounded-xl bg-paper text-ink shadow-drag dark:bg-ink-2 dark:text-paper split:h-[calc(100dvh-3rem)] split:overflow-hidden"
      >
        {children}
      </div>
    </div>
  );
}

function ListChip({ name, onClick, open }: { name?: string; onClick?: () => void; open?: boolean }) {
  const Tag = onClick ? "button" : "span";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      className={`${chipClass} max-w-[55vw] ${open ? "bg-ink/5 dark:bg-paper/10" : ""} ${onClick ? "" : "cursor-default hover:bg-transparent dark:hover:bg-transparent"}`}
      onClick={onClick}
      title={onClick ? "Move to another list" : undefined}
    >
      <span className="truncate">{name ?? "?"}</span>
      {onClick && <ChevronDownIcon size={14} className="shrink-0 opacity-60" />}
    </Tag>
  );
}

/** the date pill: due tone colour, opens the dates panel when writable */
function DatesChip({
  card, canWrite, onSave,
}: {
  card: { startAt: string | null; dueAt: string | null; dueComplete: boolean } & Parameters<typeof dueTone>[0];
  canWrite: boolean;
  onSave: (p: Record<string, unknown>) => void;
}) {
  const text = [
    card.startAt ? fmtDue(card.startAt) : null,
    card.dueAt ? new Date(card.dueAt).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : null,
  ].filter(Boolean).join(" – ");
  const tone = card.dueAt ? dueTone(card) : "bg-ink/10 dark:bg-paper/15";
  const status = card.dueAt
    ? card.dueComplete ? "Complete" : new Date(card.dueAt).getTime() < Date.now() ? "Overdue" : null
    : null;
  const inner = (
    <>
      <span>{text}</span>
      {status && <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${tone}`}>{status}</span>}
      {canWrite && <ChevronDownIcon size={14} className="opacity-60" />}
    </>
  );
  if (!canWrite) return <span className={chipClass}>{inner}</span>;
  return (
    <Pop width={260} trigger={(toggle) => <button type="button" className={chipClass} onClick={toggle} title="Change dates">{inner}</button>}>
      {(close) => <DuePanel card={card} onSave={onSave} close={close} />}
    </Pop>
  );
}

type MenuItem =
  | { key: string; divider: true }
  | { key: string; icon: ReactNode; label: string; danger?: boolean; onClick?: () => void | Promise<void>; panel?: (close: () => void) => ReactNode };

/** a menu whose rows either act or open a sub-panel in place (with a back row) */
function MenuBody({ items, close }: { items: MenuItem[]; close: () => void }) {
  const [sub, setSub] = useState<string | null>(null);
  const active = sub ? items.find((i) => i.key === sub) : null;
  if (active && "panel" in active && active.panel) {
    return (
      <div>
        <button className={`${menuRowClass} mb-1 -mt-0.5 !py-1 text-xs opacity-70`} onClick={() => setSub(null)}>
          <ChevronDownIcon size={13} className="rotate-90" /> Back
        </button>
        {active.panel(close)}
      </div>
    );
  }
  return (
    <>
      {items.map((i) =>
        "divider" in i ? (
          <div key={i.key} className="my-1 border-t border-rule dark:border-ink-3" />
        ) : (
          <button
            key={i.key}
            className={`${menuRowClass} ${i.danger ? "text-[#b03a37]" : ""}`}
            onClick={async () => {
              if (i.panel) { setSub(i.key); return; }
              await i.onClick?.();
              close();
            }}
          >
            <span className="opacity-70">{i.icon}</span>
            {i.label}
          </button>
        ),
      )}
    </>
  );
}
