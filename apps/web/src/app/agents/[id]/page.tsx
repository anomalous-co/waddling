import Link from "next/link";
import { ArrowLeftIcon } from "lucide-react";
import { AgentGrants } from "@/components/agent-grants";
import { Badge } from "@/components/ui/badge";

// Access is resolved live from the control plane per request.
export const dynamic = "force-dynamic";

export default async function AgentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ datalakeId?: string | string[] }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const datalakeId = Array.isArray(sp.datalakeId)
    ? sp.datalakeId[0]
    : sp.datalakeId;

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-6 py-10">
      <header className="flex flex-col gap-3">
        <Link
          href="/"
          className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="size-3.5" />
          Back
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            Agent access
          </h1>
          <Badge variant="secondary" className="font-mono">
            agent:{id}
          </Badge>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          The literal GRANT / DENY statements this agent key resolves to at the
          gateway, plus the editable rules that produce them.
        </p>
      </header>

      <AgentGrants agentId={id} datalakeId={datalakeId} />
    </main>
  );
}
