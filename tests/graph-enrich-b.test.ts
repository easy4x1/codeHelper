import { describe, it, expect } from 'vitest';
import { KnowledgeGraphBuilder } from '../src/core/knowledge-graph.js';
import {
  runEnrichers,
  B_LAYER_ENRICHERS,
  routesEnricher,
  eventsEnricher,
  middlewareEnricher,
  dataAccessEnricher,
  schemaTablesEnricher,
  type EnrichContext,
} from '../src/core/graph-enrich.js';
import type { FileFingerprint, GraphEdge } from '../src/core/types.js';

function fp(partial: Partial<FileFingerprint> & { filePath: string }): FileFingerprint {
  return {
    contentHash: 'h',
    functions: [],
    classes: [],
    imports: [],
    exports: [],
    totalLines: 1,
    hasStructuralAnalysis: true,
    ...partial,
  };
}

function hasEdge(edges: GraphEdge[], source: string, type: string, target: string): boolean {
  return edges.some(e => e.source === source && e.type === type && e.target === target);
}

const B: EnrichContext['enabledLayers'] = ['B'];

describe('routesEnricher', () => {
  it('extracts endpoint nodes and routes edges from call-style route registrations', async () => {
    const fingerprints = { 'src/api.ts': fp({ filePath: 'src/api.ts' }) };
    const ctx: EnrichContext = {
      enabledLayers: B,
      sources: { 'src/api.ts': `app.get('/users', list);\nrouter.post('/users', create);\n` },
    };
    const builder = new KnowledgeGraphBuilder();

    await routesEnricher.enrich(builder, fingerprints, ctx);
    const g = builder.build();

    expect(g.nodes.find(n => n.id === 'endpoint:src/api.ts:GET /users')?.type).toBe('endpoint');
    expect(g.nodes.find(n => n.id === 'endpoint:src/api.ts:POST /users')?.type).toBe('endpoint');
    expect(hasEdge(g.edges, 'file:src/api.ts', 'routes', 'endpoint:src/api.ts:GET /users')).toBe(true);
  });

  it('extracts endpoints from decorator-style routes', async () => {
    const fingerprints = { 'src/ctrl.ts': fp({ filePath: 'src/ctrl.ts' }) };
    const ctx: EnrichContext = {
      enabledLayers: B,
      sources: { 'src/ctrl.ts': `@Get('/health')\nhealth() {}\n` },
    };
    const builder = new KnowledgeGraphBuilder();

    await routesEnricher.enrich(builder, fingerprints, ctx);

    expect(builder.build().nodes.some(n => n.id === 'endpoint:src/ctrl.ts:GET /health')).toBe(true);
  });

  it('ignores .get calls whose first argument is not a route path', async () => {
    const fingerprints = { 'src/cache.ts': fp({ filePath: 'src/cache.ts' }) };
    const ctx: EnrichContext = {
      enabledLayers: B,
      sources: { 'src/cache.ts': `cache.get('userKey');\nmap.get('x');\n` },
    };
    const builder = new KnowledgeGraphBuilder();

    await routesEnricher.enrich(builder, fingerprints, ctx);

    expect(builder.build().nodes.some(n => n.type === 'endpoint')).toBe(false);
  });
});

describe('eventsEnricher', () => {
  it('builds subscribes and publishes edges to event concept nodes', async () => {
    const fingerprints = { 'src/bus.ts': fp({ filePath: 'src/bus.ts' }) };
    const ctx: EnrichContext = {
      enabledLayers: B,
      sources: { 'src/bus.ts': `bus.on('user.created', fn);\nbus.emit('user.created', payload);\n` },
    };
    const builder = new KnowledgeGraphBuilder();

    await eventsEnricher.enrich(builder, fingerprints, ctx);
    const g = builder.build();

    expect(g.nodes.find(n => n.id === 'concept:event:user.created')?.type).toBe('concept');
    expect(hasEdge(g.edges, 'file:src/bus.ts', 'subscribes', 'concept:event:user.created')).toBe(true);
    expect(hasEdge(g.edges, 'file:src/bus.ts', 'publishes', 'concept:event:user.created')).toBe(true);
  });

  it('ignores listener calls without a string event name', async () => {
    const fingerprints = { 'src/x.ts': fp({ filePath: 'src/x.ts' }) };
    const ctx: EnrichContext = { enabledLayers: B, sources: { 'src/x.ts': `el.on(handler);\nobs.subscribe(next);\n` } };
    const builder = new KnowledgeGraphBuilder();

    await eventsEnricher.enrich(builder, fingerprints, ctx);

    expect(builder.build().edges.some(e => e.type === 'subscribes' || e.type === 'publishes')).toBe(false);
  });
});

