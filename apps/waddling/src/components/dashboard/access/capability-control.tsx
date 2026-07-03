'use client';

/**
 * Compact per-object capability control (Diagnosis #4 → shaped privileges).
 * A single button summarizing the granted verbs, opening a menu that leads with
 * the three PRESETS (Read / Write / Manage) and reveals the ten granular
 * primitives under "Advanced" (progressive disclosure, P5).
 *
 * Controlled: `privileges` in, `onChange` out. Preset rows toggle their members
 * additively; Advanced toggles individual privileges. "None" clears.
 */
import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { PRIVILEGES, type Privilege } from './access-draft';

const PRESETS: { label: string; members: Privilege[] }[] = [
  { label: 'Read', members: ['SELECT'] },
  { label: 'Write', members: ['INSERT', 'UPDATE', 'DELETE'] },
  { label: 'Manage', members: ['CREATE', 'DROP', 'ALTER'] },
];

const has = (set: string[], members: Privilege[]) => members.every((m) => set.includes(m));

/** Human summary: "None" / "Read" / "Read + Write" / "Read + USAGE" / "SELECT, INSERT". */
export function summarizePrivileges(privileges: string[]): string {
  if (privileges.length === 0) return 'None';
  const covered = new Set<string>();
  const parts: string[] = [];
  for (const p of PRESETS) {
    if (has(privileges, p.members)) {
      parts.push(p.label);
      p.members.forEach((m) => covered.add(m));
    }
  }
  const ordered = PRIVILEGES.filter((p) => privileges.includes(p) && !covered.has(p));
  parts.push(...ordered);
  return parts.join(' + ');
}

export function CapabilityControl({
  privileges,
  onChange,
  disabled,
  align = 'end',
}: {
  privileges: string[];
  onChange: (next: Privilege[]) => void;
  disabled?: boolean;
  align?: 'start' | 'end';
}) {
  const [advanced, setAdvanced] = useState(false);
  const label = summarizePrivileges(privileges);
  const none = privileges.length === 0;

  const togglePreset = (members: Privilege[]) => {
    const on = has(privileges, members);
    const set = new Set(privileges);
    if (on) members.forEach((m) => set.delete(m));
    else members.forEach((m) => set.add(m));
    onChange(PRIVILEGES.filter((p) => set.has(p)));
  };
  const togglePrivilege = (p: Privilege) => {
    const set = new Set(privileges);
    set.has(p) ? set.delete(p) : set.add(p);
    onChange(PRIVILEGES.filter((x) => set.has(x)));
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          className={cn('h-7 w-40 justify-between font-normal', none && 'text-muted-foreground')}
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-52">
        <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Presets
        </DropdownMenuLabel>
        {PRESETS.map((p) => (
          <DropdownMenuCheckboxItem
            key={p.label}
            checked={has(privileges, p.members)}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={() => togglePreset(p.members)}
          >
            <span className="flex-1">{p.label}</span>
            <span className="font-mono text-[10px] text-muted-foreground">{p.members.join(', ')}</span>
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            setAdvanced((v) => !v);
          }}
          className="text-xs text-muted-foreground"
        >
          <ChevronDown className={cn('size-3.5 transition-transform', !advanced && '-rotate-90')} />
          Advanced privileges
        </DropdownMenuItem>
        {advanced &&
          PRIVILEGES.map((p) => (
            <DropdownMenuCheckboxItem
              key={p}
              checked={privileges.includes(p)}
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={() => togglePrivilege(p)}
              className="font-mono text-xs"
            >
              {p}
            </DropdownMenuCheckboxItem>
          ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={none}
          onSelect={(e) => {
            e.preventDefault();
            onChange([]);
          }}
          className="text-xs"
        >
          Clear (None)
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
