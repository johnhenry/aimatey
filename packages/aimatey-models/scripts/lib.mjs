// Pure catalog-building logic (no network, no fs) so it can be unit-tested.
// scripts/generate.mjs does the I/O around it.

const DAY = 86400000;
export const STATUS_ORDER = ['current', 'legacy', 'deprecated', 'retired'];

/** provider id -> prefix OpenRouter uses for the same vendor's models. */
export const OPENROUTER_PREFIX = {
  anthropic: 'anthropic',
  openai: 'openai',
  gemini: 'google',
  xai: 'x-ai',
  mistral: 'mistralai',
  deepseek: 'deepseek',
  moonshot: 'moonshotai',
};

export const isoDate = (d) => new Date(d).toISOString().slice(0, 10);
const norm = (s) =>
  s
    .toLowerCase()
    .replace(/^models\//, '')
    .replace(/[._]/g, '-');
export const stripModelsPrefix = (id) => String(id).replace(/^models\//, '');

/** Promote status from dates: a passed retiresOn means retired, a passed deprecatedOn means deprecated. */
export function statusFromDates(m, today) {
  if (m.retiresOn && m.retiresOn <= today) return 'retired';
  if (m.deprecatedOn && m.deprecatedOn <= today && m.status !== 'retired') return 'deprecated';
  return m.status;
}

/** OpenRouter entry -> catalog-shaped gap filler (USD per 1M). */
export function fromOpenRouter(e) {
  const out = {};
  const ctx = e.top_provider?.context_length ?? e.context_length;
  if (ctx) out.contextWindow = ctx;
  if (e.top_provider?.max_completion_tokens)
    out.maxOutputTokens = e.top_provider.max_completion_tokens;
  const caps = {};
  if (Array.isArray(e.supported_parameters)) {
    caps.tools = e.supported_parameters.includes('tools');
    caps.json = e.supported_parameters.includes('response_format');
  }
  if (Array.isArray(e.architecture?.input_modalities))
    caps.vision = e.architecture.input_modalities.includes('image');
  if (Object.keys(caps).length) out.capabilities = caps;
  const per = (v) =>
    v == null || v === '' || Number.isNaN(Number(v))
      ? undefined
      : Math.round(Number(v) * 1e6 * 1e6) / 1e6;
  const input = per(e.pricing?.prompt),
    output = per(e.pricing?.completion);
  if (input !== undefined && output !== undefined && (input > 0 || output > 0)) {
    out.pricing = { inputPer1M: input, outputPer1M: output };
    const cached = per(e.pricing?.input_cache_read);
    if (cached !== undefined) out.pricing.cachedInputPer1M = cached;
  }
  return out;
}

function indexOpenRouter(entries) {
  const byNorm = new Map();
  for (const e of entries) if (!e.id.includes(':')) byNorm.set(norm(e.id), e);
  return byNorm;
}

function orEntryFor(index, providerId, modelId) {
  if (providerId === 'openrouter') return index.get(norm(modelId));
  const prefix = OPENROUTER_PREFIX[providerId];
  return prefix ? index.get(norm(`${prefix}/${modelId}`)) : undefined;
}

const pctDiff = (a, b) => (a === 0 && b === 0 ? 0 : Math.abs(a - b) / Math.max(a, b));

/**
 * @param {{overrides:object, live?:Record<string,{id:string,name?:string}[]>, openrouter?:object[], now?:number}} input
 * @returns {{catalog:object, report:{needsReview:string[], missingFromLive:string[], priceDrift:string[], filledFromOpenRouter:string[]}}}
 */
export function buildCatalog({ overrides, live = {}, openrouter = [], now = Date.now() }) {
  const today = isoDate(now);
  const orIndex = indexOpenRouter(openrouter);
  const report = { needsReview: [], missingFromLive: [], priceDrift: [], filledFromOpenRouter: [] };
  const providers = {};

  for (const [pid, p] of Object.entries(overrides.providers)) {
    const defaults = p.modelDefaults ?? {};
    const models = {};
    const merge = (id, base, source) => {
      const m = { id, ...base };
      if (defaults.capabilities || base.capabilities)
        m.capabilities = { ...defaults.capabilities, ...base.capabilities };
      if (m.pricing && !m.pricingAsOf) m.pricingAsOf = defaults.pricingAsOf ?? p.verifiedOn;
      if (!m.pricing) delete m.pricingAsOf;
      m.status = statusFromDates(m, today);
      if (source) m.source = source;
      return m;
    };
    for (const [id, base] of Object.entries(p.models ?? {})) models[id] = merge(id, base);

    const liveList = live[pid];
    if (liveList) {
      const liveIds = new Set(liveList.map((l) => stripModelsPrefix(l.id)));
      for (const l of liveList) {
        const id = stripModelsPrefix(l.id);
        if (models[id]) continue;
        models[id] = merge(
          id,
          { name: l.name || id, family: 'unknown', status: 'current' },
          'live'
        );
        report.needsReview.push(`${pid}/${id}`);
      }
      for (const [id, m] of Object.entries(models)) {
        if (m.status === 'current' && !liveIds.has(id) && m.source !== 'live')
          report.missingFromLive.push(`${pid}/${id}`);
      }
    }

    for (const [id, m] of Object.entries(models)) {
      const e = orEntryFor(orIndex, pid, id);
      if (!e) continue;
      const g = fromOpenRouter(e);
      let filled = false;
      for (const k of ['contextWindow', 'maxOutputTokens']) {
        if (m[k] === undefined && g[k] !== undefined) {
          m[k] = g[k];
          filled = true;
        }
      }
      if (g.capabilities) {
        m.capabilities = { ...g.capabilities, ...m.capabilities };
      }
      if (g.pricing && p.openrouterPricing !== false) {
        if (!m.pricing && m.status === 'current') {
          m.pricing = g.pricing;
          m.pricingAsOf = today;
          m.pricingSource = 'openrouter';
          filled = true;
        } else if (
          m.pricing &&
          pid !== 'openrouter' &&
          pctDiff(m.pricing.inputPer1M, g.pricing.inputPer1M) > 0.1
        ) {
          report.priceDrift.push(
            `${pid}/${id}: catalog ${m.pricing.inputPer1M}/${m.pricing.outputPer1M}, OpenRouter ${g.pricing.inputPer1M}/${g.pricing.outputPer1M}`
          );
        }
      }
      if (filled) report.filledFromOpenRouter.push(`${pid}/${id}`);
    }

    const out = { label: p.label };
    if (p.local) out.local = true;
    if (p.verifiedOn) out.verifiedOn = p.verifiedOn;
    if (p.sources) out.sources = p.sources;
    if (p.notes) out.notes = p.notes;
    if (p.openrouterPricing === false) out.openrouterPricing = false;
    out.recommended = p.recommended ?? {};
    if (p.limits) out.limits = p.limits;
    out.models = models;
    providers[pid] = out;
  }
  return { catalog: { schemaVersion: 1, generatedOn: today, providers }, report };
}

const flat = (c) => {
  const m = new Map();
  for (const [pid, p] of Object.entries(c?.providers ?? {}))
    for (const [id, e] of Object.entries(p.models)) m.set(`${pid}/${id}`, e);
  return m;
};

/** Added / removed / status / price / default changes between two catalogs. */
export function diffCatalogs(prev, next) {
  const a = flat(prev),
    b = flat(next);
  const d = { added: [], removed: [], statusChanged: [], priceChanged: [], defaultsChanged: [] };
  for (const [k, e] of b) {
    const o = a.get(k);
    if (!o) {
      d.added.push(`${k} (${e.status})`);
      continue;
    }
    if (o.status !== e.status) d.statusChanged.push(`${k}: ${o.status} -> ${e.status}`);
    const op = o.pricing,
      np = e.pricing;
    if (JSON.stringify(op) !== JSON.stringify(np)) {
      d.priceChanged.push(
        `${k}: ${op ? `${op.inputPer1M}/${op.outputPer1M}` : 'none'} -> ${np ? `${np.inputPer1M}/${np.outputPer1M}` : 'none'}`
      );
    }
  }
  for (const k of a.keys()) if (!b.has(k)) d.removed.push(k);
  for (const [pid, p] of Object.entries(next.providers)) {
    const was = prev?.providers?.[pid]?.recommended ?? {};
    for (const role of new Set([...Object.keys(was), ...Object.keys(p.recommended)])) {
      if (was[role] !== p.recommended[role])
        d.defaultsChanged.push(
          `${pid} ${role}: ${was[role] ?? 'none'} -> ${p.recommended[role] ?? 'none'}`
        );
    }
  }
  return d;
}

export function formatDiffMarkdown(diff, report, { today } = {}) {
  const sec = (title, items) =>
    items?.length
      ? `### ${title} (${items.length})\n${items.map((i) => `- ${i}`).join('\n')}\n\n`
      : '';
  const empty =
    Object.values(diff).every((v) => !v.length) &&
    Object.values(report ?? {}).every((v) => !v.length);
  let md = `## Model catalog refresh${today ? ` ${today}` : ''}\n\n`;
  if (empty) return md + 'No changes.\n';
  md +=
    sec('Added', diff.added) +
    sec('Removed', diff.removed) +
    sec('Status changes', diff.statusChanged) +
    sec('Price changes', diff.priceChanged) +
    sec('Recommended defaults changed', diff.defaultsChanged);
  if (report) {
    md +=
      sec('New in live lists, needs review (add to data/overrides.json)', report.needsReview) +
      sec('Current in catalog but missing from the live list', report.missingFromLive) +
      sec(
        'OpenRouter price differs from the catalog by more than 10% (not applied)',
        report.priceDrift
      ) +
      sec('Gaps filled from OpenRouter', report.filledFromOpenRouter);
  }
  return md;
}

/**
 * Staleness and completeness checks.
 * errors fail CI; warnings are printed only.
 * @param {object} catalog
 * @param {{now?:number, maxPricingAgeDays?:number, live?:Record<string,{id:string}[]>}} [opts]
 */
export function checkCatalog(catalog, { now = Date.now(), maxPricingAgeDays = 60, live } = {}) {
  const errors = [],
    warnings = [];
  const today = isoDate(now);
  for (const [pid, p] of Object.entries(catalog.providers)) {
    const ids = Object.keys(p.models);
    const current = Object.values(p.models).filter((m) => m.status === 'current');
    if (!p.local && current.length && !p.recommended.default)
      errors.push(`${pid}: has current models but no recommended default`);
    if (!p.local && !ids.length && !p.verifiedOn)
      warnings.push(`${pid}: not curated (no models, no verifiedOn); relies on the live list`);
    for (const [role, id] of Object.entries(p.recommended)) {
      if (!ids.length) continue; // gateways / uncurated providers
      const m = p.models[id];
      if (!m) {
        errors.push(`${pid}: recommended ${role} "${id}" is not in the catalog`);
        continue;
      }
      if (m.status !== 'current')
        errors.push(`${pid}: recommended ${role} "${id}" is ${m.status}, not current`);
      if (live?.[pid] && !live[pid].some((l) => stripModelsPrefix(l.id) === id))
        errors.push(
          `${pid}: recommended ${role} "${id}" is absent from the provider's live model list`
        );
    }
    for (const m of Object.values(p.models)) {
      if (m.successor && !p.models[m.successor])
        errors.push(`${pid}/${m.id}: successor "${m.successor}" is not in the catalog`);
      if (m.status !== 'current') continue;
      if (!m.pricing) {
        warnings.push(`${pid}/${m.id}: current model has no pricing`);
        continue;
      }
      const age = Math.floor((Date.parse(today) - Date.parse(m.pricingAsOf ?? '1970-01-01')) / DAY);
      if (!m.pricingAsOf || age > maxPricingAgeDays)
        errors.push(
          `${pid}/${m.id}: pricingAsOf ${m.pricingAsOf ?? 'missing'} is ${m.pricingAsOf ? `${age} days` : 'unknown age'} old (limit ${maxPricingAgeDays})`
        );
      if (m.pricingEffectiveUntil && m.pricingEffectiveUntil < today)
        errors.push(
          `${pid}/${m.id}: pricing note expired on ${m.pricingEffectiveUntil}; re-verify`
        );
    }
  }
  return { errors, warnings };
}
