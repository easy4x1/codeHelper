import { createHash } from '../utils/hash.js';
import { createRequire } from 'module';
import type {
  FileFingerprint,
  FunctionSignature,
  ClassSignature,
  ImportSignature,
  ExportSignature,
  ChangeLevel,
  ChangeAnalysis,
} from './types.js';
import { getGlobalMetricsCollector } from './metrics.js';

// ESM-compatible require for tree-sitter CJS modules
const require = createRequire(import.meta.url);

// ============================================
// Public API
// ============================================

export function computeFingerprint(filePath: string, content: string): FileFingerprint {
  // Try Tree-sitter for supported languages, fall back to regex for others
  const treeSitterResult = tryTreeSitter(filePath, content);
  const ext = filePath.slice(filePath.lastIndexOf('.'));

  if (treeSitterResult) {
    getGlobalMetricsCollector()?.recordParserUsage(ext, true);
    return {
      filePath,
      contentHash: createHash(content),
      functions: treeSitterResult.functions,
      classes: treeSitterResult.classes,
      imports: treeSitterResult.imports,
      exports: treeSitterResult.exports,
      totalLines: content.split('\n').length,
      hasStructuralAnalysis: true,
    };
  }

  // Fallback to regex-based extraction (for unsupported languages)
  getGlobalMetricsCollector()?.recordParserUsage(ext, false);
  const functions = extractFunctionsRegex(content);
  const classes = extractClassesRegex(content);
  const imports = extractImportsRegex(content);
  const exports = extractExportsRegex(content);

  return {
    filePath,
    contentHash: createHash(content),
    functions,
    classes,
    imports,
    exports,
    totalLines: content.split('\n').length,
    hasStructuralAnalysis: true,
  };
}

export function classifyChange(
  oldFp: FileFingerprint | null,
  newFp: FileFingerprint
): ChangeAnalysis {
  if (!oldFp) {
    return { filePath: newFp.filePath, changeLevel: 'STRUCTURAL', details: ['New file'] };
  }

  if (oldFp.contentHash === newFp.contentHash) {
    return { filePath: newFp.filePath, changeLevel: 'NONE', details: ['No changes'] };
  }

  const details: string[] = [];

  if (!signaturesEqual(oldFp.functions, newFp.functions)) {
    details.push('Function signatures changed');
  }
  if (!signaturesEqual(oldFp.classes, newFp.classes)) {
    details.push('Class signatures changed');
  }
  if (!signaturesEqual(oldFp.imports, newFp.imports)) {
    details.push('Import signatures changed');
  }
  if (!signaturesEqual(oldFp.exports, newFp.exports)) {
    details.push('Export signatures changed');
  }

  const changeLevel: ChangeLevel = details.length > 0 ? 'STRUCTURAL' : 'COSMETIC';

  return { filePath: newFp.filePath, changeLevel, details };
}

// ============================================
// Tree-sitter AST Extraction
// ============================================

interface TreeSitterResult {
  functions: FunctionSignature[];
  classes: ClassSignature[];
  imports: ImportSignature[];
  exports: ExportSignature[];
}

function tryTreeSitter(filePath: string, content: string): TreeSitterResult | null {
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  const supportedExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.java']);
  if (!supportedExts.has(ext)) {
    return null;
  }

  try {
    const Parser = require('tree-sitter');
    let language: unknown;

    if (ext === '.ts') {
      language = require('tree-sitter-typescript').typescript;
    } else if (ext === '.tsx') {
      language = require('tree-sitter-typescript').tsx;
    } else if (ext === '.js' || ext === '.jsx') {
      language = require('tree-sitter-typescript').typescript;
    } else if (ext === '.py') {
      language = require('tree-sitter-python');
    } else if (ext === '.go') {
      language = require('tree-sitter-go');
    } else if (ext === '.java') {
      language = require('tree-sitter-java');
    }

    if (!language) return null;

    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(content);

    if (ext === '.py') {
      return extractPython(tree.rootNode);
    }
    if (ext === '.go') {
      return extractGo(tree.rootNode);
    }
    if (ext === '.java') {
      return extractJava(tree.rootNode);
    }

    return extractTypeScript(tree.rootNode);
  } catch {
    // Tree-sitter parse failed — fall back to regex
    return null;
  }
}

