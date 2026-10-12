#!/usr/bin/env node

// Node 20 does not expand test globs; enumerate explicitly on every platform.
// node:test exits 0 when a describe() body throws, so the run gets the strict
// reporter beside this file, which fails it. Naming a reporter replaces
// node's default, so the log gets spec.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const strictReporter = new URL("./node-test-strict-reporter.mjs", import.meta.url).href;
const tests = readdirSync(new URL("tests/", root))
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => fileURLToPath(new URL(`tests/${name}`, root)));
if (!tests.length) throw new Error("No SDK test files found.");
const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(import.meta.resolve("tsx/cli")),
    "--test",
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    `--test-reporter=${strictReporter}`,
    "--test-reporter-destination=stderr",
    ...tests,
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
