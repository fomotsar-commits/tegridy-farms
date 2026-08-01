# Tegridy CP-AMM

A constant-product AMM for Solana. **This is a fork of
[raydium-io/raydium-cp-swap](https://github.com/raydium-io/raydium-cp-swap) (Apache-2.0)**,
@ `78f254e`. The entire delta from upstream is four authority/identity constants across two
files, enforced automatically by the `diff-guard` job in `.github/workflows/solana-ci.yml`.
All swap, curve and fee math is byte-identical to upstream.

Upstream's features carry over: no Openbook market ID needed for pool creation, Token22
support, a built-in price oracle, written in Anchor.

## ⚠️ Audit and bug-bounty status — READ THIS

**This fork has NOT been audited, and it is NOT covered by any bug bounty.**

Upstream raydium-cp-swap was audited by [MadShield](https://www.madshield.xyz/)
([report](https://github.com/raydium-io/raydium-docs/tree/master/audit/MadShield%20Q1%202024))
and Raydium's deployed programs are in scope for
[their Immunefi programme](https://immunefi.com/bug-bounty/raydium/). **Neither covers this
repository.** Those are Raydium's audit and Raydium's money, obtained for Raydium's code and
Raydium's deployment. An audit of upstream is evidence about the code we did not change; it
says nothing about our four constants, our deployment, or `programs/tegridy-launch/`, which is
novel code with no upstream at all.

An earlier revision of this file was inherited verbatim from upstream and asserted both the
audit and the bounty as if they applied here. They never did. If you are a security
researcher, see [SECURITY.md](SECURITY.md) — and please do not send findings about this fork
to Raydium.

Status: **Phase 0 — devnet. NOT audited. NOT on mainnet. Holds no funds.**

## Environment Setup

1. Install `Rust`

   ```shell
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   rustup default 1.81.0
   ```

2. Install `Solana `

   ```shell
   sh -c "$(curl -sSfL https://release.anza.xyz/v2.1.0/install)"
   ```

   then run `solana-keygen new` to create a keypair at the default location.

3. install `Anchor`

   ```shell
   # Installing using Anchor version manager (avm) 
   cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
   # Install anchor
   avm install 0.31.0
   ```

## Quickstart

Clone the repository and test the program.

```shell

git clone https://github.com/raydium-io/raydium-cp-swap
cd raydium-cp-swap && yarn && anchor test
```

## License

Raydium constant product swap is licensed under the Apache License, Version 2.0.
