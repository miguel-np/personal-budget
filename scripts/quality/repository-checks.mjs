import { execFileSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'coverage', '.local', '.agents']);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const WORKSPACES = ['packages/finance-core', 'services/actual-adapter', 'services/api', 'apps/web', 'services/mcp'];
const INTERNAL_PACKAGE_PATHS = new Map([
  ['@personal-budget/finance-core', 'packages/finance-core'],
  ['@personal-budget/actual-adapter', 'services/actual-adapter'],
]);
const ALLOWED_WORKSPACE_IMPORTS = new Map([
  ['packages/finance-core', new Set(['packages/finance-core'])],
  ['services/actual-adapter', new Set(['services/actual-adapter', 'packages/finance-core'])],
  ['services/api', new Set(['services/api', 'services/actual-adapter', 'packages/finance-core'])],
  ['apps/web', new Set(['apps/web'])],
  ['services/mcp', new Set(['services/mcp'])],
]);
const RESTRICTED_PACKAGES = new Map([
  ['@actual-app/api', 'services/actual-adapter'],
  ['fastify', 'services/api'],
  ['@fastify/helmet', 'services/api'],
  ['react', 'apps/web'],
  ['react-dom', 'apps/web'],
  ['@modelcontextprotocol/sdk', 'services/mcp'],
]);
const FILE_LINE_LIMIT = 600;
const FILE_BYTE_LIMIT = 40 * 1024;

async function walkFiles(directory, predicate) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walkFiles(absolute, predicate));
    else if (entry.isFile() && predicate(absolute)) result.push(absolute);
  }
  return result;
}

function relativePath(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function stripCodeExamples(markdown) {
  const backtickFence = String.fromCharCode(96).repeat(3);
  return markdown
    .split(backtickFence).filter((_, index) => index % 2 === 0).join('')
    .split('~~~').filter((_, index) => index % 2 === 0).join('');
}

export function extractMarkdownLinks(markdown) {
  const source = stripCodeExamples(markdown);
  const links = [];
  for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)\n]+)\)/g)) {
    let destination = (match[1] ?? '').trim();
    if (destination.startsWith('<') && destination.includes('>')) {
      destination = destination.slice(1, destination.indexOf('>'));
    } else {
      destination = destination.split(/\s+/u, 1)[0] ?? '';
    }
    if (!destination || destination.startsWith('#')) continue;
    if (/^(?:https?:|mailto:|tel:|data:|javascript:)/i.test(destination)) continue;
    links.push(destination);
  }
  return links;
}

function workspaceForPath(candidate) {
  const normalized = candidate.split(path.sep).join('/');
  return WORKSPACES.find((workspace) => normalized === workspace || normalized.startsWith(workspace + '/'));
}

function packageName(specifier) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0] ?? specifier;
}

function importedWorkspace(filePath, specifier) {
  if (INTERNAL_PACKAGE_PATHS.has(specifier)) return INTERNAL_PACKAGE_PATHS.get(specifier);
  if (!specifier.startsWith('.')) return undefined;
  const absolute = path.resolve(ROOT, path.dirname(filePath), specifier);
  const candidate = path.relative(ROOT, absolute);
  if (candidate.startsWith('..') || path.isAbsolute(candidate)) return undefined;
  return workspaceForPath(candidate);
}

export function getImportBoundaryViolation(filePath, specifier) {
  const sourceWorkspace = workspaceForPath(filePath);
  if (!sourceWorkspace) return undefined;
  const restrictedOwner = RESTRICTED_PACKAGES.get(packageName(specifier));
  if (restrictedOwner && restrictedOwner !== sourceWorkspace) {
    return filePath + ' imports ' + specifier + '; this dependency belongs exclusively to ' + restrictedOwner + '.';
  }
  const targetWorkspace = importedWorkspace(filePath, specifier);
  if (!targetWorkspace) return undefined;
  if (!ALLOWED_WORKSPACE_IMPORTS.get(sourceWorkspace)?.has(targetWorkspace)) {
    return filePath + ' imports ' + targetWorkspace + ' across a forbidden workspace boundary.';
  }
  return undefined;
}