// Helper: safely get text from a node field
function getFieldText(node: unknown, fieldName: string): string | undefined {
  // Tree-sitter nodes have childForFieldName method
  const n = node as { childForFieldName?: (name: string) => { text: string } | null };
  const child = n.childForFieldName?.(fieldName);
  return child?.text;
}

// Helper: get children array from a node
function getChildren(node: unknown): Array<unknown> {
  const n = node as { children?: Array<unknown> };
  return n.children ?? [];
}

// Helper: get node type
function getType(node: unknown): string {
  const n = node as { type?: string };
  return n.type ?? '';
}

// Helper: get start/end line (1-based)
function getStartLine(node: unknown): number {
  const n = node as { startPosition?: { row: number } };
  return (n.startPosition?.row ?? 0) + 1;
}

function getEndLine(node: unknown): number {
  const n = node as { endPosition?: { row: number } };
  return (n.endPosition?.row ?? 0) + 1;
}

// Helper: extract return type text (strip leading ": ")
function extractReturnType(node: unknown): string | undefined {
  const rt = getFieldText(node, 'return_type');
  if (rt) {
    return rt.replace(/^:\s*/, '');
  }
  return undefined;
}

// Helper: extract parameters from formal_parameters node
function extractParameters(paramsNode: unknown): string[] {
  const params: string[] = [];
  const children = getChildren(paramsNode);

  for (const child of children) {
    const type = getType(child);
    if (type === 'required_parameter' || type === 'optional_parameter') {
      const pattern = getFieldText(child, 'pattern');
      if (pattern) {
        params.push(pattern);
      }
    } else if (type === 'rest_pattern') {
      const pattern = getFieldText(child, 'pattern');
      if (pattern) {
        params.push('...' + pattern);
      }
    }
  }

  return params;
}

