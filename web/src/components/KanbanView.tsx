import { useMemo, useRef, useState } from "react";
import {
  DndContext, DragOverlay, PointerSensor, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragOverEvent, type DragStartEvent,
  pointerWithin, rectIntersection,
} from "@dnd-kit/core";
import {
  SortableContext, useSortable,
  horizontalListSortingStrategy, verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useBoard } from "../stores/board";
import type { Card, List } from "../lib/types";
import CardChip from "./CardChip";

export default function KanbanView() {
  const s = useBoard();
  const canWrite = !!s.myAccess?.canWrite;
  const lists = s.lists.filter((l) => !l.archived);
  const [activeCard, setActiveCard] = useState<Card | null>(null);
  const [activeList, setActiveList] = useState<List | null>(null);
  const snapshot = useRef<Card[] | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const cardsByList = useMemo(() => {
    const m = new Map<string, Card[]>();
    for (const l of lists) m.set(l.id, []);
    for (const c of s.cards) {
      if (c.archived) continue;
      m.get(c.listId)?.push(c);
    }
    return m;
  }, [lists, s.cards]);

  const findCard = (id: string) => s.cards.find((c) => c.id === id);

  const onDragStart = (e: DragStartEvent) => {
    const id = String(e.active.id);
    if (id.startsWith("list:")) {
      setActiveList(lists.find((l) => `list:${l.id}` === id) ?? null);
    } else {
      snapshot.current = useBoard.getState().snapshotCards();
      setActiveCard(findCard(id) ?? null);
    }
  };

  /** live cross-list preview while dragging a card */
  const onDragOver = (e: DragOverEvent) => {
    const activeId = String(e.active.id);
    if (activeId.startsWith("list:") || !e.over) return;
    const overId = String(e.over.id);
    const card = findCard(activeId);
    if (!card) return;

    let targetList: string;
    let beforeId: string | null = null;
    let afterId: string | null = null;

    if (overId.startsWith("listdrop:")) {
      targetList = overId.slice("listdrop:".length);
      const inList = (cardsByList.get(targetList) ?? []).filter((c) => c.id !== activeId);
      afterId = inList.at(-1)?.id ?? null; // drop at the end
    } else if (overId.startsWith("list:")) {
      return;
    } else {
      const overCard = findCard(overId);
      if (!overCard || overCard.id === activeId) return;
      targetList = overCard.listId;
      const inList = (cardsByList.get(targetList) ?? []).filter((c) => c.id !== activeId);
      const idx = inList.findIndex((c) => c.id === overId);
      const overRect = e.over.rect;
      const pointerY = e.active.rect.current.translated?.top ?? 0;
      const isBelow = pointerY > overRect.top + overRect.height / 2;
      if (isBelow) {
        afterId = overCard.id;
        beforeId = inList[idx + 1]?.id ?? null;
      } else {
        beforeId = overCard.id;
        afterId = inList[idx - 1]?.id ?? null;
      }
    }
    if (card.listId === targetList) {
      // avoid churn when nothing would change
      const inList = cardsByList.get(targetList) ?? [];
      const idx = inList.findIndex((c) => c.id === activeId);
      if (
        (afterId === (inList[idx - 1]?.id ?? null) && beforeId === (inList[idx + 1]?.id ?? null))
      ) return;
    }
    useBoard.getState().moveCardLocal(activeId, targetList, beforeId, afterId);
  };

  const onDragEnd = (e: DragEndEvent) => {
    const activeId = String(e.active.id);

    if (activeId.startsWith("list:")) {
      setActiveList(null);
      const overId = e.over ? String(e.over.id) : null;
      if (!overId || !overId.startsWith("list:") || overId === activeId) return;
      const listId = activeId.slice(5);
      const ordered = lists.filter((l) => l.id !== listId);
      const overIdx = ordered.findIndex((l) => `list:${l.id}` === overId);
      if (overIdx === -1) return;
      const fromIdx = lists.findIndex((l) => l.id === listId);
      const toIdx = lists.findIndex((l) => `list:${l.id}` === overId);
      // moving right → land after the over list; left → before it
      const beforeId = fromIdx < toIdx ? ordered[overIdx + 1]?.id ?? null : ordered[overIdx].id;
      const afterId = fromIdx < toIdx ? ordered[overIdx].id : ordered[overIdx - 1]?.id ?? null;
      useBoard.getState().moveList(listId, beforeId, afterId);
      return;
    }

    setActiveCard(null);
    const card = findCard(activeId);
    if (!card) return;
    // commit the final (already previewed) position to the API
    const inList = (cardsByList.get(card.listId) ?? []);
    const idx = inList.findIndex((c) => c.id === activeId);
    const afterId = inList[idx - 1]?.id ?? null;
    const beforeId = inList[idx + 1]?.id ?? null;
    useBoard.getState().moveCard(activeId, card.listId, beforeId, afterId);
    snapshot.current = null;
  };

  const onDragCancel = () => {
    if (snapshot.current) useBoard.getState().restoreCards(snapshot.current);
    snapshot.current = null;
    setActiveCard(null);
    setActiveList(null);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={(args) => {
        const within = pointerWithin(args);
        const pool = within.length ? within : rectIntersection(args);
        // prefer cards over the whole-list drop zones they sit inside
        const cards = pool.filter((c) => !String(c.id).startsWith("listdrop:"));
        return cards.length ? cards : pool;
      }}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      <div className="flex h-full items-start gap-3 p-3">
        <SortableContext
          items={lists.map((l) => `list:${l.id}`)}
          strategy={horizontalListSortingStrategy}
        >
          {lists.map((list) => (
            <ListColumn
              key={list.id}
              list={list}
              cards={cardsByList.get(list.id) ?? []}
              canWrite={canWrite}
            />
          ))}
        </SortableContext>
        {canWrite && <AddList />}
      </div>

      <DragOverlay>
        {activeCard && <CardChip card={activeCard} overlay />}
        {activeList && (
          <div className="w-72 rounded-card bg-paper-2/95 p-2 shadow-drag dark:bg-ink-2/95">
            <p className="px-1.5 py-1 text-sm font-semibold">{activeList.name}</p>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

function ListColumn({ list, cards, canWrite }: { list: List; cards: Card[]; canWrite: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `list:${list.id}`,
    disabled: !canWrite,
  });
  const s = useBoard();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(list.name);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
      className="flex max-h-full w-72 shrink-0 flex-col rounded-card bg-paper-2/95 shadow-card backdrop-blur-sm dark:bg-ink-2/95"
    >
      <div className="flex items-center gap-1 p-2 pb-1" {...attributes} {...listeners}>
        {renaming ? (
          <form
            className="flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() && name !== list.name) s.renameList(list.id, name.trim());
              setRenaming(false);
            }}
          >
            <input
              className="input !py-1 text-sm font-semibold"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={(e) => (e.target.form as HTMLFormElement).requestSubmit()}
              autoFocus
              maxLength={120}
            />
          </form>
        ) : (
          <button
            className="flex-1 cursor-pointer px-1.5 py-1 text-left text-sm font-semibold"
            onClick={() => canWrite && (setName(list.name), setRenaming(true))}
          >
            {list.name}
            <span className="ml-2 text-xs font-normal opacity-50">{cards.length}</span>
          </button>
        )}
        {canWrite && (
          <button
            className="btn-ghost !px-1.5 !py-0.5 text-xs"
            title="Archive list"
            onClick={() => s.archiveList(list.id, true)}
          >
            ×
          </button>
        )}
      </div>

      <CardDropZone listId={list.id} cards={cards} />

      {canWrite && <AddCard listId={list.id} />}
    </div>
  );
}

