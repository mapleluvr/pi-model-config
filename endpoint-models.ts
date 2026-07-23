import type { ModelConfig, ProviderConfig } from "./types.ts";

const ENDPOINT_TIMEOUT_MS = 15_000;
const ENDPOINT_SOURCE_LIMIT = 512;
const SUMMARY_ID_LIMIT = 10;
const SUMMARY_ID_LENGTH = 80;

export interface EndpointIdSummary {
  ids: string[];
  remaining: number;
}

export interface NormalizedEndpointModels {
  supported: boolean;
  receivedCount: number;
  validCount: number;
  skippedCount: number;
  duplicateCount: number;
  models: ModelConfig[];
  idSummary: EndpointIdSummary;
}

export interface EndpointFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export interface EndpointFetchInit {
  method: "GET";
  headers: Record<string, string>;
  signal: AbortSignal;
}

export type EndpointFetch = (url: string, init: EndpointFetchInit) => Promise<EndpointFetchResponse>;

export interface EndpointModelDependencies {
  fetch: EndpointFetch;
  timeoutSignal: (milliseconds: number) => AbortSignal;
  getEnv: (name: string) => string | undefined;
}

export type EndpointFailureReason =
  | "missing-base-url"
  | "missing-api-key"
  | "request-failed"
  | "timeout"
  | "http-error"
  | "parse-error"
  | "unsupported-shape"
  | "empty"
  | "all-invalid";

export interface EndpointDiagnostic {
  attempt: 1 | 2;
  reason: Exclude<EndpointFailureReason, "missing-base-url" | "missing-api-key">;
  status?: number;
}

export interface EndpointDiscoverySuccess extends NormalizedEndpointModels {
  type: "success";
  source: string;
  supported: true;
}

export interface EndpointDiscoveryFailure {
  type: "failure";
  reason: EndpointFailureReason;
  diagnostics: EndpointDiagnostic[];
}

export type EndpointDiscoveryResult = EndpointDiscoverySuccess | EndpointDiscoveryFailure;

function summarizeIds(ids: readonly string[]): EndpointIdSummary {
  const displayed = ids.slice(0, SUMMARY_ID_LIMIT).map((id) => (
    id.length <= SUMMARY_ID_LENGTH ? id : `${id.slice(0, SUMMARY_ID_LENGTH - 3)}...`
  ));
  return { ids: displayed, remaining: Math.max(0, ids.length - displayed.length) };
}

export function summarizeEndpointIds(ids: readonly string[]): EndpointIdSummary {
  return summarizeIds(ids);
}

function extractRecords(raw: unknown): unknown[] | undefined {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return undefined;
  const candidate = raw as { data?: unknown; models?: unknown };
  if (Array.isArray(candidate.data)) return candidate.data;
  if (Array.isArray(candidate.models)) return candidate.models;
  return undefined;
}

export function normalizeEndpointModels(raw: unknown): NormalizedEndpointModels {
  const records = extractRecords(raw);
  if (!records) {
    return {
      supported: false,
      receivedCount: 0,
      validCount: 0,
      skippedCount: 0,
      duplicateCount: 0,
      models: [],
      idSummary: { ids: [], remaining: 0 },
    };
  }

  const models: ModelConfig[] = [];
  const seen = new Set<string>();
  let skippedCount = 0;
  let duplicateCount = 0;

  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      skippedCount += 1;
      continue;
    }
    const entry = record as { id?: unknown; name?: unknown };
    const trimmedId = typeof entry.id === "string" ? entry.id.trim() : "";
    const trimmedName = typeof entry.name === "string" ? entry.name.trim() : "";
    const id = trimmedId || trimmedName;
    if (!id) {
      skippedCount += 1;
      continue;
    }
    if (seen.has(id)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(id);
    models.push(trimmedName ? { id, name: trimmedName } : { id });
  }

  return {
    supported: true,
    receivedCount: records.length,
    validCount: models.length,
    skippedCount,
    duplicateCount,
    models,
    idSummary: summarizeIds(models.map((model) => model.id)),
  };
}

function defaultDependencies(): EndpointModelDependencies {
  return {
    fetch: (url, init) => globalThis.fetch(url, init) as Promise<EndpointFetchResponse>,
    timeoutSignal: (milliseconds) => AbortSignal.timeout(milliseconds),
    getEnv: (name) => process.env[name],
  };
}

