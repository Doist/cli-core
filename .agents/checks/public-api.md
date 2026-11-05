# Check: public API

What the Doist CLIs see: everything exported from `src/index.ts` and the subpath barrels (`./auth`, `./commands`, `./extensions`, `./markdown`, `./testing`), its names, signatures, options, error codes and behaviour, plus peer dependencies, the Node engine, the environment extensions receive, and the scaffold templates.

## Report

- A renamed or removed export, option or error code, a narrowed parameter type, or a changed default, without a breaking-change PR title (`feat!:`, `fix!:`).
- A raised peer dependency range or Node engine without a breaking-change PR title.
- A behaviour change in a shared helper (output format, spinner or accessibility gates, config paths) without the CLIs it reaches named in the description.
- A `./testing` helper changed in a way that breaks the CLIs' own tests.
- A change to the environment variables or arguments extensions receive, or to the scaffold templates, without saying which existing extensions it affects.
- `README.md` out of step with the change.

## Fine

- New exports and new optional options (additive) in a `feat:` PR.
- Internal modules not reached from any barrel.
