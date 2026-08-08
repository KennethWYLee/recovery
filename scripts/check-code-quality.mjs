import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.dirname(SCRIPT_DIRECTORY);
const CONFIG_PATH = path.join(PROJECT_ROOT, "quality-exceptions.json");
const SOURCE_ROOTS = ["app", "db", "lib", "worker"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);

function relativePath(filePath) {
  return path.relative(PROJECT_ROOT, filePath).split(path.sep).join("/");
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`無法讀取 ${relativePath(filePath)}：${detail}`);
  }
}

function collectSourceFiles() {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist" || entry.name === "build") {
        continue;
      }
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(target);
      } else if (
        entry.isFile()
        && SOURCE_EXTENSIONS.has(path.extname(entry.name))
        && !entry.name.endsWith(".d.ts")
      ) {
        files.push(path.resolve(target));
      }
    }
  };

  for (const root of SOURCE_ROOTS) {
    const directory = path.join(PROJECT_ROOT, root);
    if (fs.existsSync(directory)) visit(directory);
  }
  return files.sort((left, right) => relativePath(left).localeCompare(relativePath(right), "en"));
}

function physicalLineCount(text) {
  if (text.length === 0) return 0;
  const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const lines = normalized.split("\n").length;
  return normalized.endsWith("\n") ? lines - 1 : lines;
}

function sourceKind(filePath) {
  switch (path.extname(filePath)) {
    case ".tsx": return ts.ScriptKind.TSX;
    case ".jsx": return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs": return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

function propertyNameText(name, sourceFile) {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return name.getText(sourceFile).replaceAll(/\s+/g, " ").slice(0, 60);
}

function enclosingClassName(node) {
  let current = node.parent;
  while (current) {
    if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) {
      return current.name?.text ?? "<anonymous-class>";
    }
    current = current.parent;
  }
  return null;
}

function callName(expression, sourceFile) {
  return expression.getText(sourceFile).replaceAll(/\s+/g, " ").slice(0, 60);
}

function baseFunctionName(node, sourceFile) {
  if (node.name) {
    const ownName = propertyNameText(node.name, sourceFile);
    const className = enclosingClassName(node);
    return className ? `${className}.${ownName}` : ownName;
  }
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent)) {
    return propertyNameText(parent.name, sourceFile) ?? "<variable-function>";
  }
  if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
    return propertyNameText(parent.name, sourceFile) ?? "<property-function>";
  }
  if (ts.isBinaryExpression(parent)) {
    return `assignment:${parent.left.getText(sourceFile).replaceAll(/\s+/g, " ").slice(0, 50)}`;
  }
  if (ts.isCallExpression(parent)) {
    return `callback:${callName(parent.expression, sourceFile)}`;
  }
  if (ts.isJsxAttribute(parent)) {
    return `jsx:${parent.name.getText(sourceFile)}`;
  }
  return "<anonymous-function>";
}

function complexityIncrement(node) {
  if (
    ts.isIfStatement(node)
    || ts.isForStatement(node)
    || ts.isForInStatement(node)
    || ts.isForOfStatement(node)
    || ts.isWhileStatement(node)
    || ts.isDoStatement(node)
    || ts.isCatchClause(node)
    || ts.isConditionalExpression(node)
    || ts.isCaseClause(node)
  ) {
    return 1;
  }
  if (ts.isBinaryExpression(node)) {
    const kind = node.operatorToken.kind;
    if (
      kind === ts.SyntaxKind.AmpersandAmpersandToken
      || kind === ts.SyntaxKind.BarBarToken
      || kind === ts.SyntaxKind.QuestionQuestionToken
      || kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken
      || kind === ts.SyntaxKind.BarBarEqualsToken
      || kind === ts.SyntaxKind.QuestionQuestionEqualsToken
    ) {
      return 1;
    }
  }
  return 0;
}

function functionComplexity(node) {
  let complexity = 1;
  const visit = (current) => {
    if (current !== node && ts.isFunctionLike(current)) return;
    complexity += complexityIncrement(current);
    ts.forEachChild(current, visit);
  };
  if (node.body) visit(node.body);
  return complexity;
}

