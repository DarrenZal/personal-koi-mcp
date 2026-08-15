/**
 * Frontmatter boundary detection for the vault WRITE path.
 *
 * This module exists because the previous inline logic destroyed data. It was:
 *
 *     if (content.startsWith('---')) {
 *       content.replace(/^---\s*\n[\s\S]*?\n---\n?/, () => fm)   // else prepend
 *     }
 *
 * Four separate defects lived in those two lines:
 *
 *  1. SILENT NO-OP. The branch was chosen by the lexical test `startsWith('---')`
 *     but the edit was performed by a regex that could fail to match (empty or
 *     unterminated frontmatter). `String.replace` then returns the input
 *     unchanged, the caller's frontmatter is discarded, and the write still
 *     reports success.
 *  2. BODY DELETION. A note with no frontmatter that merely *opens* with a `---`
 *     horizontal rule took the replace branch, and the lazy quantifier ate
 *     everything up to the next line starting with `---`.
 *  3. UNANCHORED CLOSING DELIMITER. `\n---\n?` matches the three-dash PREFIX of
 *     any line beginning with `---`, so `--- END OF TRANSCRIPT ---` or a
 *     four-dash rule `----` was accepted as the closing fence.
 *  4. (handled by the callers) a content-only write dropped existing frontmatter.
 *
 * Measured against the live vault (8,987 notes, 8,307 real frontmatter blocks)
 * and against 17,294 realistic horizontal-rule documents synthesised by
 * prefixing every real note body with a `---` rule:
 *
 *     old code                                 1003 / 17294 prose deletions
 *     anchored regex + yaml-object check ONLY    90 / 17294 prose deletions
 *     anchored regex + the full guard below       0 / 17294 prose deletions
 *
 * The middle row is why `isFrontmatterBlock` does more than `yaml.parse`:
 * requiring a non-null object is NOT sufficient, because ordinary prose such as
 * "handle this task for regen ai project, context below is from slack:" parses
 * as a perfectly good YAML mapping.
 *
 * Cost of the extra guards: 3 of 8,307 real blocks are rejected (all three are
 * Task notes whose frontmatter is a JSON blob mis-serialised as one quoted YAML
 * scalar, i.e. already broken). A rejected block is PREPENDED to instead of
 * replaced, which is visible and reversible; the opposite error deletes prose.
 */

import * as YAML from 'yaml';

/**
 * Frontmatter fence, anchored to LINE boundaries at both ends.
 *
 * - `^---[ \t]*\r?\n`        opening fence: nothing but optional trailing blanks
 * - `(?:([\s\S]*?)\r?\n)?`   the block, OPTIONAL so `---\n---\n` (empty frontmatter) matches
 * - `---[ \t]*(?:\r?\n|$)`   closing fence must be a whole line, or the final line
 *                            of the file with no trailing newline
 *
 * No `m` flag: the opening fence is only ever recognised at offset 0.
 */
export const FRONTMATTER_BLOCK_RE =
  /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

/** A YAML mapping key we are willing to believe came from real frontmatter. */
const PLAUSIBLE_KEY_RE = /^[@A-Za-z_][\w @.\-/]*$/;

/** A line that opens a YAML mapping: `key:`, `"@id":`, `'a b':`. */
const KEY_LINE_RE = /^(?:"[^"]*"|'[^']*'|[A-Za-z_@][^:\r\n]*?)\s*:(?:\s|$)/;

/** Obsidian writes `@type:` / `@id:`; quote them defensively before parsing. */
function quoteAtKeys(text: string): string {
  return text.replace(/^(\s*)(@[\w-]+)(\s*:)/gm, '$1"$2"$3');
}

export interface FrontmatterBlock {
  /** offset of the opening fence (always 0 today, kept explicit for the splice) */
  index: number;
  /** length of the whole fenced region including both fences */
  length: number;
  /** the exact source text of the fenced region, byte for byte */
  raw: string;
  /** the inner YAML text, or undefined for an empty block */
  yamlText: string | undefined;
  /** parsed mapping; `{}` for an empty block */
  data: Record<string, unknown>;
}

