export const MAX_OFX_FILE_BYTES = 350_000;
export const MAX_OFX_RECORDS = 2_000;
const MAX_TEXT_FIELD_LENGTH = 500;

export interface OfxImportRecord {
  date: string;
  amount: number;
  payee_name: string;
  imported_payee?: string;
  notes?: string;
  imported_id: string;
}

export interface OfxParseResult {
  readonly profile: 'OFX SGML 1.02' | 'OFX SGML 1.03' | 'OFX XML 2.x';
  readonly currencyCode: string | null;
  readonly records: OfxImportRecord[];
  readonly rejected: string[];
  readonly duplicateRecords: number;
  readonly warnings: string[];
  readonly omittedFields: string[];
}

function fail(message: string): never {
  throw new Error(message);
}

/**
 * Decodes an OFX byte stream based only on its declared charset. The initial
 * header is ASCII-compatible in the supported SGML profiles. No replacement
 * characters are silently introduced into financial descriptions.
 */
export function decodeOfxBytes(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) fail('El archivo OFX está vacío.');
  if (bytes.byteLength > MAX_OFX_FILE_BYTES) {
    fail('El archivo OFX supera el límite de 350 KB.');
  }
  if (
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0xfe && bytes[1] === 0xff) ||
    (bytes[0] === 0x00 && bytes[1] === 0x00) ||
    (bytes[0] === 0x00 && bytes[1] === 0x3c)
  ) {
    fail('La codificación UTF-16/UTF-32 no está admitida. Exporta el extracto como UTF-8 o Windows-1252 declarado.');
  }

  const sample = new TextDecoder('windows-1252').decode(bytes.subarray(0, Math.min(bytes.byteLength, 4096)));
  const ofxStart = sample.search(/<OFX\b/i);
  const header = (ofxStart >= 0 ? sample.slice(0, ofxStart) : sample).replace(/^\uFEFF/, '');
  const charset = header.match(/^\s*CHARSET\s*:\s*([^\r\n]+)/im)?.[1]?.trim().toUpperCase();
  const xmlEncoding = sample.match(/<\?xml\b[^?]*\bencoding\s*=\s*["']([^"']+)["'][^?]*\?>/i)?.[1]?.trim().toUpperCase();

  if (xmlEncoding && !['UTF-8', 'UTF8', 'US-ASCII', 'ASCII'].includes(xmlEncoding)) {
    fail('El OFX XML debe usar UTF-8 o ASCII; no se ha convertido la codificación de forma implícita.');
  }
  if (charset && ['1252', 'CP1252', 'WINDOWS-1252', 'ANSI'].includes(charset)) {
    return new TextDecoder('windows-1252', { fatal: true }).decode(bytes);
  }
  if (charset && !['UTF-8', 'UTF8', 'USASCII', 'US-ASCII', 'ASCII', 'NONE'].includes(charset)) {
    fail('La codificación CHARSET declarada por el OFX no está admitida.');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('El OFX no contiene texto UTF-8 válido para su codificación declarada.');
  }
}

function extractTagValues(source: string, tag: string, xml: boolean): string[] {
  const pattern = new RegExp(
    `<${tag}\\b[^>]*>([\\s\\S]*?)(?:</${tag}\\s*>|(?=\\s*<)|$)`,
    'gi',
  );
  return [...source.matchAll(pattern)].map((match) => decodeText(match[1] ?? '', xml).trim());
}

function decodeText(raw: string, xml: boolean): string {
  if (xml && /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-f]+;)/i.test(raw)) {
    fail('El documento XML contiene una entidad de texto no admitida.');
  }
  return raw.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (entity) => {
    const name = entity.slice(1, -1).toLowerCase();
    const named: Record<string, string> = {
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    };
    if (name in named) return named[name]!;
    const codePoint = name.startsWith('#x')
      ? Number.parseInt(name.slice(2), 16)
      : Number.parseInt(name.slice(1), 10);
    if (
      !Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      fail('El documento contiene una referencia de carácter no válida.');
    }
    return String.fromCodePoint(codePoint);
  }).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

function readTag(source: string, tag: string, xml: boolean): string | undefined {
  return extractTagValues(source, tag, xml)[0];
}

function countTags(source: string, expression: RegExp): number {
  return [...source.matchAll(expression)].length;
}

function isValidIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** OFX dates are parsed as civil dates, without locale-dependent or timezone shifts. */
function parseOfxDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const match = /^(\d{4})(\d{2})(\d{2})(?:\d{6}(?:\.\d+)?(?:\[[+-]?\d{1,2}(?::[A-Za-z]{1,5})?\])?)?$/.exec(raw.trim());
  if (!match) return null;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  return isValidIsoDate(date) ? date : null;
}

