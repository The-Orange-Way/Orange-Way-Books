/**
 * SUPERSEDED by DL-0429.
 *
 * The send and verify stages are now both handled inside StepEmail with an
 * internal stage: 'address' | 'code', matching OWM at fd83d5f exactly.
 * This file is not imported anywhere and will be removed in a follow-up
 * cleanup once the branch is merged and the history is stable.
 *
 * Do not restore this file to the step registry. The otp step id is gone;
 * adding it back without a redirect plan would break any deep link that
 * lands on /onboarding?step=otp.
 */
