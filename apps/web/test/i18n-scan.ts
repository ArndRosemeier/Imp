import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

/**
 * Reads the app's source the way a translator would: every piece of text a
 * person can read, and every `t`, `tn` and `tx` call. The i18n test uses it to
 * fail on text that skipped translation, and on translations that are missing.
 */

/** Words that read the same in every language: names of products, formats and Imp itself. */
const SAME_EVERYWHERE = new Set([
  'Imp',
  'OpenRouter',
  'ffmpeg',
  'MP4',
  'WebM',
  'Fountain',
  'GitHub',
  'Chrome',
  'Safari',
  'Edge',
  'iPad',
  'LUFS',
  'node imp.mjs',
  'OK',
]);

/** Keyboard keys, compared with event.key rather than shown. */
const KEY_NAMES = new Set([
  'Home',
  'End',
  'Enter',
  'Escape',
  'Backspace',
  'Delete',
  'Tab',
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Insert',
]);

/** JSX attributes that hold names for code, not words for people. */
const CODE_ATTRIBUTES = new Set([
  'className',
  'id',
  'type',
  'role',
  'href',
  'key',
  'htmlFor',
  'name',
  'mode',
  'variant',
  'size',
  'src',
  'target',
  'rel',
  'accept',
  'autoComplete',
  'inputMode',
  'method',
  'lang',
  'dir',
  'weight',
  'tone',
  'kind',
  'align',
  'side',
  'direction',
  'orientation',
  'step',
  'min',
  'max',
  'pattern',
  'form',
  'd',
  'viewBox',
  'fill',
  'stroke',
  'xmlns',
  'preserveAspectRatio',
  'strokeWidth',
  'strokeLinecap',
  'strokeLinejoin',
  'transform',
  'points',
  'cx',
  'cy',
  'r',
  'x',
  'y',
  'width',
  'height',
  'x1',
  'x2',
  'y1',
  'y2',
  'offset',
  'stopColor',
  'gradientUnits',
  'fillRule',
  'clipRule',
  'fontFamily',
  'textAnchor',
  'dominantBaseline',
  'enterKeyHint',
  'capture',
  'preload',
  'crossOrigin',
  'download',
  'value',
  'defaultValue',
  'spellCheck',
  'autoCapitalize',
  'autoCorrect',
  'scope',
  'icon',
  'stage',
  'area',
  'topic',
  'place',
  'track',
  'lane',
  'group',
  'shape',
  'format',
  'color',
  'command',
  'setting',
  'prefix',
  'list',
  'wrap',
  'keys',
  'aria-keyshortcuts',
]);

/** Object properties that hold names for code. */
const CODE_PROPERTIES = new Set([
  'className',
  'id',
  'key',
  'type',
  'role',
  'kind',
  'mode',
  'variant',
  'href',
  'src',
  'icon',
  'tone',
  'mediaType',
  'accept',
  'area',
  'stage',
]);

/** Calls whose string arguments are for code: ids, keys, selectors, logs. */
const CODE_CALLS =
  /^(t|tn|tx|console\.\w+|.*\.includes|.*\.startsWith|.*\.endsWith|.*\.getItem|.*\.setItem|.*\.removeItem|matchMedia|.*\.querySelector(All)?|.*\.addEventListener|.*\.removeEventListener|document\.createElement|.*\.closest|.*\.subscribe|useLive|runCommand|.*\.run|.*\.dispatchEvent|.*\.setAttribute|.*\.getAttribute|.*\.replace|.*\.split|.*\.join|.*\.indexOf)$/;

const TRANSLATORS = new Set(['t', 'tn', 'tx']);

