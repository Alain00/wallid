import { cn } from "@/lib/utils";

/**
 * The shadcn Card, cut down to the three parts this page uses and re-skinned
 * onto the tokens the rest of the site already speaks — `raised` over `ground`,
 * hairline in `line`. The upstream component carries a `bg-card`/`text-card-
 * foreground` palette that would have to be defined twice, once here and once
 * in `@theme`, to say the thing `bg-raised` already says.
 *
 * Same border radius and border weight as `Snippet`, deliberately: they are the
 * two panels on the page and a 2xl beside an xl reads as a mistake.
 */
export function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("bg-raised/60 border-line rounded-2xl border", className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "border-line flex items-center justify-between gap-4 border-b px-5 py-4",
        className,
      )}
      {...props}
    />
  );
}

export function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("px-5 py-5", className)} {...props} />;
}
