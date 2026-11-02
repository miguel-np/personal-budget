import { describe, expect, it } from 'vitest';
import {
  findExplicitBoeArticleTitles,
  parseBoeBlockIndexXml,
  parseBoeBlockXml,
  selectBoeHistoricalVersion,
} from '../src/boe-history.js';

const wrap = (data: string) => Buffer.from('<?xml version="1.0" encoding="utf-8"?>' +
  '<response><status><code>200</code><text>ok</text></status><data>' + data + '</data></response>');

const indexXml = wrap(
  '<indice><bloque><id>a1</id><titulo>Artículo 1</titulo></bloque>' +
  '<bloque><id>a14</id><titulo>Artículo 14</titulo></bloque>' +
  '<bloque><id>dt1</id><titulo>Disposición transitoria primera</titulo></bloque></indice>',
);
const blockXml = wrap(
  '<bloque id="a14" tipo="precepto" titulo="Artículo 14">' +
  '<version id_norma="BOE-A-2015-1" fecha_publicacion="20150102" fecha_vigencia="20150103">' +
  '<p>Redacción <strong>original</strong> aplicable.</p>' +
  '</version>' +
  '<version id_norma="BOE-A-2020-2" fecha_publicacion="20200201" fecha_vigencia="20200301">' +
  '<p>Redacción <strong>modificada</strong> aplicable.</p><blockquote><p>Se modifica por la norma citada.</p></blockquote>' +
  '</version>' +
  '</bloque>',
);

