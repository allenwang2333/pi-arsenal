# pi-arsenal

A package of terminal UI changes, tools, skills, and themes for [Pi](https://pi.dev).
It does not supply provider settings, credentials, or a global prompt.

## Install

This release was tested with Pi 1.5.2. Try it for one session:

```sh
pi -ne -e git:github.com/allenwang2333/pi-arsenal@v0.1.0
```

`-ne` skips your usual extensions for this run, including the built-in MCP
extension, so another extension cannot register the same tools. The trial
does not change your saved settings.

To keep the package enabled, first disable any extensions that also
register `edit` or `background-process`, then run:

```sh
pi install git:github.com/allenwang2333/pi-arsenal@v0.1.0
```

The package replaces Pi's built-in `edit` tool and changes parts of the
interactive UI.

## What it includes

- **Terminal UI:** compact messages, tool calls, and progress indicators, plus
  code block and text selection improvements.
- **Tools:** hashline `edit` identifies lines by hash and rejects stale edits;
  `background-process` starts, checks, and stops time-limited shell commands.
- **Commands:** `/context` reports context usage; `/usage` summarizes usage
  from local Pi sessions.
- **Skills:** engineering, code review, research, explanations, slides, and
  commit and pull request writing.
- **Themes:** Catppuccin Mocha, Mist Dark, and Soft Lights.

## Development

Use Node.js 22.19 or newer. Dependencies for tests match Pi 1.5.2.

```sh
npm ci
npm test
```

These tests do not need local Pi settings or provider credentials.
See [CHANGELOG.md](CHANGELOG.md) for version notes.

## License

[MIT](LICENSE).