function extractTypeScript(rootNode: unknown): TreeSitterResult {
  const functions: FunctionSignature[] = [];
  const classes: ClassSignature[] = [];
  const imports: ImportSignature[] = [];
  const exports: ExportSignature[] = [];

  // Visit all top-level nodes
  for (const node of getChildren(rootNode)) {
    visitTypeScriptNode(node, false);
  }

  function visitTypeScriptNode(node: unknown, isExported: boolean): void {
    const type = getType(node);

    switch (type) {
      case 'export_statement': {
        const declaration = (node as { childForFieldName?: (name: string) => unknown | null }).childForFieldName?.('declaration');
        if (declaration) {
          visitTypeScriptNode(declaration, true);
        }
        // Also handle: export { a, b } from './module'
        const source = getFieldText(node, 'source');
        if (source) {
          // Re-export: export { foo } from './bar'
          const exportClause = (node as { childForFieldName?: (name: string) => unknown | null }).childForFieldName?.('export_clause');
          if (exportClause) {
            for (const spec of getChildren(exportClause)) {
              if (getType(spec) === 'export_specifier') {
                const name = getFieldText(spec, 'name');
                if (name) {
                  exports.push({ name, type: 'default', line: getStartLine(node) });
                }
              }
            }
          }
        }
        break;
      }

      case 'function_declaration': {
        const name = getFieldText(node, 'name');
        if (name) {
          const params = extractParameters(getFieldNode(node, 'parameters'));
          functions.push({
            name,
            params,
            returnType: extractReturnType(node),
            isExported,
            startLine: getStartLine(node),
            endLine: getEndLine(node),
          });
        }
        break;
      }

      case 'class_declaration': {
        const name = getFieldText(node, 'name');
        if (name) {
          const body = (node as { childForFieldName?: (name: string) => unknown | null }).childForFieldName?.('body');
          const methods: string[] = [];
          const properties: string[] = [];

          if (body) {
            for (const member of getChildren(body)) {
              const memberType = getType(member);
              if (memberType === 'method_definition') {
                const methodName = getFieldText(member, 'name');
                if (methodName) methods.push(methodName);
              } else if (memberType === 'public_field_definition') {
                const propName = getFieldText(member, 'name');
                if (propName) properties.push(propName);
              }
            }
          }

          classes.push({
            name,
            methods,
            properties,
            isExported,
            startLine: getStartLine(node),
            endLine: getEndLine(node),
          });
        }
        break;
      }

      case 'import_statement': {
        const source = getFieldText(node, 'source');
        if (source) {
          const importClause = (node as { childForFieldName?: (name: string) => unknown | null }).childForFieldName?.('import_clause');
          if (importClause) {
            // Named imports: import { foo, bar } from './module'
            for (const child of getChildren(importClause)) {
              if (getType(child) === 'named_imports') {
                const items: string[] = [];
                for (const spec of getChildren(child)) {
                  if (getType(spec) === 'import_specifier') {
                    const name = getFieldText(spec, 'name');
                    if (name) items.push(name);
                  }
                }
                imports.push({
                  source: stripQuotes(source),
                  items,
                  isDefault: false,
                  line: getStartLine(node),
                });
              }
              // Default import: import foo from './module'
              if (getType(child) === 'identifier') {
                imports.push({
                  source: stripQuotes(source),
                  items: [child as string],
                  isDefault: true,
                  line: getStartLine(node),
                });
              }
              // Namespace import: import * as foo from './module'
              if (getType(child) === 'namespace_import') {
                const name = getFieldText(child, 'name');
                if (name) {
                  imports.push({
                    source: stripQuotes(source),
                    items: ['* as ' + name],
                    isDefault: false,
                    line: getStartLine(node),
                  });
                }
              }
            }
          } else {
            // Side-effect import: import './module'
            imports.push({
              source: stripQuotes(source),
              items: [],
              isDefault: false,
              line: getStartLine(node),
            });
          }
        }
        break;
      }

      case 'lexical_declaration':
      case 'variable_declaration': {
        for (const declarator of getChildren(node)) {
          if (getType(declarator) === 'variable_declarator') {
            const varName = getFieldText(declarator, 'name');
            const value = (declarator as { childForFieldName?: (name: string) => unknown | null }).childForFieldName?.('value');
            if (varName && value && getType(value) === 'arrow_function') {
              const params = extractParameters(getFieldNode(value, 'parameters'));
              functions.push({
                name: varName,
                params,
                returnType: extractReturnType(value),
                isExported,
                startLine: getStartLine(declarator),
                endLine: getEndLine(value),
              });
            }
          }
        }
        break;
      }
    }
  }

  // Collect exports (non-export_statement exports are handled above via isExported flag)
  // But we also need to record explicit exports for the exports array
  for (const node of getChildren(rootNode)) {
    const type = getType(node);
    if (type === 'export_statement') {
      const declaration = (node as { childForFieldName?: (name: string) => unknown | null }).childForFieldName?.('declaration');
      if (declaration) {
        const declType = getType(declaration);
        if (declType === 'function_declaration') {
          const name = getFieldText(declaration, 'name');
          if (name) exports.push({ name, type: 'function', line: getStartLine(node) });
        } else if (declType === 'class_declaration') {
          const name = getFieldText(declaration, 'name');
          if (name) exports.push({ name, type: 'class', line: getStartLine(node) });
        } else if (declType === 'lexical_declaration' || declType === 'variable_declaration') {
          for (const decl of getChildren(declaration)) {
            if (getType(decl) === 'variable_declarator') {
              const name = getFieldText(decl, 'name');
              if (name) exports.push({ name, type: 'variable', line: getStartLine(node) });
            }
          }
        }
      }
      // Check for default export
      const children = getChildren(node);
      if (children.some((c: unknown) => getType(c) === 'default')) {
        const declaration = (node as { childForFieldName?: (name: string) => unknown | null }).childForFieldName?.('declaration');
        if (declaration) {
          const name = getFieldText(declaration, 'name');
          if (name) {
            exports.push({ name, type: 'default', line: getStartLine(node) });
          }
        }
      }
    }
  }

  return { functions, classes, imports, exports };
}

