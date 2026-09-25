# Homebrew formula

`mandala.rb` installs the `mandala` CLI with Homebrew:

```sh
brew install mandalacomputer/tap/mandala
```

It installs the published npm tarball of `mandala-computer` (the same package
`npm install -g mandala-computer` installs) against Homebrew's `node`, links the
`mandala` command, and generates bash, zsh and fish completions from
`mandala completion`. The package has no runtime dependencies, so installing it
is one tarball and takes about a second; nothing is compiled and no bottle is
needed.

This file is the reviewed copy. What `brew` actually reads is the copy in the
tap repository, so the two must stay identical.

## The tap repository

`brew install mandalacomputer/tap/mandala` reads
`github.com/mandalacomputer/homebrew-tap`: Homebrew expands `<org>/tap` to the
repository `<org>/homebrew-tap`. It does not exist yet. To create it:

1. Create the **public** repository `mandalacomputer/homebrew-tap`. Homebrew
   clones it anonymously, so it cannot be private.
2. Commit this directory's `mandala.rb` to it as `Formula/mandala.rb`, with a
   README that gives the install line above.
3. Check it from a clean machine:

   ```sh
   brew install mandalacomputer/tap/mandala
   brew test mandalacomputer/tap/mandala
   brew audit --strict --online mandalacomputer/tap/mandala
   ```

## After each npm release

The formula pins one version by its tarball URL and SHA-256, so each release
needs it moved. Once the new version is on npm:

```sh
brew bump-formula-pr --version X.Y.Z mandalacomputer/tap/mandala
```

That opens a pull request on the tap with the new URL and checksum. Copy the
result back here in the same release. By hand, the checksum is:

```sh
curl -fsSL https://registry.npmjs.org/mandala-computer/-/mandala-computer-X.Y.Z.tgz | shasum -a 256
```

`brew livecheck mandalacomputer/tap/mandala` reports whether npm has a newer
version than the formula.

Doing this from the release workflow instead would need a credential that can
push to the tap; this repository's releases hold none today.

## Testing a change to the formula

Without the tap, in a throwaway container, so nothing on your own machine is
installed or upgraded (Homebrew upgrades a dependency such as `node` when it
installs something that depends on it):

```sh
docker run --rm -v "$PWD/packaging/homebrew:/src:ro" homebrew/brew:latest bash -lc '
  brew update >/dev/null
  brew tap-new --no-git local/tap >/dev/null
  cp /src/mandala.rb "$(brew --repository local/tap)/Formula/mandala.rb"
  brew style local/tap/mandala
  brew install --formula local/tap/mandala
  brew test local/tap/mandala
  brew audit --strict --online --new --formula local/tap/mandala
  brew livecheck local/tap/mandala'
```
