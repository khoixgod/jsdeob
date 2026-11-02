import { t, generateCompact as generate, isConstExpr, cloneReplacing } from "../ast.js";
import { removeDeadBindings } from "./cleanup.js";

/**
 * Decodes obfuscator.io string arrays: finds each array source, its decoder functions and the
 * rotation IIFE, runs them in the sandbox, and replaces every decoder call with its string.
 * Wrapper functions and aliases around the decoders are resolved statically first.
 * A group's machinery is removed only when nothing outside it still references it.
 * All groups share one program traversal and one dead-code sweep, so bundles with
 * hundreds of arrays stay linear in size.
 */
export async function decodeStringArrays(program, sandbox) {
  program.scope.crawl();
  const top = program.get("body");
  const groups = [];
  const byDecoder = new Map();
  const machineryNodes = new Set();
  for (const source of findArraySources(top)) {
    const users = topLevelUsers(source.binding, source.path);
    const decoders = users.filter((s) => isDecoder(s, source.binding));
    if (decoders.length === 0) continue;
    const rotations = users.filter((s) => isRotation(s, source.binding));
    // Every other top-level user of the array must be a decoder or the rotation. An unrecognized
    // user may reorder the array (a rotation we missed), and decoding without it yields garbage.
    if (users.some((u) => !decoders.includes(u) && !rotations.includes(u))) continue;
    const group = { source, decoders, rotations, sites: [] };
    group.machinery = [source.path, ...group.decoders, ...group.rotations];
    for (const p of group.machinery) machineryNodes.add(p.node);
    for (const d of decoders) byDecoder.set(program.scope.getBinding(d.node.id.name), group);
    groups.push(group);
  }
  if (groups.length === 0) return false;

  const decoderBindings = new Set(byDecoder.keys());
  program.traverse({
    enter(path) {
      if (machineryNodes.has(path.node)) path.skip();
    },
    CallExpression(path) {
      const call = resolveCall(path.node, path.scope, decoderBindings, 0);
      if (!call) return;
      const group = byDecoder.get(program.scope.getBinding(call.callee.name));
      group.sites.push({ path, code: generate(call) });
    },
  });

  // Groups are independent: send them all at once so the sandbox pool runs them in parallel.
  // Replacements are applied after every batch returns, so no AST change races a traversal.
  const active = groups.filter((g) => g.sites.length > 0);
  const outcomes = await Promise.all(
    active.map((group) => {
      const setup = group.machinery.map((p) => generate(p.node)).join("\n");
      return sandbox.decode(setup, group.sites.map((s) => s.code)).catch(() => null);
    }),
  );
  let changed = false;
  active.forEach((group, g) => {
    const results = outcomes[g];
    if (!results) return;
    group.sites.forEach((site, i) => {
      if (results[i] == null) return;
      site.path.replaceWith(t.stringLiteral(results[i]));
      changed = true;
    });
  });

  // Aliases of the decoders are now dead; drop them before checking for remaining uses.
  if (removeDeadBindings(program)) changed = true;
  for (const group of groups) {
    const machinery = group.machinery.filter((p) => !p.removed);
    // removeDeadBindings re-crawled the scope, so look the bindings up again by name.
    const names = [group.source.binding, ...group.decoders.map((d) => ({ identifier: d.node.id }))].map((b) => b.identifier.name);
    const used = names.some((n) => program.scope.getBinding(n)?.referencePaths.some((r) => !insideAny(r, machinery)));
    if (used) continue;
    for (const p of machinery) p.remove();
    changed = true;
  }
  return changed;
}

