"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// No agent-listing endpoint exists yet, so this is a lookup entry point into
// the per-agent grant view. Once control-api exposes a list, render it here.
export default function AgentsPage() {
  const router = useRouter();
  const [agentId, setAgentId] = useState("");
  const [datalakeId, setDatalakeId] = useState("");

  function open(e: React.FormEvent) {
    e.preventDefault();
    const id = agentId.trim();
    if (!id) return;
    const qs = datalakeId.trim()
      ? `?datalakeId=${encodeURIComponent(datalakeId.trim())}`
      : "";
    router.push(`/agents/${encodeURIComponent(id)}${qs}`);
  }

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-6 py-10">
      <header className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Open an agent key to view the literal GRANT / DENY SQL it resolves to
          and author its access.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Open an agent</CardTitle>
          <CardDescription>
            Enter the agent key id. A datalake id is optional but required to
            author rules.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={open} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="agent-id">Agent id</Label>
              <Input
                id="agent-id"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                placeholder="123"
                autoComplete="off"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="datalake-id">Datalake id (optional)</Label>
              <Input
                id="datalake-id"
                value={datalakeId}
                onChange={(e) => setDatalakeId(e.target.value)}
                placeholder="dl_…"
                autoComplete="off"
              />
            </div>
            <Button type="submit" disabled={!agentId.trim()} className="w-fit">
              Open
              <ArrowRightIcon data-icon="inline-end" />
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
