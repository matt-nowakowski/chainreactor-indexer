import { Pool } from "pg";
import fs from "fs";
import path from "path";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || "postgresql://indexer:indexer@localhost:5432/indexer",
});

export async function initDb() {
  const schema = fs.readFileSync(
    path.join(__dirname, "..", "schema.sql"),
    "utf-8"
  );
  await pool.query(schema);
  console.log("[db] schema initialized");
}

// ─── State ──────────────────────────────────────────────────────

export async function getLastIndexedBlock(): Promise<number> {
  const res = await pool.query(
    "SELECT value FROM indexer_state WHERE key = 'last_indexed_block'"
  );
  return res.rows.length > 0 ? Number(res.rows[0].value) : -1;
}

export async function setLastIndexedBlock(block: number) {
  await pool.query(
    "INSERT INTO indexer_state (key, value) VALUES ('last_indexed_block', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
    [String(block)]
  );
}

// ─── Inserts ────────────────────────────────────────────────────

export interface BlockRow {
  number: number;
  hash: string;
  parent_hash: string;
  state_root: string;
  extrinsics_root: string;
  author: string | null;
  extrinsic_count: number;
  event_count: number;
  timestamp: number | null;
}

export interface ExtrinsicRow {
  block_number: number;
  extrinsic_index: number;
  pallet: string;
  method: string;
  signer: string | null;
  args: unknown;
  hash: string;
  success: boolean;
  fee: string | null;
  timestamp: number | null;
}

export interface EventRow {
  block_number: number;
  event_index: number;
  extrinsic_index: number | null;
  pallet: string;
  method: string;
  data: unknown;
  timestamp: number | null;
}

export interface TransferRow {
  block_number: number;
  extrinsic_index: number;
  from_address: string;
  to_address: string;
  amount: string;
  success: boolean;
  timestamp: number | null;
}

export interface RemarkRow {
  block_number: number;
  block_hash: string;
  extrinsic_hash: string;
  extrinsic_index: number;
  signer: string | null;
  data_hex: string;
  data_utf8: string | null;
  content_hash: string | null;
  timestamp: number | null;
}

