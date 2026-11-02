import { t, isLiteral, memberKey, propertyKey, cloneReplacing } from "../ast.js";

/**
 * Rebuilds objects that javascript-obfuscator splits into `const x = {}; x["a"] = 1; x["b"] = 2;`
 * back into one literal. Only runs while the following statements assign fresh keys to `x`.
 */
export function mergeObjectAssignments(program) {
  let changed = false;
  program.traverse({
    VariableDeclarator(path) {
      const { id, init } = path.node;
      if (!t.isIdentifier(id) || !t.isObjectExpression(init) || init.properties.length > 0) return;
      const decl = path.parentPath;
      if (decl.node.declarations.at(-1) !== path.node || !(decl.parentPath.isProgram() || decl.parentPath.isBlockStatement())) return;
      const binding = path.scope.getBinding(id.name);
      if (!binding) return;
      const seen = new Set();
      let next = decl.getSibling(decl.key + 1);
      while (next.node) {
        const exprs = statementAssignments(next);
        if (!exprs) break;
        const props = [];
        for (const e of exprs) {
          const prop = assignmentProperty(e, binding, seen);
          if (!prop) break;
          props.push(prop);
        }
        if (props.length !== exprs.length) break;
        init.properties.push(...props);
        const current = next;
        next = next.getSibling(next.key + 1);
        current.remove();
        changed = true;
      }
    },
  });
  if (changed) program.scope.crawl();
  return changed;
}

function statementAssignments(stmt) {
  if (!stmt.isExpressionStatement()) return null;
  const e = stmt.get("expression");
  return e.isSequenceExpression() ? e.get("expressions") : [e];
}

function assignmentProperty(expr, binding, seen) {
  if (!expr.isAssignmentExpression({ operator: "=" })) return null;
  const { left, right } = expr.node;
  if (!t.isMemberExpression(left) || !t.isIdentifier(left.object, { name: binding.identifier.name })) return null;
  if (expr.scope.getBinding(left.object.name) !== binding) return null;
  const key = memberKey(left);
  if (key === null || seen.has(key)) return null;
  // The value must not read the object being built (it isn't complete yet). Scope-aware:
  // obfuscators reuse the object's name for parameters, which don't count.
  if (readsBinding(expr.get("right"), binding)) return null;
  seen.add(key);
  return t.objectProperty(t.isValidIdentifier(key, false) ? t.identifier(key) : t.stringLiteral(key), right);
}

function readsBinding(path, binding) {
  let found = path.isIdentifier() && path.scope.getBinding(path.node.name) === binding;
  path.traverse({
    ReferencedIdentifier(p) {
      if (p.scope.getBinding(p.node.name) === binding) {
        found = true;
        p.stop();
      }
    },
  });
  return found;
}

/**
 * Inlines "proxy objects": `const p = { abc: "str", xyz: function(a, b) { return a + b; } }`.
 * Each `p.abc` becomes the string and `p.xyz(x, y)` becomes `x + y`. The object must be
 * a const (or never reassigned), its properties unique, and every use a static member read.
 */
export function inlineProxyObjects(program) {
  let changed = false;
  program.scope.crawl();
  program.traverse({
    VariableDeclarator(path) {
      const { id, init } = path.node;
      if (!t.isIdentifier(id) || !t.isObjectExpression(init) || init.properties.length === 0) return;
      const binding = path.scope.getBinding(id.name);
      if (!binding || !binding.constant) return;
      const entries = proxyEntries(init);
      if (!entries) return;

      // `const q = p;` aliases are folded into p first.
      const refs = collectRefs(binding);
      if (!refs) return;
      // Innermost first: `p.a(p.b(x))` must inline p.b before p.a clones its arguments.
      for (const ref of refs.reverse()) {
        const member = ref.parentPath;
        const entry = entries.get(memberKey(member.node));
        if (!entry) continue;
        if (entry.kind === "value") {
          if (isWriteTarget(member)) continue;
          member.replaceWith(t.cloneNode(entry.node, true));
          changed = true;
        } else if (member.parentPath.isCallExpression({ callee: member.node })) {
          const replacement = inlineCall(entry, member.parent.arguments);
          if (replacement) {
            member.parentPath.replaceWith(replacement);
            changed = true;
          }
        }
      }
    },
  });
  if (changed) program.scope.crawl();
  return changed;
}

