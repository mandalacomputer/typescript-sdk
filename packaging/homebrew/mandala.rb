# The mandala CLI, installed from the published npm tarball.
#
# The source of truth for the formula in the mandalacomputer/homebrew-tap
# repository; see README.md beside this file for how the two stay in step.
class Mandala < Formula
  desc "Command-line client for Mandala Computer cloud desktops"
  homepage "https://mandala.computer"
  url "https://registry.npmjs.org/mandala-computer/-/mandala-computer-0.6.0.tgz"
  sha256 "67bc6479812193f9751c2d112fe42b0d1da0b1348225c081eecdf668e89716da"
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
