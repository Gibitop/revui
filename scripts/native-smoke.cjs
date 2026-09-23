const { app } = require('electron')

app.whenReady().then(() => {
  let terminal
  const timeout = setTimeout(() => {
    terminal?.kill()
    console.error('Native terminal check timed out.')
    app.exit(1)
  }, 10000)
  try {
    const pty = require('node-pty')
    const windows = process.platform === 'win32'
    terminal = pty.spawn(
      windows ? process.env.ComSpec || 'cmd.exe' : '/bin/sh',
      windows ? ['/d', '/s', '/c', 'echo REVUI_PTY_OK'] : ['-c', 'printf REVUI_PTY_OK'],
      {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: process.env,
      },
    )
    let output = ''
    terminal.onData((chunk) => {
      output += chunk
    })
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timeout)
      const success = exitCode === 0 && output.includes('REVUI_PTY_OK')
      console.log(
        success
          ? `Native terminal works: Electron ${process.versions.electron}, ${process.platform}/${process.arch}.`
          : `Native terminal failed (${exitCode}): ${output}`,
      )
      app.exit(success ? 0 : 1)
    })
  } catch (error) {
    clearTimeout(timeout)
    console.error(error)
    app.exit(1)
  }
})
