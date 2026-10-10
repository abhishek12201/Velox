import React from 'react';
import ReactDOM from 'react-dom/client';
import { appTitle } from './index.js';

document.title = appTitle;
const root = document.getElementById('root');

if (!root) {
  throw new Error('Root element not found');
}

ReactDOM.createRoot(root).render(<React.StrictMode><div /> </React.StrictMode>);
