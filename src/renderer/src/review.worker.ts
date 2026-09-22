import { parseDiffFromFile } from '@pierre/diffs'
import { prepareFileTreeInput } from '@pierre/trees'
import type { FileContent } from '../../shared/review'

self.onmessage = (event: MessageEvent<{ kind: 'tree'; paths: string[] } | { kind: 'diff'; content: FileContent }>) => {
  try {
    const data = event.data
    self.postMessage({ result: data.kind === 'tree' ? prepareFileTreeInput(data.paths).paths : parseDiffFromFile(data.content.oldFile, data.content.newFile, undefined, true) })
  } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }) }
}
