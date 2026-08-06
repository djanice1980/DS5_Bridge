import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TesterApp } from './TesterApp';
import './styles.css';
import './tester.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Tester root element missing');
}

createRoot(container).render(
  <StrictMode>
    <TesterApp />
  </StrictMode>
);
