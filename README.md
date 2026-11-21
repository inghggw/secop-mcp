# secop-mcp

An MCP server that lets an AI assistant answer questions about **Colombian public procurement** — 9 million processes published on SECOP II — in plain language.

```
You: Which entities in Tolima bought software in the last 90 days, and who wins those contracts?

Assistant (via secop-mcp):
  Top 3 by entity — department=Tolima, last_days=90:
  1. GOBIERNO DEPARTAMENTAL — 2,448 processes · $176,998,874,872 COP
  2. ALCALDIA MUNICIPIO DE IBAGUE — 1,426 processes · $73,548,019,088 COP
  3. HOSPITAL REGIONAL ALFONSO JARAMILLO SALAZAR E.S.E. — 624 processes · $14,928,322,759 COP

  Most awarded suppliers in category V1.80111600:
  1. UNION TEMPORAL HUELLAS CHAPARRAL (NIT 902031694) — 1 award · $33,712,486,021 COP
  2. LEON GRAFICAS S.A.S (NIT 809012539) — 10 awards · $11,998,277,451 COP
```

That output is real: it comes from `npm run smoke`, which runs this server against the live API.

Data source: [SECOP II — Procesos de Contratación](https://www.datos.gov.co/d/p6dx-8zbt), the official open dataset published by Colombia Compra Eficiente on datos.gov.co (Socrata). Public, no API key required.

## Why this exists

This repository is a **reference implementation of a read-only MCP server over a public REST API**. It is small enough to read in one sitting and complete enough to copy: tools, a resource, a prompt, structured output, input validation, retries, error handling, unit tests at the protocol level, and an end-to-end smoke test.

If you need the same thing over *your* API — internal ERP, CRM, warehouse, SaaS backend — the shape of the solution is in [`src/`](src/).

## Install

```bash
npm install
npm test          # builds and runs 33 tests, no network needed
npm run smoke     # end-to-end against the live API (needs network)
```

Requires Node.js 20 or newer.

## Use it from a client

Any MCP client works. Point it at the built entry point:

```json
{
  "mcpServers": {
    "secop": {
      "command": "node",
      "args": ["/absolute/path/to/secop-mcp/dist/index.js"],
      "env": { "SECOP_APP_TOKEN": "optional-socrata-token" }
    }
  }
}
```

- **Claude Desktop** → `claude_desktop_config.json` (see [`examples/`](examples/))
- **Claude Code** → `claude mcp add secop -- node /absolute/path/to/secop-mcp/dist/index.js`
- **OpenClaw / Cursor / Zed** → same command, same arguments

| Variable | Default | Purpose |
| --- | --- | --- |
| `SECOP_APP_TOKEN` | *(none)* | Socrata app token. Anonymous requests share a small rate-limit pool and start returning HTTP 429 under load. Free to create. |
| `SECOP_TIMEOUT_MS` | `20000` | Per-request timeout. |
| `SECOP_MAX_RETRIES` | `3` | Retries after the first failure, for 429 and 5xx only. |

## Tools

All tools are read-only and share one filter vocabulary, so the model learns it once: `keyword`, `department`, `city`, `entity`, `entity_nit`, `unspsc`, `modality`, `contract_type`, `state`, `awarded`, `open_only`, `min_value_cop`, `max_value_cop`, `published_since`, `published_until`, `last_days`, `include_drafts`.

| Tool | What it answers |
| --- | --- |
| `search_processes` | "What has been published in my department, in my category, in the last 30 days?" Returns newest first, plus the **total** number of matches, not just the page. |
| `get_process` | "Show me process CO1.REQ.11384484." |
| `summarize_procurement` | "How big is this market?" Groups by entity, department, modality, category or supplier and sums the budget. |
| `discover_unspsc_codes` | "I sell software — which category codes should I be watching?" Ranks real UNSPSC codes by process count. |
| `top_awarded_suppliers` | "Is this market open or captured?" Ranks suppliers by awarded value. |

Also exposed: the resource `secop://dataset/schema` (field dictionary) and the prompt `qualify_opportunity` (a checklist the model should follow before telling a small supplier to bid).

## Design decisions worth stealing

Writing an MCP server over an open-data API is 20% protocol and 80% knowing which answers are useless. The decisions below are the difference between a demo and something a supplier would actually run.

**Drafts are excluded by default.** `estado_del_procedimiento = 'Borrador'` is a large slice of the dataset, and those processes were never offered to the market. Including them makes a result list technically accurate and practically worthless. `include_drafts: true` brings them back.

**UNSPSC codes are prefix matches.** The dataset stores `V1.82141500`. People type `82141500`, `V1.82141500`, `8214-1500`, or the 4-digit family `8214`. All four work, and a family code matches every code inside it — which is how a supplier actually thinks about its own catalogue.

**Totals come from a separate `count(*)` query.** Socrata caps page size. "17 processes match, here are 3" is a useful answer; "here are 3" is not.

**Placeholder text becomes `null`.** The feed writes `No Definido`, `No Adjudicado`, `No Aplica` in empty fields, and `urlproceso` often points at the portal's login page instead of the process. Passing those through as data is how an assistant ends up confidently reporting a supplier named "No Definido" and a budget of zero pesos. Missing budgets are labelled `sin valor publicado`, never `$0`.

**Money stays in COP, formatted `es-CO`.** A model that sees `48000000` will eventually call it dollars.

**Retries only where retrying helps.** 429 and 5xx are retried with exponential backoff, honouring `Retry-After`. A 400 — which on Socrata means the SoQL is wrong — fails immediately: retrying a malformed query just hammers a public endpoint.

**Every tool returns both text and `structuredContent`.** The text is what the model reads out; the structured payload is what it quotes numbers from, including the exact SoQL predicate that was executed, so any answer can be audited.

**Failures come back as tool errors, not exceptions.** An upstream 503 returns `isError` with a readable message, which the model can relay or retry. A crashed server just looks broken.

## Project layout

```
src/socrata.ts   Dependency-free SODA 2.1 client: SoQL params, timeout, retries, Retry-After
src/secop.ts     Domain layer: field dictionary, UNSPSC parsing, filter → SoQL, row → summary
src/server.ts    MCP server: tools, resource, prompt, structured output
src/index.ts     stdio entry point
test/            33 tests: unit + protocol-level (real client, real server, stubbed HTTP)
scripts/smoke.mjs End-to-end run against the live API
```

The test suite needs no network: `src/socrata.ts` takes an injectable `fetch` and `sleep`, and `test/server.test.js` drives a real MCP client over an in-memory transport with the HTTP layer stubbed. That is what catches an unregistered tool or structured output that does not match its own schema.

## Limitations

- The open dataset carries **metadata, not tender documents**. Eligibility requirements, addenda and deadlines must be read on the SECOP II portal. The `qualify_opportunity` prompt makes the model say so.
- Values are self-reported by each entity. Blank and placeholder values are common, and `nombre_del_procedimiento` sometimes contains a person's name because the entity misused the column.
- The dataset covers SECOP II. Processes published only on SECOP I or on TVEC are not here.
- Publication timestamps are floating (no timezone). Treat them as Bogotá local time.

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with Colombia Compra Eficiente or datos.gov.co.
