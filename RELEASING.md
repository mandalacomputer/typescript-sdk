# Releasing

The three client packages release together, under one version number:

| Package | Registry | Repository |
| --- | --- | --- |
| `mandala-computer` (SDK and the `mandala` CLI) | npm | this one |
| `mandala-computer` (Python SDK) | PyPI | `mandalacomputer/python-sdk` |
| `mandala-computer-mcp` | npm | `mandalacomputer/mcp` |

A release is a `vX.Y.Z` tag pushed to each repository. The tag runs
`.github/workflows/release.yml`, which checks the tag against the declared
version, runs the tests, publishes through trusted publishing (there is no
token to hold) and creates the GitHub release. Nothing else publishes.

Work through the steps in order. The later ones install what the earlier ones
publish, so each has to exist before the next can point at it.

## 1. Changelog

In each repository, rename `## [Unreleased]` in `CHANGELOG.md` to
`## [X.Y.Z] - YYYY-MM-DD` and open a fresh, empty `[Unreleased]` above it. Every
change merged since the last release should already have an entry; if one does
not, add it now.

## 2. Version, in two places per repository

The release workflow refuses a tag that disagrees with either place, and the
one-line bump is the commit most likely to be half done.

| Repository | First place | Second place |
| --- | --- | --- |
| typescript-sdk | `package.json` `version` | `export const VERSION` in `src/index.ts` |
| python-sdk | `pyproject.toml` `version` | `__version__` in `src/mandala_computer/__init__.py` |
| mcp | `package.json` `version` | `SERVER_VERSION` in `src/server.ts` |

Run `npm install --package-lock-only` after the `package.json` bump so the
lockfile's own version follows it.

## 3. Merge, then tag the merge commit

Open the pull request with the changelog and version changes, wait for CI and
merge it. Then tag the merge commit, not your local branch:

```sh
git fetch origin
git tag vX.Y.Z origin/main
git push origin vX.Y.Z
```

The workflow runs as of the tagged commit, so a fix to the workflow itself
needs a new commit and a new tag. A tag whose run failed before anything was
published can be moved to a fixed commit. A tag that published cannot be
reused: npm and PyPI never accept the same version twice, so the fix is the
next patch version.

## 4. Confirm the packages are live

```sh
npm view mandala-computer version
npm view mandala-computer-mcp version
pip index versions mandala-computer
```

The registries can lag the workflow's publish step by a few minutes.

## 5. Move the Homebrew formula

`brew install mandalacomputer/tap/mandala` installs the version that
`Formula/mandala.rb` in
[`mandalacomputer/homebrew-tap`](https://github.com/mandalacomputer/homebrew-tap)
names, pinned by the npm tarball's URL and SHA-256. It does not move by itself,
and it can only move once step 4 shows the tarball on npm, because its checksum
is the registry's copy. Either let Homebrew open the pull request:

```sh
brew bump-formula-pr --version X.Y.Z mandalacomputer/tap/mandala
```

or edit `url` and `sha256` in the tap's `Formula/mandala.rb` by hand, with the
checksum from:

```sh
curl -fsSL https://registry.npmjs.org/mandala-computer/-/mandala-computer-X.Y.Z.tgz | shasum -a 256
```

Merge the tap's pull request, then copy its `Formula/mandala.rb` back to
[`packaging/homebrew/mandala.rb`](packaging/homebrew/mandala.rb) here in a pull
request of its own; the two copies must stay identical. Then check it from a
clean shell:

```sh
brew update
brew upgrade mandalacomputer/tap/mandala || brew install mandalacomputer/tap/mandala
brew test mandalacomputer/tap/mandala
mandala --help
```

`brew livecheck mandalacomputer/tap/mandala` reports whether npm has a newer
version than the formula, which is how a missed step 5 shows up later.
[`packaging/homebrew/README.md`](packaging/homebrew/README.md) has the rest,
including how to test a formula change without touching your own machine.

## 6. Move the dashboard's pinned release

The dashboard's Connect an agent panel and API reference install one pinned
release: the `npx` snippets, the MCP server, and the install script's
`--version`. It also names the tap. Move that pinned release to X.Y.Z in the
app repository, where its doc comment says what else moves with it.

If the site's `install.sh` changed since the last release, move the
dashboard's copy of its SHA-256 in the same change: the panel's "verify first"
install checks the script against that copy, and refuses any other script.

This step comes last because every command it pins has to work the moment it
deploys: the packages from step 4 and the formula from step 5.
