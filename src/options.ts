/**
 * Shared shape for commands that respect the canonical machine-output flags.
 * Seeded narrow so the type only declares what cli-core helpers actually read
 * today; will grow (`full?`, `raw?`, etc.) as the global-args parser extraction
 * lands (see EXTRACTION_ROADMAP.md, Tier 1).
 *
 * Per-CLI `ViewOptions` types should extend this rather than re-declare the
 * `json` / `ndjson` fields.
 */
export type ViewOptions = {
    json?: boolean
    ndjson?: boolean
}
