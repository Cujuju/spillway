import { createResource, type Accessor } from 'solid-js';
import type { ActivityScope } from '@shared/activityScope';
import type { WasteReport } from '@shared/activityWaste';
import { snapshot } from '../store';
import type { Span } from './activityRange';
import { createReportQuery } from './reportRefresh';

/** Activity → Waste report. Undefined until answered; null on failure. */
export function createWasteReport(active: Accessor<boolean>, scope: Accessor<ActivityScope>, span: Accessor<Span>, all: Accessor<boolean>, rangeKey: Accessor<string>): Accessor<WasteReport | null | undefined> {
  const query = createReportQuery(
    active,
    () => ({ scope: scope(), rangeKey: rangeKey(), all: all(), credentials: snapshot()?.credentials.length ?? 0 }),
    ({ scope, all }) => ({ scope, from: all ? null : span().from, to: span().to }),
  );
  const [report] = createResource(
    query,
    ({ scope, from, to }) => window.api.activityWaste({ scope, from, to }).catch((err: unknown) => {
      console.error('[activity] waste report failed:', err);
      return null;
    }),
  );
  return () => report.latest;
}
