import { createLogger } from '../utils/logger.js';
import { maskApiKey, type LlmProviderConfig } from './llm-config.js';

const logger = createLogger('llm-service');

/**
 * Abstract LLM service interface.
 * In production, this is backed by Anthropic/Claude API.
 * In MVP/testing, uses template-based simulation.
 */
export interface LlmService {
  analyzeFault(params: FaultAnalysisParams): Promise<FaultAnalysisResult>;
  generateSolution(params: SolutionParams): Promise<SolutionResult>;
  generatePatch(params: PatchParams): Promise<PatchLlmResult>;
}

export interface FaultAnalysisParams {
  filePath: string;
  code: string;
  nodeType: string;
  nodeName: string;
  relatedCode: { filePath: string; snippet: string }[];
}

export interface FaultAnalysisResult {
  findings: Array<{
    type: 'bug' | 'performance' | 'security' | 'style';
    description: string;
    confidence: number;
    lineHint?: number;
  }>;
  rootCause?: string;
}

export interface SolutionParams {
  problem: string;
  findings: Array<{
    description: string;
    confidence: number;
    filePath?: string;
    type?: 'bug' | 'performance' | 'security' | 'style';
  }>;
  codeContext: Array<{
    filePath: string;
    code: string;
  }>;
}

export interface SolutionResult {
  rootCause: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  changes: Array<{
    filePath: string;
    description: string;
    reasoning: string;
    originalCode?: string;
    modifiedCode?: string;
  }>;
  confidence: number;
}

export interface PatchParams {
  filePath: string;
  description: string;
  reasoning: string;
  originalCode?: string;
  modifiedCode?: string;
}

export interface PatchLlmResult {
  originalCode: string;
  modifiedCode: string;
  changeType: 'modify' | 'add' | 'delete';
}

/**
 * Template-based LLM simulation for MVP phase.
 * Provides deterministic, testable fault analysis and solution generation
 * without requiring actual LLM API calls.
 */
