import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { validateModelsCandidate } from '../../config-validation.ts';

const u104 = 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent';
const a104 = path.join(u104, 'node_modules/@earendil-works/pi-ai');
const u110 = 'docs/research/upstream-1.1.0/coding-agent/package';
const a110 = 'docs/research/upstream-1.1.0/ai/package';

// 1. types.d.ts hunks & Settings
const patchText = fs.readFileSync('docs/research/types-diff.patch', 'utf8');
const hunksInPatch = patchText.match(/@@ \-\d+,\d+ \+\d+,\d+ @@/g);

const s104 = fs.readFileSync(path.join(u104, 'dist/core/settings-manager.d.ts'), 'utf8');
const s110 = fs.readFileSync(path.join(u110, 'dist/core/settings-manager.d.ts'), 'utf8');

function extractInterface(src, name) {
  const start = src.indexOf(`export interface ${name}`);
  const end = src.indexOf('export declare const DEFAULT_TOOL_NAMES', start);
  return src.slice(start, end).trim();
}
const if104 = extractInterface(s104, 'Settings');
const if110 = extractInterface(s110, 'Settings');

// 2. Load 1.1.0 ModelConfig & composer
const load = (p) => import(pathToFileURL(path.resolve(p)).href);
const { ModelConfig } = await load(path.join(u110, 'dist/core/model-config.js'));
const { composeModelProvider } = await load(path.join(u110, 'dist/core/provider-composer.js'));

const scratchDir = path.resolve('.worktrees/pi-1.1.0-research/reviewer-check');
fs.mkdirSync(scratchDir, { recursive: true });

async function snapshot(cfg) {
  const file = path.join(scratchDir, `${Date.now()}-${Math.random()}.json`);
  fs.writeFileSync(file, JSON.stringify(cfg));
  return ModelConfig.load(file);
}

// 2a. Inject { api: 'openrouter-images', type: 'image' }
const imageModelCfg = {
  providers: {
    probe: {
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'test',
      models: [{ id: 'img-model', api: 'openrouter-images', type: 'image' }]
    }
  }
};
const snapImg = await snapshot(imageModelCfg);
const providerImg = composeModelProvider('probe', undefined, snapImg);
const modelsImg = providerImg.getModels();
const imgModel = modelsImg.find(m => m.id === 'img-model');

// 2b. samplingParamsByThinkingLevel.high base vs override shallow vs deep merge
const samplingCfg = {
  providers: {
    probe: {
      api: 'openai-completions',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'test',
      models: [{
        id: 'sample-model',
        samplingParamsByThinkingLevel: {
          high: { nested: { a: 1, b: 2 } }
        }
      }],
      modelOverrides: {
        'sample-model': {
          samplingParamsByThinkingLevel: {
            high: { nested: { a: 3 } }
          }
        }
      }
    }
  }
};
const snapSample = await snapshot(samplingCfg);
const providerSample = composeModelProvider('probe', undefined, snapSample);
const sampleModel = providerSample.getModels()[0];
const highLevelResult = sampleModel.samplingParamsByThinkingLevel?.high;

// 2c. Validation for thinkingTokenBudgetField='max_tokens' and supportsThinkingTokenBudget='false'
const cfgBudget = {
  providers: {
    probe: {
      api: 'openai-completions',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'test',
      models: [{
        id: 'budget-model',
        reasoning: true,
        maxTokens: 32768,
        compat: { thinkingTokenBudgetField: 'max_tokens', supportsThinkingTokenBudget: 'false' }
      }]
    }
  }
};
const pluginBudgetErrors = validateModelsCandidate(cfgBudget);

// Also test what composeModelProvider does and whether streamSimple writes max_tokens with thinkingTokenBudgetField='max_tokens'
let capturedPayload;
const snapBudget = await snapshot(cfgBudget);
const providerBudget = composeModelProvider('probe', undefined, snapBudget);
const modelBudget = providerBudget.getModels()[0];

const transcript = { messages: [
  { role: 'user', content: 'Hello', timestamp: 1 }
] };

await providerBudget.streamSimple(modelBudget, transcript, {
  apiKey: 'test', reasoning: 'high', thinkingBudgets: { high: 4096 },
  fetch: async () => { throw new Error('NET_OFF'); },
  onPayload: (p) => { capturedPayload = p; throw new Error('CAPTURED'); }
}).result();

console.log(JSON.stringify({
  check1_typesHunksCount: hunksInPatch.length,
  check1_settingsInterfaceIdentical: if104 === if110,
  check2a_imageModelRetainedInGetModels: {
    present: !!imgModel,
    id: imgModel?.id,
    api: imgModel?.api,
    type: imgModel?.type
  },
  check2b_samplingLevelMerge: {
    highLevelResult,
    isShallowOverwritten: JSON.stringify(highLevelResult) === JSON.stringify({ nested: { a: 3 } })
  },
  check2c_budgetValidation: {
    pluginErrorCount: pluginBudgetErrors.length,
    pluginAcceptedInvalidValues: pluginBudgetErrors.length === 0,
    upstreamPayloadWroteMaxTokens: capturedPayload?.max_tokens === 4096,
    payloadField: 'max_tokens' in (capturedPayload || {}) ? capturedPayload.max_tokens : undefined
  }
}, null, 2));
