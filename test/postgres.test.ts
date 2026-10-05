import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { TokenManager } from "../src/auth/tokenManager.ts";
import { PostgresConnectionStore, PostgresSyncStore, migrate } from "../src/store/postgres.ts";

const url = process.env.SYNC_KIT_TEST_DATABASE_URL;
const scope = { connectionId: "c1", model: "Task" };

describe.skipIf(!url)("PostgreSQL stores", () => {
    let pool: pg.Pool;

    beforeAll(async () => {
        pool = new pg.Pool({ connectionString: url, max: 10 });
        await migrate(pool);
    });

    afterAll(async () => {
        await pool.end();
    });

    beforeEach(async () => {
        await pool.query("TRUNCATE records, checkpoints, connections");
    });

    it("classifies upserts as added, updated or unchanged in one statement", async () => {
        const store = new PostgresSyncStore(pool);
        await store.upsert(scope, [{ externalId: "a", hash: "h1", data: { v: 1 } }, { externalId: "b", hash: "h1", data: { v: 1 } }], "run-1");

        const changes = await store.upsert(
            scope,
            [
                { externalId: "a", hash: "h1", data: { v: 1 } },
                { externalId: "b", hash: "h2", data: { v: 2 } },
                { externalId: "c", hash: "h1", data: { v: 1 } },
            ],
            "run-2",
        );

        expect(Object.fromEntries(changes)).toEqual({ a: "unchanged", b: "updated", c: "added" });
        expect(await store.markMissingAsDeleted(scope, "run-2")).toBe(0);
        expect(await store.markMissingAsDeleted({ ...scope, model: "Other" }, "run-2")).toBe(0);
    });

    it("soft-deletes records missing from a completed run and revives them later", async () => {
        const store = new PostgresSyncStore(pool);
        await store.upsert(scope, [{ externalId: "a", hash: "h", data: {} }, { externalId: "b", hash: "h", data: {} }], "run-1");
        await store.upsert(scope, [{ externalId: "a", hash: "h", data: {} }], "run-2");

        expect(await store.markMissingAsDeleted(scope, "run-2")).toBe(1);
        const revived = await store.upsert(scope, [{ externalId: "b", hash: "h", data: {} }], "run-3");

        expect(revived.get("b")).toBe("added");
        expect((await store.records(scope)).every((record) => record.deletedAt === null)).toBe(true);
    });

    it("round-trips checkpoints", async () => {
        const store = new PostgresSyncStore(pool);
        await store.saveCheckpoint(scope, { updatedSince: "2026-10-05T09:00:00Z" });
        expect(await store.loadCheckpoint(scope)).toEqual({ updatedSince: "2026-10-05T09:00:00Z" });
    });

    it("lets only one process refresh a connection at a time", async () => {
        const otherPool = new pg.Pool({ connectionString: url, max: 10 });
        const connectionsA = new PostgresConnectionStore(pool);
        const connectionsB = new PostgresConnectionStore(otherPool);
        await connectionsA.save({ id: "c1", provider: "taskhub", credentials: { accessToken: "old", refreshToken: "refresh-0", expiresAt: 0 } });
        let issued = 0;
        const fetchImpl = vi.fn<typeof fetch>(async () => {
            issued += 1;
            await new Promise((resolve) => setTimeout(resolve, 50));
            return new Response(JSON.stringify({ access_token: `access-${issued}`, expires_in: 3600 }));
        });
        const provider = { name: "taskhub", tokenUrl: "https://taskhub.test/token", clientId: "id", clientSecret: "secret" };

        const results = await Promise.all([
            new TokenManager([provider], connectionsA, { fetchImpl }).accessToken("c1"),
            new TokenManager([provider], connectionsB, { fetchImpl }).accessToken("c1"),
        ]);

        expect(results).toEqual(["access-1", "access-1"]);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        await otherPool.end();
    });
});
