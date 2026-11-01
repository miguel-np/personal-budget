import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  addDocument, deleteDocument, detectDocumentType, emptyDocumentIndex,
  listDocumentFilesForBackup, readDocumentFile, readDocumentIndex, setDocumentLinks,
} from '../src/documents-store.js';

const directories: string[] = [];
async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'personal-budget-documents-'));
  directories.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const pdf = (text: string) => Buffer.from('%PDF-1.4\n' + text + '\n%%EOF', 'ascii');

describe('local document storage internals', () => {
  it('detects supported formats and rejects everything else', () => {
    expect(detectDocumentType(pdf('a')).mediaType).toBe('application/pdf');
    expect(detectDocumentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])).mediaType).toBe('image/jpeg');
    expect(detectDocumentType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).mediaType).toBe('image/png');
    expect(() => detectDocumentType(Buffer.from('tiny'))).toThrow(RangeError);
    expect(() => detectDocumentType(Buffer.alloc(10 * 1024 * 1024 + 1, 0x25))).toThrow(RangeError);
    expect(() => detectDocumentType(Buffer.from('GIF89a----'))).toThrow(TypeError);
  });

  it('returns an empty index when nothing is stored yet', async () => {
    expect(emptyDocumentIndex()).toEqual({ version: 1, documents: [] });
    expect((await readDocumentIndex(await directory())).documents).toEqual([]);
  });

  it('rejects malformed or oversized index files', async () => {
    const dir = await directory();
    await writeFile(join(dir, 'documents-index.json'), '{no json', 'utf8');
    await expect(readDocumentIndex(dir)).rejects.toBeInstanceOf(SyntaxError);
    await writeFile(join(dir, 'documents-index.json'), '[' + '1,'.repeat(5_000_000) + ']', 'utf8');
    await expect(readDocumentIndex(dir)).rejects.toThrow('Document index exceeds its permitted size.');
  });

  it('stores, links and deletes documents with integrity verification', async () => {
    const dir = await directory();
    const bytes = pdf('contenido');
    const record = await addDocument(dir, bytes, { displayName: 'Recibo', classification: 'receipt' });
    expect(record.fileName).toMatch(/^[0-9a-f-]{36}\.pdf$/);
    const index = await readDocumentIndex(dir);
    expect(index.documents).toHaveLength(1);
    const file = await readDocumentFile(dir, index.documents[0]!);
    expect(file.equals(bytes)).toBe(true);
    expect(await deleteDocument(dir, record.id)).toBe(true);
    expect((await readDocumentIndex(dir)).documents).toHaveLength(0);
    expect(await deleteDocument(dir, record.id)).toBe(false);
  });

  it('rejects invalid metadata and duplicate links at the store boundary', async () => {
    const dir = await directory();
    await expect(addDocument(dir, pdf('x'), { displayName: '' })).rejects.toBeInstanceOf(ZodError);
    await expect(addDocument(dir, pdf('x'), { displayName: 'Ok', amountMinor: 100 })).rejects.toBeInstanceOf(ZodError);
    const record = await addDocument(dir, pdf('x'), { displayName: 'Recibo' });
    const link = { transactionId: 't-1', accountId: 'a-1', transactionDate: '2026-11-01' };
    await expect(setDocumentLinks(dir, record.id, [link, link])).rejects.toThrow('vínculos duplicados');
  });

  it('detects index/file mismatches and tampered binaries before backup', async () => {
    const dir = await directory();
    const bytes = pdf('original');
    await addDocument(dir, bytes, { displayName: 'Original' });
    const index = await readDocumentIndex(dir);
    const record = index.documents[0]!;
    const path = join(dir, 'documents', record.fileName);
    await writeFile(join(dir, 'documents', '00000000-0000-4000-8000-0000000000ff.pdf'), pdf('ghost'));
    await expect(listDocumentFilesForBackup(dir)).rejects.toThrow('do not match the versioned document index');
    await rm(join(dir, 'documents', '00000000-0000-4000-8000-0000000000ff.pdf'));
    await writeFile(path, pdf('tampered'));
    await expect(listDocumentFilesForBackup(dir)).rejects.toThrow('backup integrity');
    await expect(readDocumentFile(dir, record)).rejects.toThrow('integrity validation');
    await writeFile(path, 'x');
    await expect(listDocumentFilesForBackup(dir)).rejects.toThrow('Unsafe or incomplete local document file inventory');
    await expect(readDocumentFile(dir, record)).rejects.toThrow('missing or has an invalid file type');
  });

  it('fails closed when a document file is missing', async () => {
    const dir = await directory();
    const record = await addDocument(dir, pdf('contenido'), { displayName: 'Recibo' });
    await rm(join(dir, 'documents', record.fileName));
    await expect(readDocumentFile(dir, record)).rejects.toThrow();
    await expect(listDocumentFilesForBackup(dir)).rejects.toThrow('do not match the versioned document index');
  });

  it('enforces the document count limit', async () => {
    const dir = await directory();
    const documents = Array.from({ length: 2_000 }, () => {
      const id = randomUUID();
      return {
        id,
        fileName: id + '.pdf',
        displayName: 'Documento ' + id,
        mediaType: 'application/pdf',
        sizeBytes: 100,
        sha256: 'a'.repeat(64),
        addedAt: '2026-11-01T00:00:00.000Z',
        links: [],
      };
    });
    await writeFile(join(dir, 'documents-index.json'), JSON.stringify({ version: 1, documents }, null, 2) + '\n');
    await expect(addDocument(dir, pdf('x'), { displayName: 'Uno más' })).rejects.toThrow('límite de documentos');
  });
});
