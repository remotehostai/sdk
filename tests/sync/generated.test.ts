// The typed helpers build ops. That they are current with
// apps/atlas/backends is checked in monorepo/generated.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";

import { checklist } from "../../src/sync/generated/checklist.js";
import { issues, newId } from "../../src/sync/index.js";

test("builders: ids are UUIDv7, ops carry their names", () => {
  assert.match(newId(), /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(issues.ops.setIssueState({ issue: "i", state: "s" }), {
    op: "set_issue_state",
    issue: "i",
    state: "s",
  });
  assert.equal(issues.records.issue, "issue");
  const put = checklist.putItem({ list_id: "l", text: "t" });
  assert.deepEqual(
    [put.op, put.backend, put.type, put.fields],
    ["put_record", "checklist", "item", { list_id: "l", text: "t" }],
  );
  assert.deepEqual(checklist.updateItem("x", { done: true }, { done: false }), {
    op: "update_record",
    backend: "checklist",
    type: "item",
    id: "x",
    set: { done: true },
    expect: { done: false },
  });
});
