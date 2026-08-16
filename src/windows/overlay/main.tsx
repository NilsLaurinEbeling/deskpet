import { createRoot } from 'react-dom/client';

import { OverlayApp } from './OverlayApp';

const container = document.getElementById('root');
if (!container) throw new Error('overlay.html is missing its #root element');

// Deliberately no <StrictMode>: its double mount would spin up a second WebGL
// context and a second hit mask for a window that renders continuously.
createRoot(container).render(<OverlayApp />);
