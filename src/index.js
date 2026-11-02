import { parse, generate, programPath } from "./ast.js";
import { Sandbox } from "./sandbox.js";
import { decodeStringArrays } from "./passes/strings.js";
import { mergeObjectAssignments, inlineProxyObjects } from "./passes/proxies.js";
import { foldConstants } from "./passes/fold.js";
import { removeDeadBindings, removeUnreachable, splitSequences, tidy } from "./passes/cleanup.js";
import { renameIdentifiers } from "./passes/rename.js";

const MAX_ROUNDS = 20;

/**
 * Deobfuscates `code`. Pass a shared `sandbox` when processing many files; otherwise one is
 * created and closed per call.
 */
export async function deobfuscate(code, { sandbox, rename = true } = {}) {
  const own = !sandbox;
  sandbox ??= new Sandbox();
  try {
    const ast = parse(code);
    const program = programPath(ast);
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let changed = false;
      changed = foldConstants(program) || changed;
      changed = mergeObjectAssignments(program) || changed;
      changed = (await decodeStringArrays(program, sandbox)) || changed;
      changed = foldConstants(program) || changed;
      changed = inlineProxyObjects(program) || changed;
      changed = removeUnreachable(program) || changed;
      changed = removeDeadBindings(program) || changed;
      if (!changed) break;
    }
    splitSequences(program);
    tidy(program);
    if (rename) {
      program.scope.crawl();
      renameIdentifiers(program);
    }
    return generate(ast) + "\n";
  } finally {
    if (own) sandbox.close();
  }
}

export { Sandbox };
