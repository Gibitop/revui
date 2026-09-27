import Markdown from 'react-markdown'
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { File } from 'lucide-react'
import { getSharedHighlighter, type SupportedLanguages, type ThemedToken } from '@pierre/diffs'
import type { CodeLocation, IntelligenceResult } from '../../shared/intelligence'
import type { FileContent, ReviewFile } from '../../shared/review'
import { gitStatuses } from './ReviewSidebar'

const commentRanges = new WeakMap<NonNullable<FileContent['newFile']>, [number, number][][]>()

const navigationKeywords = new Set(
  `abstract accessor any as asserts async await bigint boolean break case catch class const
  constructor continue debugger declare default delete do else enum export extends false finally
  for from function get global if implements import in infer instanceof interface intrinsic is
  keyof let module namespace never new null number object of out override package private protected
  public readonly require return satisfies set static string super switch symbol this throw true
  try type typeof undefined unique unknown using var void while with yield`.split(/\s+/),
)

function TooltipCode({
  children,
  className,
  theme,
}: {
  children?: ReactNode
  className?: string
  theme: 'light' | 'dark'
}) {
  const code = String(children ?? '')
  const language = className?.match(/language-([\w-]+)/)?.[1] as SupportedLanguages | undefined
  const [highlighted, setHighlighted] = useState<{
    code: string
    language: SupportedLanguages
    theme: typeof theme
    tokens: ThemedToken[][]
  } | null>(null)
  useEffect(() => {
    if (!language) return
    let canceled = false
    const syntaxTheme = theme === 'dark' ? 'pierre-dark' : 'pierre-light'
    void getSharedHighlighter({
      themes: [syntaxTheme],
      langs: [language],
      preferredHighlighter: 'shiki-js',
    })
      .then((highlighter) => {
        if (canceled) return
        const { tokens } = highlighter.codeToTokens(code, { lang: language, theme: syntaxTheme })
        setHighlighted({ code, language, theme, tokens })
      })
      .catch(() => {
        // Unknown documentation languages remain readable as plain code.
      })
    return () => {
      canceled = true
    }
  }, [code, language, theme])
  const tokens =
    highlighted?.code === code && highlighted.language === language && highlighted.theme === theme
      ? highlighted.tokens
      : null
  return (
    <code className={className}>
      {tokens
        ? tokens.map((line, lineIndex) => (
            <Fragment key={lineIndex}>
              {lineIndex > 0 && '\n'}
              {line.map((token, index) => (
                <span key={index} style={{ color: token.color }}>
                  {token.content}
                </span>
              ))}
            </Fragment>
          ))
        : children}
    </code>
  )
}

// Read the browser caret rather than estimating columns: tabs, Unicode, wrapping and
// syntax-highlight spans all use UTF-16 offsets, just like the language server.
export function codePosition(event: MouseEvent, comments: [number, number][][] | undefined) {
  if (!comments) return null
  const line = event
    .composedPath()
    .find((node) => node instanceof HTMLElement && node.matches('[data-line]')) as
    HTMLElement | undefined
  if (
    !line ||
    !line.closest('[data-code]') ||
    line.closest('[data-deletions]') ||
    line.dataset.lineType === 'change-deletion'
  )
    return null
  const shadow = line.getRootNode()
  const caret = (
    document as Document & {
      caretPositionFromPoint(
        x: number,
        y: number,
        options: { shadowRoots: ShadowRoot[] },
      ): { offsetNode: Node; offset: number } | null
    }
  ).caretPositionFromPoint(event.clientX, event.clientY, {
    shadowRoots: shadow instanceof ShadowRoot ? [shadow] : [],
  })
  if (!caret || !line.contains(caret.offsetNode)) return null
  const range = document.createRange()
  range.selectNodeContents(line)
  range.setEnd(caret.offsetNode, caret.offset)
  const character = range.toString().length
  const lineNumber = Number(line.dataset.line) - 1
  if (!Number.isInteger(lineNumber) || lineNumber < 0) return null
  if (comments[lineNumber]?.some(([start, end]) => character >= start && character < end))
    return null
  const text = line.textContent ?? ''
  for (const token of text.matchAll(
    /[$\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\$]|\$(?!\{))*`/gu,
  )) {
    const start = token.index
    const end = start + token[0].length
    if (character < start || character > end) continue
    const tokenRange = document.createRange()
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
    let offset = 0
    let node: Node | null
    while ((node = walker.nextNode())) {
      const length = node.textContent?.length ?? 0
      if (start >= offset && start < offset + length) tokenRange.setStart(node, start - offset)
      if (end > offset && end <= offset + length) {
        tokenRange.setEnd(node, end - offset)
        break
      }
      offset += length
    }
    if (
      ![...tokenRange.getClientRects()].some(
        (rect) =>
          event.clientX >= rect.left &&
          event.clientX <= rect.right &&
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom,
      )
    )
      continue
    return {
      line: lineNumber,
      character: start + (/^["'`]/.test(token[0]) ? 1 : 0),
      start,
      end,
      navigable: !navigationKeywords.has(token[0]) || /\.\s*$/.test(text.slice(0, start)),
      element: line,
      range: tokenRange,
    }
  }
  return null
}

