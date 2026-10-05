import { createHash } from "node:crypto";

function canonical(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(canonical);
    }
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, inner]) => [key, canonical(inner)]),
        );
    }
    return value;
}

export function contentHash(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
