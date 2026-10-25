import { render } from 'solid-js/web';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/dashboard.css';
import './styles/pages.css';
import { App } from './App';
import { initStore } from './store';

void initStore().then(() => render(() => <App />, document.getElementById('root')!));