function extractPython(rootNode: unknown): TreeSitterResult {
  const functions: FunctionSignature[] = [];
  const classes: ClassSignature[] = [];
  const imports: ImportSignature[] = [];
  const exports: ExportSignature[] = [];

  for (const node of getChildren(rootNode)) {
    const type = getType(node);

    switch (type) {
      case 'function_definition': {
        const name = getFieldText(node, 'name');
        if (name) {
          const params = extractPythonParameters(getFieldNode(node, 'parameters'));
          functions.push({
            name,
            params,
            isExported: false, // Python modules are the export unit
            startLine: getStartLine(node),
            endLine: getEndLine(node),
          });
        }
        break;
      }

      case 'class_definition': {
        const name = getFieldText(node, 'name');
        if (name) {
          const body = (node as { childForFieldName?: (name: string) => unknown | null }).childForFieldName?.('body');
          const methods: string[] = [];
          const properties: string[] = [];

          if (body) {
            for (const member of getChildren(body)) {
              if (getType(member) === 'function_definition') {
                const methodName = getFieldText(member, 'name');
                if (methodName) methods.push(methodName);
              } else if (getType(member) === 'expression_statement') {
                // Could be class variable assignment
                const child = getChildren(member)[0];
                if (child && getType(child) === 'assignment') {
                  const left = getFieldText(child, 'left');
                  if (left) properties.push(left);
                }
              }
            }
          }

          classes.push({
            name,
            methods,
            properties,
            isExported: false,
            startLine: getStartLine(node),
            endLine: getEndLine(node),
          });
        }
        break;
      }

      case 'import_statement':
      case 'import_from_statement': {
        // import foo
        // from foo import bar, baz
        const modules: string[] = [];
        const items: string[] = [];

        for (const child of getChildren(node)) {
          const childType = getType(child);
          if (childType === 'dotted_name' || childType === 'identifier') {
            modules.push(getFieldText(child, 'name') ?? (child as { text?: string }).text ?? '');
          }
          if (childType === 'aliased_import') {
            const name = getFieldText(child, 'name');
            if (name) items.push(name);
          }
        }

        if (modules.length > 0) {
          imports.push({
            source: modules.join('.'),
            items,
            line: getStartLine(node),
          });
        }
        break;
      }
    }
  }

  // Python: all top-level functions/classes are "exported" by default
  for (const fn of functions) {
    exports.push({ name: fn.name, type: 'function', line: fn.startLine });
  }
  for (const cls of classes) {
    exports.push({ name: cls.name, type: 'class', line: cls.startLine });
  }

  return { functions, classes, imports, exports };
}

// ============================================
// Go AST Extraction
// ============================================

