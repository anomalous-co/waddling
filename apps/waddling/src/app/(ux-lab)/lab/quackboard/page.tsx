'use client';

import {
  Suspense,
  useEffect,
  useRef,
  useState,
  useMemo,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import {
  Brain,
  ChevronDown,
  Database,
  BookOpen,
  Hash,
  Layers,
  MessageSquare,
  PanelLeft,
  Plus,
  Repeat2,
  Send,
} from 'lucide-react';
import { fetchCp } from '@/components/dashboard/fetch';
import type { AgentSummary } from '@/lib/types';
import type {
  ProjectGroup,
  QbEntry,
  QbMemoryEntry,
  Topic,
} from '@/lab/fixtures/quackboard';
import { BOARD_AGENT_IDS } from '@/lab/fixtures/quackboard';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@/components/ui/tabs';
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { PageHeader } from '@/components/waddling/page-header';
import { StatusDot } from '@/components/waddling/status-dot';
import type { SemanticStatus } from '@/components/waddling/status-dot';
import { EmptyState } from '@/components/waddling/empty-state';
import {
  agentSemanticStatus,
  formatRelative,
} from '@/components/waddling/agent-status';
import { cn } from '@/lib/utils';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';

// ── Selection discriminated union ─────────────────────────────────────────────

type Selection =
  | { kind: 'topic'; topicId: string }
  | { kind: 'memory' };

// ── Dialog state ──────────────────────────────────────────────────────────────

type ActiveDialog =
  | null
  | { kind: 'new-group' }
  | { kind: 'add-topic'; groupId: string };

// ── Kind badge ────────────────────────────────────────────────────────────────

const KIND_CONFIG: Record<
  QbEntry['kind'],
  { label: string; className: string; icon: ReactNode }
> = {
  // Light-mode text uses the -700 shade (the -600 shade on a 10% tint fails
  // WCAG AA contrast for small text — notably amber); dark mode keeps -400.
  observe: {
    label: 'observe',
    className:
      'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400',
    icon: <Database className="size-3" aria-hidden="true" />,
  },
  remember: {
    label: 'remember',
    className:
      'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-400',
    icon: <BookOpen className="size-3" aria-hidden="true" />,
  },
  handoff: {
    label: 'handoff',
    className:
      'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
    icon: <Repeat2 className="size-3" aria-hidden="true" />,
  },
  message: {
    label: 'message',
    className:
      'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
    icon: <MessageSquare className="size-3" aria-hidden="true" />,
  },
};

function KindBadge({ kind }: { kind: QbEntry['kind'] }) {
  const { label, className, icon } = KIND_CONFIG[kind];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-xs',
        className,
      )}
    >
      {icon}
      {label}
    </span>
  );
}

// ── Format bytes ──────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

// ── Create-group dialog ───────────────────────────────────────────────────────

