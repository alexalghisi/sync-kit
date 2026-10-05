import { z } from "zod";

import { defineSync } from "../../src/sdk/defineSync.ts";

const task = z.object({
    id: z.string(),
    title: z.string().min(1),
    status: z.enum(["todo", "in_progress", "done"]),
    assignee: z.string().nullable(),
    updatedAt: z.string().datetime(),
});

const project = z.object({ id: z.string(), name: z.string() });

interface TaskPage {
    tasks: { id: string; title?: string; status: string; assignee: string | null; updated_at: string }[];
    next_cursor: string | null;
}

export const tasks = defineSync<z.infer<typeof task>, { updatedSince: string }>({
    name: "taskhub-tasks",
    provider: "taskhub",
    model: "Task",
    schema: task,
    mode: "incremental",
    async *fetch({ http, checkpoint, saveCheckpoint }) {
        let cursor: string | undefined;
        let newest = checkpoint?.updatedSince ?? "";
        do {
            const { data } = await http.get<TaskPage>("/v1/tasks", { updated_since: checkpoint?.updatedSince, cursor, limit: "3" });
            yield data.tasks.map((item) => ({
                id: item.id,
                title: item.title,
                status: item.status,
                assignee: item.assignee,
                updatedAt: item.updated_at,
            }));
            for (const item of data.tasks) {
                newest = item.updated_at > newest ? item.updated_at : newest;
            }
            cursor = data.next_cursor ?? undefined;
            if (!cursor && newest) {
                saveCheckpoint({ updatedSince: newest });
            }
        } while (cursor);
    },
});

export const projects = defineSync<z.infer<typeof project>>({
    name: "taskhub-projects",
    provider: "taskhub",
    model: "Project",
    schema: project,
    mode: "full",
    async *fetch({ http }) {
        for (let page = 1; ; page += 1) {
            const { data } = await http.get<{ projects: { id: string; name: string }[]; has_more: boolean }>("/v1/projects", { page: String(page) });
            yield data.projects;
            if (!data.has_more) {
                return;
            }
        }
    },
});