function extractGo(rootNode: unknown): TreeSitterResult {
  const functions: FunctionSignature[] = [];
  const classes: ClassSignature[] = [];
  const imports: ImportSignature[] = [];
  const exports: ExportSignature[] = [];

  for (const node of getChildren(rootNode)) {
    const type = getType(node);

    switch (type) {
      case 'function_declaration':
      case 'method_declaration': {
        // Go function names are 'identifier' children, not a field
        let name: string | undefined;
        for (const child of getChildren(node)) {
          if (getType(child) === 'identifier' || getType(child) === 'field_identifier') {
            name = (child as { text?: string }).text;
            break;
          }
        }
        if (name) {
          const params = extractGoParameters(getFieldNode(node, 'parameters'));
          const returnType = extractGoReturnType(node);
          functions.push({
            name,
            params,
            returnType,
            isExported: name[0] === name[0].toUpperCase(),
            startLine: getStartLine(node),
            endLine: getEndLine(node),
          });
        }
        break;
      }

      case 'type_declaration': {
        // type_declaration → type_spec → type_identifier + struct_type
        const typeSpec = getChildren(node).find(c => getType(c) === 'type_spec');
        if (typeSpec) {
          const nameNode = getChildren(typeSpec).find(c => getType(c) === 'type_identifier');
          const name = nameNode ? (nameNode as { text?: string }).text : undefined;
          if (name) {
            const structType = getChildren(typeSpec).find(c => getType(c) === 'struct_type');
            const methods: string[] = [];
            const properties: string[] = [];

            if (structType) {
              const fieldList = getChildren(structType).find(c => getType(c) === 'field_declaration_list');
              if (fieldList) {
                for (const member of getChildren(fieldList)) {
                  const memberType = getType(member);
                  if (memberType === 'field_declaration') {
                    const memberName = getFieldText(member, 'name');
                    if (memberName) properties.push(memberName);
                  }
                  if (memberType === 'method_spec') {
                    const memberName = getFieldText(member, 'name');
                    if (memberName) methods.push(memberName);
                  }
                }
              }
            }

            classes.push({
              name,
              methods,
              properties,
              isExported: name[0] === name[0].toUpperCase(),
              startLine: getStartLine(node),
              endLine: getEndLine(node),
            });
          }
        }
        break;
      }

      case 'import_declaration': {
        // Single import: import "fmt"
        const spec = getChildren(node).find(c => getType(c) === 'import_spec');
        if (spec) {
          const pathNode = getChildren(spec).find(c =>
            getType(c) === 'interpreted_string_literal' || getType(c) === 'raw_string_literal'
          );
          const path = pathNode ? (pathNode as { text?: string }).text : undefined;
          if (path) {
            imports.push({
              source: stripQuotes(path),
              items: [],
              isDefault: false,
              line: getStartLine(node),
            });
          }
        } else {
          // import block: import ( "a" "b" )
          for (const child of getChildren(node)) {
            if (getType(child) === 'import_spec') {
              const pathNode = getChildren(child).find(c =>
                getType(c) === 'interpreted_string_literal' || getType(c) === 'raw_string_literal'
              );
              const path = pathNode ? (pathNode as { text?: string }).text : undefined;
              if (path) {
                imports.push({
                  source: stripQuotes(path),
                  items: [],
                  isDefault: false,
                  line: getStartLine(node),
                });
              }
            }
          }
        }
        break;
      }
    }
  }

  // Go: exported identifiers start with uppercase
  for (const fn of functions) {
    if (fn.isExported) {
      exports.push({ name: fn.name, type: 'function', line: fn.startLine });
    }
  }
  for (const cls of classes) {
    if (cls.isExported) {
      exports.push({ name: cls.name, type: 'class', line: cls.startLine });
    }
  }

  return { functions, classes, imports, exports };
}

function extractGoParameters(paramsNode: unknown): string[] {
  const params: string[] = [];
  const children = getChildren(paramsNode);

  for (const child of children) {
    const type = getType(child);
    if (type === 'parameter_declaration') {
      const name = getFieldText(child, 'name');
      // Type may be a sibling if multiple params share a type: (a, b int)
      const typeNode = getChildren(child).find(c =>
        getType(c) === 'type_identifier' || getType(c) === 'qualified_type'
        || getType(c) === 'slice_type' || getType(c) === 'map_type'
        || getType(c) === 'pointer_type' || getType(c) === 'function_type'
      );
      const paramType = typeNode ? (typeNode as { text?: string }).text : undefined;
      if (name) {
        params.push(paramType ? `${name}: ${paramType}` : name);
      }
    }
  }

  return params;
}

function extractGoReturnType(node: unknown): string | undefined {
  // In Go, return type is a sibling of parameter_list, not a field
  const children = getChildren(node);
  const returnNode = children.find(c => {
    const t = getType(c);
    return t === 'type_identifier' || t === 'qualified_type' || t === 'slice_type'
      || t === 'map_type' || t === 'pointer_type' || t === 'function_type';
  });
  if (returnNode) {
    return (returnNode as { text?: string }).text;
  }
  // Named returns: result is a parameter_list after the func params
  const paramLists = children.filter(c => getType(c) === 'parameter_list');
  if (paramLists.length > 1) {
    const namedReturns = paramLists[1];
    const returnParams = extractGoParameters(namedReturns);
    return returnParams.length > 0 ? returnParams.join(', ') : undefined;
  }
  return undefined;
}

// ============================================
// Java AST Extraction
// ============================================

