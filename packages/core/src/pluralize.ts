// A tiny, dependency-free pluralizer for the receipt counts ("1 frond"
// vs "2 fronds") — lives here, not in packages/daemon/src/receipts.ts,
// specifically so the lightweight Claude Code hook scripts (which
// import only @context-fern/core, never the full @context-fern/daemon
// barrel — see packages/daemon/src/client.ts's own module doc) can
// share it instead of re-deriving the same "<n> <word>(s)" formatting
// on their own, which is exactly how this went un-pluralized in three
// separate places at once. See docs/decisions.md.

export function pluralize(
  count: number,
  singular: string,
  plural: string = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
