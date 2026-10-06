/**
 * Name-invariance check
 *
 * Decision models can follow the *name* of an option instead of its
 * definition (arXiv 2609.26758). This runs a request three ways -- as
 * written, with neutral keys, and with the names reassigned to other
 * definitions -- and reports how often the answer's meaning moved. No labels
 * needed: it compares the model with itself.
 *
 * @module
 */

import type {
  BackendAdapter,
  IRDecisionAnswer,
  IRDecisionQuestion,
  IRDecisionRequest,
  IRDecisionResponse,
} from '@johnhenry/aimatey-types';

/** Options for {@link nameInvariance}. */
export interface NameInvarianceOptions {
  /**
   * Passes of each kind (neutral keys, reassignment). The backend is called
   * `1 + 2 * trials` times (fewer when the request has no `choice` question
   * for the neutral arm).
   * @default 1
   */
  readonly trials?: number;

  /**
   * Seed for the shuffles and rotations, so a run is repeatable.
   * @default 1
   */
  readonly seed?: number;
}

/** Per-question flip rates. */
export interface NameInvarianceQuestion {
  /**
   * Fraction of reassignment trials where the answer followed the *name*:
   * the name it gave now points at a different definition than the one it
   * chose in the baseline run.
   */
  readonly flipRate: number;
  /**
   * Fraction of neutral-key trials where the answer, mapped back, differs
   * from the baseline. `null` for questions the neutral arm does not cover
   * (`noul`).
   */
  readonly neutralFlipRate: number | null;
}

/** Result of {@link nameInvariance}. */
export interface NameInvarianceReport {
  /**
   * Reassignment flip rate over every tested question and trial: how often
   * the meaning of the answer changed when names were pointed at other
   * definitions. 0 means the model reads definitions; high means it reads
   * names. (The paper measured 76.9 % for Laya and 32.5 % for Jev.)
   */
  readonly flipRate: number;
  /**
   * Neutral-key flip rate over every `choice` question and trial: the noise
   * floor of re-asking with different keys and order (the paper: 6.5 %).
   * `null` when the request has no `choice` question. Compare `flipRate`
   * against this, not against 0.
   */
  readonly neutralFlipRate: number | null;
  readonly perQuestion: Record<string, NameInvarianceQuestion>;
  readonly trials: number;
}

/** mulberry32 over a numeric seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Choice = Extract<IRDecisionQuestion, { type: 'choice' }>;
type Noul = Extract<IRDecisionQuestion, { type: 'noul' }>;

const isChoice = (q: IRDecisionQuestion): q is Choice =>
  q.type === 'choice' && Object.keys(q.criteria).length >= 2;
const isLabeledNoul = (q: IRDecisionQuestion): q is Noul =>
  q.type === 'noul' && q.criteria !== undefined;

/**
 * Run the name-invariance check against a decision backend.
 *
 * Pass 1 is the request as written. Pass 2 (neutral keys) rewrites each
 * `choice` question to shuffled `opt_1..n` keys with the original key folded
 * into the description, maps the answer back, and counts a flip when it
 * differs from pass 1. Pass 3 (reassignment) rotates each `choice`
 * question's names onto other definitions, and swaps the `true`/`false`
 * labels of each `noul` question that has them; a flip is counted when the
 * answer's *meaning* changed -- the name it gave now means something other
 * than what its pass-1 answer meant. A model that reads definitions answers
 * with the renamed option and does not flip; a model that reads names keeps
 * its name and flips.
 *
 * `score` questions and `noul` questions without `criteria` have no names to
 * reassign and are left out of `perQuestion`. Throws when nothing in the
 * request can be tested.
 *
 * Because this is a defensible estimate and not a proof, run enough trials
 * (and enough distinct requests) for the rates to mean something, and read
 * `flipRate` against `neutralFlipRate`.
 *
 * @example
 * ```typescript
 * const { flipRate, neutralFlipRate } = await nameInvariance(backend, request, { trials: 3 });
 * // flipRate 0.77 vs neutralFlipRate 0.06: this model follows names; wrap it
 * // in createNeutralOptionKeys() from @johnhenry/aimatey-patterns.
 * ```
 */
