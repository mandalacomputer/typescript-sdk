# frozen_string_literal: true

# The mandala CLI, installed from the published npm tarball.
#
# The source of truth for the formula in the mandalacomputer/homebrew-tap
# repository; see README.md beside this file for how the two stay in step.
class Mandala < Formula
  desc "Command-line client for Mandala Computer cloud desktops"
  homepage "https://mandala.computer"
  url "https://registry.npmjs.org/mandala-computer/-/mandala-computer-0.25.0.tgz"
  sha256 "4d27f5a5c872ffd387c60a8732a3f2db084b8b543f90a6dd9096e32f7ffddeb7"
  license "MIT"

  livecheck do
    url :stable
  end

  # The package declares engines.node >=22; Homebrew's node is newer than that.
  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
    generate_completions_from_executable(bin/"mandala", "completion")
  end

  test do
    # Help, manifest and completion need no credentials and no network.
    assert_match "mandala login", shell_output("#{bin}/mandala --help")
    assert_equal "mandala", JSON.parse(shell_output("#{bin}/mandala manifest"))["name"]
    installed = JSON.parse((libexec/"lib/node_modules/mandala-computer/package.json").read)
    assert_equal version.to_s, installed["version"]
  end
end
