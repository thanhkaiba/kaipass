import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// A share link pasted into a tab that already shows KaiPass only changes the #fragment; reload so
// the link viewer opens.
addEventListener('hashchange', () => {
  if (location.hash.startsWith('#share=')) location.reload();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
