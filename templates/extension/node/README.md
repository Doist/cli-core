# {{DIRNAME}}

{{DESCRIPTION}}

## Install

```bash
{{BIN}} extension install {{OWNER}}/{{DIRNAME}}
```

## Develop

```bash
{{BIN}} extension install .   # symlinks this directory, so every edit is live
{{BIN}} {{NAME}}
```

## Publishing

Push this to a repository named `{{DIRNAME}}` and add the `{{BIN}}-extension`
topic, which is how `{{BIN}} extension search` finds it.

## Notes

- Everything after `{{BIN}} {{NAME}}` reaches this script untouched, `--help`
  included. Global flags belong before the name: `{{BIN}} --user you@example.com
{{NAME}}`.
- Write data to stdout and diagnostics to stderr, and exit non-zero on
  failure. {{BIN}} exits with whatever this script exits with.
- Do not prompt when stdin is not a TTY — {{BIN}} is non-interactive by design
  and agents call extensions.
- Dependencies go in `package.json`; {{BIN}} installs them when it installs the
  extension, so they do not need vendoring. It runs `npm ci --omit=dev` once
  you commit a `package-lock.json`, and `npm install --omit=dev` until then.
