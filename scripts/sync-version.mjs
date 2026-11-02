#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

const packageUrl = new URL("../package.json", import.meta.url);
const versionUrl = new URL("../src/version.ts", import.meta.url);
const packageJson = JSON.parse(await readFile(packageUrl, "utf8"));
const expected = `/** The installed SDK version. */\nexport const VERSION = ${JSON.stringify(packageJson.version)};\n`;
const current = await readFile(versionUrl, "utf8");

if (process.argv.includes("--check")) {
  if (current !== expected) {
    console.error(
      `SDK version mismatch: package.json is ${packageJson.version}, but src/version.ts is not synchronized.`,
    );
    process.exit(1);
  }
} else if (current !== expected) {
  await writeFile(versionUrl, expected);
  console.log(`Synchronized SDK runtime version to ${packageJson.version}.`);
}
