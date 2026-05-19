/**
 * Derives the refresh slot name from the access slug. Single-sourced so the
 * write and read paths can't drift onto different suffixes. Internal.
 */
export function refreshAccountSlot(accountSlug: string): string {
    return `${accountSlug}/refresh`
}
