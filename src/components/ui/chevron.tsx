import { cn } from "@/lib/utils";

/**
 * Points the way the panel opens, which is not a fixed direction — beside the
 * row on a wide screen, under it on a narrow one. Same 1.7px-family stroke as
 * the other icons on the page, at the size 0.65rem type can carry.
 */
export function ChevronIcon({ down }: { down: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("size-3 transition-transform duration-150", down && "rotate-90")}
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}
