/**
 * Minimal, dependency-free client for the Socrata Open Data API (SODA 2.1).
 *
 * Only the parts this server needs: a GET query with SoQL parameters, a sane
 * timeout, and retries that respect `Retry-After` so we never hammer a public
 * endpoint. An app token is optional — Socrata serves anonymous traffic from a
 * shared, much smaller rate-limit pool, which is the usual cause of sudden 429s
 * in production.
 */

export interface SoqlParams {
  $select?: string;
  $where?: string;
  $group?: string;
  $having?: string;
  $order?: string;
  $limit?: number;
  $offset?: number;
  /** Socrata full-text search across all columns. */
  $q?: string;
}

export interface SocrataClientOptions {
  /** Host without scheme, e.g. `www.datos.gov.co`. */
  domain?: string;
  /** Four-by-four dataset identifier, e.g. `p6dx-8zbt`. */
  datasetId?: string;
  /** Optional Socrata app token; raises the rate limit. */
  appToken?: string;
  timeoutMs?: number;
  /** Extra attempts after the first failure. */
  maxRetries?: number;
  userAgent?: string;
  /** Full override of the resource URL. Used by the test suite. */
  baseUrl?: string;
  /** Injectable fetch, so tests can run without network access. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep, so retry tests do not actually wait. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export class SocrataError extends Error {
  readonly status?: number;
  readonly url?: string;
  readonly body?: string;

  constructor(message: string, info: { status?: number; url?: string; body?: string } = {}) {
    super(message);
    this.name = 'SocrataError';
    this.status = info.status;
    this.url = info.url;
    this.body = info.body;
  }
}

const DEFAULT_DOMAIN = 'www.datos.gov.co';
const DEFAULT_DATASET = 'p6dx-8zbt';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Quotes a SoQL string literal, escaping embedded single quotes. */
export function lit(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Case-insensitive "contains" predicate. */
export function containsClause(field: string, value: string): string {
  return `upper(${field}) like upper(${lit(`%${value}%`)})`;
}

/** Joins predicates with AND, dropping empty ones. */
export function and(...clauses: Array<string | undefined | null | false>): string | undefined {
  const parts = clauses.filter((c): c is string => typeof c === 'string' && c.trim().length > 0);
  return parts.length ? parts.map((p) => `(${p})`).join(' AND ') : undefined;
}

export class SocrataClient {
  private readonly url: string;
  private readonly appToken?: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(options: SocrataClientOptions = {}) {
    const domain = options.domain ?? DEFAULT_DOMAIN;
    const datasetId = options.datasetId ?? DEFAULT_DATASET;
    this.url = options.baseUrl ?? `https://${domain}/resource/${datasetId}.json`;
    this.appToken = options.appToken;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.userAgent = options.userAgent ?? 'secop-mcp/0.1 (+https://github.com/)';
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleepImpl = options.sleepImpl ?? sleep;
  }

  /** Builds the request URL for a set of SoQL parameters. Exposed for tests and debugging. */
  buildUrl(params: SoqlParams): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      search.set(key, String(value));
    }
    const qs = search.toString();
    return qs ? `${this.url}?${qs}` : this.url;
  }

  async query<T = Record<string, unknown>>(params: SoqlParams): Promise<T[]> {
    const url = this.buildUrl(params);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': this.userAgent,
    };
    if (this.appToken) headers['X-App-Token'] = this.appToken;

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await this.sleepImpl(this.backoffMs(attempt, lastError));
      try {
        const response = await this.withTimeout((signal) => this.fetchImpl(url, { headers, signal }));
        if (response.ok) {
          const data = (await response.json()) as unknown;
          if (!Array.isArray(data)) {
            throw new SocrataError('Socrata returned a non-array payload', { url, status: response.status });
          }
          return data as T[];
        }
        const body = await response.text().catch(() => '');
        const error = new SocrataError(
          `Socrata request failed with HTTP ${response.status}: ${body.slice(0, 300)}`,
          { url, status: response.status, body: body.slice(0, 2000) },
        );
        // 4xx other than 429 means the query itself is wrong; retrying cannot help.
        if (response.status !== 429 && response.status < 500) throw error;
        lastError = withRetryAfter(error, response.headers.get('retry-after'));
      } catch (error) {
        if (error instanceof SocrataError && error.status && error.status !== 429 && error.status < 500) throw error;
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new SocrataError(`Socrata request failed after ${this.maxRetries + 1} attempts`, { url });
  }

  /** Convenience wrapper for `select count(*)` queries. */
  async count(where?: string, extra: SoqlParams = {}): Promise<number> {
    const rows = await this.query<{ count: string }>({ ...extra, $select: 'count(*)', $where: where });
    return Number(rows[0]?.count ?? 0);
  }

  private backoffMs(attempt: number, lastError: unknown): number {
    const retryAfter = (lastError as { retryAfterMs?: number } | undefined)?.retryAfterMs;
    if (typeof retryAfter === 'number' && Number.isFinite(retryAfter)) {
      return Math.min(retryAfter, 30_000);
    }
    const base = 400 * 2 ** (attempt - 1);
    return Math.min(base + Math.floor(Math.random() * 200), 8_000);
  }

  private async withTimeout(run: (signal: AbortSignal) => Promise<Response>): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new SocrataError(`Timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
    try {
      return await run(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }
}

function withRetryAfter(error: SocrataError, header: string | null): SocrataError {
  if (!header) return error;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  if (Number.isFinite(ms) && ms > 0) {
    Object.assign(error, { retryAfterMs: ms });
  }
  return error;
}
