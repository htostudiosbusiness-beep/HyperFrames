const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");

const PORT = 8082;
// Only the live child process handles are kept in memory. Job STATE lives on
// disk under /tmp/hf-<id>, so any shim instance can answer /render/:id and
// serve the finished file (the previous in-memory Map broke with >1 instance).
const processes = new Map();

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function jobDir(id) {
  return path.join(os.tmpdir(), `hf-${id}`);
}
function statusFile(id) {
  return path.join(jobDir(id), "status.json");
}
function writeStatus(id, status, error) {
  fs.writeFileSync(statusFile(id), JSON.stringify({ status, error: error || null }));
}
function readStatus(id) {
  try {
    return JSON.parse(fs.readFileSync(statusFile(id), "utf8"));
  } catch (e) {
    return null;
  }
}

function safeName(name) {
  const base = path.basename(String(name || "media"));
  return base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "media";
}

function startRender(html, resolution, media) {
  const id = crypto.randomUUID();
  const dir = jobDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), html, "utf8");

  // Write the submitted media bundle into the render project so the HTML can
  // use relative src="media/<name>" paths the local browser can always load.
  if (Array.isArray(media) && media.length) {
    fs.mkdirSync(path.join(dir, "media"), { recursive: true });
    for (const item of media.slice(0, 12)) {
      const name = safeName(item && item.name);
      const data = item && typeof item.data === "string" ? item.data : "";
      if (!name || !data) continue;
      try {
        fs.writeFileSync(path.join(dir, "media", name), Buffer.from(data, "base64"));
      } catch (e) {
        // Ignore a single bad asset; the render can still proceed.
      }
    }
  }

  const outFile = path.join(dir, "output.mp4");
  writeStatus(id, "running", null);

  const args = ["render", "--output", outFile];
  if (resolution && ["portrait", "landscape", "square"].includes(String(resolution).toLowerCase())) {
    args.push("--resolution", String(resolution).toLowerCase());
  }
  const proc = spawn("hyperframes", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  proc.stdout.on("data", () => {});
  proc.stderr.on("data", (d) => { stderr += d.toString(); });

  const timer = setTimeout(() => {
    try { proc.kill("SIGKILL"); } catch (e) {}
    writeStatus(id, "failed", "render timed out after 10 minutes");
    processes.delete(id);
  }, 600000);
  processes.set(id, { proc, timer });

  proc.on("close", (code) => {
    const entry = processes.get(id);
    if (entry && entry.timer) clearTimeout(entry.timer);
    processes.delete(id);
    if (code === 0 && fs.existsSync(outFile) && fs.statSync(outFile).size > 0) {
      writeStatus(id, "done", null);
    } else {
      writeStatus(id, "failed", stderr.trim().slice(-2000) || `hyperframes exited with code ${code}`);
    }
  });
  proc.on("error", (e) => {
    writeStatus(id, "failed", String(e));
    processes.delete(id);
  });

  return id;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/health") {
    return json(res, 200, { status: "ok" });
  }

  if (req.method === "POST" && pathname === "/render") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const html = body.html;
      if (typeof html !== "string" || !html.trim()) {
        return json(res, 400, { error: "html is required" });
      }
      const id = startRender(html, body.resolution, body.media);
      return json(res, 200, { job_id: id });
    } catch (e) {
      return json(res, 400, { error: String(e) });
    }
  }

  const m = pathname.match(/^\/render\/([^/]+)(?:\/file)?$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const isFile = pathname.endsWith("/file");
    const state = readStatus(id);
    if (!state) return json(res, 404, { error: "unknown job" });

    if (isFile) {
      const outFile = path.join(jobDir(id), "output.mp4");
      if (state.status !== "done" || !fs.existsSync(outFile)) {
        return json(res, 409, { error: "render not ready" });
      }
      const stat = fs.statSync(outFile);
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": stat.size });
      fs.createReadStream(outFile).pipe(res);
      return;
    }

    return json(res, 200, state);
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`HyperFrames shim listening on ${PORT}`);
});
