import type { TokenManager } from "../auth/tokenManager.ts";

export class ProviderRequestError extends Error {
    readonly status: number;

    constructor(message: string, status: number) {
        super(message);
        this.status = status;
    }
}

export interface ProviderClientOptions {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    sleep: (ms: number) => Promise<void>;
    fetchImpl: typeof fetch;
}

export interface ProviderResponse<T> {
    data: T;
    headers: Headers;
}

export class ProviderClient {
    private readonly baseUrl: string;
    private readonly connectionId: string;
    private readonly tokens: TokenManager;
    private readonly options: ProviderClientOptions;

    constructor(baseUrl: string, connectionId: string, tokens: TokenManager, options: Partial<ProviderClientOptions> = {}) {
        this.baseUrl = baseUrl;
        this.connectionId = connectionId;
        this.tokens = tokens;
        this.options = {
            maxAttempts: 5,
            baseDelayMs: 250,
            maxDelayMs: 30_000,
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            fetchImpl: fetch,
            ...options,
        };
    }

    async get<T>(path: string, query: Record<string, string | undefined> = {}): Promise<ProviderResponse<T>> {
        const url = new URL(path, this.baseUrl);
        for (const [key, value] of Object.entries(query)) {
            if (value !== undefined) {
                url.searchParams.set(key, value);
            }
        }
        let refreshedAfter401 = false;
        let forceRefresh = false;
        for (let attempt = 1; ; attempt += 1) {
            const token = await this.tokens.accessToken(this.connectionId, { force: forceRefresh });
            forceRefresh = false;
            const response = await this.options.fetchImpl(url, {
                headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
                signal: AbortSignal.timeout(30_000),
            });
            if (response.ok) {
                return { data: (await response.json()) as T, headers: response.headers };
            }
            if (response.status === 401 && !refreshedAfter401) {
                refreshedAfter401 = true;
                forceRefresh = true;
                attempt -= 1;
                continue;
            }
            const retryable = response.status === 429 || response.status >= 500;
            if (!retryable || attempt >= this.options.maxAttempts) {
                throw new ProviderRequestError(`GET ${url.pathname} failed with HTTP ${response.status}`, response.status);
            }
            await this.options.sleep(this.delay(attempt, response.headers.get("retry-after")));
        }
    }

    private delay(attempt: number, retryAfter: string | null): number {
        const seconds = Number(retryAfter);
        if (retryAfter !== null && Number.isFinite(seconds)) {
            return Math.min(seconds * 1000, this.options.maxDelayMs);
        }
        return Math.min(this.options.baseDelayMs * 2 ** (attempt - 1), this.options.maxDelayMs);
    }
}
