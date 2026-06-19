// OpenNext Cloudflare adapter config for the waddling render plane.
//
// Defaults are sufficient: this app is the UI/marketing/docs/dashboard-shell
// render plane. Its data + auth come from the control-api Worker over HTTP, so
// there is no incremental cache / queue / tag store to wire here. Add R2/D1/KV-
// backed caching (see https://opennext.js.org/cloudflare/caching) only if ISR is
// introduced later.
import { defineCloudflareConfig } from '@opennextjs/cloudflare';

export default defineCloudflareConfig();