export function sanitizeEndpointSource(source: string): string {
  let sanitized: string;
  try {
    const parsed = new URL(source);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    sanitized = parsed.toString();
  } catch {
    return "(configured endpoint)";
  }
  return sanitized.length <= ENDPOINT_SOURCE_LIMIT
    ? sanitized
    : `${sanitized.slice(0, ENDPOINT_SOURCE_LIMIT - 3)}...`;
}

function requestFailureReason(error: unknown): "timeout" | "request-failed" {
  if (error && typeof error === "object") {
    const name = (error as { name?: unknown }).name;
    if (name === "AbortError" || name === "TimeoutError") return "timeout";
  }
  return "request-failed";
}

export async function fetchEndpointModels(
  provider: ProviderConfig,
  dependencies: EndpointModelDependencies = defaultDependencies(),
): Promise<EndpointDiscoveryResult> {
  const configuredBaseUrl = typeof provider.baseUrl === "string" ? provider.baseUrl.trim() : "";
  const baseUrl = configuredBaseUrl.replace(/\/+$/, "");
  if (!baseUrl) return { type: "failure", reason: "missing-base-url", diagnostics: [] };

  const configuredKey = typeof provider.apiKey === "string" ? provider.apiKey : "";
  if (!configuredKey) return { type: "failure", reason: "missing-api-key", diagnostics: [] };
  const actualKey = configuredKey.startsWith("$")
    ? dependencies.getEnv(configuredKey.slice(1)) ?? ""
    : configuredKey;
  const headers: Record<string, string> = {};
  if (actualKey && actualKey !== "ollama") headers.Authorization = `Bearer ${actualKey}`;

  const endpoints = [`${baseUrl}/models`, `${baseUrl}/v1/models`];
  const diagnostics: EndpointDiagnostic[] = [];
  let lastReason: EndpointFailureReason = "request-failed";

  for (let index = 0; index < endpoints.length; index += 1) {
    const attempt = (index + 1) as 1 | 2;
    let response: EndpointFetchResponse;
    try {
      response = await dependencies.fetch(endpoints[index]!, {
        method: "GET",
        headers: { ...headers },
        signal: dependencies.timeoutSignal(ENDPOINT_TIMEOUT_MS),
      });
    } catch (error) {
      lastReason = requestFailureReason(error);
      diagnostics.push({ attempt, reason: lastReason });
      continue;
    }

    if (!response.ok) {
      lastReason = "http-error";
      diagnostics.push({ attempt, reason: lastReason, status: response.status });
      continue;
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      lastReason = "parse-error";
      diagnostics.push({ attempt, reason: lastReason });
      continue;
    }

    const normalized = normalizeEndpointModels(raw);
    if (!normalized.supported) {
      lastReason = "unsupported-shape";
      diagnostics.push({ attempt, reason: lastReason });
      continue;
    }
    if (normalized.receivedCount === 0) {
      lastReason = "empty";
      diagnostics.push({ attempt, reason: lastReason });
      continue;
    }
    if (normalized.models.length === 0) {
      lastReason = "all-invalid";
      diagnostics.push({ attempt, reason: lastReason });
      continue;
    }
    return {
      type: "success",
      source: sanitizeEndpointSource(endpoints[index]!),
      ...normalized,
      supported: true,
    };
  }

  return { type: "failure", reason: lastReason, diagnostics };
}

export function mergeDiscoveredModels(
  existing: readonly ModelConfig[],
  discovered: readonly ModelConfig[],
): ModelConfig[] {
  const merged = [...existing];
  const seen = new Set(existing.map((model) => model.id));
  for (const model of discovered) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    merged.push(model);
  }
  return merged;
}

export function replaceDiscoveredModels(
  existing: readonly ModelConfig[],
  discovered: readonly ModelConfig[],
): ModelConfig[] {
  const existingById = new Map(existing.map((model) => [model.id, model]));
  const replaced: ModelConfig[] = [];
  const seen = new Set<string>();
  for (const model of discovered) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    replaced.push(existingById.get(model.id) ?? model);
  }
  return replaced;
}
