/**
 * Single source of truth for keyring slot suffixes derived from a base
 * `accountForUser(id)` slug. Importing this helper instead of inlining the
 * string ensures the runtime read path and any future rename agree byte for
 * byte on the wire format — a stale literal in one place would silently
 * park tokens in a slot the runtime never reads from.
 *
 * Internal: not re-exported from `auth/keyring/index.ts`.
 */
export function refreshAccountSlot(accountSlug: string): string {
    return `${accountSlug}/refresh`
}
