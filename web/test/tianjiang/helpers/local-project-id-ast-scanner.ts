/**
 * 本地 projectId AST 门禁扫描器。
 * 对每个 axios.post / Socket auth 在词法作用域内解析 projectId 是否经官方边界。
 * 禁止文件级安全变量名 Set（跨函数同名污染）。
 *
 * 官方转换器仅按「真实 import 模块 + 规范导出名」识别；局部同名函数会遮蔽。
 */
import ts from "typescript";

/** 官方 projectId 边界导出名（按导入来源校验，不单认名字） */
const OFFICIAL_PROJECT_ID_CONVERTERS = new Set([
  "toLocalProjectId",
  "localProjectBody",
  "normalizeNovelProjectIdInput",
  "toNovelProjectId",
]);

const OFFICIAL_MODULE_SUFFIXES = [
  "/features/tianjiang/project/local-project-id",
  "/project/local-project-id",
  "local-project-id",
  "/views/novel/components/novel-import-contract",
  "novel-import-contract",
];

export interface ScanOffense {
  line: number;
  message: string;
  context: string;
}

export interface ScanResult {
  offenses: ScanOffense[];
}

/**
 * safe: 已证明为官方边界 number / localProjectBody 对象
 * unsafe_project: 对象字面量含未证明的 projectId（用于 body 变量）
 * other: 其它绑定（axios 第二参不因「未知」误报）
 * param: 函数参数
 */
type BindingStatus = "safe" | "unsafe_project" | "other" | "param";

interface Scope {
  parent: Scope | null;
  bindings: Map<string, BindingStatus>;
  shadowedConverters: Set<string>;
  /** 本地名 → 官方规范名 */
  officialNames: Map<string, string>;
  /** 返回官方 toLocalProjectId 等 number 的本地包装函数名 */
  safeFactories: Set<string>;
}

