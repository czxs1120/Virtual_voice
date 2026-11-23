import { useCallback, useRef, useState } from "react";

export function useStatusMessage() {
  const [statusMessage, setStatusMessage] = useState("");
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showStatus = useCallback((msg: string, duration = 2000) => {
    setStatusMessage(msg);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setStatusMessage(""), duration);
  }, []);

  return { statusMessage, showStatus };
}
