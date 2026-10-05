import { randomUUID } from "node:crypto";

import type { ProviderClient } from "../http/providerClient.ts";
import type { SyncDefinition, SyncLogger } from "../sdk/defineSync.ts";
import type { SyncScope, SyncStore } from "../store/types.ts";
import { contentHash } from "./hash.ts";

export interface SyncSummary {
    runId: string;
    added: number;
    updated: number;
    unchanged: number;
    deleted: number;
    invalid: number;
    batches: number;
    invalidSamples: string[];
}

export interface RunSyncOptions {
    connectionId: string;
    http: ProviderClient;
    store: SyncStore;
    log?: SyncLogger;
}

const silent: SyncLogger = { info: () => undefined };

export async function runSync<Model extends { id: string }, Checkpoint>(
    sync: SyncDefinition<Model, Checkpoint>,
    { connectionId, http, store, log = silent }: RunSyncOptions,
): Promise<SyncSummary> {
    const scope: SyncScope = { connectionId, model: sync.model };
    const summary: SyncSummary = { runId: randomUUID(), added: 0, updated: 0, unchanged: 0, deleted: 0, invalid: 0, batches: 0, invalidSamples: [] };
    let pendingCheckpoint: { value: Checkpoint } | undefined;

    const context = {
        http,
        checkpoint: sync.mode === "incremental" ? await store.loadCheckpoint<Checkpoint>(scope) : undefined,
        saveCheckpoint: (value: Checkpoint) => {
            pendingCheckpoint = { value };
        },
        log,
    };

    for await (const batch of sync.fetch(context)) {
        const valid: { externalId: string; hash: string; data: Model }[] = [];
        for (const item of batch) {
            const parsed = sync.schema.safeParse(item);
            if (parsed.success) {
                valid.push({ externalId: parsed.data.id, hash: contentHash(parsed.data), data: parsed.data });
            } else {
                summary.invalid += 1;
                if (summary.invalidSamples.length < 5) {
                    summary.invalidSamples.push(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
                }
            }
        }
        const changes = await store.upsert(scope, valid, summary.runId);
        for (const change of changes.values()) {
            summary[change] += 1;
        }
        summary.batches += 1;
        if (pendingCheckpoint) {
            await store.saveCheckpoint(scope, pendingCheckpoint.value);
            pendingCheckpoint = undefined;
        }
        log.info("batch stored", { sync: sync.name, size: batch.length, batches: summary.batches });
    }

    if (pendingCheckpoint) {
        await store.saveCheckpoint(scope, pendingCheckpoint.value);
    }
    if (sync.mode === "full") {
        summary.deleted = await store.markMissingAsDeleted(scope, summary.runId);
    }
    return summary;
}
