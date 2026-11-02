import { t, generate, isConstExpr, cloneReplacing } from "../ast.js";
import { removeDeadBindings } from "./cleanup.js";

/**
 * Decodes obfuscator.io string arrays: finds the array source, its decoder functions and the
 * rotation IIFE, runs them in the sandbox, and replaces every decoder call with its string.
 * Wrapper functions and aliases around the decoder are resolved statically first.
 * Only removes the machinery when every call site decoded.
 */
export async function decodeStringArrays(program, sandbox) {
  program.scope.crawl();
  const top = program.get("body");
  let changed = false;

  for (const source of findArraySources(top)) {
    const decoders = top.filter(
      (s) => s.isFunctionDeclaration() && s !== source.path && referencesBinding(s, source.binding),
    );
    if (decoders.length === 0) continue;
    const decoderBindings = new Set(decoders.map((d) => program.scope.getBinding(d.node.id.name)));
    const rotations = top.filter((s) => isRotation(s, source.binding));

    const sites = [];
    program.traverse({
      CallExpression(path) {
        if (insideAny(path, [source.path, ...decoders, ...rotations])) return;
        const call = resolveCall(path.node, path.scope, decoderBindings, 0);
        if (call) sites.push({ path, code: generate(call) });
      },
    });
    if (sites.length > 0) {
      const setup = [source.path, ...rotations, ...decoders].map((p) => generate(p.node)).join("\n");
      let results;
      try {
        results = await sandbox.decode(setup, sites.map((s) => s.code));
      } catch {
        continue;
      }
      sites.forEach((site, i) => {
        if (results[i] != null) site.path.replaceWith(t.stringLiteral(results[i]));
      });
      changed = true;
    }
    // Aliases of the decoder are now dead; drop them before checking for remaining uses.
    removeDeadBindings(program);
    const machinery = [source.path, ...decoders, ...rotations].filter((p) => !p.removed);
    // removeDeadBindings re-crawled the scope, so look the bindings up again.
    const names = [...decoderBindings, source.binding].map((b) => b.identifier.name);
    const used = names.some((n) => program.scope.getBinding(n)?.referencePaths.some((r) => !insideAny(r, machinery)));
    if (!used) {
      for (const p of machinery) p.remove();
      changed = true;
    }
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
      const reassignsSelf = body.some(
        (s) => t.isExpressionStatement(s) && t.isAssignmentExpression(s.expression) && t.isIdentifier(s.expression.left, { name }),
      );
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

/** `(function(arr, n){ … })(A, 0x1234)`, possibly behind `!`. */
function isRotation(path, binding) {
  if (!path.isExpressionStatement()) return false;
  let expr = path.node.expression;
  if (t.isUnaryExpression(expr)) expr = expr.argument;
  return (
    t.isCallExpression(expr) &&
    (t.isFunctionExpression(expr.callee) || t.isArrowFunctionExpression(expr.callee)) &&
    expr.arguments.some((a) => t.isIdentifier(a, { name: binding.identifier.name }))
  );
}

const insideAny = (path, containers) => containers.some((c) => path === c || path.isDescendant(c));

/**
 * Rewrites a call through aliases and wrapper functions down to `decoder(constArgs)`, or null.
 * The returned node is a fresh tree; the input is not mutated.
 */
function resolveCall(node, scope, decoders, depth) {
  if (depth > 20 || !t.isIdentifier(node.callee)) return null;
  if (!node.arguments.every((a) => isConstExpr(a))) return null;
  const binding = scope.getBinding(node.callee.name);
  if (!binding || !binding.constant) return null;
  if (decoders.has(binding)) return t.callExpression(t.identifier(binding.identifier.name), node.arguments.map((a) => t.cloneNode(a, true)));

  const target = aliasTarget(binding);
  if (target) return resolveCall(t.callExpression(t.identifier(target.name), node.arguments), binding.path.scope, decoders, depth + 1);

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

/** `const x = D` → the Identifier D. */
function aliasTarget(binding) {
  const p = binding.path;
  return p.isVariableDeclarator() && t.isIdentifier(p.node.init) ? p.node.init : null;
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
