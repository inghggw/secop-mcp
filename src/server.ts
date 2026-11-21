/**
 * MCP server exposing Colombia's SECOP II procurement dataset as tools.
 *
 * Tool design notes:
 * - Every tool takes the same filter vocabulary, so an assistant learns it once.
 * - Each tool returns readable text *and* `structuredContent`, so the model can
 *   quote numbers without re-parsing prose.
 * - Counts come from a separate `count(*)` query: Socrata caps page size, and a
 *   supplier's first question is always "how many are there", not "show me 20".
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  DATASET_ID,
  DATASET_TITLE,
  DATASET_URL,
  FIELD_DICTIONARY,
  GROUPABLE_FIELDS,
  buildWhere,
  formatCop,
  searchParams,
  summaryLine,
  toSummary,
  type GroupableField,
  type SearchFilters,
} from './secop.js';
import { SocrataClient, SocrataError, and, lit } from './socrata.js';

export const SERVER_NAME = 'secop-mcp';
export const SERVER_VERSION = '0.1.0';

const filterShape = {
  keyword: z.string().optional().describe('Full-text search across the whole record (title, description, entity).'),
  department: z.string().optional().describe('Department of the contracting entity, e.g. "Tolima". Partial match.'),
  city: z.string().optional().describe('City of the contracting entity, e.g. "Ibagué". Partial match.'),
  entity: z.string().optional().describe('Name of the contracting entity. Partial match.'),
  entity_nit: z.string().optional().describe('Exact NIT of the contracting entity, digits only.'),
  unspsc: z
    .string()
    .optional()
    .describe('UNSPSC category code. Accepts "82141500", "V1.82141500" or a shorter family like "8214" (prefix match).'),
  modality: z.string().optional().describe('Procurement modality, e.g. "Licitación", "Contratación directa". Partial match.'),
  contract_type: z.string().optional().describe('Contract type, e.g. "Prestación de servicios", "Obra". Partial match.'),
  state: z.string().optional().describe('Process state, e.g. "Publicado", "Adjudicado". Partial match.'),
  awarded: z.boolean().optional().describe('true = only awarded processes, false = only not-yet-awarded.'),
  open_only: z.boolean().optional().describe('Only processes whose opening state is "Abierto".'),
  min_value_cop: z.number().optional().describe('Minimum estimated budget in COP.'),
  max_value_cop: z.number().optional().describe('Maximum estimated budget in COP.'),
  published_since: z.string().optional().describe('Only processes published on or after this date (YYYY-MM-DD).'),
  published_until: z.string().optional().describe('Only processes published on or before this date (YYYY-MM-DD).'),
  last_days: z.number().int().positive().optional().describe('Shorthand for published_since = today minus N days.'),
  include_drafts: z
    .boolean()
    .optional()
    .describe('Include processes in "Borrador" state. Off by default: drafts were never offered to the market.'),
};

const processShape = {
  id: z.string(),
  title: z.string(),
  description: z.string(),
  entity: z.string(),
  entity_nit: z.string(),
  department: z.string(),
  city: z.string(),
  published_at: z.string().nullable(),
  base_value_cop: z.number().nullable(),
  base_value_label: z.string(),
  modality: z.string(),
  contract_type: z.string(),
  state: z.string(),
  open: z.boolean(),
  awarded: z.boolean(),
  awarded_to: z.string().nullable(),
  awarded_value_cop: z.number().nullable(),
  unspsc: z.string(),
  duration: z.string(),
  url: z.string().nullable(),
};

function pickFilters(args: Record<string, unknown>): SearchFilters {
  const filters: Record<string, unknown> = {};
  for (const key of Object.keys(filterShape)) {
    if (args[key] !== undefined) filters[key] = args[key];
  }
  return filters as SearchFilters;
}

function describeFilters(filters: SearchFilters): string {
  const entries = Object.entries(filters).filter(([, v]) => v !== undefined);
  if (!entries.length) return 'sin filtros (todo el dataset)';
  return entries.map(([k, v]) => `${k}=${v}`).join(', ');
}

/** Turns any failure into a tool error the model can act on instead of a stack trace. */
function toolError(error: unknown) {
  const message =
    error instanceof SocrataError
      ? `${error.message}${error.status ? ` (HTTP ${error.status})` : ''}`
      : error instanceof Error
        ? error.message
        : String(error);
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: `Query failed: ${message}` }],
  };
}

