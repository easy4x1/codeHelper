import { BaseAgent } from './base-agent.js';
import { MemoryMiddleware } from '../core/memory.js';
import { TemplateLlmService, type LlmService } from '../core/llm-service.js';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { faultDetectorContextSchema, parseContext, type AgentInput, type Finding, type GraphNode } from '../core/types.js';
import { ResultCache } from '../core/result-cache.js';
import { ContextCompressor } from '../core/context-compressor.js';

export class FaultDetectorAgent extends BaseAgent {
  private llmService: LlmService;
  private resultCache = new ResultCache();
  private contextCompressor = new ContextCompressor();

  constructor(
    private memory: MemoryMiddleware,
    llmService?: LlmService,
    resultCache?: ResultCache
  ) {
    super('fault-detector');
    this.llmService = llmService ?? new TemplateLlmService();
    if (resultCache) {
      this.resultCache = resultCache;
    }
  }

  protected async execute(input: AgentInput): Promise<Record<string, unknown>> {
    const { targetFiles, repoPath } = parseContext(input.context, faultDetectorContextSchema);
    const graph = this.memory.getKnowledgeGraph();
    const findings: Finding[] = [];

    // Phase 1: Heuristic analysis (existing behavior)
    for (const node of graph.nodes) {
      if (targetFiles.length > 0 && node.filePath && !targetFiles.includes(node.filePath)) {
        continue;
      }

      const nodeFindings = this.analyzeNode(node);
      findings.push(...nodeFindings);
    }

    // Phase 2: LLM-powered semantic analysis
    const filesToAnalyze = targetFiles.length > 0
      ? targetFiles
      : [...new Set(graph.nodes.filter(n => n.filePath).map(n => n.filePath!))];

    // Parallel analysis of multiple files (Phase 3: Batch Parallel)
    const fileAnalysisResults = await Promise.all(
      filesToAnalyze.map(filePath => this.analyzeFileWithLlm(filePath, repoPath))
    );
    for (const fileFindings of fileAnalysisResults) {
      findings.push(...fileFindings);
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

  private async analyzeFileWithLlm(filePath: string, repoPath: string): Promise<Finding[]> {
    // Check result cache first (Phase 3: Result Cache) — skip I/O if unchanged
    const fp = this.memory.getFingerprint(filePath);
    if (fp) {
      const cached = this.resultCache.get(filePath, fp.contentHash);
      if (cached !== undefined) {
        return cached;
      }
    }

    try {
      const absolutePath = resolve(repoPath, filePath);
      const content = await readFile(absolutePath, 'utf-8');

      // Compress context for large files (Phase 3: Context Compression)
      const codeForLlm = this.contextCompressor.compress(filePath, content, fp);

      // Gather related code context (imported files)
      const relatedCode: { filePath: string; snippet: string }[] = [];
      if (fp) {
        for (const imp of fp.imports) {
          if (imp.source.startsWith('.')) {
            const relatedPath = imp.source.replace(/\.js$/, '.ts');
            try {
              const relatedContent = await readFile(resolve(repoPath, relatedPath), 'utf-8');
              const relatedFp = this.memory.getFingerprint(relatedPath);
              relatedCode.push({
                filePath: relatedPath,
                snippet: relatedFp
                  ? this.contextCompressor.compress(relatedPath, relatedContent, relatedFp)
                  : relatedContent.slice(0, 500),
              });
            } catch {
              // Related file may not exist or be readable
            }
          }
        }
      }

      const result = await this.llmService.analyzeFault({
        filePath,
        code: codeForLlm,
        nodeType: 'file',
        nodeName: filePath.split('/').pop() || filePath,
        relatedCode,
      });

      const findings: Finding[] = result.findings.map((f, idx) => ({
        id: `finding-${filePath}-llm-${idx}`,
        type: f.type === 'security' ? 'fault' : f.type === 'bug' ? 'fault' : 'insight',
        description: f.description,
        confidence: f.confidence,
        nodeIds: [filePath],
      }));

      // Cache findings for unchanged files (Phase 3: Result Cache)
      if (fp) {
        this.resultCache.set(filePath, fp.contentHash, findings);
      }

      return findings;
    } catch {
      // File may not exist or be readable
      return [];
    }
  }
}
