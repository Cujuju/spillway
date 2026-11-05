import { DIAGNOSTIC_LIMITS, type DiagnosticCounts, type DiagnosticSelection, type DiagnosticSource } from '@shared/diagnosticBundle';
import { buildDiagnosticBundle, type DiagnosticContext } from './diagnosticCollect';
import { DiagnosticSanitizer } from './diagnosticSanitize';

export interface DiagnosticPreparedContent { json: string; bytes: number; counts: DiagnosticCounts }
export interface DiagnosticFormatter {
  add(source: DiagnosticSource): Promise<void>;
  finish(): Promise<DiagnosticPreparedContent>;
  close(): Promise<void>;
}
/** Pure formatting only; production runs this in a disposable worker without database or filesystem access. */
export class DiagnosticPreparation {
  private sanitizer: DiagnosticSanitizer;
  private bundle: ReturnType<typeof buildDiagnosticBundle>;
  constructor(private selection: DiagnosticSelection, private context: DiagnosticContext, private now: number) {
    this.sanitizer = new DiagnosticSanitizer(context.knownSecrets);
    this.bundle = buildDiagnosticBundle(selection, [], context, now, this.sanitizer);
  }
  add(source: DiagnosticSource): void {
    const trace = this.selection.traceIds[this.bundle.records.length];
    if (!trace) throw new Error('Unexpected diagnostic record');
    const part = buildDiagnosticBundle({ ...this.selection, traceIds: [trace], excludedRecords: 0 }, [source], this.context, this.now, this.sanitizer);
    this.bundle.records.push(part.records[0]!);
    for (const key of ['included', 'unavailable', 'partial', 'redacted', 'bodiesIncluded', 'bodiesUnavailable', 'bodiesOmitted'] as const) this.bundle.counts[key] += part.counts[key];
  }
  finish(): DiagnosticPreparedContent {
    const bundle = this.bundle;
    if (bundle.records.length !== this.selection.traceIds.length) throw new Error('Diagnostic collection incomplete');
    let json = `${JSON.stringify(bundle, null, 2)}\n`;
    for (let index = bundle.records.length - 1; Buffer.byteLength(json) > DIAGNOSTIC_LIMITS.preparedBytes && index >= 0; index--) {
      const record = bundle.records[index]!;
      if ('bodies' in record && record.bodies?.disposition === 'included') {
        record.bodies = { disposition: 'omitted', reason: 'total-export-byte-limit', partial: true };
        bundle.counts.bodiesIncluded--; bundle.counts.bodiesOmitted++;
        if (!record.partial) { record.partial = true; bundle.counts.partial++; }
        json = `${JSON.stringify(bundle, null, 2)}\n`;
      }
    }
    if (Buffer.byteLength(json) > DIAGNOSTIC_LIMITS.preparedBytes) throw new Error('Selected metadata exceeds 8 MiB; select fewer records');
    return { json, bytes: Buffer.byteLength(json), counts: { ...bundle.counts } };
  }
}
