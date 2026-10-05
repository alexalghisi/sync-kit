import type { ZodType } from "zod";

import type { ProviderClient } from "../http/providerClient.ts";

export interface SyncLogger {
    info(message: string, fields?: Record<string, unknown>): void;
}

export interface SyncContext<Checkpoint> {
    http: ProviderClient;
    checkpoint: Checkpoint | undefined;
    saveCheckpoint(checkpoint: Checkpoint): void;
    log: SyncLogger;
}

export interface SyncDefinition<Model extends { id: string }, Checkpoint = never> {
    name: string;
    provider: string;
    model: string;
    schema: ZodType<Model>;
    mode: "incremental" | "full";
    fetch(context: SyncContext<Checkpoint>): AsyncIterable<unknown[]>;
}

export function defineSync<Model extends { id: string }, Checkpoint = never>(
    definition: SyncDefinition<Model, Checkpoint>,
): SyncDefinition<Model, Checkpoint> {
    return definition;
}
