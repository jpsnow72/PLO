import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { initAppearance } from './lib/appearance';
import './index.css';

// Appearance preference (issue #25): set the <html> data attributes
// before the first render so a saved deck/back/felt choice never
// flashes the default look first.
initAppearance();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Missing #root element');

createRoot(rootEl).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
