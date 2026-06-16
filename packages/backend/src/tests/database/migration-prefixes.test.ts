import { describe, it, expect } from 'vitest';
import { readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '../../../migrations');

describe('migration files', () => {
  it('have unique numeric prefixes', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
    const byPrefix = new Map<string, string[]>();

    for (const file of files) {
      // Prefix is everything before the first underscore: digits plus an
      // optional letter suffix used to disambiguate post-merge collisions
      // (e.g. 037a, 042b). Two files share a prefix only if this whole
      // segment matches.
      const match = file.match(/^([0-9]+[a-z]?)_/);
      if (!match) continue;
      const prefix = match[1];
      const existing = byPrefix.get(prefix) ?? [];
      existing.push(file);
      byPrefix.set(prefix, existing);
    }

    const duplicates = Array.from(byPrefix.entries()).filter(([, list]) => list.length > 1);
    if (duplicates.length > 0) {
      const lines = duplicates.map(([prefix, list]) => `  ${prefix}: ${list.join(', ')}`).join('\n');
      throw new Error(
        `Duplicate migration prefixes detected:\n${lines}\n\n` +
          'Each migration must have a unique numeric prefix. See ' +
          'src/database/migration-repair.ts for how to handle renames safely.',
      );
    }

    expect(duplicates).toEqual([]);
  });
});
