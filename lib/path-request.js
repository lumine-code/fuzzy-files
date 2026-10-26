const { CompositeDisposable } = require("lumine");

// Each completion owns its document lifetime, including the lazy import and
// index preparation. Restoring the same grammar cannot revive an old request.
module.exports = async function pathRequest(provider, request, work) {
  const { editor, signal } = request;
  let valid = true;
  const current = () =>
    valid &&
    provider.enabled &&
    !signal?.aborted &&
    !editor.isDestroyed() &&
    editor.getGrammar?.() !== lumine.grammars.nullGrammar;
  if (!current()) return [];
  let abandon;
  const cancelled = new Promise((resolve) => (abandon = resolve));
  const subscriptions = new CompositeDisposable();
  const retire = () => {
    valid = false;
    abandon([]);
  };
  for (const event of ["onDidChangeGrammar", "onDidChangePath", "onDidDestroy"])
    subscriptions.add(editor[event](retire));
  subscriptions.add(editor.getBuffer().onDidChange(retire));
  signal?.addEventListener("abort", retire, { once: true });
  try {
    const result = await Promise.race([work(current), cancelled]);
    return current() ? result : [];
  } catch (error) {
    if (current()) throw error;
    return [];
  } finally {
    subscriptions.dispose();
    signal?.removeEventListener("abort", retire);
  }
};
