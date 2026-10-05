import Fastify, { type FastifyInstance } from "fastify";

export interface Task {
    id: string;
    title?: string;
    status: "todo" | "in_progress" | "done";
    assignee: string | null;
    updated_at: string;
}

export interface Project {
    id: string;
    name: string;
}

export interface FakeTaskHub {
    app: FastifyInstance;
    tasks: Map<string, Task>;
    projects: Map<string, Project>;
    tokenRefreshes: () => number;
    rateLimitEvery: (requests: number) => void;
    touch: (id: string, patch: Partial<Task>) => void;
}

export function fakeTaskHub(clock: () => number = Date.now): FakeTaskHub {
    const app = Fastify();
    const tasks = new Map<string, Task>();
    const projects = new Map<string, Project>();
    const validTokens = new Set<string>(["initial-access"]);
    let refreshes = 0;
    let requests = 0;
    let limitEvery = 0;

    for (let index = 1; index <= 7; index += 1) {
        const id = `T-${String(index).padStart(3, "0")}`;
        tasks.set(id, {
            id,
            ...(index === 5 ? {} : { title: `Task ${index}` }),
            status: index % 3 === 0 ? "done" : "todo",
            assignee: index % 2 === 0 ? "maria" : null,
            updated_at: new Date(Date.UTC(2026, 9, 1, 8, index)).toISOString(),
        });
    }
    for (const [id, name] of [["P-1", "Website"], ["P-2", "Mobile app"], ["P-3", "Billing"]] as const) {
        projects.set(id, { id, name });
    }

    app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => done(null, body));

    app.post("/oauth/token", async (request, reply) => {
        const form = new URLSearchParams(String(request.body));
        if (form.get("grant_type") !== "refresh_token" || !form.get("refresh_token")?.startsWith("refresh-")) {
            return reply.status(400).send({ error: "invalid_grant" });
        }
        refreshes += 1;
        const token = `access-${refreshes}`;
        validTokens.add(token);
        return { access_token: token, refresh_token: `refresh-${refreshes}`, expires_in: 3600 };
    });

    app.addHook("onRequest", async (request, reply) => {
        if (request.url.startsWith("/oauth")) {
            return undefined;
        }
        requests += 1;
        if (limitEvery && requests % limitEvery === 0) {
            return reply.status(429).header("retry-after", "0").send({ error: "rate_limited" });
        }
        const token = request.headers.authorization?.replace("Bearer ", "") ?? "";
        if (!validTokens.has(token)) {
            return reply.status(401).send({ error: "invalid_token" });
        }
        return undefined;
    });

    app.get<{ Querystring: { updated_since?: string; cursor?: string; limit?: string } }>("/v1/tasks", async (request) => {
        const since = request.query.updated_since ?? "";
        const limit = Number(request.query.limit ?? 3);
        const ordered = [...tasks.values()].filter((task) => task.updated_at > since).sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.id.localeCompare(b.id));
        const start = Number(request.query.cursor ?? 0);
        const page = ordered.slice(start, start + limit);
        return { tasks: page, next_cursor: start + limit < ordered.length ? String(start + limit) : null };
    });

    app.get<{ Querystring: { page?: string } }>("/v1/projects", async (request) => {
        const page = Number(request.query.page ?? 1);
        const all = [...projects.values()];
        return { projects: all.slice((page - 1) * 2, page * 2), has_more: page * 2 < all.length };
    });

    return {
        app,
        tasks,
        projects,
        tokenRefreshes: () => refreshes,
        rateLimitEvery: (count) => {
            limitEvery = count;
        },
        touch: (id, patch) => {
            const task = tasks.get(id);
            if (task) {
                tasks.set(id, { ...task, ...patch, updated_at: new Date(clock()).toISOString() });
            }
        },
    };
}
