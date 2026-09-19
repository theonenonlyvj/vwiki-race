import { useState, type ReactNode } from 'react';

/** Recovery must not mount gameplay or race restoration. Keep this choice
 * after the recovery screen removes the secret from the address bar. */
export default function AppEntry({ children, recoveryScreen }: {
  children: ReactNode;
  recoveryScreen: ReactNode;
}) {
  const [recovering] = useState(() => window.location.hash.startsWith('#reset-password'));
  return <>{recovering ? recoveryScreen : children}</>;
}
