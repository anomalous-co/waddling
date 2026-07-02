// Gateway provisioner. The ONLY component that holds run.admin: it deploys a private per-datalake
// Cloud Run gateway (gw-<slug>, max-instances=1) cloned from the bringup template, so the public,
// internet-facing control-api never gains infra-deploy power. control-api reaches this service via
// service-to-service OIDC; the service is PRIVATE (--no-allow-unauthenticated) and only control-api's
// SA holds run.invoker on it, so Cloud Run IAM IS the auth boundary — we read but don't re-verify the
// caller token. Strong tenant isolation: one OS-level container per datalake, birdshot inside each.
//
// POST /provision { slug, env: {NAME: VALUE, ...}, secretEnv: {NAME: "secretName", ...} }
//   → create-or-update gw-<slug>, wait Ready, grant control-api-run@ run.invoker, return { url, service }.
import http from "node:http";
import { GoogleAuth as GA } from "google-auth-library";

const PORT = Number(process.env.PORT ?? 8080);
const PROJECT = process.env.GCP_PROJECT ?? "project-bd87157a-f6fd-4d44-830";
const REGION = process.env.GCP_REGION ?? "us-west1";
const GATEWAY_IMAGE = process.env.GATEWAY_IMAGE; // the gateway container image to run per datalake
const GATEWAY_SA = process.env.GATEWAY_SA;       // runtime SA the gateways RUN AS (gateway-run@)
const CLOUDSQL_INSTANCE = process.env.CLOUDSQL_INSTANCE ?? `${PROJECT}:${REGION}:waddling-main`;
const CONTROL_API_SA = process.env.CONTROL_API_SA; // granted run.invoker on each gateway (control path)
const ROUTER_SA = process.env.ROUTER_SA;           // granted run.invoker on each gateway (quack data path)
// Shared mTLS PEM secrets (Secret Manager names) every gateway references for its libpq client cert.
const PEM_SECRETS = {
  GW_PG_SSLCERT_PEM_B64: process.env.SEC_SSLCERT ?? "gw-pg-sslcert-pem-b64",
  GW_PG_SSLKEY_PEM_B64: process.env.SEC_SSLKEY ?? "gw-pg-sslkey-pem-b64",
  GW_PG_SSLROOTCERT_PEM_B64: process.env.SEC_SSLROOTCERT ?? "gw-pg-sslrootcert-pem-b64",
};

