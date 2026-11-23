// mend — one patch tool for every AI edit format.
//
// mend applies an edit that an AI model wrote to a tree of text files. Models write edits in four
// formats: unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and
// text-editor tool calls as JSON. This file implements the whole of SPEC.md from scratch: the command
// line (section 1), output and exit codes (2), files, lines and paths (3), format detection (4),
// three-tier line matching (5), the four readers (6 to 9) and the order and atomicity rules (10).
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below), which runs this file once per check without the variable.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** Exit 2: carries the one line standard output must hold. */
class Fatal {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';
const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadOf = (s: string): string => /^[ \t]*/.exec(s)![0]!;

/** A patch's lines (SPEC.md section 3): split at \n, one trailing \r removed from each, and no empty
 *  piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A safe path (section 3): not empty, no leading /, no backslash, no empty, . or .. segment. */
function safePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** A text file as its lines, its own line break, and whether it ends with one. */
interface TextFile {
  lines: string[];
  brk: '\n' | '\r\n';
  tail: boolean;
}

function splitText(text: string): TextFile {
  if (text === '') return { lines: [], brk: '\n', tail: false };
  const nl = text.indexOf('\n');
  const brk: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(brk);
  const tail = text.endsWith(brk);
  if (tail) lines.pop();
  return { lines, brk, tail };
}

function joinText(f: TextFile): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.brk) + (f.tail ? f.brk : '');
}

/** The tree as the edits leave it: an overlay on the working directory. Nothing is written to disk
 *  until every edit has run and none has failed (section 10). */
class VTree {
  private disk = new Map<string, string | null>();
  private cur = new Map<string, string | null>();
  moves: Array<readonly [string, string]> = [];

  /** The path's bytes before the patch (null: it did not exist). */
  before(p: string): string | null {
    if (!this.disk.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.disk.set(p, v);
    }
    return this.disk.get(p)!;
  }

  read(p: string): string | null {
    return this.cur.has(p) ? this.cur.get(p)! : this.before(p);
  }

  write(p: string, v: string | null): void {
    this.cur.set(p, v);
  }

  touched(): string[] {
    return [...this.cur.keys()];
  }

  snapshot(): { cur: Map<string, string | null>; moves: number } {
    return { cur: new Map(this.cur), moves: this.moves.length };
  }

  restore(s: { cur: Map<string, string | null>; moves: number }): void {
    this.cur = new Map(s.cur);
    this.moves.length = s.moves;
  }
}

/** One edit of a patch: applies itself to the tree, or throws Fail. */
type Edit = (tree: VTree, strict: boolean) => void;

// ---------------------------------------------------------------- matching (section 5)

type Mark = ' ' | '-' | '+' | '\\';

/** One line of a hunk or chunk body. blankLine marks a literally empty patch line (a context line
 *  whose text is empty); such lines at the end of a body are not part of it. */
interface Piece {
  mark: Mark;
  text: string;
  blankLine?: boolean;
}

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

