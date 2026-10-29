// A one-time inline note. It never steals focus or opens an external page itself.
export function attachSupportReminder({ node, invoke, canShow, delayMs = 60000, intervalMs = 1000, now = Date.now }) {
  const star = node.querySelector('#btn-reminder-github');
  const donate = node.querySelector('#btn-reminder-donate');
  const close = node.querySelector('#btn-reminder-dismiss');
  const error = node.querySelector('#support-reminder-error');
  let quietSince = null, presented = false, complete = false, checking = false, busy = false;
  let timer = null;
  function stop() { if (timer !== null) clearInterval(timer); timer = null; }
  function hide() { complete = true; node.hidden = true; stop(); }
  function buttons() { star.disabled = donate.disabled = close.disabled = busy; }
  async function dismiss() {
    if (busy) return;
    busy = true; buttons();
    try { await invoke('support:dismiss'); } catch { /* Presentation is already persisted. */ }
    hide();
  }
  async function open(kind) {
    if (busy || complete) return;
    busy = true; buttons(); error.hidden = true;
    try {
      await invoke('app:open-link', kind);
      try { await invoke('support:dismiss'); } catch { /* Presentation is already persisted. */ }
      hide();
    } catch {
      error.textContent = 'Couldn’t open the link. Try again, or use About & support.';
      error.hidden = false;
    } finally { busy = false; buttons(); }
  }
  const onStar = () => open('github'), onDonate = () => open('donate'), onClose = () => dismiss();
  star.addEventListener('click', onStar); donate.addEventListener('click', onDonate); close.addEventListener('click', onClose);
  async function check() {
    if (complete || checking) return;
    if (!canShow()) { node.hidden = true; quietSince = null; return; }
    if (presented) { node.hidden = false; return; }
    if (quietSince === null) quietSince = now();
    if (now() - quietSince < delayMs) return;
    checking = true;
    try {
      const status = await invoke('support:status');
      if (!status?.eligible) {
        // A counted first/second session needs no further reads in this process.
        if (status?.counted || status?.presented || status?.dismissed || status?.disabled) hide();
        return;
      }
      star.hidden = status.canStar !== true; donate.hidden = status.canDonate !== true;
      if ((star.hidden && donate.hidden) || !canShow()) return;
      const claim = await invoke('support:shown');
      if (!claim?.show) { hide(); return; }
      presented = true;
      node.hidden = !canShow();
    } catch { hide(); } // An optional reminder must never create an app error.
    finally { checking = false; }
  }
  if (intervalMs > 0) timer = setInterval(check, intervalMs);
  return { check, dispose() {
    hide(); star.removeEventListener('click', onStar); donate.removeEventListener('click', onDonate); close.removeEventListener('click', onClose);
  } };
}
