'use client';

import { useEffect, useState, useId } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  Users,
  Mail,
  UserPlus,
  MoreHorizontal,
  Bot,
  Clock,
} from 'lucide-react';
import { fetchCp, cpPost } from '@/components/dashboard/fetch';
import type {
  TeamMemberRow,
  TeamInviteRow,
  TeamDelegationRow,
  TeamOrgInfo,
} from '@/lab/fixtures/team';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Avatar,
  AvatarFallback,
} from '@/components/ui/avatar';
import { PageHeader } from '@/components/waddling/page-header';
import { SectionCard } from '@/components/waddling/section-card';
import { EmptyState } from '@/components/waddling/empty-state';
import { formatRelative } from '@/components/waddling/agent-status';
import { cn } from '@/lib/utils';

// ── Local type ────────────────────────────────────────────────────────────────

interface TeamData {
  org: TeamOrgInfo;
  members: TeamMemberRow[];
  invites: TeamInviteRow[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const ROLE_BADGE: Record<string, string> = {
  owner: 'border-transparent bg-blue-500/15 text-blue-700 dark:text-blue-400',
  admin: 'border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-500',
  member: 'border-transparent bg-muted text-muted-foreground',
};

function RoleBadge({ role }: { role: string }) {
  return (
    <Badge className={cn('font-medium capitalize', ROLE_BADGE[role] ?? ROLE_BADGE.member)}>
      {role}
    </Badge>
  );
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((n) => n[0] ?? '')
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

// ── Invite dialog ─────────────────────────────────────────────────────────────

interface InviteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInvited: (invite: TeamInviteRow) => void;
}

function InviteDialog({ open, onOpenChange, onInvited }: InviteDialogProps) {
  const emailId = useId();
  const roleId = useId();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [submitting, setSubmitting] = useState(false);
  const [emailError, setEmailError] = useState('');

  // Reset on close
  useEffect(() => {
    if (!open) {
      setEmail('');
      setRole('member');
      setEmailError('');
      setSubmitting(false);
    }
  }, [open]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = email.trim().toLowerCase();
    if (!trimmed || !trimmed.includes('@')) {
      setEmailError('Enter a valid email address.');
      return;
    }
    setEmailError('');
    setSubmitting(true);
    const res = await cpPost<{ ok: true; invite: TeamInviteRow }>(
      '/api/cp/team',
      { email: trimmed, role },
    );
    setSubmitting(false);
    if (res.ok) {
      toast.success(`Invite sent to ${trimmed}`);
      onInvited(res.data.invite);
      onOpenChange(false);
    } else {
      toast.error(res.error ?? 'Failed to send invite');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Invite a team member</DialogTitle>
          <DialogDescription>
            They'll receive an email with a link to join your org.
          </DialogDescription>
        </DialogHeader>

        <form id="invite-form" onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={emailId}>Email address</Label>
            <Input
              id={emailId}
              type="email"
              placeholder="colleague@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-describedby={emailError ? `${emailId}-error` : undefined}
              aria-invalid={!!emailError}
              autoComplete="email"
              required
            />
            {emailError && (
              <p id={`${emailId}-error`} className="text-xs text-destructive">
                {emailError}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={roleId}>Role</Label>
            <Select
              value={role}
              onValueChange={(v) => setRole(v as 'admin' | 'member')}
            >
              <SelectTrigger id={roleId}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">Member — can view and query</SelectItem>
                <SelectItem value="admin">Admin — can manage agents, lakes, and billing</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </form>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button form="invite-form" type="submit" disabled={submitting}>
            {submitting ? 'Sending…' : 'Send invite'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

/**
 * Team surface — org members, roles, pending invites, and delegated access.
 *
 * A11y: ONE h1 (PageHeader), sections use h2 (SectionCard default), real <table>
 * semantics, AlertDialog confirms on all irreversible actions, accessible names on
 * icon-only controls, roles read as text, status via labeled Badge (not color alone).
 */
export default function LabTeamPage() {
  const [teamData, setTeamData] = useState<TeamData | null>(null);
  const [delegations, setDelegations] = useState<TeamDelegationRow[] | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [isMutating, setIsMutating] = useState(false);

  // AlertDialog targets
  const [pendingRemoveMember, setPendingRemoveMember] = useState<TeamMemberRow | null>(null);
  const [pendingRevokeInvite, setPendingRevokeInvite] = useState<TeamInviteRow | null>(null);
  const [pendingRevokeDelegation, setPendingRevokeDelegation] = useState<TeamDelegationRow | null>(null);

  // Fetch team data + delegations in parallel
  useEffect(() => {
    let cancelled = false;

    void Promise.all([
      fetchCp<TeamData>('/api/cp/team'),
      fetchCp<{ delegations: TeamDelegationRow[] }>('/api/cp/team/delegations'),
    ]).then(([teamRes, dlgRes]) => {
      if (cancelled) return;
      setTeamData(teamRes.ok ? teamRes.data : { org: { id: '', name: '', slug: '', createdAt: '' }, members: [], invites: [] });
      setDelegations(dlgRes.ok ? dlgRes.data.delegations : []);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  // ── Role change ──────────────────────────────────────────────────────────────

  async function handleRoleChange(member: TeamMemberRow, newRole: 'admin' | 'member') {
    const res = await cpPost<{ ok: true }>(
      `/api/cp/team/members/${member.id}/role`,
      { role: newRole },
    );
    if (res.ok) {
      setTeamData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          members: prev.members.map((m) =>
            m.id === member.id ? { ...m, role: newRole } : m,
          ),
        };
      });
      toast.success(`${member.name} is now ${newRole}`);
    } else {
      toast.error('Failed to change role');
    }
  }

  // ── Remove member ────────────────────────────────────────────────────────────

  async function handleRemoveConfirm() {
    if (!pendingRemoveMember) return;
    const member = pendingRemoveMember;
    setIsMutating(true);
    const res = await fetchCp<{ ok: true }>(
      `/api/cp/team/members/${member.id}`,
      { method: 'DELETE' },
    );
    setIsMutating(false);
    setPendingRemoveMember(null);
    if (res.ok) {
      setTeamData((prev) => {
        if (!prev) return prev;
        return { ...prev, members: prev.members.filter((m) => m.id !== member.id) };
      });
      toast.success(`${member.name} removed from the org`);
    } else {
      toast.error('Failed to remove member');
    }
  }

  // ── Resend invite ────────────────────────────────────────────────────────────

  async function handleResendInvite(invite: TeamInviteRow) {
    // No AlertDialog — resend is non-destructive
    const res = await cpPost<{ ok: true }>('/api/cp/team', {
      email: invite.email,
      role: invite.role,
    });
    if (res.ok) {
      toast.success(`Invite resent to ${invite.email}`);
    } else {
      toast.error('Failed to resend invite');
    }
  }

  // ── Revoke invite ────────────────────────────────────────────────────────────

  async function handleRevokeInviteConfirm() {
    if (!pendingRevokeInvite) return;
    const invite = pendingRevokeInvite;
    setIsMutating(true);
    const res = await cpPost<{ ok: true }>(
      `/api/cp/team/invites/${invite.id}/revoke`,
      {},
    );
    setIsMutating(false);
    setPendingRevokeInvite(null);
    if (res.ok) {
      setTeamData((prev) => {
        if (!prev) return prev;
        return { ...prev, invites: prev.invites.filter((i) => i.id !== invite.id) };
      });
      toast.success(`Invite to ${invite.email} revoked`);
    } else {
      toast.error('Failed to revoke invite');
    }
  }

  // ── Revoke delegation ────────────────────────────────────────────────────────

  async function handleRevokeDelegationConfirm() {
    if (!pendingRevokeDelegation) return;
    const delegation = pendingRevokeDelegation;
    setIsMutating(true);
    const res = await cpPost<{ ok: true }>(
      `/api/cp/team/delegations/${delegation.id}/revoke`,
      {},
    );
    setIsMutating(false);
    setPendingRevokeDelegation(null);
    if (res.ok) {
      setDelegations((prev) =>
        prev?.map((d) =>
          d.id === delegation.id ? { ...d, status: 'revoked' as const } : d,
        ) ?? null,
      );
      toast.success(`Delegation for ${delegation.agentName} revoked`);
    } else {
      toast.error('Failed to revoke delegation');
    }
  }

  // ── Derived counts ───────────────────────────────────────────────────────────

  const members = teamData?.members ?? [];
  const invites = teamData?.invites ?? [];
  const allDelegations = delegations ?? [];
  const ownerCount = members.filter((m) => m.role === 'owner').length;

  const isLoading = teamData === null || delegations === null;

  return (
    <div className="flex flex-col gap-6">
      {/* Page header */}
      <PageHeader
        title="Team"
        description="People in your organization and the agents they've lent access to."
        actions={
          <Button onClick={() => setInviteOpen(true)}>
            <UserPlus className="mr-1.5 size-3.5" aria-hidden="true" />
            Invite member
          </Button>
        }
      />

      {/* ── Members section ────────────────────────────────────────────────────── */}
      <SectionCard
        title="Members"
        contentClassName="p-0"
      >
        {isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        ) : members.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={<Users />}
              title="No members"
              description="You're the only one here. Invite someone to get started."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead className="hidden sm:table-cell">Role</TableHead>
                  <TableHead className="hidden md:table-cell">Status</TableHead>
                  <TableHead className="hidden lg:table-cell">Joined</TableHead>
                  <TableHead className="w-10" aria-label="Row actions" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((member) => {
                  const isSoleOwner = member.role === 'owner' && ownerCount === 1;
                  const cannotRemove = isSoleOwner || !!member.isCurrentUser;
                  const cannotDemote = isSoleOwner;

                  return (
                    <TableRow key={member.id}>
                      {/* Avatar + name + email */}
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <Avatar size="sm" aria-hidden="true">
                            <AvatarFallback>
                              {getInitials(member.name)}
                            </AvatarFallback>
                          </Avatar>
                          <div className="flex flex-col gap-0.5 min-w-0">
                            <span className="font-medium leading-none truncate">
                              {member.name}
                              {member.isCurrentUser && (
                                <span className="ml-1.5 text-xs text-muted-foreground font-normal">
                                  (you)
                                </span>
                              )}
                            </span>
                            <span className="text-xs text-muted-foreground truncate">
                              {member.email}
                            </span>
                          </div>
                        </div>
                      </TableCell>

                      {/* Role */}
                      <TableCell className="hidden sm:table-cell">
                        <RoleBadge role={member.role} />
                      </TableCell>

                      {/* Status */}
                      <TableCell className="hidden md:table-cell">
                        <Badge
                          variant="outline"
                          className={
                            member.status === 'active'
                              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                              : 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400'
                          }
                        >
                          {member.status === 'active' ? 'Active' : 'Invited'}
                        </Badge>
                      </TableCell>

                      {/* Joined */}
                      <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">
                        {formatRelative(member.joinedAt)}
                      </TableCell>

                      {/* Actions */}
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Actions for ${member.name}`}
                              className="size-7"
                            >
                              <MoreHorizontal className="size-4" aria-hidden="true" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-52">
                            {/* Role change items — shown for non-owner-locked members */}
                            {cannotDemote ? (
                              <DropdownMenuItem
                                disabled
                                className="cursor-not-allowed"
                              >
                                <span className="flex flex-col gap-0.5">
                                  <span>Change role</span>
                                  <span className="text-xs text-muted-foreground font-normal">
                                    Sole owner — transfer ownership first
                                  </span>
                                </span>
                              </DropdownMenuItem>
                            ) : (
                              <>
                                {member.role !== 'admin' && (
                                  <DropdownMenuItem
                                    onSelect={() => void handleRoleChange(member, 'admin')}
                                  >
                                    Make admin
                                  </DropdownMenuItem>
                                )}
                                {member.role !== 'member' && (
                                  <DropdownMenuItem
                                    onSelect={() => void handleRoleChange(member, 'member')}
                                  >
                                    Make member
                                  </DropdownMenuItem>
                                )}
                              </>
                            )}
                            <DropdownMenuSeparator />
                            {cannotRemove ? (
                              <DropdownMenuItem
                                disabled
                                className="cursor-not-allowed"
                              >
                                <span className="flex flex-col gap-0.5">
                                  <span>Remove</span>
                                  <span className="text-xs text-muted-foreground font-normal">
                                    {isSoleOwner
                                      ? 'Sole owner — transfer ownership first'
                                      : "Can't remove yourself"}
                                  </span>
                                </span>
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={() => setPendingRemoveMember(member)}
                              >
                                Remove
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Pending invites sub-list */}
        {!isLoading && invites.length > 0 && (
          <div className="border-t px-4 py-3">
            <h3 className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Pending invites
            </h3>
            <ul className="flex flex-col gap-1">
              {invites.map((invite) => (
                <li
                  key={invite.id}
                  className="flex items-center justify-between gap-3 rounded-lg px-1 py-1.5"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Avatar size="sm" aria-hidden="true">
                      <AvatarFallback className="text-muted-foreground">
                        <Mail className="size-3" />
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <span className="text-sm font-medium truncate">{invite.email}</span>
                      <span className="text-xs text-muted-foreground">
                        Invited {formatRelative(invite.invitedAt)} · as{' '}
                        <span className="capitalize">{invite.role}</span>
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Badge
                      variant="outline"
                      className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                    >
                      Pending
                    </Badge>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Actions for invite to ${invite.email}`}
                          className="size-7"
                        >
                          <MoreHorizontal className="size-4" aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onSelect={() => void handleResendInvite(invite)}
                        >
                          Resend invite
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => setPendingRevokeInvite(invite)}
                        >
                          Revoke invite
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </SectionCard>

      {/* ── Delegated access section ──────────────────────────────────────────── */}
      <SectionCard title="Delegated access">
        <p className="text-sm text-muted-foreground mb-4">
          When a team member delegates access to an agent, that agent can act with the
          intersection of the member's grants and the agent's own grants — derived per
          session and never stored. Revoking a delegation takes effect immediately on
          any new session.
        </p>

        {isLoading ? (
          <div className="flex flex-col gap-2">
            {[1, 2].map((i) => (
              <Skeleton key={i} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        ) : allDelegations.length === 0 ? (
          <EmptyState
            icon={<Bot />}
            title="No delegated access yet"
            description="When a member grants an agent access on their behalf, it will appear here."
          />
        ) : (
          <div className="overflow-x-auto -mx-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Principal</TableHead>
                  <TableHead className="hidden sm:table-cell">Agent</TableHead>
                  <TableHead className="hidden md:table-cell">Scope</TableHead>
                  <TableHead className="hidden lg:table-cell">Granted</TableHead>
                  <TableHead className="hidden sm:table-cell">Status</TableHead>
                  <TableHead className="w-10" aria-label="Row actions" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {allDelegations.map((dlg) => (
                  <TableRow key={dlg.id} className={dlg.status === 'revoked' ? 'opacity-50' : undefined}>
                    {/* Principal (human) */}
                    <TableCell>
                      <div className="flex flex-col gap-0.5">
                        <span className="font-medium text-sm leading-none">
                          {dlg.principalName}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {dlg.principalEmail}
                        </span>
                      </div>
                    </TableCell>

                    {/* Agent → link to /lab/agents/[id] */}
                    <TableCell className="hidden sm:table-cell">
                      <Link
                        href={`/lab/agents/${dlg.agentId}`}
                        className="group inline-flex items-center gap-1.5 rounded text-sm font-medium hover:underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label={`View agent ${dlg.agentName}`}
                      >
                        <Bot className="size-3.5 text-muted-foreground" aria-hidden="true" />
                        {dlg.agentName}
                      </Link>
                    </TableCell>

                    {/* Scope summary */}
                    <TableCell className="hidden text-sm text-muted-foreground md:table-cell max-w-xs truncate">
                      {dlg.scopeSummary}
                    </TableCell>

                    {/* Granted relative */}
                    <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">
                      <span className="inline-flex items-center gap-1">
                        <Clock className="size-3" aria-hidden="true" />
                        {formatRelative(dlg.grantedAt)}
                      </span>
                    </TableCell>

                    {/* Status badge */}
                    <TableCell className="hidden sm:table-cell">
                      <Badge
                        variant="outline"
                        className={
                          dlg.status === 'active'
                            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                            : 'border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400'
                        }
                      >
                        {dlg.status === 'active' ? 'Active' : 'Revoked'}
                      </Badge>
                    </TableCell>

                    {/* Actions */}
                    <TableCell>
                      {dlg.status === 'active' ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Actions for delegation from ${dlg.principalName} to ${dlg.agentName}`}
                              className="size-7"
                            >
                              <MoreHorizontal className="size-4" aria-hidden="true" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem asChild>
                              <Link href={`/lab/agents/${dlg.agentId}`}>
                                View agent
                              </Link>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              onSelect={() => setPendingRevokeDelegation(dlg)}
                            >
                              Revoke delegation
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : (
                        // Revoked rows: no actions available
                        <span className="sr-only">No actions — revoked</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      {/* ── Invite dialog ─────────────────────────────────────────────────────── */}
      <InviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onInvited={(invite) => {
          setTeamData((prev) =>
            prev ? { ...prev, invites: [...prev.invites, invite] } : prev,
          );
        }}
      />

      {/* ── Remove member AlertDialog ─────────────────────────────────────────── */}
      <AlertDialog
        open={!!pendingRemoveMember}
        onOpenChange={(open) => !open && setPendingRemoveMember(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {pendingRemoveMember?.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRemoveMember?.name} will lose access to all org resources
              immediately. Their agent connections and delegations will also be
              revoked. This cannot be undone without re-inviting them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isMutating}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isMutating}
              // eslint-disable-next-line @typescript-eslint/no-misused-promises
              onClick={handleRemoveConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isMutating ? 'Removing…' : 'Remove member'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Revoke invite AlertDialog ─────────────────────────────────────────── */}
      <AlertDialog
        open={!!pendingRevokeInvite}
        onOpenChange={(open) => !open && setPendingRevokeInvite(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Revoke invite to {pendingRevokeInvite?.email}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The invitation link will be invalidated. They will not be able to join
              unless you send a new invite.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isMutating}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isMutating}
              // eslint-disable-next-line @typescript-eslint/no-misused-promises
              onClick={handleRevokeInviteConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isMutating ? 'Revoking…' : 'Revoke invite'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Revoke delegation AlertDialog ─────────────────────────────────────── */}
      {/* Conditionally mounted so the dialog never lingers in the DOM with null
          values during Radix's exit animation (which exposed a malformed,
          empty-name heading to screen readers). */}
      {pendingRevokeDelegation && (
        <AlertDialog
          open
          onOpenChange={(open) => !open && setPendingRevokeDelegation(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Revoke {pendingRevokeDelegation.agentName}&apos;s delegated access?
              </AlertDialogTitle>
              <AlertDialogDescription>
                {pendingRevokeDelegation.agentName} will no longer be able to act on
                behalf of {pendingRevokeDelegation.principalName}. Any active sessions
                using this delegation will be terminated. This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isMutating}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={isMutating}
                // eslint-disable-next-line @typescript-eslint/no-misused-promises
                onClick={handleRevokeDelegationConfirm}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {isMutating ? 'Revoking…' : 'Revoke delegation'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