function extractJava(rootNode: unknown): TreeSitterResult {
  const functions: FunctionSignature[] = [];
  const classes: ClassSignature[] = [];
  const imports: ImportSignature[] = [];
  const exports: ExportSignature[] = [];

  for (const node of getChildren(rootNode)) {
    const type = getType(node);

    switch (type) {
      case 'class_declaration':
      case 'interface_declaration': {
        const name = getFieldText(node, 'name');
        if (name) {
          const body = getFieldNode(node, 'body');
          const methods: string[] = [];
          const properties: string[] = [];

          if (body) {
            for (const member of getChildren(body)) {
              const memberType = getType(member);
              if (memberType === 'method_declaration') {
                const methodName = getFieldText(member, 'name');
                if (methodName) methods.push(methodName);
              } else if (memberType === 'field_declaration') {
                const declarator = getFieldNode(member, 'declarator');
                if (declarator) {
                  const propName = getFieldText(declarator, 'name');
                  if (propName) properties.push(propName);
                }
              }
            }
          }

          classes.push({
            name,
            methods,
            properties,
            isExported: true, // Java classes in public files are exported
            startLine: getStartLine(node),
            endLine: getEndLine(node),
          });
          exports.push({ name, type: 'class', line: getStartLine(node) });
        }
        break;
      }

      case 'method_declaration': {
        // Top-level methods (unlikely in Java, but handle just in case)
        const name = getFieldText(node, 'name');
        if (name) {
          const params = extractJavaParameters(getFieldNode(node, 'parameters'));
          const returnType = getFieldText(node, 'type') ?? undefined;
          functions.push({
            name,
            params,
            returnType,
            isExported: true,
            startLine: getStartLine(node),
            endLine: getEndLine(node),
          });
        }
        break;
      }

      case 'import_declaration': {
        // Java import: import java.util.List; — name is a scoped_identifier child
        const scopedId = getChildren(node).find(c => getType(c) === 'scoped_identifier');
        const nameNode = scopedId ?? getFieldNode(node, 'name');
        if (nameNode) {
          const name = (nameNode as { text?: string }).text ?? '';
          const asterisk = getChildren(node).some(c => getType(c) === 'asterisk');
          imports.push({
            source: name,
            items: asterisk ? ['*'] : [],
            isDefault: false,
            line: getStartLine(node),
          });
        }
        break;
      }
    }
  }

  return { functions, classes, imports, exports };
}

function extractJavaParameters(paramsNode: unknown): string[] {
  const params: string[] = [];
  const children = getChildren(paramsNode);

  for (const child of children) {
    const type = getType(child);
    if (type === 'formal_parameter') {
      const name = getFieldText(child, 'name');
      const paramType = getFieldText(child, 'type');
      if (name) {
        params.push(paramType ? `${name}: ${paramType}` : name);
      }
    }
  }

  return params;
}

function extractPythonParameters(paramsNode: unknown): string[] {
  const params: string[] = [];
  const children = getChildren(paramsNode);

  for (const child of children) {
    const type = getType(child);
    if (type === 'identifier') {
      params.push((child as { text?: string }).text ?? '');
    } else if (type === 'default_parameter') {
      const name = getFieldText(child, 'name');
      if (name) params.push(name);
    } else if (type === 'typed_parameter') {
      const name = getFieldText(child, 'name');
      if (name) params.push(name);
    } else if (type === 'list_splat_pattern' || type === 'dictionary_splat_pattern') {
      const pattern = getFieldText(child, 'pattern');
      if (pattern) {
        params.push((type === 'list_splat_pattern' ? '*' : '**') + pattern);
      }
    }
  }

  return params.filter(Boolean);
}

// Helper to get a node field (returns the node, not text)
function getFieldNode(node: unknown, fieldName: string): unknown | undefined {
  const n = node as { childForFieldName?: (name: string) => unknown | null };
  return n.childForFieldName?.(fieldName) ?? undefined;
}

