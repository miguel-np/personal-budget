import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { z } from 'zod';

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MAX_DOCUMENTS = 2_000;
const currency = z.string().regex(/^[A-Z]{3}$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const LinkSchema = z.object({
  transactionId: z.string().trim().min(1).max(128),
  accountId: z.string().trim().min(1).max(128),
  transactionDate: isoDate,
}).strict();
const DocumentInputSchema = z.object({
  displayName: z.string().trim().min(1).max(200),
  documentDate: isoDate.optional(),
  issuer: z.string().trim().max(200).optional(),
  amountMinor: z.number().int().refine(Number.isSafeInteger).nonnegative().optional(),
  currency: currency.optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  notes: z.string().trim().max(2_000).optional(),
  fiscalYear: z.number().int().min(1900).max(9999).optional(),
  classification: z.enum(['invoice_received', 'invoice_issued', 'expense', 'income', 'asset', 'contract', 'receipt', 'other']).default('other'),
  reviewStatus: z.enum(['pending', 'reviewed', 'incomplete']).default('pending'),
}).strict().superRefine((value, context) => {
  if ((value.amountMinor === undefined) !== (value.currency === undefined)) {
    context.addIssue({ code: 'custom', path: ['currency'], message: 'An amount and currency must be provided together.' });
  }
});
export type DocumentInput = z.infer<typeof DocumentInputSchema>;
export const DocumentMetadataSchema = DocumentInputSchema.extend({
  id: z.string().uuid(),
  fileName: z.string().regex(/^[0-9a-f-]{36}\.(?:pdf|jpg|png)$/),
  mediaType: z.enum(['application/pdf', 'image/jpeg', 'image/png']),
  sizeBytes: z.number().int().min(1).max(MAX_DOCUMENT_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  addedAt: z.string().datetime(),
  archivedAt: z.string().datetime().optional(),
  links: z.array(LinkSchema).max(100),
}).strict().superRefine((document, context) => {
  const extension = document.mediaType === 'application/pdf' ? '.pdf' : document.mediaType === 'image/jpeg' ? '.jpg' : '.png';
  if (document.fileName !== document.id + extension) context.addIssue({ code: 'custom', path: ['fileName'], message: 'Stored filename must match the generated identifier and detected file type.' });
});
export type DocumentMetadata = z.infer<typeof DocumentMetadataSchema>;
export const DocumentIndexSchema = z.object({ version: z.literal(1), documents: z.array(DocumentMetadataSchema).max(MAX_DOCUMENTS) }).strict().superRefine((index, context) => {
  const ids = new Set<string>();
  index.documents.forEach((document, position) => {
    if (ids.has(document.id)) context.addIssue({ code: 'custom', path: ['documents', position, 'id'], message: 'Document IDs must be unique.' });
    ids.add(document.id);
  });
});
export type DocumentIndex = z.infer<typeof DocumentIndexSchema>;
const locks = new Map<string, Promise<void>>();

export function emptyDocumentIndex(): DocumentIndex { return { version: 1, documents: [] }; }
export function detectDocumentType(contents: Uint8Array): { extension: 'pdf' | 'jpg' | 'png'; mediaType: DocumentMetadata['mediaType'] } {
  if (contents.byteLength < 8 || contents.byteLength > MAX_DOCUMENT_BYTES) throw new RangeError('El documento debe ocupar entre 8 bytes y 10 MiB.');
  if (contents[0] === 0x25 && contents[1] === 0x50 && contents[2] === 0x44 && contents[3] === 0x46 && contents[4] === 0x2d) {
    return { extension: 'pdf', mediaType: 'application/pdf' };
  }
  if (contents[0] === 0xff && contents[1] === 0xd8 && contents[2] === 0xff) return { extension: 'jpg', mediaType: 'image/jpeg' };
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => contents[index] === byte)) {
    return { extension: 'png', mediaType: 'image/png' };
  }
  throw new TypeError('El contenido no corresponde a un PDF, JPEG o PNG admitido.');
}
function indexPath(directory: string): string { return resolve(directory, 'documents-index.json'); }
function documentDirectory(directory: string): string { return resolve(directory, 'documents'); }
function filePath(directory: string, fileName: string): string {
  if (!/^[0-9a-f-]{36}\.(?:pdf|jpg|png)$/.test(fileName)) throw new Error('Invalid internal document identifier.');
  const root = documentDirectory(directory);
  const path = resolve(root, fileName);
  if (!path.startsWith(root + sep)) throw new Error('Invalid internal document path.');
  return path;
}
async function assertDataDirectory(directory: string): Promise<void> {
  await mkdir(resolve(directory), { recursive: true, mode: 0o700 });
  const info = await lstat(resolve(directory));
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Local application data is not a safe directory.');
  await chmod(resolve(directory), 0o700).catch(() => undefined);
}
async function ensureDocumentDirectory(directory: string): Promise<string> {
  await assertDataDirectory(directory);
  const root = documentDirectory(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Local document storage is not a safe directory.');
  await chmod(root, 0o700).catch(() => undefined);
  return root;
}
export async function readDocumentIndex(directory: string): Promise<DocumentIndex> {
  await assertDataDirectory(directory);
  let content: string;
  try { content = await readFile(indexPath(directory), 'utf8'); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return emptyDocumentIndex(); throw error; }
  if (Buffer.byteLength(content, 'utf8') > 8 * 1024 * 1024) throw new Error('Document index exceeds its permitted size.');
  return DocumentIndexSchema.parse(JSON.parse(content) as unknown);
}
async function writeIndex(directory: string, value: DocumentIndex): Promise<void> {
  const index = DocumentIndexSchema.parse(value);
  await assertDataDirectory(directory);
  const path = indexPath(directory);
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(index, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, path);
    await chmod(path, 0o600).catch(() => undefined);
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
}
async function withLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const key = resolve(directory);
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  locks.set(key, gate);
  await previous;
  try { return await action(); }
  finally { release(); if (locks.get(key) === gate) locks.delete(key); }
}

