import '@fontsource-variable/inter';
import '@fontsource/courier-prime/400.css';
import '@fontsource/instrument-serif/400.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.js';
import { connectImp } from './host/client.js';
import type { Port } from './host/port.js';
import { createLocalSecretStore } from './host/secrets.js';
import './styles/tokens.css';
import './styles/app.css';

const root = document.getElementById('root');
if (root === null) {
  throw new Error('The page has no #root element.');
}
document.documentElement.dataset['theme'] = localStorage.getItem('imp.theme') ?? 'dark';

// Ask the browser not to evict the data under storage pressure.
void navigator.storage.persist();
// The core runs in a worker, so long agent runs and large files never stall the interface.
const worker = new Worker(new URL('./host/worker.ts', import.meta.url), { type: 'module' });
const lost = new Promise<never>((_, reject) => {
  worker.addEventListener('error', (event) => {
    reject(new Error(`its core did not load${event.message === '' ? '' : ` (${event.message})`}`));
  });
});
const imp = connectImp(worker as unknown as Port, createLocalSecretStore(), lost);

createRoot(root).render(
  <StrictMode>
    <App imp={imp} />
  </StrictMode>,
);
