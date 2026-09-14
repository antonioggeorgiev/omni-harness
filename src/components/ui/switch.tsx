import * as SwitchPrimitive from "@radix-ui/react-switch";
import type { ComponentProps } from "react";

type SwitchProps = ComponentProps<typeof SwitchPrimitive.Root>;

export function Switch({ className = "", ...props }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      className={`group inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-muted p-0.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary ${className}`}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-5 rounded-full bg-background shadow-sm ring-0 transition-transform duration-200 data-[state=checked]:translate-x-5" />
    </SwitchPrimitive.Root>
  );
}
