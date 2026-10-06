/**
 * API list prices in USD per million tokens, used to estimate what subscription
 * usage would have cost on the API. Source: platform.claude.com/docs/en/about-claude/pricing
 * (fetched 2026-10-06). Cache writes: 5m = 1.25× input, 1h = 2× input.
 * OpenAI models have no built-in price; add them under "prices" in ~/.vibeportal/config.json.
 */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

const p = (input: number, output: number, cacheRead: number): Price => ({
  input,
  output,
  cacheRead,
  cacheWrite5m: input * 1.25,
  cacheWrite1h: input * 2,
});

// longest prefix wins, so more specific ids come first
const BUILTIN: [string, Price][] = [
  ['claude-fable-5-1', p(10, 50, 0.25)],
  ['claude-mythos-5-1', p(10, 50, 0.25)],
  ['claude-fable-5', p(10, 50, 1)],
  ['claude-mythos-5', p(10, 50, 1)],
  ['claude-opus-5-5', p(4, 20, 0.2)],
  ['claude-opus-5', p(5, 25, 0.5)],
  ['claude-opus-4-8', p(5, 25, 0.5)],
  ['claude-opus-4-7', p(5, 25, 0.5)],
  ['claude-opus-4-6', p(5, 25, 0.5)],
  ['claude-opus-4-5', p(5, 25, 0.5)],
  ['claude-opus-4-1', p(15, 75, 1.5)],
  ['claude-opus-4', p(15, 75, 1.5)],
  ['claude-sonnet-5-5', p(2, 10, 0.2)],
  ['claude-sonnet-5', p(2, 10, 0.2)],
  ['claude-sonnet-4-6', p(3, 15, 0.3)],
  ['claude-sonnet-4-5', p(3, 15, 0.3)],
  ['claude-sonnet-4', p(3, 15, 0.3)],
  ['claude-haiku-4-5', p(1, 5, 0.1)],
  ['claude-3-5-haiku', p(0.8, 4, 0.08)],
];

export type PriceOverrides = Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }>;

export class PriceBook {
  private table: [string, Price][];

  constructor(overrides: PriceOverrides = {}) {
    const extra: [string, Price][] = Object.entries(overrides)
      .filter(([, v]) => v && Number.isFinite(v.input) && Number.isFinite(v.output))
      .map(([k, v]) => [
        k,
        {
          input: v.input,
          output: v.output,
          cacheRead: v.cacheRead ?? v.input * 0.1,
          cacheWrite5m: v.cacheWrite ?? v.input * 1.25,
          cacheWrite1h: v.cacheWrite ?? v.input * 2,
        },
      ]);
    this.table = [...extra, ...BUILTIN].sort((a, b) => b[0].length - a[0].length);
  }

  find(model: string): Price | undefined {
    const m = model.toLowerCase();
    return this.table.find(([k]) => m === k || m.startsWith(k + '-') || m.startsWith(k + '@') || m.startsWith(k + '['))?.[1];
  }

  /** USD for one request's usage. */
  cost(model: string, u: { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }): number {
    const pr = this.find(model);
    if (!pr) return 0;
    return (
      (u.input * pr.input + u.output * pr.output + u.cacheRead * pr.cacheRead + u.cacheWrite5m * pr.cacheWrite5m + u.cacheWrite1h * pr.cacheWrite1h) /
      1e6
    );
  }
}
