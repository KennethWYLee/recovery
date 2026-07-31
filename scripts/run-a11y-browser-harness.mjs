import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const listenHost = "127.0.0.1";
const listenPort = Number(process.env.CONTINUITY_OPS_A11Y_PORT ?? 3002);
const upstream = new URL(process.env.CONTINUITY_OPS_BASE_URL ?? "http://127.0.0.1:3001");
assert.ok(new Set(["localhost", "127.0.0.1", "[::1]", "::1"]).has(upstream.hostname));
assert.ok(Number.isInteger(listenPort) && listenPort >= 1024 && listenPort <= 65_535);

const axeSource = await readFile(resolve("node_modules/axe-core/axe.min.js"));
const hopByHopHeaders = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function runnerHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Local accessibility harness</title>
  <style>html,body,iframe{border:0;height:100%;margin:0;width:100%}#result{position:fixed;left:-10000px;top:auto}</style>
</head>
<body>
  <iframe id="target" src="/operations" title="Continuity Ops accessibility target"></iframe>
  <pre id="result" role="status">pending</pre>
  <script>
    const output = document.getElementById("result");
    window.addEventListener("message", (event) => {
      if (event.origin !== location.origin || event.data?.type !== "continuity-ops-axe-result") return;
      output.textContent = JSON.stringify(event.data.payload);
    });
  </script>
</body>
</html>`;
}

async function requestBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    assert.ok(length <= 1_048_576, "The local accessibility proxy request exceeded 1 MiB.");
    chunks.push(chunk);
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
}

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? "/", `http://${listenHost}:${listenPort}`);
    if (requestUrl.pathname === "/__axe-runner") {
      const html = Buffer.from(runnerHtml());
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-length": String(html.length),
        "content-type": "text/html; charset=utf-8",
        "x-content-type-options": "nosniff",
      });
      response.end(html);
      return;
    }
    if (requestUrl.pathname === "/__axe.js") {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-length": String(axeSource.length),
        "content-type": "text/javascript; charset=utf-8",
        "x-content-type-options": "nosniff",
      });
      response.end(axeSource);
      return;
    }

    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (!value || hopByHopHeaders.has(name.toLowerCase()) || name.toLowerCase() === "host") continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    headers.set("accept-encoding", "identity");
    const upstreamResponse = await fetch(new URL(`${requestUrl.pathname}${requestUrl.search}`, upstream), {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method ?? "GET") ? undefined : await requestBody(request),
      redirect: "manual",
    });
    let body = Buffer.from(await upstreamResponse.arrayBuffer());
    const responseHeaders = {};
    for (const [name, value] of upstreamResponse.headers) {
      if (!hopByHopHeaders.has(name.toLowerCase())) responseHeaders[name] = value;
    }
    if (requestUrl.pathname === "/operations") {
      // The harness alone needs same-origin framing so axe can inspect the
      // rendered document. The production Worker keeps DENY/frame-ancestors.
      delete responseHeaders["content-security-policy"];
      delete responseHeaders["x-frame-options"];
      const axeBridge = `<script src="/__axe.js"></script><script>
window.addEventListener("load", async () => {
  try {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const ready = document.querySelector("main h1");
      const loading = document.body?.textContent?.includes("正在載入營運狀態");
      if (ready && !loading) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    const result = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] } });
    const payload = {
      axeVersion: axe.version,
      url: location.href,
      viewport: { width: innerWidth, height: innerHeight },
      violations: result.violations.map((violation) => ({ id: violation.id, impact: violation.impact, description: violation.description, nodeCount: violation.nodes.length, targets: violation.nodes.slice(0, 10).map((node) => node.target) })),
      passes: result.passes.length,
      incomplete: result.incomplete.map((item) => ({ id: item.id, impact: item.impact, nodeCount: item.nodes.length })),
      inapplicable: result.inapplicable.length
    };
    const output = document.createElement("pre");
    output.id = "__continuity_ops_axe_result";
    output.setAttribute("role", "status");
    output.style.cssText = "position:fixed;left:-10000px;top:auto";
    output.textContent = JSON.stringify(payload);
    document.body.append(output);
    parent.postMessage({ type: "continuity-ops-axe-result", payload }, location.origin);
  } catch (error) {
    const payload = { error: error instanceof Error ? error.message : String(error) };
    const output = document.createElement("pre");
    output.id = "__continuity_ops_axe_result";
    output.setAttribute("role", "status");
    output.style.cssText = "position:fixed;left:-10000px;top:auto";
    output.textContent = JSON.stringify(payload);
    document.body.append(output);
    parent.postMessage({ type: "continuity-ops-axe-result", payload }, location.origin);
  }
}, { once: true });
</script>`;
      body = Buffer.from(body.toString("utf8").replace("</body>", `${axeBridge}</body>`));
    }
    responseHeaders["content-length"] = String(body.length);
    response.writeHead(upstreamResponse.status, responseHeaders);
    response.end(body);
  } catch (error) {
    const message = Buffer.from(error instanceof Error ? error.message : String(error));
    response.writeHead(502, {
      "cache-control": "no-store",
      "content-length": String(message.length),
      "content-type": "text/plain; charset=utf-8",
    });
    response.end(message);
  }
});

server.listen(listenPort, listenHost, () => {
  process.stdout.write(`Accessibility harness listening at http://${listenHost}:${listenPort}/__axe-runner\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
