// Read-only compatibility research for Pi 1.1.0. Never loads real credentials or makes HTTP requests.
// node --experimental-strip-types docs/research/pi-1.1.0-probes.mjs <pi-coding-agent package directory> <pi-ai package directory>
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateModelsCandidate } from '../../config-validation.ts';
import { planLegacySessionAffinityMigration, applyLegacySessionAffinityMigration } from '../../compat-settings.ts';

assert.ok(process.argv[2], 'Pass the pi-coding-agent package directory');
const root = resolve(process.argv[2]);
const aiRoot = resolve(process.argv[3] || join(root, 'node_modules/@earendil-works/pi-ai'));

for (const [dir, expectedVer] of [[root, '1.1.0'], [aiRoot, '1.1.0']]) {
  let metadata;
  try {
    metadata = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  } catch (cause) {
    throw new Error(`Cannot read package metadata at ${dir}`, { cause });
  }
  assert.equal(metadata.version, expectedVer, `Expected version ${expectedVer} at ${dir}, found ${metadata.version}`);
}

const load = (path) => import(pathToFileURL(path).href);
const { ModelConfig } = await load(join(root, 'dist/core/model-config.js'));
const { composeModelProvider } = await load(join(root, 'dist/core/provider-composer.js'));
const { azureProvider } = await load(join(aiRoot, 'dist/providers/azure.js'));
const { openaiProvider } = await load(join(aiRoot, 'dist/providers/openai.js'));

const scratchRoot = resolve('.worktrees/pi-1.1.0-research');
mkdirSync(scratchRoot, { recursive: true });
const scratch = await mkdtemp(join(scratchRoot, 'probe-'));
const rows = [];
const rates = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 };
let sequence = 0;

async function snapshot(config) {
  const path = join(scratch, `${++sequence}.json`);
  await writeFile(path, JSON.stringify(config));
  return ModelConfig.load(path);
}

function configFor(api = 'openai-completions', fields = {}, compat = {}) {
  return { providers: { probe: {
    api, baseUrl: 'https://example.invalid/v1', apiKey: 'synthetic-not-a-secret',
    models: [{ id: 'probe-model', reasoning: true, maxTokens: 32768, ...fields, compat }],
  } } };
}

async function compareSchema(name, config, expectedUpstream, expectedPlugin) {
  const snap = await snapshot(config);
  const upstream = !snap.getError();
  const plugin = validateModelsCandidate(config).length === 0;
  assert.equal(upstream, expectedUpstream, `${name}: upstream`);
  assert.equal(plugin, expectedPlugin, `${name}: plugin`);
  rows.push({ name, upstreamAccepts: upstream, pluginAccepts: plugin });
  return snap;
}

async function composed(config, providerId = 'probe', base) {
  const snap = await snapshot(config);
  assert.equal(snap.getError(), undefined);
  const provider = composeModelProvider(providerId, base, snap);
  return { provider, model: provider.getModels()[0] };
}

const tool = (name) => ({ name, description: name, parameters: { type: 'object', properties: {} } });
const transcript = { messages: [
  { role: 'system', content: 'Initial instruction', toolsAdded: [tool('first')], timestamp: 1 },
  { role: 'user', content: 'Hello', timestamp: 2 },
  { role: 'system', content: 'Later instruction', toolsAdded: [tool('second')], timestamp: 3 },
  { role: 'user', content: 'Continue', timestamp: 4 },
] };

async function payload(config, options = {}, context = transcript) {
  const { provider, model } = await composed(config);
  let captured;
  let networkAttempted = false;
  const result = await provider.streamSimple(model, context, {
    apiKey: 'synthetic-not-a-secret', maxRetries: 0, reasoning: 'high',
    ...options,
    fetch: async () => { networkAttempted = true; throw new Error('NETWORK_DISABLED'); },
    onPayload: (value) => { captured = value; throw new Error('PROBE_CAPTURED'); },
  }).result();
  assert.equal(networkAttempted, false, 'payload probe must never reach transport');
  assert.ok(captured, `builder did not reach onPayload: ${result.errorMessage}`);
  assert.match(result.errorMessage, /PROBE_CAPTURED/);
  return captured;
}

