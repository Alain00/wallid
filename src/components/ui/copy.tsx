import { useEffect, useRef, useState } from "react";

/**
 * Copy-to-clipboard with a self-clearing confirmation.
 *
 * Shared by the two things on this page that hand you code — the install
 * command and the config snippet — because the interesting parts are the ones
 * easy to get subtly different between two copies: swallowing a refused
 * clipboard, and clearing the timer on unmount so a component that leaves
 * during the confirmation window does not set state after it is gone.
 */
export function useCopy(text: string) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => () => clearTimeout(timer.current ?? undefined), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard access is refusable and origin-gated, and a landing page has
      // nothing useful to say when it is refused — the text is on screen and
      // selectable either way. Swallow rather than flash a failure toast.
      return;
    }
    setCopied(true);
    clearTimeout(timer.current ?? undefined);
    timer.current = setTimeout(() => setCopied(false), 1600);
  };

  return { copied, copy };
}

export function CopyIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-4"
    >
      <rect x="9" y="9" width="11" height="11" rx="2.5" />
      <path d="M5.5 15H5a1.5 1.5 0 0 1-1.5-1.5v-8A1.5 1.5 0 0 1 5 4h8A1.5 1.5 0 0 1 14.5 5.5V6" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-4"
    >
      <path d="m5 12.5 4.5 4.5L19 7" />
    </svg>
  );
}