describe('middlewareEnricher', () => {
  it('links app.use(ident) to a resolved local or imported function', async () => {
    const fingerprints = {
      'src/app.ts': fp({
        filePath: 'src/app.ts',
        functions: [{ name: 'logger', params: [], isExported: false, startLine: 1, endLine: 2 }],
        imports: [{ source: './auth.js', items: ['auth'], line: 1 }],
      }),
      'src/auth.ts': fp({ filePath: 'src/auth.ts', functions: [{ name: 'auth', params: [], isExported: true, startLine: 1, endLine: 2 }] }),
    };
    const ctx: EnrichContext = {
      enabledLayers: B,
      sources: { 'src/app.ts': `app.use(logger);\napp.use(auth);\n`, 'src/auth.ts': '' },
    };
    const builder = new KnowledgeGraphBuilder();

    await middlewareEnricher.enrich(builder, fingerprints, ctx);
    const g = builder.build();

    expect(hasEdge(g.edges, 'file:src/app.ts', 'middleware', 'function:src/app.ts:logger')).toBe(true);
    expect(hasEdge(g.edges, 'file:src/app.ts', 'middleware', 'function:src/auth.ts:auth')).toBe(true);
  });

  it('ignores .use on non-server receivers and inline call arguments', async () => {
    const fingerprints = { 'src/app.ts': fp({ filePath: 'src/app.ts' }) };
    const ctx: EnrichContext = {
      enabledLayers: B,
      sources: { 'src/app.ts': `React.use(promise);\napp.use(express.json());\n` },
    };
    const builder = new KnowledgeGraphBuilder();

    await middlewareEnricher.enrich(builder, fingerprints, ctx);

    expect(builder.build().edges.some(e => e.type === 'middleware')).toBe(false);
  });
});

describe('dataAccessEnricher', () => {
  it('builds reads_from and writes_to edges to resource nodes', async () => {
    const fingerprints = { 'src/repo.ts': fp({ filePath: 'src/repo.ts' }) };
    const ctx: EnrichContext = {
      enabledLayers: B,
      sources: {
        'src/repo.ts': `fs.readFile('a');\nfs.writeFile('b', data);\nconst pool = x; pool.query('SELECT 1');\n`,
      },
    };
    const builder = new KnowledgeGraphBuilder();

    await dataAccessEnricher.enrich(builder, fingerprints, ctx);
    const g = builder.build();

    expect(g.nodes.find(n => n.id === 'resource:filesystem')?.type).toBe('resource');
    expect(g.nodes.find(n => n.id === 'resource:database')?.type).toBe('resource');
    expect(hasEdge(g.edges, 'file:src/repo.ts', 'reads_from', 'resource:filesystem')).toBe(true);
    expect(hasEdge(g.edges, 'file:src/repo.ts', 'writes_to', 'resource:filesystem')).toBe(true);
    expect(hasEdge(g.edges, 'file:src/repo.ts', 'reads_from', 'resource:database')).toBe(true);
  });
});

describe('schemaTablesEnricher', () => {
  it('extracts Prisma models as table nodes with defines_schema edges', async () => {
    const ctx: EnrichContext = {
      enabledLayers: B,
      sources: {
        'prisma/schema.prisma': `model User {\n  id Int @id\n}\nmodel Post {\n  id Int @id\n}\n`,
      },
    };
    const builder = new KnowledgeGraphBuilder();

    await schemaTablesEnricher.enrich(builder, {}, ctx);
    const g = builder.build();

    expect(g.nodes.find(n => n.id === 'table:prisma/schema.prisma:User')?.type).toBe('table');
    expect(g.nodes.some(n => n.id === 'table:prisma/schema.prisma:Post')).toBe(true);
    expect(hasEdge(g.edges, 'schema:prisma/schema.prisma', 'defines_schema', 'table:prisma/schema.prisma:User')).toBe(true);
  });

  it('extracts CREATE TABLE statements from SQL files', async () => {
    const ctx: EnrichContext = {
      enabledLayers: B,
      sources: { 'db/init.sql': `CREATE TABLE IF NOT EXISTS orders (id INT);\ncreate table users (id int);\n` },
    };
    const builder = new KnowledgeGraphBuilder();

    await schemaTablesEnricher.enrich(builder, {}, ctx);
    const g = builder.build();

    expect(g.nodes.some(n => n.id === 'table:db/init.sql:orders')).toBe(true);
    expect(g.nodes.some(n => n.id === 'table:db/init.sql:users')).toBe(true);
    expect(hasEdge(g.edges, 'schema:db/init.sql', 'defines_schema', 'table:db/init.sql:orders')).toBe(true);
  });
});

describe('B_LAYER_ENRICHERS registry', () => {
  it('contains the five B-layer enrichers, all tagged layer B', () => {
    const names = B_LAYER_ENRICHERS.map(e => e.name).sort();
    expect(names).toEqual(['data_access', 'events', 'middleware', 'routes', 'schema_tables']);
    expect(B_LAYER_ENRICHERS.every(e => e.layer === 'B')).toBe(true);
  });

  it('B enrichers are skipped when layer B is not enabled', async () => {
    const builder = new KnowledgeGraphBuilder();
    await runEnrichers(
      builder,
      { 'src/api.ts': fp({ filePath: 'src/api.ts' }) },
      { enabledLayers: ['A'], sources: { 'src/api.ts': `app.get('/x', h);` } },
      B_LAYER_ENRICHERS
    );
    expect(builder.build().nodes.some(n => n.type === 'endpoint')).toBe(false);
  });
});
