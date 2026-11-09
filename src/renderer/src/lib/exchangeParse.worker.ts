import { exchangeSide } from '@shared/exchangeBody';
import type { ExchangeInput } from './exchangeParse';

self.onmessage = ({ data }: MessageEvent<{ id: number; detail: ExchangeInput }>) => {
  self.postMessage({
    id: data.id,
    sides: { request: exchangeSide(data.detail, 'request'), response: exchangeSide(data.detail, 'response') },
  });
};
