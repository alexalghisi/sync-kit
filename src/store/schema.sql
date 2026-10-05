CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS records (
    connection_id TEXT NOT NULL,
    model TEXT NOT NULL,
    external_id TEXT NOT NULL,
    hash TEXT NOT NULL,
    data JSONB NOT NULL,
    last_seen_run TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    PRIMARY KEY (connection_id, model, external_id)
);

CREATE TABLE IF NOT EXISTS checkpoints (
    connection_id TEXT NOT NULL,
    model TEXT NOT NULL,
    checkpoint JSONB NOT NULL,
    PRIMARY KEY (connection_id, model)
);
