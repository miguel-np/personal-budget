export interface BoeBlockIndexEntry { readonly id: string; readonly title: string; }
export interface BoeBlockVersion {
  readonly normId: string; readonly publicationDate: string; readonly effectiveDate: string | null;
  readonly text: string; readonly notes: readonly string[];
}
export interface BoeBlockHistory { readonly id: string; readonly title: string; readonly versions: readonly BoeBlockVersion[]; }
export type BoeHistoricalSelection =
  | { readonly status: 'selected'; readonly version: BoeBlockVersion; readonly consideredVersionCount: number }
  | { readonly status: 'not_yet_published' | 'not_effective_yet'; readonly consideredVersionCount: number }
  | { readonly status: 'insufficient'; readonly reason: 'invalid_history' | 'missing_effective_date' | 'effective_before_publication' | 'possible_retroactivity' | 'ambiguous_effective_date'; readonly consideredVersionCount: number };

interface XmlNode { readonly name: string; readonly attributes: Readonly<Record<string, string>>; readonly content: Array<string | XmlNode>; }
const MAX_XML_BYTES = 524_288;
const MAX_XML_NODES = 25_000;
const MAX_XML_DEPTH = 64;
const MAX_XML_ATTRIBUTES = 32;
const MAX_XML_TEXT_CHARS = 400_000;
const MAX_BLOCKS = 600;
const MAX_VERSIONS = 120;
const MAX_BLOCK_TEXT_CHARS = 24_000;

function decodeEntities(value: string): string {
  let output = '';
  let cursor = 0;
  while (cursor < value.length) {
    const ampersand = value.indexOf('&', cursor);
    if (ampersand < 0) { output += value.slice(cursor); break; }
    output += value.slice(cursor, ampersand);
    const semicolon = value.indexOf(';', ampersand + 1);
    if (semicolon < 0) throw new Error('Malformed XML entity reference.');
    const entity = value.slice(ampersand + 1, semicolon);
    const predefined: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.prototype.hasOwnProperty.call(predefined, entity)) output += predefined[entity]!;
    else {
      let codePoint: number;
      if (/^#\d{1,7}$/.test(entity)) codePoint = Number(entity.slice(1));
      else if (/^#x[0-9a-f]{1,6}$/i.test(entity)) codePoint = Number.parseInt(entity.slice(2), 16);
      else throw new Error('Unsupported XML entity.');
      if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
        (codePoint < 0x20 && ![0x09, 0x0a, 0x0d].includes(codePoint))) throw new Error('Invalid XML character reference.');
      output += String.fromCodePoint(codePoint);
    }
    cursor = semicolon + 1;
  }
  return output;
}

function parseName(source: string, position: number): { readonly name: string; readonly next: number } {
  const match = /^[A-Za-z_][A-Za-z0-9_.:-]*/.exec(source.slice(position));
  if (!match) throw new Error('Invalid XML element or attribute name.');
  return { name: match[0], next: position + match[0].length };
}

