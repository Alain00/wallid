import * as PopoverPrimitive from "@radix-ui/react-popover";
import { cn } from "@/lib/utils";

/**
 * shadcn's Popover, trimmed to what this page uses.
 *
 * Radix rather than a hand-rolled panel because the trigger lives *inside* a
 * text input: focus has to leave the field and come back to it on close, escape
 * has to dismiss without clearing what was typed, and an outside click has to
 * count as a dismissal rather than a blur. That is the whole component.
 */
const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;

function PopoverContent({
  className,
  align = "center",
  sideOffset = 10,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "bg-raised border-line text-ink z-50 rounded-2xl border p-4 shadow-2xl shadow-black/40",
          // `popover-panel` carries the open/close motion. shadcn reaches for
          // tailwindcss-animate's `animate-in` utilities here; those are a
          // dependency this page does not otherwise need, and the keyframes
          // they generate for two states are four lines of CSS.
          "popover-panel outline-none",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverTrigger, PopoverAnchor, PopoverContent };
