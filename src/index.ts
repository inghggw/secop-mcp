#!/usr/bin/env node
/**
 * stdio entry point. MCP clients (Claude Desktop, Claude Code, OpenClaw, Cursor)
 * launch this file and speak JSON-RPC over stdin/stdout, so nothing may ever be
 * written to stdout except protocol traffic — logs go to stderr.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createServer, SERVER_NAME, SERVER_VERSION } from './server.js';
import { SocrataClient } from './socrata.js';

function parseArgs(argv: string[]): { help: boolean; version: boolean } {
  return {
    help: argv.includes('--help') || argv.includes('-h'),
    version: argv.includes('--version') || argv.includes('-v'),
  };
}

const HELP = `${SERVER_NAME} ${SERVER_VERSION}

MCP server over Colombia's SECOP II public procurement dataset (datos.gov.co).
It speaks MCP on stdio; run it from an MCP client, not by hand.

Environment:
  SECOP_APP_TOKEN    Optional Socrata app token. Anonymous requests share a small
                     rate-limit pool and start failing with HTTP 429 under load.
  SECOP_TIMEOUT_MS   Per-request timeout (default 20000).
  SECOP_MAX_RETRIES  Retries after the first failure (default 3).

Client config example:
  {"mcpServers":{"secop":{"command":"npx","args":["-y","secop-mcp"]}}}
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.version) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  const client = new SocrataClient({
    appToken: process.env['SECOP_APP_TOKEN'],
    timeoutMs: process.env['SECOP_TIMEOUT_MS'] ? Number(process.env['SECOP_TIMEOUT_MS']) : undefined,
    maxRetries: process.env['SECOP_MAX_RETRIES'] ? Number(process.env['SECOP_MAX_RETRIES']) : undefined,
    userAgent: `${SERVER_NAME}/${SERVER_VERSION}`,
  });

  const server = createServer({ client });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION} ready on stdio\n`);

  const shutdown = async () => {
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