/**
 * Decide whether a captured block is really frontmatter rather than the top of a
 * document that happens to open with a horizontal rule.
 *
 * Returns the parsed mapping, or null to mean "not frontmatter".
 */
function validateBlock(yamlText: string | undefined): Record<string, unknown> | null {
  // Empty frontmatter is legal and Obsidian writes it: `---\n---\n`.
  if (yamlText === undefined || yamlText.trim() === '') return {};

  let parsed: unknown;
  try {
    // logLevel silent: yaml emits warnings via process.emitWarning, which is
    // noise on an MCP server's stderr and tells us nothing we do not check here.
    parsed = YAML.parse(quoteAtKeys(yamlText), { logLevel: 'silent' });
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  // Guard 1: the first non-blank line must open a mapping. Prose that merely
  // contains a colon further down does not qualify.
  const firstLine = yamlText.split(/\r?\n/).find((l) => l.trim() !== '');
  if (firstLine === undefined || !KEY_LINE_RE.test(firstLine.replace(/^\s+/, ''))) return null;

  // Guard 2: every top-level key must look like a key. Prose sentences parse to
  // mappings whose "keys" are whole clauses; frontmatter keys are identifiers.
  const keys = Object.keys(parsed as Record<string, unknown>);
  if (!keys.every((k) => k.length > 0 && k.length <= 64 && PLAUSIBLE_KEY_RE.test(k))) return null;

  return parsed as Record<string, unknown>;
}

/**
 * Locate a *validated* frontmatter block at the very start of `content`.
 * Returns null when there is none - including when the document opens with a
 * horizontal rule, which must fall through to a PREPEND, never to a replace.
 */
export function findFrontmatterBlock(content: string): FrontmatterBlock | null {
  const m = FRONTMATTER_BLOCK_RE.exec(content);
  if (!m) return null;
  const data = validateBlock(m[1]);
  if (data === null) return null;
  return {
    index: m.index,
    length: m[0].length,
    raw: m[0],
    yamlText: m[1],
    data,
  };
}

/**
 * How the frontmatter of a written note was resolved. Always reported to the
 * caller: a write that could not place the frontmatter it was handed must be
 * observable, never a silent success.
 */
export type FrontmatterMode =
  /** an existing valid block was replaced by the caller's frontmatter */
  | 'replaced'
  /** the caller's frontmatter was inserted above content that had none */
  | 'prepended'
  /** content-only write; the file's existing frontmatter was carried over */
  | 'preserved'
  /** content-only write with clearFrontmatter; existing frontmatter dropped on purpose */
  | 'cleared'
  /** nothing to do: no frontmatter supplied and none to carry over, or the
   *  content already carries its own block and the caller supplied none */
  | 'unchanged';

export interface PrependStyle {
  /** text inserted between the frontmatter block and the body */
  separator: string;
  /** drop one leading newline from the body before joining */
  stripLeadingNewline?: boolean;
}

/**
 * Put `fmBlock` (a complete `---\n...\n---\n` string) onto `content`.
 *
 * Splices by slice rather than String.replace so that no `$&`, `$'`, `` $` `` or
 * `$$` inside a frontmatter VALUE can be expanded as a replacement template -
 * `$'` in particular would splice the whole note body into a YAML value.
 */
export function applyFrontmatterBlock(
  content: string,
  fmBlock: string,
  style: PrependStyle
): { text: string; mode: 'replaced' | 'prepended' } {
  const found = findFrontmatterBlock(content);
  if (found) {
    return {
      text: content.slice(0, found.index) + fmBlock + content.slice(found.index + found.length),
      mode: 'replaced',
    };
  }
  const body = style.stripLeadingNewline && content.startsWith('\n') ? content.slice(1) : content;
  return { text: fmBlock + style.separator + body, mode: 'prepended' };
}
