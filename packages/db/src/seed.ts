// Per-instance PII / "memory" datasets. Each instance gets the SAME table shapes
// but DIFFERENT fake data + a different local user, so the federation/ACL demo is
// concrete: birdshot lets quack peers read the shared `todos` but gates each
// instance's contacts / addresses / memories (PII) by role.
//
// These tables live in the federated PGlite store (`db`) and are exposed to
// DuckDB as views (see stack.ts), so they ARE reachable in the catalog — and are
// protected by birdshot ACLs (peer role: no PII; member/owner: PII), NOT by
// physical isolation. That's the point: birdshot guards attached data by role.

import type { PGlite } from "@electric-sql/pglite";

export interface InstanceDataset {
  /** Local human user for this instance (distinct per instance). */
  localUser: { id: string; name: string; email: string };
  contacts: { name: string; email: string; phone: string }[];
  addresses: { label: string; street: string; city: string; region: string; postal: string }[];
  memories: { title: string; body: string }[];
}

const DATASETS: Record<string, InstanceDataset> = {
  A: {
    localUser: { id: "user-a-alice", name: "Alice Avery", email: "alice@angstrom.test" },
    contacts: [
      { name: "Arjun Anand", email: "arjun@angstrom.test", phone: "+1-415-555-0143" },
      { name: "Amara Okafor", email: "amara@angstrom.test", phone: "+1-415-555-0198" },
      { name: "Aoife Byrne", email: "aoife@angstrom.test", phone: "+1-510-555-0112" },
    ],
    addresses: [
      { label: "HQ", street: "120 Angstrom Way", city: "San Francisco", region: "CA", postal: "94107" },
      { label: "Warehouse", street: "55 Pier St", city: "Oakland", region: "CA", postal: "94607" },
    ],
    memories: [
      { title: "Onboarding note", body: "Alice prefers async standups; allergic to penicillin." },
      { title: "Deal context", body: "Angstrom renewal closes Q3; champion is Arjun." },
    ],
  },
  B: {
    localUser: { id: "user-b-bjorn", name: "Bjorn Berg", email: "bjorn@borealis.test" },
    contacts: [
      { name: "Bianca Bello", email: "bianca@borealis.test", phone: "+1-212-555-0177" },
      { name: "Bushra Basha", email: "bushra@borealis.test", phone: "+1-212-555-0165" },
      { name: "Bao Tran", email: "bao@borealis.test", phone: "+1-718-555-0190" },
    ],
    addresses: [
      { label: "HQ", street: "9 Borealis Blvd", city: "New York", region: "NY", postal: "10013" },
      { label: "Studio", street: "201 Kent Ave", city: "Brooklyn", region: "NY", postal: "11249" },
    ],
    memories: [
      { title: "Onboarding note", body: "Bjorn works EU hours; emergency contact is Bianca." },
      { title: "Deal context", body: "Borealis pilot started May; blocker is SSO." },
    ],
  },
};

/** The dataset for an instance label, falling back to a generic one. */
export function datasetFor(instance: string): InstanceDataset {
  return DATASETS[instance] ?? DATASETS.A;
}

/** Create the PII tables in `db` and seed this instance's data (idempotent). */
export async function seedInstanceData(db: PGlite, instance: string): Promise<InstanceDataset> {
  const data = datasetFor(instance);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id    SERIAL PRIMARY KEY,
      name  TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT
    );
    CREATE TABLE IF NOT EXISTS addresses (
      id     SERIAL PRIMARY KEY,
      label  TEXT NOT NULL,
      street TEXT NOT NULL,
      city   TEXT NOT NULL,
      region TEXT,
      postal TEXT
    );
    CREATE TABLE IF NOT EXISTS memories (
      id         SERIAL PRIMARY KEY,
      title      TEXT NOT NULL,
      body       TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT now()
    );
  `);

  // Only seed when empty so restarts don't duplicate rows.
  const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM contacts");
  if (rows[0]?.n === 0) {
    for (const c of data.contacts) {
      await db.query("INSERT INTO contacts (name, email, phone) VALUES ($1, $2, $3)", [c.name, c.email, c.phone]);
    }
    for (const a of data.addresses) {
      await db.query("INSERT INTO addresses (label, street, city, region, postal) VALUES ($1, $2, $3, $4, $5)", [
        a.label,
        a.street,
        a.city,
        a.region,
        a.postal,
      ]);
    }
    for (const m of data.memories) {
      await db.query("INSERT INTO memories (title, body) VALUES ($1, $2)", [m.title, m.body]);
    }
  }
  return data;
}
