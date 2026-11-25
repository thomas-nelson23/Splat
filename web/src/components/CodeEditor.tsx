import { useEffect, useRef } from 'react';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { StreamLanguage, bracketMatching, indentOnInput, syntaxHighlighting, defaultHighlightStyle, foldGutter } from '@codemirror/language';
import { closeBrackets, autocompletion, type CompletionContext } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { steezeEditor } from './editorTheme';

const KEYWORDS = new Set(['module', 'function', 'include', 'use', 'if', 'else', 'for', 'let', 'each', 'intersection_for', 'assert', 'echo', 'true', 'false', 'undef', 'function']);
const BUILTINS = [
  'cube', 'sphere', 'cylinder', 'polyhedron', 'square', 'circle', 'polygon', 'text', 'import', 'surface', 'projection',
  'translate', 'rotate', 'scale', 'resize', 'mirror', 'multmatrix', 'color', 'offset', 'hull', 'minkowski',
  'union', 'difference', 'intersection', 'linear_extrude', 'rotate_extrude', 'render', 'children',
  'abs', 'sign', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'floor', 'round', 'ceil', 'ln', 'log', 'pow', 'sqrt', 'exp',
  'len', 'min', 'max', 'norm', 'cross', 'concat', 'lookup', 'str', 'chr', 'ord', 'search', 'rands', 'version', 'is_undef',
  'is_bool', 'is_num', 'is_string', 'is_list', 'is_function',
  // common BOSL2
  'cuboid', 'cyl', 'prismoid', 'tube', 'rect_tube', 'diff', 'tag', 'attach', 'position', 'up', 'down', 'left', 'right', 'fwd', 'back',
  'xrot', 'yrot', 'zrot', 'xcopies', 'ycopies', 'zcopies', 'grid_copies', 'rot_copies', 'threaded_rod', 'threaded_nut', 'screw', 'screw_hole', 'nut',
];
const BUILTIN_SET = new Set(BUILTINS);

const openscad = StreamLanguage.define<{ inComment: boolean }>({
  name: 'openscad',
  startState: () => ({ inComment: false }),
  token(stream, state) {
    if (state.inComment) {
      if (stream.match(/.*?\*\//)) state.inComment = false;
      else stream.skipToEnd();
      return 'comment';
    }
    if (stream.eatSpace()) return null;
    if (stream.match('//')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.match('/*')) {
      state.inComment = true;
      return 'comment';
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return 'string';
    if (stream.match(/^<[^>\s]+\.scad>/)) return 'string';
    if (stream.match(/^-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/i)) return 'number';
    if (stream.match(/^\$[a-zA-Z_]+/)) return 'atom';
    const word = stream.match(/^[A-Za-z_][\w]*/) as RegExpMatchArray | null;
    if (word) {
      const w = word[0];
      if (KEYWORDS.has(w)) return 'keyword';
      if (BUILTIN_SET.has(w)) return 'builtin';
      return 'variableName';
    }
    if (stream.match(/^[+\-*/%<>=!&|?:^#]+/)) return 'operator';
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: '//', block: { open: '/*', close: '*/' } }, closeBrackets: { brackets: ['(', '[', '{', '"'] } },
});

function complete(ctx: CompletionContext) {
  const word = ctx.matchBefore(/[\w$]+/);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;
  const doc = ctx.state.doc.toString();
  const idents = new Set<string>();
  for (const m of doc.matchAll(/\b(?:module|function)\s+([A-Za-z_]\w*)|^\s*([A-Za-z_$]\w*)\s*=/gm)) idents.add(m[1] ?? m[2]);
  return {
    from: word.from,
    options: [
      ...BUILTINS.map((label) => ({ label, type: 'function' })),
      ...[...KEYWORDS].map((label) => ({ label, type: 'keyword' })),
      ...[...idents].filter(Boolean).map((label) => ({ label, type: 'variable' })),
    ],
  };
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  readOnly?: boolean;
  /** Bump to replace the document with `value` (e.g. file changed on disk). */
  docVersion: string | number;
}

export function CodeEditor({ value, onChange, onSave, readOnly, docVersion }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const cbs = useRef({ onChange, onSave });
  cbs.current = { onChange, onSave };

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          foldGutter(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion({ override: [complete] }),
          highlightActiveLine(),
          highlightSelectionMatches(),
          openscad,
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          ...steezeEditor,
          EditorState.readOnly.of(!!readOnly),
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => (cbs.current.onSave(), true) },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !u.transactions.some((t) => t.annotation(external))) cbs.current.onChange(u.state.doc.toString());
          }),
          EditorView.theme({ '&': { height: '100%', fontSize: '13px' } }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const cur = v.state.doc.toString();
    if (cur !== value) {
      v.dispatch({ changes: { from: 0, to: cur.length, insert: value }, annotations: external.of(true) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docVersion]);

  return <div className="code-editor" ref={host} />;
}

import { Annotation } from '@codemirror/state';
const external = Annotation.define<boolean>();
