import { BaseAgent } from './base-agent.js';
import { MemoryMiddleware } from '../core/memory.js';
import { KnowledgeGraphBuilder } from '../core/knowledge-graph.js';
import { recordPatterns } from '../core/graph-writer.js';
import { PatternExtractor } from '../core/pattern-extractor.js';
import { ConventionLearner } from '../core/convention-learner.js';
import { RecommendationEngine } from '../core/recommendation-engine.js';
import type { AgentInput, Finding, SolutionPlan, FileFingerprint } from '../core/types.js';

/**
 * Learning Agent — orchestrates pattern extraction, convention learning, and recommendation.
 *
 * Triggered after task completion or via `code-agent learn` CLI command.
 */
export class LearningAgent extends BaseAgent {
  private patternExtractor = new PatternExtractor();
  private conventionLearner = new ConventionLearner();
  private recommendationEngine = new RecommendationEngine();

  constructor(private memory: MemoryMiddleware) {
    super('learning');
  }

  protected async execute(input: AgentInput): Promise<Record<string, unknown>> {
    const { repoPath } = input.context as { repoPath?: string };

    // Phase 1: Learn conventions from current codebase
    const fingerprints = this.memory.getAllFingerprints();
    const fingerprintArray = Object.values(fingerprints);

    const namingConventions = this.conventionLearner.learnNamingConventions(fingerprintArray);
    const testingConventions = this.conventionLearner.learnTestingConventions(fingerprintArray);
    const architectureConventions = this.conventionLearner.learnArchitectureConventions(fingerprintArray);

    for (const c of [...namingConventions, ...testingConventions, ...architectureConventions]) {
      this.memory.addConvention(c);
    }

    this.logger.info(`Learned ${namingConventions.length + testingConventions.length + architectureConventions.length} convention(s)`);

    // Phase 2: Extract patterns from unprocessed task history (if any)
    // Note: patterns are typically extracted immediately after task completion
    // via recordTaskCompletion(). This step handles any backlog.

    return {
      conventionsLearned: namingConventions.length + testingConventions.length + architectureConventions.length,
      patternsExtracted: 0,
    };
  }

  /**
   * Record a completed task and extract patterns immediately.
   */
  recordTaskCompletion(
    taskId: string,
    description: string,
    filesAnalyzed: string[],
    findingsCount: number,
    success: boolean,
    findings?: Finding[],
    plan?: SolutionPlan
  ): void {
    // Record task
    this.memory.recordTask({
      taskId,
      description,
      timestamp: new Date().toISOString(),
      filesAnalyzed,
      findingsCount,
      success,
    });

    // Extract patterns
    if (findings && findings.length > 0) {
      const faultPatterns = this.patternExtractor.extractFaultPatterns(findings);
      for (const p of faultPatterns) {
        this.memory.addFaultPattern(p);
      }
      this.logger.info(`Extracted ${faultPatterns.length} fault pattern(s)`);
    }

    if (plan) {
      const fixPatterns = this.patternExtractor.extractFixPatterns(plan);
      for (const p of fixPatterns) {
        this.memory.addFixPattern(p);
      }
      this.logger.info(`Extracted ${fixPatterns.length} fix pattern(s)`);
    }

    // Write patterns into the knowledge graph.
    const graphBuilder = KnowledgeGraphBuilder.fromGraph(this.memory.getKnowledgeGraph());
    const sourceNodeIds = [
      ...(findings?.flatMap(f => f.nodeIds) ?? []),
      ...(plan?.changes.map(c => `file:${c.filePath}`) ?? []),
    ].filter((v, i, a) => a.indexOf(v) === i);
    const faultPatterns = findings && findings.length > 0
      ? this.patternExtractor.extractFaultPatterns(findings)
      : [];
    const fixPatterns = plan
      ? this.patternExtractor.extractFixPatterns(plan)
      : [];
    recordPatterns(graphBuilder, faultPatterns, fixPatterns, sourceNodeIds);
    this.memory.setKnowledgeGraph(graphBuilder.build());
  }

  /**
   * Get recommendations for a new problem.
   */
  recommend(problemDescription: string): ReturnType<RecommendationEngine['recommend']> {
    const learned = this.memory.getLearnedMemory();
    return this.recommendationEngine.recommend(
      problemDescription,
      learned.faultPatterns,
      learned.fixPatterns,
      learned.projectConventions
    );
  }
}
