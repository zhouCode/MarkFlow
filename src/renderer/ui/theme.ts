import React from 'react';

export type ThemeMode = 'light' | 'dark';

function applyTheme(theme: ThemeMode) {
  document.documentElement.dataset.theme = theme;
}

export function useTheme() {
  const [theme, setTheme] = React.useState<ThemeMode>(() => {
    const v = localStorage.getItem('mf:theme');
    return v === 'dark' ? 'dark' : 'light';
  });

  React.useEffect(() => {
    localStorage.setItem('mf:theme', theme);
    applyTheme(theme);
  }, [theme]);

  React.useEffect(() => {
    applyTheme(theme);
  }, []);

  return {
    theme,
    setTheme,
    toggle: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))
  };
}

