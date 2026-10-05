export type RecordChange = "added" | "updated" | "unchanged";

export interface StoredRecord {
    externalId: string;
    hash: string;
    data: unknown;
    deletedAt: string | null;
}

export interface SyncScope {
    connectionId: string;
    model: string;
}

export interface SyncStore {
    upsert(scope: SyncScope, records: { externalId: string; hash: string; data: unknown }[], runId: string): Promise<Map<string, RecordChange>>;
    markMissingAsDeleted(scope: SyncScope, runId: string): Promise<number>;
    loadCheckpoint<C>(scope: SyncScope): Promise<C | undefined>;
    saveCheckpoint(scope: SyncScope, checkpoint: unknown): Promise<void>;
    records(scope: SyncScope): Promise<StoredRecord[]>;
}
