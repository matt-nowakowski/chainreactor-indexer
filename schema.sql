-- Chain Reactor Indexer Schema

CREATE TABLE IF NOT EXISTS indexer_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Seed initial state
INSERT INTO indexer_state (key, value) VALUES ('last_indexed_block', '-1')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS blocks (
  number         BIGINT PRIMARY KEY,
  hash           TEXT NOT NULL,
  parent_hash    TEXT NOT NULL,
  state_root     TEXT NOT NULL,
  extrinsics_root TEXT NOT NULL,
  author         TEXT,
  extrinsic_count INT NOT NULL DEFAULT 0,
  event_count    INT NOT NULL DEFAULT 0,
  timestamp      BIGINT,  -- ms since epoch
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS extrinsics (
  block_number    BIGINT NOT NULL REFERENCES blocks(number),
  extrinsic_index INT NOT NULL,
  pallet          TEXT NOT NULL,
  method          TEXT NOT NULL,
  signer          TEXT,
  args            JSONB,
  hash            TEXT NOT NULL,
  success         BOOLEAN NOT NULL DEFAULT TRUE,
  fee             TEXT,
  timestamp       BIGINT,
  PRIMARY KEY (block_number, extrinsic_index)
);

CREATE TABLE IF NOT EXISTS events (
  block_number     BIGINT NOT NULL REFERENCES blocks(number),
  event_index      INT NOT NULL,
  extrinsic_index  INT,
  pallet           TEXT NOT NULL,
  method           TEXT NOT NULL,
  data             JSONB,
  timestamp        BIGINT,
  PRIMARY KEY (block_number, event_index)
);

CREATE TABLE IF NOT EXISTS transfers (
  block_number     BIGINT NOT NULL REFERENCES blocks(number),
  extrinsic_index  INT NOT NULL,
  from_address     TEXT NOT NULL,
  to_address       TEXT NOT NULL,
  amount           TEXT NOT NULL,
  success          BOOLEAN NOT NULL DEFAULT TRUE,
  timestamp        BIGINT,
  PRIMARY KEY (block_number, extrinsic_index, from_address, to_address)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_extrinsics_signer ON extrinsics(signer) WHERE signer IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_extrinsics_pallet_method ON extrinsics(pallet, method);
CREATE INDEX IF NOT EXISTS idx_extrinsics_hash ON extrinsics(hash);
CREATE INDEX IF NOT EXISTS idx_events_pallet_method ON events(pallet, method);
CREATE INDEX IF NOT EXISTS idx_transfers_from ON transfers(from_address);
CREATE INDEX IF NOT EXISTS idx_transfers_to ON transfers(to_address);
CREATE INDEX IF NOT EXISTS idx_blocks_hash ON blocks(hash);
CREATE INDEX IF NOT EXISTS idx_blocks_author ON blocks(author) WHERE author IS NOT NULL;

CREATE TABLE IF NOT EXISTS remarks (
  id                SERIAL PRIMARY KEY,
  block_number      BIGINT NOT NULL REFERENCES blocks(number),
  block_hash        TEXT NOT NULL,
  extrinsic_hash    TEXT NOT NULL,
  extrinsic_index   INT NOT NULL,
  signer            TEXT,
  data_hex          TEXT NOT NULL,
  data_utf8         TEXT,
  content_hash      TEXT,
  timestamp         BIGINT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_remarks_signer ON remarks(signer) WHERE signer IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_remarks_block ON remarks(block_number);
CREATE INDEX IF NOT EXISTS idx_remarks_extrinsic_hash ON remarks(extrinsic_hash);
CREATE INDEX IF NOT EXISTS idx_remarks_content_hash ON remarks(content_hash) WHERE content_hash IS NOT NULL;
