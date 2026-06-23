/**
 * Flag `x | y` binary expressions where the operator is almost certainly
 * a typo for `||`. Two shapes coexist in this codebase:
 *
 *   - Typo for logical-OR: `direction | rawDir.toUpperCase()`,
 *     `data.field | ''`, `(t === 'revenue') | (t === 'income')`. RHS is
 *     anything other than a numeric literal. These silently coerce both
 *     sides to int32 and produce nonsense (often 0). Always wrong.
 *   - Intentional int32-cast idiom: `parseFloat(x) | 0`, `Number(x) | 0`,
 *     `something | 0xff`. RHS is a numeric literal. JavaScript's `| 0`
 *     is the standard way to truncate a float to a 32-bit integer; the
 *     codebase uses this for journal-entry line totals among other
 *     places. Replacing this with `||` is a semantic regression.
 *
 * Rule: report `|` only when the RHS is NOT a numeric literal.
 *
 * The general `no-bitwise` rule would also flag `&`, `^`, `<<`, `>>`,
 * `~`, which the codebase uses legitimately (e.g. `sample & 0x7ff` for
 * BIP-39 word extraction). This rule narrows to just `|` and only the
 * shape that has only ever been a bug.
 *
 * The autofix rewrites `|` to `||`. A genuine bitwise-OR against a
 * non-literal RHS introduced later must opt out per-line via
 * `// eslint-disable-next-line local/no-bitwise-or`.
 */
export default {
  meta: {
    type: 'problem',
    fixable: 'code',
    docs: {
      description:
        "disallow bitwise-OR '|' against non-numeric-literal RHS (use '||' for logical OR / defaults; '| 0' stays allowed as the int32-cast idiom)",
    },
    schema: [],
    messages: {
      bitwiseOr:
        "Bitwise '|' against this RHS coerces both sides to 32-bit integers; in this codebase '|' against a non-numeric RHS has only ever been a typo for '||'. Use '||' or opt out with eslint-disable-next-line if this is a genuine bitwise op.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    return {
      BinaryExpression(node) {
        if (node.operator !== '|') return;
        const rhs = node.right;
        // Allow the int32-cast idiom: `x | 0`, `x | 0xff`, etc.
        // RHS is a JS Literal whose value is a number.
        if (rhs.type === 'Literal' && typeof rhs.value === 'number') return;
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
