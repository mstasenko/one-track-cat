import { useEffect, useRef, useState } from 'react'

function displayed(value: number): string {
  return String(Number(value.toFixed(3)))
}

export function NumberControl({ label, value, min, max, step, onChange }: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
}): React.JSX.Element {
  const input = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState(displayed(value))

  useEffect(() => {
    if (document.activeElement !== input.current) setDraft(displayed(value))
  }, [value])

  const validValue = (raw: string): number | null => {
    if (!raw.trim()) return null
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : null
  }

  return (
    <label className="control-row">
      <span>{label}</span>
      <input
        ref={input}
        aria-label={label}
        type="number"
        inputMode="decimal"
        value={draft}
        min={min}
        max={max}
        step={step}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => {
          setDraft(event.target.value)
          const next = validValue(event.target.value)
          if (next !== null) onChange(next)
        }}
        onBlur={() => {
          const next = validValue(draft)
          setDraft(displayed(next ?? value))
          if (next !== null) onChange(next)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
        }}
      />
    </label>
  )
}
