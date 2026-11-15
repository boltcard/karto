import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CARDD_SCHEMA_VERSION } from './schema';

// server/internal/store writes testvectors/schema.json from its migrations; the app must carry the same number.
describe('CARDD_SCHEMA_VERSION', () => {
  it("is the bundled cardd's schema", () => {
    const vector = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'testvectors', 'schema.json'), 'utf8'));
    expect(CARDD_SCHEMA_VERSION).toBe(vector.schema);
  });
});
