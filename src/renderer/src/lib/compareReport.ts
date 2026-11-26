import { createResource, type Accessor } from 'solid-js';
import type { ActivityScope } from '@shared/activityScope';
import type { CompareReport } from '@shared/activityCompare';
import { snapshot } from '../store';
import type { Span } from './activityRange';
import { createReportQuery } from './reportRefresh';

/** Overview combination report. Undefined until answered; null on failure. */
export function createCompareReport(active: Accessor<boolean>, scope: Accessor<ActivityScope>, span: Accessor<Span>, rangeKey: Accessor<string>): Accessor<CompareReport | null | undefined> {
  const query = createReportQuery(
    active,
    () => ({ scope: scope(), rangeKey: rangeKey(), credentials: snapshot()?.credentials.length ?? 0 }),
    ({ scope }) => ({ scope, from: span().from, to: span().to }),
  );
  const [report] = createResource(
    query,
    ({ scope, from, to }) => window.api.activityCompare({ scope, from, to }).catch((err: unknown) => {
      console.error('[activity] compare report failed:', err);
      return null;
    }),
  );
  return () => report.latest;
}