/** Strict, bounded XML subset parser. DTDs, declared/external entities and unknown entities are rejected. */
function parseBoundedXml(body: Buffer, maximumBytes: number): XmlNode {
  if (body.byteLength === 0 || body.byteLength > maximumBytes || body.byteLength > MAX_XML_BYTES) throw new Error('BOE XML exceeds its configured size limit.');
  const source = new TextDecoder('utf-8', { fatal: true }).decode(body);
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(source)) throw new Error('DTD and entity declarations are forbidden.');
  const roots: XmlNode[] = [];
  const stack: XmlNode[] = [];
  let position = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  let nodeCount = 0;
  let textCount = 0;
  const appendText = (raw: string): void => {
    if (!raw) return;
    const decoded = decodeEntities(raw);
    textCount += decoded.length;
    if (textCount > MAX_XML_TEXT_CHARS) throw new Error('BOE XML text budget exceeded.');
    const parent = stack[stack.length - 1];
    if (parent) parent.content.push(decoded);
    else if (decoded.trim()) throw new Error('Text outside XML root.');
  };

  while (position < source.length) {
    if (source.startsWith('<!--', position)) {
      const end = source.indexOf('-->', position + 4);
      if (end < 0) throw new Error('Unterminated XML comment.');
      position = end + 3;
      continue;
    }
    if (source.startsWith('<?', position)) {
      const end = source.indexOf('?>', position + 2);
      if (end < 0) throw new Error('Unterminated XML processing instruction.');
      position = end + 2;
      continue;
    }
    if (source.startsWith('<![CDATA[', position)) {
      const end = source.indexOf(']]>', position + 9);
      if (end < 0 || stack.length === 0) throw new Error('Invalid XML CDATA section.');
      const raw = source.slice(position + 9, end);
      textCount += raw.length;
      if (textCount > MAX_XML_TEXT_CHARS) throw new Error('BOE XML text budget exceeded.');
      stack[stack.length - 1]!.content.push(raw);
      position = end + 3;
      continue;
    }
    if (source.startsWith('</', position)) {
      const parsed = parseName(source, position + 2);
      const close = /^\s*>/.exec(source.slice(parsed.next));
      if (!close) throw new Error('Malformed XML closing tag.');
      const current = stack.pop();
      if (!current || current.name !== parsed.name) throw new Error('Mismatched XML closing tag.');
      position = parsed.next + close[0].length;
      continue;
    }
    if (source[position] === '<') {
      if (source.startsWith('<!', position)) throw new Error('Unsupported XML declaration.');
      const parsed = parseName(source, position + 1);
      let cursor = parsed.next;
      let terminated = false;
      let selfClosing = false;
      const attributes: Record<string, string> = {};
      while (cursor < source.length) {
        const whitespace = /^\s+/.exec(source.slice(cursor));
        if (whitespace) cursor += whitespace[0].length;
        if (source.startsWith('/>', cursor)) { selfClosing = true; terminated = true; cursor += 2; break; }
        if (source[cursor] === '>') { terminated = true; cursor += 1; break; }
        if (Object.keys(attributes).length >= MAX_XML_ATTRIBUTES) throw new Error('Too many XML attributes.');
        const attr = parseName(source, cursor);
        cursor = attr.next + /^\s*/.exec(source.slice(attr.next))![0].length;
        if (source[cursor] !== '=') throw new Error('Invalid XML attribute.');
        cursor += 1 + /^\s*/.exec(source.slice(cursor + 1))![0].length;
        const quote = source[cursor];
        if (quote !== '"' && quote !== "'") throw new Error('Unquoted XML attribute.');
        cursor += 1;
        const valueEnd = source.indexOf(quote, cursor);
        if (valueEnd < 0) throw new Error('Unterminated XML attribute.');
        if (Object.prototype.hasOwnProperty.call(attributes, attr.name)) throw new Error('Duplicate XML attribute.');
        attributes[attr.name] = decodeEntities(source.slice(cursor, valueEnd));
        if (attributes[attr.name]!.length > 4_000) throw new Error('XML attribute exceeds its limit.');
        cursor = valueEnd + 1;
      }
      if (!terminated) throw new Error('Unterminated XML opening tag.');
      nodeCount += 1;
      if (nodeCount > MAX_XML_NODES) throw new Error('BOE XML node budget exceeded.');
      const node: XmlNode = { name: parsed.name, attributes, content: [] };
      const parent = stack[stack.length - 1];
      if (parent) parent.content.push(node);
      else roots.push(node);
      if (!selfClosing) {
        stack.push(node);
        if (stack.length > MAX_XML_DEPTH) throw new Error('BOE XML nesting budget exceeded.');
      }
      position = cursor;
      continue;
    }
    const next = source.indexOf('<', position);
    const end = next < 0 ? source.length : next;
    appendText(source.slice(position, end));
    position = end;
  }
  if (stack.length !== 0 || roots.length !== 1) throw new Error('Incomplete or multi-root XML document.');
  return roots[0]!;
}

