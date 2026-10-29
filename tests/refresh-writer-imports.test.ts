import assert from "node:assert/strict";
import test from "node:test";
import { ESLint } from "eslint";

const eslint = new ESLint();
const writers = ["requestCacheRefresh", "claimCacheRefreshJobs", "storeCacheSnapshot", "releaseCacheRefreshJob"];

test("web entry points reject refresh writer imports, including aliases and namespaces", async () => {
  for (const filePath of ["app/fixture.ts", "proxy.ts"]) {
    for (const name of writers) {
      const [result] = await eslint.lintText(`import { ${name} as writer } from "@/modules/work/server"; void writer;`, { filePath });
      assert.ok(result.messages.some(({ ruleId }) => ruleId === "no-restricted-imports"), `${filePath}: ${name}`);
    }
    const [namespace] = await eslint.lintText('import * as cache from "@/modules/work/server"; void cache;', { filePath });
    assert.ok(namespace.messages.some(({ ruleId }) => ruleId === "no-restricted-imports"), filePath);
    const [reader] = await eslint.lintText('import { getCacheSnapshot } from "@/modules/work/server"; void getCacheSnapshot;', { filePath });
    assert.equal(reader.errorCount, 0);
    const [retired] = await eslint.lintText('import { load } from "@/modules/work/draft-test"; void load;', { filePath });
    assert.ok(retired.messages.some(({ ruleId }) => ruleId === "no-restricted-imports"), "retired runtime restriction remains enforced");
  }
  const [worker] = await eslint.lintText('import { storeCacheSnapshot } from "../modules/work/server"; void storeCacheSnapshot;', { filePath: "scripts/cache-worker.ts" });
  assert.equal(worker.errorCount, 0);
});
