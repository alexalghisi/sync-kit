import { describe, expect, it, vi } from "vitest";

import { TokenManager } from "../src/auth/tokenManager.ts";
import { RefreshFailedError } from "../src/auth/types.ts";
import { MemoryConnectionStore } from "../src/store/memory.ts";

const PROVIDER = { name: "taskhub", tokenUrl: "https://taskhub.test/oauth/token", clientId: "id", clientSecret: "secret" };
const NOW = 1_800_000_000_000;

function tokenEndpoint() {
    let issued = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
        issued += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return new Response(JSON.stringify({ access_token: `access-${issued}`, refresh_token: `refresh-${issued}`, expires_in: 3600 }));
    });
    return fetchImpl;
}

async function storeWith(expiresAt: number) {
    const store = new MemoryConnectionStore();
    await store.save({ id: "c1", provider: "taskhub", credentials: { accessToken: "access-0", refreshToken: "refresh-0", expiresAt } });
    return store;
}

describe("TokenManager", () => {
    it("returns the stored token while it is fresh", async () => {
        const fetchImpl = tokenEndpoint();
        const tokens = new TokenManager([PROVIDER], await storeWith(NOW + 3_600_000), { now: () => NOW, fetchImpl });
        expect(await tokens.accessToken("c1")).toBe("access-0");
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("refreshes shortly before expiry and stores the rotated refresh token", async () => {
        const store = await storeWith(NOW + 30_000);
        const fetchImpl = tokenEndpoint();
        const tokens = new TokenManager([PROVIDER], store, { now: () => NOW, fetchImpl });

        expect(await tokens.accessToken("c1")).toBe("access-1");
        expect((await store.get("c1"))?.credentials).toEqual({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: NOW + 3_600_000 });
        const body = new URLSearchParams(String(fetchImpl.mock.calls[0]?.[1]?.body));
        expect(body.get("refresh_token")).toBe("refresh-0");
    });

    it("collapses concurrent refreshes into one request", async () => {
        const fetchImpl = tokenEndpoint();
        const tokens = new TokenManager([PROVIDER], await storeWith(NOW), { now: () => NOW, fetchImpl });

        const results = await Promise.all(Array.from({ length: 10 }, () => tokens.accessToken("c1")));

        expect(new Set(results)).toEqual(new Set(["access-1"]));
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("skips refreshing when another worker already refreshed under the lock", async () => {
        const store = await storeWith(NOW);
        const fetchImpl = tokenEndpoint();
        const workerA = new TokenManager([PROVIDER], store, { now: () => NOW, fetchImpl });
        const workerB = new TokenManager([PROVIDER], store, { now: () => NOW, fetchImpl });

        const [a, b] = await Promise.all([workerA.accessToken("c1"), workerB.accessToken("c1")]);

        expect([a, b]).toEqual(["access-1", "access-1"]);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("reports a refused refresh with the provider status", async () => {
        const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 400 }));
        const tokens = new TokenManager([PROVIDER], await storeWith(NOW), { now: () => NOW, fetchImpl });
        await expect(tokens.accessToken("c1")).rejects.toEqual(new RefreshFailedError("taskhub refused to refresh the token (HTTP 400)", 400));
    });
});
