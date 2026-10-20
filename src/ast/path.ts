/**
 * Mutable ESTree path + scope for oxc ASTs.
 */

import { visitorKeys } from "oxc-parser";
import type { Node } from "./node";
import * as t from "./types";

export type VisitorFn = (path: Path) => void;
export type Visitors = Record<
  string,
  VisitorFn | { enter?: VisitorFn; exit?: VisitorFn }
>;

export class Binding {
  identifier: t.Identifier;
  path: Path;
  kind: string;
  constant: boolean;
  referenced = false;
  referencePaths: Path[] = [];
  constantViolations: Path[] = [];

  constructor(identifier: t.Identifier, path: Path, kind: string) {
    this.identifier = identifier;
    this.path = path;
    this.kind = kind;
    this.constant =
      kind === "const" ||
      kind === "module" ||
      kind === "hoisted" ||
      kind === "param";
  }
}

export class Scope {
  path: Path;
  parent: Scope | null;
  bindings = new Map<string, Binding>();

  constructor(path: Path, parent: Scope | null = null) {
    this.path = path;
    this.parent = parent;
  }

  getBinding(name: string): Binding | undefined {
    let scope: Scope | null = this;
    while (scope) {
      const b = scope.bindings.get(name);
      if (b) return b;
      scope = scope.parent;
    }
    return undefined;
  }

  register(name: string, binding: Binding): void {
    this.bindings.set(name, binding);
  }

  crawl(): void {
    this.bindings.clear();
    seedScopeBindings(this);
    markReferences(this.path);
  }
}

export function singlePath(path: Path | Path[]): Path {
  if (Array.isArray(path)) {
    throw new Error("Expected a single NodePath");
  }
  return path;
}

function keysFor(node: Node): string[] {
  return (visitorKeys as Record<string, string[] | undefined>)[node.type] ?? [];
}

function isScopeNode(node: Node): boolean {
  return (
    t.isFunction(node) ||
    node.type === "Program" ||
    node.type === "BlockStatement" ||
    node.type === "CatchClause" ||
    node.type === "SwitchStatement" ||
    node.type === "ForStatement" ||
    node.type === "ForInStatement" ||
    node.type === "ForOfStatement"
  );
}

function lexicalScopeFor(kind: string, scope: Scope): Scope {
  if (kind !== "var") return scope;
  let current = scope;
  while (
    current.parent &&
    !t.isFunction(current.path.node) &&
    current.path.node.type !== "Program"
  ) {
    current = current.parent;
  }
  return current;
}

function registerVariableDeclaration(
  stmt: Node,
  stmtPath: Path,
  scope: Scope,
): void {
  if (!t.isVariableDeclaration(stmt)) return;
  const kind = String(stmt.kind);
  const target = lexicalScopeFor(kind, scope);
  const decls = stmt.declarations;
  for (let j = 0; j < decls.length; j++) {
    registerPattern(
      decls[j]!.id as Node,
      singlePath(stmtPath.get(`declarations.${j}`)),
      target,
      kind,
    );
  }
}

function isTypeOnlyImport(spec: Node, stmt: Node): boolean {
  const declarationKind = (stmt as { importKind?: string }).importKind;
  const specifierKind = (spec as { importKind?: string }).importKind;
  return declarationKind === "type" || specifierKind === "type";
}

function registerPattern(
  pattern: Node,
  bindingPath: Path,
  scope: Scope,
  kind: string,
): void {
  if (t.isIdentifier(pattern)) {
    scope.register(pattern.name, new Binding(pattern, bindingPath, kind));
    return;
  }
  if (t.isObjectPattern(pattern)) {
    for (const prop of (pattern.properties as Node[]) ?? []) {
      if (t.isRestElement(prop)) {
        registerPattern(prop.argument as Node, bindingPath, scope, kind);
      } else if (t.isObjectProperty(prop)) {
        let value = prop.value as Node;
        if (t.isAssignmentPattern(value)) value = value.left as Node;
        registerPattern(value, bindingPath, scope, kind);
      }
    }
    return;
  }
  if (t.isArrayPattern(pattern)) {
    for (const el of (pattern.elements as (Node | null)[]) ?? []) {
      if (!el) continue;
      if (t.isRestElement(el)) {
        registerPattern(el.argument as Node, bindingPath, scope, kind);
      } else if (t.isAssignmentPattern(el)) {
        registerPattern(el.left as Node, bindingPath, scope, kind);
      } else {
        registerPattern(el, bindingPath, scope, kind);
      }
    }
  }
}

