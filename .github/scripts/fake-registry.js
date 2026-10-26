#!/usr/bin/env node
// Minimal stand-in for an npm registry that never serves anything.
//
// Every request is appended to a log file as "METHOD PATH" and answered with
// HTTP 503. The proxy workflow uses it to prove that a package manager really
// sends its requests to the configured registry, and that the install fails
// when that registry does not deliver packages.
//
// Usage: node fake-registry.js [port] [logfile]

const http = require("node:http");
const fs = require("node:fs");

const port = Number(process.argv[2] ?? 4873);
const logFile = process.argv[3] ?? "fake-registry.log";

const color = (code, text) => `\x1b[${code}m${text}\x1b[0m`;
const dim = (text) => color(2, text);
const bold = (text) => color(1, text);
const green = (text) => color(32, text);
const yellow = (text) => color(33, text);
const cyan = (text) => color(36, text);

const server = http.createServer((req, res) => {
  fs.appendFileSync(logFile, `${req.method} ${req.url}\n`);
  console.log(`${dim(new Date().toISOString())} ${cyan(req.method)} ${req.url} ${yellow("-> 503")}`);

  const body = JSON.stringify({ error: "fake registry: nothing is served here" });
  res.writeHead(503, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
});

server.listen(port, "127.0.0.1", () => {
  console.log(
    `${green("fake registry")} listening on ${bold(`http://127.0.0.1:${port}`)}, logging to ${bold(logFile)}`,
  );
});
