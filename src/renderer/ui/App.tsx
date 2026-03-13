import React from 'react';
import { EditView } from './EditView';
import { NotesView } from './NotesView';

function getView(): 'edit' | 'notes' {
  const sp = new URLSearchParams(window.location.search);
  const view = sp.get('view');
  if (view === 'notes' || view === 'edit') return view;
  return 'edit';
}

export function App() {
  const view = React.useMemo(() => getView(), []);
  if (view === 'notes') return <NotesView />;
  return <EditView />;
}
