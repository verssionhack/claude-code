/**
 * Session-scoped context window override set via /max_context_set.
 * Side-effect-free module (context.ts is imported by tests that must not
 * pull bootstrap/state).
 */
let maxContextTokensOverride: number | undefined

export function setMaxContextTokensOverride(value: number | undefined): void {
  maxContextTokensOverride = value
}

export function getMaxContextTokensOverride(): number | undefined {
  return maxContextTokensOverride
}
