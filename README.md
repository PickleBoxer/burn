# burn

A [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) that shows your rate limits and spend above the prompt.

```
◔ 14% 5h · resets 1h7m   ◕ 83% 7d · resets 3h47m   $0.10  $4.20 today  $61.30 mo
```

- **Band above the prompt**: 5 hour and weekly limit usage with a reset countdown, plus spend for this session, today and this month. The Desktop app draws the rings as SVG, the terminal as glyphs.
- **`/burn`**: opens a pane with the limits, a bar chart of the last 7 days and the totals. `/burn refresh` re-reads the history.

## Install

Requires Claude Code v2.1.287 or later, and [Bun](https://bun.sh) for `bunx`.

```
/plugin marketplace add PickleBoxer/burn
/plugin install burn@burn
```

## How it works

- Rate limits and session cost come from Claude Code itself (`$.session.usage()`). Limits show after the first request, and only on a Pro or Max subscription.
- Today, 7 day and month totals come from [ccusage](https://github.com/ryoppippi/ccusage), which reads your local transcripts. It runs when the session starts and every 10 minutes, and the current session's spend since then is added live.
- On a subscription, spend is the API-equivalent cost, not what you're billed.

## Configuration

`ccusageCommand` (default `bunx ccusage@20.0.26`) is the command that runs ccusage, split on spaces. The Desktop app may not see your shell's `PATH`, so set an absolute path there if the band shows no history, for example `/opt/homebrew/bin/bunx ccusage@20.0.26`. Change it in `/config`, or in `~/.claude/settings.json`:

```json
{
  "pluginConfigs": {
    "burn@burn": { "ccusageCommand": "/opt/homebrew/bin/bunx ccusage@20.0.26" }
  }
}
```

## Development

```
claude --plugin-dir .          # loads the mod and reloads it on save
claude plugin validate .claude-plugin/plugin.json
claude plugin test .
```

## License

MIT
