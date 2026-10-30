import { render } from 'solid-js/web';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/dashboard.css';
import '@cujuju/solidjs-kv-tooltip/styles.css';
import '@cujuju/solidjs-tiling-window-manager/styles.css';
import './styles/activity.css';
import './styles/pool.css';
import './styles/account.css';
import './styles/board.css';
import './styles/pages.css';
import './styles/help.css';
import { App } from './App';
import { initStore } from './store';

// Platform-specific CSS (macOS title bar) keys off this.
document.documentElement.dataset.platform = window.api.platform;

void initStore().then(() => render(() => <App />, document.getElementById('root')!));
