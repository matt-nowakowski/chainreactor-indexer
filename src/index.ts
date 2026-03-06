import { initDb } from "./db";
import { startIndexer } from "./indexer";
import { app } from "./api";

const PORT = Number(process.env.PORT) || 4000;

async function main() {
  console.log("[main] initializing database");
  await initDb();

  console.log("[main] starting API server on port", PORT);
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[main] API listening on http://0.0.0.0:${PORT}`);
  });

  console.log("[main] starting indexer");
  await startIndexer();
}

main().catch((err) => {
  console.error("[main] fatal error:", err);
  process.exit(1);
});
