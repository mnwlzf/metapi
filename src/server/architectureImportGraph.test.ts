import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * Layer dependency check, computed from the real import graph.
 *
 * `architecture-boundaries.test.ts` asserts "route file X must not contain function Y" as
 * strings, which is useful against re-inlining but blind to imports: adding
 * `import ... from '../services/foo.js'` into a transformer passes every string assertion.
 * This file reads the actual `from '...'` specifiers, resolves them to files, and compares
 * the layer-to-layer edges against a recorded allowlist.
 *
 * The allowlist is the CURRENT graph, so it fails on a NEW edge between layers. Adding one
 * is a deliberate act: record it here with a reason. The one upward edge (services ->
 * routes) is a re-export shim and is called out below; it may not spread.
 */

const SERVER_ROOT = __dirname;
const LAYERS = ['routes', 'proxy-core', 'services', 'transformers', 'db', 'shared', 'executors'] as const;
type Layer = (typeof LAYERS)[number];

function isLayer(value: string): value is Layer {
  return (LAYERS as readonly string[]).includes(value);
}

function layerOf(absolutePath: string): Layer | null {
  const top = relative(SERVER_ROOT, absolutePath).split(/[\\/]/)[0];
  return isLayer(top) ? top : null;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const IMPORT_SPECIFIER = /from\s+['"](\.[^'"]+)['"]/g;

function collectEdges(): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  for (const file of sourceFiles(SERVER_ROOT)) {
    const from = layerOf(file);
    if (!from) continue;
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(IMPORT_SPECIFIER)) {
      const specifier = match[1];
      const target = specifier.replace(/\.js$/, '.ts');
      const to = layerOf(resolve(dirname(file), target));
      if (!to || to === from) continue;
      const key = `${from} -> ${to}`;
      const examples = edges.get(key) ?? [];
      const repositoryPath = relative(SERVER_ROOT, file).replaceAll('\\', '/');
      if (examples.length < 3 && !examples.includes(repositoryPath)) {
        examples.push(repositoryPath);
      }
      edges.set(key, examples);
    }
  }
  return edges;
}

/** Layer pairs that exist today. A new pair means a new architectural direction. */
const ALLOWED_EDGES = [
  'db -> shared',
  'proxy-core -> db',
  'proxy-core -> services',
  'proxy-core -> shared',
  'proxy-core -> transformers',
  'routes -> db',
  'routes -> proxy-core',
  'routes -> services',
  'routes -> shared',
  'routes -> transformers',
  'services -> db',
  'services -> proxy-core',
  'services -> routes',
  'services -> shared',
  'services -> transformers',
  'transformers -> shared',
];

describe('layer dependency direction', () => {
  it('keeps consumption reads local and upstream collection behind an explicit adapter capability', () => {
    const routes = readFileSync(join(SERVER_ROOT, 'routes/api/usageCollection.ts'), 'utf8');
    expect(routes).not.toMatch(/\bfetch\s*\(|\.from\s*\(|\.insert\s*\(/);
    const collector = readFileSync(join(SERVER_ROOT, 'services/usageCollectionService.ts'), 'utf8');
    expect(collector).toContain('adapter.getUsageDashboard!');
    expect(collector).not.toMatch(/platform\s*===\s*['"]sub2api/);
    const store = readFileSync(join(SERVER_ROOT, 'services/usageCollectionStore.ts'), 'utf8');
    expect(store).not.toContain('proxyLogs');
    const policy = readFileSync(join(SERVER_ROOT, 'services/usageCollectionPolicy.ts'), 'utf8');
    expect(policy).not.toMatch(/from ['"].*(?:db|routes|platforms)/);
  });
  it('has exactly the recorded layer edges', () => {
    const edges = collectEdges();
    const actual = [...edges.keys()].sort();
    expect(actual).toEqual([...ALLOWED_EDGES].sort());
  });

  it('never lets a transformer reach above its own layer', () => {
    // transformers is the bottom of the protocol stack: it may depend on shared helpers and
    // on nothing that owns a request, a channel or a table.
    const edges = collectEdges();
    const upward = [...edges.keys()].filter((edge) => edge.startsWith('transformers -> ')).sort();
    expect(upward).toEqual(['transformers -> shared']);
  });

  it('keeps first verification policy pure and its ledger independent of route orchestration', () => {
    const policy = readFileSync(join(SERVER_ROOT, 'services/modelProbeQueuePolicy.ts'), 'utf8');
    expect([...policy.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)]).toHaveLength(0);
    const ledger = readFileSync(join(SERVER_ROOT, 'services/modelFirstVerificationService.ts'), 'utf8');
    const imports = [...ledger.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
    expect(imports).not.toContain('./modelService.js');
    expect(imports.some((path) => /routes|proxy-core|fastify/.test(path))).toBe(false);
  });

  it('keeps the single upward edge to one shim', () => {
    // services -> routes is a re-export shim (services/runtimeDispatch.ts forwards
    // dispatchRuntimeRequest from routes/proxy/runtimeExecutor.ts) so services can import
    // "the runtime dispatcher" without naming a route. It is the only upward edge in the
    // graph; moving that executor into services would delete it. Until then, it may not
    // become the pattern for reaching into routes.
    const edges = collectEdges();
    expect(edges.get('services -> routes')).toEqual(['services/runtimeDispatch.ts']);
  });
});
