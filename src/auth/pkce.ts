import { createHash, randomBytes, randomInt } from 'node:crypto'

/**
 * Default RFC 7636 unreserved character set: `A-Z a-z 0-9 - . _ ~`. 66 chars.
 *
 * Some providers (Todoist) ship a 64-char subset that drops `.~` to keep the
 * verifier alphanumeric-with-dashes-and-underscores; pass it via
 * `generateVerifier({ alphabet })` if you need to match a specific server's
 * canonicalisation.
 */
export const DEFAULT_VERIFIER_ALPHABET =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'

export type GenerateVerifierOptions = {
    /** Verifier length. RFC 7636 §4.1 mandates 43–128. Default: 64. */
    length?: number
    /** Override character set (must contain only RFC 7636 unreserved chars). Default: `DEFAULT_VERIFIER_ALPHABET`. */
    alphabet?: string
}

/**
 * Generate a PKCE `code_verifier`. Uses `crypto.randomInt` to map random bytes
 * uniformly onto the alphabet — no modulo bias, no rejection sampling needed
 * at the call site.
 */
export function generateVerifier(options: GenerateVerifierOptions = {}): string {
    const length = options.length ?? 64
    const alphabet = options.alphabet ?? DEFAULT_VERIFIER_ALPHABET
    if (length < 43 || length > 128) {
        throw new RangeError(`PKCE verifier length must be 43..128, got ${length}`)
    }
    if (alphabet.length === 0) throw new RangeError('PKCE verifier alphabet must be non-empty')

    let out = ''
    for (let i = 0; i < length; i++) {
        out += alphabet[randomInt(0, alphabet.length)]
    }
    return out
}

/** Derive the S256 `code_challenge` from a verifier: base64url(sha256(verifier)). */
export function deriveChallenge(verifier: string): string {
    return createHash('sha256').update(verifier).digest('base64url')
}

/**
 * Generate a CSRF `state` token. 16 random bytes (128 bits) hex-encoded —
 * comfortably above the 32-bit floor recommended by OAuth 2 §10.12.
 */
export function generateState(): string {
    return randomBytes(16).toString('hex')
}
