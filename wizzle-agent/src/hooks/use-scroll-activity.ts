import { useCallback, useEffect, useRef, useState } from "react";

export function useScrollActivity(delay = 900) {
  const [isScrolling, setIsScrolling] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  const handleScrollActivity = useCallback(() => {
    setIsScrolling(true);

    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
    }

    timeoutRef.current = window.setTimeout(() => {
      setIsScrolling(false);
      timeoutRef.current = null;
    }, delay);
  }, [delay]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return { handleScrollActivity, isScrolling };
}