export class TemplateLlmService implements LlmService {
  async analyzeFault(params: FaultAnalysisParams): Promise<FaultAnalysisResult> {
    logger.info(`Analyzing fault in ${params.filePath}:${params.nodeName}`);

    const findings: FaultAnalysisResult['findings'] = [];
    const code = params.code;
    const lines = code.split('\n');

    // Pattern 1: Null/undefined checks
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Detect potential null dereference: variable.property without check
      const nullDerefPattern = /(\w+)\.(\w+)\(/g;
      let match;
      while ((match = nullDerefPattern.exec(line)) !== null) {
        const varName = match[1];
        // Check if there's no preceding null check for this variable
        const hasNullCheck = lines.slice(0, i + 1).some(l =>
          l.includes(`${varName} === null`) ||
          l.includes(`${varName} === undefined`) ||
          l.includes(`${varName}?.`) ||
          l.includes(`if (${varName})`)
        );
        if (!hasNullCheck && !['console', 'process', 'Math', 'JSON'].includes(varName)) {
          findings.push({
            type: 'bug',
            description: `Potential null/undefined dereference: ${varName} may be null before accessing ${match[2]}()`,
            confidence: 0.6,
            lineHint: i + 1,
          });
        }
      }
    }

    // Pattern 2: Unused variables
    const varDeclPattern = /(?:const|let|var)\s+(\w+)\s*=/g;
    let match;
    while ((match = varDeclPattern.exec(code)) !== null) {
      const varName = match[1];
      const usageCount = (code.match(new RegExp(`\\b${varName}\\b`, 'g')) || []).length;
      if (usageCount <= 1) {
        findings.push({
          type: 'style',
          description: `Unused variable: ${varName}`,
          confidence: 0.8,
          lineHint: code.substring(0, match.index).split('\n').length,
        });
      }
    }

    // Pattern 3: Console.log in production code
    if (code.includes('console.log(') || code.includes('console.error(')) {
      findings.push({
        type: 'style',
        description: 'Console logging detected — should use structured logger',
        confidence: 0.5,
      });
    }

    // Pattern 4: TODO/FIXME comments
    const todoPattern = /\/\/\s*(TODO|FIXME|HACK|XXX)/gi;
    let todoMatch;
    while ((todoMatch = todoPattern.exec(code)) !== null) {
      findings.push({
        type: 'bug',
        description: `Outstanding ${todoMatch[1]} comment indicates incomplete implementation`,
        confidence: 0.7,
        lineHint: code.substring(0, todoMatch.index).split('\n').length,
      });
    }

    // Pattern 5: Any-type usage
    if (code.includes(': any') || code.includes('as any')) {
      findings.push({
        type: 'style',
        description: 'Unsafe "any" type usage detected',
        confidence: 0.6,
      });
    }

    // Pattern 6: Error handling gaps (catch with empty body)
    if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(code) || /catch\s*\([^)]*\)\s*\{\s*\/\/\s*noop\s*\}/.test(code)) {
      findings.push({
        type: 'bug',
        description: 'Empty catch block swallows errors silently',
        confidence: 0.85,
      });
    }

    return {
      findings,
      rootCause: findings.length > 0
        ? `${findings.length} issue(s) found in ${params.nodeName}: ${findings.map(f => f.description).join('; ')}`
        : undefined,
    };
  }

  async generateSolution(params: SolutionParams): Promise<SolutionResult> {
    logger.info(`Generating solution for: ${params.problem}`);

    const changes: SolutionResult['changes'] = [];

    for (const ctx of params.codeContext) {
      const code = ctx.code;
      const lines = code.split('\n');

      // Generate fix proposals based on findings
      for (const finding of params.findings) {
        const desc = finding.description.toLowerCase();

        if (desc.includes('null') || desc.includes('undefined')) {
          // Suggest optional chaining or null check
          const originalCode = code;
          const modifiedCode = this.suggestNullSafety(code);
          if (modifiedCode !== originalCode) {
            changes.push({
              filePath: ctx.filePath,
              description: `Add null-safety checks in ${ctx.filePath}`,
              reasoning: finding.description,
              originalCode,
              modifiedCode,
            });
          }
        }

        if (desc.includes('unused variable')) {
          const match = finding.description.match(/unused variable:\s*(\w+)/i);
          if (match) {
            const varName = match[1];
            const lineIdx = lines.findIndex(l => l.includes(`${varName} =`));
            if (lineIdx >= 0) {
              const originalCode = lines[lineIdx].trim();
              changes.push({
                filePath: ctx.filePath,
                description: `Remove unused variable ${varName}`,
                reasoning: finding.description,
                originalCode,
                modifiedCode: `// Removed: ${originalCode}`,
              });
            }
          }
        }

        if (desc.includes('console.log')) {
          const originalCode = code;
          const modifiedCode = code.replace(/console\.(log|error)\(/g, 'logger.info(');
          if (modifiedCode !== originalCode) {
            changes.push({
              filePath: ctx.filePath,
              description: `Replace console logging with structured logger`,
              reasoning: finding.description,
              originalCode,
              modifiedCode,
            });
          }
        }

        if (desc.includes('empty catch')) {
          const originalCode = code;
          const modifiedCode = code.replace(
            /catch\s*\(([^)]*)\)\s*\{\s*\}/g,
            `catch ($1) { /* TODO: handle error */ }`
          );
          if (modifiedCode !== originalCode) {
            changes.push({
              filePath: ctx.filePath,
              description: `Add error handling to catch block`,
              reasoning: finding.description,
              originalCode,
              modifiedCode,
            });
          }
        }
      }

      // If no specific fixes generated, provide a generic change entry
      if (changes.filter(c => c.filePath === ctx.filePath).length === 0) {
        changes.push({
          filePath: ctx.filePath,
          description: `Review and address: ${params.problem}`,
          reasoning: params.findings.map(f => f.description).join('; ') || 'General code review needed',
        });
      }
    }

    // Determine severity from findings
    const hasCritical = params.findings.some(f => f.type === 'security');
    const hasBug = params.findings.some(f => f.type === 'bug');
    const severity: SolutionResult['severity'] = hasCritical ? 'critical' : hasBug ? 'high' : 'medium';

    return {
      rootCause: params.findings.length > 0
        ? params.findings.map(f => f.description).join('; ')
        : 'No specific root cause identified — manual review recommended',
      severity,
      changes,
      confidence: Math.min(0.3 + params.findings.length * 0.15, 0.9),
    };
  }

  async generatePatch(params: PatchParams): Promise<PatchLlmResult> {
    logger.info(`Generating patch for ${params.filePath}`);

    const { originalCode, modifiedCode } = params;

    // If both original and modified are provided, return as-is
    if (originalCode !== undefined && modifiedCode !== undefined) {
      const changeType: PatchLlmResult['changeType'] =
        originalCode === '' ? 'add' :
        modifiedCode === '' ? 'delete' :
        'modify';
      return { originalCode, modifiedCode, changeType };
    }

    // If only original is provided, try to infer the fix
    if (originalCode !== undefined && modifiedCode === undefined) {
      const inferred = this.inferPatch(originalCode, params.description);
      return {
        originalCode,
        modifiedCode: inferred,
        changeType: inferred === '' ? 'delete' : 'modify',
      };
    }

    // If no original, generate new code
    if (originalCode === undefined) {
      const generated = this.generateNewCode(params.description, params.reasoning);
      return {
        originalCode: '',
        modifiedCode: generated,
        changeType: 'add',
      };
    }

    // Fallback
    return {
      originalCode: originalCode || '',
      modifiedCode: modifiedCode || '',
      changeType: 'modify',
    };
  }

  private inferPatch(originalCode: string, description: string): string {
    const desc = description.toLowerCase();
    let modified = originalCode;

    // Null safety inference
    if (desc.includes('null') || desc.includes('undefined')) {
      modified = modified.replace(/(\w+)\.(\w+)\(/g, (match, obj, method) => {
        if (['console', 'process', 'Math', 'JSON'].includes(obj)) return match;
        return `${obj}?.${method}(`;
      });
    }

    // Logger replacement inference
    if (desc.includes('console') || desc.includes('log')) {
      modified = modified.replace(/console\.(log|error|warn)\(/g, 'logger.info(');
    }

    // Type safety inference
    if (desc.includes('any') || desc.includes('type')) {
      modified = modified.replace(/:\s*any\b/g, ': unknown');
      modified = modified.replace(/\bas any\b/g, 'as unknown');
    }

    return modified;
  }

  private generateNewCode(description: string, _reasoning: string): string {
    const desc = description.toLowerCase();

    if (desc.includes('utility') || desc.includes('helper')) {
      return `// TODO: Implement ${description}\nexport function newUtility() {\n  throw new Error('Not implemented');\n}`;
    }

    if (desc.includes('error handling') || desc.includes('catch')) {
      return `try {\n  // TODO: Add operation\n} catch (error) {\n  logger.error('Operation failed:', error);\n  throw error;\n}`;
    }

    return `// TODO: ${description}\n`;
  }

  private suggestNullSafety(code: string): string {
    // Simple transformation: a.b() -> a?.b()
    return code.replace(/(\w+)\.(\w+)\(/g, (match, obj, method) => {
      if (['console', 'process', 'Math', 'JSON'].includes(obj)) return match;
      return `${obj}?.${method}(`;
    });
  }
}

// Anthropic SDK — lazy-loaded to avoid startup cost when not used
let AnthropicSdk: typeof import('@anthropic-ai/sdk').default | undefined;

async function loadAnthropic(): Promise<typeof import('@anthropic-ai/sdk').default> {
  if (!AnthropicSdk) {
    const mod = await import('@anthropic-ai/sdk');
    AnthropicSdk = mod.default;
  }
  return AnthropicSdk;
}

/**
 * Production LLM service using Anthropic/Claude API.
 *
 * Falls back to TemplateLlmService if:
 * - ANTHROPIC_API_KEY is not set
 * - API call fails (network error, rate limit, etc.)
 */
export class AnthropicLlmService implements LlmService {
  private client: InstanceType<typeof import('@anthropic-ai/sdk').default> | undefined;
  private fallback = new TemplateLlmService();
  private model = 'claude-sonnet-4-6-20251001';
  private baseUrl?: string;

  constructor(config?: LlmProviderConfig) {
    const apiKey = config?.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      logger.warn('ANTHROPIC_API_KEY not set — AnthropicLlmService will use TemplateLlmService fallback');
      return;
    }

    // Model priority: config > ANTHROPIC_MODEL env > ANTHROPIC_DEFAULT_* env > default
    this.model =
      config?.model ??
      process.env.ANTHROPIC_MODEL ??
      process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ??
      'claude-sonnet-4-6-20251001';

    // Base URL: config > ANTHROPIC_BASE_URL env > undefined (SDK default)
    this.baseUrl = config?.baseUrl ?? process.env.ANTHROPIC_BASE_URL;

    logger.info(
      `Initializing Anthropic client (model: ${this.model}, baseUrl: ${this.baseUrl ?? 'default'}, key: ${maskApiKey(apiKey)})`
    );
    this.initClient(apiKey).catch(err => {
      logger.error('Failed to initialize Anthropic client:', err);
    });
  }

  private async initClient(apiKey: string): Promise<void> {
    const Anthropic = await loadAnthropic();
    const options: { apiKey: string; baseURL?: string } = { apiKey };
    if (this.baseUrl) {
      options.baseURL = this.baseUrl;
    }
    this.client = new Anthropic(options);
  }

  async analyzeFault(params: FaultAnalysisParams): Promise<FaultAnalysisResult> {
    if (!this.client) {
      logger.info('Anthropic client not available — using template fallback for analyzeFault');
      return this.fallback.analyzeFault(params);
    }

    try {
      const relatedCodeContext = params.relatedCode
        .map(r => `--- ${r.filePath} ---\n${r.snippet}`)
        .join('\n\n');

      const prompt = `You are a code review expert. Analyze the following code file for potential issues (bugs, performance problems, security issues, code style issues).

File path: ${params.filePath}
Code:
\`\`\`
${params.code}
\`\`\`

${relatedCodeContext ? `Related code context:\n${relatedCodeContext}\n\n` : ''}
Respond ONLY with a JSON object in this exact format (no markdown, no explanation):
{
  "findings": [
    {
      "type": "bug" | "performance" | "security" | "style",
      "description": "concise issue description",
      "confidence": 0.0 to 1.0,
      "lineHint": optional_line_number
    }
  ],
  "rootCause": "one-sentence root cause summary"
}`;

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      });

      const content = response.content[0];
      if (content.type !== 'text') {
        throw new Error('Unexpected response type from Claude');
      }

      const parsed = JSON.parse(content.text) as FaultAnalysisResult;
      logger.info(`Claude found ${parsed.findings.length} issue(s) in ${params.filePath}`);
      return parsed;
    } catch (err) {
      logger.error('Claude analyzeFault failed, using fallback:', err);
      return this.fallback.analyzeFault(params);
    }
  }

  async generateSolution(params: SolutionParams): Promise<SolutionResult> {
    if (!this.client) {
      logger.info('Anthropic client not available — using template fallback for generateSolution');
      return this.fallback.generateSolution(params);
    }

    try {
      const findingsText = params.findings
        .map((f, i) => `${i + 1}. [${f.type || 'unknown'}] ${f.description} (confidence: ${f.confidence})`)
        .join('\n');

      const codeContextText = params.codeContext
        .map(c => `--- ${c.filePath} ---\n${c.code}`)
        .join('\n\n');

      const prompt = `You are a code repair expert. Based on the following problem and code context, generate a concrete fix plan.

Problem description: ${params.problem}

Findings:
${findingsText}

Code context:
${codeContextText}

Respond ONLY with a JSON object in this exact format (no markdown, no explanation):
{
  "rootCause": "one-sentence root cause",
  "severity": "low" | "medium" | "high" | "critical",
  "changes": [
    {
      "filePath": "relative/path/to/file",
      "description": "what this change does",
      "reasoning": "why this change fixes the issue",
      "originalCode": "the exact original code snippet to be replaced (keep it minimal)",
      "modifiedCode": "the replacement code snippet"
    }
  ],
  "confidence": 0.0 to 1.0
}`;

      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-6-20251001',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      });

      const content = response.content[0];
      if (content.type !== 'text') {
        throw new Error('Unexpected response type from Claude');
      }

      const parsed = JSON.parse(content.text) as SolutionResult;
      logger.info(`Claude generated ${parsed.changes.length} change(s)`);
      return parsed;
    } catch (err) {
      logger.error('Claude generateSolution failed, using fallback:', err);
      return this.fallback.generateSolution(params);
    }
  }

  async generatePatch(params: PatchParams): Promise<PatchLlmResult> {
    if (!this.client) {
      logger.info('Anthropic client not available — using template fallback for generatePatch');
      return this.fallback.generatePatch(params);
    }

    try {
      const prompt = `You are a code patching expert. Based on the description, generate the exact original and modified code.

File: ${params.filePath}
Description: ${params.description}
Reasoning: ${params.reasoning}
${params.originalCode ? `Original code:\n\`\`\`\n${params.originalCode}\n\`\`\`` : 'This is a new file.'}

Respond ONLY with a JSON object in this exact format (no markdown, no explanation):
{
  "originalCode": "the exact original code (empty string for new files)",
  "modifiedCode": "the exact replacement code",
  "changeType": "modify" | "add" | "delete"
}`;

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      });

      const content = response.content[0];
      if (content.type !== 'text') {
        throw new Error('Unexpected response type from Claude');
      }

      const parsed = JSON.parse(content.text) as PatchLlmResult;
      logger.info(`Claude generated patch for ${params.filePath} (${parsed.changeType})`);
      return parsed;
    } catch (err) {
      logger.error('Claude generatePatch failed, using fallback:', err);
      return this.fallback.generatePatch(params);
    }
  }
}

// ============================================
// Generic HTTP LLM Service (OpenAI-compatible APIs)
// Supports: OpenAI, Moonshot (Kimi), DeepSeek, Zhipu (GLM)
// ============================================

const PROVIDER_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  moonshot: 'https://api.moonshot.cn/v1',
  deepseek: 'https://api.deepseek.com/v1',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
};

/**
 * Generic HTTP-based LLM service for OpenAI-compatible providers.
 *
 * Falls back to TemplateLlmService when:
 * - API key is missing
 * - Network request fails
 * - Response cannot be parsed
 */
export class HttpLlmService implements LlmService {
  private fallback = new TemplateLlmService();
  private baseUrl: string;

  constructor(private config: LlmProviderConfig) {
    this.baseUrl = config.baseUrl ?? PROVIDER_BASE_URLS[config.provider] ?? '';
    logger.info(
      `Initializing ${config.provider} HTTP client (model: ${config.model}, key: ${maskApiKey(config.apiKey)})`
    );
  }

  async analyzeFault(params: FaultAnalysisParams): Promise<FaultAnalysisResult> {
    if (!this.config.apiKey || !this.baseUrl) {
      logger.info(`${this.config.provider} not configured — using template fallback`);
      return this.fallback.analyzeFault(params);
    }
    try {
      return await this.callApi('analyzeFault', params);
    } catch (err) {
      logger.error(`${this.config.provider} analyzeFault failed, using fallback:`, err);
      return this.fallback.analyzeFault(params);
    }
  }

  async generateSolution(params: SolutionParams): Promise<SolutionResult> {
    if (!this.config.apiKey || !this.baseUrl) {
      logger.info(`${this.config.provider} not configured — using template fallback`);
      return this.fallback.generateSolution(params);
    }
    try {
      return await this.callApi('generateSolution', params);
    } catch (err) {
      logger.error(`${this.config.provider} generateSolution failed, using fallback:`, err);
      return this.fallback.generateSolution(params);
    }
  }

  async generatePatch(params: PatchParams): Promise<PatchLlmResult> {
    if (!this.config.apiKey || !this.baseUrl) {
      logger.info(`${this.config.provider} not configured — using template fallback`);
      return this.fallback.generatePatch(params);
    }
    try {
      return await this.callApi('generatePatch', params);
    } catch (err) {
      logger.error(`${this.config.provider} generatePatch failed, using fallback:`, err);
      return this.fallback.generatePatch(params);
    }
  }

  private async callApi<R>(
    _method: string,
    _params: unknown
  ): Promise<R> {
    // MVP: placeholder — real implementation would call the provider's chat.completions API
    // and parse the JSON response. For now, fall through to fallback.
    throw new Error('HTTP LLM service not yet implemented for ' + this.config.provider);
  }
}

// ============================================
// Factory
// ============================================

/**
 * Create an LlmService instance from provider configuration.
 *
 * @param config Resolved provider config (or null for template fallback)
 */
export function createLlmService(config: LlmProviderConfig | null): LlmService {
  if (!config || config.provider === 'template') {
    return new TemplateLlmService();
  }
  if (config.provider === 'anthropic') {
    return new AnthropicLlmService(config);
  }
  return new HttpLlmService(config);
}
