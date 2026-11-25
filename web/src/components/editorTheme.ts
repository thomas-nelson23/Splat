// CodeMirror in Steeze: code sits in a well, the cursor and selection are cyan, keywords are lit.
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

const c = {
  well: '#01070b',
  sidebar: '#040c13',
  hair: 'rgba(255, 255, 255, 0.07)',
  text: '#d9eef2',
  bright: '#ffffff',
  soft: '#9cc7cf',
  dim: '#7d9299',
  muted: '#58707a',
  cyan: '#00e5ff',
  cyan12: 'rgba(0, 229, 255, 0.12)',
  cyan25: 'rgba(0, 229, 255, 0.25)',
  mag: '#ff2bd6',
  brass: '#d576e3',
  coral: '#96f8ff',
  azure: '#5c9cff',
  redText: '#ff7a93',
};

const theme = EditorView.theme(
  {
    '&': { color: c.text, backgroundColor: c.well },
    '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
    '.cm-content': { caretColor: c.cyan },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: c.cyan, borderLeftWidth: '2px' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: c.cyan25 },
    '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, 0.035)' },
    '.cm-selectionMatch': { backgroundColor: c.cyan12 },
    '.cm-matchingBracket, .cm-nonmatchingBracket': { backgroundColor: 'transparent', outline: `1px solid ${c.cyan}`, color: c.bright },
    '.cm-gutters': { backgroundColor: c.sidebar, color: c.muted, border: 'none', borderRight: `1px solid ${c.hair}` },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: c.cyan },
    '.cm-foldPlaceholder': { backgroundColor: 'transparent', border: `1px solid ${c.hair}`, color: c.dim },
    '.cm-tooltip': { border: '1px solid rgba(255, 255, 255, 0.16)', backgroundColor: 'rgba(4, 12, 18, 0.97)', borderRadius: '2px' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: c.cyan12, color: c.bright },
    '.cm-panels': { backgroundColor: c.sidebar, color: c.text },
    '.cm-panels.cm-panels-top': { borderBottom: `1px solid ${c.hair}` },
    '.cm-searchMatch': { backgroundColor: c.cyan12, outline: `1px solid ${c.cyan25}` },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: c.cyan25 },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword], color: c.cyan },
  { tag: [t.standard(t.variableName), t.function(t.variableName), t.definition(t.function(t.variableName))], color: c.bright },
  { tag: [t.number, t.integer, t.float], color: c.brass },
  { tag: [t.string, t.special(t.string)], color: c.coral },
  { tag: [t.bool, t.atom, t.null], color: c.mag },
  { tag: [t.comment, t.lineComment, t.blockComment], color: c.dim, fontStyle: 'italic' },
  { tag: [t.operator, t.punctuation, t.bracket], color: c.soft },
  { tag: [t.variableName, t.propertyName], color: c.text },
  { tag: [t.special(t.variableName), t.meta], color: c.azure },
  { tag: t.invalid, color: c.redText },
]);

export const steezeEditor = [theme, syntaxHighlighting(highlight)];
