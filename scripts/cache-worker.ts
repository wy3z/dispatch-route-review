import { runCacheWorker } from "@/modules/work/worker";
import { database } from "../platform/database";

runCacheWorker()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await database().end(); });
