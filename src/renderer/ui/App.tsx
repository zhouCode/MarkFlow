import React from 'react';
import { EditView } from './EditView';
import { PresenterView } from './PresenterView';
import { AudienceView } from './AudienceView';

function getView(): 'edit' | 'presenter' | 'audience' {
  const sp = new URLSearchParams(window.location.search);
  const view = sp.get('view');
  if (view === 'presenter' || view === 'audience' || view === 'edit') return view;
  return 'edit';
}

export function App() {
  const view = React.useMemo(() => getView(), []);
  if (view === 'presenter') return <PresenterView />;
  if (view === 'audience') return <AudienceView />;
  return <EditView />;
}

