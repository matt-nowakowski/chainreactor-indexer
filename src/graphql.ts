import { buildSchema } from "graphql";
import {
  queryBlocks,
  queryBlock,
  queryExtrinsics,
  queryEvents,
  queryTransfers,
  queryAccountExtrinsics,
  queryAccountTransfers,
  searchByHash,
  getIndexerStats,
} from "./db";
import { getStatus } from "./indexer";

export const schema = buildSchema(`
  type Block {
    number: Int!
    hash: String!
    parent_hash: String!
    state_root: String!
    extrinsics_root: String!
    author: String
    extrinsic_count: Int!
    event_count: Int!
    timestamp: Float
  }

  type Extrinsic {
    block_number: Int!
    extrinsic_index: Int!
    pallet: String!
    method: String!
    signer: String
    args: String
    hash: String!
    success: Boolean!
    fee: String
    timestamp: Float
  }

  type Event {
    block_number: Int!
    event_index: Int!
    extrinsic_index: Int
    pallet: String!
    method: String!
    data: String
    timestamp: Float
  }

  type Transfer {
    block_number: Int!
    extrinsic_index: Int!
    from_address: String!
    to_address: String!
    amount: String!
    success: Boolean!
    timestamp: Float
  }

  type BlocksResult {
    blocks: [Block!]!
    total: Int!
  }

  type ExtrinsicsResult {
    extrinsics: [Extrinsic!]!
    total: Int!
  }

  type EventsResult {
    events: [Event!]!
    total: Int!
  }

  type TransfersResult {
    transfers: [Transfer!]!
    total: Int!
  }

  type SearchResult {
    type: String!
    value: String!
    extrinsics: Int
    transfers: Int
  }

  type IndexerStatus {
    syncing: Boolean!
    lastIndexedBlock: Int!
    chainHead: Int!
    behind: Int!
    wsUrl: String!
    totalBlocks: Int!
    totalExtrinsics: Int!
    totalEvents: Int!
    totalTransfers: Int!
  }

  type Query {
    blocks(limit: Int, offset: Int): BlocksResult!
    block(number: Int!): Block
    extrinsics(limit: Int, offset: Int): ExtrinsicsResult!
    events(limit: Int, offset: Int, pallet: String, method: String): EventsResult!
    transfers(limit: Int, offset: Int): TransfersResult!
    accountExtrinsics(address: String!, limit: Int, offset: Int): ExtrinsicsResult!
    accountTransfers(address: String!, limit: Int, offset: Int): TransfersResult!
    search(query: String!): SearchResult
    status: IndexerStatus!
  }
`);

function clampPagination(limit?: number, offset?: number) {
  const l = Math.min(Math.max(limit || 25, 1), 100);
  const o = Math.max(offset || 0, 0);
  return { limit: l, offset: o };
}

function serializeRow(row: Record<string, unknown>) {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if ((key === "args" || key === "data") && value !== null && value !== undefined) {
      result[key] = typeof value === "string" ? value : JSON.stringify(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export const rootValue = {
  async blocks({ limit, offset }: { limit?: number; offset?: number }) {
    const p = clampPagination(limit, offset);
    const result = await queryBlocks(p.limit, p.offset);
    return { blocks: result.rows, total: result.total };
  },

  async block({ number }: { number: number }) {
    return queryBlock(number);
  },

  async extrinsics({ limit, offset }: { limit?: number; offset?: number }) {
    const p = clampPagination(limit, offset);
    const result = await queryExtrinsics(p.limit, p.offset);
    return { extrinsics: result.rows.map(serializeRow), total: result.total };
  },

  async events({
    limit,
    offset,
    pallet,
    method,
  }: {
    limit?: number;
    offset?: number;
    pallet?: string;
    method?: string;
  }) {
    const p = clampPagination(limit, offset);
    const result = await queryEvents(p.limit, p.offset, pallet, method);
    return { events: result.rows.map(serializeRow), total: result.total };
  },

  async transfers({ limit, offset }: { limit?: number; offset?: number }) {
    const p = clampPagination(limit, offset);
    const result = await queryTransfers(p.limit, p.offset);
    return { transfers: result.rows, total: result.total };
  },

  async accountExtrinsics({
    address,
    limit,
    offset,
  }: {
    address: string;
    limit?: number;
    offset?: number;
  }) {
    const p = clampPagination(limit, offset);
    const result = await queryAccountExtrinsics(address, p.limit, p.offset);
    return { extrinsics: result.rows.map(serializeRow), total: result.total };
  },

  async accountTransfers({
    address,
    limit,
    offset,
  }: {
    address: string;
    limit?: number;
    offset?: number;
  }) {
    const p = clampPagination(limit, offset);
    const result = await queryAccountTransfers(address, p.limit, p.offset);
    return { transfers: result.rows, total: result.total };
  },

  async search({ query }: { query: string }) {
    const q = query.trim();
    if (!q) return null;

    // Block number
    if (/^\d+$/.test(q)) {
      return { type: "block", value: q };
    }

    // Hash
    if (/^0x[a-fA-F0-9]{64}$/.test(q)) {
      const result = await searchByHash(q);
      if (!result) return null;
      return { type: result.type, value: String(result.value) };
    }

    // Address
    const { total: extTotal } = await queryAccountExtrinsics(q, 1, 0);
    const { total: txTotal } = await queryAccountTransfers(q, 1, 0);
    if (extTotal > 0 || txTotal > 0) {
      return { type: "account", value: q, extrinsics: extTotal, transfers: txTotal };
    }

    return null;
  },

  async status() {
    const indexerStatus = getStatus();
    const dbStats = await getIndexerStats();
    return { ...indexerStatus, ...dbStats };
  },
};
