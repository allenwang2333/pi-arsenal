import type { RegisteredCommand } from "@earendil-works/pi-coding-agent";

/**
 * A command definition without identity: the command name is supplied by
 * `index.ts` at registration time, keeping the registry in one place.
 */
export type CommandDef = Omit<RegisteredCommand, "name" | "sourceInfo">;
