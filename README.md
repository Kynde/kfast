# kfast

A [fast.com](https://fast.com) speed test for the terminal. Single file, zero dependencies, Node ≥ 18.

Live 3-row TUI (gradient bar + sparkline) while running, then a fast.com-style summary: download/upload Mbps, unloaded and loaded latency, client and server.

```
↓ Download   59.1 Mbps
  Latency    unloaded 61 ms · loaded 151 ms
  Client     176.72.7.73 · TeliaSonera (AS1759) · Helsinki, FI
  Server     Helsinki, FI · Stockholm, SE (5 conns)
```

## Usage

```sh
node kfast.mjs            # download only (default)
node kfast.mjs -u         # upload only
node kfast.mjs --both     # download and upload
```

Press `esc` or `q` to stop early with partial results; `Ctrl-C` aborts.

## Options

```
-u, --upload            test upload only
    --both              test download and upload
-c, --connections <n>   parallel streams        (default 8)
-n, --url-count <n>     targets to request       (default 5)
    --min-duration <s>  minimum measure time     (default 3)
    --max-duration <s>  maximum measure time     (default 30)
-d, --duration <s>      fixed measure time (sets min = max)
    --no-https          use http targets
    --json              machine-readable output, no TUI
    --plain             no live TUI, plain progress lines
    --no-color          disable colour
-h, --help              show this help
-v, --version           show version
```

## Install

```sh
npm link   # then run: kfast
```

## License

MIT
