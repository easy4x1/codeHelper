import { describe, it, expect, beforeEach } from 'vitest';
import { MetricsCollector } from '../src/core/metrics.js';
import { setGlobalMetricsCollector } from '../src/core/metrics.js';

describe('MetricsCollector', () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    collector = new MetricsCollector();
    setGlobalMetricsCollector(collector);
  });

  it('records agent execution', () => {
    collector.recordAgentExecution('repo-scanner', 100, true);
    collector.recordAgentExecution('repo-scanner', 200, true);
    collector.recordAgentExecution('fault-detector', 50, false);

    const scanner = collector.getAgentMetrics('repo-scanner');
    expect(scanner?.callCount).toBe(2);
    expect(scanner?.successCount).toBe(2);
    expect(scanner?.totalDurationMs).toBe(300);

    const detector = collector.getAgentMetrics('fault-detector');
    expect(detector?.callCount).toBe(1);
    expect(detector?.failureCount).toBe(1);
  });

  it('records cache query with hit', () => {
    collector.recordCacheQuery(0.75, true);
    collector.recordCacheQuery(0.3, false);

    expect(collector.getCacheHitRate()).toBe(0.5);

    const dist = collector.getCacheSimilarityDistribution();
    expect(dist.min).toBe(0.3);
    expect(dist.max).toBe(0.75);
    expect(dist.avg).toBe(0.525);
  });

  it('records token usage', () => {
    collector.recordTokenUsage('analysis', 1000);
    collector.recordTokenUsage('planning', 500);

    expect(collector.getTotalTokensUsed()).toBe(1500);
  });

  it('records task completion', () => {
    collector.recordTask('plan', true, 1000, 2000);
    collector.recordTask('fix', false, 500, 1000);
    collector.recordTask('plan', true, 800, 1500);

    expect(collector.getTaskSuccessRate('plan')).toBe(1);
    expect(collector.getTaskSuccessRate('fix')).toBe(0);
    expect(collector.getTaskSuccessRate()).toBe(2 / 3);
  });

  it('records parser usage', () => {
    collector.recordParserUsage('.ts', true);
    collector.recordParserUsage('.ts', true);
    collector.recordParserUsage('.go', false);

    expect(collector.getTreeSitterCoverage()).toBe(2 / 3);
  });

  it('records graph size', () => {
    collector.recordGraphSize(100, 250, 20);
    const snapshot = collector.getSnapshot();
    expect(snapshot.graph.nodeCount).toBe(100);
    expect(snapshot.graph.edgeCount).toBe(250);
    expect(snapshot.graph.fileCount).toBe(20);
  });

  it('records incremental savings', () => {
    collector.recordIncrementalSavings(50, 10, 25000);
    const snapshot = collector.getSnapshot();
    expect(snapshot.incrementalSavings.filesSkipped).toBe(50);
    expect(snapshot.incrementalSavings.estimatedTokensSaved).toBe(25000);
  });

  it('returns deep copy snapshot', () => {
    collector.recordTokenUsage('analysis', 100);
    const snapshot1 = collector.getSnapshot();
    snapshot1.tokens.analysis = 999;
    const snapshot2 = collector.getSnapshot();
    expect(snapshot2.tokens.analysis).toBe(100);
  });

  it('handles empty metrics gracefully', () => {
    expect(collector.getCacheHitRate()).toBe(0);
    expect(collector.getTaskSuccessRate()).toBe(0);
    expect(collector.getTreeSitterCoverage()).toBe(0);
    expect(collector.getTotalTokensUsed()).toBe(0);

    const dist = collector.getCacheSimilarityDistribution();
    expect(dist.avg).toBe(0);
  });
});
