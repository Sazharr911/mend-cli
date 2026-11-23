# mend-cli

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Sazharr911/mend-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Sazharr911/mend-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every edit format an AI model writes: unified diffs (with wrong line numbers, drifted whitespace and re-indentation), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON. `main.ts` is a dependency-free Node 22 implementation of the competition's `SPEC.md`: it detects the format (or takes `--format`), matches old lines at three tiers (exact, trailing-whitespace, full re-indent; tier 0 only under `--strict`), applies every edit in order to an in-memory tree, and writes the tree only when no edit failed — every file changed or nothing is. It reports exactly what the spec requires: `A`/`D`/`M`/`R` lines and `ok: N files` on success, one `error: <code> <path>` line per failed edit with `failed: k of n edits`, and a single `error: usage` / `no-patch` / `format` / `parse N` line with exit 2 for a patch that cannot be read at all. `--check` runs everything but the write. The kit's practice set passes 100 of 100 checks locally (`node check.ts <practice.json>`).

## Run it

```sh
node main.ts [--format=unified|search-replace|v4a|json] [--check] [--strict] [PATCH]
```

With no PATCH (or `-`), the patch is read from standard input; paths in the patch are relative to the working directory.

---
<sub>Entered on [make.fun](https://make.fun/?ref=szkznt2e&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
