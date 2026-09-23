import type { ComponentProps } from 'react'
import { Switch as SwitchPrimitive } from '@base-ui/react/switch'
import { cn } from '@/lib/utils'

export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-input bg-muted p-0.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background data-checked:border-primary data-checked:bg-primary data-disabled:cursor-default data-disabled:opacity-40',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="size-3.5 rounded-full bg-muted-foreground transition-transform data-checked:translate-x-4 data-checked:bg-primary-foreground" />
    </SwitchPrimitive.Root>
  )
}
