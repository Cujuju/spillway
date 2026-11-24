import { createResource, type Accessor } from 'solid-js';
import type { ActivityScope } from '@shared/activityScope';
import type { CompareReport } from '@shared/activityCompare';
import { activityBuckets, snapshot } from '../store';
import type { Span } from './activityRange';

/** The Overview's combination report, refetched with the scope, span, totals and credential list changes. Undefined until answered; null on failure. */
export function createCompareReport(active: Accessor<boolean>, scope: Accessor<ActivityScope>, span: Accessor<Span>): Accessor<CompareReport | null | undefined> {
  const [report] = createResource(
    () => active() && { scope: scope(), from: span().from, to: span().to, totals: activityBuckets(), credentials: snapshot()?.credentials.length ?? 0 },
    ({ scope, from, to }) => window.api.activityCompare({ scope, from, to }).catch((err: unknown) => {
      console.error('[activity] compare report failed:', err);
      return null;
    }),
  );
  return () => report.latest;
}
