import { createResource, type Accessor } from 'solid-js';
import type { ActivityScope } from '@shared/activityScope';
import type { WasteReport } from '@shared/activityWaste';
import { activityBuckets, snapshot } from '../store';
import type { Span } from './activityRange';

/** Activity → Waste report, refetched with scope, span, totals, and credentials. Undefined while loading; null on failure. */
export function createWasteReport(active: Accessor<boolean>, scope: Accessor<ActivityScope>, span: Accessor<Span>, all: Accessor<boolean>): Accessor<WasteReport | null | undefined> {
  const [report] = createResource(
    () => active() && { scope: scope(), from: all() ? null : span().from, to: span().to, totals: activityBuckets(), credentials: snapshot()?.credentials.length ?? 0 },
    ({ scope, from, to }) => window.api.activityWaste({ scope, from, to }).catch((err: unknown) => {
      console.error('[activity] waste report failed:', err);
      return null;
    }),
  );
  return () => report.latest;
}
