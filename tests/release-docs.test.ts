import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";

for (const file of ["README.md", "README-CN.md"]) {
  test(`${file} documents v1.1 model configuration behavior`, () => {
    const content = fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(content, /1\.1\.0/);
    assert.match(content, /JSONC/);
    assert.match(content, /model-config-payloads\.json/);
    assert.match(content, /max/);
    assert.doesNotMatch(content, /Register configured providers at Pi startup|启动时从 `models\.json` 注册/);
  });
}