try {
  // 1-4: New model fields validation in 1.1.0 upstream vs plugin
  await compareSchema('new-model-fields-valid', configFor('openai-completions', {
    inputLimits: { images: { resize: { jpegQuality: 75 } } },
    promptCache: { short: 300, long: 3600 },
    samplingParamsByThinkingLevel: { high: { temperature: 0.7 } },
  }), true, true);
  await compareSchema('invalid-inputLimits', configFor('openai-completions', { inputLimits: { images: { resize: { jpegQuality: 101 } } } }), false, false);
  await compareSchema('invalid-promptCache', configFor('openai-completions', { promptCache: { short: 0 } }), false, false);
  await compareSchema('invalid-level-sampling', configFor('openai-completions', { samplingParamsByThinkingLevel: { high: [] } }), false, false);

  // 5-6: Compat union bypass tests
  await compareSchema('invalid-mid-conversation-flag', configFor('openai-completions', {}, { supportsMidConvoSystemMessages: 'yes' }), true, false);
  await compareSchema('fallback-list-over-limit', configFor('anthropic-messages', {}, {
    allowedFallbackModels: Array.from({ length: 4 }, (_, i) => ({ provider: 'probe', model: `fallback-${i}`, cost: rates })),
  }), true, false);

  // 7: Schema-omitted responses flags still accepted
  await compareSchema('schema-removed-but-live-responses-flags', configFor('openai-responses', {}, { supportsAdditionalTools: true, supportsToolSearch: true }), true, true);

  // 8: Azure inheritance
  const azure = azureProvider();
  const azureId = azure.getModels()[0].id;
  const azureConfig = { providers: { azure: { baseUrl: 'https://example.invalid/openai/v1', models: [{ id: azureId }] } } };
  await compareSchema('azure-native-inheritance', azureConfig, true, true);
  const migratedAzure = await composed(azureConfig, 'azure', azure);
  assert.equal(migratedAzure.model.provider, 'azure');
  const oldAzure = await snapshot({ providers: { 'azure-openai-responses': { models: [{ id: azureId }] } } });
  assert.throws(() => composeModelProvider('azure-openai-responses', undefined, oldAzure), /no "api" specified/);
  rows.push({ name: 'azure-provider-id-renamed-api-id-retained', newProviderComposes: true, oldProviderWithoutBaseFails: true, api: migratedAzure.model.api });

  // 9: Auth-only provider
  await compareSchema('auth-only-provider-valid', { providers: { openai: { apiKey: 'synthetic-not-a-secret' } } }, true, true);

  // 10: Metadata merge and sampling precedence
  const metadataConfig = configFor('openai-completions', {
    inputLimits: { images: { resize: { maxWidth: 1000, jpegQuality: 75 } } },
    promptCache: { short: 300 },
    samplingParams: { temperature: 1, top_p: 0.95 },
    samplingParamsByThinkingLevel: { high: { temperature: 0.8, top_k: 20 } },
  });
  metadataConfig.providers.probe.modelOverrides = { 'probe-model': {
    inputLimits: { images: { resize: { jpegQuality: 85 } } },
    promptCache: { long: 3600 },
    samplingParamsByThinkingLevel: { high: { top_k: 30 } },
  } };
  const { model: metadata } = await composed(metadataConfig);
  assert.deepEqual(metadata.inputLimits.images.resize, { maxWidth: 1000, jpegQuality: 85 });
  assert.deepEqual(metadata.promptCache, { short: 300, long: 3600 });
  assert.deepEqual(metadata.samplingParamsByThinkingLevel.high, { temperature: 0.8, top_k: 30 });
  const sample = await payload(metadataConfig, { samplingParams: { top_p: 0.6 } });
  assert.equal(sample.temperature, 0.8); assert.equal(sample.top_k, 30); assert.equal(sample.top_p, 0.6);
  rows.push({ name: 'metadata-merge-and-sampling-precedence', nestedOverridesPreserveBase: true, request: { temperature: sample.temperature, top_k: sample.top_k, top_p: sample.top_p } });

  // 11: Obsolete compat flags have no effect
  const baseCompletion = await payload(configFor());
  const legacyCompletion = await payload(configFor('openai-completions', {}, { deferredToolsMode: 'kimi' }));
  assert.deepEqual(legacyCompletion, baseCompletion);
  const baseAnthropic = await payload(configFor('anthropic-messages'));
  const legacyAnthropic = await payload(configFor('anthropic-messages', {}, { supportsToolReferences: true }));
  assert.deepEqual(legacyAnthropic, baseAnthropic);
  rows.push({ name: 'obsolete-compat-no-request-effect', deferredToolsMode: 'no effect in controlled transcript', supportsToolReferences: 'no effect in controlled transcript' });

  // 12: New mid-conversation controls consumed
  const nativeAnthropic = await payload(configFor('anthropic-messages', {}, { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true }));
  assert.notDeepEqual(nativeAnthropic, baseAnthropic);
  assert.match(JSON.stringify(nativeAnthropic), /tool_addition/);
  const nativeCompletion = await payload(configFor('openai-completions', {}, { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true }));
  assert.notDeepEqual(nativeCompletion, baseCompletion);
  rows.push({ name: 'new-mid-conversation-controls-consumed', anthropicInlineToolAddition: true, completionsPayloadChanged: true });

  // 13: Schema-omitted flags consumed in responses
  for (const flag of ['supportsAdditionalTools', 'supportsToolSearch']) {
    const baseline = await payload(configFor('openai-responses', {}, { supportsMidConvoSystemMessages: true }));
    const withFlag = await payload(configFor('openai-responses', {}, { supportsMidConvoSystemMessages: true, [flag]: true }));
    assert.notDeepEqual(withFlag, baseline);
    rows.push({ name: `schema-omitted-${flag}-consumed`, requestChanged: true });
  }

  // 14: allowedFallbackModels consumed
  const fallback = await payload(configFor('anthropic-messages', {}, { allowedFallbackModels: [{ provider: 'probe', model: 'fallback', cost: rates }] }));
  assert.deepEqual(fallback.fallbacks, [{ model: 'fallback' }]);
  rows.push({ name: 'allowedFallbackModels-consumed', fallbackModel: fallback.fallbacks[0].model });

  // 15: thinking-budget alias equivalence
  const alias = await payload(configFor('openai-completions', {}, { supportsThinkingTokenBudget: true }));
  const explicit = await payload(configFor('openai-completions', {}, { thinkingTokenBudgetField: 'thinking_token_budget' }));
  assert.deepEqual(alias, explicit);
  rows.push({ name: 'thinking-budget-alias-equivalence', samePayload: true });

  // 16: fixed legacy session affinity migration (explicit format preserved)
  const prior = { sendSessionIdHeader: false, sessionAffinityFormat: 'openrouter' };
  const plan = planLegacySessionAffinityMigration(prior, 'openai-responses');
  const migrated = applyLegacySessionAffinityMigration(prior, plan);
  assert.equal(migrated.sessionAffinityFormat, 'openrouter');
  assert.equal(migrated.sendSessionIdHeader, undefined);
  rows.push({ name: 'fixed-legacy-migration-preserves-explicit-new-field', observed: true });

  // 17: models.json remains chat-only
  const nonChatConfig = configFor('openrouter-images', { type: 'image' });
  const { model: nonChat } = await composed(nonChatConfig);
  assert.equal(nonChat.type, undefined);
  rows.push({ name: 'models-json-remains-chat-only', extraTypeDiscarded: true });

  // 18: 1.1.0 classifier model in openai provider (gpt-6-luna)
  // Verify that provider.getModels() returns only chat models, while getAllModels() exposes the classifier model
  const openai = openaiProvider();
  const chatLuna = openai.getModels().find((m) => m.id === 'gpt-6-luna');
  assert.ok(chatLuna, 'chat gpt-6-luna must be present in chat models');
  assert.equal(chatLuna.type, 'chat');
  assert.equal(chatLuna.api, 'openai-responses');

  const allLunas = openai.getAllModels().filter((m) => m.id === 'gpt-6-luna');
  assert.equal(allLunas.length, 2, 'getAllModels() must contain both chat and classifier gpt-6-luna models');
  const classifierLuna = allLunas.find((m) => m.type === 'classifier');
  assert.ok(classifierLuna, 'classifier gpt-6-luna must be present in getAllModels()');
  assert.equal(classifierLuna.api, 'openai-decisions');
  rows.push({ name: 'classifier-gpt-6-luna-dual-presence-in-1.1.0', chatApi: chatLuna.api, classifierApi: classifierLuna.api });

  process.stdout.write(JSON.stringify({
    versions: { pi: '1.1.0', piAi: '1.1.0' },
    probeCount: rows.length,
    rows,
    limits: [
      'Request probes stop at the production onPayload callback; no remote provider capability was tested.',
      'No real user settings, models, auth, or payload data was read or modified.'
    ]
  }, null, 2) + '\n');
} finally {
  await rm(scratch, { recursive: true, force: true });
}