describe('BOE historical block versions', () => {
  it('parses the documented block index and locates explicit article references', () => {
    const index = parseBoeBlockIndexXml(indexXml);
    expect(index).toHaveLength(3);
    expect(findExplicitBoeArticleTitles('Consulta sobre artículo 14 y art. 1', index))
      .toEqual([{ id: 'a14', title: 'Artículo 14' }, { id: 'a1', title: 'Artículo 1' }]);
    expect(findExplicitBoeArticleTitles('Consulta general sobre IRPF', index)).toEqual([]);
  });

  it('parses block version metadata and preserves nested paragraph text order', () => {
    const history = parseBoeBlockXml(blockXml, 'a14');
    expect(history).toMatchObject({
      id: 'a14',
      title: 'Artículo 14',
      versions: [
        { normId: 'BOE-A-2015-1', publicationDate: '2015-01-02', effectiveDate: '2015-01-03', text: 'Redacción original aplicable.' },
        { normId: 'BOE-A-2020-2', publicationDate: '2020-02-01', effectiveDate: '2020-03-01', text: 'Redacción modificada aplicable. Se modifica por la norma citada.', notes: ['Se modifica por la norma citada.'] },
      ],
    });
  });

  it('selects the version by effective date, not simply by publication date', () => {
    const history = parseBoeBlockXml(blockXml, 'a14');
    expect(selectBoeHistoricalVersion(history, '2020-02-29')).toMatchObject({
      status: 'selected', version: { normId: 'BOE-A-2015-1' },
    });
    expect(selectBoeHistoricalVersion(history, '2020-03-01')).toMatchObject({
      status: 'selected', version: { normId: 'BOE-A-2020-2' },
    });
  });

  it('abstains when the effective date precedes publication and requires legal review', () => {
    const history = {
      id: 'a14', title: 'Artículo 14',
      versions: [{
        normId: 'BOE-A-2020-2', publicationDate: '2020-02-01', effectiveDate: '2020-01-01',
        text: 'Texto con posible efecto retroactivo', notes: [],
      }],
    };
    expect(selectBoeHistoricalVersion(history, '2020-03-01')).toMatchObject({
      status: 'insufficient', reason: 'effective_before_publication',
    });
  });

  it('abstains when an already published version has no effective date', () => {
    const history = {
      id: 'a14', title: 'Artículo 14',
      versions: [
        { normId: 'BOE-A-2015-1', publicationDate: '2015-01-02', effectiveDate: '2015-01-03', text: 'Original', notes: [] },
        { normId: 'BOE-A-2020-2', publicationDate: '2020-02-01', effectiveDate: null, text: 'Modified', notes: [] },
      ],
    };
    expect(selectBoeHistoricalVersion(history, '2020-04-01')).toMatchObject({
      status: 'insufficient', reason: 'missing_effective_date',
    });
  });

  it('does not apply a future effective version and ignores a not-yet-published amendment', () => {
    const history = parseBoeBlockXml(wrap(
      '<bloque id="a14" tipo="precepto" titulo="Artículo 14">' +
      '<version id_norma="BOE-A-2015-1" fecha_publicacion="20150102" fecha_vigencia="20150103"><p>Original</p></version>' +
      '<version id_norma="BOE-A-2020-2" fecha_publicacion="20200301" fecha_vigencia="20200401"><p>Futuro</p></version>' +
      '</bloque>'), 'a14');
    expect(selectBoeHistoricalVersion(history, '2020-03-15')).toMatchObject({
      status: 'selected', version: { normId: 'BOE-A-2015-1' },
    });
  });

  it('abstains when a later-published version may apply retroactively', () => {
    const history = {
      id: 'a14', title: 'Artículo 14',
      versions: [
        { normId: 'BOE-A-2015-1', publicationDate: '2015-01-02', effectiveDate: '2015-01-03', text: 'Original', notes: [] },
        { normId: 'BOE-A-2021-3', publicationDate: '2021-02-01', effectiveDate: '2020-01-01', text: 'Retroactive', notes: [] },
      ],
    };
    expect(selectBoeHistoricalVersion(history, '2020-04-01')).toMatchObject({
      status: 'insufficient', reason: 'possible_retroactivity',
    });
    const unknownFuture = { ...history, versions: [{ ...history.versions[0]! }, {
      normId: 'BOE-A-2021-3', publicationDate: '2021-02-01', effectiveDate: null, text: 'Unknown', notes: [],
    }] };
    expect(selectBoeHistoricalVersion(unknownFuture, '2020-04-01')).toMatchObject({
      status: 'insufficient', reason: 'possible_retroactivity',
    });
  });

  it('abstains when two different texts claim the same effective date', () => {
    const history = {
      id: 'a14', title: 'Artículo 14',
      versions: [
        { normId: 'BOE-A-2015-1', publicationDate: '2015-01-02', effectiveDate: '2015-01-03', text: 'Original', notes: [] },
        { normId: 'BOE-A-2020-2', publicationDate: '2020-02-01', effectiveDate: '2020-03-01', text: 'Modified A', notes: [] },
        { normId: 'BOE-A-2021-3', publicationDate: '2020-02-15', effectiveDate: '2020-03-01', text: 'Modified B', notes: [] },
      ],
    };
    expect(selectBoeHistoricalVersion(history, '2021-04-01')).toMatchObject({
      status: 'insufficient', reason: 'ambiguous_effective_date',
    });
  });

  it('rejects DTDs, external entities, invalid references and mismatched block identifiers', () => {
    expect(() => parseBoeBlockIndexXml(Buffer.from(
      '<!DOCTYPE response [<!ENTITY x SYSTEM "file:///etc/passwd">]><response><status><code>200</code></status><data>&x;</data></response>',
    ))).toThrow(/DTD|entity/i);
    expect(() => parseBoeBlockIndexXml(Buffer.from(
      '<response><status><code>200</code></status><data><bloque><id>a1</id><titulo>&unknown;</titulo></bloque></data></response>',
    ))).toThrow(/entity/i);
    expect(() => parseBoeBlockXml(blockXml, 'a1')).toThrow(/ID/i);
    expect(() => parseBoeBlockIndexXml(Buffer.alloc(196_609, 65))).toThrow(/size limit/i);
  });
});
