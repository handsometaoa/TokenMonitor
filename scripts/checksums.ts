import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Usage: npx tsx scripts/checksums.ts [dir]
// Writes <file>.sha256 next to every installer artifact so downloads can be verified:
//   macOS/Linux:  sha256sum -c <file>.sha256
//   Windows:      certutil -hashfile <file> SHA256  (compare with the .sha256 content)
const dir = process.argv[2] ?? 'release';

for (const name of readdirSync(dir)) {
  if (!/\.(exe|dmg|zip)$/i.test(name) || name.endsWith('.sha256')) continue;
  const hash = createHash('sha256').update(readFileSync(join(dir, name))).digest('hex');
  writeFileSync(join(dir, `${name}.sha256`), `${hash}  ${name}\n`);
  console.log(`${hash}  ${name}`);
}
