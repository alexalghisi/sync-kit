import {
    ConnectionNotFoundError,
    RefreshFailedError,
    type Connection,
    type ConnectionStore,
    type Credentials,
    type OAuthProvider,
} from "./types.ts";

interface TokenResponse {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
}

export interface TokenManagerOptions {
    refreshMarginMs: number;
    now: () => number;
    fetchImpl: typeof fetch;
}

export class TokenManager {
    private readonly providers: Map<string, OAuthProvider>;
    private readonly store: ConnectionStore;
    private readonly options: TokenManagerOptions;
    private readonly inFlight = new Map<string, Promise<string>>();

    constructor(providers: OAuthProvider[], store: ConnectionStore, options: Partial<TokenManagerOptions> = {}) {
        this.providers = new Map(providers.map((provider) => [provider.name, provider]));
        this.store = store;
        this.options = { refreshMarginMs: 60_000, now: Date.now, fetchImpl: fetch, ...options };
    }

    async accessToken(connectionId: string, { force = false } = {}): Promise<string> {
        const connection = await this.load(connectionId);
        if (!force && !this.expiresSoon(connection.credentials)) {
            return connection.credentials.accessToken;
        }
        const pending = this.inFlight.get(connectionId);
        if (pending) {
            return pending;
        }
        const refresh = this.refresh(connectionId, connection.credentials.accessToken).finally(() => this.inFlight.delete(connectionId));
        this.inFlight.set(connectionId, refresh);
        return refresh;
    }

    private async load(connectionId: string): Promise<Connection> {
        const connection = await this.store.get(connectionId);
        if (!connection) {
            throw new ConnectionNotFoundError(`Connection ${connectionId} not found`);
        }
        return connection;
    }

    private expiresSoon(credentials: Credentials): boolean {
        return credentials.expiresAt - this.options.refreshMarginMs <= this.options.now();
    }

    private refresh(connectionId: string, staleToken: string): Promise<string> {
        return this.store.withRefreshLock(connectionId, async () => {
            const connection = await this.load(connectionId);
            if (connection.credentials.accessToken !== staleToken && !this.expiresSoon(connection.credentials)) {
                return connection.credentials.accessToken;
            }
            const provider = this.providers.get(connection.provider);
            if (!provider) {
                throw new RefreshFailedError(`No OAuth provider configured for ${connection.provider}`, 0);
            }
            const response = await this.options.fetchImpl(provider.tokenUrl, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    grant_type: "refresh_token",
                    refresh_token: connection.credentials.refreshToken,
                    client_id: provider.clientId,
                    client_secret: provider.clientSecret,
                }),
                signal: AbortSignal.timeout(15_000),
            });
            if (!response.ok) {
                throw new RefreshFailedError(`${provider.name} refused to refresh the token (HTTP ${response.status})`, response.status);
            }
            const token = (await response.json()) as TokenResponse;
            const credentials: Credentials = {
                accessToken: token.access_token,
                refreshToken: token.refresh_token ?? connection.credentials.refreshToken,
                expiresAt: this.options.now() + token.expires_in * 1000,
            };
            await this.store.save({ ...connection, credentials });
            return credentials.accessToken;
        });
    }
}
