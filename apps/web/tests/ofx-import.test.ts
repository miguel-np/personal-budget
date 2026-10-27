import { describe, expect, it } from 'vitest';
import { decodeOfxBytes, MAX_OFX_FILE_BYTES, parseOfx } from '../src/ofx-import.js';

function sgml(transactions: string, extra = ''): string {
  return [
    'OFXHEADER:100',
    'DATA:OFXSGML',
    'VERSION:102',
    'SECURITY:NONE',
    'ENCODING:USASCII',
    'CHARSET:1252',
    '',
    '<OFX>',
    '<BANKMSGSRSV1>',
    '<STMTTRNRS>',
    '<STMTRS>',
    '<CURDEF>EUR',
    '<BANKACCTFROM><BANKID>1234<BRANCHID>01<ACCTID>private-account-id</BANKACCTFROM>',
    '<BANKTRANLIST>',
    transactions,
    '</BANKTRANLIST>',
    extra,
    '</STMTRS>',
    '</STMTTRNRS>',
    '</BANKMSGSRSV1>',
    '</OFX>',
  ].join('\r\n');
}

function transaction(options: {
  date?: string;
  amount?: string;
  fitId?: string;
  name?: string;
  memo?: string;
  extra?: string;
} = {}): string {
  return [
    '<STMTTRN>',
    options.date === undefined ? '<DTPOSTED>20261003' : '<DTPOSTED>' + options.date,
    options.amount === undefined ? '<TRNAMT>-12.34' : '<TRNAMT>' + options.amount,
    options.fitId === undefined ? '<FITID>bank-transaction-001' : options.fitId ? '<FITID>' + options.fitId : '',
    options.name === undefined ? '<NAME>Mercado Central' : options.name ? '<NAME>' + options.name : '',
    options.memo ? '<MEMO>' + options.memo : '',
    options.extra ?? '',
    '</STMTTRN>',
  ].join('\n');
}

