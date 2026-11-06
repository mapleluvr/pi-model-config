// Read-only public catalog probe. No provider credentials or model calls.
// Run: node --experimental-strip-types docs/research/pi-dev-model-cards/probe.mjs
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { normalizeEndpointModels } from '../../../endpoint-models.ts';

const base = 'https://pi.dev';
const observations = [];
const keepHeaders = /^(content-type|cache-control|etag|last-modified|vary|access-control-allow-origin|access-control-expose-headers|x-pi-model-catalog-.+)$/;
async function request(label, path, headers = {}) {
  const response = await fetch(base + path, {
    headers: { accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(30000),
  });
  const body = await response.text();
  let data = body;
  if (body && response.headers.get('content-type')?.includes('json')) {
    try {
      data = JSON.parse(body);
    } catch (cause) {
      throw new Error(`Invalid JSON from ${label}: ${response.status}`, { cause });
    }
  }
  const observation = {
    label, url: base + path, status: response.status,
    headers: Object.fromEntries([...response.headers].filter(([key]) => keepHeaders.test(key))),
    bytes: Buffer.byteLength(body),
    shape: Array.isArray(data) ? 'array' : typeof data,
  };
  if (!response.ok && response.status !== 304) observation.error = data;
  observations.push(observation);
  return { data, observation };
}
function distribution(models, key) {
  const counts = {};
  for (const model of models) {
    const value = key === 'type' ? model.type ?? 'chat' : model[key] ?? '(absent)';
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}
function shapeCounts(models) {
  const counts = {};
  for (const model of models) for (const key of Object.keys(model)) counts[key] = (counts[key] ?? 0) + 1;
  return counts;
}

const [providers, legacy, typed, deepseek, typedDeepseek, typedOpenrouter, ua, badVersion, badTypes, absent] = await Promise.all([
  request('providers', '/api/models/providers?pi-version=1.5.0'),
  request('legacy-all', '/api/models?pi-version=1.5.0'),
  request('typed-all', '/api/models?pi-version=1.5.0&types=chat,image,classifier'),
  request('legacy-deepseek-1.4', '/api/models/providers/deepseek?pi-version=1.4.0'),
  request('typed-deepseek', '/api/models/providers/deepseek?pi-version=1.5.0&types=chat,image,classifier'),
  request('types-chat-openrouter', '/api/models/providers/openrouter?pi-version=1.5.0&types=chat'),
  request('pi-user-agent', '/api/models/providers/deepseek', { 'user-agent': 'pi/1.4.0' }),
  request('invalid-version', '/api/models/providers/deepseek?pi-version=invalid'),
  request('invalid-types', '/api/models/providers/deepseek?types='),
  request('unknown-provider', '/api/models/providers/pi-model-config-nonexistent'),
  request('old-version', '/api/models/providers/deepseek?pi-version=0.1.0'),
]);
for (const result of [providers, legacy, typed, deepseek, typedDeepseek, typedOpenrouter, ua]) assert.equal(result.observation.status, 200);
assert(Array.isArray(providers.data));
assert(!Array.isArray(legacy.data));
assert(!Array.isArray(deepseek.data));
assert(Array.isArray(typedDeepseek.data));
assert.deepEqual(Object.keys(legacy.data).sort(), [...providers.data].sort());
for (const models of Object.values(typed.data)) assert(Array.isArray(models));
const allTyped = Object.values(typed.data).flat();
const allLegacy = Object.values(legacy.data).flatMap(models => Object.values(models));
assert(allLegacy.every(model => !model.type || model.type === 'chat'));
assert.deepEqual(deepseek.data, ua.data);
assert.equal(badVersion.observation.status, 400);
assert.equal(badTypes.observation.status, 400);
assert.equal(absent.observation.status, 404);

const etag = deepseek.observation.headers.etag;
assert(etag);
const conditional = await request('conditional-deepseek', '/api/models/providers/deepseek?pi-version=1.4.0', { 'if-none-match': etag });
assert.equal(conditional.observation.status, 304);
assert.equal(conditional.observation.bytes, 0);

const byIdentity = new Map();
for (const model of allTyped) {
  const key = `${model.provider}/${model.id}`;
  const types = byIdentity.get(key) ?? [];
  types.push(model.type ?? 'chat');
  byIdentity.set(key, types);
}
const duplicateIds = [...byIdentity].filter(([, types]) => types.length > 1);
const normalizedLegacy = normalizeEndpointModels(deepseek.data);
const normalizedTyped = normalizeEndpointModels(typedDeepseek.data);
assert.equal(normalizedLegacy.supported, false);
assert(normalizedTyped.models.every(model => Object.keys(model).every(key => key === 'id' || key === 'name')));

const output = {
  checkedAt: new Date().toISOString(),
  observations,
  summary: {
    providers: providers.data.length,
    legacyChatModels: allLegacy.length,
    typedModels: allTyped.length,
    types: distribution(allTyped, 'type'),
    typesChatQueryActuallyReturns: distribution(typedOpenrouter.data, 'type'),
    keysByType: Object.fromEntries(['chat', 'image', 'classifier'].map(type => [type, shapeCounts(allTyped.filter(model => (model.type ?? 'chat') === type))])),
    crossTypeDuplicateIdentityCount: duplicateIds.length,
    crossTypeDuplicateExamples: duplicateIds.slice(0, 4),
    currentNormalizer: { legacySupported: normalizedLegacy.supported, typedResult: normalizedTyped.models },
  },
  samples: {
    deepseek: deepseek.data['deepseek-v4-pro'],
    tiered: allTyped.find(model => model.provider === 'anthropic' && model.cost?.tiers?.length),
    cache: allTyped.find(model => model.provider === 'anthropic' && model.promptCache),
    image: allTyped.find(model => model.type === 'image'),
    classifier: allTyped.find(model => model.type === 'classifier'),
  },
};
await writeFile(new URL('./evidence.json', import.meta.url), JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ checkedAt: output.checkedAt, summary: output.summary, requests: observations.map(item => ({ label: item.label, status: item.status, bytes: item.bytes, shape: item.shape })) }, null, 2));
