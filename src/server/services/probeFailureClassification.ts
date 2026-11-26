/**
 * Pure failure classifiers for probes.
 *
 * Kept dependency-free (no db, no fetch) so both the probe and its callers can
 * import it without dragging a database connection into the module graph — the
 * unit tests mock `runtimeModelProbe` and would otherwise initialise a second
 * database handle before `DATA_DIR` is set.
 */

/**
 * A relay answering "this model is not served by any account in *this group*"
 * is describing the token's group, not the site: another group of the same
 * account may serve the model perfectly well. Treating that as a model verdict is
 * what disabled models reachable through a different key (measured: a sub2api
 * account's `cc max` key served claude-fable-5-2 while the account's default key
 * group, bound to an OpenAI group, did not).
 */
const GROUP_SCOPED_REJECTION_PATTERNS = [
  /not supported by any (?:configured )?account in this group/i,
  /no available channels?\b/i,
  /当前分组不(?:支持|可用)/,
  /本?分组[^]{0,10}(不支持|未开通|无可用)/,
  /this group does not support/i,
  /model[^]{0,40}not (?:available|enabled) in (?:this|the) group/i,
];

export function isGroupScopedModelRejection(reason: string | null | undefined): boolean {
  const text = String(reason || '').trim();
  if (!text) return false;
  return GROUP_SCOPED_REJECTION_PATTERNS.some((pattern) => pattern.test(text));
}
