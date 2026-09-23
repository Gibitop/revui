import type { ComponentProps } from 'react'
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group'
import { cn } from '@/lib/utils'

export function RadioGroup({
  className,
  ...props
}: ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      orientation="horizontal"
      className={cn('flex gap-1 rounded-md border p-0.5', className)}
      {...props}
    />
  )
}

// A segmented presentation of the shadcn/Radix radio control for compact preferences.
export function RadioGroupItem({
  className,
  ...props
}: ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        'flex-1 whitespace-nowrap rounded-sm px-2 py-1 text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=checked]:bg-muted data-[state=checked]:text-foreground',
        className,
      )}
      {...props}
    />
  )
}
