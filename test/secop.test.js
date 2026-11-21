import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  buildWhere,
  daysAgoTimestamp,
  formatCop,
  searchParams,
  summaryLine,
  toFloatingTimestamp,
  toSummary,
  unspscPrefix,
} from '../dist/secop.js';

const CLOCK = new Date('2026-11-21T15:00:00Z');

test('unspscPrefix accepts every form a supplier might type', () => {
  assert.equal(unspscPrefix('82141500'), 'V1.82141500');
  assert.equal(unspscPrefix('V1.82141500'), 'V1.82141500');
  assert.equal(unspscPrefix('8214-1500'), 'V1.82141500');
  assert.equal(unspscPrefix('8214'), 'V1.8214', 'a family code stays a prefix so it matches every child code');
  assert.throws(() => unspscPrefix('software'), /does not contain a UNSPSC code/);
  assert.throws(() => unspscPrefix('123456789'), /at most 8 digits/);
});

test('dates are normalized to the floating timestamps Socrata compares against', () => {
  assert.equal(toFloatingTimestamp('2026-11-01'), '2026-11-01T00:00:00');
  assert.equal(toFloatingTimestamp('2026-11-01T06:30:00Z'), '2026-11-01T06:30:00');
  assert.throws(() => toFloatingTimestamp('ayer'), /not a valid date/);
  assert.equal(daysAgoTimestamp(20, CLOCK), '2026-11-01T15:00:00');
});

test('drafts are excluded by default and kept when asked for', () => {
  assert.match(buildWhere({}, CLOCK), /estado_del_procedimiento != 'Borrador'/);
  assert.equal(buildWhere({ include_drafts: true }, CLOCK), undefined, 'no filters left once drafts are allowed');
});

test('an explicit state filter replaces the default draft exclusion', () => {
  const where = buildWhere({ state: 'Borrador' }, CLOCK);
  assert.match(where, /upper\(estado_del_procedimiento\) like upper\('%Borrador%'\)/);
  assert.doesNotMatch(where, /!=/);
});

test('buildWhere composes every filter with AND', () => {
  const where = buildWhere(
    {
      department: 'Tolima',
      entity_nit: '800.103.923',
      unspsc: '8111',
      awarded: false,
      min_value_cop: 5_000_000,
      last_days: 20,
    },
    CLOCK,
  );
  assert.match(where, /upper\(departamento_entidad\) like upper\('%Tolima%'\)/);
  assert.match(where, /nit_entidad = '800103923'/, 'NIT punctuation is stripped');
  assert.match(where, /starts_with\(codigo_principal_de_categoria, 'V1\.8111'\)/);
  assert.match(where, /adjudicado = 'No'/);
  assert.match(where, /precio_base >= 5000000/);
  assert.match(where, /fecha_de_publicacion_del >= '2026-11-01T15:00:00'/);
  assert.equal(where.split(' AND ').length, 7, 'six filters plus the draft exclusion');
});

test('published_since wins over last_days when both are given', () => {
  const where = buildWhere({ published_since: '2026-01-01', last_days: 5 }, CLOCK);
  assert.match(where, /fecha_de_publicacion_del >= '2026-01-01T00:00:00'/);
  assert.doesNotMatch(where, /2026-11-16/);
});

test('searchParams orders by newest first and passes the keyword as full-text search', () => {
  const params = searchParams({ keyword: 'software' }, 10, 20, CLOCK);
  assert.equal(params.$order, 'fecha_de_publicacion_del DESC');
  assert.equal(params.$limit, 10);
  assert.equal(params.$offset, 20);
  assert.equal(params.$q, 'software');
});

const RAW_ROW = {
  entidad: 'GOBERNACION DE NARIÑO',
  nit_entidad: '800103923',
  departamento_entidad: 'Nariño',
  ciudad_entidad: 'Pasto',
  id_del_proceso: 'CO1.REQ.1980926',
  nombre_del_procedimiento: 'CONTRATO DE PRESTACION DE SERVICIOS PROFESIONALES',
  descripci_n_del_procedimiento: 'Prestar servicios profesionales de apoyo',
  fecha_de_publicacion_del: '2026-11-20T11:05:02.387',
  precio_base: '21200000',
  modalidad_de_contratacion: 'Contratación directa',
  duracion: '243',
  unidad_de_duracion: 'día(s)',
  estado_del_procedimiento: 'Publicado',
  estado_de_apertura_del_proceso: 'Abierto',
  adjudicado: 'No',
  valor_total_adjudicacion: '0',
  nombre_del_proveedor: 'No Definido',
  nit_del_proveedor_adjudicado: 'No Definido',
  codigo_principal_de_categoria: 'V1.80111600',
  tipo_de_contrato: 'Prestación de servicios',
  urlproceso: { url: 'https://community.secop.gov.co/Public/Tendering/OpportunityDetail/Index?noticeUID=CO1.NTC.1' },
};

test('toSummary maps a real row and turns placeholder text into nulls', () => {
  const p = toSummary(RAW_ROW);
  assert.equal(p.id, 'CO1.REQ.1980926');
  assert.equal(p.base_value_cop, 21_200_000);
  assert.equal(p.department, 'Nariño');
  assert.equal(p.open, true);
  assert.equal(p.awarded, false);
  assert.equal(p.awarded_to, null, '"No Definido" is absence of data, not a supplier name');
  assert.equal(p.duration, '243 día(s)');
  assert.ok(p.url.includes('OpportunityDetail'));
});

test('a login redirect is not reported as the process page', () => {
  const p = toSummary({ ...RAW_ROW, urlproceso: { url: 'https://community.secop.gov.co/STS/Users/Login/Index' } });
  assert.equal(p.url, null);
});

test('a missing budget is labelled, never shown as zero pesos', () => {
  const p = toSummary({ ...RAW_ROW, precio_base: 'No definido' });
  assert.equal(p.base_value_cop, null);
  assert.equal(p.base_value_label, 'sin valor publicado');
  assert.match(formatCop(21_200_000), /21\.200\.000/);
});

test('summaryLine renders three auditable lines with the id and the date', () => {
  const lines = summaryLine(toSummary(RAW_ROW), 1).split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^1\. CONTRATO DE PRESTACION/);
  assert.match(lines[1], /Pasto, Nariño/);
  assert.match(lines[2], /2026-11-20 · UNSPSC V1\.80111600 · CO1\.REQ\.1980926/);
});
