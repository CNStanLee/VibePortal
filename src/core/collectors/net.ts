/**
 * fetch for the plan-limit collectors: a dropped connection or a stalled one
 * is tried again a couple of times (flaky networks, VPNs coming up after a
 * wake), so one blip doesn't show an error until the next poll minutes later.
 * HTTP errors are answers, not blips: they come back as they are.
 */
export async function fetchRetry(url: string, init: RequestInit = {}, opts: { tries?: number; timeoutMs?: number; delays?: number[] } = {}): Promise<Response> {
  const tries = opts.tries ?? 3;
  const delays = opts.delays ?? [1500, 4000];
  for (let i = 0; ; i++) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
    } catch (e) {
      if (i + 1 >= tries) throw new Error(networkMessage(e));
      await new Promise((r) => setTimeout(r, delays[Math.min(i, delays.length - 1)]));
    }
  }
}

/** "fetch failed" says nothing: name the cause (ECONNRESET, ETIMEDOUT, ENOTFOUND, a timeout…). */
export function networkMessage(e: unknown): string {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  if (err?.name === 'TimeoutError') return 'network timeout';
  const cause = err?.cause?.code ?? err?.cause?.message;
  return cause ? `${err.message} (${cause})` : String(err?.message ?? e);
}
