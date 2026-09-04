#!/usr/bin/env bash
# canon-terms.sh: the ONE canonicalizer for the reserved-term list, and the
# one place a pattern built from it is checked for being usable at all.
#
# The reserved-term list is not committed. It arrives at runtime as an
# environment value or a gitignored file, and every consumer has to turn it
# into a single regex alternation before it can be used. That conversion
# lives here, once, and every consumer sources this file:
#
#   scripts/pre-publish-scan.sh
#   scripts/pre-push-gate.sh
#   .github/workflows/post-merge-identity-scan.yml
#   .github/workflows/leak-check.yml
#
# Why one copy and not four. Every way this conversion can go wrong fails in
# the same direction: the pattern still compiles, it just matches nothing,
# and a scan that matches nothing is indistinguishable from a clean tree.
# The consumers each print a term count, which reads as proof in both cases.
# So a divergence here is invisible from the outside, and the only defence
# is that there is nothing to diverge from.
#
# Usage:
#   . "<repo root>/scripts/canon-terms.sh"
#   PATTERN="$(printf '%s\n' "$OW_RESERVED_TERMS" | canon_terms)"
#   PATTERN="$(canon_terms < .reserved-terms)"
#   if [ -n "$PATTERN" ] && ! canon_terms_usable "$PATTERN"; then ...; fi
#
# Each step is load bearing:
#
#   tr -d '\r'
#       Deletes carriage returns. A value saved with Windows line endings
#       leaves a trailing CR on every fragment, so each branch of the
#       alternation looks for "term<CR>", finds it nowhere in the tree, and
#       the scan reports clean against a list that is fully populated.
#
#   s/^[[:space:]]*// and s/[[:space:]]*$//
#       Trims whitespace from the ENDS of each line and never from the
#       middle, so a term containing an internal space keeps working. A
#       trailing space is what a value typed into a secrets textarea
#       collects, and the branch "term " then matches only where the term
#       is followed by a space: it misses nearly every real occurrence
#       while the term count still reads correct. Same failure as the
#       carriage return, one character class over.
#
#   /^#/d and /^$/d
#       Drops comment lines and blank lines, after the trim so an indented
#       comment is still recognised as a comment. A comment compiled into
#       the regex becomes a live fragment that matches its own literal
#       text. A blank line becomes an empty alternation branch, which
#       matches EVERY line of every file and turns the scan into a refusal
#       of everything.
#
#       These deletions are sed and not grep -v on purpose. grep exits 1
#       when it selects nothing, which is exactly what a list of only
#       comments and blanks produces, and under set -e plus pipefail that
#       status ended the calling script mid-assignment with no message at
#       all: the caller's own "the list is not configured" branch never
#       ran. sed deletes the same lines and still exits 0, so the empty
#       case arrives at the caller as empty OUTPUT, which is what the
#       contract below is written in terms of.
#
#   paste -sd'|' -
#       Joins what survives into one alternation.
#
#   sed -e 's/||*/|/g' -e 's/^|*//' -e 's/|*$//'
#       Squeezes runs of separators, then trims them off the two ends. Every
#       one of them is an empty alternation branch, which matches every line
#       of every file: the same match-everything effect as a blank line, and
#       it arrives the same way. A line is documented as a regex FRAGMENT, so
#       "termA|termB" on one line is invited, and editing it down to "termA|"
#       leaves a trailing pipe that the join turns into "termA||termB".
#       Trimming only the ends of the joined string left that internal pair
#       in place. The squeeze runs BEFORE the trim so a leading or trailing
#       run is reduced first and then removed.
#
# The output is EMPTY when the input holds no usable terms. Callers must
# treat empty as "not configured" and say so loudly. Empty is never clean.
# canon_terms itself always exits 0: "no usable terms" is a value, not an
# error, and every caller already has a branch for it.
#
# scripts/test-canon-terms.sh proves this still matches real text, and
# carries a negative control proving the test can fail.

canon_terms() {
  tr -d '\r' \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e '/^#/d' -e '/^$/d' \
    | paste -sd'|' - \
    | sed -e 's/||*/|/g' -e 's/^|*//' -e 's/|*$//'
}

