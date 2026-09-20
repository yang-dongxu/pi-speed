# pi-speed

A [Pi](https://github.com/earendil-works/pi) extension that shows output-token throughput and request volume in the footer and through a `/speed` command.

## Features

- Live, estimated speed while a model response is streaming
- Exact TPS for the latest response when the provider reports output-token usage
- Rolling TPS, TPM, and RPM over the last 5 and 20 minutes by default
- Custom rolling windows such as 30 seconds, 10 minutes, 2 hours, or 1 day
- Restores completed-response samples from the active session branch after reload or resume

## Install

Install globally from GitHub (recommended):

```bash
pi install git:github.com/yang-dongxu/pi-speed
```

You can also use the repository URL:

```bash
pi install https://github.com/yang-dongxu/pi-speed
```

To install only for the current project, run this from that project directory:

```bash
pi install -l git:github.com/yang-dongxu/pi-speed
```

To try it without installing:

```bash
pi -e git:github.com/yang-dongxu/pi-speed
```

Then start Pi, or run `/reload` if Pi is already open. To update the installed extension later:

```bash
pi update git:github.com/yang-dongxu/pi-speed
```

For local development from a clone:

```bash
pi -e ./extensions/pi-speed.ts
```

## Usage

Show the default rolling windows:

```text
/speed
```

Show custom windows:

```text
/speed 30s 10m 1h
```

A bare number means minutes, so `/speed 5 20` is equivalent to `/speed 5m 20m`. Supported units are `s`, `m`, `h`, and `d`; windows may range from 1 second to 30 days.

Example output:

```text
Token speed
Current: 42.7 TPS (812 tokens / 19.0s, latest response)
Last 5m: 38.4 TPS · 386 TPM · 0.60 RPM (1,932 tokens / 3 responses)
Last 20m: 35.1 TPS · 244 TPM · 0.40 RPM (4,882 tokens / 8 responses)
TPS = generation throughput · TPM = rolling token volume · RPM = rolling completed responses. ~ means estimated tokens.
```

## Measurement details

- **TPS** is output tokens divided by end-to-end model response time, including time to first token. Rolling TPS uses total output tokens divided by total response time, weighting long responses appropriately.
- **TPM** is the output-token volume completed inside the rolling window, normalized per minute. For example, 1,000 tokens in a 5-minute window is 200 TPM.
- **RPM** is the number of model responses completed inside the rolling window, normalized per minute. For example, 10 responses in a 5-minute window is 2 RPM.
- The current response shows TPS only; TPM and RPM require a rolling time window.
- Final counts use provider-reported `usage.output` when available.
- Live counts, and final counts from providers that omit output usage, use Pi's four-characters-per-token style heuristic and are marked with `~`.
- Failed and aborted responses are excluded from rolling averages.
- History follows the active session branch; it is rebuilt when a session starts or tree navigation completes. Restored durations come from Pi's message and session-entry timestamps, so another extension with a slow `message_end` hook can make restored rates differ slightly from the original live measurement.

## Development

```bash
npm install
npm run check
```

## License

MIT
