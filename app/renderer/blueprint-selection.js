// Pointer and keyboard selection only. This module never sends color changes.
export function attachBlueprintSelection({ surface, board, marquee, canSelect, getSelection, getKeys, setSelection }) {
  let drag = null;
  const clearBox = () => { marquee.hidden = true; surface.classList.remove('selecting'); };
  const keyFromNode = node => {
    const button = node?.closest?.('.key');
    return button && board.contains(button) ? getKeys().find(key => key.layoutIndex === Number(button.dataset.i)) : null;
  };
  function endCapture() {
    const previous = drag;
    drag = null;
    clearBox();
    if (previous && surface.hasPointerCapture?.(previous.id)) surface.releasePointerCapture(previous.id);
    return previous;
  }
  function down(event) {
    if (event.button !== 0 || !canSelect()) return;
    const key = keyFromNode(event.target);
    const button = event.target.closest?.('.key');
    (button || surface).focus({ preventScroll: true });
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, key,
      additive: event.shiftKey || event.ctrlKey || event.metaKey,
      baseline: new Set(getSelection()), moved: false };
    try { surface.setPointerCapture(event.pointerId); } catch { /* Synthetic test pointers have no capture target. */ }
    event.preventDefault();
  }
  function move(event) {
    if (!drag || drag.id !== event.pointerId) return;
    if (!canSelect()) { endCapture(); return; }
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
    drag.moved = true;
    const bounds = surface.getBoundingClientRect();
    const clampX = value => Math.max(bounds.left, Math.min(bounds.right, value));
    const clampY = value => Math.max(bounds.top, Math.min(bounds.bottom, value));
    const left = Math.min(clampX(drag.x), clampX(event.clientX));
    const top = Math.min(clampY(drag.y), clampY(event.clientY));
    const right = Math.max(clampX(drag.x), clampX(event.clientX));
    const bottom = Math.max(clampY(drag.y), clampY(event.clientY));
    Object.assign(marquee.style, { left: `${left - bounds.left}px`, top: `${top - bounds.top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
    marquee.hidden = false;
    surface.classList.add('selecting');
    const selected = drag.additive ? new Set(drag.baseline) : new Set();
    const keys = new Map(getKeys().map(key => [key.layoutIndex, key.slot]));
    board.querySelectorAll('.key').forEach(button => {
      const slot = keys.get(Number(button.dataset.i));
      if (slot === undefined || button.disabled) return;
      const rect = button.getBoundingClientRect();
      if (rect.left < right && rect.right > left && rect.top < bottom && rect.bottom > top) selected.add(slot);
    });
    setSelection(selected);
    event.preventDefault();
  }
  function up(event) {
    if (!drag || drag.id !== event.pointerId) return;
    // Use the final release coordinate even if the last move was coalesced.
    move(event);
    const previous = endCapture();
    if (!previous || previous.moved || !canSelect()) return;
    const selected = previous.additive ? new Set(previous.baseline) : new Set();
    if (previous.key) {
      if (selected.has(previous.key.slot)) selected.delete(previous.key.slot);
      else selected.add(previous.key.slot);
    }
    setSelection(selected);
  }
  function cancel() {
    const previous = endCapture();
    if (previous?.moved && canSelect()) setSelection(previous.baseline);
  }
  function keydown(event) {
    if (!canSelect()) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      setSelection(new Set(getKeys().map(key => key.slot)));
    } else if (event.key === 'Escape') {
      event.preventDefault();
      endCapture();
      setSelection(new Set());
    }
  }
  surface.addEventListener('pointerdown', down);
  surface.addEventListener('keydown', keydown);
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', cancel, true);
  window.addEventListener('blur', cancel);
  return () => {
    endCapture();
    surface.removeEventListener('pointerdown', down);
    surface.removeEventListener('keydown', keydown);
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', cancel, true);
    window.removeEventListener('blur', cancel);
  };
}
