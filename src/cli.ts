#!/usr/bin/env node
import { projects, tasks } from "../examples/taskhub/syncs.ts";
import { fakeTaskHub } from "../examples/taskhub/server.ts";
import { TokenManager } from "./auth/tokenManager.ts";
import { ProviderClient } from "./http/providerClient.ts";
import { runSync, type RunSyncOptions, type SyncSummary } from "./runtime/runSync.ts";
import { MemoryConnectionStore, MemorySyncStore } from "./store/memory.ts";

const SYNCS = {
    tasks: { definition: tasks, run: (options: RunSyncOptions) => runSync(tasks, options) },
    projects: { definition: projects, run: (options: RunSyncOptions) => runSync(projects, options) },
} as const;

function print(label: string, summary: SyncSummary): void {
    const counts = (["added", "updated", "unchanged", "deleted", "invalid"] as const).map((key) => `${key} ${summary[key]}`).join(" · ");
    console.log(`${label.padEnd(28)} ${counts} · ${summary.batches} batches`);
    for (const sample of summary.invalidSamples) {
        console.log(`${"".padEnd(28)} skipped invalid record: ${sample}`);
    }
}

async function dryRun(name: keyof typeof SYNCS): Promise<void> {
    const taskhub = fakeTaskHub();
    const baseUrl = await taskhub.app.listen({ port: 0, host: "127.0.0.1" });
    const connections = new MemoryConnectionStore();
    await connections.save({ id: "conn_demo", provider: "taskhub", credentials: { accessToken: "expired", refreshToken: "refresh-0", expiresAt: 0 } });
    const tokens = new TokenManager([{ name: "taskhub", tokenUrl: `${baseUrl}/oauth/token`, clientId: "demo", clientSecret: "demo" }], connections);
    const http = new ProviderClient(baseUrl, "conn_demo", tokens, { baseDelayMs: 10 });
    const store = new MemorySyncStore();
    const { definition: sync, run: execute } = SYNCS[name];
    const run = () => execute({ connectionId: "conn_demo", http, store });

    console.log(`dry run of ${sync.name} against a local TaskHub\n`);
    taskhub.rateLimitEvery(4);
    print("first run", await run());
    print("second run, nothing changed", await run());
    taskhub.touch("T-002", { status: "done" });
    taskhub.projects.delete("P-2");
    print("after one edit and a delete", await run());
    console.log(`\ntoken refreshes: ${taskhub.tokenRefreshes()} · records stored: ${(await store.records({ connectionId: "conn_demo", model: sync.model })).length}`);
    await taskhub.app.close();
}

const [command, name] = process.argv.slice(2);
if (command !== "dry-run" || !name || !(name in SYNCS)) {
    console.error(`usage: sync-kit dry-run <${Object.keys(SYNCS).join("|")}>`);
    process.exitCode = 1;
} else {
    await dryRun(name as keyof typeof SYNCS);
}
