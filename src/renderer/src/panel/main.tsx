import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PanelApp } from './PanelApp';
import '../styles.css';
import './panel-window.css';

const root = document.getElementById('root');
if (!root) throw new Error('Root element #root was not found.');

createRoot(root).render(
  <StrictMode>
    <PanelApp />
  </StrictMode>,
);
