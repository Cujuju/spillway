import { render } from 'solid-js/web';
import '@cujuju/electron-notices/styles.css';
import { NoticeOverlay } from '@cujuju/electron-notices/renderer';
import { NOTICE_ICONS } from './icons';
import { setHourCycle } from '@shared/timeFormat';

// Before the first render: every date and time format reads it through appLocale().
setHourCycle(window.api.hourCycle);

render(() => <NoticeOverlay bridge={window.notices} icons={NOTICE_ICONS} label="spillway" />, document.getElementById('root')!);
