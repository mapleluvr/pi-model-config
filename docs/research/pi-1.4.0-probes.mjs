// Pi 1.4.0 compatibility probes for the current pi-model-config working tree.
// Run: node --experimental-strip-types docs/research/pi-1.4.0-probes.mjs <pi-coding-agent-1.4.0-package> <pi-ai-1.4.0-package>
// Uses synthetic files and credentials; the SDK request is intercepted in-process and no network is permitted.
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
assert.ok(process.argv[2] && process.argv[3], 'Pass both Pi 1.4.0 package directories');
const codingRoot = resolve(process.argv[2]);
const aiRoot = resolve(process.argv[3]);
const oldRoot = join(project, 'docs/research/upstream-1.1.0/coding-agent/package');
async function readJson(path) {
  const content = await readFile(path, 'utf8');
  try {
    return JSON.parse(content);
  } catch (cause) {
    throw new Error(`Invalid JSON in ${path}`, { cause });
  }
}
const [codingPkg, aiPkg, oldPkg] = await Promise.all([codingRoot, aiRoot, oldRoot].map((root) => readJson(join(root, 'package.json'))));
assert.equal(codingPkg.version, '1.4.0');
assert.equal(aiPkg.version, '1.4.0');
assert.equal(oldPkg.version, '1.1.0');

// The checked-in 1.1.0 snapshot has no installed node_modules. Resolve only the two
// dependencies imported by its ModelConfig module to exactly matching installed versions.
const entry = join(codingRoot, 'dist/core/model-config.js');
const hostRequire = createRequire(pathToFileURL(entry));
async function packageMetadata(name) {
  let dir = dirname(hostRequire.resolve(name));
  for (;;) {
    try {
      const pkg = await readJson(join(dir, 'package.json'));
      if (pkg.name === name) return pkg;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`Cannot find package metadata for ${name}`);
    dir = parent;
  }
}
for (const name of ['typebox', 'cross-spawn']) {
  const installed = await packageMetadata(name);
  assert.equal(installed.version, oldPkg.dependencies[name], `1.1.0 snapshot dependency ${name} must match exactly`);
}
const oldUrl = pathToFileURL(oldRoot + sep).href;
const hostEntryUrl = pathToFileURL(entry).href;
const shared = new Set(['typebox', 'typebox/compile', 'cross-spawn']);
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(oldUrl) && shared.has(specifier)) return next(specifier, { ...context, parentURL: hostEntryUrl });
    return next(specifier, context);
  },
});

