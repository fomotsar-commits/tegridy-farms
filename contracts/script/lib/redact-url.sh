# shellcheck shell=bash
# Print an endpoint an operator can READ without printing the credential in it.
#
# SOURCED, NEVER EXECUTED. This file defines two functions and does nothing else, so
# scripts/lib/redact-url.test.mjs can source it and assert its behaviour directly
# rather than scraping the text of the scripts that use it.
#
# WHY THIS EXISTS. cancel-gated-pending.sh and deploy-gated.sh each echoed their
# endpoint verbatim in the header they print on every invocation, dry runs included:
#
#     mode: DRY-RUN   rpc: https://eth-mainnet.g.alchemy.com/v2/<the live API key>
#
# That is the same defect that leaked a live Alchemy key into a shared terminal
# screenshot during the 2026-09-20 BAYLA ladder go-live. It matters more here than in a
# read-only tool: cancel-gated-pending.sh's own header tells the operator to point
# RPC_URL at Flashbots or MEV-Blocker for admin transactions, and those are keyed.
#
# WHY THE HOST STAYS, AND IS NOT A BUG. The line is not deleted and the host is not
# masked, because reading the host back is the operator's only local signal that a
# mainnet ceremony is not pointed somewhere else. "rpc: [redacted]" would satisfy a
# naive leak test and delete the entire reason the line is printed. So the host is kept
# and everything that can carry a credential is masked. The cost is stated plainly: a
# provider that puts its credential in the HOSTNAME is not protected by this, and
# nothing that also answers "am I on mainnet?" could be.
#
# THE FOUR PLACES A CREDENTIAL HIDES, all covered:
#   path       Alchemy /v2/<key>, Infura /v3/<key>, QuickNode /<token>/
#              -> every segment that is not a short route word becomes ***
#   query      Helius ?api-key=<uuid>, drpc ?dkey=<key>
#              -> every VALUE becomes ***, names kept. Not a list of known key names:
#                 the next provider names it something else, and the value we have not
#                 heard of is exactly the one that leaks.
#   userinfo   https://user:pass@host -> ***@, so its presence still shows
#   fragment   #<anything> -> ***
#
# This mirrors scripts/lib/redact-url.mjs, which does the same job for the Node CLIs.
# The two are separate implementations on purpose: bash cannot import the module, and
# the alternative was two inline copies of the mask in two shell scripts. Each pins its
# own contract in scripts/lib/redact-url.test.mjs.

# One path segment: a short route word is readable and carries no secret, so it is kept.
# Anything else -- a 32-char key, a UUID, a base58 token, anything with digits inside --
# becomes ***. Mirrors ROUTE_WORD in scripts/lib/redact-url.mjs.
_redact_url_segment() {
  if [ -z "${1-}" ]; then
    printf ''
  elif [[ "$1" =~ ^[A-Za-z][A-Za-z-]{0,7}[0-9]{0,2}$ ]]; then
    printf '%s' "$1"
  else
    printf '***'
  fi
}

# redact_url <endpoint>
#
# Always prints something, and never prints a credential from the input. A value it
# cannot read is REFUSED rather than echoed, because an unparseable value may BE a bare
# key -- someone exporting RPC_URL wrong. "we could not parse it" is never a reason to
# print it.
#
# The one non-URL form that IS echoed is a foundry rpc_endpoints alias (mainnet,
# flashbots, mev-blocker): letters and dashes with at most a trailing version number.
# deploy-gated.sh passes an alias by default, that shape cannot hold a key, and printing
# "[unreadable endpoint]" for the ordinary case would train an operator to ignore it.
redact_url() {
  local url="${1-}"
  # Trim surrounding whitespace before any decision: "  <key>  " must not read as a URL.
  url="${url#"${url%%[![:space:]]*}"}"
  url="${url%"${url##*[![:space:]]}"}"
  if [ -z "$url" ]; then printf '%s' '[no endpoint]'; return 0; fi

  case "$url" in
    *://*) ;;
    *)
      if [[ "$url" =~ ^[A-Za-z][A-Za-z-]{0,15}[0-9]{0,2}$ ]]; then
        printf '%s' "$url"
      else
        printf '%s' '[unreadable endpoint]'
      fi
      return 0
      ;;
  esac

  local scheme rest frag='' query='' userinfo='' authority='' host path=''
  scheme="${url%%://*}"
  rest="${url#*://}"
  if [ -z "$scheme" ] || [ -z "$rest" ]; then printf '%s' '[unreadable endpoint]'; return 0; fi

  # Strip right to left so a '?' inside a fragment, or a '#' inside neither, cannot
  # confuse the split.
  case "$rest" in *'#'*) frag='#***'; rest="${rest%%#*}" ;; esac
  case "$rest" in *'?'*) query="${rest#*\?}"; rest="${rest%%\?*}" ;; esac

  # Userinfo is only userinfo before the first '/': an '@' inside a path is not a
  # credential delimiter.
  authority="${rest%%/*}"
  case "$rest" in */*) path="/${rest#*/}" ;; esac
  case "$authority" in *@*) userinfo='***@'; authority="${authority##*@}" ;; esac
  host="$authority"
  if [ -z "$host" ]; then printf '%s' '[unreadable endpoint]'; return 0; fi

  if [ -n "$path" ]; then
    local out='' rem="${path#/}" seg
    while : ; do
      case "$rem" in
        */*) seg="${rem%%/*}"; rem="${rem#*/}"; out="$out/$(_redact_url_segment "$seg")" ;;
        *)   out="$out/$(_redact_url_segment "$rem")"; break ;;
      esac
    done
    path="$out"
  fi

  if [ -n "$query" ]; then
    local q='' rem="$query" pair
    while : ; do
      case "$rem" in
        *'&'*) pair="${rem%%&*}"; rem="${rem#*&}" ;;
        *)     pair="$rem"; rem='' ;;
      esac
      case "$pair" in
        '')  q="$q&" ;;
        *=*) q="$q&${pair%%=*}=***" ;;
        # A pair with NO '=' is masked WHOLE. '?<key>' is a real shape, and reading it
        # as a parameter NAME -- names are kept -- would have printed that key in full.
        *)   q="$q&***" ;;
      esac
      [ -n "$rem" ] || break
    done
    query="?${q#&}"
  fi

  printf '%s' "${scheme}://${userinfo}${host}${path}${query}${frag}"
  return 0
}
