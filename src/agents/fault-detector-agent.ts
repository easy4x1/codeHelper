import { BaseAgent } from './base-agent.js';
import { MemoryMiddleware } from '../core/memory.js';
import type { AgentInput, Finding, GraphNode } from '../core/types.js';

export class FaultDetectorAgent extends BaseAgent {
  constructor(private memory: MemoryMiddleware) {
    super('fault-detector');
  }

  protected async execute(input: AgentInput): Promise<Record<string, unknown>> {
    const targetFiles = input.context.targetFiles as string[] || [];
    const graph = this.memory.getKnowledgeGraph();
    const findings: Finding[] = [];

    for (const node of graph.nodes) {
      if (targetFiles.length > 0 && node.filePath && !targetFiles.includes(node.filePath)) {
        continue;
      }

      const nodeFindings = this.analyzeNode(node);
      findings.push(...nodeFindings);
    }

    for (const finding of findings) {
      this.memory.addFinding(finding);
    }

    return {
      findingsCount: findings.length,
      findings,
    };
  }

  private analyzeNode(node: GraphNode): Finding[] {
    const findings: Finding[] = [];

    // Heuristic: functions without exports in non-test files might be dead code
    if (node.type === 'function' && !node.filePath?.includes('.test.')) {
      const graph = this.memory.getKnowledgeGraph();
      const hasCallers = graph.edges.some(e => e.target === node.id && e.type === 'calls');
      if (!hasCallers && node.metadata?.isExported === false) {
        findings.push({
          id: `finding-${node.id}-deadcode`,
          type: 'insight',
          description: `Potentially dead code: ${node.name}`,
          confidence: 0.5,
          nodeIds: [node.id],
        });
      }
    }

    return findings;
  }
}
