import { encodeWav } from '@imp/audio';
import type { ImpClient } from '@imp/host';
import { RecordIcon, StopIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { messageOf, runCommand } from './context.js';

/**
 * Collects what the microphone hears, sample by sample, off the main thread.
 * Loaded from a blob, so the build needs no separate file for it.
 */
const WORKLET = `
class Collector extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor('imp-collector', Collector);
`;

/** A take from the microphone, as it was heard: mono, at the device's rate, no processing. */
export class MicRecorder {
  #context: AudioContext | null = null;
  #stream: MediaStream | null = null;
  #chunks: Float32Array[] = [];
  #node: AudioWorkletNode | null = null;

  /** Asks for the microphone and starts. `onLevel` gets the peak of each piece, 0 to 1. */
  async start(onLevel: (peak: number) => void): Promise<void> {
    // Raw sound: the browser's voice-call processing would colour a recording.
    this.#stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const context = new AudioContext();
    this.#context = context;
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    try {
      await context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const node = new AudioWorkletNode(context, 'imp-collector');
    this.#node = node;
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      this.#chunks.push(event.data);
      let peak = 0;
      for (const sample of event.data) peak = Math.max(peak, Math.abs(sample));
      onLevel(peak);
    };
    context.createMediaStreamSource(this.#stream).connect(node);
    await context.resume();
  }

  /** Stops and returns the take as a WAV file, or null when nothing was heard. */
  async stop(): Promise<Uint8Array | null> {
    const sampleRate = this.#context?.sampleRate ?? 48_000;
    this.#node?.port.close();
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    await this.#context?.close();
    const length = this.#chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (length === 0) return null;
    const samples = new Float32Array(length);
    let at = 0;
    for (const chunk of this.#chunks) {
      samples.set(chunk, at);
      at += chunk.length;
    }
    this.#chunks = [];
    return encodeWav({ sampleRate, channels: [samples] }, 'float32');
  }
}

/**
 * The record button of the audio editor. It records from the playhead onto
 * the chosen track, or onto a new one, and the take becomes a region there.
 */
export function RecordControl({
  imp,
  projectId,
  docId,
  trackId,
  startSeconds,
  disabledReason,
  onError,
}: {
  imp: ImpClient;
  projectId: string;
  docId: string;
  trackId: string | undefined;
  startSeconds: number;
  /** Why recording is not possible here, or null. */
  disabledReason: string | null;
  onError: (message: string | null) => void;
}): ReactElement {
  const [state, setState] = useState<'idle' | 'starting' | 'recording' | 'saving'>('idle');
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const recorder = useRef<MicRecorder | null>(null);
  const started = useRef({ at: 0, from: 0, trackId: undefined as string | undefined });

  useEffect(() => {
    if (state !== 'recording') return;
    const timer = window.setInterval(() => {
      setElapsed((performance.now() - started.current.at) / 1000);
    }, 100);
    return () => {
      window.clearInterval(timer);
    };
  }, [state]);

  // Leaving the editor stops the microphone.
  useEffect(
    () => () => {
      void recorder.current?.stop();
    },
    [],
  );

  const start = async (): Promise<void> => {
    onError(null);
    setState('starting');
    const mic = new MicRecorder();
    try {
      await mic.start((peak) => {
        setLevel((before) => Math.max(peak, before * 0.85));
      });
    } catch (reason) {
      setState('idle');
      onError(
        reason instanceof DOMException && reason.name === 'NotAllowedError'
          ? 'The microphone is blocked. Allow it for this site in the browser, then try again.'
          : `The microphone could not start: ${messageOf(reason)}`,
      );
      return;
    }
    recorder.current = mic;
    started.current = { at: performance.now(), from: startSeconds, trackId };
    setElapsed(0);
    setState('recording');
  };

  const stop = async (): Promise<void> => {
    const mic = recorder.current;
    recorder.current = null;
    if (mic === null) return;
    setState('saving');
    try {
      const bytes = await mic.stop();
      if (bytes === null) {
        onError('Nothing was heard from the microphone.');
        return;
      }
      const uploadKey = await imp.upload(bytes, 'audio/wav');
      await runCommand(imp, 'audio.recording.keep', {
        projectId,
        docId,
        uploadKey,
        startSeconds: started.current.from,
        ...(started.current.trackId === undefined ? {} : { trackId: started.current.trackId }),
      });
    } catch (reason) {
      onError(messageOf(reason));
    } finally {
      setLevel(0);
      setState('idle');
    }
  };

  if (state === 'recording' || state === 'saving') {
    return (
      <div className="recording" role="status" aria-live="polite">
        <span className="rec-dot" aria-hidden="true" />
        <span className="mono">{elapsed.toFixed(1)} s</span>
        <span className="rec-meter" aria-label="Input level">
          <span style={{ width: `${String(Math.min(100, Math.round(level * 100)))}%` }} />
        </span>
        <button
          type="button"
          className="button small"
          disabled={state === 'saving'}
          onClick={() => {
            void stop();
          }}
        >
          <StopIcon aria-hidden="true" weight="fill" /> {state === 'saving' ? 'Saving…' : 'Stop'}
        </button>
      </div>
    );
  }
  return (
    <button
      type="button"
      className="tool record"
      aria-label="Record"
      aria-keyshortcuts="R"
      title={disabledReason ?? 'Record from the playhead (R)'}
      disabled={disabledReason !== null || state === 'starting'}
      onClick={() => {
        void start();
      }}
    >
      <RecordIcon aria-hidden="true" size={18} weight="fill" />
    </button>
  );
}
