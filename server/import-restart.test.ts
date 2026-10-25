// Isolated API test: uploaded data survives a server restart and synthetic reset is durable.
import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateDataset } from '../src/data/generator';
import { createApp } from './app';

async function runServer(file: string) {
  const createAppInstance = createApp({ decisionsFile: file });
  const server = createServer((req, res) => void createAppInstance(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { server, base: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}` };
}

describe('durable imported dataset', () => {
  it('reopens imported metrics and clears them on synthetic reset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cloudsentinel-import-test-'));
    const file = join(dir, 'decisions.json');
    let server: ReturnType<typeof createServer> | null = null;
    try {
      let running = await runServer(file);
      server = running.server;
      const dataset = generateDataset();
      const resource = dataset.resources.find((r) => r.type === 'vm' && !(r.dependsOn?.length))!;
      const csvJson = JSON.stringify({ resources: [resource], series: [dataset.series.get(resource.id)!] });
      const post = (base: string, url: string, data: unknown) => fetch(base + url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
      });
      const importResponse = await post(running.base, '/api/import', { json: csvJson });
      expect(importResponse.status).toBe(201);
      expect(existsSync(file + '.import.json.gz')).toBe(true);
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      running = await runServer(file);
      server = running.server;
      const h = await fetch(running.base + '/api/health').then((r) => r.json());
      expect(h.dataset.source).toBe('imported');
      expect(h.dataset.resources).toBe(1);
      const reset = await post(running.base, '/api/dataset/reset', {});
      expect(reset.status).toBe(200);
      expect(existsSync(file + '.import.json.gz')).toBe(false);
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      running = await runServer(file);
      server = running.server;
      const after = await fetch(running.base + '/api/health').then((r) => r.json());
      expect(after.dataset.source).toBe('synthetic');
      expect(after.dataset.resources).toBe(122);
    } finally {
      if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