/** OFX TRNAMT uses a decimal point; commas, exponents and excess precision are ambiguous. */
function parseOfxAmount(raw: string | undefined): number | null {
  if (!raw) return null;
  const match = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(raw.trim());
  if (!match) return null;
  try {
    const integerPart = BigInt(match[2]!);
    const fractionalPart = BigInt((match[3] ?? '').padEnd(2, '0') || '0');
    const absolute = integerPart * 100n + fractionalPart;
    if (absolute === 0n || absolute > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const amount = Number(absolute) * (match[1] === '-' ? -1 : 1);
    return Number.isSafeInteger(amount) ? amount : null;
  } catch {
    return null;
  }
}

function stableHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return (first >>> 0).toString(16).padStart(8, '0') + (second >>> 0).toString(16).padStart(8, '0');
}

function boundedText(value: string | undefined, max: number): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  if (value.length > max) fail('Un campo de texto del OFX supera el límite admitido.');
  return value;
}

function selectProfile(source: string): { xml: boolean; profile: OfxParseResult['profile'] } {
  if (/<INTU\.[A-Z0-9_.-]+\b/i.test(source)) fail('El archivo contiene extensiones QFX/Intuit no admitidas.');
  const ofxStart = source.search(/<OFX\b/i);
  if (ofxStart < 0) fail('El archivo no contiene un documento OFX reconocible.');
  const header = source.slice(0, ofxStart);
  if (/OFXHEADER\s*:/i.test(header)) {
    const fields = new Map<string, string>();
    for (const line of header.split(/\r?\n/)) {
      const match = /^\s*([A-Z][A-Z0-9_-]*)\s*:\s*([^\r\n]*)/i.exec(line);
      if (match) fields.set(match[1]!.toUpperCase(), match[2]!.trim().toUpperCase());
    }
    if (fields.get('OFXHEADER') !== '100' || fields.get('DATA') !== 'OFXSGML') {
      fail('Solo se admite OFX SGML con OFXHEADER:100 y DATA:OFXSGML.');
    }
    const version = fields.get('VERSION');
    if (version === '102') return { xml: false, profile: 'OFX SGML 1.02' };
    if (version === '103') return { xml: false, profile: 'OFX SGML 1.03' };
    fail('Versión OFX SGML no admitida. Se admiten las versiones 1.02 y 1.03.');
  }
  if (!/^\s*(?:<\?xml\b[^?]*\?>\s*)?<OFX\b/i.test(source)) {
    fail('El formato no corresponde a OFX SGML 1.02/1.03 ni a OFX XML.');
  }
  if (!/<\/OFX\s*>\s*$/i.test(source)) fail('El documento OFX XML está incompleto o malformado.');
  if (/<!\s*(?:DOCTYPE|ENTITY|\[CDATA)\b/i.test(source)) {
    fail('El documento incluye DTD, entidades personalizadas o CDATA no admitidos.');
  }
  return { xml: true, profile: 'OFX XML 2.x' };
}

export function parseOfx(input: string): OfxParseResult {
  if (input.length === 0) fail('El archivo OFX está vacío.');
  if (input.length > MAX_OFX_FILE_BYTES) fail('El archivo OFX supera el límite de 350 KB.');
  const source = input.replace(/^\uFEFF/, '');
  if (source.includes('\u0000')) fail('El OFX contiene bytes nulos y se ha rechazado.');
  const { xml, profile } = selectProfile(source);

  const opens = countTags(source, /<STMTTRN\b/gi);
  const closes = countTags(source, /<\/STMTTRN\s*>/gi);
  if (opens === 0) fail('No se encontraron operaciones STMTTRN en el extracto OFX.');
  if (opens > MAX_OFX_RECORDS) fail('El OFX supera el máximo de 2.000 operaciones.');
  if (opens !== closes) fail('El OFX contiene bloques STMTTRN incompletos o malformados.');

  const currencies = [...new Set(extractTagValues(source, 'CURDEF', xml).map((value) => value.toUpperCase()))];
  if (currencies.length > 1) fail('El extracto OFX mezcla varias divisas; esta variante no se puede importar con seguridad.');
  const currencyCode = currencies[0] ?? null;
  if (currencyCode && !/^[A-Z]{3}$/.test(currencyCode)) fail('La divisa CURDEF del OFX no tiene un código de tres letras válido.');

  const accountBlocks = [
    ...source.matchAll(/<BANKACCTFROM\b[^>]*>([\s\S]*?)<\/BANKACCTFROM\s*>/gi),
    ...source.matchAll(/<CCACCTFROM\b[^>]*>([\s\S]*?)<\/CCACCTFROM\s*>/gi),
  ];
  if (accountBlocks.length > 1) {
    fail('El archivo contiene varias cuentas de origen; separa el extracto antes de importarlo.');
  }
  const accountBlock = accountBlocks[0]?.[1] ?? '';
  const bankId = readTag(accountBlock, 'BANKID', xml) ?? '';
  const branchId = readTag(accountBlock, 'BRANCHID', xml) ?? '';
  const sourceAccountId = readTag(accountBlock, 'ACCTID', xml) ?? '';
  const accountIdentity = [bankId, branchId, sourceAccountId].join('|');

  const blocks = [...source.matchAll(/<STMTTRN\b[^>]*>([\s\S]*?)<\/STMTTRN\s*>/gi)];
  const records: OfxImportRecord[] = [];
  const rejected: string[] = [];
  const signatures = new Map<string, string>();
  let duplicateRecords = 0;
  let recordsWithoutMemo = 0;

  for (const [index, blockMatch] of blocks.entries()) {
    const block = blockMatch[1] ?? '';
    try {
      const date = parseOfxDate(readTag(block, 'DTPOSTED', xml));
      const amount = parseOfxAmount(readTag(block, 'TRNAMT', xml));
      const fitId = boundedText(readTag(block, 'FITID', xml), MAX_TEXT_FIELD_LENGTH);
      const name = boundedText(readTag(block, 'NAME', xml), MAX_TEXT_FIELD_LENGTH);
      const memo = boundedText(readTag(block, 'MEMO', xml), MAX_TEXT_FIELD_LENGTH);
      const checkNumber = boundedText(readTag(block, 'CHECKNUM', xml), 100);
      const referenceNumber = boundedText(readTag(block, 'REFNUM', xml), 200);
      if (!date) {
        rejected.push(`Registro ${index + 1}: fecha DTPOSTED ausente o inválida.`);
        continue;
      }
      if (amount === null) {
        rejected.push(`Registro ${index + 1}: TRNAMT ausente, cero, ambiguo o fuera de rango.`);
        continue;
      }
      if (!fitId) {
        rejected.push(`Registro ${index + 1}: falta FITID; no se puede garantizar la deduplicación.`);
        continue;
      }
      const payee = name || memo || '';
      if (!payee.trim()) {
        rejected.push(`Registro ${index + 1}: falta NAME y MEMO; no se puede identificar el concepto.`);
        continue;
      }
      if (payee.length > 200) {
        rejected.push(`Registro ${index + 1}: el concepto supera los 200 caracteres admitidos.`);
        continue;
      }
      const importedPayee = [name, memo && memo !== name ? memo : undefined].filter(Boolean).join(' — ');
      if (importedPayee.length > MAX_TEXT_FIELD_LENGTH) {
        rejected.push(`Registro ${index + 1}: NAME y MEMO combinados superan el límite de texto.`);
        continue;
      }
      const notes = [
        memo && name && memo !== name ? `Memo: ${memo}` : '',
        checkNumber ? `Cheque: ${checkNumber}` : '',
        referenceNumber ? `Referencia: ${referenceNumber}` : '',
      ].filter(Boolean).join(' · ');
      if (notes.length > 2_000) {
        rejected.push(`Registro ${index + 1}: los metadatos adicionales superan el límite admitido.`);
        continue;
      }

      const identityKey = `${accountIdentity}|FITID:${fitId}`;
      const signature = [date, amount, payee, memo ?? '', checkNumber ?? '', referenceNumber ?? ''].join('\u001f');
      const prior = signatures.get(identityKey);
      if (prior !== undefined) {
        if (prior !== signature) {
          fail('El OFX repite un FITID con datos distintos; se rechaza el archivo completo para evitar conciliaciones ambiguas.');
        }
        duplicateRecords += 1;
        continue;
      }
      signatures.set(identityKey, signature);
      if (!memo) recordsWithoutMemo += 1;
      records.push({
        date,
        amount,
        payee_name: payee,
        imported_payee: importedPayee,
        imported_id: 'personal-budget-ofx:' + stableHash(identityKey),
        ...(notes ? { notes } : {}),
      });
    } catch (error) {
      if (error instanceof Error && /entidad de texto|referencia de carácter|campo de texto/.test(error.message)) {
        rejected.push(`Registro ${index + 1}: campo de texto no válido o demasiado largo.`);
      } else {
        throw error;
      }
    }
  }

  const warnings: string[] = [];
  if (!currencyCode) warnings.push('El OFX no declara CURDEF; comprueba manualmente que la divisa coincide con la cuenta destino. No se aplicará conversión.');
  if (!accountIdentity.replace(/\|/g, '')) warnings.push('El archivo no identifica de forma fiable la cuenta de origen; la cuenta destino debe seleccionarse manualmente.');
  if (recordsWithoutMemo > 0) warnings.push(`${recordsWithoutMemo} operación(es) no incluyen MEMO; se importará únicamente el concepto disponible.`);
  if (duplicateRecords > 0) warnings.push(`${duplicateRecords} operación(es) repetidas dentro del mismo archivo se han omitido.`);

  return {
    profile,
    currencyCode,
    records,
    rejected,
    duplicateRecords,
    warnings,
    omittedFields: [
      'Categorías: OFX no ofrece una categoría estándar por movimiento; Actual podrá aplicar sus reglas locales.',
      'Saldos del extracto y metadatos de estado de cuenta: no se importan como movimientos.',
    ],
  };
}
