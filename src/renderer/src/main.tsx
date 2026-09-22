import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './styles.css'
import { WorkerPoolContextProvider } from '@pierre/diffs/react'
import DiffWorker from '@pierre/diffs/worker/worker.js?worker'
import { App } from './App'

const poolOptions = { workerFactory: () => new DiffWorker(), poolSize: 2 }
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false } } })

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={{ theme: { dark: 'pierre-dark', light: 'pierre-light' }, langs: ['typescript', 'tsx', 'javascript', 'jsx', 'json', 'css', 'html', 'markdown'], preferredHighlighter: 'shiki-js' }}>
        <App />
      </WorkerPoolContextProvider>
    </QueryClientProvider>
  </React.StrictMode>,
)