export interface CreateServerOptions {
  client?: SocrataClient;
  appToken?: string;
  /** Fixed clock, for deterministic tests of relative date filters. */
  now?: () => Date;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const client = options.client ?? new SocrataClient({ appToken: options.appToken });
  const now = options.now ?? (() => new Date());

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: [
        `This server queries ${DATASET_TITLE} (Socrata dataset ${DATASET_ID}), the official open-data`,
        'feed of Colombian public procurement processes.',
        '',
        'Guidance:',
        '- Ask for a department and a UNSPSC category when the user is a supplier looking for work;',
        '  those two filters decide relevance more than any keyword.',
        '- Drafts ("Borrador") are excluded unless include_drafts is true.',
        '- Budgets are in Colombian pesos (COP). Never present them as USD.',
        '- Values come from the entity itself and are frequently incomplete; say so instead of guessing.',
      ].join('\n'),
    },
  );

  server.registerResource(
    'dataset-schema',
    'secop://dataset/schema',
    {
      title: 'SECOP II field dictionary',
      description: 'The columns this server reads from the SECOP II dataset and what each one means.',
      mimeType: 'application/json',
    },
    async () => ({
      contents: [
        {
          uri: 'secop://dataset/schema',
          mimeType: 'application/json',
          text: JSON.stringify(
            { dataset_id: DATASET_ID, title: DATASET_TITLE, source: DATASET_URL, fields: FIELD_DICTIONARY },
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerTool(
    'search_processes',
    {
      title: 'Search procurement processes',
      description:
        'Search SECOP II processes by place, category, entity, budget, state and date. Returns the newest matches first plus the total number of matching processes.',
      inputSchema: {
        ...filterShape,
        limit: z.number().int().min(1).max(50).optional().describe('How many processes to return (default 10, max 50).'),
        offset: z.number().int().min(0).optional().describe('Skip this many results, for paging.'),
      },
      outputSchema: {
        total_matching: z.number().describe('Total processes matching the filters, ignoring limit/offset.'),
        returned: z.number(),
        where: z.string().describe('The SoQL predicate that was executed. Useful for auditing a result.'),
        processes: z.array(z.object(processShape)),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const filters = pickFilters(args);
        const limit = args.limit ?? 10;
        const clock = now();
        const where = buildWhere(filters, clock) ?? '';
        const params = searchParams(filters, limit, args.offset ?? 0, clock);
        const [rows, total] = await Promise.all([
          client.query(params),
          client.count(where || undefined, params.$q ? { $q: params.$q } : {}),
        ]);
        const processes = rows.map(toSummary);
        const header =
          `${total.toLocaleString('es-CO')} procesos coinciden con ${describeFilters(filters)}. ` +
          `Mostrando ${processes.length}${args.offset ? ` desde el #${args.offset + 1}` : ''}:`;
        const body = processes.length
          ? processes.map((p, i) => summaryLine(p, (args.offset ?? 0) + i + 1)).join('\n\n')
          : 'Ningún proceso coincide. Prueba con menos filtros, un código UNSPSC más corto (familia de 4 dígitos) o una ventana de fechas más amplia.';
        return {
          content: [{ type: 'text' as const, text: `${header}\n\n${body}` }],
          structuredContent: { total_matching: total, returned: processes.length, where, processes },
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_process',
    {
      title: 'Get one process',
      description: 'Fetch a single procurement process by its SECOP II process id (e.g. CO1.REQ.6690779).',
      inputSchema: {
        process_id: z.string().min(3).describe('Value of id_del_proceso, e.g. "CO1.REQ.6690779".'),
      },
      outputSchema: { found: z.boolean(), process: z.object(processShape).nullable() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ process_id }) => {
      try {
        const rows = await client.query({ $where: `id_del_proceso = ${lit(process_id)}`, $limit: 1 });
        const row = rows[0];
        if (!row) {
          return {
            content: [{ type: 'text' as const, text: `No process found with id ${process_id}.` }],
            structuredContent: { found: false, process: null },
          };
        }
        const process = toSummary(row);
        const detail = [
          summaryLine(process),
          '',
          process.description ? `Objeto: ${process.description}` : '',
          process.duration ? `Duración: ${process.duration}` : '',
          process.url ? `Expediente: ${process.url}` : 'Expediente: el portal exige inicio de sesión para este proceso.',
        ]
          .filter(Boolean)
          .join('\n');
        return {
          content: [{ type: 'text' as const, text: detail }],
          structuredContent: { found: true, process },
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'summarize_procurement',
    {
      title: 'Summarize procurement by a field',
      description:
        'Group matching processes by a field (entity, department, modality, category, supplier...) and return how many processes and how much budget each group holds. Use it to size a market before bidding.',
      inputSchema: {
        ...filterShape,
        group_by: z.enum(GROUPABLE_FIELDS).describe('Column to group by.'),
        limit: z.number().int().min(1).max(50).optional().describe('Groups to return (default 10, max 50).'),
      },
      outputSchema: {
        group_by: z.string(),
        groups: z.array(
          z.object({
            value: z.string(),
            processes: z.number(),
            total_base_value_cop: z.number().nullable(),
            total_base_value_label: z.string(),
          }),
        ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const filters = pickFilters(args);
        const groupBy = args.group_by as GroupableField;
        const limit = args.limit ?? 10;
        const where = buildWhere(filters, now());
        const rows = await client.query<Record<string, string>>({
          $select: `${groupBy}, count(*) as processes, sum(precio_base) as total_base_value`,
          $where: where,
          $group: groupBy,
          $order: 'processes DESC',
          $limit: limit,
          ...(filters.keyword ? { $q: filters.keyword } : {}),
        });
        const groups = rows.map((row) => {
          const total = Number(row['total_base_value'] ?? NaN);
          const value = Number.isFinite(total) ? total : null;
          return {
            value: row[groupBy] || '(sin dato)',
            processes: Number(row['processes'] ?? 0),
            total_base_value_cop: value,
            total_base_value_label: formatCop(value),
          };
        });
        const text = groups.length
          ? [
              `Top ${groups.length} por ${groupBy} — ${describeFilters(filters)}:`,
              '',
              ...groups.map(
                (g, i) => `${i + 1}. ${g.value} — ${g.processes.toLocaleString('es-CO')} procesos · ${g.total_base_value_label}`,
              ),
            ].join('\n')
          : 'Ningún proceso coincide con esos filtros.';
        return {
          content: [{ type: 'text' as const, text }],
          structuredContent: { group_by: groupBy, groups },
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'discover_unspsc_codes',
    {
      title: 'Discover UNSPSC codes from a keyword',
      description:
        'Find which UNSPSC category codes actually carry the work a supplier describes in plain words ("software", "transporte escolar", "obra civil"), ranked by number of processes. Run this before searching by category.',
      inputSchema: {
        keyword: z.string().min(2).describe('What the supplier sells, in plain Spanish.'),
        department: z.string().optional().describe('Restrict the sample to one department.'),
        last_days: z.number().int().positive().optional().describe('Only look at processes published in the last N days.'),
        limit: z.number().int().min(1).max(25).optional().describe('Codes to return (default 10).'),
      },
      outputSchema: {
        keyword: z.string(),
        codes: z.array(z.object({ code: z.string(), processes: z.number(), example: z.string() })),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ keyword, department, last_days, limit }) => {
      try {
        const filters: SearchFilters = { department, last_days };
        const where = buildWhere(filters, now());
        const rows = await client.query<Record<string, string>>({
          $select: 'codigo_principal_de_categoria, count(*) as processes, max(nombre_del_procedimiento) as example',
          $where: and(where, 'codigo_principal_de_categoria IS NOT NULL'),
          $group: 'codigo_principal_de_categoria',
          $order: 'processes DESC',
          $limit: limit ?? 10,
          $q: keyword,
        });
        const codes = rows.map((row) => ({
          code: row['codigo_principal_de_categoria'] ?? '',
          processes: Number(row['processes'] ?? 0),
          // An arbitrary title from the group: entities often misuse this column
          // (supplier names end up in it), so it is a hint, not a definition.
          example: (row['example'] ?? '').trim(),
        }));
        const text = codes.length
          ? [
              `Códigos UNSPSC con más procesos para "${keyword}"${department ? ` en ${department}` : ''}:`,
              '',
              ...codes.map((c) => `• ${c.code} — ${c.processes.toLocaleString('es-CO')} procesos · ej.: ${c.example}`),
              '',
              'Usa el código en search_processes(unspsc: ...). Los primeros 4 dígitos son la familia: sirven para ampliar la búsqueda.',
            ].join('\n')
          : `Sin resultados para "${keyword}". Prueba un término más genérico.`;
        return {
          content: [{ type: 'text' as const, text }],
          structuredContent: { keyword, codes },
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'top_awarded_suppliers',
    {
      title: 'Top awarded suppliers',
      description:
        'Who actually wins this kind of contract: ranks suppliers by awarded amount for the given filters. Use it to check whether a market is open or captured before spending days on a bid.',
      inputSchema: {
        ...filterShape,
        limit: z.number().int().min(1).max(50).optional().describe('Suppliers to return (default 10).'),
      },
      outputSchema: {
        suppliers: z.array(
          z.object({
            name: z.string(),
            nit: z.string(),
            awards: z.number(),
            total_awarded_cop: z.number().nullable(),
            total_awarded_label: z.string(),
          }),
        ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const filters: SearchFilters = { ...pickFilters(args), awarded: true };
        const where = and(buildWhere(filters, now()), `nombre_del_proveedor != ${lit('No Definido')}`);
        const rows = await client.query<Record<string, string>>({
          $select:
            'nombre_del_proveedor, max(nit_del_proveedor_adjudicado) as nit, count(*) as awards, sum(valor_total_adjudicacion) as total_awarded',
          $where: where,
          $group: 'nombre_del_proveedor',
          $order: 'total_awarded DESC',
          $limit: args.limit ?? 10,
          ...(filters.keyword ? { $q: filters.keyword } : {}),
        });
        const suppliers = rows.map((row) => {
          const total = Number(row['total_awarded'] ?? NaN);
          const value = Number.isFinite(total) ? total : null;
          return {
            name: row['nombre_del_proveedor'] ?? '',
            nit: row['nit'] ?? '',
            awards: Number(row['awards'] ?? 0),
            total_awarded_cop: value,
            total_awarded_label: formatCop(value),
          };
        });
        const text = suppliers.length
          ? [
              `Proveedores con más valor adjudicado — ${describeFilters(filters)}:`,
              '',
              ...suppliers.map(
                (s, i) =>
                  `${i + 1}. ${s.name}${s.nit ? ` (NIT ${s.nit})` : ''} — ${s.awards} adjudicaciones · ${s.total_awarded_label}`,
              ),
            ].join('\n')
          : 'Ninguna adjudicación coincide con esos filtros.';
        return {
          content: [{ type: 'text' as const, text }],
          structuredContent: { suppliers },
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerPrompt(
    'qualify_opportunity',
    {
      title: 'Qualify a process for a small supplier',
      description: 'Checklist an assistant should follow before telling a small supplier to bid on a process.',
      argsSchema: {
        process_id: z.string().describe('SECOP II process id to qualify.'),
        supplier_profile: z.string().optional().describe('What the supplier does, its size and where it operates.'),
      },
    },
    ({ process_id, supplier_profile }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              `Qualify SECOP II process ${process_id} for this supplier: ${supplier_profile || '(profile not provided — ask for it)'}.`,
              '',
              'Steps:',
              '1. Call get_process to read the real record. Never qualify from memory.',
              '2. Call top_awarded_suppliers with the same entity and category: if one supplier holds most of the',
              '   awarded value, say so plainly — that is a captured market.',
              '3. Call summarize_procurement grouped by modalidad_de_contratacion for the entity, to show whether it',
              '   buys openly or mostly by direct contracting.',
              '4. Report: budget in COP, state, whether it is still open, who usually wins, and the single biggest',
              '   reason this supplier would be disqualified.',
              '5. State clearly that the open dataset does not carry the tender documents or the eligibility',
              '   requirements: those must be read on the SECOP II portal before bidding.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  return server;
}
