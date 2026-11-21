const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");

const PORT = 8082;
const jobs = new Map();

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

function startRender(html, resolution) {
  const id = crypto.randomUUID();
  const dir = path.join(os.tmpdir(), `hf-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), html, "utf8");
  const outFile = path.join(dir, "output.mp4");

  const job = { id, dir, outFile, status: "running", error: null, proc: null };
  jobs.set(id, job);

  const args = ["render", "--output", outFile];
  if (resolution && ["portrait", "landscape", "square"].includes(String(resolution).toLowerCase())) {
    args.push("--resolution", String(resolution).toLowerCase());
  }
  const proc = spawn("hyperframes", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  job.proc = proc;
  job.timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch (e) {} if (job.status === "running") { job.status = "failed"; job.error = "render timed out after 10 minutes"; } }, 600000);
  let stderr = "";
  proc.stdout.on("data", () => {});
  proc.stderr.on("data", (d) => { stderr += d.toString(); });

  proc.on("close", (code) => {
    if (job.timer) { clearTimeout(job.timer); job.timer = null; }
    if (code === 0 && fs.existsSync(outFile) && fs.statSync(outFile).size > 0) {
      job.status = "done";
    } else {
      job.status = "failed";
      job.error = stderr.trim().slice(-2000) || `hyperframes exited with code ${code}`;
    }
  });
  proc.on("error", (e) => {
    job.status = "failed";
    job.error = String(e);
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
      const id = startRender(html, body.resolution);
      return json(res, 200, { job_id: id });
    } catch (e) {
      return json(res, 400, { error: String(e) });
    }
  }

  const m = pathname.match(/^\/render\/([^/]+)(?:\/file)?$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const isFile = pathname.endsWith("/file");
    const job = jobs.get(id);
    if (!job) return json(res, 404, { error: "unknown job" });

    if (isFile) {
      if (job.status !== "done" || !fs.existsSync(job.outFile)) {
        return json(res, 409, { error: "render not ready" });
      }
      const stat = fs.statSync(job.outFile);
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": stat.size,
      });
      fs.createReadStream(job.outFile).pipe(res);
      return;
    }

    return json(res, 200, { status: job.status, error: job.error });
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`HyperFrames shim listening on ${PORT}`);
});
