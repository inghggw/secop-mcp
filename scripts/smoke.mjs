/**
 * End-to-end smoke test against the live datos.gov.co API.
 *
 * Launches the built server as a real subprocess over stdio, connects a real MCP
 * client, and calls every tool. Unlike the unit suite this needs network access,
 * so it is a separate `npm run smoke` and is not part of `npm test`.
 *
 * Usage: npm run smoke [-- --department Tolima --keyword software]
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const department = flag('department', 'Tolima');
const keyword = flag('keyword', 'software');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js'],
  env: { ...process.env },
  stderr: 'inherit',
});

const client = new Client({ name: 'secop-mcp-smoke', version: '0.1.0' });

let failures = 0;
const step = async (label, run) => {
  const started = Date.now();
  console.log(`\n▶ ${label}`);
  try {
    const result = await run();
    if (result?.isError) throw new Error(result.content?.[0]?.text ?? 'tool returned isError');
    console.log(`   ✅ ok in ${Date.now() - started} ms`);
    return result;
  } catch (error) {
    failures++;
    console.error(`   ❌ ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
};

await client.connect(transport);

const tools = await step('listTools', () => client.listTools());
console.log('   tools:', tools?.tools.map((t) => t.name).join(', '));

const codes = await step(`discover_unspsc_codes("${keyword}")`, () =>
  client.callTool({ name: 'discover_unspsc_codes', arguments: { keyword, limit: 3 } }),
);
const topCode = codes?.structuredContent?.codes?.[0]?.code;
console.log('   ' + (codes?.content?.[0]?.text ?? '').split('\n').slice(0, 5).join('\n   '));

const search = await step(`search_processes(${department}, last 30 days)`, () =>
  client.callTool({
    name: 'search_processes',
    arguments: { department, keyword, last_days: 30, limit: 3 },
  }),
);
console.log('   total_matching:', search?.structuredContent?.total_matching);
console.log('   ' + (search?.content?.[0]?.text ?? '').split('\n').slice(0, 7).join('\n   '));

const firstId = search?.structuredContent?.processes?.[0]?.id;
if (firstId) {
  const one = await step(`get_process(${firstId})`, () =>
    client.callTool({ name: 'get_process', arguments: { process_id: firstId } }),
  );
  console.log('   found:', one?.structuredContent?.found);
}

await step(`summarize_procurement(group_by=entidad, ${department})`, async () => {
  const result = await client.callTool({
    name: 'summarize_procurement',
    arguments: { department, group_by: 'entidad', last_days: 90, limit: 3 },
  });
  console.log('   ' + (result.content?.[0]?.text ?? '').split('\n').join('\n   '));
  return result;
});

await step(`top_awarded_suppliers(${department}${topCode ? `, ${topCode}` : ''})`, async () => {
  const result = await client.callTool({
    name: 'top_awarded_suppliers',
    arguments: { department, ...(topCode ? { unspsc: topCode } : {}), limit: 3 },
  });
  console.log('   ' + (result.content?.[0]?.text ?? '').split('\n').join('\n   '));
  return result;
});

await step('readResource(secop://dataset/schema)', async () => {
  const read = await client.readResource({ uri: 'secop://dataset/schema' });
  const payload = JSON.parse(read.contents[0].text);
  console.log('   fields documented:', Object.keys(payload.fields).length);
  return read;
});

await client.close();

console.log(`\n${failures === 0 ? 'Smoke test passed.' : `Smoke test FAILED: ${failures} step(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
