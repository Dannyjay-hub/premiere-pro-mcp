/**
 * Claude Desktop can pass an optional `user_config` field through unsubstituted
 * (the literal `${user_config.name}` string). Treat that, and blank values, as unset.
 */
const UNSUBSTITUTED_PLACEHOLDER = /^\$\{user_config\.[^}]*\}$/;

export function readEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || UNSUBSTITUTED_PLACEHOLDER.test(trimmed)) return undefined;
  return trimmed;
}
