"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function DashboardSection({
  title,
  subtitle,
  children,
  variant = "primary",
  emphasis = false,
  divider = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  variant?: "primary" | "secondary";
  emphasis?: boolean;
  divider?: boolean;
}) {
  const Heading = variant === "primary" ? "h2" : "h3";
  return (
    <section
      className={cn(
        "space-y-4",
        variant === "secondary" && "space-y-3",
        divider && "border-t border-border pt-10",
        emphasis && "space-y-5",
      )}
    >
      <div className="min-w-0">
        <Heading
          className={cn(
            "font-medium",
            emphasis && variant === "primary" && "text-lg",
            !emphasis && variant === "primary" && "text-sm",
            variant === "secondary" && (emphasis ? "text-base" : "text-sm text-foreground/90"),
          )}
        >
          {title}
        </Heading>
        {subtitle ? (
          <p
            className={cn(
              "mt-1 text-muted-foreground",
              emphasis ? "text-base" : "text-sm",
            )}
          >
            {subtitle}
          </p>
        ) : null}
      </div>
      {children}
    </section>
  );
}
