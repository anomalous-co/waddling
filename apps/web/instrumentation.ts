// Runs once when the Next.js server process starts. We use it to warm the
// quack stack (PGlite wire server + DuckDB quack endpoint) so this instance's
// federation endpoint is up early and the peer can ATTACH it. Route handlers
// don't rely on this having run — getStack() is self-initializing — but warming
// at boot means the peer doesn't have to wait for the first request.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getStack } = await import("@pglite-sandbox/db");
    await getStack();
  }
}
