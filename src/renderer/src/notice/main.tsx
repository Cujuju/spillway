import { render } from 'solid-js/web';
import '@cujuju/electron-notices/styles.css';
import { NoticeOverlay } from '@cujuju/electron-notices/renderer';
import { NOTICE_ICONS } from './icons';

render(() => <NoticeOverlay bridge={window.notices} icons={NOTICE_ICONS} label="spillway" />, document.getElementById('root')!);
