import { createEffect, ErrorBoundary, Match, Switch } from 'solid-js';
import { App } from './App';
import { TitleBar } from './components/TitleBar';
import { Notice } from './components/ui';
import { applyTheme, retryStartup, settings, shownText, storeStartup } from './store';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A failure in place of the app. Keeps the title bar: the window is frameless off macOS. */
function Failure(props: { title: string; message: string; action: string; onAction: () => void }) {
  // A failed startup never mounts App, which paints the theme.
  createEffect(() => applyTheme(settings().general.theme));
  return (
    <div class="shell">
      <TitleBar />
      <div class="boot-state">
        <Notice tone="error" class="boot-notice">
          <span class="spacer" role="alert">{props.title}{props.message ? `: ${shownText(props.message)}` : ''}</span>
          <button type="button" class="btn" onClick={() => props.onAction()}>{props.action}</button>
        </Notice>
      </div>
    </div>
  );
}

/** Mounts at once. Shows nothing while startup reads run, so the first frame keeps the window's theme colour. */
export function Root() {
  const startupError = () => {
    const startup = storeStartup();
    return startup.status === 'error' ? startup : undefined;
  };
  return (
    <ErrorBoundary
      fallback={(error) => {
        // Caught errors still reach the console and pnpm smoke as uncaught.
        reportError(error);
        return <Failure title="Spillway stopped rendering" message={errorText(error)} action="Reload" onAction={() => location.reload()} />;
      }}
    >
      <Switch>
        <Match when={storeStartup().status === 'ready'}><App /></Match>
        <Match when={startupError()}>
          {(error) => <Failure title="Spillway couldn't start" message={error().message} action="Retry" onAction={() => void retryStartup()} />}
        </Match>
      </Switch>
    </ErrorBoundary>
  );
}
