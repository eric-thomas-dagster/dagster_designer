import { useState } from 'react';
import { getNotifyOnRunCompletion, setNotifyOnRunCompletion } from '@/lib/runNotificationsPref';

export function useNotifyOnRunCompletion(): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState<boolean>(getNotifyOnRunCompletion);
  const set = (v: boolean) => {
    setValue(v);
    setNotifyOnRunCompletion(v);
  };
  return [value, set];
}
