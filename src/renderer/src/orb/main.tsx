import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { OrbApp } from './OrbApp';
import './orb.css';

const root = document.getElementById('root');
if (!root) throw new Error('Root element #root was not found.');

createRoot(root).render(
  <StrictMode>
    <OrbApp />
  </StrictMode>,
);
