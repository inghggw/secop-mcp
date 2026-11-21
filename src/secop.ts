/**
 * Domain layer for the SECOP II dataset (`p6dx-8zbt` on datos.gov.co).
 *
 * Everything that knows about Colombian procurement lives here: column names,
 * the shape of a UNSPSC category code, what "a real opportunity" means for a
 * small supplier, and how to turn a raw Socrata row into something an assistant
 * can read out loud.
 */

import { and, containsClause, lit, type SoqlParams } from './socrata.js';

export const DATASET_ID = 'p6dx-8zbt';
export const DATASET_TITLE = 'SECOP II — Procesos de Contratación';
export const DATASET_URL = 'https://www.datos.gov.co/d/p6dx-8zbt';

/** Columns this server reads, with the meaning of each one. Exposed as an MCP resource. */
export const FIELD_DICTIONARY: Record<string, string> = {
  entidad: 'Name of the contracting public entity.',
  nit_entidad: 'Tax ID (NIT) of the contracting entity.',
  departamento_entidad: 'Department (state) of the entity.',
  ciudad_entidad: 'City of the entity.',
  ordenentidad: 'Government level: Territorial, Nacional, etc.',
  id_del_proceso: 'Process identifier, e.g. CO1.REQ.6690779. Stable key for a procurement process.',
  referencia_del_proceso: 'Entity-assigned reference number.',
  nombre_del_procedimiento: 'Short title of the process.',
  descripci_n_del_procedimiento: 'Full description of what is being bought.',
  fecha_de_publicacion_del: 'Publication timestamp (floating, no timezone).',
  fecha_de_ultima_publicaci: 'Timestamp of the last modification.',
  precio_base: 'Estimated budget in COP (numeric).',
  modalidad_de_contratacion: 'Procurement modality, e.g. Licitación pública, Contratación directa.',
  duracion: 'Contract duration (numeric), with unidad_de_duracion as its unit.',
  unidad_de_duracion: 'Unit for duracion: día(s), mes(es), etc.',
  estado_del_procedimiento: 'Process state: Borrador, Publicado, Adjudicado, Celebrado, etc.',
  estado_de_apertura_del_proceso: 'Whether the process is Abierto or Cerrado.',
  adjudicado: 'Si / No — whether the process has been awarded.',
  valor_total_adjudicacion: 'Awarded amount in COP (numeric).',
  nombre_del_proveedor: 'Awarded supplier name, when awarded.',
  nit_del_proveedor_adjudicado: 'Awarded supplier NIT, when awarded.',
  codigo_principal_de_categoria: 'Main UNSPSC category, prefixed with the version, e.g. V1.82141500.',
  categorias_adicionales: 'Additional UNSPSC categories.',
  tipo_de_contrato: 'Contract type, e.g. Prestación de servicios, Obra.',
  urlproceso: 'Link to the process on the SECOP II portal.',
};

/** States that mean "this was never actually offered to the market". */
export const DRAFT_STATES = ['Borrador'];

export interface SearchFilters {
  keyword?: string;
  department?: string;
  city?: string;
  entity?: string;
  entity_nit?: string;
  unspsc?: string;
  modality?: string;
  contract_type?: string;
  state?: string;
  awarded?: boolean;
  open_only?: boolean;
  min_value_cop?: number;
  max_value_cop?: number;
  published_since?: string;
  published_until?: string;
  last_days?: number;
  include_drafts?: boolean;
}

/**
 * Normalizes a UNSPSC code into a `codigo_principal_de_categoria` prefix.
 *
 * The dataset stores codes as `V1.<8 digits>`. Users (and suppliers' paperwork)
 * write them as `82141500`, `V1.82141500`, `8214-1500` or just the 4-digit
 * family `8214`. All of those are accepted and turned into a prefix match, so a
 * family code finds every code inside it.
 */
export function unspscPrefix(input: string): string {
  const digits = String(input).replace(/^v\d+\./i, '').replace(/\D/g, '');
  if (!digits) throw new Error(`"${input}" does not contain a UNSPSC code`);
  if (digits.length > 8) throw new Error(`UNSPSC codes have at most 8 digits, got ${digits.length}`);
  return `V1.${digits}`;
}

/** `YYYY-MM-DD` or a full ISO timestamp into the floating form Socrata compares against. */
export function toFloatingTimestamp(input: string): string {
  const trimmed = String(input).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return `${trimmed}T00:00:00`;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) throw new Error(`"${input}" is not a valid date`);
  return parsed.toISOString().slice(0, 19);
}

export function daysAgoTimestamp(days: number, now: Date = new Date()): string {
  const then = new Date(now.getTime() - days * 86_400_000);
  return then.toISOString().slice(0, 19);
}

