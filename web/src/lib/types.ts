export type User = {
  id: string;
  email: string;
  name: string;
  avatarColor: string;
  isAdmin: boolean;
  theme: "system" | "light" | "dark";
};

export type Workspace = {
  id: string;
  name: string;
  settings: {
    boardCreation?: "admins" | "members";
    inviting?: "admins" | "members";
    visibilityChanges?: "admins" | "members";
  };
  role: "admin" | "member";
};

export type WsMember = {
  id: string;
  name: string;
  email: string;
  avatarColor: string;
  role: "admin" | "member";
};

export type Team = {
  id: string;
  workspaceId: string;
  name: string;
  color: string;
  memberIds: string[];
};

export type BoardRole = "admin" | "member" | "observer" | "guest";
export type Visibility = "private" | "team" | "workspace" | "link";

export type Board = {
  id: string;
  workspaceId: string;
  name: string;
  background: string;
  visibility: Visibility;
  shareToken: string | null;
  archived: boolean;
  starred?: boolean;
};

export type BoardMember = {
  id: string;
  name: string;
  email: string;
  avatarColor: string;
  role: BoardRole;
  starred: boolean;
};

export type List = {
  id: string;
  boardId: string;
  name: string;
  rank: string;
  archived: boolean;
};

export type CardBadges = {
  comments: number;
  attachments: number;
  checklist: { total: number; done: number } | null;
};

export type MirrorSnapshot = {
  sourceCardId: string;
  sourceBoardId: string;
  boardName: string;
  title: string;
  dueAt: string | null;
  dueComplete: boolean;
  archived: boolean;
  labels: Array<{ name: string; color: string }>;
} | null;

export type Card = {
  id: string;
  boardId: string;
  listId: string;
  mirrorOfCardId?: string | null;
  /** present (possibly null = broken) when this card is a mirror */
  mirror?: MirrorSnapshot;
  title: string;
  description: string;
  rank: string;
  startAt: string | null;
  dueAt: string | null;
  dueComplete: boolean;
  coverColor: string | null;
  coverAttachmentId: string | null;
  archived: boolean;
  labelIds: string[];
  memberIds: string[];
  fieldValues: Record<string, unknown>;
  badges: CardBadges;
};

export type Label = { id: string; boardId: string; name: string; color: string };

export type FieldType =
  | "text" | "number" | "date" | "checkbox"
  | "select" | "multiselect" | "member" | "url";

export type CustomFieldDef = {
  id: string;
  boardId: string;
  name: string;
  type: FieldType;
  options: Array<{ id: string; label: string; color: string }>;
  showOnFront: boolean;
  rank: string;
};

export type MyAccess = {
  role: BoardRole | null;
  canWrite: boolean;
  canAdmin: boolean;
  workspaceRole: "admin" | "member" | null;
};

/** dependency: cardId blocks blocksCardId */
export type CardLink = { cardId: string; blocksCardId: string };

export type BoardFull = {
  board: Board;
  myAccess: MyAccess;
  lists: List[];
  cards: Card[];
  labels: Label[];
  members: BoardMember[];
  teamIds: string[];
  customFieldDefs: CustomFieldDef[];
  links: CardLink[];
};

export type FormDef = {
  id: string;
  boardId: string;
  listId: string;
  token: string;
  title: string;
  description: string;
  enabled: boolean;
  fields: Array<{ id: string; label: string; type: string; required: boolean; options?: string[] }>;
};

export type Checklist = {
  id: string;
  cardId: string;
  name: string;
  rank: string;
  items: ChecklistItem[];
};

export type ChecklistItem = {
  id: string;
  checklistId: string;
  text: string;
  done: boolean;
  assigneeId: string | null;
  dueAt: string | null;
  rank: string;
};

export type Comment = {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string | null;
  userId: string | null;
  userName: string | null;
  avatarColor: string | null;
};

export type Attachment = {
  id: string;
  cardId: string;
  filename: string;
  mime: string;
  size: number;
  createdAt: string;
};

export type CardDetail = {
  card: Card & { fieldValues: Record<string, unknown> };
  checklists: Checklist[];
  comments: Comment[];
  attachments: Attachment[];
  activity: Array<{
    id: string; type: string; data: Record<string, unknown>;
    createdAt: string; userId: string | null; userName: string | null;
  }>;
};

export type AutomationRule = {
  id: string;
  boardId: string;
  name: string;
  enabled: boolean;
  trigger: Record<string, any>;
  conditions: Array<Record<string, any>>;
  actions: Array<Record<string, any>>;
};