function isOfficialModule(spec: string): boolean {
  const n = spec.replace(/\\/g, "/").replace(/['"]/g, "");
  const bare = n.replace(/\.ts$/, "").replace(/\.js$/, "");
  return OFFICIAL_MODULE_SUFFIXES.some(
    (s) => bare.endsWith(s) || bare === s || bare.endsWith(s.replace(/^\//, "")),
  );
}

function createScope(parent: Scope | null): Scope {
  return {
    parent,
    bindings: new Map(),
    shadowedConverters: new Set(),
    officialNames: parent ? new Map(parent.officialNames) : new Map(),
    safeFactories: parent ? new Set(parent.safeFactories) : new Set(),
  };
}

function lookupBinding(scope: Scope, name: string): BindingStatus | undefined {
  let s: Scope | null = scope;
  while (s) {
    if (s.bindings.has(name)) return s.bindings.get(name);
    s = s.parent;
  }
  return undefined;
}

/** 赋值更新最近外层已声明绑定；无则写当前作用域 */
function assignBinding(scope: Scope, name: string, status: BindingStatus): void {
  let s: Scope | null = scope;
  while (s) {
    if (s.bindings.has(name)) {
      s.bindings.set(name, status);
      return;
    }
    s = s.parent;
  }
  scope.bindings.set(name, status);
}

function declareBinding(scope: Scope, name: string, status: BindingStatus): void {
  scope.bindings.set(name, status);
}

function lookupOfficialCanon(scope: Scope, localName: string): string | undefined {
  let s: Scope | null = scope;
  while (s) {
    if (s.shadowedConverters.has(localName)) return undefined;
    if (s.officialNames.has(localName)) return s.officialNames.get(localName);
    s = s.parent;
  }
  return undefined;
}

function isOfficialConverterName(scope: Scope, name: string): boolean {
  return lookupOfficialCanon(scope, name) !== undefined;
}

function isSafeFactoryName(scope: Scope, name: string): boolean {
  let s: Scope | null = scope;
  while (s) {
    if (s.shadowedConverters.has(name)) return false;
    if (s.safeFactories.has(name)) return true;
    s = s.parent;
  }
  return false;
}

function isAxiosPostCall(node: ts.CallExpression): boolean {
  const exp = node.expression;
  return (
    ts.isPropertyAccessExpression(exp) &&
    exp.name.text === "post" &&
    ts.isIdentifier(exp.expression) &&
    exp.expression.text === "axios"
  );
}

function isCallToOfficial(
  scope: Scope,
  node: ts.Expression,
  want: "any" | "localProjectBody" | "numberConverters" = "any",
): boolean {
  if (!ts.isCallExpression(node)) return false;
  const cal = node.expression;
  if (!ts.isIdentifier(cal)) return false;
  if (!isOfficialConverterName(scope, cal.text)) return false;
  const canon = lookupOfficialCanon(scope, cal.text)!;
  if (want === "localProjectBody") return canon === "localProjectBody";
  if (want === "numberConverters") return canon !== "localProjectBody";
  return true;
}

function isLocalProjectBodyCall(scope: Scope, node: ts.Expression): boolean {
  return isCallToOfficial(scope, node, "localProjectBody");
}

function isSafeNumberProjectIdCall(scope: Scope, node: ts.Expression): boolean {
  if (isCallToOfficial(scope, node, "numberConverters")) return true;
  if (!ts.isCallExpression(node)) return false;
  const cal = node.expression;
  if (ts.isIdentifier(cal) && isSafeFactoryName(scope, cal.text)) return true;
  return false;
}

function lineOf(sf: ts.SourceFile, node: ts.Node, offsetLine: number): number {
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return offsetLine + line;
}

/**
 * null = 安全；string = 违规原因。
 * 对无法判断且非典型裸传的表达式返回 null（避免账号设置等无 projectId 请求误报）。
 */
function projectIdValueReason(scope: Scope, init: ts.Expression, sf: ts.SourceFile): string | null {
  if (isSafeNumberProjectIdCall(scope, init)) return null;

  // localProjectBody(...).projectId
  if (
    ts.isPropertyAccessExpression(init) &&
    init.name.text === "projectId" &&
    isLocalProjectBodyCall(scope, init.expression)
  ) {
    return null;
  }

  if (ts.isIdentifier(init)) {
    const st = lookupBinding(scope, init.text);
    if (st === "safe") return null;
    if (st === "param" || st === "unsafe_project" || st === "other" || st === undefined) {
      return `标识符 ${init.text} 未证明经官方 toLocalProjectId（状态=${st ?? "unbound"}）`;
    }
  }

  const text = init.getText(sf).replace(/\s+/g, " ");
  if (/project\.value/.test(text)) return `裸 project.value: ${text}`;
  if (/state\.project\.value/.test(text)) return `裸 state.project.value: ${text}`;
  if (/^String\s*\(/.test(text)) return `String(...) 强制: ${text}`;
  if (/\.id\b/.test(text) && !/toLocalProjectId|localProjectBody|normalizeNovel|toNovelProjectId|currentLocalProjectId/.test(text)) {
    return `疑似未转换 ID 表达式: ${text}`;
  }
  // 其它未知表达式（含 props.projectId/config.projectId）：不因无法理解而误报账号/设置 API
  return null;
}

function checkObjectLiteral(
  scope: Scope,
  obj: ts.ObjectLiteralExpression,
  ctx: string,
  sf: ts.SourceFile,
  offsetLine: number,
  offenses: ScanOffense[],
): void {
  /**
   * 按属性顺序模拟最终 projectId：
   * - 后写覆盖先写；spread 可能注入/覆盖
   * - lastSafe: true/false/null(无 projectId 键)
   */
  let lastSafe: boolean | null = null;
  let lastProjectIdNode: ts.Node | null = null;
  let pendingUnsafeSpread: ts.Node | null = null;

  for (const prop of obj.properties) {
    if (ts.isSpreadAssignment(prop)) {
      if (isLocalProjectBodyCall(scope, prop.expression)) {
        lastSafe = true;
        lastProjectIdNode = prop;
        pendingUnsafeSpread = null;
        continue;
      }
      if (ts.isIdentifier(prop.expression)) {
        const st = lookupBinding(scope, prop.expression.text);
        if (st === "safe") {
          lastSafe = true;
          lastProjectIdNode = prop;
          pendingUnsafeSpread = null;
          continue;
        }
        // unsafe_project / param / other / unbound：可能注入或覆盖 projectId
        if (st === "unsafe_project" || st === "param" || st === undefined) {
          lastSafe = null;
          pendingUnsafeSpread = prop;
          continue;
        }
        // other：对象无 projectId 的绑定，不改变 lastSafe，也不单独定罪
        continue;
      }
      // 非标识展开：保守视为可能注入
      lastSafe = null;
      pendingUnsafeSpread = prop;
      continue;
    }

    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === "projectId") {
      lastProjectIdNode = prop;
      pendingUnsafeSpread = null;
      const st = lookupBinding(scope, "projectId");
      lastSafe = st === "safe";
      continue;
    }

    if (ts.isPropertyAssignment(prop)) {
      const name = prop.name;
      const key = ts.isIdentifier(name)
        ? name.text
        : ts.isStringLiteral(name)
          ? name.text
          : null;
      if (key !== "projectId") continue;
      lastProjectIdNode = prop;
      pendingUnsafeSpread = null;
      const reason = projectIdValueReason(scope, prop.initializer, sf);
      lastSafe = reason === null;
      if (reason) {
        // 先记原因，最后统一用 lastSafe 输出，避免被后续覆盖干扰——若最终仍 unsafe 再报
        (prop as ts.PropertyAssignment & { __reason?: string }).__reason = reason;
      }
    }
  }

  if (lastSafe === false && lastProjectIdNode) {
    const prop = lastProjectIdNode as ts.PropertyAssignment & { __reason?: string };
    let msg: string;
    if (ts.isShorthandPropertyAssignment(lastProjectIdNode)) {
      const st = lookupBinding(scope, "projectId");
      msg = `简写 { projectId } 未证明经官方边界（状态=${st ?? "unbound"}）`;
    } else if (prop.__reason) {
      msg = prop.__reason;
    } else {
      msg = "projectId 未证明经官方边界";
    }
    offenses.push({
      line: lineOf(sf, lastProjectIdNode, offsetLine),
      context: ctx,
      message: msg,
    });
  }

  // 纯展开体 + 不安全来源 → 失败关闭（fixture: { ...unsafeBody }）。
  // 带其它字段的表单展开（settings formData）不因无法证明而误报。
  const onlySpreads = obj.properties.every((p) => ts.isSpreadAssignment(p));
  if (lastSafe !== true && pendingUnsafeSpread && onlySpreads) {
    const exp = (pendingUnsafeSpread as ts.SpreadAssignment).expression;
    if (ts.isIdentifier(exp)) {
      const st = lookupBinding(scope, exp.text);
      if (st === "param" || st === "unsafe_project" || st === undefined) {
        offenses.push({
          line: lineOf(sf, pendingUnsafeSpread, offsetLine),
          context: ctx,
          message: `对象展开未证明安全（禁止裸 ...body）: ${exp.text}`,
        });
      }
    }
  }
}

function analyzeObjectLiteralBinding(
  scope: Scope,
  init: ts.ObjectLiteralExpression,
  sf: ts.SourceFile,
): BindingStatus {
  let hasProjectId = false;
  let projectIdSafe = true;
  for (const prop of init.properties) {
    if (ts.isSpreadAssignment(prop)) {
      if (isLocalProjectBodyCall(scope, prop.expression)) {
        hasProjectId = true;
        continue;
      }
      if (ts.isIdentifier(prop.expression)) {
        const st = lookupBinding(scope, prop.expression.text);
        if (st === "safe") {
          hasProjectId = true;
          continue;
        }
        if (st === "unsafe_project") {
          hasProjectId = true;
          projectIdSafe = false;
        }
      }
      continue;
    }
    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === "projectId") {
      hasProjectId = true;
      if (lookupBinding(scope, "projectId") !== "safe") projectIdSafe = false;
    }
    if (ts.isPropertyAssignment(prop)) {
      const key = ts.isIdentifier(prop.name)
        ? prop.name.text
        : ts.isStringLiteral(prop.name)
          ? prop.name.text
          : null;
      if (key === "projectId") {
        hasProjectId = true;
        if (projectIdValueReason(scope, prop.initializer, sf)) projectIdSafe = false;
      }
    }
  }
  if (!hasProjectId) return "other";
  return projectIdSafe ? "safe" : "unsafe_project";
}

function statusFromInitializer(
  scope: Scope,
  init: ts.Expression | undefined,
  sf: ts.SourceFile,
): BindingStatus {
  if (!init) return "other";
  if (isCallToOfficial(scope, init, "any")) {
    return "safe";
  }
  if (isSafeNumberProjectIdCall(scope, init)) return "safe";
  if (ts.isObjectLiteralExpression(init)) {
    return analyzeObjectLiteralBinding(scope, init, sf);
  }
  if (ts.isIdentifier(init)) {
    return lookupBinding(scope, init.text) ?? "other";
  }
  return "other";
}

/** 函数体是否仅 return 官方 number 转换 / safe factory */
function functionReturnsSafeProjectId(
  scope: Scope,
  body: ts.ConciseBody,
): boolean {
  if (!ts.isBlock(body)) {
    return isSafeNumberProjectIdCall(scope, body);
  }
  // 仅当存在 return 且全部 return 为安全调用
  const returns: ts.Expression[] = [];
  const walk = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n)) {
      return;
    }
    if (ts.isReturnStatement(n) && n.expression) returns.push(n.expression);
    ts.forEachChild(n, walk);
  };
  walk(body);
  if (returns.length === 0) return false;
  return returns.every((r) => isSafeNumberProjectIdCall(scope, r));
}

