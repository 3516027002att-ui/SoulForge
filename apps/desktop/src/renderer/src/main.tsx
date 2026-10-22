import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';
import { applyThemeMode, readThemePreferences } from './theme/themeConfig.js';
import { syncNativeWindowTheme } from './theme/nativeWindowTheme.js';

// Restore the selected mode before React's first paint; unavailable storage stays opal.
const initialThemeMode = readThemePreferences().mode;
applyThemeMode(initialThemeMode);
void syncNativeWindowTheme(initialThemeMode);

const root = document.getElementById('root');

if (!root) {
  throw new Error('Root element not found.');
}

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