function childNodes(node: XmlNode, name: string): XmlNode[] {
  return node.content.filter((item): item is XmlNode => typeof item !== 'string' && item.name === name);
}
function descendants(node: XmlNode, name: string): XmlNode[] {
  const result: XmlNode[] = [];
  for (const item of node.content) if (typeof item !== 'string') {
    if (item.name === name) result.push(item);
    result.push(...descendants(item, name));
  }
  return result;
}
function nodeText(node: XmlNode): string {
  return node.content.map((item) => typeof item === 'string' ? item : nodeText(item)).join('').replace(/\s+/g, ' ').trim();
}
function childText(node: XmlNode, name: string): string | null {
  const child = childNodes(node, name)[0];
  return child ? nodeText(child) || null : null;
}
function responseData(root: XmlNode): XmlNode {
  if (root.name !== 'response') throw new Error('Unexpected BOE XML root.');
  const status = childNodes(root, 'status')[0];
  if (!status || childText(status, 'code') !== '200') throw new Error('BOE API returned an unsuccessful XML response.');
  const data = childNodes(root, 'data')[0];
  if (!data) throw new Error('BOE XML response has no data node.');
  return data;
}
function validBlockId(value: string): boolean { return /^[A-Za-z0-9_-]{1,100}$/.test(value); }
function validNormId(value: string): boolean { return /^BOE-A-\d{4}-\d{1,8}$/.test(value); }
function validDate(value: string): boolean {
  if (!/^\d{8}$/.test(value)) return false;
  const iso = value.slice(0, 4) + '-' + value.slice(4, 6) + '-' + value.slice(6, 8);
  const parsed = Date.parse(iso + 'T00:00:00.000Z');
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === iso;
}
function formatDate(value: string): string { return value.slice(0, 4) + '-' + value.slice(4, 6) + '-' + value.slice(6, 8); }

export function parseBoeBlockIndexXml(body: Buffer): readonly BoeBlockIndexEntry[] {
  const data = responseData(parseBoundedXml(body, 196_608));
  const blocks = descendants(data, 'bloque');
  if (blocks.length === 0 || blocks.length > MAX_BLOCKS) throw new Error('BOE block index is empty or exceeds its item limit.');
  const entries: BoeBlockIndexEntry[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    const id = childText(block, 'id') ?? block.attributes.id ?? '';
    const title = childText(block, 'titulo') ?? block.attributes.titulo ?? '';
    if (!validBlockId(id) || !title || title.length > 4_000 || seen.has(id)) throw new Error('Invalid BOE block index entry.');
    seen.add(id);
    entries.push({ id, title });
  }
  return entries;
}

export function parseBoeBlockXml(body: Buffer, expectedBlockId: string): BoeBlockHistory {
  if (!validBlockId(expectedBlockId)) throw new Error('Invalid requested BOE block identifier.');
  const data = responseData(parseBoundedXml(body, MAX_XML_BYTES));
  const blocks = descendants(data, 'bloque').filter((block) =>
    (block.attributes.id ?? childText(block, 'id')) === expectedBlockId);
  if (blocks.length !== 1) throw new Error('BOE block response identifier is missing, duplicated or does not match the request.');
  const block = blocks[0]!;
  const blockId = block.attributes.id ?? childText(block, 'id') ?? '';
  const title = block.attributes.titulo ?? childText(block, 'titulo') ?? expectedBlockId;
  const versionNodes = descendants(block, 'version');
  if (versionNodes.length === 0 || versionNodes.length > MAX_VERSIONS) throw new Error('BOE block has no versions or exceeds its version limit.');
  const versions: BoeBlockVersion[] = [];
  let totalText = 0;
  for (const version of versionNodes) {
    const normId = version.attributes.id_norma ?? '';
    const publicationDate = version.attributes.fecha_publicacion ?? '';
    const effectiveRaw = version.attributes.fecha_vigencia ?? '';
    if (!validNormId(normId) || !validDate(publicationDate) || (effectiveRaw !== '' && !validDate(effectiveRaw))) {
      throw new Error('BOE block version has invalid temporal metadata.');
    }
    const text = nodeText(version);
    totalText += text.length;
    if (!text || text.length > MAX_BLOCK_TEXT_CHARS || totalText > 160_000) throw new Error('BOE block text is empty or exceeds its limit.');
    const notes = descendants(version, 'blockquote').map(nodeText).filter(Boolean).slice(0, 12).map((note) => note.slice(0, 1_500));
    versions.push({ normId, publicationDate: formatDate(publicationDate), effectiveDate: effectiveRaw ? formatDate(effectiveRaw) : null, text, notes });
  }
  return { id: blockId, title, versions };
}