/** Every start position at or after `from` where oTexts matches fileLines at the given tier. */
function occurrences(fileLines: string[], oTexts: string[], tier: number, from: number, endOnly: boolean): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, from); i + oTexts.length <= fileLines.length; i += 1) {
    if (endOnly && i + oTexts.length !== fileLines.length) continue;
    let ok = true;
    for (let k = 0; k < oTexts.length; k += 1) {
      if (!lineEq(fileLines[i + k]!, oTexts[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which oTexts occurs (tier 0 only when strict), or null when it occurs at none. */
function findMatch(
  fileLines: string[],
  oTexts: string[],
  strict: boolean,
  from = 0,
  endOnly = false,
): { tier: number; starts: number[] } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const starts = occurrences(fileLines, oTexts, tier, from, endOnly);
    if (starts.length > 0) return { tier, starts };
  }
  return null;
}

/** The lines a match writes: a context line is the file's own matched line, never the patch's; at
 *  tier 2 every other new line is re-indented from the patch's first old line onto the file's first
 *  matched line. */
function replacementLines(fileLines: string[], start: number, pieces: Piece[], tier: number): string[] {
  const olds = pieces.filter((p) => p.mark === ' ' || p.mark === '-');
  const news = pieces.filter((p) => p.mark === ' ' || p.mark === '+');
  const oldIndex = new Map<Piece, number>();
  olds.forEach((p, i) => oldIndex.set(p, i));
  let patchLead = '';
  let fileLead = '';
  if (tier === 2 && olds.length > 0) {
    patchLead = leadOf(olds[0]!.text);
    fileLead = leadOf(fileLines[start]!);
  }
  return news.map((p) => {
    if (p.mark === ' ') return fileLines[start + oldIndex.get(p)!]!;
    if (tier === 2 && p.text.trim() !== '' && p.text.startsWith(patchLead)) {
      return fileLead + p.text.slice(patchLead.length);
    }
    return p.text;
  });
}

/** Whether a `\` line follows the piece list's last context or `+` line (the "\ No newline" marker). */
function noEolAfter(pieces: Piece[]): boolean {
  let last = -1;
  pieces.forEach((p, i) => {
    if (p.mark === ' ' || p.mark === '+') last = i;
  });
  return last >= 0 && pieces[last + 1]?.mark === '\\';
}

// ---------------------------------------------------------------- unified diffs (section 6)

interface UHunk {
  a: number;
  pieces: Piece[];
}

interface USection {
  gitOld?: string;
  gitNew?: string;
  headOld?: string;
  headNew?: string;
  renFrom?: string;
  renTo?: string;
  isNew: boolean;
  isDel: boolean;
  hunks: UHunk[];
}

/** The path a --- or +++ line names: after the four characters, up to the first tab, surrounding
 *  spaces removed, and a leading a/ or b/ removed. */
function headPath(raw: string): string {
  let p = raw.split('\t')[0]!.replace(/^ +/, '').replace(/ +$/, '');
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** The two paths of a `diff --git a/<X> b/<Y>` line, or null when the line is not of that form. */
function gitPaths(line: string): readonly [string, string] | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const cut = rest.indexOf(' b/', 2);
  if (cut < 0) return null;
  const x = rest.slice(2, cut);
  const y = rest.slice(cut + 3);
  if (x === '' || y === '') return null;
  return [x, y];
}

function unifiedEdit(sec: USection): Edit {
  return (tree, strict) => {
    const oldRaw = sec.headOld ?? sec.renFrom ?? sec.gitOld;
    const newRaw = sec.headNew ?? sec.renTo ?? sec.gitNew;
    const create = sec.isNew || oldRaw === '/dev/null';
    const del = sec.isDel || newRaw === '/dev/null';
    if (create) {
      const target = newRaw ?? '';
      if (!safePath(target)) throw new Fail('unsafe', target);
      if (tree.read(target) !== null) throw new Fail('exists', target);
      const all: Piece[] = [];
      for (const h of sec.hunks) all.push(...h.pieces);
      const plusTexts: string[] = [];
      let lastPlus = -1;
      all.forEach((p, i) => {
        if (p.mark === '+') {
          plusTexts.push(p.text);
          lastPlus = i;
        }
      });
      const tail = lastPlus < 0 || all[lastPlus + 1]?.mark !== '\\';
      tree.write(target, joinText({ lines: plusTexts, brk: '\n', tail }));
      return;
    }
    if (del) {
      const target = oldRaw ?? '';
      if (!safePath(target)) throw new Fail('unsafe', target);
      if (tree.read(target) === null) throw new Fail('missing', target);
      tree.write(target, null);
      return;
    }
    const from = oldRaw ?? '';
    const to = newRaw ?? '';
    if (!safePath(from)) throw new Fail('unsafe', from);
    if (to !== from && !safePath(to)) throw new Fail('unsafe', to);
    const content = tree.read(from);
    if (content === null) throw new Fail('missing', from);
    const move = to !== from;
    if (move && tree.read(to) !== null) throw new Fail('exists', to);
    const f = splitText(content);
    let d = 0;
    for (const h of sec.hunks) {
      const oTexts = h.pieces.filter((p) => p.mark === ' ' || p.mark === '-').map((p) => p.text);
      const nCount = h.pieces.filter((p) => p.mark === ' ' || p.mark === '+').length;
      if (oTexts.length === 0) {
        const adds = h.pieces.filter((p) => p.mark === '+').map((p) => p.text);
        const pos = Math.min(Math.max(h.a + d, 0), f.lines.length);
        const atEnd = pos === f.lines.length;
        f.lines.splice(pos, 0, ...adds);
        if (atEnd) f.tail = !noEolAfter(h.pieces);
      } else {
        const found = findMatch(f.lines, oTexts, strict);
        if (found === null) throw new Fail('no-match', from);
        const target = h.a - 1 + d;
        let start = found.starts[0]!;
        for (const s of found.starts) {
          if (Math.abs(s - target) < Math.abs(start - target)) start = s;
        }
        const reachesEnd = start + oTexts.length === f.lines.length;
        const repl = replacementLines(f.lines, start, h.pieces, found.tier);
        f.lines.splice(start, oTexts.length, ...repl);
        if (reachesEnd) f.tail = !noEolAfter(h.pieces);
      }
      d += nCount - oTexts.length;
    }
    const out = joinText(f);
    if (move) {
      tree.write(from, null);
      tree.write(to, out);
      tree.moves.push([from, to]);
    } else {
      tree.write(from, out);
    }
  };
}

function readUnified(lines: string[]): Edit[] {
  const sections: USection[] = [];
  let sec: USection | null = null;
  let i = 0;
  const fail = (n: number): never => {
    throw new Fatal(`error: parse ${n}`);
  };
  while (i < lines.length) {
    const line = lines[i]!;
    const no = i + 1;
    if (line.startsWith('diff --git ')) {
      const g = gitPaths(line);
      if (g === null) fail(no);
      sec = { gitOld: g![0], gitNew: g![1], isNew: false, isDel: false, hunks: [] };
      sections.push(sec);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (sec === null || sec.headOld !== undefined) {
        sec = { isNew: false, isDel: false, hunks: [] };
        sections.push(sec);
      }
      sec.headOld = headPath(line.slice(4));
      sec.headNew = headPath(lines[i + 1]!.slice(4));
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (sec === null) fail(no);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) fail(no);
      const pieces: Piece[] = [];
      i += 1;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') {
          pieces.push({ mark: ' ', text: '', blankLine: true });
          i += 1;
          continue;
        }
        const c = b[0]!;
        if (c === ' ' || c === '-' || c === '+' || c === '\\') {
          // A context line whose text is empty counts as an empty line, like a literally empty one.
          pieces.push({ mark: c as Mark, text: c === '\\' ? '' : b.slice(1), blankLine: c === ' ' && b.length === 1 });
          i += 1;
          continue;
        }
        break;
      }
      while (pieces.length > 0 && pieces[pieces.length - 1]!.blankLine === true) pieces.pop();
      sec.hunks.push({ a: Number(m![1]), pieces });
      continue;
    }
    if (sec !== null && sec.hunks.length === 0) {
      // The section's header, before its first hunk: paths, renames and modes are read here; a ---
      // line whose next line is not +++ is a parse fault naming the line after it; anything else is
      // ignored.
      if (line.startsWith('--- ')) fail(no + 1);
      if (line.startsWith('+++ ')) {
        sec.headNew = headPath(line.slice(4));
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        sec.renFrom = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        sec.renTo = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.isNew = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.isDel = true;
        i += 1;
        continue;
      }
    }
    i += 1; // outside bodies and headers, lines are ignored (prose, code fences)
  }
  return sections.map(unifiedEdit);
}