export async function nameInvariance(
  backend: BackendAdapter,
  request: IRDecisionRequest,
  options: NameInvarianceOptions = {}
): Promise<NameInvarianceReport> {
  if (typeof backend.decide !== 'function') {
    throw new Error(`nameInvariance: backend '${backend.metadata.name}' has no decide()`);
  }
  const decide = (r: IRDecisionRequest): Promise<IRDecisionResponse> => backend.decide!(r);
  const trials = Math.max(1, Math.floor(options.trials ?? 1));
  const random = rng(options.seed ?? 1);

  const entries = Object.entries(request.questions);
  const testable = entries.filter(([, q]) => isChoice(q) || isLabeledNoul(q));
  if (testable.length === 0) {
    throw new Error(
      'nameInvariance: nothing to test: the request has no choice question with 2+ options and no noul question with criteria'
    );
  }
  const hasChoice = entries.some(([, q]) => isChoice(q));

  const baseline = await decide(request);

  const stats: Record<string, { flips: number; total: number; nFlips: number; nTotal: number }> =
    {};
  for (const [name] of testable) {
    stats[name] = { flips: 0, total: 0, nFlips: 0, nTotal: 0 };
  }

  for (let t = 0; t < trials; t++) {
    // ---- neutral keys ----
    if (hasChoice) {
      const maps: Record<string, Map<string, string>> = {};
      const questions: Record<string, IRDecisionQuestion> = {};
      for (const [name, q] of entries) {
        if (!isChoice(q)) {
          questions[name] = q;
          continue;
        }
        const order = Object.entries(q.criteria);
        for (let i = order.length - 1; i > 0; i--) {
          const j = Math.floor(random() * (i + 1));
          [order[i], order[j]] = [order[j]!, order[i]!];
        }
        const map = new Map<string, string>();
        const criteria: Record<string, string> = {};
        order.forEach(([original, description], i) => {
          map.set(`opt_${i + 1}`, original);
          criteria[`opt_${i + 1}`] = `${original}: ${description}`;
        });
        maps[name] = map;
        questions[name] = { ...q, criteria };
      }
      const res = await decide({ ...request, questions });
      for (const [name, map] of Object.entries(maps)) {
        const got = res.answers[name];
        const base = baseline.answers[name];
        if (got?.type !== 'choice' || base?.type !== 'choice') {
          continue;
        }
        const s = stats[name]!;
        s.nTotal++;
        if ((map.get(got.value) ?? got.value) !== base.value) {
          s.nFlips++;
        }
      }
    }

    // ---- reassignment ----
    const questions: Record<string, IRDecisionQuestion> = {};
    for (const [name, q] of entries) {
      if (isChoice(q)) {
        const names = Object.keys(q.criteria);
        const descriptions = Object.values(q.criteria);
        const n = names.length;
        const shift = 1 + ((t + Math.floor(random() * n)) % (n - 1));
        const criteria: Record<string, string> = {};
        // The definition at position i now carries the name at position i + shift.
        descriptions.forEach((d, i) => {
          criteria[names[(i + shift) % n]!] = d;
        });
        // Keep the original key order so only the name -> definition binding moves.
        questions[name] = {
          ...q,
          criteria: Object.fromEntries(names.map((k) => [k, criteria[k]!])),
        };
      } else if (isLabeledNoul(q)) {
        questions[name] = { ...q, criteria: { true: q.criteria!.false, false: q.criteria!.true } };
      } else {
        questions[name] = q;
      }
    }
    const res = await decide({ ...request, questions });
    for (const [name] of testable) {
      const q = request.questions[name]!;
      const got = res.answers[name];
      const base = baseline.answers[name];
      if (!got || !base) {
        continue;
      }
      const s = stats[name]!;
      if (isChoice(q) && got.type === 'choice' && base.type === 'choice') {
        const after = (questions[name] as Choice).criteria[got.value];
        s.total++;
        if (after !== q.criteria[base.value]) {
          s.flips++;
        }
      } else if (isLabeledNoul(q) && got.type === 'noul' && base.type === 'noul') {
        s.total++;
        if (side(got) === side(base)) {
          s.flips++;
        } // same side, swapped meaning
      }
    }
  }

  const perQuestion: Record<string, NameInvarianceQuestion> = {};
  let flips = 0;
  let total = 0;
  let nFlips = 0;
  let nTotal = 0;
  for (const [name, s] of Object.entries(stats)) {
    perQuestion[name] = {
      flipRate: s.total > 0 ? s.flips / s.total : 0,
      neutralFlipRate: s.nTotal > 0 ? s.nFlips / s.nTotal : null,
    };
    flips += s.flips;
    total += s.total;
    nFlips += s.nFlips;
    nTotal += s.nTotal;
  }
  return {
    flipRate: total > 0 ? flips / total : 0,
    neutralFlipRate: nTotal > 0 ? nFlips / nTotal : null,
    perQuestion,
    trials,
  };
}

const side = (a: Extract<IRDecisionAnswer, { type: 'noul' }>): boolean => a.value >= 0.5;
