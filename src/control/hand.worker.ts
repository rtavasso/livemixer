import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
// A classic worker is intentional: the matching MediaPipe WASM loader uses importScripts.
let hand: HandLandmarker | undefined;
const scope = self as unknown as { onmessage: (event: MessageEvent) => void; postMessage: (data: unknown) => void };
scope.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    try {
      const files = await FilesetResolver.forVisionTasks(data.wasmRoot);
      hand = await HandLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: data.modelUrl, delegate: 'CPU' }, runningMode: 'VIDEO', numHands: 1, minHandDetectionConfidence: .5, minHandPresenceConfidence: .5, minTrackingConfidence: .5 });
      scope.postMessage({ type: 'ready' });
    } catch (error) { scope.postMessage({ type: 'error', message: String(error) }); }
  }
  if (data.type === 'frame') {
    const bitmap = data.bitmap as ImageBitmap;
    try {
      if (!hand) throw new Error('Hand model is not ready.');
      const result = hand.detectForVideo(bitmap, data.observedAtMs);
      scope.postMessage({ type: 'result', sequence: data.sequence, observedAtMs: data.observedAtMs, width: bitmap.width, height: bitmap.height, landmarks: result.landmarks[0] ?? [] });
    } catch (error) { scope.postMessage({ type: 'frame-error', sequence: data.sequence, observedAtMs: data.observedAtMs, message: String(error) }); }
    finally { bitmap.close(); }
  }
};
