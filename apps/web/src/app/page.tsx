import Link from "next/link";
import { Dashboard } from "@/components/dashboard";
import { Badge } from "@/components/ui/badge";
import type { InstanceInfo } from "@/lib/types";

// Live, per-request: identity comes from this instance's env.
export const dynamic = "force-dynamic";

export default function Home() {
  const info: InstanceInfo = {
    instance: process.env.INSTANCE ?? "A",
    port: process.env.PORT ?? "3000",
    quackPort: process.env.QUACK_PORT ?? "9494",
    peerQuackPort: process.env.PEER_QUACK_PORT ?? "9495",
  };

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-6 py-10">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            PGlite × DuckDB <span className="font-mono">quack</span> analytics
          </h1>
          <Badge variant="secondary">Instance {info.instance}</Badge>
          <Link
            href="/agents"
            className="ml-auto text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Agents →
          </Link>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Each instance stores todos in its own PGlite database and exposes them
          to DuckDB over the Postgres wire. DuckDB federates the two instances
          over the quack protocol, so each side can run analytics across the
          other&apos;s data. This is instance{" "}
          <span className="font-medium text-foreground">{info.instance}</span> on
          port {info.port} — quack {info.quackPort}, peer quack{" "}
          {info.peerQuackPort}.
        </p>
      </header>

      <Dashboard info={info} />
    </main>
  );
}
