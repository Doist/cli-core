/**
 * Single source of truth for the wire format of per-account keyring slot
 * names. Internal to the keyring module — not re-exported from
 * `keyring/index.ts` because consumers should never need to construct
 * these directly. Tests import from here too so a rename can't drift
 * the fixture away from production code.
 */

/** Sibling keyring slot for the refresh token. */
export function refreshAccountSlot(accessSlot: string): string {
    return `${accessSlot}/refresh`
}