function collectImports(sf: ts.SourceFile, fileScope: Scope): void {
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
    const spec = stmt.moduleSpecifier.getText(sf).replace(/['"]/g, "");
    if (!isOfficialModule(spec)) continue;
    const clause = stmt.importClause;
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        const imported = (el.propertyName ?? el.name).text;
        const local = el.name.text;
        if (OFFICIAL_PROJECT_ID_CONVERTERS.has(imported)) {
          fileScope.officialNames.set(local, imported);
        }
      }
    }
  }
}

function collectNestedReturns(node: ts.Node, out: ts.Expression[]): void {
  if (ts.isReturnStatement(node) && node.expression) {
    out.push(node.expression);
  }
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  ) {
    return;
  }
  ts.forEachChild(node, (c) => collectNestedReturns(c, out));
}

/**
 * 扫描一段 TS/TSX 源码。
 * @param options.assumeOfficialGlobals fixture：将名字视为已从官方模块导入
 */
export function scanTypeScriptSource(
  fileLabel: string,
  script: string,
  offsetLine = 1,
  options?: { assumeOfficialGlobals?: string[] },
): ScanResult {
  const offenses: ScanOffense[] = [];
  const sf = ts.createSourceFile(
    fileLabel.endsWith(".tsx") ? fileLabel : fileLabel.replace(/\.vue$/, ".ts"),
    script,
    ts.ScriptTarget.Latest,
    true,
    fileLabel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const fileScope = createScope(null);
  collectImports(sf, fileScope);
  for (const name of options?.assumeOfficialGlobals ?? []) {
    if (OFFICIAL_PROJECT_ID_CONVERTERS.has(name)) {
      fileScope.officialNames.set(name, name);
    }
  }

  function visitStatementList(statements: readonly ts.Statement[], scope: Scope): void {
    for (const st of statements) visitStatement(st, scope);
  }

  function visitFunctionLike(
    params: readonly ts.ParameterDeclaration[],
    body: ts.ConciseBody | ts.Block | undefined,
    scope: Scope,
    name?: string,
  ): void {
    const fnScope = createScope(scope);
    for (const p of params) {
      if (ts.isIdentifier(p.name)) declareBinding(fnScope, p.name.text, "param");
    }
    if (body) {
      if (ts.isBlock(body)) visitStatementList(body.statements, fnScope);
      else visitExpression(body, fnScope);
    }
    if (name && body && functionReturnsSafeProjectId(fnScope, body as ts.ConciseBody)) {
      // 注册到父作用域：包装函数对同级可见
      scope.safeFactories.add(name);
    }
  }

  function visitStatement(st: ts.Statement, scope: Scope): void {
    if (ts.isFunctionDeclaration(st)) {
      const fname = st.name?.text;
      if (fname && (OFFICIAL_PROJECT_ID_CONVERTERS.has(fname) || scope.officialNames.has(fname))) {
        scope.shadowedConverters.add(fname);
        scope.officialNames.delete(fname);
      }
      if (st.body) {
        visitFunctionLike(st.parameters, st.body, scope, fname);
      }
      return;
    }

    if (ts.isVariableStatement(st)) {
      for (const decl of st.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          // const f = () => toLocalProjectId(...)
          if (
            decl.initializer &&
            (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
          ) {
            visitFunctionLike(
              decl.initializer.parameters,
              decl.initializer.body,
              scope,
              decl.name.text,
            );
            declareBinding(scope, decl.name.text, "other");
          } else {
            declareBinding(scope, decl.name.text, statusFromInitializer(scope, decl.initializer, sf));
            if (decl.initializer) visitExpression(decl.initializer, scope);
          }
        } else if (decl.initializer) {
          visitExpression(decl.initializer, scope);
        }
      }
      return;
    }

    if (ts.isExpressionStatement(st)) {
      if (
        ts.isBinaryExpression(st.expression) &&
        st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(st.expression.left)
      ) {
        assignBinding(
          scope,
          st.expression.left.text,
          statusFromInitializer(scope, st.expression.right, sf),
        );
      }
      visitExpression(st.expression, scope);
      return;
    }

    if (ts.isReturnStatement(st)) {
      if (st.expression) visitExpression(st.expression, scope);
      return;
    }

    if (ts.isIfStatement(st)) {
      visitExpression(st.expression, scope);
      visitStatement(st.thenStatement, scope);
      if (st.elseStatement) visitStatement(st.elseStatement, scope);
      return;
    }

    if (ts.isBlock(st)) {
      // 块作用域：const/let 隔离；赋值仍上溯
      const blockScope = createScope(scope);
      visitStatementList(st.statements, blockScope);
      return;
    }

    if (ts.isTryStatement(st)) {
      // try 块不新建绑定隔离层用于「赋值上溯」——仍用 block 但 assignBinding 可写外层
      visitStatement(st.tryBlock, scope);
      if (st.catchClause) visitStatement(st.catchClause.block, scope);
      if (st.finallyBlock) visitStatement(st.finallyBlock, scope);
      return;
    }

    ts.forEachChild(st, (child) => {
      if (ts.isStatement(child)) visitStatement(child, scope);
      else visitExpression(child as ts.Expression, scope);
    });
  }

  function visitExpression(node: ts.Node, scope: Scope): void {
    if (!node) return;

    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      visitFunctionLike(node.parameters, node.body, scope);
      return;
    }

    if (ts.isCallExpression(node) && isAxiosPostCall(node) && node.arguments.length >= 2) {
      const body = node.arguments[1];
      if (isLocalProjectBodyCall(scope, body)) {
        // 整包安全
      } else if (ts.isObjectLiteralExpression(body)) {
        checkObjectLiteral(scope, body, "axios.post", sf, offsetLine, offenses);
      } else if (ts.isIdentifier(body)) {
        const st = lookupBinding(scope, body.text);
        // 仅当 body 变量被证明含裸 projectId 时报告（fixture bodyVariable）
        if (st === "unsafe_project") {
          offenses.push({
            line: lineOf(sf, body, offsetLine),
            context: "axios.post",
            message: `请求体变量 ${body.text} 未证明仅含官方边界 projectId（状态=${st}）`,
          });
        }
      }
      // formData.value / 其它表达式：无 projectId 键可检查则跳过
    }

    if (ts.isPropertyAssignment(node)) {
      const key = ts.isIdentifier(node.name)
        ? node.name.text
        : ts.isStringLiteral(node.name)
          ? node.name.text
          : "";
      if (key === "auth") {
        inspectAuthInitializer(node.initializer, scope);
      }
    }

    ts.forEachChild(node, (c) => visitExpression(c, scope));
  }

  function inspectAuthInitializer(init: ts.Expression, scope: Scope): void {
    const inspectExpr = (exp: ts.Expression, s: Scope) => {
      let e = exp;
      if (ts.isParenthesizedExpression(e)) e = e.expression;
      if (ts.isObjectLiteralExpression(e)) {
        checkObjectLiteral(s, e, "socket.auth", sf, offsetLine, offenses);
      }
    };

    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
      const fnScope = createScope(scope);
      for (const p of init.parameters) {
        if (ts.isIdentifier(p.name)) declareBinding(fnScope, p.name.text, "param");
      }
      const body = init.body;
      if (ts.isBlock(body)) {
        visitStatementList(body.statements, fnScope);
        const rets: ts.Expression[] = [];
        collectNestedReturns(body, rets);
        for (const r of rets) inspectExpr(r, fnScope);
      } else {
        inspectExpr(body, fnScope);
      }
      return;
    }
    inspectExpr(init, scope);
  }

  visitStatementList(sf.statements, fileScope);

  return {
    offenses: offenses.map((o) => ({
      ...o,
      message: `${fileLabel}:${o.line} [${o.context}] ${o.message}`,
    })),
  };
}

export function formatOffenses(result: ScanResult): string[] {
  return result.offenses.map((o) => o.message);
}
