import { analyzeSong } from './analysis';
const scope = self as unknown as { onmessage: (event: MessageEvent) => void; postMessage: (value: unknown) => void };
scope.onmessage = async ({ data }) => {
  try { const analysis = await analyzeSong(data.stems, stem => scope.postMessage({ type: 'progress', id: data.id, stem })); scope.postMessage({ type: 'done', id: data.id, analysis }); }
  catch (error) { scope.postMessage({ type: 'error', id: data.id, message: String(error) }); }
};
