import { t, isObfuscatorName, isPrivateBinding, forEachScope } from "../ast.js";

/**
 * Renames obfuscator-generated (`_0x…`) bindings to role-based names: loop counters become
 * `index`, reduce accumulators `acc`, catch params `error`, and so on. Every new name is unique
 * across the whole program, so no rename can shadow or capture another binding.
 */
export function renameIdentifiers(program) {
  const taken = new Set();
  program.traverse({
    Identifier(path) {
      taken.add(path.node.name);
    },
  });
  const counters = new Map();
  const fresh = (base) => {
    for (let n = counters.get(base) ?? 1; ; n++) {
      const name = n === 1 ? base : `${base}${n}`;
      if (taken.has(name)) continue;
      counters.set(base, n + 1);
      taken.add(name);
      return name;
    }
  };

  // Decide every new name first, then rewrite in one traversal. `scope.rename` walks the
  // whole scope block per call, which is quadratic on large bundles.
  const plan = new Map();
  forEachScope(program, (scope) => {
    for (const [name, binding] of Object.entries(scope.bindings)) {
      // `_0x…` names always; 1–2 character names come from mangling.
      if (!isObfuscatorName(name) && name.length > 2) continue;
      if (!isPrivateBinding(binding) || binding.kind === "module") continue;
      plan.set(binding, { from: name, to: fresh(roleOf(binding)) });
    }
  });
  if (plan.size === 0) return false;

  program.traverse({
    Identifier(path) {
      const { node, parent } = path;
      // Labels live in their own namespace (`e: for…; continue e`).
      if (t.isLabeledStatement(parent) || t.isBreakStatement(parent) || t.isContinueStatement(parent)) return;
      // Scope tables still hold the old names until the crawl below.
      const binding = path.scope.getBinding(node.name);
      const entry = binding && plan.get(binding);
      if (!entry || node.name !== entry.from) return;
      if (!path.isReferencedIdentifier() && !path.isBindingIdentifier() && !isWriteTarget(path)) return;
      // `{ a }` / `const { a } = o`: the key keeps the old name, only the value is renamed.
      if (t.isObjectProperty(parent) && parent.shorthand && parent.value === node) {
        parent.shorthand = false;
        parent.key = t.identifier(entry.from);
      }
      node.name = entry.to;
    },
  });
  program.scope.crawl();
  return true;
}

/** `x = …`, `x++`, `[x] = …`, `for (x of …)`: identifiers Babel marks neither referenced nor binding. */
function isWriteTarget(path) {
  const p = path.parentPath;
  return p.isAssignmentExpression({ left: path.node }) || p.isUpdateExpression() || p.isArrayPattern() || p.isRestElement() || p.isAssignmentPattern({ left: path.node }) || (p.isObjectProperty({ value: path.node }) && p.parentPath.isObjectPattern()) || p.isForXStatement({ left: path.node });
}

function roleOf(binding) {
  const p = binding.path;
  if (binding.kind === "param") {
    if (p.parentPath?.isCatchClause?.() || p.isCatchClause?.()) return "error";
    const fn = p.isFunction() ? p : p.findParent((x) => x.isFunction());
    const call = fn?.parentPath;
    if (call?.isCallExpression() && t.isMemberExpression(call.node.callee)) {
      const method = memberName(call.node.callee);
      const index = fn.node.params.indexOf(binding.identifier);
      const roles = CALLBACK_PARAMS[method];
      if (roles && roles[index]) return roles[index];
    }
    return "arg";
  }
  if (binding.kind === "hoisted") return "func";
  if (p.isVariableDeclarator()) {
    const loop = p.parentPath.parentPath;
    if (loop.isForStatement() && loop.node.init === p.parent) return "index";
    if (loop.isForOfStatement() || loop.isForInStatement()) return loop.isForInStatement() ? "key" : "item";
    return roleOfValue(p.node.init);
  }
  return "value";
}

const CALLBACK_PARAMS = {
  reduce: ["acc", "item", "index", "array"],
  reduceRight: ["acc", "item", "index", "array"],
  map: ["item", "index", "array"],
  forEach: ["item", "index", "array"],
  filter: ["item", "index", "array"],
  find: ["item", "index", "array"],
  findIndex: ["item", "index", "array"],
  some: ["item", "index", "array"],
  every: ["item", "index", "array"],
  sort: ["a1", "b1"],
  then: ["result"],
  catch: ["error"],
  replace: ["match"],
};

function memberName(member) {
  if (!member.computed && t.isIdentifier(member.property)) return member.property.name;
  if (t.isStringLiteral(member.property)) return member.property.value;
  return null;
}

function roleOfValue(init) {
  if (!init) return "value";
  if (t.isArrayExpression(init)) return "arr";
  if (t.isObjectExpression(init)) return "obj";
  if (t.isStringLiteral(init) || t.isTemplateLiteral(init)) return "str";
  if (t.isNumericLiteral(init) || (t.isUnaryExpression(init, { operator: "-" }) && t.isNumericLiteral(init.argument))) return "num";
  if (t.isBooleanLiteral(init)) return "flag";
  if (t.isFunction(init)) return "func";
  if (t.isNewExpression(init) && t.isIdentifier(init.callee)) return lowerFirst(init.callee.name);
  if (t.isCallExpression(init) && t.isMemberExpression(init.callee)) {
    const name = memberName(init.callee);
    if (name && /^(get|create|make|build|load|read|parse)[A-Z]/.test(name)) return lowerFirst(name.replace(/^(get|create|make|build|load|read|parse)/, ""));
  }
  return "value";
}

const lowerFirst = (s) => {
  const name = s.charAt(0).toLowerCase() + s.slice(1);
  return t.isValidIdentifier(name, true) ? name : "value";
};
