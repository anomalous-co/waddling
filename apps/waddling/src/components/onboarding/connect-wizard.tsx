'use client';

/**
 * Guided "aha" onboarding — teach the system one concept at a time.
 *
 * NOT a wall of cards. A single-focus wizard: one concept per screen, advance as you
 * learn it. Lean 6-step, aha-first:
 *   1. Data lake    — the idea (your personal data store) + your seeded demo lake
 *   2. Agent + key  — the identity that connects; reveal its key HERE (reveal-once)
 *   3. Connect      — paste the ready MCP config; LIVE "waiting → ✓ connected"
 *   4. First query  — ask the agent to query the demo table; LIVE "waiting → 🎉"
 *   5. Memory       — ask the agent to REMEMBER something; LIVE "waiting → 🧠"
 *                     (polls the memory lake via GET /api/cp/quackboard/memory —
 *                     this is the product's core promise, so it gets the aha slot)
 *   6. You're set   — recap + memory oversight + bring-your-own-data
 *
 * Resumable + non-blocking by design: this page is NOT a gate (the paywall is). State
 * comes from GET /api/cp/onboarding/status so a reload resumes; the live steps (3/4/5)
 * always offer a manual "I've done this" advance because activation happens in another
 * app (Claude Desktop) and possibly a later session — we never trap the user.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Check,
  Copy,
  Loader2,
  KeyRound,
  RefreshCw,
  Database,
  Bot,
  Plug,
  Sparkles,
  Brain,
  PartyPopper,
  ArrowRight,
  ArrowLeft,
  ChevronDown,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { StatusBadge } from '@/components/dashboard/status';
import { fetchCp, cpPost } from '@/components/dashboard/fetch';
import { toast } from 'sonner';

// ── Status contract (matches GET /api/cp/onboarding/status) ────────────────────

interface OnboardingStatus {
  /** The seeded demo lake (auto-provisioned). Null while still provisioning. */
  lake: { id: string; name: string; slug: string; status: string } | null;
  /** The default agent record (key revealed separately, on demand). */
  agent: { id: string; name: string } | null;
  /** Single source of truth for the demo — keep grant + query + copy in lockstep. */
  demoTable: string; // e.g. "demo.events"
  demoQuery: string; // e.g. "SELECT * FROM lake.demo.events LIMIT 5"
  /** Live activation signals (durable: agent_session row / query-chokepoint marker). */
  connected: boolean;
  firstQuery: boolean;
  /** Resources still being created/seeded in the background. */
  provisioning: boolean;
  /** User finished or dismissed the tour. */
  completed: boolean;
}

const STEPS = [
  { key: 'lake', label: 'Data lake', icon: Database },
  { key: 'agent', label: 'Agent', icon: Bot },
  { key: 'connect', label: 'Connect', icon: Plug },
  { key: 'query', label: 'First query', icon: Sparkles },
  { key: 'memory', label: 'Memory', icon: Brain },
  { key: 'done', label: 'Done', icon: PartyPopper },
] as const;

const POLL_MS = 2500;

// ── Small shared pieces ────────────────────────────────────────────────────────

function CodeBlock({ code }: { code: string }) {
  const copy = useCallback(() => {
    void navigator.clipboard.writeText(code).then(() => toast('Copied'));
  }, [code]);
  return (
    <div className="relative rounded-lg border bg-muted/50">
      <Button
        variant="ghost"
        size="icon"
        className="absolute right-2 top-2 size-7 text-muted-foreground hover:text-foreground"
        onClick={copy}
        aria-label="Copy to clipboard"
      >
        <Copy />
      </Button>
      <pre className="overflow-x-auto p-4 pr-10 font-mono text-xs leading-relaxed text-foreground">
        {code}
      </pre>
    </div>
  );
}

// Remote MCP over Streamable HTTP — no local install. Works as-is in Claude
// Code (.mcp.json) and any host that supports `type: "http"` servers.
function mcpConfig(apiKey: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        waddling: {
          type: 'http',
          url: 'https://api.getwaddling.com/mcp',
          headers: { Authorization: `Bearer ${apiKey}` },
        },
      },
    },
    null,
    2,
  );
}

/** One-liner for Claude Code users — same server, zero file editing. */
function claudeCodeCommand(apiKey: string): string {
  return `claude mcp add --transport http waddling https://api.getwaddling.com/mcp --header "Authorization: Bearer ${apiKey}"`;
}