// ---------------------------------------------------------------- SEARCH/REPLACE (section 7)

function readSearchReplace(lines: string[]): Edit[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const at = i;
    let path: string | null = null;
    for (let j = at - 1; j >= prevEnd; j -= 1) {
      const cand = lines[j]!;
      if (!isBlank(cand) && !cand.trim().startsWith('```')) {
        path = cand.trim();
        break;
      }
    }
    if (path === null) {
      if (blocks.length === 0) throw new Fatal(`error: parse ${at + 1}`);
      path = blocks[blocks.length - 1]!.path;
    }
    let eq = -1;
    for (let k = at + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    if (eq < 0) throw new Fatal(`error: parse ${at + 1}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new Fatal(`error: parse ${at + 1}`);
    blocks.push({ path, oldLines: lines.slice(at + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return blocks.map((b) => (tree, strict) => {
    if (!safePath(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.read(b.path) !== null) throw new Fail('exists', b.path);
      tree.write(b.path, joinText({ lines: [...b.newLines], brk: '\n', tail: true }));
      return;
    }
    const content = tree.read(b.path);
    if (content === null) throw new Fail('missing', b.path);
    const f = splitText(content);
    const found = findMatch(f.lines, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.starts.length > 1) throw new Fail('ambiguous', b.path);
    const pieces: Piece[] = [
      ...b.oldLines.map((t) => ({ mark: '-' as Mark, text: t })),
      ...b.newLines.map((t) => ({ mark: '+' as Mark, text: t })),
    ];
    const repl = replacementLines(f.lines, found.starts[0]!, pieces, found.tier);
    f.lines.splice(found.starts[0]!, b.oldLines.length, ...repl);
    tree.write(b.path, joinText(f));
  });
}

// ---------------------------------------------------------------- V4A (section 8)

interface VChunk {
  anchor: string | null;
  eof: boolean;
  pieces: Piece[];
  real: boolean; // started by @@, closed by End of File, or holding a non-blank body line
}

interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  atLine: number;
  addLines: string[];
  moveTo?: string;
  chunks: VChunk[];
}

function v4aEdit(sec: VSection): Edit {
  return (tree, strict) => {
    if (!safePath(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.read(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.write(sec.path, joinText({ lines: [...sec.addLines], brk: '\n', tail: true }));
      return;
    }
    if (sec.kind === 'del') {
      if (tree.read(sec.path) === null) throw new Fail('missing', sec.path);
      tree.write(sec.path, null);
      return;
    }
    if (sec.moveTo !== undefined && !safePath(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const content = tree.read(sec.path);
    if (content === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== undefined && tree.read(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const f = splitText(content);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        let at = -1;
        for (const tier of strict ? [0] : [0, 1, 2]) {
          for (let j = cursor; j < f.lines.length; j += 1) {
            if (lineEq(f.lines[j]!, ch.anchor, tier)) {
              at = j;
              break;
            }
          }
          if (at >= 0) break;
        }
        if (at < 0) throw new Fail('no-match', sec.path);
        cursor = at + 1;
      }
      const oTexts = ch.pieces.filter((p) => p.mark === ' ' || p.mark === '-').map((p) => p.text);
      if (oTexts.length === 0) {
        const adds = ch.pieces.filter((p) => p.mark === '+').map((p) => p.text);
        const pos = ch.eof ? f.lines.length : Math.min(cursor, f.lines.length);
        f.lines.splice(pos, 0, ...adds);
        cursor = pos + adds.length;
      } else {
        const found = findMatch(f.lines, oTexts, strict, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', sec.path);
        const start = found.starts[0]!;
        const repl = replacementLines(f.lines, start, ch.pieces, found.tier);
        f.lines.splice(start, oTexts.length, ...repl);
        cursor = start + repl.length;
      }
    }
    const out = joinText(f);
    if (sec.moveTo !== undefined) {
      tree.write(sec.path, null);
      tree.write(sec.moveTo, out);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.write(sec.path, out);
    }
  };
}

function readV4a(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Fatal('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Fatal(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && isBlank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Fatal(`error: parse ${lines.length + 1}`);
  const ADD = '*** Add File: ';
  const DEL = '*** Delete File: ';
  const UPD = '*** Update File: ';
  const MOV = '*** Move to: ';
  const secStart = (l: string): { kind: 'add' | 'del' | 'upd'; path: string } | null => {
    if (l.startsWith(ADD)) return { kind: 'add', path: l.slice(ADD.length).trim() };
    if (l.startsWith(DEL)) return { kind: 'del', path: l.slice(DEL.length).trim() };
    if (l.startsWith(UPD)) return { kind: 'upd', path: l.slice(UPD.length).trim() };
    return null;
  };
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    const head = secStart(line);
    if (head === null) throw new Fatal(`error: parse ${i + 1}`);
    const sec: VSection = { ...head, atLine: i + 1, addLines: [], chunks: [] };
    i += 1;
    const body: { no: number; line: string }[] = [];
    while (i < last && secStart(lines[i]!) === null) {
      body.push({ no: i + 1, line: lines[i]! });
      i += 1;
    }
    if (head.kind === 'add') {
      while (body.length > 0 && isBlank(body[body.length - 1]!.line)) body.pop();
      const fl: { text: string; blankLine: boolean }[] = [];
      for (const b of body) {
        if (b.line.startsWith('+')) fl.push({ text: b.line.slice(1), blankLine: false });
        else if (b.line === '') fl.push({ text: '', blankLine: true });
        else throw new Fatal(`error: parse ${b.no}`);
      }
      while (fl.length > 0 && fl[fl.length - 1]!.blankLine) fl.pop();
      sec.addLines = fl.map((x) => x.text);
    } else if (head.kind === 'del') {
      for (const b of body) {
        if (!isBlank(b.line)) throw new Fatal(`error: parse ${b.no}`);
      }
    } else {
      // Blank lines at the end of the section are not part of it (a line of only whitespace is
      // blank), so a chunk never ends with the padding lines a writer leaves before the next header.
      while (body.length > 0 && isBlank(body[body.length - 1]!.line)) body.pop();
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let moveTo: string | undefined;
      for (const b of body) {
        const l = b.line;
        if (l.startsWith(MOV)) {
          if (moveTo !== undefined || chunks.length > 0 || cur !== null) {
            throw new Fatal(`error: parse ${b.no}`);
          }
          moveTo = l.slice(MOV.length).trim();
          continue;
        }
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, pieces: [], real: true };
          chunks.push(cur);
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (cur === null) {
            chunks.push({ anchor: null, eof: true, pieces: [], real: true });
          } else {
            cur.eof = true;
            cur.real = true;
            cur = null;
          }
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            cur = { anchor: null, eof: false, pieces: [], real: false };
            chunks.push(cur);
          }
          if (l === '') {
            cur.pieces.push({ mark: ' ', text: '', blankLine: true });
          } else {
            cur.pieces.push({ mark: l[0] as Mark, text: l.slice(1) });
            cur.real = true;
          }
          continue;
        }
        throw new Fatal(`error: parse ${b.no}`);
      }
      const lastChunk = chunks[chunks.length - 1];
      if (lastChunk !== undefined) {
        while (lastChunk.pieces.length > 0 && lastChunk.pieces[lastChunk.pieces.length - 1]!.blankLine === true) {
          lastChunk.pieces.pop();
        }
      }
      const kept = chunks.filter((c) => c.real || c.pieces.some((p) => p.blankLine !== true));
      if (kept.length === 0 && moveTo === undefined) throw new Fatal(`error: parse ${sec.atLine}`);
      sec.chunks = kept;
      sec.moveTo = moveTo;
    }
    sections.push(sec);
  }
  return sections.map(v4aEdit);
}

// ---------------------------------------------------------------- JSON edits (section 9)

/** One JSON edit object, or null when it is not one (a parse fault where it stands). */
function jsonObjectEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      if (tree.read(p) !== null) throw new Fail('exists', p);
      tree.write(p, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      const before = tree.read(p);
      if (before === null) throw new Fail('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.split('\r\n').join('\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.write(p, crlf ? out.split('\n').join('\r\n') : out);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const at = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      const before = tree.read(p);
      if (before === null) throw new Fail('missing', p);
      const f = splitText(before);
      if (at < 0 || at > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(at, 0, ...add);
      tree.write(p, joinText(f));
    };
  }
  return null;
}

function readJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Fatal('error: parse 1');
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Fatal(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Fatal(`error: parse ${first + 1}`);
    const edits: Edit[] = [];
    for (const x of v) {
      const e = jsonObjectEdit(x);
      if (e === null) throw new Fatal(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  const edits: Edit[] = [];
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonObjectEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Fatal(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------- detection (section 4)

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart().charAt(0);
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, idx) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------- the command line (sections 1, 2, 10)

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

function runCli(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  let optionsDone = false;
  const positional: string[] = [];
  for (const a of args) {
    if (!optionsDone && a === '--') {
      optionsDone = true;
      continue;
    }
    if (!optionsDone && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.includes(a.slice('--format='.length))) {
        format = a.slice('--format='.length);
      } else if (a === '--check' && !checkOnly) {
        checkOnly = true;
      } else if (a === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };
  const patchArg = positional.length === 0 || positional[0] === '-' ? null : positional[0]!;
  let text = '';
  try {
    text = readFileSync(patchArg ?? 0, 'utf8');
  } catch {
    if (patchArg !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'unified') edits = readUnified(lines);
    else if (kind === 'search-replace') edits = readSearchReplace(lines);
    else if (kind === 'v4a') edits = readV4a(lines);
    else edits = readJson(text, lines);
    if (edits.length === 0) throw new Fatal('error: parse 1');
  } catch (e) {
    if (e instanceof Fatal) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new VTree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const snap = tree.snapshot();
    try {
      edit(tree, strict);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.restore(snap);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const changed = tree.touched().filter((p) => tree.before(p) !== tree.read(p));
  const used = new Set<string>();
  const byNew = new Map<string, string>();
  for (const [o, n] of tree.moves) {
    if (
      tree.before(o) !== null &&
      tree.read(o) === null &&
      tree.before(n) === null &&
      tree.read(n) !== null &&
      !used.has(o) &&
      !used.has(n)
    ) {
      byNew.set(n, o);
      used.add(o);
      used.add(n);
    }
  }
  const rows: { key: string; line: string }[] = [];
  for (const p of changed) {
    if (byNew.has(p)) {
      rows.push({ key: p, line: `R ${byNew.get(p)!} -> ${p}` });
    } else if (used.has(p)) {
      continue; // the old half of a move: its R line covers it
    } else {
      const was = tree.before(p);
      const now = tree.read(p);
      rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    }
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key, 'utf8'), Buffer.from(y.key, 'utf8')));
  if (!checkOnly) {
    for (const p of changed) {
      const now = tree.read(p);
      if (now === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const n = rows.length;
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${n} ${n === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without
  // this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = runCli(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
