// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** [old, new] pairs of move edits that succeeded, for the `R` output lines. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

// ---------- file model (SPEC section 3) ----------

interface FileState {
  lines: string[];
  br: string; // '\n' | '\r\n'
  final: boolean; // ends with a line break
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function serializeFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

// ---------- tier matching (SPEC section 5) ----------

const rtrimWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimWs(a) === rtrimWs(b);
  return trimWs(a) === trimWs(b);
}

/** All positions i where oldLines matches lines[i..] at the given tier. */
function occurrences(lines: string[], oldLines: string[], tier: number): number[] {
  const out: number[] = [];
  if (oldLines.length === 0) return out;
  for (let i = 0; i + oldLines.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < oldLines.length; k++) {
      if (!lineEq(lines[i + k]!, oldLines[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function tiersToTry(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** One line of N: its text, and the index into O when it is a context line. */
interface NLine {
  text: string;
  ctxOld: number | null;
}

/**
 * Lines replacing file lines [pos, pos+oldLines.length): context lines are
 * written as the file's own matched lines; at tier 2 every other line is
 * re-indented (SPEC section 5).
 */
function buildReplacement(fileLines: string[], pos: number, tier: number, oldLines: string[], newLines: NLine[]): string[] {
  const out: string[] = [];
  const F = oldLines.length > 0 ? leadWs(fileLines[pos]!) : '';
  const P = oldLines.length > 0 ? leadWs(oldLines[0]!) : '';
  for (const nl of newLines) {
    if (nl.ctxOld !== null) {
      out.push(fileLines[pos + nl.ctxOld]!);
    } else if (tier === 2) {
      const t = nl.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(P)) out.push(F + t.slice(P.length));
      else out.push(t);
    } else {
      out.push(nl.text);
    }
  }
  return out;
}

// ---------- hunk / chunk bodies (SPEC sections 6 and 8) ----------

interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

function toBodyLine(l: string): BodyLine {
  if (l === '') return { kind: ' ', text: '' };
  const c = l[0]!;
  if (c === ' ') return { kind: ' ', text: l.slice(1) };
  if (c === '-') return { kind: '-', text: l.slice(1) };
  if (c === '+') return { kind: '+', text: l.slice(1) };
  return { kind: '\\', text: l };
}

function isBodyLine(l: string): boolean {
  return l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\';
}

/** O = context and `-` lines, N = context and `+` lines, each in body order. */
function bodyON(body: BodyLine[]): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      O.push(b.text);
      N.push({ text: b.text, ctxOld: O.length - 1 });
    } else if (b.kind === '-') {
      O.push(b.text);
    } else if (b.kind === '+') {
      N.push({ text: b.text, ctxOld: null });
    }
  }
  return { O, N };
}

interface Hunk {
  a: number; // old start line, 1-based
  body: BodyLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noNewline: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  lastPlusNoNl: boolean;
}

function hunkFlags(body: BodyLine[]): { noNewline: boolean; lastPlusNoNl: boolean } {
  let lastCP = -1;
  for (let k = 0; k < body.length; k++) if (body[k]!.kind === ' ' || body[k]!.kind === '+') lastCP = k;
  const noNewline = lastCP >= 0 && body[lastCP + 1]?.kind === '\\';
  let lastPlus = -1;
  for (let k = 0; k < body.length; k++) if (body[k]!.kind === '+') lastPlus = k;
  const lastPlusNoNl = lastPlus >= 0 && body[lastPlus + 1]?.kind === '\\';
  return { noNewline, lastPlusNoNl };
}

/** Apply a section's hunks in order to a file (SPEC section 6). */
function applyHunks(f: FileState, hunks: Hunk[], path: string, strict: boolean): void {
  let d = 0;
  for (const h of hunks) {
    const { O, N } = bodyON(h.body);
    if (O.length === 0) {
      const oldLen = f.lines.length;
      const insAt = Math.min(Math.max(h.a + d, 0), oldLen);
      const rep = buildReplacement(f.lines, insAt, 0, [], N);
      f.lines.splice(insAt, 0, ...rep);
      if (insAt === oldLen) f.final = !h.noNewline;
      d += N.length;
    } else {
      let tier = -1;
      let occs: number[] = [];
      for (const t of tiersToTry(strict)) {
        occs = occurrences(f.lines, O, t);
        if (occs.length > 0) {
          tier = t;
          break;
        }
      }
      if (tier < 0) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = occs[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of occs) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const runsToEnd = best + O.length === f.lines.length;
      const rep = buildReplacement(f.lines, best, tier, O, N);
      f.lines.splice(best, O.length, ...rep);
      if (runsToEnd) f.final = !h.noNewline;
      d += N.length - O.length;
    }
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- unified diffs (SPEC section 6) ----------

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Path after `--- ` / `+++ `: text up to the first tab, spaces removed; /dev/null is no file. */
function headerPath(text: string): string | null {
  const t = text.split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  return stripAB(t);
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hunks: Hunk[];
}

/**
 * Parse a section's header (before its first hunk) and its hunks.
 * Returns the index of the next line after the section.
 */
function parseSectionRest(lines: string[], i: number, sec: Section, pairSeenInit: boolean): number {
  let pairSeen = pairSeenInit;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  // Header phase: ends at the first hunk, a new section, or the end.
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (pairSeen) break; // starts a new section
        sec.oldPath = headerPath(l.slice(4));
        sec.newPath = headerPath(lines[i + 1]!.slice(4));
        pairSeen = true;
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('+++ ')) {
      sec.newPath = headerPath(l.slice(4));
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (HUNK_RE.exec(l) === null) throw new Exit2(`error: parse ${i + 1}`);
      break;
    }
    if (l.startsWith('rename from ')) {
      renameFrom = l.slice('rename from '.length).trim();
      i++;
      continue;
    }
    if (l.startsWith('rename to ')) {
      renameTo = l.slice('rename to '.length).trim();
      i++;
      continue;
    }
    if (l.startsWith('new file mode')) {
      sec.newFileMode = true;
      i++;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      sec.deletedFileMode = true;
      i++;
      continue;
    }
    i++; // ignored header line
  }
  // rename lines name the paths when no ---/+++ pair does.
  if (!pairSeen) {
    if (renameFrom !== null) sec.oldPath = renameFrom;
    if (renameTo !== null) sec.newPath = renameTo;
  }
  // Hunk phase: ends at a new section or the end; other lines are ignored prose.
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith('@@')) {
      const m = HUNK_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      i++;
      const raw: string[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (!isBodyLine(bl)) break;
        raw.push(bl);
        i++;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop(); // trailing empty lines are not part of the body
      const body = raw.map(toBodyLine);
      const flags = hunkFlags(body);
      sec.hunks.push({ a, body, noNewline: flags.noNewline, lastPlusNoNl: flags.lastPlusNoNl });
      continue;
    }
    i++;
  }
  return i;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const sec: Section = { oldPath: stripAB(m[1]!), newPath: stripAB(m[2]!), newFileMode: false, deletedFileMode: false, hunks: [] };
      i = parseSectionRest(lines, i + 1, sec, false);
      sections.push(sec);
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: Section = { oldPath: headerPath(l.slice(4)), newPath: headerPath(lines[i + 1]!.slice(4)), newFileMode: false, deletedFileMode: false, hunks: [] };
      i = parseSectionRest(lines, i + 2, sec, true);
      sections.push(sec);
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`); // a hunk before any section
    } else {
      i++; // ignored prose
    }
  }
  return sections.map((sec) => unifiedEdit(sec, strict));
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = oldP === null || sec.newFileMode;
    const isDelete = newP === null || sec.deletedFileMode;
    if (isCreate) {
      if (newP === null) return; // degenerate: no file to create
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const b of h.body) if (b.kind === '+') plus.push(b.text);
      let noNl = false;
      for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const h = sec.hunks[hi]!;
        if (h.body.some((b) => b.kind === '+')) {
          noNl = h.lastPlusNoNl;
          break;
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noNl ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (oldP === null) return; // degenerate: no file to delete
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP === null || newP === null) return; // degenerate
    if (oldP !== newP) {
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const f = parseFile(before);
      applyHunks(f, sec.hunks, oldP, strict);
      tree.now.set(newP, serializeFile(f));
      tree.now.set(oldP, null);
      tree.moves.push([oldP, newP]);
      return;
    }
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    const f = parseFile(before);
    applyHunks(f, sec.hunks, oldP, strict);
    tree.now.set(oldP, serializeFile(f));
  };
}

// ---------- SEARCH/REPLACE blocks (SPEC section 7) ----------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1; // index of the previous block's >>>>>>> REPLACE line
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    let sep = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = parseFile(before);
    let tier = -1;
    let occs: number[] = [];
    for (const t of tiersToTry(strict)) {
      occs = occurrences(f.lines, oldLines, t);
      if (occs.length > 0) {
        tier = t;
        break;
      }
    }
    if (tier < 0) throw new Fail('no-match', path);
    if (occs.length > 1) throw new Fail('ambiguous', path);
    const pos = occs[0]!;
    const rep = buildReplacement(f.lines, pos, tier, oldLines, newLines.map((t) => ({ text: t, ctxOld: null })));
    f.lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, serializeFile(f));
  };
}

// ---------- V4A patches (SPEC section 8) ----------

const V4A_ADD = '*** Add File: ';
const V4A_DEL = '*** Delete File: ';
const V4A_UPD = '*** Update File: ';
const V4A_MOVE = '*** Move to: ';

function isV4aSectionStart(l: string): boolean {
  return l.startsWith(V4A_ADD) || l.startsWith(V4A_DEL) || l.startsWith(V4A_UPD);
}

function stripTrailingBlanks(raw: string[]): string[] {
  const out = raw.slice();
  while (out.length > 0 && blank(out[out.length - 1]!)) out.pop();
  return out;
}

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  O: string[];
  N: NLine[];
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith(V4A_ADD) || l.startsWith(V4A_DEL) || l.startsWith(V4A_UPD)) {
      const isAdd = l.startsWith(V4A_ADD);
      const isDel = l.startsWith(V4A_DEL);
      const prefix = isAdd ? V4A_ADD : isDel ? V4A_DEL : V4A_UPD;
      const path = l.slice(prefix.length).trim();
      // Collect the section's lines, up to the next section or *** End Patch.
      const contentStart = i + 1;
      const raw: string[] = [];
      let next = contentStart;
      while (next < last && !isV4aSectionStart(lines[next]!)) {
        raw.push(lines[next]!);
        next++;
      }
      const body = stripTrailingBlanks(raw);
      if (isAdd) {
        const fileLines: string[] = [];
        for (let k = 0; k < body.length; k++) {
          const bl = body[k]!;
          if (bl.startsWith('+')) fileLines.push(bl.slice(1));
          else if (bl === '') fileLines.push('');
          else throw new Exit2(`error: parse ${contentStart + k + 1}`);
        }
        edits.push(v4aAddEdit(path, fileLines));
      } else if (isDel) {
        if (body.length > 0) throw new Exit2(`error: parse ${contentStart + 1}`);
        edits.push(v4aDeleteEdit(path));
      } else {
        edits.push(v4aUpdateEdit(path, body, contentStart, i + 1, strict));
      }
      i = next;
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  return edits;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, body: string[], contentStart: number, updateLineNo: number, strict: boolean): Edit {
  const lineNo = (k: number): number => contentStart + k + 1;
  let moveTo: string | null = null;
  let idx = 0;
  if (body.length > 0 && body[0]!.startsWith(V4A_MOVE)) {
    moveTo = body[0]!.slice(V4A_MOVE.length).trim();
    idx = 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: { anchor: string | null; eof: boolean; body: BodyLine[] } | null = null;
  const flush = (): void => {
    if (cur === null) return;
    const { O, N } = bodyON(cur.body);
    chunks.push({ anchor: cur.anchor, eof: cur.eof, O, N });
    cur = null;
  };
  for (let k = idx; k < body.length; k++) {
    const l = body[k]!;
    if (l.startsWith('@@')) {
      flush();
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
    } else if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${lineNo(k)}`);
      cur.eof = true;
      flush();
    } else if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${lineNo(k)}`);
        cur = { anchor: null, eof: false, body: [] };
      }
      cur.body.push(toBodyLine(l));
    } else {
      throw new Exit2(`error: parse ${lineNo(k)}`);
    }
  }
  flush();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLineNo}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = parseFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let found = -1;
        for (const t of tiersToTry(strict)) {
          for (let j = cursor; j < f.lines.length; j++) {
            if (lineEq(f.lines[j]!, ch.anchor, t)) {
              found = j;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      if (ch.O.length === 0) {
        const insAt = ch.eof ? f.lines.length : cursor;
        const rep = buildReplacement(f.lines, insAt, 0, [], ch.N);
        f.lines.splice(insAt, 0, ...rep);
        cursor = insAt + rep.length;
      } else {
        let tier = -1;
        let pos = -1;
        for (const t of tiersToTry(strict)) {
          const occs = occurrences(f.lines, ch.O, t).filter((p) => p >= cursor && (!ch.eof || p + ch.O.length === f.lines.length));
          if (occs.length > 0) {
            tier = t;
            pos = occs[0]!;
            break;
          }
        }
        if (tier < 0) throw new Fail('no-match', path);
        const rep = buildReplacement(f.lines, pos, tier, ch.O, ch.N);
        f.lines.splice(pos, ch.O.length, ...rep);
        cursor = pos + rep.length;
      }
    }
    const out = serializeFile(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Changed paths, in byte order of the paths (UTF-8); a move line sorts by its new path.
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.now.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.now.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  for (const p of tree.now.keys()) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  if (!check) {
    // Read every original first (already cached above), then delete, then write,
    // so a file and a directory swapping places still lands correctly.
    const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p)).sort(byteCmp);
    for (const p of changed) {
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
