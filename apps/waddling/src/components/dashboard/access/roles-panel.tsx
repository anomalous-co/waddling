'use client';

/**
 * Roles & membership (§5.5, progressive). Two things:
 *  - Membership: the roles THIS key holds (chips) + an "add role" menu populated
 *    from the org's roles. Adding → GRANT <role> TO <subject> (a draft membership).
 *  - Grant to a role (admin): flagged org-wide, propagates to every holder.
 *
 * Role/PUBLIC targets + membership authoring are owner/admin-gated server-side
 * (403 for non-admins), so when `isAdmin` is false the authoring affordances are
 * visibly disabled with a "requires admin" hint rather than erroring on submit.
 */
import { UserCog, Plus, X, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export interface RoleSummary {
  name: string;
  memberCount: number;
}

export function RolesPanel({
  roles,
  heldRoles,
  isAdmin,
  onAddRole,
  onRemoveRole,
}: {
  roles: RoleSummary[];
  heldRoles: string[];
  isAdmin: boolean;
  onAddRole: (role: string) => void;
  onRemoveRole: (role: string) => void;
}) {
  const available = roles.filter((r) => !heldRoles.includes(r.name));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="flex items-center justify-between border-b pb-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Roles this key holds
          </span>
          {!isAdmin && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                  <ShieldAlert className="size-3" /> requires admin
                </span>
              </TooltipTrigger>
              <TooltipContent>Managing role membership is restricted to org owners and admins.</TooltipContent>
            </Tooltip>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {heldRoles.length === 0 && (
            <span className="text-sm text-muted-foreground">No roles held.</span>
          )}
          {heldRoles.map((r) => (
            <span
              key={r}
              className="inline-flex items-center gap-1.5 rounded-md border bg-muted/50 px-2 py-1 text-sm"
            >
              <UserCog className="size-3.5 text-muted-foreground" />
              <span className="font-mono">{r}</span>
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => onRemoveRole(r)}
                  className="text-muted-foreground hover:text-destructive"
                  aria-label={`Remove role ${r}`}
                >
                  <X className="size-3.5" />
                </button>
              )}
            </span>
          ))}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" disabled={!isAdmin || available.length === 0} className="h-8">
                <Plus className="size-3.5" /> Add role
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-52">
              <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Grant a role
              </DropdownMenuLabel>
              {available.map((r) => (
                <DropdownMenuItem key={r.name} onSelect={() => onAddRole(r.name)}>
                  <span className="flex-1 font-mono text-sm">{r.name}</span>
                  <span className="text-[10px] text-muted-foreground">~{r.memberCount} members</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <p className={cn('text-xs text-muted-foreground', !isAdmin && 'opacity-70')}>
        Adding a role grants this key everything that role can do — inherited access shows up in the
        object tree with a{' '}
        <span className="rounded bg-muted px-1 py-0.5 text-[10px]">via role</span> chip. Managing what a
        role itself can do is org-wide and lives on the role, not this key.
      </p>
    </div>
  );
}
