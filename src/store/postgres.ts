import { readFile } from "node:fs/promises";

import type { Pool } from "pg";

import type { Connection, ConnectionStore } from "../auth/types.ts";
import type { RecordChange, StoredRecord, SyncScope, SyncStore } from "./types.ts";

export async function migrate(pool: Pool): Promise<void> {
    await pool.query(await readFile(new URL("./schema.sql", import.meta.url), "utf8"));
}

const UPSERT = `
WITH incoming AS (
    SELECT * FROM unnest($3::text[], $4::text[], $5::jsonb[]) AS t(external_id, hash, data)
), previous AS (
    SELECT external_id, hash, deleted_at FROM records
    WHERE connection_id = $1 AND model = $2 AND external_id = ANY($3)
), written AS (
    INSERT INTO records (connection_id, model, external_id, hash, data, last_seen_run)
    SELECT $1, $2, external_id, hash, data, $6 FROM incoming
    ON CONFLICT (connection_id, model, external_id) DO UPDATE SET
        hash = EXCLUDED.hash,
        data = EXCLUDED.data,
        last_seen_run = EXCLUDED.last_seen_run,
        deleted_at = NULL,
        updated_at = CASE WHEN records.hash <> EXCLUDED.hash OR records.deleted_at IS NOT NULL THEN now() ELSE records.updated_at END
    RETURNING external_id
)
SELECT incoming.external_id,
       CASE WHEN previous.external_id IS NULL OR previous.deleted_at IS NOT NULL THEN 'added'
            WHEN previous.hash <> incoming.hash THEN 'updated'
            ELSE 'unchanged' END AS change
FROM incoming
JOIN written USING (external_id)
LEFT JOIN previous USING (external_id)`;

export class PostgresSyncStore implements SyncStore {
    private readonly pool: Pool;

    constructor(pool: Pool) {
        this.pool = pool;
    }

    async upsert(scope: SyncScope, records: { externalId: string; hash: string; data: unknown }[], runId: string): Promise<Map<string, RecordChange>> {
        if (records.length === 0) {
            return new Map();
        }
        const result = await this.pool.query<{ external_id: string; change: RecordChange }>(UPSERT, [
            scope.connectionId,
            scope.model,
            records.map((record) => record.externalId),
            records.map((record) => record.hash),
            records.map((record) => JSON.stringify(record.data)),
            runId,
        ]);
        return new Map(result.rows.map((row) => [row.external_id, row.change]));
    }

    async markMissingAsDeleted(scope: SyncScope, runId: string): Promise<number> {
        const result = await this.pool.query(
            "UPDATE records SET deleted_at = now() WHERE connection_id = $1 AND model = $2 AND last_seen_run <> $3 AND deleted_at IS NULL",
            [scope.connectionId, scope.model, runId],
        );
        return result.rowCount ?? 0;
    }

    async loadCheckpoint<C>(scope: SyncScope): Promise<C | undefined> {
        const result = await this.pool.query<{ checkpoint: C }>("SELECT checkpoint FROM checkpoints WHERE connection_id = $1 AND model = $2", [
            scope.connectionId,
            scope.model,
        ]);
        return result.rows[0]?.checkpoint;
    }

    async saveCheckpoint(scope: SyncScope, checkpoint: unknown): Promise<void> {
        await this.pool.query(
            `INSERT INTO checkpoints (connection_id, model, checkpoint) VALUES ($1, $2, $3)
             ON CONFLICT (connection_id, model) DO UPDATE SET checkpoint = EXCLUDED.checkpoint`,
            [scope.connectionId, scope.model, JSON.stringify(checkpoint)],
        );
    }

    async records(scope: SyncScope): Promise<StoredRecord[]> {
        const result = await this.pool.query<{ external_id: string; hash: string; data: unknown; deleted_at: Date | null }>(
            "SELECT external_id, hash, data, deleted_at FROM records WHERE connection_id = $1 AND model = $2 ORDER BY external_id",
            [scope.connectionId, scope.model],
        );
        return result.rows.map((row) => ({
            externalId: row.external_id,
            hash: row.hash,
            data: row.data,
            deletedAt: row.deleted_at ? row.deleted_at.toISOString() : null,
        }));
    }
}

export class PostgresConnectionStore implements ConnectionStore {
    private readonly pool: Pool;

    constructor(pool: Pool) {
        this.pool = pool;
    }

    async get(connectionId: string): Promise<Connection | undefined> {
        const result = await this.pool.query<{ id: string; provider: string; access_token: string; refresh_token: string; expires_at: string }>(
            "SELECT * FROM connections WHERE id = $1",
            [connectionId],
        );
        const row = result.rows[0];
        return row
            ? { id: row.id, provider: row.provider, credentials: { accessToken: row.access_token, refreshToken: row.refresh_token, expiresAt: Number(row.expires_at) } }
            : undefined;
    }

    async save(connection: Connection): Promise<void> {
        const { accessToken, refreshToken, expiresAt } = connection.credentials;
        await this.pool.query(
            `INSERT INTO connections (id, provider, access_token, refresh_token, expires_at) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (id) DO UPDATE SET access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token, expires_at = EXCLUDED.expires_at`,
            [connection.id, connection.provider, accessToken, refreshToken, expiresAt],
        );
    }

    async withRefreshLock<T>(connectionId: string, action: () => Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`refresh:${connectionId}`]);
            const result = await action();
            await client.query("COMMIT");
            return result;
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }
}
