import { t, isPure, isPrivateBinding, isLiteral, memberKey, forEachScope } from "../ast.js";

/**
 * Deletes unreferenced private bindings whose initializer has no side effects, repeating until
 * nothing changes. Program-scope names are kept unless obfuscator-generated (they may be globals).
 */
export function removeDeadBindings(program) {
  let changed = false;
  for (let again = true; again; ) {
    again = false;
    program.scope.crawl();
    forEachScope(program, (scope) => {
      for (const binding of Object.values(scope.bindings)) {
        if (binding.referenced || !isPrivateBinding(binding)) continue;
        if (binding.constantViolations.length > 0 && !binding.constantViolations.every(isRemovableAssignment)) continue;
        if (!removeDeclaration(binding)) continue;
        for (const v of binding.constantViolations) removeAssignment(v);
        again = changed = true;
      }
    });
  }
  return changed;
}

function removeDeclaration(binding) {
  const p = binding.path;
  if (p.removed) return false;
  if (binding.kind === "hoisted" && p.isFunctionDeclaration()) {
    p.remove();
    return true;
  }
  if (p.isVariableDeclarator() && t.isIdentifier(p.node.id) && isPure(p.node.init, p.scope)) {
    // A `for (let i = 0; …)` init can't lose its only declarator.
    if (p.parentPath.parentPath.isFor() && p.parent.declarations.length === 1) return false;
    p.remove();
    return true;
  }
  return false;
}

const isRemovableAssignment = (p) =>
  p.isAssignmentExpression({ operator: "=" }) && p.parentPath.isExpressionStatement() && isPure(p.node.right, p.scope);

function removeAssignment(p) {
  if (!p.removed) p.parentPath.remove();
}

/** Drops unreachable code after return/throw/break/continue and empty statements. */
export function removeUnreachable(program) {
  let changed = false;
  program.traverse({
    "BlockStatement|Program"(path) {
      const body = path.get("body");
      const end = body.findIndex((s) => s.isReturnStatement() || s.isThrowStatement() || s.isBreakStatement() || s.isContinueStatement());
      if (end === -1) return;
      for (const s of body.slice(end + 1)) {
        if (s.isFunctionDeclaration() || (s.isVariableDeclaration({ kind: "var" }))) continue;
        s.remove();
        changed = true;
      }
    },
    EmptyStatement(path) {
      if (path.parentPath.isBlockStatement() || path.parentPath.isProgram()) {
        path.remove();
        changed = true;
      }
    },
  });
  return changed;
}

/** `a["b"]` → `a.b`, `{ "b": 1 }` → `{ b: 1 }`, `!0`/`!1`/`!![]`/`![]` → booleans, `void 0` → undefined. */
export function tidy(program) {
  let changed = false;
  program.traverse({
    MemberExpression(path) {
      const key = path.node.computed && t.isStringLiteral(path.node.property) ? path.node.property.value : null;
      if (key !== null && t.isValidIdentifier(key, false)) {
        path.node.property = t.identifier(key);
        path.node.computed = false;
        changed = true;
      }
    },
    "ObjectProperty|ObjectMethod|ClassMethod|ClassProperty"(path) {
      const { key } = path.node;
      if (path.node.computed && !t.isStringLiteral(key)) return;
      if (t.isStringLiteral(key) && t.isValidIdentifier(key.value, false)) {
        path.node.key = t.identifier(key.value);
        path.node.computed = false;
        changed = true;
      }
    },
    UnaryExpression: {
      exit(path) {
        const { operator, argument } = path.node;
        if (operator === "!" && (t.isArrayExpression(argument) || t.isObjectExpression(argument)) && isPure(argument, path.scope)) {
          path.replaceWith(t.booleanLiteral(false));
          changed = true;
        } else if (operator === "!" && t.isNumericLiteral(argument)) {
          path.replaceWith(t.booleanLiteral(!argument.value));
          changed = true;
        } else if (operator === "!" && t.isBooleanLiteral(argument)) {
          path.replaceWith(t.booleanLiteral(!argument.value));
          changed = true;
        } else if (operator === "void" && isLiteral(argument) && path.scope.getBinding("undefined") === undefined) {
          path.replaceWith(t.identifier("undefined"));
          changed = true;
        }
      },
    },
    NumericLiteral(path) {
      // Drop the raw hex spelling so the generator prints decimal.
      if (path.node.extra?.raw && /^0x/i.test(path.node.extra.raw)) {
        delete path.node.extra;
        changed = true;
      }
    },
    StringLiteral(path) {
      if (path.node.extra) {
        delete path.node.extra;
        changed = true;
      }
    },
  });
  return changed;
}

/** `(a = 1, b = 2);` as a statement → two statements; `return a, b` → `a; return b`. */
export function splitSequences(program) {
  let changed = false;
  program.traverse({
    ExpressionStatement(path) {
      const expr = path.node.expression;
      if (!t.isSequenceExpression(expr) || !canHoldStatements(path)) return;
      path.replaceWithMultiple(expr.expressions.map((e) => t.expressionStatement(e)));
      changed = true;
    },
    ReturnStatement(path) {
      const expr = path.node.argument;
      if (!t.isSequenceExpression(expr) || !canHoldStatements(path)) return;
      const last = expr.expressions.at(-1);
      path.replaceWithMultiple([...expr.expressions.slice(0, -1).map((e) => t.expressionStatement(e)), t.returnStatement(last)]);
      changed = true;
    },
    VariableDeclaration(path) {
      // `const a = 1, b = 2;` → one declaration per line (not in for-heads).
      if (path.node.declarations.length < 2 || !canHoldStatements(path)) return;
      path.replaceWithMultiple(path.node.declarations.map((d) => t.variableDeclaration(path.node.kind, [d])));
      changed = true;
    },
  });
  return changed;
}

const canHoldStatements = (path) => path.parentPath.isBlockStatement() || path.parentPath.isProgram() || path.parentPath.isSwitchCase();

export { memberKey };
