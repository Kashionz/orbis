import { useEffect, useRef } from "react";
import type { ReviewComment } from "../../api/schemas";
import { languageOf, monaco } from "./monaco";

type Side = ReviewComment["side"];

interface DiffEditorProps {
  path: string;
  original: string;
  modified: string;
  /** 這個檔案的留言，用來在對應的行加上標示。 */
  comments: readonly ReviewComment[];
  /** 點擊行號時呼叫：要在這一行加入留言。 */
  onLineClick: (line: number, side: Side) => void;
}

const LINE_TARGETS = new Set([
  monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS,
  monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN,
  monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS,
]);

function decorationsFor(comments: readonly ReviewComment[], side: Side) {
  return comments
    .filter((comment) => comment.side === side)
    .map((comment) => ({
      range: new monaco.Range(comment.line, 1, comment.line, 1),
      options: {
        isWholeLine: true,
        className: "review-comment-line",
        linesDecorationsClassName: "review-comment-gutter",
        hoverMessage: { value: comment.body },
      },
    }));
}

/** Monaco 的並排 diff。點左側（修改前）或右側（修改後）的行號可以加入留言。 */
export function DiffEditor({ path, original, modified, comments, onLineClick }: DiffEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const decorationsRef = useRef<{
    original: monaco.editor.IEditorDecorationsCollection;
    modified: monaco.editor.IEditorDecorationsCollection;
  } | null>(null);
  const onLineClickRef = useRef(onLineClick);
  onLineClickRef.current = onLineClick;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const editor = monaco.editor.createDiffEditor(container, {
      readOnly: true,
      originalEditable: false,
      automaticLayout: true,
      renderSideBySide: true,
      // 留言要能分別點兩側的行號，所以窄畫面也維持並排
      useInlineViewWhenSpaceIsLimited: false,
      renderMarginRevertIcon: false,
      renderGutterMenu: false,
      glyphMargin: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
    });
    editorRef.current = editor;
    decorationsRef.current = {
      original: editor.getOriginalEditor().createDecorationsCollection(),
      modified: editor.getModifiedEditor().createDecorationsCollection(),
    };
    const listen = (target: monaco.editor.ICodeEditor, side: Side) =>
      target.onMouseDown((event) => {
        const line = event.target.position?.lineNumber;
        if (line && LINE_TARGETS.has(event.target.type)) onLineClickRef.current(line, side);
      });
    const subscriptions = [
      listen(editor.getOriginalEditor(), "old"),
      listen(editor.getModifiedEditor(), "new"),
    ];
    return () => {
      for (const subscription of subscriptions) subscription.dispose();
      const model = editor.getModel();
      editor.dispose();
      model?.original.dispose();
      model?.modified.dispose();
      editorRef.current = null;
      decorationsRef.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const language = languageOf(path);
    const previous = editor.getModel();
    editor.setModel({
      original: monaco.editor.createModel(original, language),
      modified: monaco.editor.createModel(modified, language),
    });
    previous?.original.dispose();
    previous?.modified.dispose();
  }, [path, original, modified]);

  useEffect(() => {
    decorationsRef.current?.original.set(decorationsFor(comments, "old"));
    decorationsRef.current?.modified.set(decorationsFor(comments, "new"));
  }, [comments]);

  return (
    <div ref={containerRef} className="diff-editor" data-testid="diff-editor" data-path={path} />
  );
}