/** Whether a string in code reads as words for a person rather than a name for code. */
export function readsAsWords(text: string): boolean {
  const value = text.trim();
  if (
    value.length < 2 ||
    !/[A-Za-z]/.test(value) ||
    KEY_NAMES.has(value) ||
    SAME_EVERYWHERE.has(value)
  )
    return false;
  if (/[\\/<>=#{}]|--|^[a-z0-9.:_-]+$|^[a-z][\w-]*( [a-z][\w-]*)*$/.test(value)) {
    // Lower-case words with no capital and no punctuation are class lists and ids, unless
    // they are a sentence fragment of three words or more.
    if (!/^[a-z’']+( [a-z’']+){2,}$/.test(value)) return false;
  }
  if (/^[A-Z][a-z’']/.test(value)) return true;
  return /[A-Za-z’']{2,} [A-Za-z’']{2,}/.test(value);
}

function attributeReadsAsWords(name: string, value: string): boolean {
  if (CODE_ATTRIBUTES.has(name) || name.startsWith('data-') || name.startsWith('aria-live')) {
    return false;
  }
  if (SAME_EVERYWHERE.has(value.trim())) return false;
  return /[A-Za-z]/.test(value) && (/^[A-Z]/.test(value) || value.includes(' '));
}

/** JSX text as React renders it: lines trimmed and joined with single spaces. */
function rendered(raw: string): string {
  const lines = raw.split(/\r?\n/);
  if (lines.length === 1) return raw;
  return lines
    .map((line, index) => {
      let kept = line;
      if (index > 0) kept = kept.replace(/^[ \t]+/, '');
      if (index < lines.length - 1) kept = kept.replace(/[ \t]+$/, '');
      return kept;
    })
    .filter((line) => line !== '')
    .join(' ');
}

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

export interface Use extends Finding {
  /** The English key, with its {placeholders}. */
  readonly key: string;
}

export interface Scan {
  /** Text a person reads that is not passed through a translator. */
  readonly untranslated: Finding[];
  /** Translator calls at the top of a module, which would not follow a change of language. */
  readonly tooEarly: Finding[];
  /** Every literal key passed to t or tn. */
  readonly uses: Use[];
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

function insideFunction(node: ts.Node): boolean {
  for (let at = node.parent as ts.Node | undefined; at !== undefined; at = at.parent) {
    if (ts.isFunctionLike(at)) return true;
  }
  return false;
}

function forCode(node: ts.Node): boolean {
  const parent = node.parent;
  if (
    ts.isImportDeclaration(parent) ||
    ts.isExportDeclaration(parent) ||
    ts.isExternalModuleReference(parent) ||
    ts.isLiteralTypeNode(parent)
  ) {
    return true;
  }
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isEnumMember(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isPropertyDeclaration(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return true;
  if (
    ts.isBinaryExpression(parent) &&
    [
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken,
      ts.SyntaxKind.InKeyword,
    ].includes(parent.operatorToken.kind)
  ) {
    return true;
  }
  if (ts.isCaseClause(parent) || ts.isTaggedTemplateExpression(parent)) return true;
  if (ts.isCallExpression(parent) && CODE_CALLS.test(parent.expression.getText())) return true;
  if (
    ts.isNewExpression(parent) &&
    /^(RegExp|URL|CustomEvent|Event|KeyboardEvent|Blob|File)$/.test(parent.expression.getText())
  ) {
    return true;
  }
  for (let at: ts.Node = parent; !ts.isSourceFile(at); at = at.parent) {
    if (ts.isJsxAttribute(at)) {
      const name = at.name.getText();
      return CODE_ATTRIBUTES.has(name) || name.startsWith('data-');
    }
    if (
      ts.isPropertyAssignment(at) &&
      ts.isIdentifier(at.name) &&
      CODE_PROPERTIES.has(at.name.text)
    ) {
      return true;
    }
    if (ts.isJsxElement(at) || ts.isFunctionLike(at) || ts.isBlock(at)) return false;
  }
  return false;
}

/** The text of a template with its substitutions as {placeholders}. */
function templateText(node: ts.TemplateExpression): string {
  return node.head.text + node.templateSpans.map((span) => `{x}${span.literal.text}`).join('');
}

function ignored(source: ts.SourceFile, node: ts.Node): boolean {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  const lines = source.text.split('\n');
  return [lines[line], lines[line - 1]].some((text) => text?.includes('i18n-ignore') === true);
}

export function scan(root: string, skip: (path: string) => boolean): Scan {
  const result: Scan = { untranslated: [], tooEarly: [], uses: [] };
  for (const path of files(root)) {
    if (skip(path)) continue;
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const at = (node: ts.Node, text: string): Finding => ({
      file: relative(root, path),
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      text,
    });
    // A file that keeps its words per language itself says so once, at the top.
    const ownWords = source.text.includes('i18n-ignore-file');
    const flag = (node: ts.Node, text: string): void => {
      if (!ownWords && !ignored(source, node)) result.untranslated.push(at(node, text));
    };
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        if (TRANSLATORS.has(name)) {
          if (!insideFunction(node)) result.tooEarly.push(at(node, node.getText(source)));
          const keys = name === 'tn' ? node.arguments.slice(1, 3) : node.arguments.slice(0, 1);
          if (name !== 'tx') {
            for (const key of keys) {
              if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) {
                result.uses.push({ ...at(key, key.text), key: key.text });
              } else {
                result.untranslated.push(at(key, `${name}() needs a literal: ${key.getText()}`));
              }
            }
          }
          // The values passed in can hold text of their own.
          node.arguments.slice(name === 'tn' ? 3 : 1).forEach(visit);
          return;
        }
      }
      if (ts.isJsxText(node)) {
        const text = rendered(node.text).trim();
        // A lone letter is a glyph, such as the A that shows a text size.
        if (/[A-Za-z]{2}|[A-Za-z] [A-Za-z]/.test(text) && !SAME_EVERYWHERE.has(text))
          flag(node, text);
      } else if (
        ts.isJsxAttribute(node) &&
        node.initializer !== undefined &&
        ts.isStringLiteral(node.initializer)
      ) {
        if (attributeReadsAsWords(node.name.getText(source), node.initializer.text)) {
          flag(node, `${node.name.getText(source)}="${node.initializer.text}"`);
        }
        return;
      } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        if (readsAsWords(node.text) && !forCode(node)) flag(node, node.text);
      } else if (ts.isTemplateExpression(node)) {
        const text = templateText(node);
        if (readsAsWords(text.replace(/\{x\}/g, 'X ')) && !forCode(node)) flag(node, text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return result;
}

/** The {placeholders} a text fills, sorted. */
export function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();
}