const xmlFixture = `<?xml version="1.0" encoding="UTF-8"?>
<OFX>
  <BANKMSGSRSV1><STMTTRNRS><STMTRS>
    <CURDEF>EUR</CURDEF>
    <BANKACCTFROM><BANKID>1234</BANKID><ACCTID>private-account-id</ACCTID></BANKACCTFROM>
    <BANKTRANLIST>
      <STMTTRN>
        <TRNTYPE>DEBIT</TRNTYPE>
        <DTPOSTED>20261003120000.000[-5:EST]</DTPOSTED>
        <TRNAMT>-12.34</TRNAMT>
        <FITID>xml-transaction-001</FITID>
        <NAME>Mercado &amp; Más</NAME>
        <MEMO>Compra semanal</MEMO>
      </STMTTRN>
    </BANKTRANLIST>
  </STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

describe('parseOfx', () => {
  it('parses a supported OFX SGML 1.02 statement without locale-sensitive conversion', () => {
    const result = parseOfx(sgml(transaction()));
    expect(result.profile).toBe('OFX SGML 1.02');
    expect(result.currencyCode).toBe('EUR');
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      date: '2026-10-03',
      amount: -1234,
      payee_name: 'Mercado Central',
      imported_id: expect.stringMatching(/^personal-budget-ofx:[a-f\d]{16}$/),
    });
    expect(result.rejected).toEqual([]);
  });

  it('accepts the second supported SGML profile and decodes a declared Windows-1252 byte stream', () => {
    const profile103 = sgml(transaction({ name: 'Café' })).replace('VERSION:102', 'VERSION:103');
    const encoded = Uint8Array.from([...profile103].map((character) => character.charCodeAt(0)));
    const decoded = decodeOfxBytes(encoded);
    expect(parseOfx(decoded).profile).toBe('OFX SGML 1.03');
    expect(parseOfx(decoded).records[0]?.payee_name).toBe('Café');
  });

  it('parses OFX XML, decodes standard XML entities and preserves memo metadata', () => {
    const result = parseOfx(xmlFixture);
    expect(result.profile).toBe('OFX XML 2.x');
    expect(result.records[0]).toMatchObject({
      date: '2026-10-03',
      amount: -1234,
      payee_name: 'Mercado & Más',
      imported_payee: 'Mercado & Más — Compra semanal',
      notes: 'Memo: Compra semanal',
    });
  });

  it('uses stable imported identifiers for repeated imports and omits identical duplicate FITIDs within a file', () => {
    const row = transaction({ fitId: 'stable-fitid' });
    const first = parseOfx(sgml(row));
    const second = parseOfx(sgml(row));
    const duplicated = parseOfx(sgml(row + '\n' + row));
    expect(first.records[0]?.imported_id).toBe(second.records[0]?.imported_id);
    expect(duplicated.records).toHaveLength(1);
    expect(duplicated.duplicateRecords).toBe(1);
    expect(duplicated.warnings.join(' ')).toContain('repetidas');
  });

  it('rejects a repeated FITID with conflicting transaction data instead of choosing silently', () => {
    expect(() => parseOfx(sgml(
      transaction({ fitId: 'same-id', amount: '-12.34' }) +
      '\n' +
      transaction({ fitId: 'same-id', amount: '-99.99' }),
    ))).toThrow(/repite un FITID con datos distintos/);
  });

  it('isolates invalid records and refuses records without FITID', () => {
    const result = parseOfx(sgml(
      transaction({ fitId: '' }) + '\n' +
      transaction({ fitId: 'valid-id', date: '20260230' }),
    ));
    expect(result.records).toHaveLength(0);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected.join(' ')).toContain('falta FITID');
    expect(result.rejected.join(' ')).toContain('fecha DTPOSTED');
    expect(result.rejected.join(' ')).not.toContain('private-account-id');
  });

  it('rejects ambiguous amounts, excess decimal precision, zero values and invalid dates', () => {
    const result = parseOfx(sgml(
      transaction({ fitId: 'comma', amount: '-12,34' }) + '\n' +
      transaction({ fitId: 'precision', amount: '1.234' }) + '\n' +
      transaction({ fitId: 'zero', amount: '0.00' }) + '\n' +
      transaction({ fitId: 'date', date: '20261301' }),
    ));
    expect(result.records).toHaveLength(0);
    expect(result.rejected).toHaveLength(4);
  });

  it('rejects QFX/Intuit-specific tags even when the file is renamed to .ofx', () => {
    expect(() => parseOfx(sgml(transaction({ extra: '<INTU.BID>1234' })))).toThrow(/extensiones QFX\/Intuit/);
  });

  it('rejects unsupported profiles, incomplete SGML aggregates and unsafe XML constructs', () => {
    expect(() => parseOfx('OFXHEADER:100\nDATA:OFXSGML\nVERSION:200\n\n<OFX></OFX>')).toThrow(/Versión OFX SGML no admitida/);
    expect(() => parseOfx(sgml('<STMTTRN><DTPOSTED>20261003'))).toThrow(/incompletos o malformados/);
    expect(() => parseOfx(xmlFixture.replace('<OFX>', '<!DOCTYPE OFX [<!ENTITY x SYSTEM "file:///secret">]><OFX>'))).toThrow(/DTD, entidades personalizadas o CDATA/);
    expect(() => parseOfx('<html><body>not an OFX statement</body></html>')).toThrow(/documento OFX reconocible/);
  });

  it('rejects mixed-currency statements and multiple source-account blocks', () => {
    expect(() => parseOfx(sgml(transaction(), '<CURDEF>USD'))).toThrow(/mezcla varias divisas/);
    expect(() => parseOfx(sgml(transaction(), '<BANKACCTFROM><BANKID>999</BANKID><ACCTID>another</ACCTID></BANKACCTFROM>'))).toThrow(/varias cuentas de origen/);
  });

  it('rejects statements above the 2,000 transaction bound before deduplicating', () => {
    const repeated = Array.from({ length: 2_001 }, () => transaction()).join('\\n');
    expect(() => parseOfx(sgml(repeated))).toThrow(/máximo de 2.000 operaciones/);
  });

  it('keeps missing currency explicit instead of guessing or converting', () => {
    const result = parseOfx(sgml(transaction()).replace('<CURDEF>EUR\r\n', ''));
    expect(result.currencyCode).toBeNull();
    expect(result.warnings.join(' ')).toContain('no declara CURDEF');
  });

  it('decodes declared encodings strictly and enforces the byte size limit', () => {
    const utf8 = new TextEncoder().encode(xmlFixture);
    expect(decodeOfxBytes(utf8)).toContain('<OFX>');
    expect(() => decodeOfxBytes(new Uint8Array([0xff, 0xfe, 0x3c, 0x00]))).toThrow(/UTF-16\/UTF-32/);
    expect(() => decodeOfxBytes(new Uint8Array(MAX_OFX_FILE_BYTES + 1))).toThrow(/350 KB/);
  });
});