/** Translates search filters into a single SoQL `$where` clause. */
export function buildWhere(filters: SearchFilters, now: Date = new Date()): string | undefined {
  const clauses: Array<string | undefined> = [];

  if (filters.department) clauses.push(containsClause('departamento_entidad', filters.department));
  if (filters.city) clauses.push(containsClause('ciudad_entidad', filters.city));
  if (filters.entity) clauses.push(containsClause('entidad', filters.entity));
  if (filters.entity_nit) clauses.push(`nit_entidad = ${lit(filters.entity_nit.replace(/\D/g, ''))}`);
  if (filters.unspsc) clauses.push(`starts_with(codigo_principal_de_categoria, ${lit(unspscPrefix(filters.unspsc))})`);
  if (filters.modality) clauses.push(containsClause('modalidad_de_contratacion', filters.modality));
  if (filters.contract_type) clauses.push(containsClause('tipo_de_contrato', filters.contract_type));
  if (filters.state) clauses.push(containsClause('estado_del_procedimiento', filters.state));
  if (typeof filters.awarded === 'boolean') clauses.push(`adjudicado = ${lit(filters.awarded ? 'Si' : 'No')}`);
  if (filters.open_only) clauses.push(`estado_de_apertura_del_proceso = ${lit('Abierto')}`);
  if (typeof filters.min_value_cop === 'number') clauses.push(`precio_base >= ${filters.min_value_cop}`);
  if (typeof filters.max_value_cop === 'number') clauses.push(`precio_base <= ${filters.max_value_cop}`);

  // A draft is visible in the open data but was never offered to the market, and
  // drafts are a large share of the dataset. Excluding them by default is what
  // makes a result list usable by a supplier instead of merely accurate.
  if (!filters.include_drafts && !filters.state) {
    clauses.push(DRAFT_STATES.map((s) => `estado_del_procedimiento != ${lit(s)}`).join(' AND '));
  }

  const since = filters.published_since
    ? toFloatingTimestamp(filters.published_since)
    : typeof filters.last_days === 'number'
      ? daysAgoTimestamp(filters.last_days, now)
      : undefined;
  if (since) clauses.push(`fecha_de_publicacion_del >= ${lit(since)}`);
  if (filters.published_until) {
    clauses.push(`fecha_de_publicacion_del <= ${lit(toFloatingTimestamp(filters.published_until))}`);
  }

  return and(...clauses);
}

export function searchParams(filters: SearchFilters, limit: number, offset = 0, now: Date = new Date()): SoqlParams {
  const params: SoqlParams = {
    $where: buildWhere(filters, now),
    $order: 'fecha_de_publicacion_del DESC',
    $limit: limit,
  };
  if (offset > 0) params.$offset = offset;
  if (filters.keyword) params.$q = filters.keyword;
  return params;
}

export interface ProcessSummary {
  id: string;
  title: string;
  description: string;
  entity: string;
  entity_nit: string;
  department: string;
  city: string;
  published_at: string | null;
  base_value_cop: number | null;
  base_value_label: string;
  modality: string;
  contract_type: string;
  state: string;
  open: boolean;
  awarded: boolean;
  awarded_to: string | null;
  awarded_value_cop: number | null;
  unspsc: string;
  duration: string;
  url: string | null;
}

const MISSING = new Set(['No definido', 'No Definido', 'No definida', 'No Adjudicado', 'No Aplica', '']);

function clean(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value);
  return MISSING.has(text) ? '' : text;
}

function num(value: unknown): number | null {
  const text = clean(value);
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatCop(value: number | null): string {
  if (value === null) return 'sin valor publicado';
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(value);
}

function processUrl(row: Record<string, unknown>): string | null {
  const raw = row['urlproceso'];
  if (raw && typeof raw === 'object' && 'url' in raw) {
    const url = clean((raw as { url?: unknown }).url);
    // The portal returns a login URL for processes whose detail page is gated.
    return url && !url.includes('/STS/Users/Login') ? url : null;
  }
  const direct = clean(raw);
  return direct || null;
}

export function toSummary(row: Record<string, unknown>): ProcessSummary {
  const base = num(row['precio_base']);
  return {
    id: clean(row['id_del_proceso']),
    title: clean(row['nombre_del_procedimiento']),
    description: clean(row['descripci_n_del_procedimiento']),
    entity: clean(row['entidad']),
    entity_nit: clean(row['nit_entidad']),
    department: clean(row['departamento_entidad']),
    city: clean(row['ciudad_entidad']),
    published_at: clean(row['fecha_de_publicacion_del']) || null,
    base_value_cop: base,
    base_value_label: formatCop(base),
    modality: clean(row['modalidad_de_contratacion']),
    contract_type: clean(row['tipo_de_contrato']),
    state: clean(row['estado_del_procedimiento']),
    open: clean(row['estado_de_apertura_del_proceso']).toLowerCase() === 'abierto',
    awarded: clean(row['adjudicado']).toLowerCase() === 'si',
    awarded_to: clean(row['nombre_del_proveedor']) || null,
    awarded_value_cop: num(row['valor_total_adjudicacion']),
    unspsc: clean(row['codigo_principal_de_categoria']),
    duration: [clean(row['duracion']), clean(row['unidad_de_duracion'])].filter(Boolean).join(' '),
    url: processUrl(row),
  };
}

/** One-line rendering used in tool text output. */
export function summaryLine(p: ProcessSummary, index?: number): string {
  const head = index === undefined ? '' : `${index}. `;
  const date = p.published_at ? p.published_at.slice(0, 10) : 'sin fecha';
  const place = [p.city, p.department].filter(Boolean).join(', ') || 'sin ubicación';
  const award = p.awarded && p.awarded_to ? ` — adjudicado a ${p.awarded_to} por ${formatCop(p.awarded_value_cop)}` : '';
  return [
    `${head}${p.title || '(sin título)'} — ${p.base_value_label}`,
    `   ${p.entity} (${place}) · ${p.modality || 'modalidad no publicada'} · ${p.state || 'estado no publicado'}${award}`,
    `   ${date} · UNSPSC ${p.unspsc || 'n/d'} · ${p.id}${p.url ? ` · ${p.url}` : ''}`,
  ].join('\n');
}

export const GROUPABLE_FIELDS = [
  'entidad',
  'departamento_entidad',
  'ciudad_entidad',
  'modalidad_de_contratacion',
  'tipo_de_contrato',
  'estado_del_procedimiento',
  'codigo_principal_de_categoria',
  'nombre_del_proveedor',
  'ordenentidad',
] as const;

export type GroupableField = (typeof GROUPABLE_FIELDS)[number];
