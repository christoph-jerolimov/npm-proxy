# npm-proxy

A small caching proxy for the npm registry that refuses to hand out packages
which are deprecated or have known security advisories.

- Delegates every request it does not understand to an upstream registry
  (`https://registry.npmjs.org` by default).
- Caches successfully downloaded tarballs under
  `$HOME/.npm-proxy/cache/<upstream host>/<package>/<name>-<version>.tgz`.
- Downloads the full package document and the security advisories the first
  time a package, or an unknown version of it, is requested.
- Answers `403` for deprecated or insecure versions and prints the reason and
  a recommendation on stderr. HTTP access logs go to stdout.
- `npm-proxy install` wraps your package manager: it starts the proxy on a
  random port, runs `npm`, `yarn`, `pnpm`, `bun` or `deno` against it, and
  stops the proxy again.

Written in TypeScript on top of [commander](https://github.com/tj/commander.js),
[zod](https://zod.dev) and [yaml](https://eemeli.org/yaml/).

## Install

```sh
npm install
npm run build
node dist/cli.js --help      # or: npm link && npm-proxy --help
```

Node.js 20 or newer is required.

## Usage

### `npm-proxy serve`

Starts the proxy and keeps it running until you press Ctrl+C.

```sh
npm-proxy serve                 # http://127.0.0.1:4873
npm-proxy serve --port 8080 --host 0.0.0.0
```

Point a package manager at it, for example:

```sh
npm install --registry=http://127.0.0.1:4873
pnpm install --registry=http://127.0.0.1:4873
bun install --registry=http://127.0.0.1:4873
NPM_CONFIG_REGISTRY=http://127.0.0.1:4873 deno install
YARN_NPM_REGISTRY_SERVER=http://127.0.0.1:4873 YARN_UNSAFE_HTTP_WHITELIST=127.0.0.1 yarn install
```

### `npm-proxy install [args...]`

Detects the package manager from the lock file in the current folder
(`deno.lock`, `bun.lock`, `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`,
then the `packageManager` field, then npm), starts the proxy on a random
port, runs the manager's install command against it with the registry passed
as an argument or environment variable, and stops the proxy when the command
exits. The exit code of the package manager is returned. Both outputs are
shown together: HTTP logs on stdout, denials on stderr.

```sh
npm-proxy install                      # e.g. npm install --registry=http://127.0.0.1:54321
npm-proxy install --no-audit --no-fund # extra arguments go to the package manager
npm-proxy install --manager pnpm       # override the detection
```

### Global options

| Option | Description |
|---|---|
| `-c, --config <file>` | Configuration file. Default: `npm-proxy.yaml` in the current folder. |
| `--upstream <url>` | Upstream registry, overrides the file. |
| `--cache-dir <dir>` | Cache directory, overrides the file. |

## Configuration

`npm-proxy` looks for `npm-proxy.yaml` (also `npm-proxy.yml`,
`.npm-proxy.yaml`, `.npm-proxy.yml`) in the current folder. Every key is
optional; the values below are the defaults.

```yaml
upstream: https://registry.npmjs.org
host: 127.0.0.1
port: 4873                      # only used by `serve`; `install` picks a random port
cacheDir: ~/.npm-proxy/cache
deny:
  deprecated: true              # refuse versions with a deprecation notice
  insecure: true                # refuse versions with a security advisory
  minSeverity: low              # low | moderate | high | critical
```

The file is validated with zod, so a typo or an out-of-range value is
reported with the offending key before the proxy starts.

## How a tarball request is handled

1. The request path `/<package>/-/<name>-<version>.tgz` is parsed.
2. The cached package document is loaded. If it is missing or does not know
   the requested version, the full document is fetched from upstream and
   cached. It contains the deprecation notice of every version.
3. The advisories for that exact version are loaded from the cache or fetched
   from upstream's `/-/npm/v1/security/advisories/bulk` endpoint and cached.
4. The policy is applied. A deprecated or insecure version is refused with
   `403`, and the reason plus a recommendation (usually the latest release)
   is printed on stderr.
5. Otherwise the tarball is served from the cache, or streamed from upstream
   while being written to the cache. The file is only kept when the download
   completed and the integrity hash from the package document matches.

Everything else, such as package documents, dist-tags, search and audit
requests, is forwarded to upstream. Tarball URLs inside package documents are
rewritten to point at the proxy, so downloads come back through it even when
no lock file exists.

## Logging

```
2026-10-26T22:44:33.460Z PROXY GET /lodash 200 99.8ms
2026-10-26T22:44:33.739Z MISS  GET /lodash/-/lodash-4.18.1.tgz 200 243.4ms
2026-10-26T22:44:37.174Z HIT   GET /lodash/-/lodash-4.18.1.tgz 200 3.1ms
```

Denials are written to stderr:

```
2026-10-26T22:48:19.267Z DENY lodash@4.17.23 (insecure)
                              high severity: lodash vulnerable to Code Injection via `_.template` imports key names (https://github.com/advisories/GHSA-r5fr-rjxr-66jc)
                              recommendation: upgrade to lodash@4.18.1 (latest) and check that it is not affected by the advisories above
```

Colors are used when the stream is a terminal and `NO_COLOR` is not set.

## Good to know

- Package managers keep their own caches. A version that is already in
  npm's, pnpm's, Yarn's or Bun's local store is installed without asking the
  registry, so the proxy never sees it. Clear that cache or use a fresh one
  (for example `npm-proxy install --cache /tmp/npm-cache`) to force a check.
- Package documents and advisories are cached until a version unknown to the
  cache is requested. Delete `<cacheDir>/<host>/<package>/packument.json` and
  `advisories.json` to force a refresh.
- If the advisory endpoint cannot be reached, the download is allowed and a
  warning is printed. Deprecation checks still apply.
- The proxy speaks plain HTTP. Yarn Berry refuses plain-http registries unless
  the host is listed in `unsafeHttpWhitelist`; `npm-proxy install` sets that
  for you.

## Development

```sh
npm run dev -- serve        # run from the TypeScript sources with tsx
npm run typecheck
npm test                    # node:test, includes an end-to-end test against a fake upstream
```

The `managers/` folder contains example projects for each package manager,
see [managers/README.md](managers/README.md).
