import '@fontsource-variable/inter';
import '@fontsource/courier-prime/400.css';
import '@fontsource/instrument-serif/400.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.js';
import { createImp } from './host/imp.js';
import { IndexedDbKeyValueStore } from './host/indexeddb-store.js';
import { createLocalSecretStore } from './host/secrets.js';
import './styles/tokens.css';
import './styles/app.css';

const root = document.getElementById('root');
if (root === null) {
  throw new Error('The page has no #root element.');
}
document.documentElement.dataset['theme'] = localStorage.getItem('imp.theme') ?? 'dark';

const store = await IndexedDbKeyValueStore.open('imp');
// Ask the browser not to evict the data under storage pressure.
void navigator.storage.persist();
const imp = createImp({ store, secrets: createLocalSecretStore() });

createRoot(root).render(
  <StrictMode>
    <App imp={imp} />
  </StrictMode>,
);