/** `function A(){ const k=[...strings]; A=function(){return k}; return A(); }` or `var A = [...strings]`. */
function findArraySources(top) {
  const out = [];
  for (const path of top) {
    if (path.isFunctionDeclaration()) {
      const name = path.node.id.name;
      const body = path.node.body.body;
      const hasArray = body.some(
        (s) => t.isVariableDeclaration(s) && s.declarations.some((d) => isStringArray(d.init)),
      );
      // `A = function(){…}; return A();` or minified `return (A = function(){…})();`
      const reassignsSelf = body.some((s) => {
        const e = t.isExpressionStatement(s) ? s.expression : t.isReturnStatement(s) && t.isCallExpression(s.argument) ? s.argument.callee : null;
        return t.isAssignmentExpression(e) && t.isIdentifier(e.left, { name });
      });
      if (hasArray && reassignsSelf) out.push({ path, binding: path.scope.parent.getBinding(name) });
    } else if (path.isVariableDeclaration() && path.node.declarations.length === 1) {
      const decl = path.node.declarations[0];
      if (t.isIdentifier(decl.id) && isStringArray(decl.init)) {
        out.push({ path, binding: path.scope.getBinding(decl.id.name) });
      }
    }
  }
  return out.filter((s) => s.binding);
}

const isStringArray = (node) =>
  t.isArrayExpression(node) && node.elements.length > 0 && node.elements.every((e) => t.isStringLiteral(e));

function referencesBinding(path, binding) {
  return binding.referencePaths.some((r) => r.isDescendant(path));
}

/** Distinct top-level statements (other than `self`) containing a reference to `binding`. */
function topLevelUsers(binding, self) {
  const users = new Set();
  for (const ref of binding.referencePaths) {
    let p = ref;
    while (p.parentPath && !p.parentPath.isProgram()) p = p.parentPath;
    if (p !== self && p.node !== self.node) users.add(p);
  }
  return [...users];
}

/**
 * obfuscator.io decoder: a function declaration whose body starts by shifting its first param
 * (`i = i - 0x1e3` or `i -= 399`) and then indexes the array returned by `A()` or `A`.
 * Ordinary code that merely reads a string-array constant fails this shape.
 */
function isDecoder(path, binding) {
  if (!path.isFunctionDeclaration() || path.node.params.length < 1 || !t.isIdentifier(path.node.params[0])) return false;
  const [first] = path.node.body.body;
  const index = path.node.params[0].name;
  const e = t.isExpressionStatement(first) ? first.expression : null;
  if (!t.isAssignmentExpression(e) || !t.isIdentifier(e.left, { name: index })) return false;
  if (e.operator === "=" && !(t.isBinaryExpression(e.right, { operator: "-" }) && t.isIdentifier(e.right.left, { name: index }))) return false;
  if (e.operator !== "=" && e.operator !== "-=") return false;
  return path.node.body.body.length <= 12 && referencesBinding(path, binding);
}

/**
 * The rotation IIFE: `(function(arr, n){ … })(A, 0x1234)` or the minified
 * `!function(){ const c = A(); for(;;) try{ … c.push(c.shift()) … } }()`, possibly behind `!`.
 */
function isRotation(path, binding) {
  if (!path.isExpressionStatement()) return false;
  let expr = path.node.expression;
  if (t.isUnaryExpression(expr)) expr = expr.argument;
  if (!t.isCallExpression(expr) || !(t.isFunctionExpression(expr.callee) || t.isArrowFunctionExpression(expr.callee))) return false;
  if (expr.arguments.some((a) => t.isIdentifier(a, { name: binding.identifier.name }))) return true;
  // Only reached for top-level IIFEs that reference the array, so generating them is cheap.
  return referencesBinding(path, binding) && /\.push\(\w+\.shift\(\)\)|\["push"\]\(\w+\["shift"\]\(\)\)/.test(generate(path.node));
}

const insideAny = (path, containers) => containers.some((c) => path === c || path.isDescendant(c));

/**
 * Rewrites a call through aliases and wrapper functions down to `decoder(constArgs)`, or null.
 * The returned node is a fresh tree; the input is not mutated.
 */
