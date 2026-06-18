// Better Auth's catch-all Next.js route handler. Exposes /api/auth/* including
// the OAuth callbacks, /api/auth/token (mint a JWT for quack), and
// /api/auth/jwks (public keys birdshot's loader pulls in RS256 mode).
import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

export const { GET, POST } = toNextJsHandler(auth);
