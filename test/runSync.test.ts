import { afterEach, describe, expect, it } from "vitest";

import { fakeTaskHub, type FakeTaskHub } from "../examples/taskhub/server.ts";
import { projects, tasks } from "../examples/taskhub/syncs.ts";
import { TokenManager } from "../src/auth/tokenManager.ts";
import { ProviderClient, ProviderRequestError } from "../src/http/providerClient.ts";
import { runSync } from "../src/runtime/runSync.ts";
import { MemoryConnectionStore, MemorySyncStore } from "../src/store/memory.ts";
import type { SyncStore } from "../src/store/types.ts";

const servers: FakeTaskHub[] = [];

afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.app.close()));
});

async function setup(store: SyncStore = new MemorySyncStore()) {
    const taskhub = fakeTaskHub(() => Date.UTC(2026, 9, 5, 9, 0));
    servers.push(taskhub);
    const baseUrl = await taskhub.app.listen({ port: 0, host: "127.0.0.1" });
    const connections = new MemoryConnectionStore();
    await connections.save({ id: "c1", provider: "taskhub", credentials: { accessToken: "initial-access", refreshToken: "refresh-0", expiresAt: Date.now() + 3_600_000 } });
    const tokens = new TokenManager([{ name: "taskhub", tokenUrl: `${baseUrl}/oauth/token`, clientId: "id", clientSecret: "secret" }], connections);
    const http = new ProviderClient(baseUrl, "c1", tokens, { sleep: async () => undefined });
    return { taskhub, store, connections, http, options: { connectionId: "c1", http, store } };
}

describe("runSync", () => {
    it("stores valid records, skips invalid ones and explains why", async () => {
        const { options, store } = await setup();
        const summary = await runSync(tasks, options);

        expect(summary).toMatchObject({ added: 6, updated: 0, unchanged: 0, invalid: 1, batches: 3 });
        expect(summary.invalidSamples).toEqual(["title: Required"]);
        expect((await store.records({ connectionId: "c1", model: "Task" })).map((record) => record.externalId)).not.toContain("T-005");
    });

    it("only fetches what changed since the last checkpoint", async () => {
        const { options, taskhub } = await setup();
        await runSync(tasks, options);

        expect(await runSync(tasks, options)).toMatchObject({ added: 0, updated: 0, unchanged: 0, batches: 1 });

        taskhub.touch("T-003", { status: "in_progress" });
        expect(await runSync(tasks, options)).toMatchObject({ updated: 1, unchanged: 0 });
    });

    it("detects deletions on full syncs and counts restored records as added", async () => {
        const { options, taskhub, store } = await setup();
        await runSync(projects, options);

        const removed = taskhub.projects.get("P-2");
        taskhub.projects.delete("P-2");
        expect(await runSync(projects, options)).toMatchObject({ deleted: 1, unchanged: 2 });
        expect((await store.records({ connectionId: "c1", model: "Project" })).find((record) => record.externalId === "P-2")?.deletedAt).not.toBeNull();

        taskhub.projects.set("P-2", removed!);
        expect(await runSync(projects, options)).toMatchObject({ added: 1, deleted: 0 });
    });

    it("does not delete anything when a full sync fails part-way", async () => {
        const { options, taskhub, store } = await setup();
        await runSync(projects, options);
        taskhub.rateLimitEvery(1);

        await expect(runSync(projects, options)).rejects.toThrow(ProviderRequestError);

        const stored = await store.records({ connectionId: "c1", model: "Project" });
        expect(stored.every((record) => record.deletedAt === null)).toBe(true);
    });

    it("rides out rate limits and refreshes a revoked token once", async () => {
        const { options, taskhub, connections } = await setup();
        taskhub.rateLimitEvery(3);
        const credentials = (await connections.get("c1"))!.credentials;
        await connections.save({ id: "c1", provider: "taskhub", credentials: { ...credentials, accessToken: "revoked" } });

        expect(await runSync(tasks, options)).toMatchObject({ added: 6 });
        expect(taskhub.tokenRefreshes()).toBe(1);
    });
});