export function selectBoeHistoricalVersion(history: BoeBlockHistory, eventDate: string): BoeHistoricalSelection {
  const parsed = Date.parse(eventDate + 'T00:00:00.000Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate) || !Number.isFinite(parsed) ||
    new Date(parsed).toISOString().slice(0, 10) !== eventDate) {
    return { status: 'insufficient', reason: 'invalid_history', consideredVersionCount: 0 };
  }
  const versions = history.versions;
  if (versions.length === 0 || versions.some((version) =>
    !validDate(version.publicationDate.replace(/-/g, '')) ||
    (version.effectiveDate !== null && !validDate(version.effectiveDate.replace(/-/g, ''))))) {
    return { status: 'insufficient', reason: 'invalid_history', consideredVersionCount: versions.length };
  }
  const published = versions.filter((version) => version.publicationDate <= eventDate);
  const publishedAfterEvent = versions.filter((version) => version.publicationDate > eventDate);
  if (publishedAfterEvent.some((version) => version.effectiveDate === null || version.effectiveDate <= eventDate)) {
    return { status: 'insufficient', reason: 'possible_retroactivity', consideredVersionCount: versions.length };
  }
  if (published.length === 0) return { status: 'not_yet_published', consideredVersionCount: 0 };
  if (published.some((version) => version.effectiveDate === null)) {
    return { status: 'insufficient', reason: 'missing_effective_date', consideredVersionCount: published.length };
  }
  if (published.some((version) => version.effectiveDate! < version.publicationDate)) {
    return { status: 'insufficient', reason: 'effective_before_publication', consideredVersionCount: published.length };
  }
  const effective = published.filter((version) => version.effectiveDate! <= eventDate);
  if (effective.length === 0) return { status: 'not_effective_yet', consideredVersionCount: published.length };
  const latestDate = effective.reduce((latest, version) => version.effectiveDate! > latest ? version.effectiveDate! : latest, '0000-00-00');
  const candidates = effective.filter((version) => version.effectiveDate === latestDate);
  const first = candidates[0]!;
  if (candidates.some((version) => version.normId !== first.normId || version.text !== first.text ||
    JSON.stringify(version.notes) !== JSON.stringify(first.notes))) {
    return { status: 'insufficient', reason: 'ambiguous_effective_date', consideredVersionCount: published.length };
  }
  return { status: 'selected', version: first, consideredVersionCount: published.length };
}

export function findExplicitBoeArticleTitles(
  query: string, index: readonly BoeBlockIndexEntry[], maximum = 5,
): readonly BoeBlockIndexEntry[] {
  const requested = new Set<string>();
  const pattern = /\b(?:artículo|articulo|art\.?)\s*(\d{1,4})(?:\s*(bis|ter|quater|quinquies))?\b/giu;
  for (const match of query.matchAll(pattern)) requested.add(match[1]! + (match[2] ? ' ' + match[2].toLowerCase() : ''));
  const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const found: BoeBlockIndexEntry[] = [];
  for (const article of requested) {
    const suffix = article.split(' ')[1];
    const number = article.split(' ')[0]!;
    const matcher = new RegExp('^articulo\\s+' + number + (suffix ? '\\s+' + suffix : '') + '$', 'i');
    const entry = index.find((block) => matcher.test(normalize(block.title)));
    if (entry) found.push(entry);
  }
  return found.slice(0, Math.max(0, Math.min(maximum, MAX_BLOCKS)));
}
