/**
 * Stable content identity for an imported inventory+metrics pair.
 * Decision history must NEVER be keyed by a filename or file size: two different
 * datasets can share both, and approvals for one must not load for the other.
 * Web Crypto is available in secure browsers, localhost and modern file contexts.
 */
export async function datasetFingerprint(inventoryCsv: string, metricsCsv: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Secure SHA-256 hashing is unavailable here. Open this app on localhost or HTTPS before importing data.');
  }
  // Length-prefix the UTF-8 payloads so pairs cannot be confused by a separator in CSV contents.
  const enc = new TextEncoder();
  const inventory = enc.encode(inventoryCsv);
  const metrics = enc.encode(metricsCsv);
  const prefix = enc.encode(`CloudSentinelX-import-v1:${inventory.length}:${metrics.length}:`);
  const input = new Uint8Array(prefix.length + inventory.length + metrics.length);
  input.set(prefix);
  input.set(inventory, prefix.length);
  input.set(metrics, prefix.length + inventory.length);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', input));
  return `import-sha256-${Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