export async function addDocument(directory: string, raw: Uint8Array, input: unknown): Promise<DocumentMetadata> {
  const metadata = DocumentInputSchema.parse(input);
  const content = Buffer.from(raw);
  const type = detectDocumentType(content);
  return withLock(directory, async () => {
    const current = await readDocumentIndex(directory);
    if (current.documents.length >= MAX_DOCUMENTS) throw new RangeError('Se ha alcanzado el límite de documentos locales.');
    const id = randomUUID();
    const fileName = id + '.' + type.extension;
    await ensureDocumentDirectory(directory);
    const path = filePath(directory, fileName);
    await writeFile(path, content, { flag: 'wx', mode: 0o600 });
    await chmod(path, 0o600).catch(() => undefined);
    const record = DocumentMetadataSchema.parse({
      ...metadata, id, fileName, mediaType: type.mediaType, sizeBytes: content.byteLength,
      sha256: createHash('sha256').update(content).digest('hex'), addedAt: new Date().toISOString(), links: [],
    });
    try { await writeIndex(directory, DocumentIndexSchema.parse({ version: 1, documents: [...current.documents, record] })); }
    catch (error) { await rm(path, { force: true }).catch(() => undefined); throw error; }
    return record;
  });
}

export async function updateDocumentMetadata(directory: string, id: string, update: unknown): Promise<DocumentMetadata | null> {
  const parsedId = z.string().uuid().parse(id);
  return withLock(directory, async () => {
    const current = await readDocumentIndex(directory);
    const existing = current.documents.find((item) => item.id === parsedId);
    if (!existing) return null;
    const input = DocumentInputSchema.partial().strict().parse(update);
    const next = DocumentMetadataSchema.parse({ ...existing, ...input });
    await writeIndex(directory, DocumentIndexSchema.parse({
      version: 1, documents: current.documents.map((item) => item.id === parsedId ? next : item),
    }));
    return next;
  });
}

