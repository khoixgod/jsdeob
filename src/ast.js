import { parse as babelParse } from "@babel/parser";
import traverse from "@babel/traverse";
import { generate as babelGenerate } from "@babel/generator";
import * as t from "@babel/types";

export { traverse, t };

export function parse(code) {
  return babelParse(code, { sourceType: "unambiguous", allowReturnOutsideFunction: true });
}

export function generate(node) {
  return babelGenerate(node, { jsescOption: { minimal: true, quotes: "double" } }).code;
}

/**
 * Code for the sandbox. Compact like the obfuscator's own output: "self-defending" decoders
 * regex-test their source text and loop forever when it has been reformatted.
 */
export function generateCompact(node) {
  return babelGenerate(node, { compact: true, jsescOption: { minimal: true } }).code;
}
export function programPath(ast) {
  let program;
  traverse(ast, {
    Program(path) {
      program = path;
      path.stop();
    },
  });
  return program;
}

const OPAQUE = /^_0x[0-9a-f]+$/i;
export const isObfuscatorName = (name) => OPAQUE.test(name);

/** Calls `fn(scope)` for the program scope and every nested scope. `traverse({Scope})` skips the program. */
export function forEachScope(program, fn) {
  fn(program.scope);
  program.traverse({
    Scope(path) {
      fn(path.scope);
    },
  });
}

/**
 * Script top-level bindings are globals that other scripts may use, so passes only delete or
 * rename them when the name is obfuscator-generated. Module top-level bindings are private
 * unless exported.
 */
export const isPrivateBinding = (binding) => {
  const scope = binding.scope.path;
  if (scope.type !== "Program") return true;
  if (isObfuscatorName(binding.identifier.name)) return true;
  return scope.node.sourceType === "module" && !isExported(binding);
};

const isExported = (binding) =>
  binding.referencePaths.some((r) => r.parentPath.isExportSpecifier()) ||
  Boolean(binding.path.findParent((p) => p.isExportNamedDeclaration() || p.isExportDefaultDeclaration()));

export const isLiteral = (node) =>
  t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node) || t.isNullLiteral(node);

/** Literal-only expression tree: safe to evaluate anywhere, no identifiers. */
export function isConstExpr(node) {
  if (isLiteral(node)) return true;
  if (t.isUnaryExpression(node)) return node.operator !== "delete" && isConstExpr(node.argument);
  if (t.isBinaryExpression(node)) return node.operator !== "in" && node.operator !== "instanceof" && isConstExpr(node.left) && isConstExpr(node.right);
  if (t.isTemplateLiteral(node)) return node.expressions.length === 0;
  if (t.isArrayExpression(node)) return node.elements.every((e) => e && isConstExpr(e));
  return false;
}

/** Evaluating the expression has no side effects and cannot throw. */
export function isPure(node, scope) {
  if (!node) return true;
  if (isLiteral(node) || t.isRegExpLiteral(node)) return true;
  if (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) return true;
  if (t.isIdentifier(node)) return node.name === "undefined" || Boolean(scope.getBinding(node.name));
  if (t.isTemplateLiteral(node)) return node.expressions.length === 0;
  if (t.isUnaryExpression(node)) return ["!", "void", "typeof"].includes(node.operator) && isPure(node.argument, scope);
  if (t.isBinaryExpression(node)) return isConstExpr(node);
  if (t.isArrayExpression(node)) return node.elements.every((e) => e && !t.isSpreadElement(e) && isPure(e, scope));
  if (t.isObjectExpression(node)) {
    return node.properties.every(
      (p) => t.isObjectMethod(p) ? !p.computed : t.isObjectProperty(p) && !p.computed && isPure(p.value, scope),
    );
  }
  return false;
}

/** Static key of `a.b`, `a["b"]` or `{ b: … }`, or null if computed from a non-literal. */
export function staticKey(node, computed, key) {
  if (!computed && t.isIdentifier(key)) return key.name;
  if (t.isStringLiteral(key)) return key.value;
  if (t.isNumericLiteral(key)) return String(key.value);
  return null;
}

export const memberKey = (node) => staticKey(node, node.computed, node.property);
export const propertyKey = (prop) => staticKey(prop, prop.computed, prop.key);

/** Clones `node`, swapping every node found in `replacements` for a clone of its mapped node. */
export function cloneReplacing(node, replacements) {
  const hit = replacements.get(node);
  if (hit) return t.cloneNode(hit, true);
  if (Array.isArray(node)) return node.map((n) => cloneReplacing(n, replacements));
  if (!node || typeof node !== "object" || typeof node.type !== "string") return node;
  const out = t.cloneNode(node, false);
  for (const key of t.VISITOR_KEYS[node.type] ?? []) out[key] = cloneReplacing(node[key], replacements);
  return out;
}

/** The Identifier reference paths inside `path`, with their resolved bindings. */
export function freeReferences(path) {
  const refs = [];
  path.traverse({
    ReferencedIdentifier(p) {
      refs.push({ path: p, binding: p.scope.getBinding(p.node.name) });
    },
  });
  if (path.isReferencedIdentifier()) refs.push({ path, binding: path.scope.getBinding(path.node.name) });
  return refs;
}
