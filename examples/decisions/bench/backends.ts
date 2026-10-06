/**
 * Backend specs for the benchmark CLI (`--backend <spec>`).
 *
 * | Spec | Backend |
 * |---|---|
 * | `ollama[:<model>]` | local Ollama `/v1/systemone` (default model `tev1:0.8b`) |
 * | `typesafe` | TypeSafe Jev (`TYPESAFE_API_KEY`) |
 * | `openrouter[:<model>]` | OpenRouter Decisions (`OPENROUTER_API_KEY`) |
 * | `cloudflare[:clef\|clef-flash]` | Workers AI Clef (`CLOUDFLARE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`) |
 * | `systemone:<url>` | any System One server (`SYSTEMONE_API_KEY` optional) |
 * | `emulated:<chatModel>` | a local Ollama chat model answering through structured output |
 * | `laya` | on-device Laya (`@receptron/laya` must be installed) |
 *
 * @module
 */

import type { BackendAdapter } from '@johnhenry/aimatey-types';

export const BACKEND_KINDS = [
  'ollama',
  'typesafe',
  'openrouter',
  'cloudflare',
  'systemone',
  'emulated',
  'laya',
] as const;
export type BackendKind = (typeof BACKEND_KINDS)[number];

export interface BackendSpec {
  readonly kind: BackendKind;
  /** Everything after the first colon: a model id, or a URL for `systemone`. */
  readonly arg: string | undefined;
}

/** Split `kind[:arg]` at the first colon only, so URLs and `name:tag` models survive. */
export function parseBackendSpec(spec: string): BackendSpec {
  const colon = spec.indexOf(':');
  const kind = (colon === -1 ? spec : spec.slice(0, colon)) as BackendKind;
  const arg = colon === -1 ? undefined : spec.slice(colon + 1) || undefined;
  if (!BACKEND_KINDS.includes(kind)) {
    throw new Error(`unknown backend '${kind}' (expected one of: ${BACKEND_KINDS.join(', ')})`);
  }
  if (kind === 'systemone' && !arg) {
    throw new Error("backend 'systemone' needs a URL: systemone:<url>");
  }
  if (kind === 'emulated' && !arg) {
    throw new Error("backend 'emulated' needs a chat model: emulated:<chatModel>");
  }
  return { kind, arg };
}

function requireEnv(name: string, kind: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`backend '${kind}' needs ${name} in the environment`);
  }
  return value;
}

/** Display label for a spec in reports. */
export function labelFor(spec: BackendSpec): string {
  return spec.arg ? `${spec.kind}:${spec.arg}` : spec.kind;
}

/** Instantiate a backend. Provider packages load lazily, so unused ones need not be installed. */
export async function createBackend(spec: BackendSpec): Promise<BackendAdapter> {
  const ollamaHost = process.env.OLLAMA_HOST?.startsWith('http')
    ? process.env.OLLAMA_HOST
    : process.env.OLLAMA_HOST
      ? `http://${process.env.OLLAMA_HOST}`
      : undefined;

  switch (spec.kind) {
    case 'ollama': {
      const { OllamaBackendAdapter } = await import('@johnhenry/aimatey-backend');
      return new OllamaBackendAdapter({
        baseURL: ollamaHost,
        defaultModel: spec.arg ?? process.env.BENCH_OLLAMA_MODEL ?? 'tev1:0.8b',
      });
    }
    case 'typesafe': {
      const { TypeSafeBackendAdapter } = await import('@johnhenry/aimatey-backend');
      return new TypeSafeBackendAdapter({
        apiKey: requireEnv('TYPESAFE_API_KEY', 'typesafe'),
        ...(spec.arg && { defaultModel: spec.arg }),
      });
    }
    case 'openrouter': {
      const { OpenRouterBackendAdapter } = await import('@johnhenry/aimatey-backend');
      return new OpenRouterBackendAdapter({
        apiKey: requireEnv('OPENROUTER_API_KEY', 'openrouter'),
        ...(spec.arg && { defaultModel: spec.arg }),
      });
    }
    case 'cloudflare': {
      const { CloudflareBackendAdapter } = await import('@johnhenry/aimatey-backend');
      return new CloudflareBackendAdapter({
        apiKey: requireEnv('CLOUDFLARE_API_KEY', 'cloudflare'),
        accountId: requireEnv('CLOUDFLARE_ACCOUNT_ID', 'cloudflare'),
        ...(spec.arg && { defaultModel: spec.arg }),
      });
    }
    case 'systemone': {
      const { SystemOneBackendAdapter } = await import('@johnhenry/aimatey-backend');
      return new SystemOneBackendAdapter({
        baseURL: spec.arg!,
        apiKey: process.env.SYSTEMONE_API_KEY,
        name: 'systemone',
      });
    }
    case 'emulated': {
      const { OllamaBackendAdapter } = await import('@johnhenry/aimatey-backend');
      const { createEmulatedDecisionBackend } = await import('@johnhenry/aimatey-patterns');
      const chat = new OllamaBackendAdapter({ baseURL: ollamaHost, defaultModel: spec.arg });
      return createEmulatedDecisionBackend(chat, { model: spec.arg });
    }
    case 'laya': {
      const { LayaBackendAdapter } = await import('@johnhenry/aimatey-native-laya');
      return new LayaBackendAdapter();
    }
  }
}