function seedScopeBindings(scope: Scope): void {
  const path = scope.path;
  const node = path.node;

  if (t.isFunction(node)) {
    if (
      (node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression") &&
      t.isIdentifier(node.id)
    ) {
      scope.register(
        node.id.name,
        new Binding(node.id, singlePath(path.get("id")), "hoisted"),
      );
    }
    for (let i = 0; i < node.params.length; i++) {
      registerPattern(
        node.params[i]!,
        singlePath(path.get(`params.${i}`)),
        scope,
        "param",
      );
    }
  }

  if (node.type === "ForStatement" && t.isVariableDeclaration(node.init)) {
    registerVariableDeclaration(node.init, singlePath(path.get("init")), scope);
  }
  if (
    (node.type === "ForInStatement" || node.type === "ForOfStatement") &&
    t.isVariableDeclaration(node.left)
  ) {
    registerVariableDeclaration(node.left, singlePath(path.get("left")), scope);
  }
  if (
    node.type === "CatchClause" &&
    node.param &&
    typeof node.param === "object"
  ) {
    registerPattern(
      node.param as Node,
      singlePath(path.get("param")),
      scope,
      "const",
    );
  }
  if (node.type === "SwitchStatement") {
    const cases = (node.cases as Node[]) ?? [];
    for (let i = 0; i < cases.length; i++) {
      const consequent = ((cases[i] as { consequent?: Node[] }).consequent ??
        []) as Node[];
      const casePath = singlePath(path.get(`cases.${i}`));
      for (let j = 0; j < consequent.length; j++) {
        const stmt = consequent[j]!;
        if (!t.isVariableDeclaration(stmt)) continue;
        registerVariableDeclaration(
          stmt,
          singlePath(casePath.get(`consequent.${j}`)),
          scope,
        );
      }
    }
  }

  if (node.type === "Program" || node.type === "BlockStatement") {
    const body = (node.body as Node[]) ?? [];
    for (let i = 0; i < body.length; i++) {
      const stmt = body[i]!;
      const stmtPath = singlePath(path.get(`body.${i}`));
      if (t.isVariableDeclaration(stmt)) {
        registerVariableDeclaration(stmt, stmtPath, scope);
      } else if (t.isFunctionDeclaration(stmt) && t.isIdentifier(stmt.id)) {
        scope.register(
          stmt.id.name,
          new Binding(stmt.id, stmtPath, "hoisted"),
        );
      } else if (t.isClassDeclaration(stmt) && t.isIdentifier(stmt.id)) {
        scope.register(stmt.id.name, new Binding(stmt.id, stmtPath, "const"));
      } else if (t.isImportDeclaration(stmt)) {
        const specs = stmt.specifiers;
        for (let j = 0; j < specs.length; j++) {
          const spec = specs[j]!;
          if (isTypeOnlyImport(spec, stmt)) continue;
          if (
            t.isImportSpecifier(spec) ||
            t.isImportDefaultSpecifier(spec) ||
            t.isImportNamespaceSpecifier(spec)
          ) {
            const local = spec.local as t.Identifier;
            scope.register(
              local.name,
              new Binding(
                local,
                singlePath(stmtPath.get(`specifiers.${j}`)),
                "module",
              ),
            );
          }
        }
      } else if (
        stmt.type === "ExportNamedDeclaration" &&
        stmt.declaration &&
        t.isFunctionDeclaration(stmt.declaration) &&
        t.isIdentifier(stmt.declaration.id)
      ) {
        const fnId = stmt.declaration.id;
        scope.register(
          fnId.name,
          new Binding(
            fnId,
            singlePath(stmtPath.get("declaration")),
            "hoisted",
          ),
        );
      } else if (
        stmt.type === "ExportNamedDeclaration" &&
        stmt.declaration &&
        t.isClassDeclaration(stmt.declaration) &&
        t.isIdentifier(stmt.declaration.id)
      ) {
        const classId = stmt.declaration.id;
        scope.register(
          classId.name,
          new Binding(
            classId,
            singlePath(stmtPath.get("declaration")),
            "const",
          ),
        );
      } else if (
        stmt.type === "ExportNamedDeclaration" &&
        stmt.declaration &&
        t.isVariableDeclaration(stmt.declaration)
      ) {
        const decl = stmt.declaration;
        const kind = String(decl.kind);
        const decls = decl.declarations;
        const declPath = singlePath(stmtPath.get("declaration"));
        for (let j = 0; j < decls.length; j++) {
          registerPattern(
            decls[j]!.id as Node,
            singlePath(declPath.get(`declarations.${j}`)),
            scope,
            kind,
          );
        }
      }
    }
  }
}

function markReferences(root: Path): void {
  const stack: Path[] = [];
  const visit = (path: Path): void => {
    stack.push(path);
    if (t.isIdentifier(path.node) && path.isReferencedIdentifier()) {
      const binding = path.scope.getBinding(path.node.name);
      if (binding) {
        binding.referenced = true;
        binding.referencePaths.push(path);
      }
    }
    if (
      path.node.type === "AssignmentExpression" &&
      t.isIdentifier(path.node.left as Node)
    ) {
      const binding = path.scope.getBinding(
        (path.node.left as t.Identifier).name,
      );
      if (binding) {
        binding.constant = false;
        binding.constantViolations.push(path);
      }
    }
    if (path.node.type === "UpdateExpression" && t.isIdentifier(path.node.argument as Node)) {
      const binding = path.scope.getBinding(
        (path.node.argument as t.Identifier).name,
      );
      if (binding) {
        binding.constant = false;
        binding.constantViolations.push(path);
      }
    }

    for (const key of keysFor(path.node)) {
      const child = path.node[key];
      if (Array.isArray(child)) {
        for (let i = 0; i < child.length; i++) {
          const c = child[i];
          if (!c || typeof c !== "object" || !("type" in c)) continue;
          visit(childPath(path, key, i, c as Node));
        }
      } else if (
        child &&
        typeof child === "object" &&
        "type" in (child as object)
      ) {
        visit(childPath(path, key, null, child as Node));
      }
    }
    stack.pop();
  };
  visit(root);
}

function childPath(
  parent: Path,
  key: string,
  index: number | null,
  node: Node,
): Path {
  let scope = parent.scope;
  if (isScopeNode(node)) {
    scope = new Scope(parent, parent.scope);
  }
  let path: Path;
  if (index !== null) {
    path = new Path(
      node,
      parent.node,
      parent,
      index,
      parent.node[key] as Node[],
      key,
      scope,
    );
  } else {
    path = new Path(
      node,
      parent.node,
      parent,
      key,
      parent.node,
      null,
      scope,
    );
  }
  if (isScopeNode(node)) {
    scope.path = path;
    // Seed bindings for this scope before visiting children so nested
    // references resolve here instead of an outer binding.
    seedScopeBindings(scope);
  }
  return path;
}

export class Path {
  node: Node;
  parent: Node | null;
  parentPath: Path | null;
  key: string | number | null;
  container: Node | Node[] | null;
  listKey: string | null;
  scope: Scope;
  _skip = false;
  _stop = false;
  _removed = false;
  _hubEmpty = false;

  constructor(
    node: Node,
    parent: Node | null,
    parentPath: Path | null,
    key: string | number | null,
    container: Node | Node[] | null,
    listKey: string | null,
    scope?: Scope,
  ) {
    this.node = node;
    this.parent = parent;
    this.parentPath = parentPath;
    this.key = key;
    this.container = container;
    this.listKey = listKey;
    this.scope = scope ?? new Scope(this, parentPath?.scope ?? null);
  }

  skip(): void {
    this._skip = true;
  }
  stop(): void {
    this._stop = true;
  }
  get shouldSkip(): boolean {
    return this._skip;
  }
  get shouldStop(): boolean {
    return this._stop;
  }

  /** Resolve dotted path like `declaration.declarations.0` or `arguments`. */
  get(dotPath: string): Path | Path[] {
    const parts = dotPath.split(".");
    let current: Path | Path[] = this;
    for (const part of parts) {
      if (Array.isArray(current)) {
        current = current[Number(part)]!;
        continue;
      }
      const node = current.node;
      if (/^\d+$/.test(part)) {
        throw new Error(`Unexpected index without array at ${dotPath}`);
      }
      const value = node[part];
      if (Array.isArray(value)) {
        const paths: Path[] = [];
        for (let i = 0; i < value.length; i++) {
          const c = value[i];
          if (!c || typeof c !== "object" || !("type" in c)) continue;
          let childScope = current.scope;
          let childPath: Path;
          if (isScopeNode(c as Node)) {
            childScope = new Scope(current, current.scope);
            childPath = new Path(
              c as Node,
              node,
              current,
              i,
              value as Node[],
              part,
              childScope,
            );
            childScope.path = childPath;
            childScope.crawl();
          } else {
            childPath = new Path(
              c as Node,
              node,
              current,
              i,
              value as Node[],
              part,
              childScope,
            );
          }
          paths.push(childPath);
        }
        // Attach numeric index access for `argPaths[0]`
        current = paths;
        continue;
      }
      if (value && typeof value === "object" && "type" in (value as object)) {
        const childNode = value as Node;
        let childScope = current.scope;
        if (isScopeNode(childNode)) {
          childScope = new Scope(current, current.scope);
          // Temporary path for crawl seeding
          const tmp = new Path(
            childNode,
            node,
            current,
            part,
            node,
            null,
            childScope,
          );
          childScope.path = tmp;
          childScope.crawl();
          current = tmp;
        } else {
          current = new Path(
            childNode,
            node,
            current,
            part,
            node,
            null,
            childScope,
          );
        }
      } else {
        const empty = new Path(
          { type: "EmptyStatement" },
          node,
          current,
          part,
          node,
          null,
          current.scope,
        );
        empty._hubEmpty = true;
        current = empty;
      }
    }
    return current;
  }

  getFunctionParent(): Path | null {
    let cur: Path | null = this.parentPath;
    while (cur) {
      if (t.isFunction(cur.node)) return cur;
      cur = cur.parentPath;
    }
    return null;
  }

  findParent(pred: (p: Path) => boolean): Path | null {
    let cur: Path | null = this.parentPath;
    while (cur) {
      if (pred(cur)) return cur;
      cur = cur.parentPath;
    }
    return null;
  }

  replaceWith(replacement: Node): void {
    if (this.parent == null || this.key == null) {
      throw new Error("Cannot replace root");
    }
    if (Array.isArray(this.container) && typeof this.key === "number") {
      this.container[this.key] = replacement;
    } else if (typeof this.key === "string") {
      this.parent[this.key] = replacement;
    }
    this.node = replacement;
  }

  replaceWithMultiple(nodes: Node[]): void {
    if (!Array.isArray(this.container) || typeof this.key !== "number") {
      throw new Error("replaceWithMultiple requires a list path");
    }
    this.container.splice(this.key, 1, ...nodes);
    this._removed = true;
  }

  traverse(visitors: Visitors): void {
    // Match Babel: nested traverse visits children only, not this node.
    for (const key of keysFor(this.node)) {
      const child = this.node[key];
      if (Array.isArray(child)) {
        for (let i = 0; i < child.length; ) {
          const c = child[i];
          if (!c || typeof c !== "object" || !("type" in c)) {
            i += 1;
            continue;
          }
          const childP = new Path(
            c as Node,
            this.node,
            this,
            i,
            child as Node[],
            key,
            this.scope,
          );
          const stopped = traverseInner(childP, visitors, false);
          if (stopped || this.shouldStop) return;
          if (child[i] === c) i += 1;
        }
      } else if (
        child &&
        typeof child === "object" &&
        "type" in (child as object)
      ) {
        const childP = new Path(
          child as Node,
          this.node,
          this,
          key,
          this.node,
          null,
          this.scope,
        );
        const stopped = traverseInner(childP, visitors, false);
        if (stopped || this.shouldStop) return;
      }
    }
  }

  isReferencedIdentifier(): this is Path & { node: t.Identifier } {
    if (!t.isIdentifier(this.node)) return false;
    const parent = this.parent;
    if (!parent) return true;
    if (this.listKey === "params") return false;
    if (t.isVariableDeclarator(parent) && this.key === "id") return false;
    if (t.isFunction(parent) && this.key === "id") return false;
    if (
      (parent.type === "ClassDeclaration" ||
        parent.type === "ClassExpression") &&
      this.key === "id"
    )
      return false;
    if (
      (parent.type === "MethodDefinition" ||
        parent.type === "PropertyDefinition") &&
      this.key === "key" &&
      parent.computed !== true
    )
      return false;
    if (t.isFunction(parent) && this.key === "params") return false;
    if (
      (t.isImportSpecifier(parent) ||
        t.isImportDefaultSpecifier(parent) ||
        t.isImportNamespaceSpecifier(parent)) &&
      this.key === "local"
    )
      return false;
    if (
      t.isObjectProperty(parent) &&
      this.key === "key" &&
      !parent.computed &&
      !parent.shorthand
    )
      return false;
    if (
      t.isMemberExpression(parent) &&
      this.key === "property" &&
      !parent.computed
    )
      return false;
    if (parent.type === "Property" && this.key === "key" && !parent.computed)
      return false;
    if (t.isAssignmentPattern(parent) && this.key === "left") return false;
    if (t.isRestElement(parent)) {
      const gp = this.parentPath?.parent;
      if (gp && (t.isObjectPattern(gp) || t.isArrayPattern(gp))) return false;
    }
    // Binding names inside patterns
    if (t.isObjectPattern(parent) || t.isArrayPattern(parent)) return false;
    if (
      t.isObjectProperty(parent) &&
      this.key === "value" &&
      this.parentPath?.parent &&
      (t.isObjectPattern(this.parentPath.parent) ||
        t.isArrayPattern(this.parentPath.parent))
    )
      return false;
    if (
      t.isObjectProperty(parent) &&
      parent.shorthand &&
      (this.key === "key" || this.key === "value")
    ) {
      // shorthand property in ObjectExpression is a reference; in ObjectPattern is binding
      const gp = this.parentPath?.parent;
      if (gp && t.isObjectPattern(gp)) return false;
      return true;
    }
    if (parent.type === "CatchClause" && this.key === "param") return false;
    if (parent.type === "JSXAttribute" && this.key === "name") return false;
    if (
      (parent.type === "JSXOpeningElement" ||
        parent.type === "JSXClosingElement") &&
      this.key === "name"
    )
      return false;
    if (parent.type === "JSXMemberExpression" && this.key === "property")
      return false;
    return true;
  }

  isFunction(): boolean {
    return t.isFunction(this.node);
  }
  isIdentifier(opts?: { name?: string }): boolean {
    return t.isIdentifier(this.node, opts);
  }
  isLiteral(): boolean {
    return t.isLiteral(this.node);
  }
  isCallExpression(): boolean {
    return t.isCallExpression(this.node);
  }
  isOptionalCallExpression(): boolean {
    return t.isOptionalCallExpression(this.node);
  }
  isMemberExpression(): boolean {
    return t.isMemberExpression(this.node);
  }
  isOptionalMemberExpression(): boolean {
    return t.isOptionalMemberExpression(this.node);
  }
  isObjectProperty(opts?: { shorthand?: boolean }): boolean {
    if (!t.isObjectProperty(this.node)) return false;
    if (opts?.shorthand !== undefined)
      return this.node.shorthand === opts.shorthand;
    return true;
  }
  isObjectExpression(): boolean {
    return t.isObjectExpression(this.node);
  }
  isParenthesizedExpression(): boolean {
    return t.isParenthesizedExpression(this.node);
  }
  isIfStatement(): boolean {
    return this.node.type === "IfStatement";
  }
  isObjectPattern(): boolean {
    return t.isObjectPattern(this.node);
  }
  isArrayExpression(): boolean {
    return this.node.type === "ArrayExpression";
  }
  isArrayPattern(): boolean {
    return t.isArrayPattern(this.node);
  }
  isVariableDeclarator(): boolean {
    return t.isVariableDeclarator(this.node);
  }
  isVariableDeclaration(opts?: { kind?: string }): boolean {
    return t.isVariableDeclaration(this.node, opts);
  }
  isImportSpecifier(): boolean {
    return t.isImportSpecifier(this.node);
  }
  isImportDefaultSpecifier(): boolean {
    return t.isImportDefaultSpecifier(this.node);
  }
  isImportDeclaration(): boolean {
    return t.isImportDeclaration(this.node);
  }
  isJSXElement(): boolean {
    return t.isJSXElement(this.node);
  }
  isJSXFragment(): boolean {
    return t.isJSXFragment(this.node);
  }
  isJSXExpressionContainer(): boolean {
    return t.isJSXExpressionContainer(this.node);
  }
  isJSXAttribute(): boolean {
    return t.isJSXAttribute(this.node);
  }
  isBlockStatement(): boolean {
    return t.isBlockStatement(this.node);
  }
  isArrowFunctionExpression(): boolean {
    return t.isArrowFunctionExpression(this.node);
  }
  isFunctionExpression(): boolean {
    return t.isFunctionExpression(this.node);
  }
  isFunctionDeclaration(): boolean {
    return t.isFunctionDeclaration(this.node);
  }
  isSpreadElement(): boolean {
    return t.isSpreadElement(this.node);
  }
  isTemplateLiteral(): boolean {
    return t.isTemplateLiteral(this.node);
  }
  isTemplateElement(): boolean {
    return this.node.type === "TemplateElement";
  }
  isBinaryExpression(): boolean {
    return this.node.type === "BinaryExpression";
  }
  isLogicalExpression(): boolean {
    return this.node.type === "LogicalExpression";
  }
  isConditionalExpression(): boolean {
    return this.node.type === "ConditionalExpression";
  }
  isUnaryExpression(opts?: { operator?: string }): boolean {
    if (this.node.type !== "UnaryExpression") return false;
    if (opts?.operator !== undefined)
      return this.node.operator === opts.operator;
    return true;
  }
  isUpdateExpression(): boolean {
    return this.node.type === "UpdateExpression";
  }
  isAssignmentExpression(): boolean {
    return this.node.type === "AssignmentExpression";
  }
  isForInStatement(): boolean {
    return this.node.type === "ForInStatement";
  }
  isForOfStatement(): boolean {
    return this.node.type === "ForOfStatement";
  }
  isTSType(): boolean {
    return (
      this.node.type.startsWith("TS") &&
      !t.isTSAsExpression(this.node) &&
      !t.isTSTypeAssertion(this.node) &&
      !t.isTSNonNullExpression(this.node) &&
      !t.isTSSatisfiesExpression(this.node)
    );
  }
  isTSAsExpression(): boolean {
    return t.isTSAsExpression(this.node);
  }
  isTSTypeAssertion(): boolean {
    return t.isTSTypeAssertion(this.node);
  }
  isTSNonNullExpression(): boolean {
    return t.isTSNonNullExpression(this.node);
  }
  isTSSatisfiesExpression(): boolean {
    return t.isTSSatisfiesExpression(this.node);
  }
  isProgram(): boolean {
    return this.node.type === "Program";
  }

  assertExpression(): void {
    if (this._hubEmpty) throw new TypeError("Expected Expression");
    t.assertExpression(this.node);
  }
}

function aliasesFor(type: string): string[] {
  switch (type) {
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      return ["Function"];
    case "Property":
      return ["ObjectProperty"];
    case "Literal":
      return [];
    default:
      return [];
  }
}

function runVisitor(
  visitors: Visitors,
  type: string,
  path: Path,
  phase: "enter" | "exit",
): void {
  const names = [type, ...aliasesFor(type)];
  // Also match Babel-style compound keys: "FunctionDeclaration|VariableDeclarator"
  for (const key of Object.keys(visitors)) {
    if (key.includes("|")) {
      for (const part of key.split("|")) {
        if (part === type || aliasesFor(type).includes(part)) {
          names.push(key);
          break;
        }
      }
    }
  }
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const v = visitors[name];
    if (!v) continue;
    if (typeof v === "function") {
      if (phase === "enter") v(path);
    } else if (phase === "enter" && v.enter) {
      v.enter(path);
    } else if (phase === "exit" && v.exit) {
      v.exit(path);
    }
  }
  if (phase === "enter" && typeof visitors.enter === "function") {
    visitors.enter(path);
  }
}

