import { strict as assert } from 'node:assert';
import test from 'node:test';

import { SocrataClient, SocrataError, and, containsClause, lit } from '../dist/socrata.js';

const BASE = 'https://example.test/resource/abcd-1234.json';

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

test('lit escapes single quotes so a value cannot break out of the literal', () => {
  assert.equal(lit("O'Brien"), "'O''Brien'");
  assert.equal(lit("x' OR 1=1 --"), "'x'' OR 1=1 --'");
});

test('containsClause builds a case-insensitive match', () => {
  assert.equal(containsClause('entidad', 'alcaldía'), "upper(entidad) like upper('%alcaldía%')");
});

test('and() wraps and drops empty clauses', () => {
  assert.equal(and('a = 1', undefined, '', 'b = 2'), '(a = 1) AND (b = 2)');
  assert.equal(and(undefined, ''), undefined);
});

test('buildUrl serializes only the parameters that carry a value', () => {
  const client = new SocrataClient({ baseUrl: BASE, fetchImpl: async () => jsonResponse([]) });
  const url = client.buildUrl({ $select: 'count(*)', $where: "a = 'b'", $limit: 5, $offset: 0, $q: undefined });
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('$select'), 'count(*)');
  assert.equal(parsed.searchParams.get('$where'), "a = 'b'");
  assert.equal(parsed.searchParams.get('$limit'), '5');
  assert.equal(parsed.searchParams.has('$q'), false, 'an undefined parameter is never sent');
  // Zero is a real value, so it survives: only undefined/null/'' are dropped.
  assert.equal(parsed.searchParams.get('$offset'), '0');
});

test('query sends the app token only when one is configured', async () => {
  const seen = [];
  const withToken = new SocrataClient({
    baseUrl: BASE,
    appToken: 'tok_123',
    fetchImpl: async (url, init) => {
      seen.push(init.headers['X-App-Token']);
      return jsonResponse([{ ok: true }]);
    },
  });
  await withToken.query({ $limit: 1 });

  const anonymous = new SocrataClient({
    baseUrl: BASE,
    fetchImpl: async (url, init) => {
      seen.push(init.headers['X-App-Token']);
      return jsonResponse([]);
    },
  });
  await anonymous.query({ $limit: 1 });

  assert.deepEqual(seen, ['tok_123', undefined]);
});

test('count() reads the scalar out of a count(*) query', async () => {
  const client = new SocrataClient({
    baseUrl: BASE,
    fetchImpl: async (url) => {
      assert.ok(url.includes('%24select=count%28*%29'));
      return jsonResponse([{ count: '78562' }]);
    },
  });
  assert.equal(await client.count("departamento_entidad = 'Tolima'"), 78562);
});

test('a 429 is retried and Retry-After decides the delay', async () => {
  const delays = [];
  let calls = 0;
  const client = new SocrataClient({
    baseUrl: BASE,
    maxRetries: 2,
    sleepImpl: async (ms) => void delays.push(ms),
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '2' } });
      return jsonResponse([{ id: 'CO1.REQ.1' }]);
    },
  });

  const rows = await client.query({ $limit: 1 });
  assert.equal(calls, 2);
  assert.deepEqual(delays, [2000]);
  assert.equal(rows[0].id, 'CO1.REQ.1');
});

test('a 5xx is retried until the attempt budget is spent, then throws', async () => {
  let calls = 0;
  const client = new SocrataClient({
    baseUrl: BASE,
    maxRetries: 2,
    sleepImpl: async () => {},
    fetchImpl: async () => {
      calls++;
      return new Response('upstream exploded', { status: 503 });
    },
  });

  await assert.rejects(() => client.query({ $limit: 1 }), (error) => {
    assert.ok(error instanceof SocrataError);
    assert.equal(error.status, 503);
    return true;
  });
  assert.equal(calls, 3, 'first attempt plus two retries');
});

test('a malformed SoQL query (400) fails immediately — retrying cannot fix it', async () => {
  let calls = 0;
  const client = new SocrataClient({
    baseUrl: BASE,
    maxRetries: 3,
    sleepImpl: async () => {},
    fetchImpl: async () => {
      calls++;
      return new Response('{"message":"Invalid SoQL"}', { status: 400 });
    },
  });

  await assert.rejects(() => client.query({ $where: 'nope(' }), /HTTP 400/);
  assert.equal(calls, 1);
});

test('a non-array payload is rejected instead of being passed to callers', async () => {
  const client = new SocrataClient({
    baseUrl: BASE,
    maxRetries: 0,
    fetchImpl: async () => jsonResponse({ error: true, message: 'authentication required' }),
  });
  await assert.rejects(() => client.query({ $limit: 1 }), /non-array payload/);
});