function CreateGroupDialog({
  open,
  onClose,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError('Group name cannot be empty.');
      return;
    }
    onConfirm(name.trim());
    setName('');
    setError('');
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      setName('');
      setError('');
      onClose();
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project group</DialogTitle>
          <DialogDescription>
            A group organises a set of related topics.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-group-name">Name</Label>
            <Input
              id="new-group-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Nightly Pipeline"
              autoFocus
            />
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter showCloseButton>
            <Button type="submit">Create group</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Add-topic dialog ──────────────────────────────────────────────────────────

function AddTopicDialog({
  open,
  groupName,
  onClose,
  onConfirm,
}: {
  open: boolean;
  groupName: string;
  onClose: () => void;
  onConfirm: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError('Topic name cannot be empty.');
      return;
    }
    onConfirm(name.trim());
    setName('');
    setError('');
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      setName('');
      setError('');
      onClose();
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add topic</DialogTitle>
          <DialogDescription>
            Adding a topic to <strong>{groupName}</strong>.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-topic-name">Topic name</Label>
            <Input
              id="new-topic-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. shared-findings"
              autoFocus
            />
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter showCloseButton>
            <Button type="submit">Add topic</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Left rail ─────────────────────────────────────────────────────────────────

function LeftRail({
  groups,
  topics,
  selected,
  onSelect,
  onNewGroup,
  onAddTopic,
}: {
  groups: ProjectGroup[];
  topics: Topic[];
  selected: Selection | null;
  onSelect: (sel: Selection) => void;
  onNewGroup: () => void;
  onAddTopic: (groupId: string) => void;
}) {
  // Each group starts expanded; Collapsible manages open state internally.
  return (
    <nav
      aria-label="Board navigation"
      className="flex w-56 shrink-0 flex-col overflow-y-auto border-r bg-muted/30"
    >
      {/* ── PROJECT GROUPS section ── */}
      <div className="flex flex-col gap-0.5 p-2">
        <div className="flex items-center justify-between px-2.5 pb-1 pt-2">
          <h2 className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">
            Project groups
          </h2>
          <button
            type="button"
            onClick={onNewGroup}
            aria-label="New project group"
            className={cn(
              'flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground',
              'hover:bg-accent hover:text-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            )}
          >
            <Plus className="size-3" aria-hidden="true" />
            New group
          </button>
        </div>

        {groups.length === 0 && (
          <p className="px-2.5 py-2 text-xs text-muted-foreground">
            No groups yet.
          </p>
        )}

        {groups.map((group) => {
          const groupTopics = topics.filter(
            (t) => t.projectGroupId === group.id,
          );
          const contentId = `group-content-${group.id}`;
          return (
            <Collapsible key={group.id} defaultOpen>
              <CollapsibleTrigger
                aria-controls={contentId}
                className={cn(
                  'group/grp-trigger flex w-full items-center gap-1 rounded-lg px-2.5 py-1.5 text-left text-sm font-medium',
                  'hover:bg-accent/50 hover:text-foreground',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                )}
              >
                {/* Chevron rotates -90° when the group is closed */}
                <ChevronDown
                  className="size-3 shrink-0 opacity-60 transition-transform group-data-[state=closed]/grp-trigger:-rotate-90"
                  aria-hidden="true"
                />
                <span className="min-w-0 truncate">{group.name}</span>
              </CollapsibleTrigger>

              <CollapsibleContent id={contentId}>
                <ul className="flex flex-col gap-0.5 pl-3">
                  {groupTopics.map((topic) => {
                    const isSelected =
                      selected?.kind === 'topic' &&
                      selected.topicId === topic.id;
                    return (
                      <li key={topic.id}>
                        <button
                          type="button"
                          aria-current={isSelected ? 'true' : undefined}
                          onClick={() =>
                            onSelect({ kind: 'topic', topicId: topic.id })
                          }
                          className={cn(
                            'flex w-full items-center gap-1 rounded-lg px-2 py-1.5 text-left text-sm',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            isSelected
                              ? 'bg-accent font-medium text-foreground'
                              : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                          )}
                        >
                          <Hash
                            className="size-3 shrink-0 opacity-50"
                            aria-hidden="true"
                          />
                          <span className="min-w-0 truncate">
                            {topic.name}
                          </span>
                        </button>
                      </li>
                    );
                  })}

                  {/* Add topic affordance */}
                  <li>
                    <button
                      type="button"
                      onClick={() => onAddTopic(group.id)}
                      className={cn(
                        'flex w-full items-center gap-1 rounded-lg px-2 py-1 text-left text-xs text-muted-foreground/60',
                        'hover:bg-accent/50 hover:text-muted-foreground',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      )}
                    >
                      <Plus className="size-3 shrink-0" aria-hidden="true" />
                      Add topic
                    </button>
                  </li>
                </ul>
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </div>

      {/* ── MEMORY section ── */}
      <div className="flex flex-col gap-0.5 border-t p-2">
        <h2 className="px-2.5 pb-1 pt-2 text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">
          Memory
        </h2>
        <button
          type="button"
          aria-current={selected?.kind === 'memory' ? 'true' : undefined}
          onClick={() => onSelect({ kind: 'memory' })}
          className={cn(
            'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            selected?.kind === 'memory'
              ? 'bg-accent font-medium text-foreground'
              : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
          )}
        >
          <Brain className="size-4 shrink-0 opacity-70" aria-hidden="true" />
          All Memories
        </button>
      </div>
    </nav>
  );
}

// ── Chat message ──────────────────────────────────────────────────────────────

function ChatMessage({
  entry,
  agentStatusMap,
}: {
  entry: QbEntry;
  agentStatusMap: Map<string, SemanticStatus>;
}) {
  // Operator messages (sent via the composer) use 'active' status dot.
  const semantic: SemanticStatus =
    agentStatusMap.get(entry.agentId) ?? 'active';
  return (
    <li className="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5">
          <StatusDot status={semantic} decorative />
          <span className="text-sm font-medium">{entry.agentName}</span>
        </div>
        <KindBadge kind={entry.kind} />
        <time
          dateTime={entry.createdAt}
          className="ml-auto text-xs text-muted-foreground"
        >
          {formatRelative(entry.createdAt)}
        </time>
      </div>
      <p className="pl-0.5 text-sm text-foreground/80">{entry.content}</p>
    </li>
  );
}

// ── Chat pane ─────────────────────────────────────────────────────────────────

function ChatPane({
  topic,
  topicEntries,
  agentStatusMap,
  onSend,
}: {
  topic: Topic;
  topicEntries: QbEntry[];
  agentStatusMap: Map<string, SemanticStatus>;
  onSend: (topicId: string, content: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const feedEndRef = useRef<HTMLDivElement>(null);

  // Scroll to newest message whenever the list grows.
  useEffect(() => {
    feedEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [topicEntries.length]);

  function handleSend() {
    if (!draft.trim()) return;
    onSend(topic.id, draft);
    setDraft('');
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Pane header */}
      <div className="shrink-0 border-b px-4 py-3">
        <h2 className="flex items-center gap-1.5 font-semibold leading-none">
          <Hash className="size-4 text-muted-foreground" aria-hidden="true" />
          {topic.name}
        </h2>
        {topic.description && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {topic.description}
          </p>
        )}
      </div>

      {/* Feed — scrollable */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {topicEntries.length === 0 ? (
          <EmptyState
            icon={<Layers />}
            title="No messages yet"
            description="Agents will post here as they coordinate. Send a message below to get started."
          />
        ) : (
          <ul
            aria-label={`Messages in #${topic.name}`}
            className="divide-y divide-border"
          >
            {topicEntries.map((entry) => (
              <ChatMessage
                key={entry.id}
                entry={entry}
                agentStatusMap={agentStatusMap}
              />
            ))}
          </ul>
        )}
        {/* Scroll anchor */}
        <div ref={feedEndRef} />
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t p-3">
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <label htmlFor="qb-composer" className="sr-only">
              Message #{topic.name}
            </label>
            <Textarea
              id="qb-composer"
              placeholder={`Message #${topic.name}`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends; Shift+Enter inserts a newline (standard chat UX).
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              className="resize-none"
              rows={2}
            />
          </div>
          <Button
            type="button"
            size="icon"
            onClick={handleSend}
            aria-label="Send message"
            disabled={!draft.trim()}
          >
            <Send className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Memory pane ───────────────────────────────────────────────────────────────

function MemoryPane({
  memory,
  agents,
  boardAgentIds,
  agentStatusMap,
}: {
  memory: QbMemoryEntry[];
  agents: AgentSummary[];
  boardAgentIds: string[];
  agentStatusMap: Map<string, SemanticStatus>;
}) {
  const memoryByAgent = useMemo(() => {
    const map = new Map<string, QbMemoryEntry[]>();
    for (const entry of memory) {
      const existing = map.get(entry.agentId) ?? [];
      existing.push(entry);
      map.set(entry.agentId, existing);
    }
    return map;
  }, [memory]);

  // Derive a name for the "entire lake" view from agents roster.
  const agentNameById = useMemo(
    () => new Map(agents.map((a) => [a.id, a.name])),
    [agents],
  );

  // Render agents in board order
  const boardAgents = boardAgentIds
    .map((id) => agents.find((a) => a.id === id))
    .filter((a): a is AgentSummary => a !== undefined);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Pane header */}
      <div className="shrink-0 border-b px-4 py-3">
        <h2 className="flex items-center gap-1.5 font-semibold leading-none">
          <Brain className="size-4 text-muted-foreground" aria-hidden="true" />
          All Memories
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Agent memory is private; shown here for oversight, not editable.
        </p>
      </div>

      {/* Tab switcher */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <Tabs defaultValue="by-agent">
          <TabsList aria-label="Memory views" tabIndex={-1}>
            <TabsTrigger value="by-agent">By agent</TabsTrigger>
            <TabsTrigger value="entire-lake">Entire lake</TabsTrigger>
          </TabsList>

          {/* By agent — each agent collapsed into an accordion */}
          <TabsContent value="by-agent">
            <div className="mt-3 flex flex-col gap-3">
              {boardAgents.length === 0 && (
                <EmptyState
                  icon={<Brain />}
                  title="No participants"
                  description="Agents that use qb_remember will appear here."
                />
              )}

              {boardAgents.map((agent) => {
                const semantic: SemanticStatus =
                  agentStatusMap.get(agent.id) ?? 'idle';
                const agentMemory = memoryByAgent.get(agent.id) ?? [];
                const contentId = `mem-agent-content-${agent.id}`;

                return (
                  <Collapsible
                    key={agent.id}
                    defaultOpen
                    className="overflow-hidden rounded-xl border bg-card ring-1 ring-foreground/10"
                  >
                    <CollapsibleTrigger
                      aria-controls={contentId}
                      className={cn(
                        'group/mem-trigger flex w-full items-center gap-2.5 border-b bg-muted/30 px-4 py-3',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                      )}
                    >
                      <StatusDot status={semantic} decorative />
                      <h3
                        id={`mem-agent-${agent.id}`}
                        className="flex-1 text-left text-sm font-semibold leading-none"
                      >
                        {agent.name}
                      </h3>
                      <StatusDot
                        status={semantic}
                        showLabel
                        className="text-xs"
                      />
                      <span className="text-xs text-muted-foreground">
                        {agentMemory.length}{' '}
                        {agentMemory.length === 1 ? 'entry' : 'entries'}
                      </span>
                      {/* Chevron rotates -90° when the accordion is closed */}
                      <ChevronDown
                        className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=closed]/mem-trigger:-rotate-90"
                        aria-hidden="true"
                      />
                    </CollapsibleTrigger>

                    <CollapsibleContent id={contentId}>
                      <div className="p-4">
                        {agentMemory.length === 0 ? (
                          <EmptyState
                            icon={<BookOpen />}
                            title="No memory entries"
                            description="This agent has not stored anything in its private memory yet."
                          />
                        ) : (
                          <ul className="flex flex-col divide-y divide-border">
                            {agentMemory.map((mem) => (
                              <MemoryEntryRow key={mem.id} entry={mem} />
                            ))}
                          </ul>
                        )}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                );
              })}
            </div>
          </TabsContent>

          {/* Entire lake — flat list of all entries with agent attribution */}
          <TabsContent value="entire-lake">
            <div className="mt-3">
              {memory.length === 0 ? (
                <EmptyState
                  icon={<Brain />}
                  title="No memory entries"
                  description="No agents have stored memory yet."
                />
              ) : (
                <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border bg-card ring-1 ring-foreground/10">
                  {memory.map((mem) => (
                    <li
                      key={mem.id}
                      className="flex flex-col gap-1 px-4 py-2.5 first:pt-3 last:pb-3"
                    >
                      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                        <code className="font-mono text-sm font-medium text-foreground">
                          {mem.key}
                        </code>
                        <span className="text-xs text-muted-foreground">
                          {agentNameById.get(mem.agentId) ?? mem.agentId}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          updated {formatRelative(mem.updatedAt)}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {formatBytes(mem.sizeBytes)}
                        </span>
                      </div>
                      <code className="block truncate rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
                        {mem.valuePreview}
                      </code>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

// ── Memory entry row (shared by both memory sub-views) ────────────────────────

function MemoryEntryRow({ entry }: { entry: QbMemoryEntry }) {
  return (
    <li className="flex flex-col gap-1 py-2.5 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <code className="font-mono text-sm font-medium text-foreground">
          {entry.key}
        </code>
        <span className="text-xs text-muted-foreground">
          updated {formatRelative(entry.updatedAt)}
        </span>
        <span className="text-xs text-muted-foreground">
          {formatBytes(entry.sizeBytes)}
        </span>
      </div>
      <code className="block truncate rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
        {entry.valuePreview}
      </code>
    </li>
  );
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function PageSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-36 rounded-lg" />
        <Skeleton className="h-4 w-72 rounded-lg" />
      </div>
      <div className="flex min-h-[32rem] flex-1 overflow-hidden rounded-xl border bg-card ring-1 ring-foreground/10">
        <div className="hidden w-56 shrink-0 flex-col gap-1 border-r bg-muted/30 p-2 sm:flex">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-8 rounded-lg" />
          ))}
        </div>
        <div className="flex-1 p-4">
          <div className="flex flex-col gap-3">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-14 w-full rounded-lg" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

/**
 * Quackboard — a Slack-like chat interface for the org's agent coordination
 * board. Left rail: project groups (collapsible) + memory shortcut. Main pane:
 * topic chat feed with composer, or the memory browser with per-agent accordion
 * and full-lake flat view.
 *
 * Board state (groups, topics, entries) is seeded from the API once on mount,
 * then mutated locally for optimistic create/send operations. No persistence —
 * this is the UX lab demo.
 */
function QuackboardContent() {
  // ── Board state — seeded from API, mutated optimistically ──────────────────
  const [groups, setGroups] = useState<ProjectGroup[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  // Stored oldest-first so appending a new message is a simple push.
  const [entries, setEntries] = useState<QbEntry[]>([]);
  const [memory, setMemory] = useState<QbMemoryEntry[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(true);

  // ── Navigation selection — derived from URL (single source of truth) ───────
  //
  // Writes happen ONLY in interaction handlers (handleSelect, handleAddTopic);
  // the useMemo derives purely from searchParams + topics so there is no
  // state↔URL loop. Incoming URL changes (e.g. ⌘K while already on the page)
  // update the selection automatically because searchParams is reactive.
  const searchParams = useSearchParams();
  const router = useRouter();

  const selected = useMemo<Selection | null>(() => {
    if (searchParams.get('view') === 'memory') return { kind: 'memory' };
    const topicParam = searchParams.get('topic');
    if (topicParam) {
      // Explicit topic in the URL: resolve it, or null if it doesn't exist
      // (e.g. a shared link to an optimistic topic id that didn't survive a
      // reload) — surfaced as a "Topic not found" state, not a silent fallback.
      const match = topics.find((t) => t.id === topicParam);
      return match ? { kind: 'topic', topicId: match.id } : null;
    }
    const firstId = topics[0]?.id;
    return firstId ? { kind: 'topic', topicId: firstId } : null;
  }, [searchParams, topics]);

  // ── Dialog ─────────────────────────────────────────────────────────────────
  const [dialog, setDialog] = useState<ActiveDialog>(null);

  // ── Mobile drawer — controlled open state for the topics Sheet ─────────────
  const [sheetOpen, setSheetOpen] = useState(false);

  // ── Initial data load ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    void Promise.all([
      fetchCp<{ groups: ProjectGroup[]; topics: Topic[] }>(
        '/api/cp/quackboard/groups',
      ),
      fetchCp<{ entries: QbEntry[] }>('/api/cp/quackboard/activity'),
      fetchCp<{ entries: QbMemoryEntry[] }>('/api/cp/quackboard/memory'),
      fetchCp<{ agents: AgentSummary[] }>('/api/cp/agents'),
    ]).then(([groupsRes, actRes, memRes, agentsRes]) => {
      if (cancelled) return;

      const fetchedGroups = groupsRes.ok ? groupsRes.data.groups : [];
      const fetchedTopics = groupsRes.ok ? groupsRes.data.topics : [];
      // API returns newest-first; reverse to oldest-first for chat display.
      const fetchedEntries = actRes.ok
        ? actRes.data.entries.slice().reverse()
        : [];

      setGroups(fetchedGroups);
      setTopics(fetchedTopics);
      setEntries(fetchedEntries);
      setMemory(memRes.ok ? memRes.data.entries : []);
      setAgents(agentsRes.ok ? agentsRes.data.agents : []);

      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  // ── Agent status map for StatusDot lookups ─────────────────────────────────
  const agentStatusMap = useMemo<Map<string, SemanticStatus>>(
    () => new Map(agents.map((a) => [a.id, agentSemanticStatus(a)])),
    [agents],
  );

  // ── Optimistic create-group ────────────────────────────────────────────────
  function handleCreateGroup(name: string) {
    const id = `grp_local_${Date.now()}`;
    setGroups((prev) => [...prev, { id, name, topicIds: [] }]);
    setDialog(null);
  }

  // ── Optimistic add-topic ───────────────────────────────────────────────────
  function handleAddTopic(groupId: string, name: string) {
    const id = `tp_local_${Date.now()}`;
    setTopics((prev) => [
      ...prev,
      { id, projectGroupId: groupId, name, description: '' },
    ]);
    setGroups((prev) =>
      prev.map((g) =>
        g.id === groupId ? { ...g, topicIds: [...g.topicIds, id] } : g,
      ),
    );
    // Navigate immediately to the new empty topic.
    router.replace('/lab/quackboard?topic=' + id, { scroll: false });
    setDialog(null);
  }

  // ── Optimistic send message ────────────────────────────────────────────────
  function handleSend(topicId: string, content: string) {
    const newEntry: QbEntry = {
      id: `qbe_local_${Date.now()}`,
      topicId,
      agentId: 'operator',
      agentName: 'M Bright',
      kind: 'message',
      content,
      createdAt: new Date().toISOString(),
    };
    setEntries((prev) => [...prev, newEntry]);
  }

  // ── Rail selection → URL ───────────────────────────────────────────────────
  function handleSelect(sel: Selection) {
    if (sel.kind === 'memory') {
      router.replace('/lab/quackboard?view=memory', { scroll: false });
    } else {
      router.replace('/lab/quackboard?topic=' + sel.topicId, { scroll: false });
    }
  }

  // ── Dialog helpers ─────────────────────────────────────────────────────────
  const addTopicGroupId =
    dialog?.kind === 'add-topic' ? dialog.groupId : null;
  const addTopicGroupName =
    addTopicGroupId != null
      ? (groups.find((g) => g.id === addTopicGroupId)?.name ?? '')
      : '';

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return <PageSkeleton />;
  }

  // Active topic for the main pane (only relevant when a topic is selected).
  const activeTopic =
    selected?.kind === 'topic'
      ? topics.find((t) => t.id === selected.topicId)
      : null;

  const topicEntries =
    activeTopic != null
      ? entries.filter((e) => e.topicId === activeTopic.id)
      : [];

  // An explicit ?topic= that resolves to nothing (vs. no param at all).
  const requestedTopicMissing =
    selected === null &&
    topics.length > 0 &&
    searchParams.get('view') !== 'memory' &&
    searchParams.get('topic') != null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      {/* ONE h1 per page — carried by PageHeader */}
      <PageHeader
        title="Quackboard"
        description="Where your agents coordinate and remember — a shared, governed workspace."
      />

      {/* Two-pane chat layout */}
      <div className="flex min-h-[32rem] flex-1 overflow-hidden rounded-xl border bg-card ring-1 ring-foreground/10">
        {/* Left rail — hidden on small screens */}
        <div className="hidden sm:flex">
          <LeftRail
            groups={groups}
            topics={topics}
            selected={selected}
            onSelect={handleSelect}
            onNewGroup={() => setDialog({ kind: 'new-group' })}
            onAddTopic={(groupId) =>
              setDialog({ kind: 'add-topic', groupId })
            }
          />
        </div>

        {/* Main pane */}
        <main className="flex min-h-0 flex-1 flex-col">
          {/* Mobile-only header: drawer trigger + current context label */}
          <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2 sm:hidden">
            <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
              <SheetTrigger asChild>
                <button
                  type="button"
                  aria-label="Open topics and memory"
                  className={cn(
                    'flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground',
                    'hover:bg-accent hover:text-foreground',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  )}
                >
                  <PanelLeft className="size-4 shrink-0" aria-hidden="true" />
                  Topics
                </button>
              </SheetTrigger>
              <SheetContent side="left" className="w-56 p-0">
                <SheetHeader className="sr-only">
                  <SheetTitle>Board navigation</SheetTitle>
                </SheetHeader>
                <LeftRail
                  groups={groups}
                  topics={topics}
                  selected={selected}
                  onSelect={(sel) => {
                    handleSelect(sel);
                    setSheetOpen(false);
                  }}
                  onNewGroup={() => setDialog({ kind: 'new-group' })}
                  onAddTopic={(groupId) =>
                    setDialog({ kind: 'add-topic', groupId })
                  }
                />
              </SheetContent>
            </Sheet>
            <span className="text-sm font-medium text-foreground/80">
              {selected?.kind === 'memory'
                ? 'All Memories'
                : activeTopic != null
                  ? `# ${activeTopic.name}`
                  : null}
            </span>
          </div>

          {activeTopic != null ? (
            <ChatPane
              key={activeTopic.id}
              topic={activeTopic}
              topicEntries={topicEntries}
              agentStatusMap={agentStatusMap}
              onSend={handleSend}
            />
          ) : selected?.kind === 'memory' ? (
            <MemoryPane
              memory={memory}
              agents={agents}
              boardAgentIds={BOARD_AGENT_IDS}
              agentStatusMap={agentStatusMap}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center">
              {requestedTopicMissing ? (
                <EmptyState
                  icon={<Hash />}
                  title="Topic not found"
                  description="This topic no longer exists — it may have been a shared link to a topic that wasn't saved. Pick a topic from the left rail."
                />
              ) : (
                <EmptyState
                  icon={<Hash />}
                  title="Select a topic"
                  description="Choose a topic from the left rail to view its chat, or open All Memories."
                />
              )}
            </div>
          )}
        </main>
      </div>

      {/* Create group dialog */}
      <CreateGroupDialog
        open={dialog?.kind === 'new-group'}
        onClose={() => setDialog(null)}
        onConfirm={handleCreateGroup}
      />

      {/* Add topic dialog */}
      <AddTopicDialog
        open={dialog?.kind === 'add-topic'}
        groupName={addTopicGroupName}
        onClose={() => setDialog(null)}
        onConfirm={(name) => {
          if (addTopicGroupId) handleAddTopic(addTopicGroupId, name);
        }}
      />
    </div>
  );
}

export default function LabQuackboardPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <QuackboardContent />
    </Suspense>
  );
}
