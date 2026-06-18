// Minimal "allowlisted gateway" stand-in for Stage 0 probe #1.
//
// This is NOT a quack gateway — it is a trivial HTTPS endpoint that returns a known
// body, used only as the single ALLOWLISTED egress target for the egress-shape gate.
// The probe proves that the workspace container can reach THIS host on HTTPS:443
// (and no other host, and no non-443 port). Whether the gateway speaks the quack
// protocol over TLS is a separate Stage D concern (the gateway container doesn't
// exist yet); decoupling protocol from egress shape is deliberate.
export default {
  async fetch(): Promise<Response> {
    return new Response("OK-GATEWAY-STAGE0", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  },
};
