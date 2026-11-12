import { activityLog } from './activityService';
import { proxy } from './proxySupervisor';
import { proxyIdentity } from './proxyIdentity';
import { ThinkingTestRunner } from './thinkingTestRunner';
import type { TestPlanRequest } from '@shared/thinkingTest';

export const thinkingTestRunner = new ThinkingTestRunner(() => {
  const status = proxy.getStatus(), clientApiKey = proxyIdentity().clientApiKeys[0];
  if (status.state !== 'running' || !status.endpoint || !clientApiKey) throw new Error('Start the local proxy before testing');
  return { endpoint: status.endpoint, clientApiKey };
}, (test) => activityLog.call('thinkingTestSave', test));
let generation = 0, deleting = false;
export async function thinkingTestPlan(req: TestPlanRequest) {
  if (deleting) throw new Error('Activity deletion in progress');
  const revision = generation, prepared = await activityLog.call('thinkingTestPrepare', req);
  if (generation !== revision) throw new Error('Thinking test planning canceled');
  return thinkingTestRunner.prepare(prepared);
}
export async function thinkingTests() { return { ...await activityLog.call('thinkingTests'), ...thinkingTestRunner.current() }; }
export async function clearThinkingTests<T>(operation: () => Promise<T>): Promise<T> { generation++; deleting = true; try { await thinkingTestRunner.clear(); return await operation(); } finally { generation++; deleting = false; } }
