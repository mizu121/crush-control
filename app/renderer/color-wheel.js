const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// The wheel uses HSV value 1; keyboard brightness remains its own hardware control.
export function createColorWheel(element, onChange) {
  const thumb = element.querySelector('.wheel-thumb');
  let hue = 0, saturation = 255, disabled = true, dragging = false;

  function choose(event) {
    if (disabled) return;
    const bounds = element.getBoundingClientRect();
    const x = event.clientX - bounds.left - bounds.width / 2;
    const y = event.clientY - bounds.top - bounds.height / 2;
    const distance = Math.hypot(x, y);
    const nextHue = distance < 1 ? hue : (Math.atan2(x, -y) * 180 / Math.PI + 360) % 360;
    onChange({ hueDeg: Math.round(nextHue) % 360, sat: Math.round(clamp(distance / (bounds.width / 2), 0, 1) * 255) });
  }
  function down(event) {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    element.focus({ preventScroll: true });
    dragging = true;
    element.setPointerCapture(event.pointerId);
    choose(event);
  }
  function move(event) { if (dragging) choose(event); }
  function up(event) {
    dragging = false;
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
  }
  function key(event) {
    if (disabled) return;
    const step = event.shiftKey ? 15 : 3;
    let nextHue = hue, nextSat = saturation;
    if (event.key === 'ArrowRight') nextHue = (hue + step) % 360;
    else if (event.key === 'ArrowLeft') nextHue = (hue - step + 360) % 360;
    else if (event.key === 'ArrowUp') nextSat = clamp(saturation + step, 0, 255);
    else if (event.key === 'ArrowDown') nextSat = clamp(saturation - step, 0, 255);
    else if (event.key === 'Home') nextSat = 0;
    else if (event.key === 'End') nextSat = 255;
    else return;
    event.preventDefault();
    onChange({ hueDeg: nextHue, sat: nextSat });
  }
  element.addEventListener('pointerdown', down);
  element.addEventListener('pointermove', move);
  element.addEventListener('pointerup', up);
  element.addEventListener('pointercancel', up);
  element.addEventListener('lostpointercapture', () => { dragging = false; });
  element.addEventListener('keydown', key);

  return {
    update(lighting, locked) {
      hue = lighting.hueDeg;
      saturation = lighting.sat;
      disabled = locked;
      element.classList.toggle('disabled', disabled);
      element.setAttribute('aria-disabled', String(disabled));
      element.tabIndex = disabled ? -1 : 0;
      element.setAttribute('aria-label', `Color picker. Hue ${Math.round(hue)} degrees, saturation ${Math.round(saturation / 255 * 100)} percent.`);
      const radians = hue * Math.PI / 180, radius = saturation / 255 * 50;
      thumb.style.left = `${50 + Math.sin(radians) * radius}%`;
      thumb.style.top = `${50 - Math.cos(radians) * radius}%`;
      thumb.style.backgroundColor = `hsl(${hue} 100% ${100 - saturation / 255 * 50}%)`;
    },
  };
}
