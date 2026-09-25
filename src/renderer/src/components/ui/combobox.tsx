import type { ComponentProps } from 'react'
import { Combobox as ComboboxPrimitive } from '@base-ui/react/combobox'
import { cn } from '@/lib/utils'

export const Combobox = ComboboxPrimitive.Root
export const ComboboxTrigger = ComboboxPrimitive.Trigger
export const ComboboxList = ComboboxPrimitive.List
export const ComboboxEmpty = ComboboxPrimitive.Empty
export function ComboboxInput({
  className,
  ...props
}: ComponentProps<typeof ComboboxPrimitive.Input>) {
  return (
    <ComboboxPrimitive.Input
      data-slot="combobox-input"
      className={cn(
        'h-8 w-full min-w-0 bg-transparent px-1.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        className,
      )}
      {...props}
    />
  )
}
export function ComboboxContent({
  children,
  container,
  className,
  ...props
}: ComponentProps<typeof ComboboxPrimitive.Popup> & {
  container?: ComponentProps<typeof ComboboxPrimitive.Portal>['container']
}) {
  return (
    <ComboboxPrimitive.Portal container={container}>
      <ComboboxPrimitive.Positioner sideOffset={5} className="z-40">
        <ComboboxPrimitive.Popup
          data-slot="combobox-content"
          className={cn(
            'max-h-75 w-[max(var(--anchor-width),240px)] overflow-auto rounded-md border bg-background p-1 text-foreground shadow-lg',
            className,
          )}
          {...props}
        >
          {children}
        </ComboboxPrimitive.Popup>
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  )
}
export function ComboboxItem({
  className,
  ...props
}: ComponentProps<typeof ComboboxPrimitive.Item>) {
  return (
    <ComboboxPrimitive.Item
      data-slot="combobox-item"
      className={cn(
        'flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 wrap-anywhere data-highlighted:bg-accent',
        className,
      )}
      {...props}
    />
  )
}
