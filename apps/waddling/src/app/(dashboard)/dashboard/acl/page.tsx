'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Card,
  CardHeader,
  Badge,
  statusVariant,
  Button,
  Spinner,
  ErrorState,
  EmptyState,
  SectionTitle,
  Table,
  Td,
  Input,
  Label,
  Select,
  UpgradeBanner,
} from '@/components/dashboard/ui';
import { fetchCp, cpPost, cpDelete } from '@/components/dashboard/fetch';
import type { AclRuleInput, EndpointSummary, AgentSummary } from '@/lib/types';

interface AclRuleRow {
  id: string;
  endpointId: string;
  agentId?: string;
  schemaName: string;
  tableName: string;
  columns?: string[];
  verb: 'read' | 'write';
  effect: 'allow' | 'deny';
  rowLimit?: number;
  ttlSeconds?: number;
  windowStart?: string;
  windowEnd?: string;
  expiresAt?: string;
  priority: number;
  createdAt: string;
}

const DEFAULT_FORM: AclRuleInput = {
  endpointId: '',
  agentId: '',
  schema: '*',
  table: '*',
  columns: undefined,
  verb: 'read',
  effect: 'allow',
  rowLimit: undefined,
  ttlSeconds: undefined,
};

function RuleBuilder({
  endpoints,
  agents,
  onCreated,
}: {
  endpoints: EndpointSummary[];
  agents: AgentSummary[];
  onCreated: (rule: AclRuleRow) => void;
}) {
  const [form, setForm] = useState<AclRuleInput>(DEFAULT_FORM);
  const [columnsRaw, setColumnsRaw] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [upgradeRequired, setUpgradeRequired] = useState(false);

  const submit = async () => {
    if (!form.endpointId) {
      setError('Endpoint is required');
      return;
    }
    setLoading(true);
    setError(null);
    setUpgradeRequired(false);

    const payload: AclRuleInput = {
      ...form,
      agentId: form.agentId || undefined,
      columns: columnsRaw.trim()
        ? columnsRaw.split(',').map((c) => c.trim()).filter(Boolean)
        : undefined,
    };

    const res = await cpPost<{ rule: AclRuleRow }>('/api/cp/acl', payload);
    setLoading(false);
    if (!res.ok) {
      if (res.status === 402 || res.code === 'upgrade_required') {
        setUpgradeRequired(true);
      } else {
        setError(res.error);
      }
      return;
    }
    onCreated(res.data.rule);
    setForm(DEFAULT_FORM);
    setColumnsRaw('');
  };

  const set = <K extends keyof AclRuleInput>(k: K, v: AclRuleInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  return (
    <Card>
      <CardHeader
        title="Add ACL rule"
        subtitle="Define who can access what resource. Deny wins over allow on priority tie."
      />
      {upgradeRequired && (
        <div className="mb-4">
          <UpgradeBanner message="Dynamic ACL rules require the Pro plan. Free tier supports static reader/writer roles only." />
        </div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <div>
          <Label htmlFor="r-endpoint">Endpoint *</Label>
          <Select
            id="r-endpoint"
            value={form.endpointId}
            onChange={(e) => set('endpointId', e.target.value)}
          >
            <option value="">— select —</option>
            {endpoints.map((ep) => (
              <option key={ep.id} value={ep.id}>
                {ep.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="r-agent">Agent (blank = org-wide)</Label>
          <Select
            id="r-agent"
            value={form.agentId ?? ''}
            onChange={(e) => set('agentId', e.target.value || undefined)}
          >
            <option value="">All agents</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="r-schema">Schema</Label>
          <Input
            id="r-schema"
            value={form.schema}
            onChange={(e) => set('schema', e.target.value)}
            placeholder="* or sales"
          />
        </div>
        <div>
          <Label htmlFor="r-table">Table</Label>
          <Input
            id="r-table"
            value={form.table}
            onChange={(e) => set('table', e.target.value)}
            placeholder="* or orders"
          />
        </div>
        <div>
          <Label htmlFor="r-columns">Columns (comma-sep, blank = all)</Label>
          <Input
            id="r-columns"
            value={columnsRaw}
            onChange={(e) => setColumnsRaw(e.target.value)}
            placeholder="id, name, amount"
          />
        </div>
        <div>
          <Label htmlFor="r-verb">Verb</Label>
          <Select
            id="r-verb"
            value={form.verb}
            onChange={(e) => set('verb', e.target.value as 'read' | 'write')}
          >
            <option value="read">read</option>
            <option value="write">write</option>
          </Select>
        </div>
        <div>
          <Label htmlFor="r-effect">Effect</Label>
          <Select
            id="r-effect"
            value={form.effect ?? 'allow'}
            onChange={(e) =>
              set('effect', e.target.value as 'allow' | 'deny')
            }
          >
            <option value="allow">allow</option>
            <option value="deny">deny</option>
          </Select>
        </div>
        <div>
          <Label htmlFor="r-rowlimit">Row limit (blank = ∞)</Label>
          <Input
            id="r-rowlimit"
            type="number"
            value={form.rowLimit ?? ''}
            onChange={(e) =>
              set('rowLimit', e.target.value ? Number(e.target.value) : undefined)
            }
            placeholder="1000"
          />
        </div>
        <div>
          <Label htmlFor="r-ttl">TTL seconds (blank = no expiry)</Label>
          <Input
            id="r-ttl"
            type="number"
            value={form.ttlSeconds ?? ''}
            onChange={(e) =>
              set('ttlSeconds', e.target.value ? Number(e.target.value) : undefined)
            }
            placeholder="3600"
          />
        </div>
      </div>
      {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
      <div className="mt-4">
        <Button variant="primary" onClick={() => void submit()} loading={loading}>
          Add rule
        </Button>
      </div>
    </Card>
  );
}

function ExpiryBadge({ expiresAt }: { expiresAt?: string }) {
  if (!expiresAt) return <span className="text-neutral-600 text-xs">—</span>;
  const d = new Date(expiresAt);
  const expired = d < new Date();
  return (
    <Badge variant={expired ? 'red' : 'yellow'}>
      {expired ? 'expired' : d.toLocaleDateString()}
    </Badge>
  );
}

export default function AclPage() {
  const [rules, setRules] = useState<AclRuleRow[]>([]);
  const [endpoints, setEndpoints] = useState<EndpointSummary[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [rulesRes, endRes, agentRes] = await Promise.all([
      fetchCp<{ rules: AclRuleRow[] }>('/api/cp/acl'),
      fetchCp<{ endpoints: EndpointSummary[] }>('/api/cp/endpoints'),
      fetchCp<{ agents: AgentSummary[] }>('/api/cp/agents'),
    ]);
    if (!rulesRes.ok) {
      setError(rulesRes.error);
    } else {
      setRules(rulesRes.data.rules);
      setEndpoints(endRes.ok ? endRes.data.endpoints : []);
      setAgents(agentRes.ok ? agentRes.data.agents : []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const deleteRule = async (id: string) => {
    const res = await cpDelete<{ ok: boolean }>(`/api/cp/acl/${id}`);
    if (res.ok) {
      setRules((prev) => prev.filter((r) => r.id !== id));
    }
  };

  if (loading)
    return (
      <div className="flex justify-center py-24">
        <Spinner size="lg" />
      </div>
    );
  if (error) return <ErrorState message={error} retry={() => { setLoading(true); void load(); }} />;

  return (
    <div className="space-y-4">
      <SectionTitle>ACL Rules</SectionTitle>

      <RuleBuilder
        endpoints={endpoints}
        agents={agents}
        onCreated={(rule) => setRules((prev) => [rule, ...prev])}
      />

      <Card>
        <CardHeader
          title="Active rules"
          subtitle={`${rules.length} rules — deny wins over allow on priority tie`}
        />
        {rules.length === 0 ? (
          <EmptyState
            title="No ACL rules"
            description="Add a rule above to grant or restrict agent access to tables."
          />
        ) : (
          <Table
            headers={[
              'Endpoint',
              'Agent',
              'Schema.Table',
              'Columns',
              'Verb',
              'Effect',
              'Row limit',
              'Expires',
              '',
            ]}
          >
            {rules.map((r) => (
              <tr key={r.id}>
                <Td mono>{r.endpointId}</Td>
                <Td mono>{r.agentId ?? 'all'}</Td>
                <Td mono>
                  {r.schemaName}.{r.tableName}
                </Td>
                <Td>
                  {r.columns ? r.columns.join(', ') : <span className="text-neutral-600">all</span>}
                </Td>
                <Td>
                  <Badge variant={r.verb === 'read' ? 'blue' : 'yellow'}>
                    {r.verb}
                  </Badge>
                </Td>
                <Td>
                  <Badge variant={statusVariant(r.effect)}>{r.effect}</Badge>
                </Td>
                <Td>{r.rowLimit ?? '∞'}</Td>
                <Td>
                  <ExpiryBadge expiresAt={r.expiresAt} />
                </Td>
                <Td>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => void deleteRule(r.id)}
                  >
                    Delete
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
