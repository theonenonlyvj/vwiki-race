import { Fragment, useEffect, useState, type ReactNode } from 'react';

/** Recovery must not mount gameplay or race restoration. Keep this choice
 * after the recovery screen removes the secret from the address bar. */
export default function AppEntry({ children, recoveryScreen }: {
  children: ReactNode;
  recoveryScreen: ReactNode;
}) {
  const [entry, setEntry] = useState(() => ({
    recovering: window.location.hash.startsWith('#reset-password'),
    generation: 0,
  }));
  useEffect(() => {
    const onHashChange = () => {
      if (!window.location.hash.startsWith('#reset-password')) return;
      // A replacement link can arrive in the same browser tab. Remount the
      // recovery screen so it captures that new token before clearing it.
      setEntry(previous => ({ recovering: true, generation: previous.generation + 1 }));
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  return entry.recovering
    ? <Fragment key={entry.generation}>{recoveryScreen}</Fragment>
    : <>{children}</>;
}
