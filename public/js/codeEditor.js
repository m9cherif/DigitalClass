/**
 * Upgrades a plain <textarea> into a real code editor (CodeMirror 5, loaded
 * via <script> tags in index.html — a global, not a module import, so this
 * just waits for it). fromTextArea keeps the original textarea in sync on
 * every keystroke, so every existing `.value` read elsewhere in the app
 * (save handlers, onSet callbacks) keeps working completely unchanged —
 * mounting one of these is a pure visual upgrade, never a data-flow change.
 * If the CDN script never loads (offline, blocked), the plain textarea it
 * would have replaced is simply left alone and still works.
 */
function waitForCodeMirror(timeoutMs = 8000) {
  return new Promise(resolve => {
    const start = Date.now();
    (function poll() {
      if (window.CodeMirror) return resolve(window.CodeMirror);
      if (Date.now() - start > timeoutMs) return resolve(null);
      setTimeout(poll, 50);
    })();
  });
}

const MODES = { javascript: 'javascript', sql: 'text/x-sql', json: { name: 'javascript', json: true }, plain: null };

/**
 * @param {HTMLTextAreaElement} textarea
 * @param {{language?: keyof typeof MODES, readOnly?: boolean, onChange?: (value: string) => void}} opts
 * @returns the CodeMirror instance, or null if the library never loaded.
 */
export async function mountCodeEditor(textarea, { language = 'javascript', readOnly = false, onChange } = {}) {
  const CodeMirror = await waitForCodeMirror();
  if (!CodeMirror || !textarea.isConnected) return null;

  const cm = CodeMirror.fromTextArea(textarea, {
    mode: MODES[language] ?? 'javascript',
    theme: 'material-darker',
    lineNumbers: true,
    matchBrackets: true,
    autoCloseBrackets: true,
    styleActiveLine: !readOnly,
    indentUnit: 2, tabSize: 2, indentWithTabs: false,
    readOnly: readOnly ? 'nocursor' : false,
    cursorBlinkRate: readOnly ? -1 : 530,
    viewportMargin: Infinity, // grow to fit its content, like the textarea it replaces
    lineWrapping: language !== 'json'
  });
  if (readOnly) cm.getWrapperElement().classList.add('cm-readonly');

  // Always kept in sync, whether or not the caller wants a live callback —
  // authoring code reads the (hidden) textarea's .value straight from a
  // save-button handler with no onChange involved at all, and that only
  // ever sees fresh content because this runs unconditionally.
  cm.on('change', () => {
    cm.save();
    onChange?.(cm.getValue());
  });
  return cm;
}