function CardDropZone({ listId, cards }: { listId: string; cards: Card[] }) {
  // whole column body is a droppable — catches drops on empty lists and below
  // the last card; card-level collisions take precedence (see collisionDetection)
  const { setNodeRef } = useDroppable({ id: `listdrop:${listId}`, data: { type: "listdrop" } });
  return (
    <div ref={setNodeRef} className="board-scroll min-h-4 flex-1 overflow-y-auto px-2">
      <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-2 pb-2">
          {cards.map((card) => (
            <SortableCard key={card.id} card={card} />
          ))}
          {cards.length === 0 && (
            <div className="h-8 rounded-md border border-dashed border-ink/15 dark:border-paper/15" />
          )}
        </div>
      </SortableContext>
    </div>
  );
}

function SortableCard({ card }: { card: Card }) {
  const canWrite = !!useBoard((s) => s.myAccess?.canWrite);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    data: { type: "card", listId: card.listId },
    disabled: !canWrite,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.35 : 1 }}
      {...attributes}
      {...listeners}
    >
      <CardChip card={card} />
    </div>
  );
}

function AddCard({ listId }: { listId: string }) {
  const s = useBoard();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  if (!open) {
    return (
      <button
        className="m-2 mt-0 rounded-md px-2 py-1.5 text-left text-sm opacity-60 transition-colors hover:bg-ink/8 hover:opacity-100 dark:hover:bg-paper/10"
        onClick={() => setOpen(true)}
      >
        + Add a card
      </button>
    );
  }
  return (
    <form
      className="m-2 mt-0"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!title.trim()) return setOpen(false);
        await s.addCard(listId, title.trim());
        setTitle("");
      }}
    >
      <textarea
        className="input resize-none text-sm"
        rows={2}
        placeholder="Card title…"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            (e.currentTarget.form as HTMLFormElement).requestSubmit();
          }
          if (e.key === "Escape") setOpen(false);
        }}
        autoFocus
      />
      <div className="mt-1 flex gap-1">
        <button className="btn-accent !py-1 text-xs">Add card</button>
        <button type="button" className="btn-ghost !py-1 text-xs" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function AddList() {
  const s = useBoard();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  if (!open) {
    return (
      <button
        className="w-72 shrink-0 rounded-card bg-white/20 px-3 py-2.5 text-left text-sm font-medium text-white backdrop-blur-sm transition-colors hover:bg-white/30"
        onClick={() => setOpen(true)}
      >
        + Add a list
      </button>
    );
  }
  return (
    <form
      className="w-72 shrink-0 rounded-card bg-paper-2 p-2 shadow-card dark:bg-ink-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return setOpen(false);
        await s.addList(name.trim());
        setName("");
      }}
    >
      <input
        className="input text-sm"
        placeholder="List name…"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        autoFocus
        maxLength={120}
      />
      <div className="mt-1 flex gap-1">
        <button className="btn-accent !py-1 text-xs">Add list</button>
        <button type="button" className="btn-ghost !py-1 text-xs" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