export async function insertBatch(
  blocks: BlockRow[],
  extrinsics: ExtrinsicRow[],
  events: EventRow[],
  transfers: TransferRow[],
  remarks: RemarkRow[] = []
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const b of blocks) {
      await client.query(
        `INSERT INTO blocks (number, hash, parent_hash, state_root, extrinsics_root, author, extrinsic_count, event_count, timestamp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (number) DO NOTHING`,
        [b.number, b.hash, b.parent_hash, b.state_root, b.extrinsics_root, b.author, b.extrinsic_count, b.event_count, b.timestamp]
      );
    }

    for (const e of extrinsics) {
      await client.query(
        `INSERT INTO extrinsics (block_number, extrinsic_index, pallet, method, signer, args, hash, success, fee, timestamp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT DO NOTHING`,
        [e.block_number, e.extrinsic_index, e.pallet, e.method, e.signer, JSON.stringify(e.args), e.hash, e.success, e.fee, e.timestamp]
      );
    }

    for (const ev of events) {
      await client.query(
        `INSERT INTO events (block_number, event_index, extrinsic_index, pallet, method, data, timestamp)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT DO NOTHING`,
        [ev.block_number, ev.event_index, ev.extrinsic_index, ev.pallet, ev.method, JSON.stringify(ev.data), ev.timestamp]
      );
    }

    for (const t of transfers) {
      await client.query(
        `INSERT INTO transfers (block_number, extrinsic_index, from_address, to_address, amount, success, timestamp)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT DO NOTHING`,
        [t.block_number, t.extrinsic_index, t.from_address, t.to_address, t.amount, t.success, t.timestamp]
      );
    }

    for (const r of remarks) {
      await client.query(
        `INSERT INTO remarks (block_number, block_hash, extrinsic_hash, extrinsic_index, signer, data_hex, data_utf8, content_hash, timestamp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT DO NOTHING`,
        [r.block_number, r.block_hash, r.extrinsic_hash, r.extrinsic_index, r.signer, r.data_hex, r.data_utf8, r.content_hash, r.timestamp]
      );
    }

    if (blocks.length > 0) {
      const maxBlock = Math.max(...blocks.map((b) => b.number));
      await client.query(
        "UPDATE indexer_state SET value = $1 WHERE key = 'last_indexed_block'",
        [String(maxBlock)]
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ─── Queries ────────────────────────────────────────────────────

export async function queryAccountExtrinsics(
  address: string,
  limit: number,
  offset: number
) {
  const res = await pool.query(
    `SELECT * FROM extrinsics WHERE signer = $1
     ORDER BY block_number DESC, extrinsic_index DESC
     LIMIT $2 OFFSET $3`,
    [address, limit, offset]
  );
  const countRes = await pool.query(
    "SELECT COUNT(*) FROM extrinsics WHERE signer = $1",
    [address]
  );
  return { rows: res.rows, total: Number(countRes.rows[0].count) };
}

export async function queryAccountTransfers(
  address: string,
  limit: number,
  offset: number
) {
  const res = await pool.query(
    `SELECT * FROM transfers WHERE from_address = $1 OR to_address = $1
     ORDER BY block_number DESC
     LIMIT $2 OFFSET $3`,
    [address, limit, offset]
  );
  const countRes = await pool.query(
    "SELECT COUNT(*) FROM transfers WHERE from_address = $1 OR to_address = $1",
    [address]
  );
  return { rows: res.rows, total: Number(countRes.rows[0].count) };
}

export async function queryExtrinsics(limit: number, offset: number) {
  const res = await pool.query(
    `SELECT * FROM extrinsics ORDER BY block_number DESC, extrinsic_index DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  const countRes = await pool.query("SELECT COUNT(*) FROM extrinsics");
  return { rows: res.rows, total: Number(countRes.rows[0].count) };
}

export async function queryEvents(
  limit: number,
  offset: number,
  pallet?: string,
  method?: string
) {
  let where = "";
  const params: (string | number)[] = [];
  let paramIdx = 1;

  if (pallet) {
    where += ` WHERE pallet = $${paramIdx++}`;
    params.push(pallet);
  }
  if (method) {
    where += where ? ` AND method = $${paramIdx++}` : ` WHERE method = $${paramIdx++}`;
    params.push(method);
  }

  const res = await pool.query(
    `SELECT * FROM events${where} ORDER BY block_number DESC, event_index DESC LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
    [...params, limit, offset]
  );
  const countRes = await pool.query(
    `SELECT COUNT(*) FROM events${where}`,
    params
  );
  return { rows: res.rows, total: Number(countRes.rows[0].count) };
}

export async function queryTransfers(limit: number, offset: number) {
  const res = await pool.query(
    `SELECT * FROM transfers ORDER BY block_number DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  const countRes = await pool.query("SELECT COUNT(*) FROM transfers");
  return { rows: res.rows, total: Number(countRes.rows[0].count) };
}

export async function queryBlock(number: number) {
  const res = await pool.query("SELECT * FROM blocks WHERE number = $1", [number]);
  return res.rows.length > 0 ? res.rows[0] : null;
}

export async function queryBlocks(limit: number, offset: number) {
  const res = await pool.query(
    `SELECT * FROM blocks ORDER BY number DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  const countRes = await pool.query("SELECT COUNT(*) FROM blocks");
  return { rows: res.rows, total: Number(countRes.rows[0].count) };
}

export async function searchByHash(hash: string) {
  // Try block hash
  const block = await pool.query("SELECT number FROM blocks WHERE hash = $1", [hash]);
  if (block.rows.length > 0) return { type: "block", value: block.rows[0].number };

  // Try extrinsic hash
  const ext = await pool.query(
    "SELECT block_number, extrinsic_index FROM extrinsics WHERE hash = $1 LIMIT 1",
    [hash]
  );
  if (ext.rows.length > 0)
    return {
      type: "extrinsic",
      value: `${ext.rows[0].block_number}-${ext.rows[0].extrinsic_index}`,
    };

  return null;
}

export async function queryRemarks(
  limit: number,
  offset: number,
  signer?: string,
  fromBlock?: number,
  toBlock?: number,
  search?: string
) {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  let paramIdx = 1;

  if (signer) {
    conditions.push(`signer = $${paramIdx++}`);
    params.push(signer);
  }
  if (fromBlock !== undefined) {
    conditions.push(`block_number >= $${paramIdx++}`);
    params.push(fromBlock);
  }
  if (toBlock !== undefined) {
    conditions.push(`block_number <= $${paramIdx++}`);
    params.push(toBlock);
  }
  if (search) {
    conditions.push(`(data_utf8 ILIKE $${paramIdx} OR data_hex ILIKE $${paramIdx} OR content_hash = $${paramIdx})`);
    params.push(`%${search}%`);
    paramIdx++;
  }

  const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";

  const res = await pool.query(
    `SELECT * FROM remarks${where} ORDER BY block_number DESC, extrinsic_index DESC LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
    [...params, limit, offset]
  );
  const countRes = await pool.query(
    `SELECT COUNT(*) FROM remarks${where}`,
    params
  );
  return { rows: res.rows, total: Number(countRes.rows[0].count) };
}

export async function queryRemarkByHash(extrinsicHash: string) {
  const res = await pool.query(
    "SELECT * FROM remarks WHERE extrinsic_hash = $1 LIMIT 1",
    [extrinsicHash]
  );
  return res.rows.length > 0 ? res.rows[0] : null;
}

export async function getIndexerStats() {
  const lastBlock = await getLastIndexedBlock();
  const blockCount = await pool.query("SELECT COUNT(*) FROM blocks");
  const extCount = await pool.query("SELECT COUNT(*) FROM extrinsics");
  const eventCount = await pool.query("SELECT COUNT(*) FROM events");
  const transferCount = await pool.query("SELECT COUNT(*) FROM transfers");
  const remarkCount = await pool.query("SELECT COUNT(*) FROM remarks");
  return {
    lastIndexedBlock: lastBlock,
    totalBlocks: Number(blockCount.rows[0].count),
    totalExtrinsics: Number(extCount.rows[0].count),
    totalEvents: Number(eventCount.rows[0].count),
    totalTransfers: Number(transferCount.rows[0].count),
    totalRemarks: Number(remarkCount.rows[0].count),
  };
}

export { pool };
