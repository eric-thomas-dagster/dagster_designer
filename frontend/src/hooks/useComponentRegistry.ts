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
  });
}
