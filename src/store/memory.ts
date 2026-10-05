import type { Connection, ConnectionStore } from "../auth/types.ts";
import type { RecordChange, StoredRecord, SyncScope, SyncStore } from "./types.ts";

interface MemoryRecord extends StoredRecord {
    lastSeenRun: string;
}

const key = (scope: SyncScope) => `${scope.connectionId}\u0000${scope.model}`;

export class MemorySyncStore implements SyncStore {
    private readonly tables = new Map<string, Map<string, MemoryRecord>>();
    private readonly checkpoints = new Map<string, unknown>();

    private table(scope: SyncScope): Map<string, MemoryRecord> {
        let table = this.tables.get(key(scope));
        if (!table) {
            table = new Map();
            this.tables.set(key(scope), table);
        }
        return table;
    }

    async upsert(scope: SyncScope, records: { externalId: string; hash: string; data: unknown }[], runId: string): Promise<Map<string, RecordChange>> {
        const table = this.table(scope);
        const changes = new Map<string, RecordChange>();
        for (const record of records) {
            const previous = table.get(record.externalId);
            const change: RecordChange = !previous || previous.deletedAt ? "added" : previous.hash === record.hash ? "unchanged" : "updated";
            changes.set(record.externalId, change);
            table.set(record.externalId, { ...record, deletedAt: null, lastSeenRun: runId });
        }
        return changes;
    }

    async markMissingAsDeleted(scope: SyncScope, runId: string): Promise<number> {
        let deleted = 0;
        for (const record of this.table(scope).values()) {
            if (record.lastSeenRun !== runId && !record.deletedAt) {
                record.deletedAt = new Date().toISOString();
                deleted += 1;
            }
        }
        return deleted;
    }

    async loadCheckpoint<C>(scope: SyncScope): Promise<C | undefined> {
        return this.checkpoints.get(key(scope)) as C | undefined;
    }

    async saveCheckpoint(scope: SyncScope, checkpoint: unknown): Promise<void> {
        this.checkpoints.set(key(scope), structuredClone(checkpoint));
    }

    async records(scope: SyncScope): Promise<StoredRecord[]> {
        return [...this.table(scope).values()]
            .map(({ externalId, hash, data, deletedAt }) => ({ externalId, hash, data, deletedAt }))
            .sort((a, b) => a.externalId.localeCompare(b.externalId));
    }
}

export class MemoryConnectionStore implements ConnectionStore {
    private readonly connections = new Map<string, Connection>();
    private readonly locks = new Map<string, Promise<unknown>>();

    async get(connectionId: string): Promise<Connection | undefined> {
        const connection = this.connections.get(connectionId);
        return connection ? structuredClone(connection) : undefined;
    }

    async save(connection: Connection): Promise<void> {
        this.connections.set(connection.id, structuredClone(connection));
    }

    async withRefreshLock<T>(connectionId: string, action: () => Promise<T>): Promise<T> {
        const previous = this.locks.get(connectionId) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(action);
        this.locks.set(connectionId, next);
        try {
            return await next;
        } finally {
            if (this.locks.get(connectionId) === next) {
                this.locks.delete(connectionId);
            }
        }
    }
}
