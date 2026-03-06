import { ApiPromise, WsProvider } from "@polkadot/api";
import {
  getLastIndexedBlock,
  insertBatch,
  BlockRow,
  ExtrinsicRow,
  EventRow,
  TransferRow,
} from "./db";

const BATCH_SIZE = Number(process.env.BATCH_SIZE) || 50;
const WS_URL = process.env.WS_URL || "ws://127.0.0.1:9944";

let api: ApiPromise;
let chainHead = 0;
let isSyncing = false;
let lastIndexedBlock = -1;

export function getStatus() {
  return {
    syncing: isSyncing,
    lastIndexedBlock,
    chainHead,
    behind: chainHead - lastIndexedBlock,
    wsUrl: WS_URL,
  };
}

export async function startIndexer() {
  console.log(`[indexer] connecting to ${WS_URL}`);
  const provider = new WsProvider(WS_URL);
  api = await ApiPromise.create({ provider });

  const chain = await api.rpc.system.chain();
  console.log(`[indexer] connected to ${chain.toString()}`);

  // Initial sync
  await catchUp();

  // Subscribe to new finalized blocks
  console.log("[indexer] subscribing to finalized heads");
  await api.rpc.chain.subscribeFinalizedHeads(async (header) => {
    chainHead = header.number.toNumber();
    if (!isSyncing) {
      await catchUp();
    }
  });
}

async function catchUp() {
  isSyncing = true;
  try {
    lastIndexedBlock = await getLastIndexedBlock();
    const finalizedHash = await api.rpc.chain.getFinalizedHead();
    const finalizedHeader = await api.rpc.chain.getHeader(finalizedHash);
    chainHead = finalizedHeader.number.toNumber();

    const startBlock = lastIndexedBlock + 1;
    if (startBlock > chainHead) {
      isSyncing = false;
      return;
    }

    const totalToIndex = chainHead - startBlock + 1;
    console.log(
      `[indexer] syncing blocks ${startBlock} → ${chainHead} (${totalToIndex} blocks)`
    );

    for (let from = startBlock; from <= chainHead; from += BATCH_SIZE) {
      const to = Math.min(from + BATCH_SIZE - 1, chainHead);
      await indexBlockRange(from, to);
      lastIndexedBlock = to;

      const progress = (((to - startBlock + 1) / totalToIndex) * 100).toFixed(1);
      if ((to - startBlock + 1) % 500 === 0 || to === chainHead) {
        console.log(
          `[indexer] ${progress}% — block ${to.toLocaleString()} / ${chainHead.toLocaleString()}`
        );
      }
    }

    console.log("[indexer] sync complete, watching for new blocks");
  } catch (err) {
    console.error("[indexer] sync error:", err);
  } finally {
    isSyncing = false;
  }
}

async function indexBlockRange(from: number, to: number) {
  const blocks: BlockRow[] = [];
  const extrinsics: ExtrinsicRow[] = [];
  const events: EventRow[] = [];
  const transfers: TransferRow[] = [];

  // Fetch all blocks in parallel
  const blockPromises = [];
  for (let num = from; num <= to; num++) {
    blockPromises.push(processBlock(num));
  }

  const results = await Promise.all(blockPromises);

  for (const result of results) {
    blocks.push(result.block);
    extrinsics.push(...result.extrinsics);
    events.push(...result.events);
    transfers.push(...result.transfers);
  }

  await insertBatch(blocks, extrinsics, events, transfers);
}