export async function setDocumentLinks(directory: string, id: string, links: unknown): Promise<DocumentMetadata | null> {
  const parsedLinks = z.array(LinkSchema).max(100).parse(links);
  const keys = new Set<string>();
  for (const link of parsedLinks) {
    const key = [link.transactionId, link.accountId, link.transactionDate].join('|');
    if (keys.has(key)) throw new RangeError('No se permiten vínculos duplicados.');
    keys.add(key);
  }
  return withLock(directory, async () => {
    const current = await readDocumentIndex(directory);
    const existing = current.documents.find((item) => item.id === id);
    if (!existing) return null;
    const next = DocumentMetadataSchema.parse({ ...existing, links: parsedLinks });
    await writeIndex(directory, DocumentIndexSchema.parse({
      version: 1, documents: current.documents.map((item) => item.id === id ? next : item),
    }));
    return next;
  });
}

export async function archiveDocument(directory: string, id: string, archived: boolean): Promise<DocumentMetadata | null> {
  return withLock(directory, async () => {
    const current = await readDocumentIndex(directory);
    const existing = current.documents.find((item) => item.id === id);
    if (!existing) return null;
    const next = DocumentMetadataSchema.parse({
      ...existing,
      ...(archived ? { archivedAt: new Date().toISOString() } : { archivedAt: undefined }),
    });
    await writeIndex(directory, DocumentIndexSchema.parse({
      version: 1, documents: current.documents.map((item) => item.id === id ? next : item),
    }));
    return next;
  });
}

export async function deleteDocument(directory: string, id: string): Promise<boolean> {
  return withLock(directory, async () => {
    await ensureDocumentDirectory(directory);
    const current = await readDocumentIndex(directory);
    const existing = current.documents.find((item) => item.id === id);
    if (!existing) return false;
    const path = filePath(directory, existing.fileName);
    const tombstone = path + '.' + randomUUID() + '.deleting';
    await rename(path, tombstone);
    try {
      const next = DocumentIndexSchema.parse({ version: 1, documents: current.documents.filter((item) => item.id !== id) });
      await writeIndex(directory, next);
    } catch (error) {
      await rename(tombstone, path).catch(() => undefined);
      throw error;
    }
    await rm(tombstone, { force: true });
    return true;
  });
}

export async function readDocumentFile(directory: string, record: DocumentMetadata): Promise<Buffer> {
  await ensureDocumentDirectory(directory);
  const path = filePath(directory, record.fileName);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== record.sizeBytes) throw new Error('Stored document is missing or has an invalid file type.');
  const content = await readFile(path);
  if (createHash('sha256').update(content).digest('hex') !== record.sha256 || detectDocumentType(content).mediaType !== record.mediaType) {
    throw new Error('Stored document failed integrity validation.');
  }
  return content;
}

export async function listDocumentFilesForBackup(directory: string): Promise<readonly { fileName: string; sizeBytes: number; sha256: string }[]> {
  const index = await readDocumentIndex(directory);
  const root = await ensureDocumentDirectory(directory);
  const entries = await readdir(root);
  const expected = new Map(index.documents.map((item) => [item.fileName, item]));
  if (entries.length !== expected.size || entries.some((name) => !expected.has(name))) {
    throw new Error('Local document files do not match the versioned document index.');
  }
  const result = [];
  for (const record of index.documents) {
    const info = await lstat(filePath(directory, record.fileName));
    if (!info.isFile() || info.isSymbolicLink() || info.size !== record.sizeBytes) throw new Error('Unsafe or incomplete local document file inventory.');
    const content = await readFile(filePath(directory, record.fileName));
    const digest = createHash('sha256').update(content).digest('hex');
    if (digest !== record.sha256 || detectDocumentType(content).mediaType !== record.mediaType) throw new Error('Local document failed backup integrity validation.');
    result.push({ fileName: record.fileName, sizeBytes: info.size, sha256: digest });
  }
  return result;
}
