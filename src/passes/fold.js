import { t, isLiteral } from "../ast.js";

const BINARY = {
  "+": (a, b) => a + b,
  "-": (a, b) => a - b,
  "*": (a, b) => a * b,
  "/": (a, b) => a / b,
  "%": (a, b) => a % b,
  "**": (a, b) => a ** b,
  "|": (a, b) => a | b,
  "&": (a, b) => a & b,
  "^": (a, b) => a ^ b,
  "<<": (a, b) => a << b,
  ">>": (a, b) => a >> b,
  ">>>": (a, b) => a >>> b,
  "==": (a, b) => a == b,
  "!=": (a, b) => a != b,
  "===": (a, b) => a === b,
  "!==": (a, b) => a !== b,
  "<": (a, b) => a < b,
  "<=": (a, b) => a <= b,
  ">": (a, b) => a > b,
  ">=": (a, b) => a >= b,
};

const UNARY = {
  "-": (a) => -a,
  "+": (a) => +a,
  "~": (a) => ~a,
  "!": (a) => !a,
};

/** Literal value of a node, or `undefined` sentinel-free: returns `{ value }` or null. */
function literalValue(node) {
  if (t.isNumericLiteral(node) || t.isStringLiteral(node) || t.isBooleanLiteral(node)) return { value: node.value };
  if (t.isNullLiteral(node)) return { value: null };
  if (t.isUnaryExpression(node, { operator: "-" }) && t.isNumericLiteral(node.argument)) return { value: -node.argument.value };
  return null;
}

/** Node for a folded value; null for values that don't print as a short literal (NaN, Infinity, -0, huge strings). */
function valueNode(value) {
  if (typeof value === "string") return value.length <= 1000 ? t.stringLiteral(value) : null;
  if (typeof value === "boolean") return t.booleanLiteral(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) return null;
    return value < 0 ? t.unaryExpression("-", t.numericLiteral(-value)) : t.numericLiteral(value);
  }
  return null;
}

/**
 * Folds literal arithmetic and string concatenation (`0x1*-0x1cc7+…`, `"redu"+"ce"`), and
 * resolves `if`/`?:`/`&&`/`||` whose test is a literal.
 */
export function foldConstants(program) {
  let changed = false;
  program.traverse({
    BinaryExpression: {
      exit(path) {
        const fn = BINARY[path.node.operator];
        const a = literalValue(path.node.left);
        const b = literalValue(path.node.right);
        if (!fn || !a || !b) return;
        const node = valueNode(fn(a.value, b.value));
        if (!node) return;
        path.replaceWith(node);
        changed = true;
      },
    },
    UnaryExpression: {
      exit(path) {
        const { operator, argument } = path.node;
        const fn = UNARY[operator];
        if (!fn || (operator === "-" && t.isNumericLiteral(argument))) return;
        const a = literalValue(argument);
        if (!a) return;
        const node = valueNode(fn(a.value));
        if (!node) return;
        path.replaceWith(node);
        changed = true;
      },
    },
    IfStatement: {
      exit(path) {
        const test = literalValue(path.node.test);
        if (!test) return;
        const branch = test.value ? path.node.consequent : path.node.alternate;
        if (!branch) path.remove();
        else if (t.isBlockStatement(branch) && !hasLexical(branch)) path.replaceWithMultiple(branch.body);
        else path.replaceWith(branch);
        changed = true;
      },
    },
    ConditionalExpression: {
      exit(path) {
        const test = literalValue(path.node.test);
        if (!test) return;
        path.replaceWith(test.value ? path.node.consequent : path.node.alternate);
        changed = true;
      },
    },
    LogicalExpression: {
      exit(path) {
        const left = literalValue(path.node.left);
        if (!left) return;
        const { operator } = path.node;
        const keepLeft = operator === "&&" ? !left.value : operator === "||" ? Boolean(left.value) : left.value != null;
        path.replaceWith(keepLeft ? path.node.left : path.node.right);
        changed = true;
      },
    },
  });
  return changed;
}

const hasLexical = (block) =>
  block.body.some((s) => (t.isVariableDeclaration(s) && s.kind !== "var") || t.isClassDeclaration(s) || t.isFunctionDeclaration(s));

export { isLiteral };
