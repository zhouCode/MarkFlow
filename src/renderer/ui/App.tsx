import React from 'react';
import { EditView } from './EditView';
import { NotesView } from './NotesView';
import { PrintView } from './PrintView';

function getView(): 'edit' | 'notes' | 'print' {
  const sp = new URLSearchParams(window.location.search);
  const view = sp.get('view');
  if (view === 'notes' || view === 'edit' || view === 'print') return view;
  return 'edit';
}

export function App() {
  const view = React.useMemo(() => getView(), []);
  if (view === 'notes') return <NotesView />;
  if (view === 'print') return <PrintView />;
  return <EditView />;
}
