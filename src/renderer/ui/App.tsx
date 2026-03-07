import React from 'react';
import { EditView } from './EditView';
import { AudienceView } from './AudienceView';

function getView(): 'edit' | 'share' {
  const sp = new URLSearchParams(window.location.search);
  const view = sp.get('view');
  if (view === 'share' || view === 'edit') return view;
  return 'edit';
}

export function App() {
  const view = React.useMemo(() => getView(), []);
  if (view === 'share') return <AudienceView />;
  return <EditView />;
}
