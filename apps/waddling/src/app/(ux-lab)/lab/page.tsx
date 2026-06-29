import { Button } from '@/components/ui/button';

/**
 * Loop 0 — verify-loop smoke test. Confirms: next dev boots, the ungated
 * /lab route renders, shadcn primitives + theme tokens resolve, and Chrome
 * can screenshot it. Replaced by the real lab index once the loop starts.
 */
export default function LabIndex() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-6 bg-background text-foreground">
      <h1 className="text-2xl font-semibold tracking-tight">waddling UX lab</h1>
      <p className="text-muted-foreground">verify-loop smoke test · loop 0</p>
      <div className="flex gap-3">
        <Button>Primary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
      </div>
    </main>
  );
}
