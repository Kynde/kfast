#!/usr/bin/env node
// kfast — a fast.com speed test for the terminal. Zero dependencies, Node >= 18.
// Download by default; upload opt-in. Live TUI, then fast.com-style "more info".

// ─── ansi / color ──────────────────────────────────────────────────────────

const useColor = () =>
  process.stdout.isTTY && !process.env.NO_COLOR && !ARGS.noColor;

const rgb = (r, g, b, s) =>
  useColor() ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m` : s;
const bold = (s) => (useColor() ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s) => (useColor() ? `\x1b[2m${s}\x1b[0m` : s);

// linear gradient between two rgb stops at fraction t∈[0,1]
const lerp = (a, b, t) => Math.round(a + (b - a) * t);
const grad = (t, [r0, g0, b0], [r1, g1, b1]) => [
  lerp(r0, r1, t),
  lerp(g0, g1, t),
  lerp(b0, b1, t),
];

const DOWN_STOPS = [[0, 180, 255], [80, 255, 170]]; // cyan → mint
const UP_STOPS = [[255, 90, 210], [180, 120, 255]]; // pink → violet

const write = (s) => process.stdout.write(s);
const hideCursor = () => process.stdout.isTTY && write("\x1b[?25l");
const showCursor = () => process.stdout.isTTY && write("\x1b[?25h");

// ─── small utilities ─────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const cov = (xs) => {
  if (xs.length < 2) return Infinity;
  const m = mean(xs);
  if (m <= 0) return Infinity;
  const v = mean(xs.map((x) => (x - m) ** 2));
  return Math.sqrt(v) / m;
};

const fmtSpeed = (mbps) =>
  mbps >= 100 ? mbps.toFixed(0) : mbps >= 10 ? mbps.toFixed(1) : mbps.toFixed(2);
const fmtMs = (ms) => (ms > 0 ? Math.round(ms).toString() : "--");

const UA = {
  headers: {
    "user-agent":
      "Mozilla/5.0 (X11; Linux x86_64) kfast/1.0 (+https://fast.com)",
  },
};

// ─── argument parsing ────────────────────────────────────────────────────────

const HELP = `kfast — fast.com speed test for the terminal

usage: kfast [options]

  -u, --upload            test upload only
      --both              test download and upload
      (default)           test download only

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
`;

const VERSION = "0.2.0";

function parseArgs(argv) {
  const o = {
    mode: "download", // download | upload | both
    connections: 8,
    urlCount: 5,
    minDuration: 3,
    maxDuration: 30,
    https: true,
    json: false,
    plain: false,
    noColor: false,
  };
  const next = (i, name) => {
    const v = argv[i + 1];
    if (v === undefined) fail(`missing value for ${name}`);
    return v;
  };
  const positiveNum = (v, name) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) fail(`invalid number for ${name}: ${v}`);
    return n;
  };
  const positiveInt = (v, name) => {
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n <= 0)
      fail(`invalid integer for ${name}: ${v}`);
    return n;
  };
  let upload = false;
  let both = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h": case "--help": write(HELP); process.exit(0); break;
      case "-v": case "--version": write(VERSION + "\n"); process.exit(0); break;
      case "-u": case "--upload": upload = true; break;
      case "--both": both = true; break;
      case "-c": case "--connections": o.connections = positiveInt(next(i, a), a); i++; break;
      case "-n": case "--url-count": o.urlCount = positiveInt(next(i, a), a); i++; break;
      case "--min-duration": o.minDuration = positiveNum(next(i, a), a); i++; break;
      case "--max-duration": o.maxDuration = positiveNum(next(i, a), a); i++; break;
      case "-d": case "--duration": {
        const d = positiveNum(next(i, a), a); o.minDuration = d; o.maxDuration = d; i++; break;
      }
      case "--no-https": o.https = false; break;
      case "--json": o.json = true; break;
      case "--plain": o.plain = true; break;
      case "--no-color": o.noColor = true; break;
      default: fail(`unknown option: ${a}`);
    }
  }
  if (o.maxDuration < o.minDuration) o.maxDuration = o.minDuration;
  o.mode = both ? "both" : upload ? "upload" : "download";
  return o;
}

function fail(msg) {
  write(`kfast: ${msg}\n`);
  process.exit(2);
}

let ARGS; // set in main

// ─── fast.com api ─────────────────────────────────────────────────────────────

// fetch with a few retries + a hard timeout, for the flaky setup requests
async function fetchRetry(url, opts = {}, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        ...UA,
        ...opts,
        signal: AbortSignal.timeout(10_000),
      });
      return res;
    } catch (e) {
      last = e;
      await sleep(300 * (i + 1));
    }
  }
  throw new Error(`network request failed (${url.replace(/\?.*/, "")}): ${last?.message ?? last}`);
}

async function getToken() {
  const html = await (await fetchRetry("https://fast.com")).text();
  const js = html.match(/\/app-[a-zA-Z0-9]+\.js/);
  if (!js) throw new Error("could not locate fast.com JS bundle");
  const bundle = await (await fetchRetry("https://fast.com" + js[0])).text();
  const token = bundle.match(/token:"([a-zA-Z0-9]+)"/);
  if (!token) throw new Error("could not extract API token");
  return token[1];
}

async function getTargets(token, https, urlCount) {
  const url =
    `https://api.fast.com/netflix/speedtest/v2?https=${https}` +
    `&token=${token}&urlCount=${urlCount}`;
  const res = await fetchRetry(url);
  if (res.status === 403) throw new Error("API rejected token (403)");
  if (!res.ok) throw new Error(`API error ${res.status}`);
  const data = await res.json();
  if (!data.targets?.length) throw new Error("API returned no targets");
  return data; // { client, targets }
}

// build a ranged measurement URL from a target url
const rangeUrl = (targetUrl, bytes) =>
  targetUrl.replace("/speedtest?", `/speedtest/range/0-${bytes - 1}?`);

const DL_CHUNK = 26_214_400; // 25 MiB per request, worker re-issues as needed
const UP_CHUNK = 26_214_400;
const UP_BLOCK = new Uint8Array(65_536); // reused zero-filled upload block

// one latency probe against a target (1-byte range GET), returns ms or null
async function ping(targetUrl, signal) {
  const url = targetUrl.replace("/speedtest?", "/speedtest/range/0-0?");
  const t = performance.now();
  try {
    const r = await fetch(url, { ...UA, signal });
    await r.arrayBuffer();
    return performance.now() - t;
  } catch {
    return null;
  }
}

async function measureUnloaded(targetUrl, n = 6) {
  const xs = [];
  for (let i = 0; i < n; i++) {
    const p = await ping(targetUrl);
    if (p != null) xs.push(p);
  }
  return { min: xs.length ? Math.min(...xs) : 0, median: median(xs) };
}

// ─── workers ──────────────────────────────────────────────────────────────────

async function downloadWorker(state, ctl, nextTarget) {
  while (!state.stopped) {
    const t = nextTarget();
    try {
      const res = await fetch(rangeUrl(t.url, DL_CHUNK), {
        ...UA,
        signal: ctl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`download target returned ${res.status}`);
      for await (const chunk of res.body) {
        state.bytes += chunk.length;
        if (state.stopped) break;
      }
    } catch {
      if (state.stopped) return;
      await sleep(50); // transient; retry with next target
    }
  }
}

// a ReadableStream that emits up to `size` bytes, counting as the socket pulls
function uploadStream(size, state) {
  let sent = 0;
  return {
    body: new ReadableStream({
      pull(controller) {
        if (sent >= size || state.stopped) {
          controller.close();
          return;
        }
        const remaining = size - sent;
        const chunk =
          remaining < UP_BLOCK.length ? UP_BLOCK.subarray(0, remaining) : UP_BLOCK;
        controller.enqueue(chunk);
        sent += chunk.length;
        state.bytes += chunk.length;
      },
    }),
    sent: () => sent,
  };
}

async function uploadWorker(state, ctl, nextTarget) {
  while (!state.stopped) {
    const t = nextTarget();
    const stream = uploadStream(UP_CHUNK, state);
    try {
      const res = await fetch(rangeUrl(t.url, UP_CHUNK), {
        ...UA,
        method: "POST",
        body: stream.body,
        duplex: "half",
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`upload target returned ${res.status}`);
    } catch {
      if (!state.stopped) state.bytes -= stream.sent();
      if (state.stopped) return;
      await sleep(50);
    }
  }
}

// ─── tui rendering ─────────────────────────────────────────────────────────────

const SPARK_CHARS = " ▁▂▃▄▅▆▇█";
const BAR_W = 40;
const SPARK_W = 24;

function gradientBar(frac, stops) {
  const filled = clamp(Math.round(BAR_W * frac), 0, BAR_W);
  let out = "";
  for (let i = 0; i < BAR_W; i++) {
    if (i < filled) {
      const [r, g, b] = grad(i / (BAR_W - 1), stops[0], stops[1]);
      out += rgb(r, g, b, "█");
    } else {
      out += dim("─");
    }
  }
  return "▕" + out + "▏";
}

function sparkline(samples, peak, stops) {
  const tail = samples.slice(-SPARK_W);
  const pad = SPARK_W - tail.length;
  let out = " ".repeat(pad);
  for (const v of tail) {
    const frac = peak > 0 ? clamp(v / peak, 0, 1) : 0;
    const idx = Math.round(frac * (SPARK_CHARS.length - 1));
    const [r, g, b] = grad(frac, stops[0], stops[1]);
    out += rgb(r, g, b, SPARK_CHARS[idx]);
  }
  return out;
}

let blockRendered = false;

function renderFrame(kind, view, opts) {
  if (opts.plain || !process.stdout.isTTY) return;
  const isUp = kind === "upload";
  const stops = isUp ? UP_STOPS : DOWN_STOPS;
  const arrow = isUp ? "↑" : "↓";
  const label = isUp ? "UPLOAD" : "DOWNLOAD";
  const accent = ([r, g, b]) => rgb(r, g, b, `${arrow} ${label}`);

  const num = bold(fmtSpeed(view.mbps));
  const l1 =
    ` ${accent(stops[1])}` +
    " ".repeat(Math.max(1, 30 - label.length - 2)) +
    `${num} ${dim("Mbps")}`;
  const l2 = ` ${gradientBar(view.peak > 0 ? view.mbps / view.peak : 0, stops)}  ${sparkline(
    view.spark,
    view.peak,
    stops,
  )}`;
  const l3 = dim(
    ` latency ${fmtMs(view.latency)} ms · ${view.elapsed.toFixed(1)}s · ${
      opts.connections
    } conns · peak ${fmtSpeed(view.peak)} · esc to quit`,
  );

  if (blockRendered) write("\x1b[3A");
  write(`\x1b[2K${l1}\n\x1b[2K${l2}\n\x1b[2K${l3}\n`);
  blockRendered = true;
}

// ─── measurement phase ──────────────────────────────────────────────────────────

async function runPhase(kind, targets, opts) {
  const state = { bytes: 0, stopped: false };
  const ctl = new AbortController();
  let targetIndex = 0;
  const nextTarget = () => targets[targetIndex++ % targets.length];
  const workerFn = kind === "upload" ? uploadWorker : downloadWorker;
  const workers = Array.from({ length: opts.connections }, () =>
    workerFn(state, ctl, nextTarget),
  );

  const loadedPings = [];
  const pinger = (async () => {
    while (!state.stopped) {
      await sleep(500);
      if (state.stopped) break;
      const p = await ping(targets[0].url, ctl.signal);
      if (p != null) loadedPings.push(p);
    }
  })();

  const samples = []; // per-tick instantaneous Mbps (raw, for stability)
  const spark = []; // smoothed Mbps history for the sparkline
  let smoothed = 0;
  let peak = 0;
  const start = performance.now();
  let lastT = start;
  let lastB = 0;
  let lastPlain = 0;

  await new Promise((resolve) => {
    blockRendered = false;
    const SAMPLE_MS = 200;
    const iv = setInterval(() => {
      const now = performance.now();
      const dt = (now - lastT) / 1000;
      const db = Math.max(0, state.bytes - lastB);
      lastT = now;
      lastB = state.bytes;
      const inst = dt > 0 ? (db * 8) / 1e6 / dt : 0; // Mbps this tick
      samples.push(inst);
      const win = samples.slice(-8);
      smoothed = mean(win);
      spark.push(smoothed);
      if (spark.length > SPARK_W) spark.shift();
      peak = Math.max(peak, smoothed);
      const elapsed = (now - start) / 1000;
      const latency = median(loadedPings);

      renderFrame(kind, { mbps: smoothed, peak, spark, latency, elapsed }, opts);
      if (opts.plain && now - lastPlain > 1000) {
        lastPlain = now;
        write(
          `${kind}: ${fmtSpeed(smoothed)} Mbps  (${elapsed.toFixed(0)}s)\n`,
        );
      }

      const stable =
        elapsed >= opts.minDuration && cov(samples.slice(-10)) < 0.05;
      if (control.interrupted || elapsed >= opts.maxDuration || stable) {
        clearInterval(iv);
        resolve();
      }
    }, SAMPLE_MS);
  });

  state.stopped = true;
  ctl.abort();
  await Promise.allSettled([...workers, pinger]);

  return { mbps: smoothed, peakMbps: peak, loadedLatency: median(loadedPings) };
}

// ─── results output ────────────────────────────────────────────────────────────

function uniqueLocations(targets) {
  const seen = new Set();
  const out = [];
  for (const t of targets) {
    const key = `${t.location?.city ?? "?"}, ${t.location?.country ?? "?"}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

function printResults(res, opts) {
  const { client, unloaded, download, upload, targets } = res;

  if (opts.json) {
    write(
      JSON.stringify(
        {
          downloadMbps: download ? +download.mbps.toFixed(2) : null,
          uploadMbps: upload ? +upload.mbps.toFixed(2) : null,
          latencyMs: {
            unloaded: +unloaded.median.toFixed(1),
            unloadedMin: +unloaded.min.toFixed(1),
            downloadLoaded: download ? +download.loadedLatency.toFixed(1) : null,
            uploadLoaded: upload ? +upload.loadedLatency.toFixed(1) : null,
          },
          client: {
            ip: client.ip,
            asn: client.asn,
            isp: client.isp,
            city: client.location?.city,
            country: client.location?.country,
          },
          servers: uniqueLocations(targets),
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  const label = (s) => dim(s.padEnd(11));
  write("\n");
  if (download)
    write(
      `${rgb(80, 255, 170, "↓")} ${label("Download")}${bold(
        fmtSpeed(download.mbps),
      )} ${dim("Mbps")}\n`,
    );
  if (upload)
    write(
      `${rgb(180, 120, 255, "↑")} ${label("Upload")}${bold(
        fmtSpeed(upload.mbps),
      )} ${dim("Mbps")}\n`,
    );

  const loaded = download?.loadedLatency ?? upload?.loadedLatency ?? 0;
  write(
    `  ${label("Latency")}${dim("unloaded")} ${bold(
      fmtMs(unloaded.median),
    )} ms ${dim("· loaded")} ${bold(fmtMs(loaded))} ms\n`,
  );

  write(
    `  ${label("Client")}${client.ip} ${dim("·")} ${client.isp} ${dim(
      `(AS${client.asn})`,
    )} ${dim("·")} ${client.location?.city}, ${client.location?.country}\n`,
  );

  const locs = uniqueLocations(targets);
  write(
    `  ${label("Server")}${locs.join(dim(" · "))} ${dim(
      `(${opts.connections} conn${opts.connections > 1 ? "s" : ""}, ` +
        `${targets.length} target${targets.length > 1 ? "s" : ""})`,
    )}\n`,
  );
}

// ─── interaction: esc / q to quit, ctrl-c to abort ─────────────────────────────

const control = { interrupted: false };
let restoreKeyboard = () => {};

function setupKeyboard() {
  const stdin = process.stdin;
  if (!stdin.isTTY) return () => {};
  stdin.setRawMode(true);
  stdin.resume();
  const onData = (buf) => {
    if (buf.length === 1 && buf[0] === 0x03) return hardQuit(); // Ctrl-C
    // bare ESC, or q/Q → graceful stop (a lone 0x1b, so arrow-key escapes don't match)
    if (buf.length === 1 && (buf[0] === 0x1b || buf[0] === 0x71 || buf[0] === 0x51))
      control.interrupted = true;
  };
  stdin.on("data", onData);
  return () => {
    stdin.off("data", onData);
    try {
      stdin.setRawMode(false);
    } catch {}
    stdin.pause();
  };
}

function hardQuit() {
  restoreKeyboard();
  showCursor();
  write("\n");
  process.exit(130);
}

// ─── main ────────────────────────────────────────────────────────────────────────

async function main() {
  ARGS = parseArgs(process.argv.slice(2));

  const status = (s) => {
    if (!ARGS.json && !ARGS.plain && process.stdout.isTTY)
      write(`\r\x1b[2K${dim(s)}`);
    else if (!ARGS.json) write(`${s}\n`);
  };

  restoreKeyboard = setupKeyboard();
  try {
    status("connecting to fast.com…");
    const token = await getToken();
    const { client, targets } = await getTargets(
      token,
      ARGS.https,
      ARGS.urlCount,
    );

    status("measuring latency…");
    const unloaded = await measureUnloaded(targets[0].url);
    if (process.stdout.isTTY && !ARGS.plain && !ARGS.json) write("\r\x1b[2K");

    hideCursor();
    let download = null;
    let upload = null;
    const wantDownload = ARGS.mode === "download" || ARGS.mode === "both";
    const wantUpload = ARGS.mode === "upload" || ARGS.mode === "both";
    if (wantDownload && !control.interrupted)
      download = await runPhase("download", targets, ARGS);
    if (wantUpload && !control.interrupted)
      upload = await runPhase("upload", targets, ARGS);

    printResults({ client, unloaded, download, upload, targets }, ARGS);
    if (control.interrupted && !ARGS.json)
      write(dim("  interrupted — partial results\n"));
  } catch (err) {
    write(`\nkfast: ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    restoreKeyboard();
    showCursor();
  }
}

process.on("SIGINT", hardQuit);

main();
