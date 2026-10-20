/**
 * @johnhenry/aimatey-models: helpers, generator core and checks.
 */
import { describe, it, expect } from 'vitest';
import {
  CATALOG,
  getProvider,
  getModel,
  recommendedModel,
  successorOf,
  isDeprecated,
  mergeLiveModels,
  limitsFor,
} from '../../packages/aimatey-models/src/index.js';
// @ts-expect-error plain ESM script, no types
import {
  buildCatalog,
  diffCatalogs,
  checkCatalog,
  fromOpenRouter,
  statusFromDates,
} from '../../packages/aimatey-models/scripts/lib.mjs';
import overrides from '../../packages/aimatey-models/data/overrides.json';
import catalogJson from '../../packages/aimatey-models/data/catalog.json';

const NOW = Date.parse('2026-10-20T12:00:00Z');

describe('shipped catalog', () => {
  it('data/catalog.json and the generated TS module are the same data', () => {
    expect(CATALOG).toEqual(catalogJson);
  });

  it('is exactly what the generator produces from overrides.json (offline)', () => {
    const { catalog } = buildCatalog({ overrides, now: Date.parse(catalogJson.generatedOn) });
    expect(catalog).toEqual(catalogJson);
  });

  it('recommends the Claude 5 family for Anthropic', () => {
    expect(recommendedModel('anthropic', 'default')?.id).toBe('claude-sonnet-5-5');
    expect(recommendedModel('anthropic', 'best')?.id).toBe('claude-opus-5-5');
    expect(recommendedModel('anthropic', 'fast')?.id).toBe('claude-haiku-5-5');
  });

  it('passes its own staleness and completeness checks', () => {
    const { errors } = checkCatalog(CATALOG, { now: NOW });
    expect(errors).toEqual([]);
  });

  it('every current priced model carries pricingAsOf', () => {
    for (const p of Object.values(CATALOG.providers))
      for (const m of Object.values(p.models))
        if (m.status === 'current' && m.pricing)
          expect(m.pricingAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('helpers', () => {
  it('successorOf follows the chain to a current model', () => {
    expect(successorOf('claude-opus-4-1-20250805')).toBe('claude-opus-5-5');
    expect(successorOf('gpt-4o-mini')).toBe('gpt-6-luna');
    expect(successorOf('claude-sonnet-5-5')).toBeUndefined();
    expect(successorOf('no-such-model')).toBeUndefined();
  });

  it('successorOf can be scoped to a provider', () => {
    expect(successorOf('gpt-4o', 'openai')).toBe('gpt-6-luna');
    expect(successorOf('gpt-4o', 'anthropic')).toBeUndefined();
  });

  it('isDeprecated is true for deprecated and retired, false for current/legacy/unknown', () => {
    expect(isDeprecated('claude-sonnet-4-5-20250929')).toBe(true);
    expect(isDeprecated('claude-3-haiku-20240307')).toBe(true);
    expect(isDeprecated('claude-sonnet-5-5')).toBe(false);
    expect(isDeprecated('claude-sonnet-4-6')).toBe(false); // legacy, still served
    expect(isDeprecated('not-in-catalog')).toBe(false);
  });

  it('limitsFor reads model, then provider limits', () => {
    expect(limitsFor('openai', 'gpt-6.1-sol')).toMatchObject({
      maxTools: 128,
      contextTokens: 1050000,
    });
    expect(limitsFor('chrome-ai', 'gemini-nano')).toMatchObject({ contextTokens: 4096 });
    expect(limitsFor('anthropic', 'claude-sonnet-5-5').maxTools).toBeUndefined();
    expect(limitsFor('openai', 'unknown-model')).toEqual({ maxTools: 128 });
  });
});

describe('mergeLiveModels', () => {
  const entries = Object.values(getProvider('anthropic')!.models);
  const rec = getProvider('anthropic')!.recommended;
  const live = (ids: string[]) => ({
    models: ids.map((id) => ({ id, name: id })),
    source: 'remote' as const,
    fetchedAt: 1,
    isComplete: true,
  });

  it('live is authoritative for availability', () => {
    const out = mergeLiveModels(entries, live(['claude-sonnet-5-5', 'claude-opus-5-5']), {
      recommended: rec,
    });
    expect(out.map((m) => m.id)).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5']);
    expect(out.every((m) => m.available)).toBe(true);
  });

  it('catalog supplies metadata and recommended roles; default sorts first', () => {
    const out = mergeLiveModels(entries, live(['claude-opus-5-5', 'claude-sonnet-5-5']), {
      recommended: rec,
    });
    expect(out[0]).toMatchObject({
      id: 'claude-sonnet-5-5',
      recommended: ['default'],
      status: 'current',
      inCatalog: true,
    });
    expect(out[0].contextWindow).toBe(1000000);
  });

  it('models missing from the catalog are kept, flagged inCatalog:false', () => {
    const out = mergeLiveModels(entries, live(['claude-brand-new-9']), { recommended: rec });
    expect(out).toEqual([
      expect.objectContaining({ id: 'claude-brand-new-9', inCatalog: false, available: true }),
    ]);
    expect(out[0].status).toBeUndefined();
  });

  it('orders current, uncatalogued, legacy, deprecated, retired', () => {
    const out = mergeLiveModels(
      entries,
      live([
        'claude-3-haiku-20240307',
        'claude-sonnet-4-5-20250929',
        'claude-sonnet-4-6',
        'zzz-new',
        'claude-haiku-5-5',
      ]),
      { recommended: rec }
    );
    expect(out.map((m) => m.id)).toEqual([
      'claude-haiku-5-5',
      'zzz-new',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5-20250929',
      'claude-3-haiku-20240307',
    ]);
  });

  it('strips Gemini-style models/ prefixes', () => {
    const g = Object.values(getProvider('gemini')!.models);
    const out = mergeLiveModels(g, live(['models/gemini-3.8-flash']));
    expect(out[0]).toMatchObject({ id: 'gemini-3.8-flash', inCatalog: true });
  });

  it('includeUnavailable adds catalog-only models flagged available:false', () => {
    const out = mergeLiveModels(entries, live(['claude-sonnet-5-5']), {
      recommended: rec,
      includeUnavailable: true,
    });
    const missing = out.find((m) => m.id === 'claude-opus-5-5');
    expect(missing).toMatchObject({ available: false, inCatalog: true });
  });
});

describe('generator core', () => {
  const ov = {
    providers: {
      acme: {
        label: 'Acme',
        verifiedOn: '2026-10-01',
        recommended: { default: 'a-1' },
        modelDefaults: { capabilities: { tools: true }, pricingAsOf: '2026-10-01' },
        models: {
          'a-1': {
            name: 'A1',
            family: 'a',
            status: 'current',
            pricing: { inputPer1M: 1, outputPer1M: 2 },
          },
          'a-old': {
            name: 'Old',
            family: 'a',
            status: 'current',
            deprecatedOn: '2026-09-01',
            retiresOn: '2026-10-10',
            successor: 'a-1',
          },
          'a-dep': {
            name: 'Dep',
            family: 'a',
            status: 'legacy',
            deprecatedOn: '2026-10-01',
            successor: 'a-1',
          },
        },
      },
    },
  };

  it('promotes status from dates', () => {
    const { catalog } = buildCatalog({ overrides: ov, now: NOW });
    expect(catalog.providers.acme.models['a-old'].status).toBe('retired');
    expect(catalog.providers.acme.models['a-dep'].status).toBe('deprecated');
    expect(statusFromDates({ status: 'current' }, '2026-10-20')).toBe('current');
  });

  it('adds live-only models as current + needsReview, and reports current models missing from live', () => {
    const { catalog, report } = buildCatalog({
      overrides: ov,
      live: { acme: [{ id: 'models/a-2', name: 'A2' }] },
      now: NOW,
    });
    expect(catalog.providers.acme.models['a-2']).toMatchObject({
      status: 'current',
      source: 'live',
    });
    expect(report.needsReview).toEqual(['acme/a-2']);
    expect(report.missingFromLive).toContain('acme/a-1');
  });

  it('overrides always win over OpenRouter; gaps are filled and dated', () => {
    const orRow = {
      id: 'acme/a-1',
      context_length: 5000,
      top_provider: { context_length: 5000, max_completion_tokens: 900 },
      pricing: { prompt: '0.000009', completion: '0.00002' },
      supported_parameters: ['tools'],
      architecture: { input_modalities: ['text', 'image'] },
    };
    const ov2 = JSON.parse(JSON.stringify(ov));
    ov2.providers.acme.models['a-1'].contextWindow = 777;
    const { catalog, report } = buildCatalog({ overrides: ov2, openrouter: [orRow], now: NOW });
    // acme is not a mapped vendor, so nothing is applied
    expect(catalog.providers.acme.models['a-1'].contextWindow).toBe(777);
    expect(report.filledFromOpenRouter).toEqual([]);
  });

  it('fills missing pricing/context from OpenRouter for mapped vendors and reports drift without applying it', () => {
    const ov3 = {
      providers: {
        openai: {
          label: 'OpenAI',
          verifiedOn: '2026-10-01',
          recommended: {},
          models: {
            'gpt-x': { name: 'X', family: 'g', status: 'current' },
            'gpt-y': {
              name: 'Y',
              family: 'g',
              status: 'current',
              pricing: { inputPer1M: 1, outputPer1M: 2 },
              pricingAsOf: '2026-10-01',
            },
          },
        },
      },
    };
    const orRows = [
      {
        id: 'openai/gpt-x',
        top_provider: { context_length: 4000, max_completion_tokens: 100 },
        pricing: { prompt: '0.000001', completion: '0.000003' },
        supported_parameters: ['tools'],
      },
      { id: 'openai/gpt-y', pricing: { prompt: '0.000005', completion: '0.00001' } },
    ];
    const { catalog, report } = buildCatalog({ overrides: ov3, openrouter: orRows, now: NOW });
    expect(catalog.providers.openai.models['gpt-x']).toMatchObject({
      contextWindow: 4000,
      maxOutputTokens: 100,
      pricing: { inputPer1M: 1, outputPer1M: 3 },
      pricingAsOf: '2026-10-20',
      pricingSource: 'openrouter',
    });
    expect(catalog.providers.openai.models['gpt-y'].pricing).toEqual({
      inputPer1M: 1,
      outputPer1M: 2,
    });
    expect(report.priceDrift).toHaveLength(1);
  });

  it('fromOpenRouter converts per-token strings to per-1M numbers', () => {
    expect(
      fromOpenRouter({
        pricing: { prompt: '0.000002', completion: '0.00001', input_cache_read: '0.0000002' },
      }).pricing
    ).toEqual({ inputPer1M: 2, outputPer1M: 10, cachedInputPer1M: 0.2 });
  });

  it('diffCatalogs reports added, removed, status and price changes', () => {
    const a = buildCatalog({ overrides: ov, now: NOW }).catalog;
    const ov2 = JSON.parse(JSON.stringify(ov));
    delete ov2.providers.acme.models['a-dep'];
    ov2.providers.acme.models['a-3'] = { name: 'A3', family: 'a', status: 'current' };
    ov2.providers.acme.models['a-1'].pricing = { inputPer1M: 2, outputPer1M: 2 };
    ov2.providers.acme.recommended.default = 'a-3';
    const d = diffCatalogs(a, buildCatalog({ overrides: ov2, now: NOW }).catalog);
    expect(d.added).toEqual(['acme/a-3 (current)']);
    expect(d.removed).toEqual(['acme/a-dep']);
    expect(d.priceChanged).toEqual(['acme/a-1: 1/2 -> 2/2']);
    expect(d.defaultsChanged).toEqual(['acme default: a-1 -> a-3']);
  });
});

describe('checkCatalog', () => {
  const base = () =>
    buildCatalog({
      overrides: {
        providers: {
          acme: {
            label: 'Acme',
            verifiedOn: '2026-10-19',
            recommended: { default: 'a-1' },
            modelDefaults: { pricingAsOf: '2026-10-19' },
            models: {
              'a-1': {
                name: 'A1',
                family: 'a',
                status: 'current',
                pricing: { inputPer1M: 1, outputPer1M: 2 },
              },
            },
          },
        },
      },
      now: NOW,
    }).catalog;

  it('passes a clean catalog', () => {
    expect(checkCatalog(base(), { now: NOW }).errors).toEqual([]);
  });

  it('fails on stale pricingAsOf', () => {
    const c = base();
    c.providers.acme.models['a-1'].pricingAsOf = '2026-01-01';
    expect(checkCatalog(c, { now: NOW }).errors[0]).toMatch(
      /pricingAsOf 2026-01-01 is 292 days old/
    );
  });

  it('fails when a recommended default is missing from the catalog', () => {
    const c = base();
    c.providers.acme.recommended.default = 'ghost';
    expect(checkCatalog(c, { now: NOW }).errors[0]).toMatch(/"ghost" is not in the catalog/);
  });

  it('fails when a provider has current models but no default', () => {
    const c = base();
    c.providers.acme.recommended = {};
    expect(checkCatalog(c, { now: NOW }).errors[0]).toMatch(/no recommended default/);
  });

  it('fails when the recommended default is not current', () => {
    const c = base();
    c.providers.acme.models['a-1'].status = 'deprecated';
    expect(checkCatalog(c, { now: NOW }).errors.join()).toMatch(/is deprecated, not current/);
  });

  it('with a live list, fails if the default is absent from it', () => {
    const r = checkCatalog(base(), { now: NOW, live: { acme: [{ id: 'other' }] } });
    expect(r.errors[0]).toMatch(/absent from the provider's live model list/);
  });

  it('fails on a dangling successor', () => {
    const c = base();
    c.providers.acme.models['a-1'].successor = 'nope';
    expect(checkCatalog(c, { now: NOW }).errors[0]).toMatch(/successor "nope"/);
  });
});

describe('OpenRouter pricing policy', () => {
  const ovr = (extra: object = {}) => ({
    providers: {
      deepseek: {
        label: 'D',
        verifiedOn: '2026-10-01',
        recommended: {},
        ...extra,
        models: {
          'm-cur': { name: 'cur', family: 'f', status: 'current' },
          'm-old': { name: 'old', family: 'f', status: 'legacy' },
        },
      },
    },
  });
  const rows = [
    { id: 'deepseek/m-cur', pricing: { prompt: '0.000001', completion: '0.000002' } },
    { id: 'deepseek/m-old', pricing: { prompt: '0.000001', completion: '0.000002' } },
  ];

  it('fills pricing only for current models', () => {
    const m = buildCatalog({ overrides: ovr(), openrouter: rows, now: NOW }).catalog.providers
      .deepseek.models;
    expect(m['m-cur'].pricing).toEqual({ inputPer1M: 1, outputPer1M: 2 });
    expect(m['m-old'].pricing).toBeUndefined();
  });

  it('openrouterPricing:false opts a provider out', () => {
    const m = buildCatalog({
      overrides: ovr({ openrouterPricing: false }),
      openrouter: rows,
      now: NOW,
    }).catalog.providers.deepseek.models;
    expect(m['m-cur'].pricing).toBeUndefined();
  });
});