function analyzeFunctions(sourceFile, projectPath) {
  const functions = [];
  const nameCounts = new Map();
  const visit = (node) => {
    if (ts.isFunctionLike(node) && node.body) {
      const baseName = baseFunctionName(node, sourceFile);
      const occurrence = (nameCounts.get(baseName) ?? 0) + 1;
      nameCounts.set(baseName, occurrence);
      const displayName = occurrence === 1 ? baseName : `${baseName}#${occurrence}`;
      const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const end = sourceFile.getLineAndCharacterOfPosition(node.end).line + 1;
      functions.push({
        id: `${projectPath}::${displayName}`,
        path: projectPath,
        name: displayName,
        start,
        end,
        lines: end - start + 1,
        complexity: functionComplexity(node),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return functions;
}

function importReferences(sourceFile) {
  const references = [];
  const add = (specifier, typeOnly) => {
    if (specifier && (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("@/"))) {
      references.push({ specifier, typeOnly });
    }
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const namedBindings = clause?.namedBindings;
      const everyNamedImportIsTypeOnly = namedBindings && ts.isNamedImports(namedBindings)
        ? namedBindings.elements.length > 0 && namedBindings.elements.every((element) => element.isTypeOnly)
        : false;
      add(node.moduleSpecifier.text, Boolean(
        clause?.isTypeOnly
        || (!clause?.name && everyNamedImportIsTypeOnly),
      ));
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      add(node.moduleSpecifier.text, node.isTypeOnly);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (argument && ts.isStringLiteral(argument)) add(argument.text, false);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return references;
}

function resolveInternalImport(importer, specifier, sourceFileSet) {
  const rawTarget = specifier.startsWith("@/")
    ? path.join(PROJECT_ROOT, specifier.slice(2))
    : path.resolve(path.dirname(importer), specifier);
  const ext = path.extname(rawTarget);
  const withoutTypeScriptExtension = ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".mjs"
    ? rawTarget.slice(0, -ext.length)
    : rawTarget;
  const candidates = [
    rawTarget,
    withoutTypeScriptExtension,
    ...[".ts", ".tsx", ".js", ".jsx", ".mjs"].map((extension) => `${withoutTypeScriptExtension}${extension}`),
    ...[".ts", ".tsx", ".js", ".jsx", ".mjs"].map((extension) => path.join(withoutTypeScriptExtension, `index${extension}`)),
  ].map((candidate) => path.resolve(candidate));
  return candidates.find((candidate) => sourceFileSet.has(candidate)) ?? null;
}

function hasUseClientDirective(sourceFile) {
  for (const statement of sourceFile.statements) {
    if (ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression)) {
      if (statement.expression.text === "use client") return true;
      continue;
    }
    break;
  }
  return false;
}

function layerOf(projectPath, sourceFile) {
  if (projectPath.startsWith("lib/")) return "lib";
  if (projectPath.startsWith("db/")) return "db";
  if (projectPath.startsWith("worker/")) return "worker";
  if (projectPath.startsWith("app/") && hasUseClientDirective(sourceFile)) return "client";
  if (projectPath.startsWith("app/api/")) return "api";
  if (projectPath.startsWith("app/")) return "app-server";
  return "other";
}

function layerViolation(from, to, typeOnly) {
  if (from === "lib" && ["db", "client", "api", "app-server", "worker"].includes(to)) {
    return "lib 只能依賴 lib 或外部套件";
  }
  if (from === "db" && ["client", "api", "app-server", "worker"].includes(to)) {
    return "db 可依賴 lib，但不可反向依賴 app 或 worker";
  }
  if (from === "client" && !typeOnly && ["db", "api", "worker"].includes(to)) {
    return "client 不可在執行階段載入 db、API route 或 worker；純型別 import 可接受";
  }
  return null;
}

function graphCycles(graph) {
  const state = new Map();
  const stack = [];
  const stackIndex = new Map();
  const cycles = new Map();

  const canonicalCycle = (nodes) => {
    const ring = nodes.slice(0, -1);
    const rotations = ring.map((_, index) => [...ring.slice(index), ...ring.slice(0, index)]);
    rotations.sort((left, right) => left.join(" -> ").localeCompare(right.join(" -> "), "en"));
    const best = rotations[0];
    return [...best, best[0]];
  };

  const visit = (node) => {
    state.set(node, 1);
    stackIndex.set(node, stack.length);
    stack.push(node);
    for (const target of graph.get(node) ?? []) {
      if ((state.get(target) ?? 0) === 0) {
        visit(target);
      } else if (state.get(target) === 1) {
        const index = stackIndex.get(target);
        const cycle = canonicalCycle([...stack.slice(index), target]);
        cycles.set(cycle.join(" -> "), cycle);
      }
    }
    stack.pop();
    stackIndex.delete(node);
    state.set(node, 2);
  };

  for (const node of graph.keys()) {
    if ((state.get(node) ?? 0) === 0) visit(node);
  }
  return [...cycles.values()];
}

function validateExceptionMetadata(id, entry, today, errors) {
  if (!entry || typeof entry !== "object") {
    errors.push(`${id}：例外設定必須是物件`);
    return false;
  }
  if (typeof entry.reason !== "string" || entry.reason.trim().length < 12) {
    errors.push(`${id}：必須提供具體 reason（至少 12 個字元）`);
  }
  if (typeof entry.ownerRole !== "string" || entry.ownerRole.trim().length < 3) {
    errors.push(`${id}：必須指定 ownerRole`);
  }
  if (typeof entry.expiresOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.expiresOn)) {
    errors.push(`${id}：expiresOn 必須使用 YYYY-MM-DD`);
  } else if (entry.expiresOn < today) {
    errors.push(`${id}：例外已於 ${entry.expiresOn} 到期`);
  }
  return true;
}

function checkMetric({ id, metricName, actual, limit, baseline, exceptionPresent, errors }) {
  if (actual <= limit) {
    if (exceptionPresent && baseline !== undefined) {
      errors.push(`${id}：${metricName} 已降至門檻內，請移除不再需要的例外基線`);
    }
    return false;
  }
  if (!exceptionPresent || !Number.isInteger(baseline) || baseline <= limit) {
    errors.push(`${id}：${metricName} ${actual} 超過門檻 ${limit}，且沒有有效的不可增長基線`);
    return true;
  }
  if (actual > baseline) {
    errors.push(`${id}：${metricName} 從例外基線 ${baseline} 增至 ${actual}`);
  } else if (actual < baseline) {
    errors.push(`${id}：${metricName} 已從 ${baseline} 降至 ${actual}，請同步下修基線，避免日後回升`);
  }
  return true;
}

function main() {
  const config = readJson(CONFIG_PATH);
  if (config.schemaVersion !== 1) {
    throw new Error("quality-exceptions.json 的 schemaVersion 必須是 1");
  }
  const limits = config.limits ?? {};
  const maxFileLines = limits.maxFileLines;
  const maxFunctionLines = limits.maxFunctionLines;
  const maxCyclomaticComplexity = limits.maxCyclomaticComplexity;
  if (![maxFileLines, maxFunctionLines, maxCyclomaticComplexity].every((value) => Number.isInteger(value) && value > 0)) {
    throw new Error("quality-exceptions.json 的三項 limits 必須是正整數");
  }

  const fileExceptions = config.fileExceptions ?? {};
  const functionExceptions = config.functionExceptions ?? {};
  const today = new Date().toISOString().slice(0, 10);
  const errors = [];
  const sourcePaths = collectSourceFiles();
  const sourceFileSet = new Set(sourcePaths);
  const analyses = new Map();
  const allFunctions = [];

  for (const filePath of sourcePaths) {
    const projectPath = relativePath(filePath);
    const text = fs.readFileSync(filePath, "utf8");
    const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, sourceKind(filePath));
    const analysis = {
      filePath,
      projectPath,
      text,
      sourceFile,
      lines: physicalLineCount(text),
      layer: layerOf(projectPath, sourceFile),
      imports: importReferences(sourceFile),
      functions: analyzeFunctions(sourceFile, projectPath),
    };
    analyses.set(filePath, analysis);
    allFunctions.push(...analysis.functions);
  }

  const usedFileExceptions = new Set();
  const usedFunctionExceptions = new Set();
  for (const [projectPath, entry] of Object.entries(fileExceptions)) {
    validateExceptionMetadata(`檔案例外 ${projectPath}`, entry, today, errors);
  }
  for (const [id, entry] of Object.entries(functionExceptions)) {
    validateExceptionMetadata(`函式例外 ${id}`, entry, today, errors);
  }

  for (const analysis of analyses.values()) {
    const exception = fileExceptions[analysis.projectPath];
    const exceeds = checkMetric({
      id: analysis.projectPath,
      metricName: "檔案行數",
      actual: analysis.lines,
      limit: maxFileLines,
      baseline: exception?.baselineLines,
      exceptionPresent: Boolean(exception),
      errors,
    });
    if (exceeds && exception) usedFileExceptions.add(analysis.projectPath);
  }

  for (const metric of allFunctions) {
    const exception = functionExceptions[metric.id];
    const lineExceeds = metric.lines > maxFunctionLines;
    const complexityExceeds = metric.complexity > maxCyclomaticComplexity;
    if (!lineExceeds && !complexityExceeds) continue;
    if (exception) usedFunctionExceptions.add(metric.id);
    checkMetric({
      id: `${metric.id}（第 ${metric.start} 行）`,
      metricName: "函式行數",
      actual: metric.lines,
      limit: maxFunctionLines,
      baseline: exception?.baselineLines,
      exceptionPresent: Boolean(exception),
      errors,
    });
    checkMetric({
      id: `${metric.id}（第 ${metric.start} 行）`,
      metricName: "循環複雜度",
      actual: metric.complexity,
      limit: maxCyclomaticComplexity,
      baseline: exception?.baselineComplexity,
      exceptionPresent: Boolean(exception),
      errors,
    });
  }

  for (const projectPath of Object.keys(fileExceptions)) {
    if (!analyses.has(path.resolve(PROJECT_ROOT, projectPath))) {
      errors.push(`檔案例外 ${projectPath}：找不到對應來源檔`);
    } else if (!usedFileExceptions.has(projectPath)) {
      errors.push(`檔案例外 ${projectPath}：檔案已未超標，請移除此例外`);
    }
  }
  const functionIds = new Set(allFunctions.map((metric) => metric.id));
  for (const id of Object.keys(functionExceptions)) {
    if (!functionIds.has(id)) {
      errors.push(`函式例外 ${id}：找不到對應函式（函式可能已改名或移除）`);
    } else if (!usedFunctionExceptions.has(id)) {
      errors.push(`函式例外 ${id}：函式已未超標，請移除此例外`);
    }
  }

  const graph = new Map();
  const layerViolations = [];
  for (const analysis of analyses.values()) {
    const targets = new Set();
    for (const reference of analysis.imports) {
      const targetPath = resolveInternalImport(analysis.filePath, reference.specifier, sourceFileSet);
      if (!targetPath) continue;
      const target = analyses.get(targetPath);
      if (!target) continue;
      targets.add(target.projectPath);
      const violation = layerViolation(analysis.layer, target.layer, reference.typeOnly);
      if (violation) {
        layerViolations.push(`${analysis.projectPath} -> ${target.projectPath}: ${violation}`);
      }
    }
    graph.set(analysis.projectPath, targets);
  }
  const cycles = graphCycles(graph);
  for (const cycle of cycles) errors.push(`內部 import cycle：${cycle.join(" -> ")}`);
  for (const violation of layerViolations) errors.push(`分層違反：${violation}`);

  const fileExceptionSummary = [...usedFileExceptions].sort();
  const functionExceptionSummary = [...usedFunctionExceptions].sort();
  console.log("程式品質閘門");
  console.log(`- 掃描：${sourcePaths.length} 個來源檔、${allFunctions.length} 個函式`);
  console.log(`- 門檻：檔案 <= ${maxFileLines} 行；函式 <= ${maxFunctionLines} 行；循環複雜度 <= ${maxCyclomaticComplexity}`);
  console.log(`- 架構：${graph.size} 個模組；${cycles.length} 個 cycle；${layerViolations.length} 個分層違反`);
  console.log("- 分層：lib 不反向依賴 db/app/worker；db 不依賴 app/worker；client 不在執行階段載入 db/API/worker");
  console.log(`- 既有例外：${fileExceptionSummary.length} 個檔案、${functionExceptionSummary.length} 個函式（皆不得超過目前基線）`);
  for (const projectPath of fileExceptionSummary) {
    const entry = fileExceptions[projectPath];
    console.log(`  FILE ${projectPath}: ${entry.baselineLines} 行；負責=${entry.ownerRole}；期限=${entry.expiresOn}`);
    console.log(`       理由：${entry.reason}`);
  }
  for (const id of functionExceptionSummary) {
    const entry = functionExceptions[id];
    const baselines = [
      entry.baselineLines ? `${entry.baselineLines} 行` : null,
      entry.baselineComplexity ? `複雜度 ${entry.baselineComplexity}` : null,
    ].filter(Boolean).join(" / ");
    console.log(`  FUNC ${id}: ${baselines}；負責=${entry.ownerRole}；期限=${entry.expiresOn}`);
    console.log(`       理由：${entry.reason}`);
  }

  if (errors.length > 0) {
    console.error(`\nFAIL：${errors.length} 個問題`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log("PASS：沒有新增或惡化的品質債，依賴方向與 import graph 符合規則。");
}

try {
  main();
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`程式品質閘門無法執行：${detail}`);
  process.exitCode = 1;
}
