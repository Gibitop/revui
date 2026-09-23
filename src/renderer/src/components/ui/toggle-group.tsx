import type { ComponentProps } from 'react'
import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group'
import { cn } from '@/lib/utils'

export function ToggleGroup({
  className,
  ...props
}: ComponentProps<typeof ToggleGroupPrimitive.Root>) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      className={cn('flex gap-1 border-b', className)}
      {...props}
    />
  )
}
export function ToggleGroupItem({
  className,
  ...props
}: ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      className={cn(
        'grid flex-1 place-items-center border-b-2 border-transparent p-2 text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=on]:border-foreground data-[state=on]:bg-accent data-[state=on]:text-foreground',
        className,
      )}
      {...props}
    />
  )
}
