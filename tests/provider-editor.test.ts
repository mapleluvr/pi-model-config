import assert from "node:assert/strict";
import test from "node:test";

import { buildProviderCategories } from "../provider-editor.ts";

function catalog(categories: ReturnType<typeof buildProviderCategories>): Array<[string, string[]]> {
  return categories.map((category) => [category.id, category.fields.map((field) => field.id)]);
}

test("Provider catalog uses the exact stable category and field IDs", () => {
  assert.deepEqual(catalog(buildProviderCategories("example", { models: [] })), [
    ["general", ["id", "name", "baseUrl", "api"]],
    ["http-auth", ["apiKey", "authHeader", "headers"]],
    ["models", ["manageModels", "fetchModels", "modelOverrides"]],
    ["compatibility", ["compat"]],
    ["actions", ["copy", "delete"]],
  ]);
});

test("Provider descriptors mask literals, preserve references, and always expose endpoint discovery", () => {
  const literal = buildProviderCategories("example", {
    apiKey: "literal-secret-value-9876",
    authHeader: false,
    headers: {},
    models: [],
    modelOverrides: {},
  });
  const literalFields = new Map(literal.flatMap((category) => category.fields.map((field) => [field.id, field])));
  assert.equal(literalFields.get("apiKey")?.displayValue, "************9876");
  assert.equal(literalFields.get("authHeader")?.displayValue, "false");
  assert.equal(literalFields.get("headers")?.displayValue, "0 项");
  assert.equal(literalFields.get("modelOverrides")?.displayValue, "0 个覆盖");
  assert.ok(literalFields.has("fetchModels"));

  for (const reference of ["$MODEL_API_KEY", "!credential read model"]) {
    const categories = buildProviderCategories("example", { apiKey: reference, models: [{ id: "one" }] });
    const apiKey = categories.find((category) => category.id === "http-auth")?.fields.find((field) => field.id === "apiKey");
    assert.equal(apiKey?.displayValue, reference);
    assert.ok(categories.find((category) => category.id === "models")?.fields.some((field) => field.id === "fetchModels"));
  }
});
