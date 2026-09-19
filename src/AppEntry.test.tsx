import { useState } from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import AppEntry from './AppEntry';

afterEach(() => window.history.replaceState(null, '', '/'));

it('opens reset links before mounting gameplay or active-run recovery', () => {
  window.history.replaceState(null, '', '/#reset-password=synthetic-test-token');
  const mounted = vi.fn();
  function Game() { mounted(); return <p>Game</p>; }
  const view=render(<AppEntry recoveryScreen={<p>Choose a password</p>}><Game /></AppEntry>);
  expect(screen.getByText('Choose a password')).toBeVisible();
  expect(mounted).not.toHaveBeenCalled();
  window.history.replaceState(null, '', '/');
  view.rerender(<AppEntry recoveryScreen={<p>Choose a password</p>}><Game /></AppEntry>);
  expect(screen.getByText('Choose a password')).toBeVisible();
  expect(mounted).not.toHaveBeenCalled();
});

it('keeps ordinary navigation in the game', () => {
  window.history.replaceState(null, '', '/?challenge=challenge-0001');
  render(<AppEntry recoveryScreen={<p>Choose a password</p>}><p>Game</p></AppEntry>);
  expect(screen.getByText('Game')).toBeVisible();
  expect(screen.queryByText('Choose a password')).toBeNull();
});


it('switches an already-open game to recovery on an incoming reset fragment', () => {
  render(<AppEntry recoveryScreen={<p>Choose a password</p>}><p>Game</p></AppEntry>);
  act(() => {
    window.history.replaceState(null, '', '/#reset-password=incoming');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  expect(screen.queryByText('Game')).toBeNull();
  expect(screen.getByText('Choose a password')).toBeVisible();
});


it('remounts recovery for a replacement link in the same tab', () => {
  window.history.replaceState(null, '', '/#reset-password=first');
  function Recovery() {
    const [fragment] = useState(() => window.location.hash);
    return <p>{fragment}</p>;
  }
  render(<AppEntry recoveryScreen={<Recovery />}><p>Game</p></AppEntry>);
  expect(screen.getByText('#reset-password=first')).toBeVisible();
  act(() => {
    window.history.replaceState(null, '', '/#reset-password=replacement');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  expect(screen.getByText('#reset-password=replacement')).toBeVisible();
  expect(screen.queryByText('#reset-password=first')).toBeNull();
});
