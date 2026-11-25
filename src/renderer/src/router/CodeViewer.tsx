import { useEffect, useMemo, useRef } from 'react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { parseJson } from '../../../shared/validation';

self.MonacoEnvironment = {
  getWorker() {
    return new Worker(new URL('./monaco.worker.ts', import.meta.url), { type: 'module' });
  },
};

let jsonLanguageReady = false;

function ensureJsonLanguage(): void {
  if (jsonLanguageReady) return;
  jsonLanguageReady = true;
  if (!monaco.languages.getLanguages().some((language) => language.id === 'json')) {
    monaco.languages.register({ id: 'json', extensions: ['.json'], aliases: ['JSON'] });
  }
  monaco.languages.setMonarchTokensProvider('json', {
    tokenizer: {
      root: [
        [/"([^"\\]|\\.)*"(?=\s*:)/, 'string.key.json'],
        [/"([^"\\]|\\.)*"/, 'string.value.json'],
        [/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/, 'number.json'],
        [/\b(?:true|false|null)\b/, 'keyword.json'],
        [/[{}]/, 'delimiter.bracket.json'],
        [/[[\]]/, 'delimiter.array.json'],
        [/:/, 'delimiter.colon.json'],
        [/,/, 'delimiter.comma.json'],
      ],
    },
  });
}

function currentTheme(): 'vs' | 'vs-dark' {
  return document.documentElement.dataset.theme === 'dark' ? 'vs-dark' : 'vs';
}

function displayText(value: string, language: 'json' | 'plaintext'): string {
  if (language !== 'json') return value;
  try {
    return JSON.stringify(parseJson(value), null, 2);
  } catch {
    return value;
  }
}

export function CodeViewer({
  value,
  language = 'plaintext',
  height = 220,
}: {
  value: string;
  language?: 'json' | 'plaintext';
  height?: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const text = useMemo(() => displayText(value, language), [value, language]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    ensureJsonLanguage();
    const editor = monaco.editor.create(container, {
      value: text,
      language,
      theme: currentTheme(),
      readOnly: true,
      minimap: { enabled: false },
      fontSize: 11,
      wordWrap: 'on',
      scrollBeyondLastLine: false,
      automaticLayout: true,
      scrollbar: { alwaysConsumeMouseWheel: false },
      padding: { top: 8, bottom: 8 },
    });
    editorRef.current = editor;
    return () => {
      editorRef.current = null;
      editor.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    if (model.getValue() !== text) model.setValue(text);
    if (model.getLanguageId() !== language) monaco.editor.setModelLanguage(model, language);
  }, [text, language]);

  useEffect(() => {
    const applyTheme = () => monaco.editor.setTheme(currentTheme());
    applyTheme();
    const observer = new MutationObserver(applyTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  return <div ref={containerRef} className="router-code" style={{ height }} />;
}
