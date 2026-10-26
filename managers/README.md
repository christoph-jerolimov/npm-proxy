# Package manager examples

Each subfolder contains a minimal `package.json` with a single dependency,
`lodash@4.17.23`, together with the lockfile written by one package manager.
`node_modules` is ignored at the repository root, so every folder can be
installed independently without affecting the others.

| Folder  | Package manager | Version used | Lockfile            |
|---------|-----------------|--------------|---------------------|
| `npm/`  | npm             | 10.9.4       | `package-lock.json` |
| `yarn/` | Yarn (Berry)    | 4.18.1       | `yarn.lock`         |
| `pnpm/` | pnpm            | 10.28.0      | `pnpm-lock.yaml`    |
| `bun/`  | Bun             | 1.4.4        | `bun.lock`          |
| `deno/` | Deno            | 2.9.6        | `deno.lock`         |

## npm

npm ships with Node.js, so no extra setup is needed.

```sh
cd managers/npm
npm install
```

Use `npm ci` instead of `npm install` to install exactly what the lockfile
says and fail if `package.json` and `package-lock.json` disagree.

## Yarn

The `yarn/` folder pins Yarn 4 through the `packageManager` field in
`package.json`. Corepack, which ships with Node.js, reads that field and
downloads the pinned version. Enable it once:

```sh
corepack enable
```

Then install as usual:

```sh
cd managers/yarn
yarn install
```

If you prefer not to enable Corepack globally, prefix the command instead:

```sh
corepack yarn install
```

A globally installed Yarn 1 (Classic) will not honor the pin and would
rewrite `yarn.lock` in the old format, so make sure `yarn --version`
prints `4.x` inside the folder before installing.

`.yarnrc.yml` sets `nodeLinker: node-modules` so Yarn writes a regular
`node_modules` folder like the other examples instead of using Plug'n'Play.
Use `yarn install --immutable` to refuse any change to the lockfile.

## pnpm

Install pnpm with Corepack or any other method from
<https://pnpm.io/installation>:

```sh
corepack enable pnpm
```

Then:

```sh
cd managers/pnpm
pnpm install
```

Use `pnpm install --frozen-lockfile` to fail instead of updating
`pnpm-lock.yaml`. In CI pnpm enables this automatically.

## Bun

Install Bun from <https://bun.sh>:

```sh
curl -fsSL https://bun.sh/install | bash
```

Then:

```sh
cd managers/bun
bun install
```

Bun writes a text lockfile, `bun.lock`. Older Bun versions wrote a binary
`bun.lockb`; Bun 1.2 and later read both. Use `bun install --frozen-lockfile`
to fail instead of updating the lockfile.

## Deno

Install Deno from <https://deno.com>:

```sh
curl -fsSL https://deno.land/install.sh | sh
```

Then:

```sh
cd managers/deno
deno install
```

Deno 2 reads `package.json`, resolves the `npm:` specifier for lodash and
writes `deno.lock`. It also creates a `node_modules` folder because the
project has a `package.json`. Use `deno install --frozen` to fail instead of
updating the lockfile.

## Regenerating the lockfiles

To regenerate a lockfile from scratch, delete it together with
`node_modules` in that folder and run the install command again. Keep the
manager versions in the table above in mind, since different major versions
of the same manager may write a different lockfile format.