/** Horizontal stepper — shows where you are; completed steps get a check. */
function Stepper({ current, maxReached }: { current: number; maxReached: number }) {
  return (
    <ol className="flex items-center gap-2">
      {STEPS.map((s, i) => {
        const done = i < maxReached || (i < current);
        const active = i === current;
        const Icon = done ? Check : s.icon;
        return (
          <li key={s.key} className="flex flex-1 items-center gap-2">
            <div
              className={`flex size-8 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                active
                  ? 'border-primary bg-primary text-primary-foreground'
                  : done
                    ? 'border-green-500 bg-green-500/10 text-green-600 dark:text-green-400'
                    : 'border-muted-foreground/30 text-muted-foreground'
              }`}
            >
              <Icon className="size-4" />
            </div>
            <span
              className={`hidden text-xs font-medium sm:inline ${
                active ? 'text-foreground' : 'text-muted-foreground'
              }`}
            >
              {s.label}
            </span>
            {i < STEPS.length - 1 ? (
              <div
                className={`h-px flex-1 ${done ? 'bg-green-500/40' : 'bg-border'}`}
                aria-hidden
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/** A live "waiting for X → done" pill used by the connect + query steps. */
function LiveSignal({
  done,
  waitingLabel,
  doneLabel,
}: {
  done: boolean;
  waitingLabel: string;
  doneLabel: string;
}) {
  return (
    <div
      className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
        done
          ? 'border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-300'
          : 'border-border bg-muted/40 text-muted-foreground'
      }`}
    >
      {done ? (
        <>
          <Check className="size-4" />
          <span className="font-medium">{doneLabel}</span>
        </>
      ) : (
        <>
          <Loader2 className="size-4 animate-spin" />
          <span>{waitingLabel}</span>
        </>
      )}
    </div>
  );
}

// ── Step shell ─────────────────────────────────────────────────────────────────

function StepShell({
  icon: Icon,
  eyebrow,
  title,
  blurb,
  children,
  onBack,
  onNext,
  nextLabel,
  nextDisabled,
}: {
  icon: React.ComponentType<{ className?: string }>;
  eyebrow: string;
  title: string;
  blurb: string;
  children: React.ReactNode;
  onBack?: () => void;
  onNext?: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-primary">
          <Icon className="size-4" />
          {eyebrow}
        </div>
        <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
        <p className="max-w-xl text-sm text-muted-foreground">{blurb}</p>
      </div>

      <div className="flex flex-col gap-4">{children}</div>

      <div className="flex items-center justify-between pt-2">
        {onBack ? (
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft data-icon="inline-start" />
            Back
          </Button>
        ) : (
          <span />
        )}
        {onNext ? (
          <Button onClick={onNext} disabled={nextDisabled}>
            {nextLabel ?? 'Next'}
            <ArrowRight data-icon="inline-end" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// ── Wizard ─────────────────────────────────────────────────────────────────────

export function ConnectWizard() {
  const router = useRouter();
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [maxReached, setMaxReached] = useState(0);

  // Agent key is revealed on demand at the connect step (reveal-once model).
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [keyBusy, setKeyBusy] = useState(false);

  // Lake provisioning is USER-triggered (step 1 button), never automatic.
  const [provisionBusy, setProvisionBusy] = useState(false);

  // Memory step's live signal: has ANY note landed in the org's memory lake?
  // (Own poll, not onboarding/status — memory lives in the quackboard gateway.)
  const [hasMemory, setHasMemory] = useState(false);

  const didInit = useRef(false);

  const advanceTo = useCallback((next: number) => {
    setStep(next);
    setMaxReached((m) => Math.max(m, next));
  }, []);

  const loadStatus = useCallback(async () => {
    const res = await fetchCp<OnboardingStatus>('/api/cp/onboarding/status');
    if (res.ok) {
      setStatus(res.data);
      setLoadError(null);
      return res.data;
    }
    setLoadError(res.error);
    return null;
  }, []);

  // Initial load — resume to the furthest incomplete step. Provisioning is NOT kicked
  // here: the user starts it explicitly on step 1 (see `provision` below).
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    void (async () => {
      const s = await loadStatus();
      if (!s) return;
      const resume = s.firstQuery ? 4 : s.connected ? 3 : s.agent ? 1 : 0;
      setStep(resume);
      setMaxReached(resume);
    })();
  }, [loadStatus]);

  // User-triggered lake provisioning. Idempotent server-side; the poll below picks up
  // the running lake + agent + background-seeded sample data.
  const provision = useCallback(async () => {
    setProvisionBusy(true);
    const res = await cpPost('/api/cp/onboarding/provision', {});
    if (!res.ok) {
      setProvisionBusy(false);
      toast.error(res.error);
      return;
    }
    await loadStatus();
  }, [loadStatus]);

  // Clear the busy spinner once the lake actually exists.
  useEffect(() => {
    if (status?.lake) setProvisionBusy(false);
  }, [status?.lake]);

  // Poll while a provision is in flight, or while waiting on a live signal (connect/query).
  const needsPoll =
    !!status &&
    ((provisionBusy && (!status.lake || !status.agent || status.provisioning)) ||
      (step === 2 && !status.connected) ||
      (step === 3 && !status.firstQuery));
  useEffect(() => {
    if (!needsPoll) return;
    const id = setInterval(() => void loadStatus(), POLL_MS);
    return () => clearInterval(id);
  }, [needsPoll, loadStatus]);

  // Auto-celebrate: when a live signal lands while the user is on that step, nudge forward.
  useEffect(() => {
    if (status?.connected && step === 2) setMaxReached((m) => Math.max(m, 3));
    if (status?.firstQuery && step === 3) setMaxReached((m) => Math.max(m, 4));
    if (hasMemory && step === 4) setMaxReached((m) => Math.max(m, 5));
  }, [status?.connected, status?.firstQuery, hasMemory, step]);

  // Memory step live poll: the first remembered note in the memory lake. A 503
  // (gateway waking) just means "not yet" — keep polling.
  useEffect(() => {
    if (step !== 4 || hasMemory) return;
    const check = async () => {
      const res = await fetchCp<{ entries: unknown[] }>('/api/cp/quackboard/memory');
      if (res.ok && res.data.entries.length > 0) setHasMemory(true);
    };
    void check();
    const id = setInterval(() => void check(), POLL_MS);
    return () => clearInterval(id);
  }, [step, hasMemory]);

  const revealKey = useCallback(async () => {
    setKeyBusy(true);
    const res = await cpPost<{ key: string }>('/api/cp/onboarding/agent-key', {});
    setKeyBusy(false);
    if (res.ok) setApiKey(res.data.key);
    else toast.error(res.error);
  }, []);

  const finish = useCallback(async () => {
    void cpPost('/api/cp/onboarding/complete', {});
    router.push('/dashboard');
  }, [router]);

  const demoQuery = status?.demoQuery ?? 'SELECT * FROM lake.main.events LIMIT 5';

  const body = useMemo(() => {
    if (loadError && !status) {
      return (
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t load onboarding</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3">
            {loadError}
            <Button variant="outline" size="sm" onClick={() => void loadStatus()}>
              <RefreshCw data-icon="inline-start" />
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      );
    }

    // ── Step 1: Data lake (+ the idea) ────────────────────────────────────────
    if (step === 0) {
      return (
        <StepShell
          icon={Database}
          eyebrow="Step 1 of 6"
          title="Your governed data lake"
          blurb="waddling lets your AI agents query your data — and you decide exactly what each one can see. Everything flows through a data lake. Create your first one below — we'll seed it with sample data so you can try a real query in a minute."
          onBack={undefined}
          onNext={status?.lake ? () => advanceTo(1) : undefined}
          nextLabel="Next: your agent"
          nextDisabled={!status?.lake}
        >
          {status?.lake ? (
            <div className="flex items-center gap-3 rounded-lg border p-4">
              <Database className="size-5 text-muted-foreground" />
              <div className="flex flex-col">
                <span className="text-sm font-medium">{status.lake.name}</span>
                <span className="text-xs text-muted-foreground">
                  Sample data: <code className="font-mono">{status.demoTable}</code>
                </span>
              </div>
              <StatusBadge status={status.lake.status} />
            </div>
          ) : provisionBusy ? (
            <div className="flex items-center gap-3 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Creating your lake and loading sample data…
            </div>
          ) : (
            <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed p-4">
              <p className="text-sm text-muted-foreground">
                This spins up a managed lake on object storage and scales to zero when idle
                — there&apos;s no cost to keep it around.
              </p>
              <Button onClick={() => void provision()}>
                <Database data-icon="inline-start" />
                Create my demo lake
              </Button>
            </div>
          )}
        </StepShell>
      );
    }

    // ── Step 2: Agent + key ───────────────────────────────────────────────────
    if (step === 1) {
      return (
        <StepShell
          icon={Bot}
          eyebrow="Step 2 of 6"
          title="Your agent"
          blurb="An agent is the identity your AI uses to connect — it carries a key and the access rules you grant it. We've created your first agent. Reveal its key now; you'll paste it in the next step."
          onBack={() => advanceTo(0)}
          onNext={() => advanceTo(2)}
          nextLabel="Next: connect it"
        >
          <div className="flex flex-col gap-3 rounded-lg border p-4">
            <div className="flex items-center gap-3">
              <Bot className="size-5 text-muted-foreground" />
              <span className="text-sm font-medium">
                {status?.agent?.name ?? 'Setting up your agent…'}
              </span>
            </div>
            {apiKey ? (
              <>
                <CodeBlock code={apiKey} />
                <p className="text-xs text-muted-foreground">
                  This is shown once. It&apos;s already baked into the config on the next
                  step — copy it there.
                </p>
              </>
            ) : (
              <Button
                variant="outline"
                className="self-start"
                onClick={() => void revealKey()}
                disabled={keyBusy || !status?.agent}
              >
                {keyBusy ? (
                  <Loader2 data-icon="inline-start" className="animate-spin" />
                ) : (
                  <KeyRound data-icon="inline-start" />
                )}
                Reveal API key
              </Button>
            )}
          </div>
        </StepShell>
      );
    }

    // ── Step 3: Connect (live) ────────────────────────────────────────────────
    if (step === 2) {
      return (
        <StepShell
          icon={Plug}
          eyebrow="Step 3 of 6"
          title="Connect your agent"
          blurb="One command in Claude Code, or paste the JSON into any MCP-compatible client. It's a remote server — nothing to install; waddling handles auth, sessions, and governed queries."
          onBack={() => advanceTo(1)}
          onNext={() => advanceTo(3)}
          nextLabel={status?.connected ? 'Next: first query' : "I've connected →"}
        >
          {apiKey ? (
            <div className="flex flex-col gap-3">
              <p className="text-xs font-medium text-muted-foreground">Claude Code</p>
              <CodeBlock code={claudeCodeCommand(apiKey)} />
              <p className="text-xs font-medium text-muted-foreground">
                Or any MCP client (.mcp.json)
              </p>
              <CodeBlock code={mcpConfig(apiKey)} />
              <p className="text-xs text-muted-foreground">
                Adding the config alone doesn&apos;t connect anything — your agent only opens a
                session when it actually uses the tool. Ask it something like{' '}
                <em>&ldquo;connect to my waddling data lake&rdquo;</em> and this will turn green.
              </p>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed p-4">
              <p className="text-sm text-muted-foreground">
                Reveal your agent key to fill in the config.
              </p>
              <Button variant="outline" size="sm" onClick={() => void revealKey()} disabled={keyBusy}>
                {keyBusy ? (
                  <Loader2 data-icon="inline-start" className="animate-spin" />
                ) : (
                  <KeyRound data-icon="inline-start" />
                )}
                Reveal key
              </Button>
            </div>
          )}

          <LiveSignal
            done={!!status?.connected}
            waitingLabel="Waiting for your agent to connect…"
            doneLabel="Agent connected!"
          />

          <AdvancedConnect />
        </StepShell>
      );
    }

    // ── Step 4: First query (live) ────────────────────────────────────────────
    if (step === 3) {
      return (
        <StepShell
          icon={Sparkles}
          eyebrow="Step 4 of 6"
          title="Run your first governed query"
          blurb="Now ask your agent to query the sample data. Every query runs through your access rules — try this one:"
          onBack={() => advanceTo(2)}
          onNext={() => advanceTo(4)}
          nextLabel={status?.firstQuery ? 'Next: memory' : 'Skip →'}
        >
          <CodeBlock code={demoQuery} />
          <p className="text-xs text-muted-foreground">
            Paste that to your agent (e.g. &ldquo;run this query&rdquo;), or have it call{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono">waddling_query</code>.
          </p>
          <LiveSignal
            done={!!status?.firstQuery}
            waitingLabel="Waiting for the first governed query…"
            doneLabel="🎉 First governed query received!"
          />
        </StepShell>
      );
    }

    // ── Step 5: Memory (live, THE aha — the product's promise) ────────────────
    if (step === 4) {
      return (
        <StepShell
          icon={Brain}
          eyebrow="Step 5 of 6"
          title="Teach it something — and watch it remember"
          blurb="This is the point of waddling: your agents keep what they learn. Ask your agent to remember something about your data:"
          onBack={() => advanceTo(3)}
          onNext={() => advanceTo(5)}
          nextLabel={hasMemory ? 'Next: finish' : 'Skip →'}
        >
          <CodeBlock code={'Remember what you just learned about my data — the table, its shape, and anything surprising.'} />
          <p className="text-xs text-muted-foreground">
            Your agent calls{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono">waddling_remember</code>. Next
            session — tomorrow, next week — ask &ldquo;what do you remember about my data?&rdquo; and
            it answers from{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono">waddling_recall</code>.
          </p>
          <LiveSignal
            done={hasMemory}
            waitingLabel="Waiting for the first remembered note…"
            doneLabel="🧠 Remembered! Your agent now has durable memory."
          />
        </StepShell>
      );
    }

    // ── Step 6: You're set ────────────────────────────────────────────────────
    return (
      <StepShell
        icon={PartyPopper}
        eyebrow="Step 6 of 6"
        title="You're all set"
        blurb="Your agent queries your data through your rules and remembers what it learns. Two things to explore next:"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Link
            href="/quackboard"
            className="flex flex-col gap-1 rounded-lg border p-4 transition-colors hover:border-primary/50 hover:bg-muted/40"
          >
            <span className="text-sm font-medium">See what it remembers →</span>
            <span className="text-xs text-muted-foreground">
              Your memory lake: every note and observation your agents keep, in the open —
              not a black box.
            </span>
          </Link>
          <Link
            href="/datalakes/new"
            className="flex flex-col gap-1 rounded-lg border p-4 transition-colors hover:border-primary/50 hover:bg-muted/40"
          >
            <span className="text-sm font-medium">Connect your own data →</span>
            <span className="text-xs text-muted-foreground">
              Point waddling at your own DuckLake or object storage when you&apos;re ready.
            </span>
          </Link>
        </div>
        <div className="flex items-center justify-between pt-2">
          <Button variant="ghost" onClick={() => advanceTo(4)}>
            <ArrowLeft data-icon="inline-start" />
            Back
          </Button>
          <Button onClick={() => void finish()}>
            Go to dashboard
            <ArrowRight data-icon="inline-end" />
          </Button>
        </div>
      </StepShell>
    );
  }, [step, status, apiKey, keyBusy, provisionBusy, hasMemory, loadError, demoQuery, advanceTo, provision, revealKey, loadStatus, finish]);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Get started</h1>
          <p className="text-sm text-muted-foreground">
            Connect your first agent to a governed lake.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void finish()}>
          Skip for now
        </Button>
      </div>

      <Stepper current={step} maxReached={maxReached} />

      {body}
    </div>
  );
}

// ── Advanced connect methods (collapsed — MCP is the happy path) ───────────────

const EXTENSION_SQL = [
  'SET allow_unsigned_extensions = true;',
  "INSTALL birdshot FROM 'https://ext.getwaddling.com';",
  'LOAD birdshot;',
].join('\n');

function AdvancedConnect() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between p-3 text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        Other ways to connect
        <ChevronDown className={`size-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open ? (
        <div className="flex flex-col gap-3 border-t p-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium">Device code</span>
            <p className="text-xs text-muted-foreground">
              For a headless agent: have it display a short code and claim it from{' '}
              <Link href="/agents" className="text-primary underline-offset-4 hover:underline">
                Agents
              </Link>
              .
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium">Local DuckDB extension</span>
            <p className="text-xs text-muted-foreground">
              If your agent runs its own DuckDB (v1.5.3), load birdshot directly:
            </p>
            <CodeBlock code={EXTENSION_SQL} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
