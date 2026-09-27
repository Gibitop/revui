export type CodeLocation = { path: string; line: number; character: number; fileOnly?: boolean }
export type IntelligenceRequest = {
  snapshot: string
  workspace: string | null
  path: string
  line: number
  character: number
  kind: 'hover' | 'definition' | 'references'
}
export type IntelligenceResult = {
  hover: string
  locations: CodeLocation[]
  unavailable?: boolean
}
