export class RetryableError extends Error {}
/** Job fails permanently (goes straight to dead-letter), e.g. provider rejected the request as invalid. */
export class PermanentError extends Error {}

export async function httpJson(
  url: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<{ status: number; body: any }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 15_000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
    if (res.status === 429 || res.status >= 500) {
      throw new RetryableError(`provider ${res.status}: ${text.slice(0, 300)}`);
    }
    if (res.status >= 400) {
      throw new PermanentError(`provider ${res.status}: ${text.slice(0, 300)}`);
    }
    return { status: res.status, body };
  } catch (e) {
    if (e instanceof RetryableError || e instanceof PermanentError) throw e;
    throw new RetryableError(`network error: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

export const form = (o: Record<string, string | number>): string =>
  new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();
