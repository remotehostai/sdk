// The browser entry never reaches node:sqlite: @remotehost/sdk/sync's import
// graph (every static import from src/sync/index.ts) holds neither the
// SQLite store nor the module name, so a bundle of it cannot pull it in.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../../src/sync/index.ts", import.meta.url));

function graph(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen;
  seen.add(file);
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/(?:import|export)[^'"]*?from\s+["'](\.[^"']+)["']/g)) {
    graph(resolve(dirname(file), m[1]!.replace(/\.js$/, ".ts")), seen);
  }
  return seen;
}

test("the sync entry's graph never references node:sqlite", () => {
  const files = graph(entry);
  assert.ok(files.size > 5);
  for (const f of files) {
    assert.ok(!f.endsWith("stores/sqlite.ts"), `${f} is in the browser entry's graph`);
    assert.ok(!readFileSync(f, "utf8").includes("node:sqlite"), `${f} names node:sqlite`);
  }
});

test("package.json exports ./sync and ./sync/sqlite", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.exports["./sync"].import, "./dist/sync/index.js");
  assert.equal(pkg.exports["./sync/sqlite"].import, "./dist/sync/sqlite.js");
});

test("the sync entry offers the launch backends' helpers and no others", () => {
  const files = [...graph(entry)].map((f) => f.replace(/\\/g, "/"));
  const generated = files.filter((f) => /\/generated\/(?!protocol\.ts$)[^/]+\.ts$/.test(f));
  assert.deepEqual(generated.map((f) => f.slice(f.lastIndexOf("/") + 1)).sort(), [
    "issues.ts",
    "tasks.ts",
  ]);
});
