import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import ts from 'typescript';

const roots = ['src', 'tests', 'scripts'];
const rootFiles = ['electron.vite.config.ts', 'vitest.config.ts'];
const ignoredDirectories = new Set(['node_modules', 'out', 'release', 'tmp', '.git']);
const suppressedComments = ['@ts-' + 'ignore', '@ts-' + 'nocheck'];

function collectFiles(path: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === 'check-no-any.ts') continue;
    const next = join(path, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) files.push(...collectFiles(next));
    } else if (entry.isFile() && ['.ts', '.tsx'].includes(extname(entry.name))) {
      files.push(next);
    }
  }
  return files;
}

const files = [
  ...rootFiles,
  ...roots.flatMap((root) => collectFiles(root)),
];
const violations: string[] = [];

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    extname(file) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      const position = source.getLineAndCharacterOfPosition(node.getStart(source));
      violations.push(`${file}:${position.line + 1}:${position.character + 1} uses any`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (suppressedComments.some((comment) => line.includes(comment))) {
      violations.push(`${file}:${index + 1} uses ${line.includes('nocheck') ? '@ts-nocheck' : '@ts-ignore'}`);
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`No any types or TypeScript suppressions in ${files.length} authored files.`);
}
