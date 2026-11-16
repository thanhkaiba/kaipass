import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './fonts.css';
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

// Phones: when the keyboard opens, keep the field being typed in on screen.
window.visualViewport?.addEventListener('resize', () => {
  const el = document.activeElement;
  if (el instanceof HTMLElement && el.matches('input, textarea, select')) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
});