# canon_terms_usable PATTERN
#
# True when PATTERN can actually be scanned with, false when it cannot, and
# on false it records WHICH of the three ways it failed in the global
# CANON_TERMS_REASON: refused, matches-everything, or empty. Those are three
# different problems with three different fixes, and every consumer used to
# report the first one whatever the cause. canon_terms_reason_text below
# turns the recorded reason into the one sentence they all print.
#
# The list is documented as one regex FRAGMENT per line, so an unbalanced
# parenthesis or bracket is a realistic typo, and the join hides it: the
# fragments are concatenated without anyone ever asking whether the result
# is a regex. What each consumer did with a pattern grep refuses is the
# whole problem, because grep exits 2 on a bad pattern and every consumer
# read that as "no matches":
#
#   - a scan whose grep is wrapped in "|| true" collected an empty result
#     and printed a green tick for the category
#   - a scan whose grep sits in an "if" took the false branch and printed
#     "clean"
#
# So one typo in the stored value turned every layer green while nothing
# was being checked, and the term count was printed each time to reassure
# you. Asking the question here, next to the join, is the only place it
# cannot drift apart from the code that builds the pattern.
#
# An empty pattern is NOT usable and is reported as such, but it is also
# not this function's job to explain: empty means "not configured", every
# caller already refuses or skips on it explicitly and with a message that
# says how to fix it, so callers test for empty FIRST and only then ask
# this. The invocation is deliberately the same shape the consumers use,
# so a pattern that grep would refuse in a scan is refused here too.
#
# THE PROBE IS TWO LINES, fed to grep one at a time, and each one answers a
# different question. Neither can be dropped.
#
# Probe line 1 is ONE BLANK LINE, and the difference from zero bytes is the
# whole reason this function can ask the match-everything question at all.
# grep tests lines: given no input at all there are no lines to test, so it
# returns "no match" for every pattern including one that matches the empty
# string. An earlier version of this probe piped in zero bytes and then
# reasoned about what a match would mean, which could never happen. One
# blank line gives grep something to test that no real reserved term can
# appear in. It catches the patterns that match the EMPTY string: an empty
# alternation branch left by a stray pipe, and an entirely optional
# fragment.
#
# Probe line 2 holds ONE control character, and it exists because the blank
# line covers only half of the match-everything class. A branch of ".", or
# ".+", or "[^x]", matches every NON-EMPTY line of every file and does NOT
# match a blank line, so probe 1 on its own reports it healthy. The list is
# documented as one regex FRAGMENT per line, so a fragment edited down to a
# bare "." is a realistic edit, and the resulting "termA|.|termB" makes
# every consumer flag every file in the tree.
#
# The character is SOH (\001). No reserved term can contain it, the list
# being names and hostnames, so a pattern that matches a lone control byte
# is matching by breadth and not by content. It is deliberately not NUL,
# which grep would read as binary input.
#
# A pattern that survives both probes compiles, does not match the empty
# string, and does not match an arbitrary non-empty line. That is as close
# to usable as a probe can get without the real tree.
canon_terms_usable() {
  local pattern="${1-}"
  local rc=0
  CANON_TERMS_REASON=empty
  [ -n "$pattern" ] || return 1

  # Probe 1: does it match the empty string.
  printf '\n' | grep -qE "$pattern" >/dev/null 2>&1 || rc=$?
  case "$rc" in
    # 1 = compiled and did not match. Healthy so far, so ask probe 2. This
    #     is the only branch that continues.
    1)
      :
      ;;
    # 0 = the pattern matched a line with nothing in it. The empty string is
    #     contained in every line, so such a pattern matches every line of
    #     every file. This is the match-everything failure: an empty
    #     alternation branch left by a stray pipe in a fragment, or a
    #     fragment that is entirely optional. It compiles, so the refusal
    #     below cannot see it, and it turns the scan into a refusal of the
    #     whole tree while the term count printed next to it still reads
    #     correct.
    0)
      CANON_TERMS_REASON=matches-everything
      return 1
      ;;
    # 2 or higher = grep refused the pattern outright, which is the typo
    #     case this function was added for.
    *)
      CANON_TERMS_REASON=refused
      return 1
      ;;
  esac

  # Probe 2: does it match an arbitrary non-empty line.
  rc=0
  printf '\001\n' | grep -qE "$pattern" >/dev/null 2>&1 || rc=$?
  case "$rc" in
    # 1 = it compiles, matches neither probe line, and is the only answer
    #     that gets to be called usable.
    1)
      CANON_TERMS_REASON=ok
      return 0
      ;;
    # 0 = it matches a line holding one control character, which no real
    #     reserved term can appear in. The pattern is matching by breadth,
    #     so it matches every non-empty line of every file: the same
    #     match-everything failure as probe 1 reports, one class over.
    0)
      CANON_TERMS_REASON=matches-everything
      return 1
      ;;
    # 2 or higher cannot normally arrive here, since probe 1 already
    #     compiled the same pattern. Kept because a refusal must never be
    #     read as a pass, whatever the reason for it.
    *)
      CANON_TERMS_REASON=refused
      return 1
      ;;
  esac
}

# canon_terms_reason_text [REASON]
#
# Prints ONE line saying what is wrong with the list and what it would cost,
# for the REASON given, or for the last call to canon_terms_usable when no
# argument is passed.
#
# It never prints any part of the list. Every consumer's message states that
# already and has to keep it true: the value is a repository secret and these
# logs are public.
#
# WHERE to fix it is deliberately NOT here. That answer is different for each
# consumer, a repository secret in CI and a gitignored file locally, so each
# one adds its own line. What is wrong, and what it would cost, is the same
# everywhere, so it is written once.
canon_terms_reason_text() {
  case "${1-${CANON_TERMS_REASON-}}" in
    refused)
      printf '%s\n' "The reserved-term list does not compile as a regular expression, so every scan that uses it would report clean while checking nothing. At least one fragment is not valid regex; an unbalanced parenthesis or bracket is the usual cause."
      ;;
    matches-everything)
      printf '%s\n' "The reserved-term list matches every line of every file, so every scan that uses it would flag the whole tree instead of checking it. One fragment matches far more than it names: an empty alternation branch left by a stray pipe, an entirely optional fragment, or a fragment edited down to a catch-all such as a bare dot, are the usual causes."
      ;;
    empty)
      printf '%s\n' "The reserved-term list holds no usable terms, so every scan that uses it would check for nothing. Either nothing is configured, or every line is blank or a comment."
      ;;
    *)
      printf '%s\n' "The reserved-term list cannot be scanned with, and no reason was recorded. That is a defect in scripts/canon-terms.sh itself; treat this run as unrunnable, never as clean."
      ;;
  esac
}