const scratchRoot = join(project, '.worktrees/pi-1.4.0-research');
await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(join(scratchRoot, 'probe-'));
const agentDir = join(scratch, 'agent');
await mkdir(agentDir, { recursive: true });
// Strip inherited secrets and default profile locations inside this child process only.
const keep = new Set(['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT']);
for (const key of Object.keys(process.env)) if (!keep.has(key.toUpperCase())) delete process.env[key];
Object.assign(process.env, { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', HOME: scratch, USERPROFILE: scratch, TEMP: scratch, TMP: scratch });
const originalFetch = globalThis.fetch;
let outgoing = [];
globalThis.fetch = async (url, init) => {
  const destination = String(url);
  if (!destination.startsWith('https://probe.invalid/')) throw new Error(`BLOCKED_UNEXPECTED_NETWORK: ${destination}`);
  let body;
  try {
    body = JSON.parse(String(init?.body));
  } catch (cause) {
    throw new Error('Synthetic transport received a non-JSON request body', { cause });
  }
  outgoing.push({ destination, body });
  const chunks = [
    { id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: 1, model: 'probe-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] },
    { id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: 1, model: 'probe-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ];
  return new Response(chunks.map((x) => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
};

const load = (path) => import(pathToFileURL(path).href);
let session;
const rows = [];
try {
  const { ModelConfig: OldModelConfig } = await import(new URL('dist/core/model-config.js', oldUrl).href);
  const { ModelConfig } = await load(entry);
  const { ModelRuntime, DefaultResourceLoader, SettingsManager, SessionManager, createAgentSession } = await load(join(codingRoot, 'dist/index.js'));
  const { composeModelProvider } = await load(join(codingRoot, 'dist/core/provider-composer.js'));
  const { ProviderCompatSchema } = await load(join(aiRoot, 'dist/providers/compat-schema.js'));
  const { builtinProviders } = await load(join(aiRoot, 'dist/providers/all.js'));
  const { typesafeProvider } = await load(join(aiRoot, 'dist/providers/typesafe.js'));
  const { classify } = await load(join(aiRoot, 'dist/api/typesafe-system-one.js'));
  const { validateModelsCandidate, BUILT_IN_PROVIDERS_PI_1_1_0 } = await load(join(project, 'config-validation.ts'));
  const { readModelsConfig, writeModelsConfig } = await load(join(project, 'config.ts'));
  const { editCompatDraft } = await load(join(project, 'field-editors.ts'));

  const ids = builtinProviders().map((provider) => provider.id).sort();
  assert.deepEqual(ids, [...BUILT_IN_PROVIDERS_PI_1_1_0].sort());
  rows.push({ name: 'builtin-provider-identities', count: ids.length, matchesPlugin: true });

  const baseProvider = { api: 'openai-completions', baseUrl: 'https://probe.invalid/v1', apiKey: 'synthetic-key', models: [{ id: 'probe-model' }] };
  const base = { providers: { probe: baseProvider } };
  const goodCompat = { imageInput: 'state-image-urls', sendImageOptInHeader: false };
  const cases = [
    ['plain', base, true, true, true],
    ['valid-classifier-compat', { providers: { ...base.providers, typesafe: { compat: goodCompat } } }, true, true, true],
    ['invalid-image-input', { providers: { ...base.providers, typesafe: { compat: { imageInput: 'invalid' } } } }, true, false, false],
    ['invalid-image-opt-in', { providers: { ...base.providers, typesafe: { compat: { sendImageOptInHeader: 'false' } } } }, true, false, false],
    ['invalid-schema-metadata', { $schema: 42, ...base }, true, false, false],
    ['valid-schema-metadata', { $schema: 'https://example.invalid/models.schema.json', ...base }, true, true, true],
    ['invalid-existing-chat-compat', { providers: { probe: { ...baseProvider, compat: { supportsMaxOutputTokens: 'false' } } } }, true, false, false],
    ['zero-context-window', { providers: { probe: { ...baseProvider, models: [{ id: 'probe-model', contextWindow: 0 }] } } }, true, false, false],
  ];
  const path = join(scratch, 'models.json');
  for (const [name, config, oldExpected, newExpected, pluginExpected] of cases) {
    await writeFile(path, JSON.stringify(config));
    const [oldSnap, newSnap] = await Promise.all([OldModelConfig.load(path), ModelConfig.load(path)]);
    const oldAccepts = oldSnap.getError() === undefined;
    const newAccepts = newSnap.getError() === undefined;
    const pluginAccepts = validateModelsCandidate(config).length === 0;
    assert.deepEqual([oldAccepts, newAccepts, pluginAccepts], [oldExpected, newExpected, pluginExpected], name);
    if (oldAccepts && !newAccepts && !pluginAccepts) {
      // Reject an existing invalid file without changing its bytes.
      const original = await readFile(path, 'utf8');
      assert.throws(() => readModelsConfig(path), /document does not satisfy the Pi models schema/, name);
      assert.equal(await readFile(path, 'utf8'), original, name);
    }
    rows.push({ name, pi110: oldAccepts, pi140: newAccepts, plugin: pluginAccepts });
  }

  // A single invalid field invalidates the complete custom-provider snapshot, not the built-in catalog.
  const invalid = cases.find(([name]) => name === 'invalid-image-input')[1];
  await writeFile(path, JSON.stringify(invalid));
  const invalidRuntime = await ModelRuntime.create({ modelsPath: path, authPath: join(agentDir, 'auth.json'), allowModelNetwork: false });
  assert.match(invalidRuntime.getError(), /imageInput/);
  assert.equal(invalidRuntime.getModel('probe', 'probe-model'), undefined);
  assert.ok(invalidRuntime.getModels().length > 0, 'built-in catalog remains present');
  rows.push({ name: 'invalid-file-runtime-effect', customModelLoaded: false, builtinsRemain: true });

  // Finite negative-value matrix: not exhaustive and not a proof of all schema compatibility.
  const vals = [null, false, 0, 'bogus', [], {}];
  const pluginAcceptsPiRejects = new Set();
  const piAcceptsPluginRejects = new Set();
  for (const key of Object.keys(ProviderCompatSchema.properties)) {
    for (const val of vals) {
      const config = { providers: { probe: { ...baseProvider, compat: { [key]: val } } } };
      await writeFile(path, JSON.stringify(config));
      const piAccepts = (await ModelConfig.load(path)).getError() === undefined;
      const pluginAccepts = validateModelsCandidate(config).length === 0;
      if (!piAccepts && pluginAccepts) pluginAcceptsPiRejects.add(key);
      if (piAccepts && !pluginAccepts) piAcceptsPluginRejects.add(key);
    }
  }
  assert.deepEqual([...pluginAcceptsPiRejects].sort(), []);
  assert.deepEqual([...piAcceptsPluginRejects], []);
  rows.push({ name: 'compat-negative-matrix', fields: Object.keys(ProviderCompatSchema.properties).length, valuesPerField: vals.length, pluginAcceptsPiRejects: [...pluginAcceptsPiRejects].sort() });

  // Exercise the production editor's logic with scripted selections, then the production writer.
  let shown = [];
  const editorResult = await editCompatDraft({ ui: { select: async (_title, choices) => { shown = choices; return '保存并返回'; } } }, 'Provider Compat', goodCompat, undefined, 'provider');
  assert.equal(editorResult.status, 'save');
  assert.deepEqual(editorResult.value, goodCompat);
  assert.ok(shown.some((choice) => choice.includes('imageInput')));
  assert.ok(shown.some((choice) => choice.includes('sendImageOptInHeader')));
  const preserved = { providers: { ...base.providers, typesafe: { compat: editorResult.value } } };
  await rm(path, { force: true });
  writeModelsConfig(preserved, path);
  assert.equal((await ModelConfig.load(path)).getError(), undefined);
  assert.deepEqual(readModelsConfig(path).providers.typesafe.compat, goodCompat);
  rows.push({ name: 'provider-editor-pass-through', fieldsPreserved: true, fieldsOfferedInMenu: true, selection: 'scripted' });

  // Build a real 1.4.0 classifier payload, intercepting its transport before any network.
  for (const [name, compat] of [['default', {}], ['proxy-override', goodCompat]]) {
    await writeFile(path, JSON.stringify({ providers: { typesafe: { baseUrl: 'https://synthetic-proxy.invalid/v1', compat } } }));
    const snap = await ModelConfig.load(path);
    assert.equal(snap.getError(), undefined);
    const provider = composeModelProvider('typesafe', typesafeProvider(), snap);
    const model = provider.getAllModels().find((item) => item.type === 'classifier' && item.input.includes('image'));
    assert.ok(model);
    let request;
    const result = await classify(model, { state: { question: 'synthetic' }, questions: { ok: { type: 'bool', instructions: 'synthetic', criteria: { true: 'yes', false: 'no' } } }, images: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }] }, {
      apiKey: 'synthetic-key', maxRetries: 0,
      fetch: async (_url, init) => { request = { payload: JSON.parse(init.body), optIn: new Headers(init.headers).get('TypeSafe-Danger-Zone-Images') }; throw new Error('NETWORK_DISABLED_BY_PROBE'); },
    });
    assert.ok(request, result.errorMessage);
    assert.match(result.errorMessage, /NETWORK_DISABLED_BY_PROBE/);
    const actual = { assets: Boolean(request.payload.assets), imageUrl: JSON.stringify(request.payload.state).includes('image_url'), optIn: request.optIn };
    assert.deepEqual(actual, name === 'default' ? { assets: true, imageUrl: false, optIn: 'true' } : { assets: false, imageUrl: true, optIn: null });
    rows.push({ name: `classifier-${name}`, ...actual, transport: 'intercepted' });
  }

  // Load the real extension through Pi 1.4.0's loader and drive an SDK agent turn.
  await writeFile(join(agentDir, 'models.json'), JSON.stringify(base));
  await writeFile(join(agentDir, 'model-config-payloads.json'), JSON.stringify({ version: 1, extraPayloads: { [JSON.stringify(['probe', 'probe-model'])]: { probe_marker: 'hook-applied', temperature: 0.314 } } }));
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off' });
  const loader = new DefaultResourceLoader({ cwd: scratch, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [join(project, 'index.ts')] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(loader.getExtensions().extensions.length, 1);
  const runtime = await ModelRuntime.create({ modelsPath: join(agentDir, 'models.json'), authPath: join(agentDir, 'auth.json'), allowModelNetwork: false });
  const model = runtime.getModel('probe', 'probe-model');
  assert.ok(model);
  ({ session } = await createAgentSession({ cwd: scratch, agentDir, modelRuntime: runtime, model, thinkingLevel: 'off', resourceLoader: loader, sessionManager: SessionManager.inMemory(scratch), settingsManager, noTools: 'all' }));
  const errors = [];
  await session.bindExtensions({ mode: 'json', onError: (error) => errors.push(error) });
  outgoing = [];
  await session.prompt('synthetic offline probe');
  assert.equal(outgoing.length, 1);
  assert.equal(outgoing[0].body.probe_marker, 'hook-applied');
  assert.equal(outgoing[0].body.temperature, 0.314);
  assert.equal(session.getLastAssistantText(), 'OK');
  assert.deepEqual(errors, []);
  rows.push({ name: 'sdk-agent-request-hook', extensionLoaded: true, payloadHookApplied: true, mockedResponse: 'OK', externalNetwork: false });

  console.log(JSON.stringify({ testedPlugin: 'working-tree', codingAgent: codingPkg.version, piAi: aiPkg.version, cases: rows }, null, 2));
} finally {
  session?.dispose();
  globalThis.fetch = originalFetch;
  await rm(scratch, { recursive: true, force: true });
}