async function processBlock(blockNumber: number): Promise<{
  block: BlockRow;
  extrinsics: ExtrinsicRow[];
  events: EventRow[];
  transfers: TransferRow[];
}> {
  const hash = await api.rpc.chain.getBlockHash(blockNumber);
  const [signedBlock, allEvents] = await Promise.all([
    api.rpc.chain.getBlock(hash),
    api.query.system.events.at(hash),
  ]);

  const block = signedBlock.block;
  const header = block.header;

  // Extract timestamp
  let timestamp: number | null = null;
  for (const ext of block.extrinsics) {
    if (
      ext.method.section === "timestamp" &&
      ext.method.method === "set"
    ) {
      timestamp = Number(ext.method.args[0].toString());
      break;
    }
  }

  // Extract author from digest (Aura pre-runtime)
  let author: string | null = null;
  try {
    // Try to get author from Aura
    const apiAt = await api.at(hash);
    if (apiAt.query.aura) {
      const authorities = await apiAt.query.aura.authorities();
      const preRuntimeDigest = header.digest.logs.find(
        (log) => log.isPreRuntime
      );
      if (preRuntimeDigest && Array.isArray(authorities)) {
        const [engine, data] = preRuntimeDigest.asPreRuntime;
        if (engine.toString() === "aura") {
          // Slot-based author selection
          const slot = api.registry
            .createType("u64", data)
            .toNumber();
          const authorIdx = slot % authorities.length;
          author = authorities[authorIdx]?.toString() || null;
        }
      }
    }
  } catch {
    // Author extraction is best-effort
  }

  // Count events per extrinsic and total
  const eventRecords = allEvents as unknown as Array<{
    phase: { isApplyExtrinsic: boolean; asApplyExtrinsic: { toNumber(): number } };
    event: { section: string; method: string; data: unknown[] };
  }>;

  const blockExtrinsics: ExtrinsicRow[] = [];
  const blockEvents: EventRow[] = [];
  const blockTransfers: TransferRow[] = [];

  // Process extrinsics
  block.extrinsics.forEach((ext, extIdx) => {
    const signer = ext.isSigned ? ext.signer.toString() : null;
    const fee = (ext as unknown as { partialFee?: { toString(): string } }).partialFee?.toString() || null;

    blockExtrinsics.push({
      block_number: blockNumber,
      extrinsic_index: extIdx,
      pallet: ext.method.section,
      method: ext.method.method,
      signer,
      args: ext.method.args.map((a) => a.toJSON()),
      hash: ext.hash.toHex(),
      success: true, // Updated below from events
      fee,
      timestamp,
    });
  });

  // Process events
  let eventIndex = 0;
  for (const record of eventRecords) {
    const { event, phase } = record;
    const extIdx = phase.isApplyExtrinsic
      ? phase.asApplyExtrinsic.toNumber()
      : null;

    blockEvents.push({
      block_number: blockNumber,
      event_index: eventIndex++,
      extrinsic_index: extIdx,
      pallet: event.section,
      method: event.method,
      data: event.data.map((d) =>
        typeof d === "object" && d !== null && "toJSON" in d
          ? (d as { toJSON(): unknown }).toJSON()
          : d
      ),
      timestamp,
    });

    // Mark extrinsic as failed if ExtrinsicFailed event
    if (
      event.section === "system" &&
      event.method === "ExtrinsicFailed" &&
      extIdx !== null
    ) {
      const ext = blockExtrinsics[extIdx];
      if (ext) ext.success = false;
    }

    // Extract transfers
    if (event.section === "balances" && event.method === "Transfer") {
      const data = event.data;
      if (data.length >= 3) {
        const from = data[0]?.toString();
        const to = data[1]?.toString();
        const amount = data[2]?.toString();
        if (from && to && amount && extIdx !== null) {
          blockTransfers.push({
            block_number: blockNumber,
            extrinsic_index: extIdx,
            from_address: from,
            to_address: to,
            amount,
            success:
              blockExtrinsics[extIdx]?.success ?? true,
            timestamp,
          });
        }
      }
    }
  }

  return {
    block: {
      number: blockNumber,
      hash: hash.toHex(),
      parent_hash: header.parentHash.toHex(),
      state_root: header.stateRoot.toHex(),
      extrinsics_root: header.extrinsicsRoot.toHex(),
      author,
      extrinsic_count: block.extrinsics.length,
      event_count: eventRecords.length,
      timestamp,
    },
    extrinsics: blockExtrinsics,
    events: blockEvents,
    transfers: blockTransfers,
  };
}
