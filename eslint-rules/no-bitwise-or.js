/**
 * Flag every `x | y` binary expression. In this codebase every `|` ever
 * introduced has been a typo for `||`, including the ones that looked
 * like the JS int32-cast idiom `Number(x) | 0`. Why this matters:
 * the codebase deals with financial amounts where 350.35 must stay
 * 350.35, not get truncated to 350; `Number(x) | 0` does the truncation.
 * A prior version of this rule allowed `x | <numeric literal>` as the
 * int-cast idiom, and re-introduced the truncation bug in the
 * opening-balances reducer (caught by the test suite once it ran on a
 * newer node). The rule is now universal: report every `|` and autofix
 * to `||`.
 *
 * The general `no-bitwise` rule would also flag `&`, `^`, `<<`, `>>`,
 * `~`, which the codebase uses legitimately (e.g. `sample & 0x7ff` for
 * BIP-39 word extraction). This rule stays narrow to just `|`.
 *
 * A genuine bitwise-OR introduced later (e.g. building a flags bitmap
 * in a future feature) must opt out per-line, with a one-line reason
 * comment that reviewers can confirm. Worked example:
 *
 *   // eslint-disable-next-line local/no-bitwise-or
 *   // reason: building Permission flags bitmap; both operands are uint32.
 *   const flags = READ | WRITE;
 *
 * Treat the disable comment as a flag for reviewers, not as a way to
 * silence the linter.
 */
export default {
  meta: {
    type: 'problem',
    fixable: 'code',
    docs: {
      description:
        "disallow runtime bitwise-OR '|' (this codebase has no legitimate `x | y` site; use '||' for defaults, eslint-disable for any real bitwise need)",
    },
    schema: [],
    messages: {
      bitwiseOr:
        "Bitwise '|' coerces both sides to 32-bit integers; this codebase has no legitimate `x | y`, every `|` ever introduced has been a typo for '||'. Use '||' or opt out with eslint-disable-next-line if this is a genuine bitwise op (and add a comment explaining why).",
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
