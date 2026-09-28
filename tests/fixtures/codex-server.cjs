// Deterministic app-server protocol fixture. No network requests or model calls.
const { createInterface } = require('node:readline')
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n')
let active = ''
let sequence = 0
let approval = false
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line)
  const { id, method, params } = request
  if (method && process.env.REVUI_CODEX_LOG)
    require('node:fs').appendFileSync(process.env.REVUI_CODEX_LOG, JSON.stringify(request) + '\n')
  if (!method) {
    if (approval) {
      approval = false
      emit({
        method: 'item/completed',
        params: {
          threadId: 'fixture-session',
          item: {
            id: `reply-${process.pid}-${sequence}`,
            type: 'agentMessage',
            text: request.result.decision === 'accept' ? 'Command allowed.' : 'Command denied.',
          },
        },
      })
      emit({
        method: 'turn/completed',
        params: { threadId: 'fixture-session', turn: { id: active, status: 'completed' } },
      })
    }
    return
  }
  if (method === 'initialize') emit({ id, result: { userAgent: 'Codex fixture 0.146.0' } })
  if (method === 'model/list')
    emit({
      id,
      result: {
        data: ['chat-model', 'review-model', 'order-model'].map((model) => ({
          model,
          displayName: model,
          supportedReasoningEfforts: [
            { reasoningEffort: 'low', description: 'Fast' },
            { reasoningEffort: 'high', description: 'Thorough' },
          ],
        })),
        nextCursor: null,
      },
    })
  if (method === 'thread/start' || method === 'thread/resume')
    emit({
      id,
      result: {
        thread: { id: 'fixture-session' },
        sandbox: {
          type:
            params.sandbox === 'danger-full-access'
              ? 'dangerFullAccess'
              : params.sandbox === 'workspace-write'
                ? 'workspaceWrite'
                : 'readOnly',
        },
        approvalPolicy: params.approvalPolicy,
        approvalsReviewer: params.approvalsReviewer,
      },
    })
  if (method === 'turn/interrupt') {
    active = ''
    emit({ id, result: {} })
    return
  }
  if (method !== 'turn/start') return
  active = 'turn-' + ++sequence
  const turn = active
  emit({ id, result: { turn: { id: turn } } })
  const prompt = params.input[0].text
  if (prompt.startsWith('Hold')) return
  if (prompt.startsWith('Approval')) {
    approval = true
    emit({
      id: 900,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'fixture-session',
        turnId: turn,
        command: 'npm test',
        cwd: '/review',
        reason: 'Validate the reviewed code',
      },
    })
    return
  }
  setTimeout(
    () => {
      if (active !== turn) return
      const text = params.outputSchema?.properties?.sections
        ? JSON.stringify({
            sections: [
              {
                title: 'Public behavior',
                rationale: 'Check the changed export first.',
                paths: ['z.ts', 'file.ts'],
              },
              {
                title: 'Supporting files',
                rationale: 'Check the helper last.',
                paths: ['helpers/a.ts'],
              },
            ],
          })
        : params.outputSchema
          ? JSON.stringify({
              findings: prompt.startsWith('Review these')
                ? [
                    {
                      path: 'file.ts',
                      side: 'additions',
                      start: 1,
                      end: 1,
                      severity: 'high',
                      body: 'The changed value breaks the existing contract.',
                      replacement: 'export const value = 3',
                    },
                  ]
                : [],
              walkthrough: prompt.startsWith('Suggest a grouped')
                ? [
                    {
                      title: 'Public behavior',
                      rationale: 'Check the changed export first.',
                      paths: ['file.ts'],
                    },
                  ]
                : [],
            })
          : prompt.startsWith('Files')
            ? 'See z.ts, `helpers/a.ts:1`, and [the export](/Users/gibito/Library/Application%20Support/RevUI/worktrees/4f51a866-2328-4c61-b7e6-dc382ca72e30/file.ts:1). Unknown missing.ts stays plain.'
            : 'The review changes the exported value.'
      emit({
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'fixture-session',
          turnId: turn,
          itemId: `reply-${process.pid}-${sequence}`,
          delta: text.slice(0, 12),
        },
      })
      emit({
        method: 'item/completed',
        params: {
          threadId: 'fixture-session',
          turnId: turn,
          item: { id: `reply-${process.pid}-${sequence}`, type: 'agentMessage', text },
        },
      })
      emit({
        method: 'turn/completed',
        params: { threadId: 'fixture-session', turn: { id: turn, status: 'completed' } },
      })
    },
    params.outputSchema?.properties?.sections ? 800 : 50,
  )
})
