import type { Settings, PreferencesPatch } from '../../shared/desktop'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'

export function SettingsDialog({
  open,
  onOpenChange,
  settings,
  onChange,
  error,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  settings: Settings
  onChange: (patch: PreferencesPatch) => void
  error: Error | null
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle className="font-semibold">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Choose application appearance and review layouts. These settings apply to all
          repositories.
        </DialogDescription>
        {(
          [
            {
              key: 'theme',
              label: 'Appearance',
              options: [
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
                { value: 'system', label: 'System' },
              ],
            },
            {
              key: 'diffLayout',
              label: 'Diff layout',
              options: [
                { value: 'split', label: 'Split' },
                { value: 'unified', label: 'Unified' },
              ],
            },
            {
              key: 'reviewLayout',
              label: 'Review layout',
              options: [
                { value: 'continuous', label: 'Continuous' },
                { value: 'focused', label: 'Focused file' },
              ],
            },
          ] as const
        ).map(({ key, label, options }) => (
          <fieldset key={key} className="mt-6">
            <legend className="font-semibold">{label}</legend>
            <RadioGroup
              aria-label={label}
              className="mt-3"
              value={settings[key]}
              onValueChange={(value) => onChange({ [key]: value })}
            >
              {options.map((option) => (
                <RadioGroupItem key={option.value} value={option.value}>
                  {option.label}
                </RadioGroupItem>
              ))}
            </RadioGroup>
          </fieldset>
        ))}
        <Label className="mt-6">
          <Checkbox
            checked={settings.wrapLines}
            onCheckedChange={(checked) => onChange({ wrapLines: checked === true })}
          />
          Wrap long lines
        </Label>
        {error && (
          <p className="mt-4" role="alert">
            {error.message}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
