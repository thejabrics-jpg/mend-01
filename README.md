[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/thejabrics-jpg/mend-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/thejabrics-jpg/mend-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend — one patch tool for every AI edit format

`mend` applies an edit that an AI model wrote to a tree of text files.
Models write edits in four formats, and `mend` reads all of them:

- **unified diffs** (often with wrong line numbers),
- **SEARCH/REPLACE blocks**,
- **V4A patches** (`*** Begin Patch` … `*** End Patch`),
- **JSON tool calls** (one array, or one edit object per line).

Every file is changed or nothing is: edits apply in patch order to the
tree as earlier edits left it, a failed edit changes nothing, the edits
after it still run, and when any edit failed no file is written at all.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is the patch file, relative to the working directory (the root of
the tree). When it is absent or `-`, the patch is read from standard input.

- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto` (the default) detects it, in
  the order v4a, json, search-replace, unified.
- `--check` does everything but write: same output and exit code, no file
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only, see below).
- Options and `PATCH` may come in any order. `--` ends the options.

Node 22, standard library alone. No dependencies.

## Exit codes and output

Standard output holds lines, each ended by `\n`, and nothing else.

- **Exit 2**, exactly one line, nothing written: `error: usage`,
  `error: no-patch` (patch file cannot be read), `error: format` (auto
  detection found no format), `error: parse <N>` (the patch cannot be
  read in its format; a patch with no edit at all is `error: parse 1`).
  A usage error wins over everything; a parse error is reported before
  any file is looked at.
- **Exit 1**, nothing written: one line `error: <code> <path>` for each
  edit that failed, in patch order, then `failed: <k> of <n> edits`.
  Codes: `no-match`, `ambiguous`, `missing`, `exists`, `unsafe`.
- **Exit 0**, the tree is written: one line per path whose state changed,
  in byte order of the paths (UTF-8), then `ok: <n> files`
  (`ok: 1 file` when n is 1):
  `A <path>` created, `D <path>` deleted, `M <path>` changed,
  `R <old> -> <new>` moved (sorts by `<new>`). A file whose bytes are
  unchanged is not listed; a patch that changes nothing prints only
  `ok: 0 files`.

## Matching

Old lines are found at the first of three tiers at which they occur:

- **tier 0**: every line equal;
- **tier 1**: every line equal once trailing spaces and tabs are removed;
- **tier 2**: every line equal once leading and trailing spaces and tabs
  are removed.

A context line is written as the file's own matched line, never the
patch's. At tier 2, other new lines are re-indented to the file's
indentation. Which occurrence is taken when there are several depends
on the format: unified takes the one nearest the hunk's line number,
SEARCH/REPLACE requires exactly one (else `ambiguous`), V4A takes the
first at or after its cursor (an end-of-file chunk only takes one that
ends at the file's last line).

## Details the spec pins down

- Paths are safe when non-empty, not starting with `/`, holding no `\`,
  and with no empty, `.` or `..` segment. Every path an edit names is
  checked for safety before anything else about it.
- A file's line break is CRLF when its first line feed follows a
  carriage return, otherwise LF; a changed file keeps its own break and
  its final break, except a unified hunk whose matched lines run to the
  end of the file (or whose insertion lands at the end), where the
  result ends with a line break unless a `\` line
  (`\ No newline at end of file`) follows the hunk's last context or
  `+` line. Files an edit creates use LF breaks.
- Unified diffs tolerate wrong line numbers, blank context lines
  without their leading space, prose and code fences around the patch,
  `rename from`/`rename to`, `new file mode` / `deleted file mode`,
  and `/dev/null` sides.
- V4A chunks use an `@@ <anchor>` line and a cursor that moves past
  each anchor and each chunk; `*** End of File` anchors a chunk to the
  end of the file; `*** Move to:` moves the file.
- JSON `create` writes its `file_text` byte for byte; `str_replace`
  matches exactly (no tiers) and is exact-once; `insert` inserts after
  line `insert_line` (0 is the top). In a CRLF file, `str_replace`
  reads and writes with `\r\n` as `\n` and back again.

## Files

- `main.ts` — the CLI (SPEC.md is the whole specification; the kit's
  starter already did sections 1–4, 9 and 10, and this build adds
  sections 5–8 plus the `R` move lines).
- `runner.ts` — the kit's runner, unchanged. When `MAKEFUN_ENV_URL` is
  set, `main.ts` hands the trial over to it.
- `LICENSE` — MIT.

## Testing

Against the kit's public practice set (100 checks, program/generator/
practice.json), with the kit's `check.ts`:

```
node check.ts ../hidden-spec-cli-01-run-20261122-kit/program/generator/practice.json
# 100 of 100 passed: practice score 1000
```

A further 76 hand-written edge cases (in the author's test harness,
not shipped) cover usage errors, missing patch files, unknown formats,
parse errors in every format, ambiguous / no-match / missing / exists /
unsafe failures, `--check` writing nothing, `--strict`, empty-old
insertions, moves and renames, CRLF files, `\ No newline at end of
file`, detection order, and `R`-line sorting. All 76 pass, and repeated
runs on the same input are byte-identical.
