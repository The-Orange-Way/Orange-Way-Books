/**
 * Flag every `x | y` binary expression. Across this codebase, runtime
 * bitwise-OR is never intentional: every `|` ever introduced has been
 * a typo for `||` (logical OR / nullish default). Prior grep-based
 * sweeps caught the string-literal-RHS shape but missed boolean
 * comparisons and non-literal RHS like `direction | rawDir.toUpperCase()`.
 * An AST-based rule catches all of them.
 *
 * The general `no-bitwise` rule would also flag `&`, `^`, `<<`, `>>`,
 * `~`, which the codebase does use legitimately (e.g. `sample & 0x7ff`
 * in BIP-39 word extraction). This rule narrows to just `|`.
 *
 * The autofix rewrites `|` to `||`. A genuine bitwise-OR introduced
 * later must opt out per-line via
 * `// eslint-disable-next-line local/no-bitwise-or`.
 */
export default {
  meta: {
    type: 'problem',
    fixable: 'code',
    docs: {
      description: "disallow runtime bitwise-OR '|' (use '||' for logical OR / defaults)",
    },
    schema: [],
    messages: {
      bitwiseOr:
        "Bitwise '|' coerces both sides to 32-bit integers; this codebase uses '|' only as a typo for '||'. Use '||' or opt out with eslint-disable-next-line if this is a genuine bitwise op.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    return {
      BinaryExpression(node) {
        if (node.operator !== '|') return;
        context.report({
          node,
          messageId: 'bitwiseOr',
          fix(fixer) {
            const opToken = sourceCode.getTokenAfter(
              node.left,
              (t) => t.type === 'Punctuator' && t.value === '|',
            );
            if (!opToken) return null;
            return fixer.replaceText(opToken, '||');
          },
        });
      },
    };
  },
};
