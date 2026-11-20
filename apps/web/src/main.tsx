import '@fontsource-variable/inter';
import '@fontsource/courier-prime/400.css';
import '@fontsource/instrument-serif/400.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.js';
import { connectImp, createHttpPort, type EventStream, type ImpClient, type Port } from '@imp/host';
import { createLocalSecretStore } from './host/secrets.js';
import { servedByLocalServer } from './host/served.js';
import './styles/tokens.css';
import './styles/app.css';

const root = document.getElementById('root');
if (root === null) {
  throw new Error('The page has no #root element.');
}
document.documentElement.dataset['theme'] = localStorage.getItem('imp.theme') ?? 'dark';

// Ask the browser not to evict the data under storage pressure.
void navigator.storage.persist();
const secrets = createLocalSecretStore();

/** The core is either the local server that delivered this page, or a worker of this page. */
function connect(): ImpClient {
  if (servedByLocalServer()) {
    const { port, lost } = createHttpPort({
      base: new URL('./', location.href).href,
      openStream: (url) => new EventSource(url) as unknown as EventStream,
      fetch: (url, request) => fetch(url, request),
      onForgotten: () => {
        location.reload();
      },
      newId: () => crypto.randomUUID(),
    });
    return connectImp(port, secrets, lost);
  }
  // A worker, so long agent runs and large files never stall the interface.
  const worker = new Worker(new URL('./host/worker.ts', import.meta.url), { type: 'module' });
  const lost = new Promise<never>((_, reject) => {
    worker.addEventListener('error', (event) => {
      reject(
        new Error(`its core did not load${event.message === '' ? '' : ` (${event.message})`}`),
      );
    });
  });
  return connectImp(worker as unknown as Port, secrets, lost);
}
const imp = connect();

createRoot(root).render(
  <StrictMode>
    <App imp={imp} />
  </StrictMode>,
);
