export {
  createDefaultAudioCodec,
  sniffAudioFormat,
  UnsupportedAudioError,
  type AudioCodec,
  type AudioFormat,
} from './codec.js';
export { Mp4Error, readMp4Audio, type Mp4AudioTrack } from './mp4.js';
export {
  createWebCodecsMp4Decoder,
  placeMp4Sound,
  webCodecs,
  type Mp4AudioDecoder,
  type WebCodecsLike,
} from './webcodecs.js';
export {
  applyEffects,
  describeEffect,
  Effect,
  EffectError,
  EqBand,
  VOICE_PRESETS,
  voicePreset,
  type EffectKind,
  type VoicePreset,
} from './effects.js';
export { designBiquad, responseDb, type FilterSpec, type FilterType } from './dsp/biquad.js';
export { measureLoudness, type LoudnessReport } from './dsp/loudness.js';
export { audioSourcesFor, createAudioCommands, type AudioCommandOptions } from './commands.js';
export { audioRenderKey, type AudioLink, type LengthOf } from './doc-commands.js';
export {
  AudioDoc,
  copyRange,
  deleteRange,
  docDuration,
  insertSilence,
  Marker,
  pasteAt,
  regionDuration,
  regionEnd,
  renderDoc,
  silenceRange,
  splitRegion,
  Track,
  withDuration,
} from './doc.js';
export {
  forEngine,
  frameCount,
  levels,
  resample,
  toDecibels,
  toStereo,
  type Pcm,
  type StereoPcm,
} from './pcm.js';
export {
  computePeaks,
  decodePeaks,
  encodePeaks,
  PEAK_LEVELS,
  waveform,
  type PeakLevel,
  type Peaks,
  type Waveform,
} from './peaks.js';
export { FadeCurve, SoundPlacement } from './placement.js';
export {
  dbToGain,
  fadeGain,
  panGains,
  placementSpan,
  renderBlock,
  type MixInput,
  type PlacementSpan,
  type SourceLookup,
} from './render.js';
export { AudioSources, MissingSourceError, type SourceInfo } from './sources.js';
export { SAMPLE_RATE, snapSeconds, toFrames, toSeconds } from './time.js';
export { decodeWav, encodeWav, isWav } from './wav.js';
export { recordingPrefix } from './record-commands.js';
export { placeWords, SourceWord, Transcript, wordSpan, type PlacedWord } from './transcript.js';
export { TRANSCRIPTION_MODEL_SETTING, type Transcriber } from './transcript-commands.js';
