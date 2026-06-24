'use client';

/**
 * Agent access surface (on the agent detail page) — shows what an agent can reach
 * (catalog grants + external source/extension policies) read-only, with a single
 * "Edit access" button that opens the shared AccessEditorDialog. The dialog owns
 * the editing, diffing, and save (incl. the confirm-on-removal gate).
 */
import { useEffect, useState, useCallback } from 'react';
import { Pencil, RefreshCw } from 'lucide-react';
import {
  Card, CardHeader, CardTitle, CardDescription, CardContent,
} from '@/components/ui/card';
import {
  Table, TableHeader, TableRow, TableHead, TableBody, TableCell,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@/components/ui/empty';
import { fetchCp } from '@/components/dashboard/fetch';
import { AccessEditorDialog } from '@/components/dashboard/access-editor-dialog';

interface AclRuleRow {
  id: string;
  datalakeId: string;
  capability: string;
  schemaName: string;
  tableName: string;
  columns?: string[];
  effect: 'allow' | 'deny';
}
interface AclPolicyRow { id: string; datalakeId?: string; capability: string; pattern: string }

function targetLabel(r: AclRuleRow): string {
  if (r.schemaName === '*') return 'entire lake';
  if (r.tableName === '*') return `${r.schemaName}.* (whole schema)`;
  return `${r.schemaName}.${r.tableName}`;
}

export function AgentAccess({ agentId }: { agentId: string }) {
  const [rules, setRules] = useState<AclRuleRow[]>([]);
  const [policies, setPolicies] = useState<AclPolicyRow[]>([]);
  const [datalakes, setDatalakes] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  const load = useCallback(async () => {
    const [aclRes, polRes, lakesRes] = await Promise.all([
      fetchCp<{ rules: AclRuleRow[] }>(`/api/cp/acl?agentId=${agentId}`),
      fetchCp<{ policies: AclPolicyRow[] }>(`/api/cp/acl-policy?agentId=${agentId}`),
      fetchCp<{ datalakes: { id: string; name: string }[] }>('/api/cp/datalakes'),
    ]);
    if (!aclRes.ok) setError(aclRes.error);
    else { setRules(aclRes.data.rules.filter((r) => r.capability)); setError(null); }
    if (polRes.ok) setPolicies(polRes.data.policies);
    if (lakesRes.ok) setDatalakes(lakesRes.data.datalakes.map((d) => ({ id: d.id, name: d.name })));
    setLoading(false);
  }, [agentId]);

  useEffect(() => { void load(); }, [load]);

  const lakeName = (id?: string) => (id ? datalakes.find((d) => d.id === id)?.name ?? id.slice(0, 8) : 'all lakes');

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <div>
          <CardTitle>Access</CardTitle>
          <CardDescription>Tables, capabilities, and external sources this agent is granted.</CardDescription>
        </div>
        {!loading && !error && (
          <Button size="sm" onClick={() => setEditOpen(true)} disabled={datalakes.length === 0}>
            <Pencil className="size-3.5" /> Edit access
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <div className="flex items-center gap-2 text-sm text-destructive">
            {error}
            <Button size="sm" variant="ghost" onClick={() => { setLoading(true); void load(); }}>
              <RefreshCw className="size-3.5" /> Retry
            </Button>
          </div>
        ) : rules.length === 0 && policies.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No access yet</EmptyTitle>
              <EmptyDescription>This agent can&apos;t reach any data until you grant access.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col gap-5">
            {rules.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Data lake</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>Capability</TableHead>
                    <TableHead>Columns</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rules.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="text-muted-foreground">{lakeName(r.datalakeId)}</TableCell>
                      <TableCell className="font-mono text-xs">{targetLabel(r)}</TableCell>
                      <TableCell>
                        <Badge variant={r.effect === 'deny' ? 'destructive' : 'secondary'}>
                          {r.effect === 'deny' ? `deny ${r.capability}` : r.capability}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {r.columns?.length ? r.columns.join(', ') : 'all'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {policies.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">External sources &amp; extensions</p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Data lake</TableHead>
                      <TableHead>Capability</TableHead>
                      <TableHead>Pattern</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {policies.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="text-muted-foreground">{lakeName(p.datalakeId)}</TableCell>
                        <TableCell><Badge variant="secondary">{p.capability}</Badge></TableCell>
                        <TableCell className="font-mono text-xs break-all">{p.pattern}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        )}
      </CardContent>

      {editOpen && (
        <AccessEditorDialog
          mode="edit"
          open={editOpen}
          onOpenChange={setEditOpen}
          datalakes={datalakes}
          agentId={agentId}
          onSaved={() => { setLoading(true); void load(); }}
        />
      )}
    </Card>
  );
}
