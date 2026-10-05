export interface OAuthProvider {
    name: string;
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
}

export interface Credentials {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
}

export interface Connection {
    id: string;
    provider: string;
    credentials: Credentials;
}

export interface ConnectionStore {
    get(connectionId: string): Promise<Connection | undefined>;
    save(connection: Connection): Promise<void>;
    withRefreshLock<T>(connectionId: string, action: () => Promise<T>): Promise<T>;
}

export class ConnectionNotFoundError extends Error {}

export class RefreshFailedError extends Error {
    readonly status: number;

    constructor(message: string, status: number) {
        super(message);
        this.status = status;
    }
}
