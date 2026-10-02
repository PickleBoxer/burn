# burn

A [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) that shows your rate limits, usage credits and spend above the prompt.

In the Desktop app:

![burn in the Claude Desktop app](docs/desktop.png)

In the terminal:

```
◑ 59% 5h · resets 7m   ◕ 81% 7d · resets 8h57m   ● €120.06 / €120 credits   ≈$3.27 session
```

- **Band above the prompt**: 5 hour and weekly limit usage with a reset countdown, your usage credits for the month, and this session's cost. The Desktop app draws the rings as SVG, the terminal as glyphs.
- **`/burn`**: opens a pane with the limits, credits, a bar chart of the last 7 days and the totals. `/burn refresh` reloads them.

## Install

Requires Claude Code v2.1.287 or later.

```
/plugin marketplace add PickleBoxer/burn
/plugin install burn@burn
```

## Where the numbers come from

- **Rate limits and session cost** come from Claude Code itself. Limits show after the first request, and only on a Pro or Max subscription.
- **Usage credits** are the only billed figure. They come from the same endpoint `/status` reads, through Claude Code's own credential, which the mod never sees. That endpoint is internal, so if it changes the credits group just disappears.
- **Today, 7 day and month (≈)** are API-equivalent cost, not your bill. burn records each session's cost per day on this machine, starting when you install it, so the chart fills in over the first week.

## Development

```
claude --plugin-dir .          # loads the mod and reloads it on save
claude plugin validate .claude-plugin/plugin.json
claude plugin test .
```

## License

MIT
