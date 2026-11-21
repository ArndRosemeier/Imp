export { connectImp, type ImpClient } from './client.js';
export { createHttpPort, type EventStream, type HttpPortOptions } from './http-port.js';
export {
  createImp,
  type ColorSampler,
  type FrameGrabber,
  type Imp,
  type ImpOptions,
} from './imp.js';
export { createLocalPorts, type Port } from './port.js';
export {
  fromWireError,
  toWireError,
  type Calls,
  type CommandInfo,
  type ModeInfo,
  type Reply,
  type Request,
  type StoredFile,
  type WireError,
} from './protocol.js';
export { createMemorySecretStore, type SecretStore } from './secrets.js';
export { serveImp } from './serve.js';
export { decodeWire, encodeWire } from './wire.js';

/** How the colours of a frame lie, for a host's colour sampler. */
export { colorStats } from '@imp/mode-movie';