function traverseInner(
  path: Path,
  visitors: Visitors,
  isRoot: boolean,
): boolean {
  void isRoot;
  if (isScopeNode(path.node) && path.parentPath) {
    const scoped = new Scope(path, path.parentPath.scope ?? null);
    path.scope = scoped;
    seedScopeBindings(scoped);
  }
  path._skip = false;
  runVisitor(visitors, path.node.type, path, "enter");
  if (path.shouldStop) return true;
  if (!path.shouldSkip && !path._removed) {
    for (const key of keysFor(path.node)) {
      const child = path.node[key];
      if (Array.isArray(child)) {
        const seen = new WeakSet<object>();
        for (let i = 0; i < child.length; ) {
          const c = child[i];
          if (!c || typeof c !== "object" || !("type" in c)) {
            i += 1;
            continue;
          }
          if (seen.has(c)) {
            i += 1;
            continue;
          }
          seen.add(c);
          const childP = new Path(
            c as Node,
            path.node,
            path,
            i,
            child as Node[],
            key,
            path.scope,
          );
          const stopped = traverseInner(childP, visitors, false);
          if (stopped || path.shouldStop) return true;
          if (child[i] === c) i += 1;
        }
      } else if (
        child &&
        typeof child === "object" &&
        "type" in (child as object)
      ) {
        const childP = new Path(
          child as Node,
          path.node,
          path,
          key,
          path.node,
          null,
          path.scope,
        );
        const stopped = traverseInner(childP, visitors, false);
        if (stopped || path.shouldStop) return true;
      }
    }
  }
  runVisitor(visitors, path.node.type, path, "exit");
  return path.shouldStop;
}

export type NodePath<N extends Node = Node> = Path & { node: N };
export type TraverseOptions = Visitors;

export function traverse(ast: Node, visitors: Visitors): void {
  const root = ast.type === "File" && ast.program ? ast.program : ast;
  const rootPath = new Path(root, null, null, null, null, null, undefined);
  rootPath.scope = new Scope(rootPath, null);
  rootPath.scope.crawl();
  traverseInner(rootPath, visitors, true);
}
