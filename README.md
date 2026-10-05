# sync-kit

Every integration ends up re-solving the same problems: tokens that expire mid-sync, APIs that rate-limit at the worst moment, pages of half-valid data, and knowing what actually changed since last time. sync-kit is a small, typed SDK and runtime that handles those parts, so the integration code only describes how to read the provider's API.

![Dry runs of an incremental and a full sync, then the test suite against PostgreSQL](docs/dry-run.gif)

## Writing a sync

```ts
// trimmed; the full version is in examples/taskhub/syncs.ts
export const tasks = defineSync<Task, { updatedSince: string }>({
    name: "taskhub-tasks",
    provider: "taskhub",
    model: "Task",
    schema: task,                       // zod schema, the source of truth for the model
    mode: "incremental",
    async *fetch({ http, checkpoint, saveCheckpoint }) {
        let cursor: string | undefined;
        do {
            const { data } = await http.get<TaskPage>("/v1/tasks", { updated_since: checkpoint?.updatedSince, cursor });
            yield data.tasks.map(toTask);
            cursor = data.next_cursor ?? undefined;
        } while (cursor);
        saveCheckpoint({ updatedSince: newest });
    },
});
```

The sync yields pages. Everything else is the runtime's job. See [`examples/taskhub`](examples/taskhub) for a complete provider with an incremental and a full sync.

## What the runtime does

- **Auth without stampedes.** `TokenManager` refreshes OAuth tokens shortly before expiry and stores rotated refresh tokens. It collapses concurrent refreshes in one process into one request. Across processes it holds a PostgreSQL advisory lock and re-checks after acquiring it, so a token refreshed by another worker is reused instead of refreshed again. A test runs two connection pools against a real database and expects exactly one token request.
- **Provider calls that survive.** `ProviderClient` injects the bearer token. On a `401` it forces one refresh and retries. It honours `Retry-After` on `429`, backs off on `5xx` and fails fast on other `4xx`.
- **Validation at the edge.** Every record is parsed with the sync's zod schema. Invalid records are skipped, counted and reported with the reason (`title: Required`), so one bad record doesn't fail the whole sync.
- **Change detection.** Records are hashed canonically (key order doesn't matter) and upserted in a single SQL statement that also returns whether each record was added, updated or unchanged.
- **Resumable incremental syncs.** Checkpoints are persisted only after the records they cover are stored. A crash means re-reading some data, never losing it, and content hashes make the re-read a no-op.
- **Safe deletion detection.** Full syncs soft-delete records not seen in the run, but only when the run completes. A sync that fails half-way deletes nothing. A record that comes back is reported as added.

## Tech stack

Node.js 22, TypeScript (strict), PostgreSQL (`pg`), zod, Fastify for the example provider, vitest, GitHub Actions

## Running it

```bash
npm ci
node src/cli.ts dry-run tasks        # or: projects
```

The dry run starts the example TaskHub provider locally with rate limiting switched on. It runs the sync three times (first run, no changes, then after an edit and a delete) and prints what changed.

## Tests

```bash
npm run typecheck
npm test                                                             # PostgreSQL tests are skipped without a database
SYNC_KIT_TEST_DATABASE_URL=postgres://user:pass@localhost/db npm test
```

## License

MIT
