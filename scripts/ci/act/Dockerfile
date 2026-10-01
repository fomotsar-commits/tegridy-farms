# The image act runs every `runs-on: ubuntu-latest` job in. Built by scripts/ci/act-job.sh.
# Base: catthehacker's rebuild of GitHub's ubuntu-24.04 runner (tag act-24.04-20260815),
# pinned by digest. A wrong digest fails the pull; it can never fetch something else.
FROM ghcr.io/catthehacker/ubuntu@sha256:62d572b92f9f32d3427b6d220ad1f9dca9c7b6ffad37d295425037dbff78abaf

# The scope jobs call `gh api .../pulls/N/files`; off GitHub this stand-in answers from git.
COPY gh /usr/local/bin/gh

# solana-ci.yml points ANCHOR_WALLET at /home/runner/.config, but this image runs as root.
# Its three validator jobs run `yarn install`; GitHub's image ships yarn 1, this one may not.
RUN chmod 0755 /usr/local/bin/gh \
 && mkdir -p /home/runner \
 && ln -s /root/.config /home/runner/.config \
 && set -a && . /etc/environment && set +a \
 && (command -v yarn >/dev/null || npm install --global yarn@1.22.22) \
 && yarn --version
