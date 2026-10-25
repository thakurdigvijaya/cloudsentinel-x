import { describe, expect, it } from 'vitest';
import { datasetFingerprint } from '../datasetFingerprint';

describe('Imported dataset identity', () => {
  it('hashes both contents, not filename or file size', async () => {
    const a=await datasetFingerprint('id,name\n1,vmA','resource_id,cpu_pct\n1,20');
    const b=await datasetFingerprint('id,name\n1,vmB','resource_id,cpu_pct\n1,20');
    const c=await datasetFingerprint('id,name\n1,vmA','resource_id,cpu_pct\n1,21');
    expect(a).toBe(await datasetFingerprint('id,name\n1,vmA','resource_id,cpu_pct\n1,20'));
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^import-sha256-[a-f0-9]{64}$/);
  });
});
