import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogTitle = DialogPrimitive.Title
export const DialogDescription = DialogPrimitive.Description

export function DialogContent({ className, children, ...props }: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/35" />
      <DialogPrimitive.Content className={cn('fixed top-1/2 left-1/2 z-50 w-[calc(100%-3rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-background p-6 shadow-lg outline-none', className)} {...props}>
        {children}
        <DialogPrimitive.Close className="absolute top-5 right-5 rounded-sm p-1 text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring">
          <X className="size-4" /><span className="sr-only">Close settings</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}
