import { render } from 'solid-js/web';
import '../styles/tokens.css';
import './notice.css';
import { NoticeApp } from './NoticeApp';

document.documentElement.dataset.platform = window.api.platform;

render(() => <NoticeApp />, document.getElementById('root')!);
