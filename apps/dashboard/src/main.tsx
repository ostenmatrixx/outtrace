import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Dashboard root element is missing');
}

const dashboardRoute = window.location.pathname.startsWith('/app');
const [{ App }, { LandingPage }] = await Promise.all([import('./App'), import('./LandingPage')]);

if (dashboardRoute) {
  document.title = 'Outtrace | Agency operations';
  document
    .querySelector('meta[name="description"]')
    ?.setAttribute('content', 'Outtrace cross-platform incident and agency operations workspace.');
  await import('./styles.css');
} else {
  await import('./landing.css');
}

createRoot(root).render(<StrictMode>{dashboardRoute ? <App /> : <LandingPage />}</StrictMode>);
