import './globals.css';
import { RootProvider } from 'fumadocs-ui/provider/next';
import type { ReactNode } from 'react';
import { PostHogSetup } from '@/lib/posthog-client';
import { Geist } from "next/font/google";
import localFont from "next/font/local";
import { cn } from "@/lib/utils";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

// Coiny (SIL OFL) — the rounded display face used for the "waddling" wordmark.
const coiny = localFont({
  src: './fonts/Coiny-Regular.ttf',
  weight: '400',
  display: 'swap',
  variable: '--font-coiny',
});

export const metadata = {
  title: 'waddling — Dynamic ACLs for AI agents',
  description:
    'Provision, govern, and monitor analytics database access for LLM agents over DuckDB / DuckLake.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={cn("font-sans", geist.variable, coiny.variable)}>
      <body className="flex flex-col min-h-screen">
        {/* next-themes (via fumadocs RootProvider) injects a pre-hydration inline theme
            script; the SWC transform wraps its functions with `__name(fn, "name")`, but
            that esbuild/keepNames helper isn't defined in the inline browser scope → an
            app-wide `__name is not defined` ReferenceError that kills the theme script.
            Shim it as identity BEFORE that script runs (first body child = first to
            execute). No-op if already defined. */}
        <script
          dangerouslySetInnerHTML={{
            __html: 'globalThis.__name||(globalThis.__name=function(f){return f});',
          }}
        />
        {/* PostHogSetup is a no-op passthrough when NEXT_PUBLIC_POSTHOG_KEY is unset */}
        <PostHogSetup>
          {/* Ship dark by default (the brand's first impression); the toggle
              lets visitors opt into light. Swap to defaultTheme: 'system' to
              follow the OS preference instead. */}
          <RootProvider theme={{ defaultTheme: 'dark', enableSystem: true }}>
            {children}
          </RootProvider>
        </PostHogSetup>
      </body>
    </html>
  );
}