function resolveCall(node, scope, decoders, depth) {
  // `(alias = D)(…)` calls D. Replacing the call drops the assignment, so only do it when
  // nothing ever reads the alias.
  if (t.isAssignmentExpression(node.callee, { operator: "=" }) && t.isIdentifier(node.callee.left) && t.isIdentifier(node.callee.right)) {
    const alias = scope.getBinding(node.callee.left.name);
    if (!alias || alias.referencePaths.length > 0) return null;
    return resolveCall(t.callExpression(node.callee.right, node.arguments), scope, decoders, depth + 1);
  }
  if (depth > 20 || !t.isIdentifier(node.callee)) return null;
  if (!node.arguments.every((a) => isConstExpr(a))) return null;
  const binding = scope.getBinding(node.callee.name);
  if (!binding) return null;
  if (decoders.has(binding) && binding.constant) return t.callExpression(t.identifier(binding.identifier.name), node.arguments.map((a) => t.cloneNode(a, true)));

  const target = aliasTarget(binding);
  if (target) return resolveCall(t.callExpression(t.identifier(target.name), node.arguments), binding.path.scope, decoders, depth + 1);
  if (!binding.constant) return null;

  const wrapper = wrapperFunction(binding);
  if (!wrapper) return null;
  const replacements = new Map();
  wrapper.fn.params.forEach((param, i) => {
    replacements.set(param.name, node.arguments[i] ?? t.identifier("undefined"));
  });
  const inner = substituteParams(wrapper.call, replacements);
  if (!inner) return null;
  return resolveCall(inner, wrapper.scope, decoders, depth + 1);
}

/**
 * `const x = D` → the Identifier D. Also the minified `var x; … (x = D)(…)`: a declaration with
 * no initializer and exactly one plain assignment of an identifier, which must be a decoder.
 */
function aliasTarget(binding) {
  const p = binding.path;
  if (binding.constant) return p.isVariableDeclarator() && t.isIdentifier(p.node.init) ? p.node.init : null;
  if (!p.isVariableDeclarator() || p.node.init || binding.constantViolations.length !== 1) return null;
  const v = binding.constantViolations[0];
  return v.isAssignmentExpression({ operator: "=" }) && t.isIdentifier(v.node.right) ? v.node.right : null;
}

/** `function w(a, b) { return D(a - 1, b); }` (or the same as a const function expression). */
function wrapperFunction(binding) {
  const p = binding.path;
  let fn;
  let fnPath;
  if (p.isFunctionDeclaration()) {
    fn = p.node;
    fnPath = p;
  } else if (p.isVariableDeclarator() && (t.isFunctionExpression(p.node.init) || t.isArrowFunctionExpression(p.node.init))) {
    fn = p.node.init;
    fnPath = p.get("init");
  } else {
    return null;
  }
  if (!fn.params.every((x) => t.isIdentifier(x))) return null;
  let body = fn.body;
  if (t.isBlockStatement(body)) {
    if (body.body.length !== 1 || !t.isReturnStatement(body.body[0])) return null;
    body = body.body[0].argument;
  }
  if (!t.isCallExpression(body) || !t.isIdentifier(body.callee)) return null;
  // The callee is looked up from the wrapper's own scope; it must not be one of its params.
  if (fn.params.some((x) => x.name === body.callee.name)) return null;
  return { fn, call: body, scope: fnPath.scope };
}

/** Clones `call`, replacing parameter identifiers by name. Fails on any other free identifier in the args. */
function substituteParams(call, byName) {
  const replacements = new Map();
  let ok = true;
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (t.isIdentifier(node)) {
      if (byName.has(node.name)) replacements.set(node, byName.get(node.name));
      else ok = false;
      return;
    }
    for (const key of t.VISITOR_KEYS[node.type] ?? []) visit(node[key]);
  };
  visit(call.arguments);
  if (!ok) return null;
  const args = cloneReplacing(call.arguments, replacements);
  if (!args.every((a) => isConstExpr(a))) return null;
  return t.callExpression(t.identifier(call.callee.name), args);
}
