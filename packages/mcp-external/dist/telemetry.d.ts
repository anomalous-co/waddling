export interface Telemetry {
    capture(event: string, properties?: Record<string, unknown>): void;
    /** Mark a $set_once person property the first time it's seen this process. */
    setOnce(property: string, properties?: Record<string, unknown>): void;
    shutdown(): Promise<void>;
}
/** Enabled only when not opted-out AND a real (non-placeholder) key is baked. */
export declare function telemetryEnabled(): boolean;
/**
 * Build a telemetry handle bound to a device distinct-id. Call shutdown() once
 * before process exit to flush. When disabled, returns a no-op handle that opens
 * no network client (important for the stdio CLI: no per-event POST, no exit hang).
 */
export declare function createTelemetry(deviceId: string): Telemetry;
