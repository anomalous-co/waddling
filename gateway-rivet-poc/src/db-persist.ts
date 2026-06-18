// Persist a DuckDB file into Rivet actor KV (c.kv) and restore it.
// KV per-value cap is 128 KiB, so the file is split into 120 KiB chunks across
// keys `db:chunk:NNNNNN`, with `db:meta` holding {count,size}.
//
// Uses the real rivetkit ActorKv surface: put/get(key,{type}) + deleteRange,
// where keys/range bounds are Uint8Array.

const CHUNK = 120 * 1024;
const enc = new TextEncoder();
const pad = (n: number) => String(n).padStart(6, "0");
const chunkKey = (i: number) => enc.encode(`db:chunk:${pad(i)}`);

/** Minimal subset of rivetkit's ActorKv we use (also satisfied by the test mock). */
export interface KvLike {
  get(key: string | Uint8Array, opts?: { type?: "binary" | "text" }): Promise<string | Uint8Array | null>;
  put(key: string | Uint8Array, value: string | Uint8Array): Promise<void>;
  deleteRange(start: Uint8Array, end: Uint8Array): Promise<void>;
}

export async function persistFile(kv: KvLike, bytes: Uint8Array): Promise<number> {
  // Drop any stale chunks first ([db:chunk: .. db:chunk;) covers all indices).
  await kv.deleteRange(enc.encode("db:chunk:"), enc.encode("db:chunk;"));
  const count = Math.ceil(bytes.length / CHUNK);
  for (let i = 0; i < count; i++) {
    const slice = bytes.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, bytes.length));
    await kv.put(chunkKey(i), new Uint8Array(slice)); // copy off the shared buffer
  }
  await kv.put("db:meta", JSON.stringify({ count, size: bytes.length }));
  return count;
}

export async function restoreFile(kv: KvLike): Promise<Uint8Array | null> {
  const metaRaw = (await kv.get("db:meta")) as string | null;
  if (!metaRaw) return null;
  const { count, size } = JSON.parse(metaRaw) as { count: number; size: number };
  const out = new Uint8Array(size);
  let off = 0;
  for (let i = 0; i < count; i++) {
    const chunk = (await kv.get(chunkKey(i), { type: "binary" })) as Uint8Array | null;
    if (!chunk) throw new Error(`missing chunk ${i}/${count}`);
    out.set(chunk, off);
    off += chunk.length;
  }
  if (off !== size) throw new Error(`reassembled size ${off} != ${size}`);
  return out;
}
