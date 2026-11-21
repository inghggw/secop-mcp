/**
 * Protocol-level tests: a real MCP client talks to a real MCP server over an
 * in-memory transport, with the Socrata layer stubbed. This is what catches the
 * failures that unit tests cannot — an unregistered tool, a schema the client
 * rejects, or structured output that does not match its own declaration.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer } from '../dist/server.js';

const ROW = {
  entidad: 'ALCALDIA DE IBAGUE',
  nit_entidad: '800113389',
  departamento_entidad: 'Tolima',
  ciudad_entidad: 'Ibagué',
  id_del_proceso: 'CO1.REQ.7777777',
  nombre_del_procedimiento: 'DESARROLLO DE SOFTWARE PARA LA SECRETARIA DE TIC',
  descripci_n_del_procedimiento: 'Construcción de un sistema de información',
  fecha_de_publicacion_del: '2026-11-18T09:00:00.000',
  precio_base: '48000000',
  modalidad_de_contratacion: 'Selección abreviada',
  duracion: '4',
  unidad_de_duracion: 'mes(es)',
  estado_del_procedimiento: 'Publicado',
  estado_de_apertura_del_proceso: 'Abierto',
  adjudicado: 'No',
  nombre_del_proveedor: 'No Definido',
  codigo_principal_de_categoria: 'V1.81111500',
  tipo_de_contrato: 'Prestación de servicios',
  urlproceso: { url: 'https://community.secop.gov.co/Public/Tendering/OpportunityDetail/Index?noticeUID=CO1.NTC.7' },
};

/** Stub that records the SoQL it was asked for and replays canned rows. */
function stubClient(handler) {
  const calls = [];
  return {
    calls,
    query: async (params) => {
      calls.push(params);
      return handler(params) ?? [];
    },
    count: async (where, extra = {}) => {
      calls.push({ $select: 'count(*)', $where: where, ...extra });
      const rows = handler({ $select: 'count(*)', $where: where, ...extra });
      return Number(rows?.[0]?.count ?? 0);
    },
  };
}

