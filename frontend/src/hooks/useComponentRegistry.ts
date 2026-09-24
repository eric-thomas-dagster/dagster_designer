import { useQuery } from '@tanstack/react-query';
import { componentsApi } from '@/services/api';

export function useComponentRegistry(category?: string) {
  return useQuery({
    queryKey: ['components', category],
    queryFn: () => componentsApi.list(category),
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

export function useComponent(componentType: string, projectId?: string) {
  return useQuery({
    queryKey: ['component', componentType, projectId],
    queryFn: () => componentsApi.get(componentType, projectId),
    enabled: !!componentType,
    // A 404 here means Designer just doesn't have a schema for this
    // component type at all (e.g. a project-local custom component --
    // Designer can only introspect its own built-in component libraries).
    // Retrying can never turn that into a different answer, so don't --
    // the default retry: 1 (see main.tsx's QueryClient) was adding a
    // real, visible delay (request, wait, retry, wait again) before
    // PropertyPanel's "Advanced" button could switch to its "Open YAML"
    // fallback for exactly this case. Other error types (a genuine
    // transient network blip, a 500) still get the one default retry.
    retry: (failureCount, error: any) => {
      if (error?.response?.status === 404) return false;
      return failureCount < 1;
    },
  });
}
