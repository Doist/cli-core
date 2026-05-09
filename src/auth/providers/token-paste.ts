import { CliError } from '../../errors.js'
import type { AuthAccount, AuthProvider, PasteInput } from '../types.js'

export type TokenPasteProviderOptions<TAccount extends AuthAccount = AuthAccount> = {
    /** Validate the pasted token against the API and return the resolved account. */
    validate: (input: PasteInput) => Promise<TAccount>
}

/**
 * `AuthProvider` for "the user pastes a token they got from somewhere else
 * (web settings page, CI secret, …)". The OAuth-flow methods throw — the
 * registrar must route directly to `acceptPastedToken` when this provider is
 * the sole strategy. Useful for CLIs that only ever offer manual token entry.
 *
 * Most CLIs combine this with `createPkceProvider` by passing
 * `acceptPastedToken` as an option there instead of using this factory.
 */
export function createTokenPasteProvider<TAccount extends AuthAccount>(
    options: TokenPasteProviderOptions<TAccount>,
): AuthProvider<TAccount> {
    const unsupported = (op: string) =>
        new CliError(
            'AUTH_PROVIDER_UNSUPPORTED',
            `${op} is not supported by the token-paste provider — pass --token <value> instead.`,
        )

    return {
        async authorize() {
            throw unsupported('OAuth authorize')
        },
        async exchangeCode() {
            throw unsupported('OAuth code exchange')
        },
        async validateToken({ token }) {
            return options.validate({ token, flags: {} })
        },
        async acceptPastedToken(input) {
            return options.validate(input)
        },
    }
}