function stripQuotes(str: string): string {
  return str.replace(/^['"`]|['"`]$/g, '');
}

// ============================================
// Regex Fallback (for unsupported languages)
// ============================================

function extractFunctionsRegex(content: string): FunctionSignature[] {
  const functions: FunctionSignature[] = [];
  const lines = content.split('\n');

  const funcRegex = /^(export\s+)?(async\s+)?function\s+(\w+)\s*\(([^)]*)\)/;
  const arrowRegex = /^(export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/;
  const asyncFuncRegex = /^(export\s+)?const\s+(\w+)\s*=\s*async\s+function\s*\(([^)]*)\)/;

  lines.forEach((line, idx) => {
    const lineNum = idx + 1;
    let match = line.match(funcRegex);
    if (match) {
      functions.push({
        name: match[3],
        params: match[4].split(',').map(p => p.trim()).filter(Boolean),
        isExported: !!match[1],
        startLine: lineNum,
        endLine: lineNum,
      });
      return;
    }
    match = line.match(arrowRegex);
    if (match) {
      functions.push({
        name: match[2],
        params: match[3].split(',').map(p => p.trim()).filter(Boolean),
        isExported: !!match[1],
        startLine: lineNum,
        endLine: lineNum,
      });
      return;
    }
    match = line.match(asyncFuncRegex);
    if (match) {
      functions.push({
        name: match[2],
        params: match[3].split(',').map(p => p.trim()).filter(Boolean),
        isExported: !!match[1],
        startLine: lineNum,
        endLine: lineNum,
      });
    }
  });

  return functions;
}

function extractClassesRegex(content: string): ClassSignature[] {
  const classes: ClassSignature[] = [];
  const lines = content.split('\n');
  const classRegex = /^(export\s+)?class\s+(\w+)/;

  lines.forEach((line, idx) => {
    const match = line.match(classRegex);
    if (match) {
      classes.push({
        name: match[2],
        methods: [],
        properties: [],
        isExported: !!match[1],
        startLine: idx + 1,
        endLine: idx + 1,
      });
    }
  });

  return classes;
}

function extractImportsRegex(content: string): ImportSignature[] {
  const imports: ImportSignature[] = [];
  const lines = content.split('\n');
  const importRegex = /import\s+(?:(\{[^}]+\})|(\w+))\s+from\s+['"]([^'"]+)['"]/;

  lines.forEach((line, idx) => {
    const match = line.match(importRegex);
    if (match) {
      const items = match[1]
        ? match[1].replace(/[{}]/g, '').split(',').map(s => s.trim()).filter(Boolean)
        : match[2]
          ? [match[2]]
          : [];
      imports.push({
        source: match[3],
        items,
        isDefault: !!match[2],
        line: idx + 1,
      });
    }
  });

  return imports;
}

function extractExportsRegex(content: string): ExportSignature[] {
  const exports: ExportSignature[] = [];
  const lines = content.split('\n');
  const exportRegex = /^export\s+(?:default\s+)?(?:(?:async\s+)?function|class|const|let|var|type|interface)\s+(\w+)/;
  const defaultRegex = /^export\s+default\s+(\w+)/;

  lines.forEach((line, idx) => {
    let match = line.match(exportRegex);
    if (match) {
      const type: ExportSignature['type'] = line.includes('function')
        ? 'function'
        : line.includes('class')
          ? 'class'
          : 'variable';
      exports.push({ name: match[1], type, line: idx + 1 });
      return;
    }
    match = line.match(defaultRegex);
    if (match) {
      exports.push({ name: match[1], type: 'default', line: idx + 1 });
    }
  });

  return exports;
}

function signaturesEqual<T extends object>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!deepEqual(a[i], b[i])) return false;
  }
  return true;
}

/** Deep equality for plain objects and arrays (order-sensitive). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object' || typeof b !== 'object') return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (Array.isArray(a) !== Array.isArray(b)) return false;

  const keysA = Object.keys(a as Record<string, unknown>).sort();
  const keysB = Object.keys(b as Record<string, unknown>).sort();
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    if (keysA[i] !== keysB[i]) return false;
    if (!deepEqual((a as Record<string, unknown>)[keysA[i]], (b as Record<string, unknown>)[keysB[i]])) {
      return false;
    }
  }
  return true;
}