/** Map from key to `{kind: "value", node}` or `{kind: "fn", params, body}`; null if any property is unusable. */
function proxyEntries(obj) {
  const entries = new Map();
  for (const prop of obj.properties) {
    if (!t.isObjectProperty(prop) || prop.computed && !t.isStringLiteral(prop.key)) return null;
    const key = propertyKey(prop);
    if (key === null || entries.has(key)) return null;
    const value = prop.value;
    if (isLiteral(value)) {
      entries.set(key, { kind: "value", node: value });
    } else if (t.isFunctionExpression(value) || t.isArrowFunctionExpression(value)) {
      const fn = proxyFunction(value);
      // A function we can't inline is fine; it stays as a normal method.
      if (fn) entries.set(key, fn);
    } else {
      return null;
    }
  }
  return entries;
}

/** `function(a, b) { return <expr using a, b once each, or a call a(b…)>; }` */
function proxyFunction(fn) {
  if (fn.async || fn.generator || !fn.params.every((p) => t.isIdentifier(p))) return null;
  let body = fn.body;
  if (t.isBlockStatement(body)) {
    if (body.body.length !== 1 || !t.isReturnStatement(body.body[0]) || !body.body[0].argument) return null;
    body = body.body[0].argument;
  }
  const names = fn.params.map((p) => p.name);
  const counts = new Map(names.map((n) => [n, 0]));
  let foreign = false;
  const visit = (node, parent) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach((n) => visit(n, parent));
    if (t.isIdentifier(node)) {
      if (counts.has(node.name)) counts.set(node.name, counts.get(node.name) + 1);
      else foreign = true;
      return;
    }
    if (t.isMemberExpression(node) && !node.computed) return visit(node.object, node);
    if (t.isFunction(node) || t.isThisExpression(node)) {
      foreign = true;
      return;
    }
    for (const k of t.VISITOR_KEYS[node.type] ?? []) visit(node[k], node);
  };
  visit(body, null);
  if (foreign) return null;
  // Each param exactly once keeps argument evaluation order and count.
  if ([...counts.values()].some((c) => c !== 1)) return null;
  const isShape = t.isBinaryExpression(body) || t.isLogicalExpression(body) || t.isCallExpression(body) || t.isNewExpression(body);
  if (!isShape) return null;
  if (!paramsInOrder(body, names)) return null;
  return { kind: "fn", params: fn.params.map((p) => p.name), body };
}

/** Params appear left-to-right in evaluation order, so inlining keeps argument side-effect order. */
function paramsInOrder(body, names) {
  const order = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (t.isIdentifier(node)) return void order.push(node.name);
    if (t.isMemberExpression(node) && !node.computed) return visit(node.object);
    for (const k of t.VISITOR_KEYS[node.type] ?? []) visit(node[k]);
  };
  visit(body);
  return order.every((n, i) => n === names[i]);
}

function inlineCall(entry, args) {
  if (args.length !== entry.params.length || args.some((a) => t.isSpreadElement(a))) return null;
  const byName = new Map(entry.params.map((p, i) => [p, args[i]]));
  const replacements = new Map();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (t.isIdentifier(node) && byName.has(node.name)) return void replacements.set(node, byName.get(node.name));
    if (t.isMemberExpression(node) && !node.computed) return visit(node.object);
    for (const k of t.VISITOR_KEYS[node.type] ?? []) visit(node[k]);
  };
  visit(entry.body);
  return cloneReplacing(entry.body, replacements);
}

/** Reference paths of the proxy object, following `const alias = p` chains. Null if any use isn't a static member read. */
function collectRefs(binding, depth = 0) {
  if (depth > 10) return null;
  const out = [];
  for (const ref of binding.referencePaths) {
    const parent = ref.parentPath;
    if (parent.isMemberExpression({ object: ref.node }) && memberKey(parent.node) !== null) {
      // Any write means the object is real state, not a lookup table.
      if (isWriteTarget(parent)) return null;
      out.push(ref);
      continue;
    }
    if (parent.isVariableDeclarator({ init: ref.node }) && t.isIdentifier(parent.node.id)) {
      const alias = parent.scope.getBinding(parent.node.id.name);
      if (!alias || !alias.constant) return null;
      const aliasRefs = collectRefs(alias, depth + 1);
      if (!aliasRefs) return null;
      out.push(...aliasRefs);
      continue;
    }
    return null;
  }
  return out;
}

function isWriteTarget(member) {
  const p = member.parentPath;
  return (
    (p.isAssignmentExpression() && p.node.left === member.node) ||
    p.isUpdateExpression() ||
    (p.isUnaryExpression({ operator: "delete" }))
  );
}
