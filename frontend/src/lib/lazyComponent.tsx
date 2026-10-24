import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';

/**
 * A component that loads its code the first time it renders.
 *
 *   const DbtPanel = lazyComponent(() => import('./components/DbtPanel'), 'DbtPanel');
 *
 * Each one carries its own Suspense boundary, so a screen loading its code never blanks the rest of the app (a single boundary
 * around everything would). The fallback is empty by default: the code is on local disk, so it's a flash, not a wait.
 * Props and types are the original component's.
 */
export function lazyComponent<M extends Record<string, unknown>, K extends keyof M>(
  load: () => Promise<M>,
  name: K,
  fallback: ReactNode = null,
): M[K] {
  const Lazy = lazy(() => load().then((m) => ({ default: m[name] as ComponentType<any> })));
  const Wrapped = (props: Record<string, unknown>) => (
    <Suspense fallback={fallback}>
      <Lazy {...props} />
    </Suspense>
  );
  Wrapped.displayName = `Lazy(${String(name)})`;
  return Wrapped as unknown as M[K];
}