const log = (...a) => console.log("[provisioner]", ...a);
const auth = new GA({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
const API = "https://run.googleapis.com/v2";
const parent = `projects/${PROJECT}/locations/${REGION}`;

async function api(method, url, body) {
  const client = await auth.getClient();
  const res = await client.request({ url, method, data: body, validateStatus: () => true });
  return { status: res.status, data: res.data };
}

// Build the google.cloud.run.v2.Service body, cloning the bringup template (max=1, cpu always-on,
// gen2, cloudsql socket, gateway SA) and injecting this datalake's plain env + the shared PEM secrets.
//
// kind 'workspace' opens an encrypted durable .duckdb (restored/persisted to GCS) and relays the lake
// over the public router — it has NO Cloud SQL catalog and NO libpq mTLS, so its body OMITS the shared
// PEM secrets and the cloudsql-instances annotation. kind 'gateway' (default) is unchanged.
function serviceBody(envMap, secretEnvMap, kind = "gateway") {
  const isWorkspace = kind === "workspace";
  const env = [
    ...Object.entries(envMap ?? {}).map(([name, value]) => ({ name, value: String(value) })),
    // Workspaces have no libpq client cert; only inject the shared PEM secrets for gateways.
    ...Object.entries({ ...(isWorkspace ? {} : PEM_SECRETS), ...(secretEnvMap ?? {}) }).map(([name, secret]) => ({
      name,
      valueSource: { secretKeyRef: { secret, version: "latest" } },
    })),
  ];
  return {
    template: {
      scaling: { minInstanceCount: 0, maxInstanceCount: 1 },
      serviceAccount: GATEWAY_SA,
      executionEnvironment: "EXECUTION_ENVIRONMENT_GEN2",
      // Workspaces don't reach Cloud SQL, so they get no cloudsql-instances annotation.
      ...(isWorkspace ? {} : { annotations: { "run.googleapis.com/cloudsql-instances": CLOUDSQL_INSTANCE } }),
      containers: [
        {
          image: GATEWAY_IMAGE,
          ports: [{ containerPort: 8080 }],
          env,
          resources: { cpuIdle: false, startupCpuBoost: true, limits: { cpu: "1", memory: "1Gi" } },
        },
      ],
    },
    // Private: no allUsers binding is added; ingress allows the LB/internal + the router's id-token.
    ingress: "INGRESS_TRAFFIC_ALL",
  };
}

async function waitOperation(opName) {
  // opName is "projects/.../operations/<id>"; poll the v2 operations endpoint until done.
  for (let i = 0; i < 120; i++) {
    const { status, data } = await api("GET", `${API}/${opName}`);
    if (status >= 400) throw new Error(`operation poll ${status}: ${JSON.stringify(data).slice(0, 300)}`);
    if (data.done) {
      if (data.error) throw new Error(`operation failed: ${JSON.stringify(data.error).slice(0, 300)}`);
      return data.response;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("operation timed out after 240s");
}

async function provision(slug, envMap, secretEnvMap, kind = "gateway") {
  // Workspaces deploy as ws-<slug>; gateways as gw-<slug>.
  const service = `${kind === "workspace" ? "ws" : "gw"}-${slug}`;
  const svcPath = `${parent}/services/${service}`;
  const body = serviceBody(envMap, secretEnvMap, kind);

  // create-or-update (idempotent): GET → PATCH if exists, else POST with serviceId.
  const existing = await api("GET", `${API}/${svcPath}`);
  let op;
  if (existing.status === 200) {
    log(`updating ${service}`);
    ({ data: op } = await api("PATCH", `${API}/${svcPath}`, body));
  } else {
    log(`creating ${service}`);
    ({ data: op } = await api("POST", `${API}/${parent}/services?serviceId=${service}`, body));
  }
  if (op?.error) throw new Error(`deploy error: ${JSON.stringify(op.error).slice(0, 300)}`);
  if (op?.name) await waitOperation(op.name);

  // Resolve the serving URL.
  const got = await api("GET", `${API}/${svcPath}`);
  if (got.status !== 200) throw new Error(`describe ${service} ${got.status}: ${JSON.stringify(got.data).slice(0, 200)}`);
  const url = got.data.uri;

  // Grant run.invoker on this private gateway to control-api (pushes /ctrl/snapshot — control path)
  // and to the public router (forwards quack POST /quack with a minted id token — data path).
  const invokers = [CONTROL_API_SA, ROUTER_SA].filter(Boolean).map((sa) => `serviceAccount:${sa}`);
  if (invokers.length) {
    const pol = await api("POST", `${API}/${svcPath}:setIamPolicy`, {
      policy: { bindings: [{ role: "roles/run.invoker", members: invokers }] },
    });
    if (pol.status >= 400) log(`WARN setIamPolicy ${pol.status}: ${JSON.stringify(pol.data).slice(0, 200)}`);
  }
  return { url, service };
}

const server = http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (req.method === "GET" && (req.url === "/healthz" || req.url === "/")) return send(200, { ok: true });
  if (req.method !== "POST" || (req.url || "").split("?")[0] !== "/provision") return send(404, { error: "not found" });
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    try {
      const { slug, env: envMap, secretEnv, kind: rawKind } = JSON.parse(raw || "{}");
      if (!slug || !/^[a-z0-9-]+$/.test(slug)) return send(400, { error: "invalid slug" });
      if (!GATEWAY_IMAGE || !GATEWAY_SA) return send(500, { error: "provisioner misconfigured: GATEWAY_IMAGE/GATEWAY_SA unset" });
      const kind = rawKind === "workspace" ? "workspace" : "gateway";
      const prefix = kind === "workspace" ? "ws" : "gw";
      log(`provision ${prefix}-${slug} (${Object.keys(envMap ?? {}).length} env)`);
      const out = await provision(slug, envMap, secretEnv, kind);
      log(`provisioned ${out.service} → ${out.url}`);
      send(200, { ok: true, ...out });
    } catch (e) {
      log(`provision failed: ${e?.message || e}`);
      send(502, { ok: false, error: String(e?.message || e) });
    }
  });
});
server.listen(PORT, "0.0.0.0", () => log(`listening on :${PORT} (project=${PROJECT} region=${REGION} image=${GATEWAY_IMAGE ? "set" : "UNSET"})`));
