import express from "express";
import { createHandler } from "graphql-http/lib/use/express";
import { graphql } from "graphql";
import {
  queryAccountExtrinsics,
  queryAccountTransfers,
  queryExtrinsics,
  queryEvents,
  queryTransfers,
  queryBlocks,
  searchByHash,
  getIndexerStats,
} from "./db";
import { getStatus, getChainName } from "./indexer";
import { schema, rootValue } from "./graphql";

const app = express();

// ─── GraphQL ─────────────────────────────────────────────────────

app.all("/graphql", createHandler({ schema, rootValue }));

// Serve GraphiQL playground
app.get("/graphiql", (_req, res) => {
  const chainName = getChainName();
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>${chainName} — GraphQL Explorer</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none"><rect width="32" height="32" rx="8" fill="%232563EB"/></svg>')}" />
  <style>body{height:100vh;margin:0;overflow:hidden}</style>
  <link rel="stylesheet" href="https://unpkg.com/graphiql@3/graphiql.min.css" />
</head>
<body>
  <div id="graphiql" style="height:100vh"></div>
  <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/graphiql@3/graphiql.min.js"></script>
  <script>
    const fetcher = GraphiQL.createFetcher({ url: '/graphql' });
    ReactDOM.createRoot(document.getElementById('graphiql')).render(
      React.createElement(GraphiQL, {
        fetcher,
        defaultQuery: \`# ${chainName} — Chain Indexer GraphQL API
{
  status {
    syncing
    lastIndexedBlock
    chainHead
    totalBlocks
    totalExtrinsics
    totalEvents
    totalTransfers
  }
  blocks(limit: 5) {
    blocks { number hash author extrinsic_count event_count timestamp }
    total
  }
}\`
      })
    );
  </script>
</body>
</html>`);
});

function paginate(query: { limit?: string; offset?: string; page?: string }) {
  const limit = Math.min(Number(query.limit) || 25, 100);
  const page = Number(query.page) || 1;
  const offset = Number(query.offset) || (page - 1) * limit;
  return { limit, offset };
}

// ─── Status ─────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/status", async (_req, res) => {
  try {
    const [indexerStatus, dbStats] = await Promise.all([
      getStatus(),
      getIndexerStats(),
    ]);
    res.json({ ...indexerStatus, ...dbStats });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Account Endpoints ──────────────────────────────────────────

app.get("/accounts/:address/extrinsics", async (req, res) => {
  try {
    const { limit, offset } = paginate(req.query as Record<string, string>);
    const result = await queryAccountExtrinsics(req.params.address, limit, offset);
    res.json({ extrinsics: result.rows, total: result.total, limit, offset });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/accounts/:address/transfers", async (req, res) => {
  try {
    const { limit, offset } = paginate(req.query as Record<string, string>);
    const result = await queryAccountTransfers(req.params.address, limit, offset);
    res.json({ transfers: result.rows, total: result.total, limit, offset });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── List Endpoints ─────────────────────────────────────────────

app.get("/extrinsics", async (req, res) => {
  try {
    const { limit, offset } = paginate(req.query as Record<string, string>);
    const result = await queryExtrinsics(limit, offset);
    res.json({ extrinsics: result.rows, total: result.total, limit, offset });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/events", async (req, res) => {
  try {
    const { limit, offset } = paginate(req.query as Record<string, string>);
    const { pallet, method } = req.query as Record<string, string>;
    const result = await queryEvents(limit, offset, pallet, method);
    res.json({ events: result.rows, total: result.total, limit, offset });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/transfers", async (req, res) => {
  try {
    const { limit, offset } = paginate(req.query as Record<string, string>);
    const result = await queryTransfers(limit, offset);
    res.json({ transfers: result.rows, total: result.total, limit, offset });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/blocks", async (req, res) => {
  try {
    const { limit, offset } = paginate(req.query as Record<string, string>);
    const result = await queryBlocks(limit, offset);
    res.json({ blocks: result.rows, total: result.total, limit, offset });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Search ─────────────────────────────────────────────────────

app.get("/search", async (req, res) => {
  try {
    const q = (req.query.q as string)?.trim();
    if (!q) return res.json({ result: null });

    // Block number
    if (/^\d+$/.test(q)) {
      return res.json({ result: { type: "block", value: Number(q) } });
    }

    // Hash
    if (/^0x[a-fA-F0-9]{64}$/.test(q)) {
      const result = await searchByHash(q);
      return res.json({ result });
    }

    // Address — check if has extrinsics or transfers
    const { total: extTotal } = await queryAccountExtrinsics(q, 1, 0);
    const { total: txTotal } = await queryAccountTransfers(q, 1, 0);
    if (extTotal > 0 || txTotal > 0) {
      return res.json({
        result: { type: "account", value: q, extrinsics: extTotal, transfers: txTotal },
      });
    }

    res.json({ result: null });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export { app };
