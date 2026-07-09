import { useCallback, useEffect, useRef, useState } from "react";

export function useAutoDisclosure(defaultOpen = false) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const wasManuallyToggledRef = useRef(false);

  useEffect(() => {
    if (!wasManuallyToggledRef.current) {
      setIsOpen(defaultOpen);
    }
  }, [defaultOpen]);

  const toggle = useCallback(() => {
    wasManuallyToggledRef.current = true;
    setIsOpen((current) => !current);
  }, []);

  return {
    isOpen,
    wasManuallyToggled: wasManuallyToggledRef.current,
    toggle,
  };
}