export function CodeIntelligence({
  root,
  snapshot,
  workspace,
  path,
  file,
  files,
  theme,
  onNavigate,
}: {
  root: RefObject<HTMLElement | null>
  snapshot: string
  workspace: string | null
  path: string
  file?: FileContent['newFile']
  files: ReviewFile[]
  theme: 'light' | 'dark'
  onNavigate: (location: CodeLocation, origin: CodeLocation) => void
}) {
  const dismiss = useRef(() => {})
  const popupInteraction = useRef({ enter: () => {}, leave: () => {} })
  const popupElement = useRef<HTMLDivElement>(null)
  const [popup, setPopup] = useState<
    ({ x: number; y: number; message?: string; origin: CodeLocation } & IntelligenceResult) | null
  >(null)
  useLayoutEffect(() => {
    const element = popupElement.current
    if (!element || !popup) return
    const position = () => {
      const { width, height } = element.getBoundingClientRect()
      element.style.left = `${Math.max(8, Math.min(popup.x, document.documentElement.clientWidth - width - 8))}px`
      element.style.top = `${Math.max(8, Math.min(popup.y, document.documentElement.clientHeight - height - 8))}px`
    }
    position()
    const observer = new ResizeObserver(position)
    observer.observe(element)
    window.addEventListener('resize', position)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', position)
    }
  }, [popup])
  useEffect(() => {
    const element = root.current
    if (!element || !file || !/\.[cm]?[jt]sx?$/.test(path)) return
    let disposed = false
    let comments = commentRanges.get(file)
    const lang = path.endsWith('tsx')
      ? 'tsx'
      : path.endsWith('jsx')
        ? 'jsx'
        : /\.[cm]?ts$/.test(path)
          ? 'typescript'
          : 'javascript'
    // Tokenize the complete target file once so hidden lines and multiline comments
    // keep their grammar context. Pointer movement only checks cached ranges.
    if (!comments)
      void getSharedHighlighter({
        themes: ['pierre-dark'],
        langs: [lang],
        preferredHighlighter: 'shiki-js',
      })
        .then((highlighter) => {
          if (disposed) return
          const { tokens } = highlighter.codeToTokens(file.contents, {
            lang,
            theme: 'pierre-dark',
            includeExplanation: 'scopeName',
          })
          comments = tokens.map((tokens) => {
            const ranges: [number, number][] = []
            let offset = 0
            for (const token of tokens) {
              for (const part of token.explanation ?? []) {
                if (part.scopes.some(({ scopeName }) => scopeName.startsWith('comment.')))
                  ranges.push([offset, offset + part.content.length])
                offset += part.content.length
              }
              if (!token.explanation) offset += token.content.length
            }
            return ranges
          })
          commentRanges.set(file, comments)
        })
        .catch(() => {
          // Leave navigation disabled if lexical classification is unavailable.
        })
    type Pointer = { position: NonNullable<ReturnType<typeof codePosition>>; x: number; y: number }
    let pointer: Pointer | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let hideTimer: ReturnType<typeof setTimeout> | undefined
    let overPopup = false
    let generation = 0
    let lastPosition = ''
    let navigationKey = ''
    let pinned = false
    let decoration: {
      nodes: HTMLElement[]
      element: HTMLElement
      cursor: string
      priority: string
    } | null = null
    const clearLink = () => {
      navigationKey = ''
      if (decoration) {
        decoration.nodes.forEach((node) => node.remove())
        decoration.element.style.setProperty('cursor', decoration.cursor, decoration.priority)
        decoration = null
      }
    }
    const clear = () => {
      clearTimeout(timer)
      clearTimeout(hideTimer)
      hideTimer = undefined
      overPopup = false
      generation++
      lastPosition = ''
      pinned = false
      clearLink()
      setPopup(null)
    }
    const scheduleHide = () => {
      if (pinned || overPopup) return
      clearTimeout(timer)
      generation++
      lastPosition = ''
      hideTimer ??= setTimeout(clear, 250)
    }
    popupInteraction.current = {
      enter: () => {
        overPopup = true
        pointer = null
        clearTimeout(hideTimer)
        hideTimer = undefined
        clearTimeout(timer)
        generation++
        lastPosition = ''
        clearLink()
      },
      leave: () => {
        overPopup = false
        scheduleHide()
      },
    }
    dismiss.current = clear
    clear()
    const scroll = (event: Event) => {
      if (!(event.target instanceof Element && event.target.closest('[data-code-popup]'))) {
        pointer = null
        clear()
      }
    }
    const previewLink = () => {
      if (!pointer || pinned) {
        clearLink()
        return
      }
      if (!pointer.position.navigable) {
        clear()
        return
      }
      const { line, start, end, element: lineElement, range } = pointer.position
      const key = `${line}:${start}:${end}`
      if (navigationKey === key && decoration?.element === lineElement) return
      clearLink()
      clearTimeout(timer)
      generation++
      lastPosition = ''
      setPopup(null)
      navigationKey = key
      // This is an immediate, lexical preview. Resolve destinations only on click.
      // Overlay the text range without changing Pierre's syntax-highlighted DOM.
      const nodes = [...range.getClientRects()]
        .filter((rect) => rect.width > 0)
        .map((rect) => {
          const underline = document.createElement('div')
          underline.dataset.codeLink = ''
          underline.setAttribute('aria-hidden', 'true')
          Object.assign(underline.style, {
            position: 'fixed',
            pointerEvents: 'none',
            zIndex: '40',
            left: `${rect.left}px`,
            top: `${rect.bottom - 1}px`,
            width: `${rect.width}px`,
            borderBottom: '1px solid currentColor',
          })
          document.body.append(underline)
          return underline
        })
      decoration = {
        nodes,
        element: lineElement,
        cursor: lineElement.style.getPropertyValue('cursor'),
        priority: lineElement.style.getPropertyPriority('cursor'),
      }
      lineElement.style.setProperty('cursor', 'pointer', 'important')
    }
    const query = async (target: Pointer, kind: 'hover' | 'definition' | 'references') => {
      const { line, character, start, end } = target.position
      const id = `${line}:${start}:${end}`
      if (kind === 'hover' && (pinned || overPopup || lastPosition === id)) return
      lastPosition = id
      clearTimeout(timer)
      clearTimeout(hideTimer)
      hideTimer = undefined
      const current = ++generation
      const point = { x: target.x, y: target.y + 18 }
      const run = async () => {
        try {
          const result = await window.desktop.intelligence({
            snapshot,
            workspace,
            path,
            line,
            character,
            kind,
          })
          if (current !== generation) return
          if (result.unavailable || (kind === 'hover' && !result.hover)) {
            clear()
            return
          }
          if (kind === 'definition' && result.locations.length === 1) {
            clear()
            onNavigate(result.locations[0], { path, line: line + 1, character })
            return
          }
          pinned = kind !== 'hover' && result.locations.length > 0
          setPopup({
            ...point,
            ...result,
            origin: { path, line: line + 1, character },
            message:
              kind !== 'hover' && !result.locations.length
                ? 'No locations found in this review.'
                : undefined,
          })
        } catch (error) {
          if (current !== generation) return
          pinned = false
          const message =
            error instanceof Error
              ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
              : String(error)
          setPopup({
            ...point,
            hover: '',
            locations: [],
            message,
            origin: { path, line: line + 1, character },
          })
        }
      }
      if (kind === 'hover') timer = setTimeout(() => void run(), 450)
      else {
        pinned = true
        setPopup(null)
        await run()
      }
    }
    const move = (event: MouseEvent) => {
      const position = codePosition(event, comments)
      pointer = position ? { position, x: event.clientX, y: event.clientY } : null
      if (!pointer) {
        clearLink()
        scheduleHide()
        return
      }
      clearTimeout(hideTimer)
      hideTimer = undefined
      if (event.ctrlKey || event.metaKey) previewLink()
      else {
        clearLink()
        void query(pointer, 'hover')
      }
    }
    const click = (event: MouseEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return
      const position = codePosition(event, comments)
      if (!position) return
      event.preventDefault()
      event.stopPropagation()
      clearLink()
      if (!position.navigable) {
        clear()
        return
      }
      void query(
        { position, x: event.clientX, y: event.clientY },
        event.shiftKey ? 'references' : 'definition',
      )
    }
    const down = (event: MouseEvent) => {
      if ((event.ctrlKey || event.metaKey) && codePosition(event, comments)) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    const leave = (event: MouseEvent) => {
      pointer = null
      clearLink()
      if (
        !pinned &&
        !(
          event.relatedTarget instanceof Element && event.relatedTarget.closest('[data-code-popup]')
        )
      )
        scheduleHide()
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        clear()
        return
      }
      if (overPopup) return
      if (!['Control', 'Meta', 'Shift'].includes(event.key)) return
      if (event.ctrlKey || event.metaKey) previewLink()
      else {
        clearLink()
        if (pointer) void query(pointer, 'hover')
      }
    }
    const blur = () => {
      pointer = null
      clear()
    }
    const outside = (event: Event) => {
      const popup = popupElement.current
      if ((popup || pinned) && (!popup || !event.composedPath().includes(popup))) {
        pointer = null
        clear()
      }
    }
    element.addEventListener('mousemove', move)
    element.addEventListener('click', click, true)
    element.addEventListener('pointerdown', down, true)
    element.addEventListener('mouseleave', leave)
    window.addEventListener('keydown', key)
    window.addEventListener('keyup', key)
    window.addEventListener('blur', blur)
    window.addEventListener('resize', blur)
    window.addEventListener('scroll', scroll, true)
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('click', outside, true)
    return () => {
      disposed = true
      clearTimeout(timer)
      clearTimeout(hideTimer)
      generation++
      clearLink()
      element.removeEventListener('mousemove', move)
      element.removeEventListener('click', click, true)
      element.removeEventListener('pointerdown', down, true)
      element.removeEventListener('mouseleave', leave)
      window.removeEventListener('keydown', key)
      window.removeEventListener('keyup', key)
      window.removeEventListener('blur', blur)
      window.removeEventListener('resize', blur)
      window.removeEventListener('scroll', scroll, true)
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('click', outside, true)
    }
  }, [root, snapshot, workspace, path, file, onNavigate])
  if (!popup) return null
  return createPortal(
    <div
      ref={popupElement}
      data-code-popup
      onMouseEnter={() => popupInteraction.current.enter()}
      onMouseLeave={() => popupInteraction.current.leave()}
      role={popup.locations.length ? 'dialog' : 'tooltip'}
      aria-label="TypeScript information"
      className="fixed z-50 max-h-[min(18rem,calc(100vh_-_16px))] w-max max-w-[min(720px,calc(100vw_-_16px))] overflow-auto rounded border bg-background p-3 text-foreground shadow-lg"
      style={{ left: popup.x, top: popup.y }}
    >
      {popup.message && <p>{popup.message}</p>}
      {popup.hover && (
        <div className="markdown code-tooltip break-words">
          <Markdown
            skipHtml
            components={{
              code: ({ children, className }) => (
                <TooltipCode className={className} theme={theme}>
                  {children}
                </TooltipCode>
              ),
              img: ({ alt }) => <span>{alt}</span>,
              a: ({ children }) => <span>{children}</span>,
            }}
          >
            {popup.hover}
          </Markdown>
        </div>
      )}
      {!!popup.locations.length && (
        <div className="flex flex-col gap-1">
          <div className="sticky -top-3 z-10 -mx-3 -mt-3 flex justify-between gap-4 border-b bg-background px-3 pt-3 pb-2">
            <span>{popup.locations.length} locations</span>
            <button onClick={() => dismiss.current()} aria-label="Close locations">
              ×
            </button>
          </div>
          {popup.locations.map((location) => {
            const file = files.find((file) => file.path === location.path)
            return (
              <button
                key={`${location.path}:${location.line}:${location.character}`}
                data-git-status={
                  file?.mergeConflict ? 'conflicted' : file ? gitStatuses[file.status] : undefined
                }
                className="flex items-baseline gap-2 rounded p-1 text-left font-mono hover:bg-accent focus:bg-accent data-[git-status=added]:text-git-added data-[git-status=untracked]:text-git-added data-[git-status=deleted]:text-git-deleted data-[git-status=modified]:text-git-modified data-[git-status=renamed]:text-git-renamed data-[git-status=conflicted]:text-git-conflicted"
                onClick={() => {
                  dismiss.current()
                  onNavigate(location, popup.origin)
                }}
              >
                <span
                  className="w-3 shrink-0"
                  title={
                    file?.mergeConflict
                      ? 'Conflicted'
                      : file
                        ? gitStatuses[file.status]
                        : 'Unchanged'
                  }
                >
                  {file?.mergeConflict ? (
                    'U'
                  ) : file ? (
                    file.status
                  ) : (
                    <File
                      size={12}
                      className="inline-block text-muted-foreground"
                      aria-label="Unchanged file"
                    />
                  )}
                </span>
                <span>
                  {location.path}
                  <span className="text-muted-foreground">
                    :{location.line}:{location.character + 1}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>,
    document.body,
  )
}
