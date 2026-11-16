import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerZoomShortcuts } from '../electron-zoom.mjs';

const packageConfig = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
assert.ok(packageConfig.build.files.includes('electron-zoom.mjs'), 'Electron 构建必须包含缩放快捷键模块');

function createHarness(initialZoomFactor = 1) {
  const listeners = new Map();
  let zoomFactor = initialZoomFactor;
  const webContents = {
    on(eventName, listener) { listeners.set(eventName, listener); },
    getZoomFactor() { return zoomFactor; },
    setZoomFactor(value) { zoomFactor = value; },
  };
  registerZoomShortcuts(webContents);
  return {
    get zoomFactor() { return zoomFactor; },
    press(input) {
      let prevented = false;
      listeners.get('before-input-event')?.({ preventDefault() { prevented = true; } }, { type: 'keyDown', ...input });
      return prevented;
    },
  };
}

{
  const harness = createHarness();
  assert.equal(harness.press({ control: true, key: '+', code: 'Equal' }), true);
  assert.equal(harness.zoomFactor, 1.1, 'Ctrl + + 应放大页面');
  assert.equal(harness.press({ control: true, key: '=', code: 'Equal' }), true);
  assert.equal(harness.zoomFactor, 1.2, 'Ctrl + = 也应识别为放大快捷键');
}

{
  const harness = createHarness();
  assert.equal(harness.press({ control: true, key: '+', code: 'NumpadAdd' }), true);
  assert.equal(harness.zoomFactor, 1.1, 'Ctrl + 小键盘加号应放大页面');
  assert.equal(harness.press({ control: true, key: '-', code: 'Minus' }), true);
  assert.equal(harness.zoomFactor, 1, 'Ctrl + - 应缩小页面');
  assert.equal(harness.press({ control: true, key: '0', code: 'Digit0' }), true);
  assert.equal(harness.zoomFactor, 1, 'Ctrl + 0 应恢复 100%');
}

{
  const harness = createHarness();
  assert.equal(harness.press({ control: false, key: '+', code: 'Equal' }), false, '未按 Ctrl/Command 时不得拦截加号');
  assert.equal(harness.zoomFactor, 1);
}

console.log('electron zoom tests passed');