async function connect(socrata) {
  const server = createServer({ client: socrata, now: () => new Date('2026-11-21T15:00:00Z') });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test('the server advertises every tool with an input schema', async () => {
  const { client, server } = await connect(stubClient(() => []));
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'discover_unspsc_codes',
    'get_process',
    'search_processes',
    'summarize_procurement',
    'top_awarded_suppliers',
  ]);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} must declare an object input schema`);
    assert.ok(tool.description?.length > 20, `${tool.name} needs a description a model can act on`);
  }
  await server.close();
});

test('search_processes returns the count, the rows and the executed predicate', async () => {
  const socrata = stubClient((params) => (params.$select === 'count(*)' ? [{ count: '3' }] : [ROW]));
  const { client, server } = await connect(socrata);

  const result = await client.callTool({
    name: 'search_processes',
    arguments: { department: 'Tolima', unspsc: '8111', last_days: 20, limit: 5 },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.total_matching, 3);
  assert.equal(result.structuredContent.returned, 1);
  assert.equal(result.structuredContent.processes[0].id, 'CO1.REQ.7777777');
  assert.equal(result.structuredContent.processes[0].base_value_cop, 48_000_000);
  assert.match(result.content[0].text, /3 procesos coinciden/);
  assert.match(result.content[0].text, /DESARROLLO DE SOFTWARE/);

  const where = socrata.calls[0].$where;
  assert.match(where, /starts_with\(codigo_principal_de_categoria, 'V1\.8111'\)/);
  assert.match(where, /fecha_de_publicacion_del >= '2026-11-01T15:00:00'/);
  assert.equal(socrata.calls[0].$limit, 5);
  await server.close();
});

test('an empty result set explains how to widen the search', async () => {
  const { client, server } = await connect(stubClient((p) => (p.$select === 'count(*)' ? [{ count: '0' }] : [])));
  const result = await client.callTool({ name: 'search_processes', arguments: { department: 'Vaupés', unspsc: '8111' } });
  assert.equal(result.structuredContent.total_matching, 0);
  assert.match(result.content[0].text, /familia de 4 dígitos/);
  await server.close();
});

test('get_process reports a missing id instead of inventing a process', async () => {
  const { client, server } = await connect(stubClient(() => []));
  const result = await client.callTool({ name: 'get_process', arguments: { process_id: 'CO1.REQ.0000' } });
  assert.equal(result.structuredContent.found, false);
  assert.equal(result.structuredContent.process, null);
  assert.match(result.content[0].text, /No process found/);
  await server.close();
});

test('get_process says the portal gates the file when the dataset only has a login URL', async () => {
  const gated = { ...ROW, urlproceso: { url: 'https://community.secop.gov.co/STS/Users/Login/Index' } };
  const { client, server } = await connect(stubClient(() => [gated]));
  const result = await client.callTool({ name: 'get_process', arguments: { process_id: 'CO1.REQ.7777777' } });
  assert.equal(result.structuredContent.process.url, null);
  assert.match(result.content[0].text, /exige inicio de sesión/);
  await server.close();
});

test('summarize_procurement groups, sums the budget and labels it in COP', async () => {
  const socrata = stubClient(() => [
    { entidad: 'ALCALDIA DE IBAGUE', processes: '120', total_base_value: '4500000000' },
    { entidad: 'GOBERNACION DEL TOLIMA', processes: '80', total_base_value: '2100000000' },
  ]);
  const { client, server } = await connect(socrata);

  const result = await client.callTool({
    name: 'summarize_procurement',
    arguments: { department: 'Tolima', group_by: 'entidad', limit: 2 },
  });

  assert.equal(socrata.calls[0].$group, 'entidad');
  assert.equal(socrata.calls[0].$order, 'processes DESC');
  assert.equal(result.structuredContent.groups[0].processes, 120);
  assert.equal(result.structuredContent.groups[0].total_base_value_cop, 4_500_000_000);
  assert.match(result.structuredContent.groups[0].total_base_value_label, /4\.500\.000\.000/);
  await server.close();
});

test('discover_unspsc_codes searches full text and groups by category', async () => {
  const socrata = stubClient(() => [
    { codigo_principal_de_categoria: 'V1.81111500', processes: '3384', example: 'DESARROLLO DE SOFTWARE' },
  ]);
  const { client, server } = await connect(socrata);
  const result = await client.callTool({ name: 'discover_unspsc_codes', arguments: { keyword: 'software' } });
  assert.equal(socrata.calls[0].$q, 'software');
  assert.equal(socrata.calls[0].$group, 'codigo_principal_de_categoria');
  assert.equal(result.structuredContent.codes[0].code, 'V1.81111500');
  assert.match(result.content[0].text, /V1\.81111500 — 3\.384 procesos/);
  await server.close();
});

test('top_awarded_suppliers only looks at awarded processes with a named supplier', async () => {
  const socrata = stubClient(() => [
    { nombre_del_proveedor: 'CONSORCIO X', nit: '900111222', awards: '7', total_awarded: '1800000000' },
  ]);
  const { client, server } = await connect(socrata);
  const result = await client.callTool({ name: 'top_awarded_suppliers', arguments: { department: 'Tolima' } });
  const where = socrata.calls[0].$where;
  assert.match(where, /adjudicado = 'Si'/);
  assert.match(where, /nombre_del_proveedor != 'No Definido'/);
  assert.equal(result.structuredContent.suppliers[0].awards, 7);
  await server.close();
});

test('an upstream failure comes back as a tool error, not a transport crash', async () => {
  const socrata = {
    query: async () => {
      throw new Error('Socrata request failed with HTTP 503');
    },
    count: async () => {
      throw new Error('Socrata request failed with HTTP 503');
    },
  };
  const { client, server } = await connect(socrata);
  const result = await client.callTool({ name: 'search_processes', arguments: { department: 'Tolima' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Query failed: .*503/);
  await server.close();
});

test('an invalid argument is rejected by the schema before any request is made', async () => {
  const socrata = stubClient(() => []);
  const { client, server } = await connect(socrata);
  const result = await client.callTool({ name: 'search_processes', arguments: { limit: 500 } });
  assert.equal(result.isError, true);
  assert.equal(socrata.calls.length, 0, 'no HTTP call for an argument the schema already rejected');
  await server.close();
});

test('the dataset schema is exposed as a resource', async () => {
  const { client, server } = await connect(stubClient(() => []));
  const { resources } = await client.listResources();
  assert.equal(resources[0].uri, 'secop://dataset/schema');
  const read = await client.readResource({ uri: 'secop://dataset/schema' });
  const payload = JSON.parse(read.contents[0].text);
  assert.equal(payload.dataset_id, 'p6dx-8zbt');
  assert.ok(payload.fields.codigo_principal_de_categoria.includes('UNSPSC'));
  await server.close();
});

test('the qualify_opportunity prompt tells the model to read the real record first', async () => {
  const { client, server } = await connect(stubClient(() => []));
  const { prompts } = await client.listPrompts();
  assert.equal(prompts[0].name, 'qualify_opportunity');
  const prompt = await client.getPrompt({
    name: 'qualify_opportunity',
    arguments: { process_id: 'CO1.REQ.7777777', supplier_profile: 'two-person software shop in Ibagué' },
  });
  assert.match(prompt.messages[0].content.text, /Call get_process/);
  assert.match(prompt.messages[0].content.text, /captured market/);
  await server.close();
});
