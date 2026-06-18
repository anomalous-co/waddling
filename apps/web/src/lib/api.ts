/** SWR fetcher that throws the API's `{ error }` message on non-2xx. */
export async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

/** JSON POST/PATCH/DELETE helper that throws the API's `{ error }` message. */
export async function mutateJson<T>(
  url: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok && res.status !== 204) {
    const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(errBody?.error ?? res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
