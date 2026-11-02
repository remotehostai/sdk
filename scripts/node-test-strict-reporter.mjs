// A node:test reporter that fails a run whose top-level test or suite
// failed while node counted no failure.
//
// node:test exits 0 when a describe() body throws: it reports the suite
// `not ok` but counts no failure, so `npm test` would pass a file whose
// suite never ran. scripts/test.mjs adds this reporter beside the one that
// writes the log:
//
//   node --test \
//     --test-reporter=spec --test-reporter-destination=stdout \
//     --test-reporter=<path to this file> --test-reporter-destination=stderr \
//     <files>
//
// It writes nothing on a clean run. When a top-level test failed, it names
// each one and sets the exit status to 1. A suite that fails because a test
// inside it failed is top-level too, so a describe() that throws inside
// another is caught by the outer one. A failing TODO test does not count, as
// node does not count it.

export default async function* nodeTestStrictReporter(source) {
  const failed = [];
  for await (const event of source) {
    if (event.type !== "test:fail") continue;
    const { nesting, todo, name, file } = event.data;
    if (nesting !== 0 || (todo !== undefined && todo !== false)) continue;
    failed.push(file ? `${file}: ${name}` : name);
  }
  if (failed.length === 0) return;
  process.exitCode = 1;
  yield "node-test-strict-reporter: these top-level tests failed (node exits 0 on a describe() body that throws):\n" +
    failed.map((line) => `  not ok - ${line}\n`).join("");
}
