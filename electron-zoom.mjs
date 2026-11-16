const MIN_ZOOM_FACTOR = 0.5;
const MAX_ZOOM_FACTOR = 2;
const ZOOM_STEP = 0.1;

const clampZoomFactor = (value) => Math.min(MAX_ZOOM_FACTOR, Math.max(MIN_ZOOM_FACTOR, value));

function nextZoomFactor(currentZoomFactor, direction) {
  const current = Number.isFinite(Number(currentZoomFactor)) ? Number(currentZoomFactor) : 1;
  return Math.round(clampZoomFactor(current + direction * ZOOM_STEP) * 100) / 100;
}

export function handleZoomShortcut(webContents, event, input = {}) {
  if (input.type !== 'keyDown' || (!input.control && !input.meta) || input.alt) return false;

  const key = String(input.key ?? '');
  const code = String(input.code ?? '');
  const zoomIn = key === '+' || key === '=' || code === 'NumpadAdd';
  const zoomOut = key === '-' || code === 'NumpadSubtract';
  const resetZoom = key === '0' || code === 'Numpad0';
  if (!zoomIn && !zoomOut && !resetZoom) return false;

  event.preventDefault();
  if (resetZoom) webContents.setZoomFactor(1);
  else webContents.setZoomFactor(nextZoomFactor(webContents.getZoomFactor(), zoomIn ? 1 : -1));
  return true;
}

export function registerZoomShortcuts(webContents) {
  webContents.on('before-input-event', (event, input) => {
    handleZoomShortcut(webContents, event, input);
  });
}
