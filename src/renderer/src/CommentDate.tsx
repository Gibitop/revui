import { useEffect, useState } from 'react'
import { Tooltip } from '@/components/ui/tooltip'

export function CommentDate({ date }: { date: string }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(timer)
  }, [])
  const posted = new Date(date)
  if (!Number.isFinite(posted.getTime())) return null
  const seconds = Math.max(0, Math.floor((now - posted.getTime()) / 1000))
  const unit =
    seconds < 60
      ? 'second'
      : seconds < 3600
        ? 'minute'
        : seconds < 86400
          ? 'hour'
          : seconds < 2592000
            ? 'day'
            : seconds < 31536000
              ? 'month'
              : 'year'
  const count = Math.floor(
    seconds /
      { second: 1, minute: 60, hour: 3600, day: 86400, month: 2592000, year: 31536000 }[unit],
  )
  const relative =
    seconds < 10
      ? 'just now'
      : new Intl.RelativeTimeFormat(undefined, { numeric: 'always' }).format(-count, unit)
  return (
    <Tooltip label={posted.toLocaleString()}>
      <time
        data-testid="comment-date"
        className="inline-block text-xs text-muted-foreground"
        tabIndex={0}
        dateTime={posted.toISOString()}
        aria-label={`Posted ${relative}`}
      >
        {relative}
      </time>
    </Tooltip>
  )
}
