import { Copy, Minus, Square, X } from 'lucide-solid';
import { Show } from 'solid-js';
import { maximized } from '../store';

const ICON_PX = 14;

export function TitleBar() {
  return (
    <header class="titlebar">
      <img src="./icon.png" alt="" width="16" height="16" />
      <span class="titlebar-title">CLIPROXY DESKTOP</span>
      <div class="titlebar-controls">
        <button class="titlebar-btn" title="Minimize" onClick={() => window.api.windowMinimize()}>
          <Minus size={ICON_PX} />
        </button>
        <button class="titlebar-btn" title={maximized() ? 'Restore' : 'Maximize'} onClick={() => window.api.windowToggleMaximize()}>
          <Show when={maximized()} fallback={<Square size={ICON_PX - 2} />}>
            <Copy size={ICON_PX - 2} />
          </Show>
        </button>
        <button class="titlebar-btn close" title="Close" onClick={() => window.api.windowClose()}>
          <X size={ICON_PX} />
        </button>
      </div>
    </header>
  );
}
