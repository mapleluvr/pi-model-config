import test from "node:test";
import assert from "node:assert/strict";

import { applyCompatBooleanChoice } from "../compat-settings.ts";

test("sets compat boolean fields to explicit true, explicit false, or default deletion", () => {
  assert.deepEqual(
    applyCompatBooleanChoice({ keep: "yes" }, "supportsDeveloperRole", "true"),
    { keep: "yes", supportsDeveloperRole: true },
  );

  assert.deepEqual(
    applyCompatBooleanChoice({ keep: "yes", supportsDeveloperRole: true }, "supportsDeveloperRole", "false"),
    { keep: "yes", supportsDeveloperRole: false },
  );

  assert.deepEqual(
    applyCompatBooleanChoice({ keep: "yes", supportsDeveloperRole: false }, "supportsDeveloperRole", "default"),
    { keep: "yes" },
  );
});