function extractImportSpecifiers(source) {
  const specifiers = new Set();
  const expressions = [
    /\bimport\s+(?:type\s+)?(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:type\s+)?[^'";]*?\s+from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const expression of expressions) {
    for (const match of source.matchAll(expression)) {
      if (match[1]) specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}

async function checkArchitecture() {
  const errors = [];
  for (const workspace of WORKSPACES) {
    const directory = path.join(ROOT, workspace);
    try { await stat(directory); } catch { continue; }
    const files = await walkFiles(directory, (file) => SOURCE_EXTENSIONS.has(path.extname(file)));
    for (const file of files) {
      const relative = relativePath(file);
      const source = await readFile(file, 'utf8');
      for (const specifier of extractImportSpecifiers(source)) {
        const violation = getImportBoundaryViolation(relative, specifier);
        if (violation) errors.push(violation);
      }
    }
  }

  const manifestRules = new Map([
    ['packages/finance-core/package.json', new Set()],
    ['services/actual-adapter/package.json', new Set(['@personal-budget/finance-core'])],
    ['services/api/package.json', new Set(['@personal-budget/finance-core', '@personal-budget/actual-adapter'])],
    ['apps/web/package.json', new Set()],
  ]);
  for (const [manifestPath, allowed] of manifestRules) {
    const manifest = JSON.parse(await readFile(path.join(ROOT, manifestPath), 'utf8'));
    for (const dependency of Object.keys(manifest.dependencies ?? {}).filter((name) => name.startsWith('@personal-budget/'))) {
      if (!allowed.has(dependency)) errors.push(manifestPath + ' declares forbidden workspace dependency ' + dependency + '.');
    }
  }
  return errors;
}

function lineCount(content) {
  const lines = content.split(/\r?\n/u);
  return lines.length - (content.endsWith('\n') ? 1 : 0);
}

export function evaluateFileBudget(previous, current, filePath) {
  const previousLines = previous === null ? 0 : lineCount(previous.toString('utf8'));
  const currentLines = lineCount(current.toString('utf8'));
  const previousBytes = previous?.byteLength ?? 0;
  const currentBytes = current.byteLength;
  const wasOverBudget = previous !== null && (previousLines > FILE_LINE_LIMIT || previousBytes > FILE_BYTE_LIMIT);

  if (previous === null) {
    return currentLines > FILE_LINE_LIMIT || currentBytes > FILE_BYTE_LIMIT
      ? filePath + ' is new and exceeds the maintainability budget (' + currentLines + ' lines, ' + currentBytes + ' bytes).'
      : undefined;
  }
  if (wasOverBudget) {
    if (currentLines > previousLines || currentBytes > previousBytes) {
      return filePath + ' already exceeded the maintainability budget and must not grow (' +
        previousLines + ' → ' + currentLines + ' lines; ' + previousBytes + ' → ' + currentBytes + ' bytes).';
    }
    return undefined;
  }
  if (currentLines > FILE_LINE_LIMIT || currentBytes > FILE_BYTE_LIMIT) {
    return filePath + ' crosses the maintainability budget (' + currentLines + ' lines, ' + currentBytes +
      ' bytes; maximum ' + FILE_LINE_LIMIT + ' lines and ' + FILE_BYTE_LIMIT + ' bytes).';
  }
  return undefined;
}

async function checkChangedFileBudgets() {
  const base = process.env.QUALITY_BASE_SHA;
  const head = process.env.QUALITY_HEAD_SHA || 'HEAD';
  if (!base || !/^[0-9a-f]{40}$/i.test(base) || base === '0000000000000000000000000000000000000000') {
    console.log('Maintainability delta check skipped: no valid base SHA was supplied.');
    return [];
  }
  const changedOutput = execFileSync('git', [
    'diff', '--name-only', '--diff-filter=ACMR', '-z', base + '...' + head,
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const changedPaths = changedOutput.split('\0').filter((file) => file && SOURCE_EXTENSIONS.has(path.extname(file)));
  const errors = [];

  for (const filePath of changedPaths) {
    let current;
    try { current = await readFile(path.join(ROOT, filePath)); } catch { continue; }
    let previous = null;
    try {
      previous = execFileSync('git', ['show', base + ':' + filePath], {
        cwd: ROOT, maxBuffer: 10 * 1024 * 1024,
      });
    } catch {
      // New paths receive the full file budget.
    }
    const violation = evaluateFileBudget(previous, current, filePath);
    if (violation) errors.push(violation);
    const lines = lineCount(current.toString('utf8'));
    if (lines > FILE_LINE_LIMIT || current.byteLength > FILE_BYTE_LIMIT) {
      console.log('Existing maintainability exception: ' + filePath + ' (' + lines + ' lines, ' + current.byteLength + ' bytes).');
    }
  }
  return errors;
}

export function extractNpmCommands(markdown) {
  const samples = [...markdown.matchAll(/```[\s\S]*?```|~~~[\s\S]*?~~~/g)].map((match) => match[0].slice(3, -3));
  const backtick = String.fromCharCode(96);
  const inlineCode = new RegExp(backtick + '([^' + backtick + '\n]+)' + backtick, 'g');
  for (const match of markdown.matchAll(inlineCode)) samples.push(match[1] ?? '');
  const commands = [];
  const expression = /\bnpm\s+run\s+([a-zA-Z0-9:_-]+)([^\n]*)/g;
  for (const sample of samples) {
    for (const match of sample.matchAll(expression)) {
      commands.push({ script: match[1], suffix: match[2] ?? '' });
    }
  }
  return commands;
}
async function checkDocumentation() {
  const errors = [];
  const markdownFiles = await walkFiles(ROOT, (file) => file.toLowerCase().endsWith('.md'));
  const rootManifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const rootScripts = new Set(Object.keys(rootManifest.scripts ?? {}));
  const workspaceScripts = new Map();

  for (const workspacePattern of rootManifest.workspaces ?? []) {
    const workspaceRoot = workspacePattern.replace(/\/\*$/, '');
    try {
      const manifest = JSON.parse(await readFile(path.join(ROOT, workspaceRoot, 'package.json'), 'utf8'));
      workspaceScripts.set(manifest.name, new Set(Object.keys(manifest.scripts ?? {})));
      workspaceScripts.set(workspaceRoot, new Set(Object.keys(manifest.scripts ?? {})));
    } catch {
      // Workspace globs without a direct package manifest are not script targets.
    }
  }

  for (const file of markdownFiles) {
    const relative = relativePath(file);
    const content = await readFile(file, 'utf8');
    for (const destination of extractMarkdownLinks(content)) {
      let decoded;
      try { decoded = decodeURIComponent(destination.split(/[?#]/u, 1)[0] ?? ''); }
      catch {
        errors.push(relative + ' contains an invalid encoded link: ' + destination);
        continue;
      }
      if (!decoded) continue;
      const absolute = decoded.startsWith('/')
        ? path.resolve(ROOT, '.' + decoded)
        : path.resolve(path.dirname(file), decoded);
      let exists = false;
      for (const candidate of [absolute, absolute + '.md', path.join(absolute, 'README.md'), path.join(absolute, 'index.md')]) {
        try { await stat(candidate); exists = true; break; } catch { /* Try the next Markdown target. */ }
      }
      if (!exists) errors.push(relative + ' links to a missing local path: ' + destination);
    }

    for (const { script, suffix } of extractNpmCommands(content)) {
      const workspaceMatch = suffix.match(/(?:--workspace(?:=|\s+)|-w\s+)([^\s]+)/);
      if (workspaceMatch) {
        const scripts = workspaceScripts.get(workspaceMatch[1]);
        if (scripts && !scripts.has(script)) {
          errors.push(relative + ' documents an unknown workspace npm script: ' + workspaceMatch[1] + ' run ' + script + '.');
        }
        continue;
      }
      if (!rootScripts.has(script)) errors.push(relative + ' documents an unknown root npm script: ' + script + '.');
    }
  }
  return errors;
}

async function main() {
  const [documentationErrors, architectureErrors, budgetErrors] = await Promise.all([
    checkDocumentation(), checkArchitecture(), checkChangedFileBudgets(),
  ]);
  const groups = [['Documentation', documentationErrors], ['Architecture', architectureErrors], ['Maintainability', budgetErrors]];
  let total = 0;
  for (const [name, errors] of groups) {
    if (errors.length === 0) console.log(name + ': passed.');
    else {
      total += errors.length;
      console.error(name + ' violations:');
      for (const error of errors) console.error(' - ' + error);
    }
  }
  if (total > 0) process.exitCode = 1;
  else console.log('Repository quality gates passed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
