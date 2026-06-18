import { createServer } from "node:http";
import { type DuckRuntime } from "./duck";
export interface CtrlServerDeps {
    runtime: DuckRuntime;
}
export declare function startCtrlServer(port: number, deps: CtrlServerDeps): ReturnType<typeof createServer>;
